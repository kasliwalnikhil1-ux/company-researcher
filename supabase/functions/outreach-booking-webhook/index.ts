// Item 24 — Booking webhook (public; deploy with --no-verify-jwt). A booked meeting fills the last funnel stage and ends the sequence cleanly.
//
// URL to paste into Calendly / Cal.com:
//   <functions base>/outreach-booking-webhook?ws=<workspace id>&k=<booking_secret>&p=calendly|calcom
// `k` is outreach_workspace_secrets.booking_secret (compared in constant time). `p` may be left out: the payload shape tells the provider.
//
// How the lead is found
//   1. the lead id the booking link carried. Links rendered by the platform ({{booking_link}}, the inbox "Send booking link" button) end in
//      ?utm_content=<lead id>. Calendly returns it as payload.tracking.utm_content. Cal.com does not echo UTM parameters, so for cal.com links
//      the platform also appends metadata[lead_id]=<lead id>, which Cal.com returns as payload.metadata.lead_id. A hidden booking question with
//      the identifier `lead_id` (or `utm_content`) works too: it arrives in payload.responses.
//   2. otherwise the invitee / attendee email (outreach_record_booking matches it against the workspace's leads).
//   Bookings that match no lead are still stored (outreach_booking_events.lead_id is null) and logged as `unmatched`.
//
// Calendly: invitee.created → booked · invitee.canceled → cancelled (or rescheduled when payload.rescheduled is true; the new time arrives as its own invitee.created)
// Cal.com:  BOOKING_CREATED → booked · BOOKING_RESCHEDULED → booked under the new uid, the old uid (rescheduleUid) is marked rescheduled · BOOKING_CANCELLED → cancelled
// Always answers 200 quickly once the secret checks out, so the provider does not retry or disable the hook over a payload we do not use.
import { admin, json, serve, HttpError, rpc, log, timingSafeEqual, rateLimit } from "../_shared/outreach/supabase.ts";

type Row = Record<string, any>;
type Status = "booked" | "cancelled" | "rescheduled";
interface Booking { provider: "calendly" | "calcom"; externalId: string | null; leadId: string | null; email: string | null; status: Status; startsAt: string | null; alsoRescheduled?: string | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const asUuid = (v: unknown): string | null => { const s = String((v as any)?.value ?? v ?? "").trim(); return UUID.test(s) ? s.toLowerCase() : null; };
const asIso = (v: unknown): string | null => { const t = Date.parse(String(v ?? "")); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const asEmail = (v: unknown): string | null => { const s = String((v as any)?.value ?? v ?? "").trim().toLowerCase(); return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : null; };

function parseCalendly(body: Row): Booking | null {
  const ev = String(body.event ?? "");
  if (ev !== "invitee.created" && ev !== "invitee.canceled") return null;
  const p: Row = body.payload ?? {};
  const answers: Row[] = Array.isArray(p.questions_and_answers) ? p.questions_and_answers : [];
  const fromAnswer = answers.map((a) => (/lead[_ ]?id/i.test(String(a.question ?? "")) ? asUuid(a.answer) : null)).find(Boolean) ?? null;
  return {
    provider: "calendly", externalId: p.uri ?? p.invitee?.uri ?? null,
    leadId: asUuid(p.tracking?.utm_content) ?? asUuid(p.tracking?.utm_term) ?? fromAnswer,
    email: asEmail(p.email ?? p.invitee?.email),
    status: ev === "invitee.created" ? "booked" : p.rescheduled ? "rescheduled" : "cancelled",
    startsAt: asIso(p.scheduled_event?.start_time ?? p.event?.start_time),
  };
}

function parseCalcom(body: Row): Booking | null {
  const ev = String(body.triggerEvent ?? "").toUpperCase();
  if (!["BOOKING_CREATED", "BOOKING_CANCELLED", "BOOKING_RESCHEDULED"].includes(ev)) return null;
  const p: Row = body.payload ?? {};
  const md: Row = p.metadata ?? {};
  const rs: Row = p.responses ?? {};
  const uf: Row = p.userFieldsResponses ?? {};
  const leadId = asUuid(md.lead_id) ?? asUuid(md.utm_content) ?? asUuid(md.outreach_lead_id) ?? asUuid(rs.lead_id) ?? asUuid(rs.utm_content) ?? asUuid(uf.lead_id) ?? asUuid(uf.utm_content) ?? asUuid(p.tracking?.utm_content);
  const attendee = (Array.isArray(p.attendees) ? p.attendees : [])[0] ?? {};
  return {
    provider: "calcom", externalId: p.uid ?? (p.bookingId ? String(p.bookingId) : null), leadId,
    email: asEmail(attendee.email) ?? asEmail(rs.email),
    status: ev === "BOOKING_CANCELLED" ? "cancelled" : "booked",
    startsAt: asIso(p.startTime),
    alsoRescheduled: ev === "BOOKING_RESCHEDULED" ? (p.rescheduleUid ?? null) : null,
  };
}

/** Keep what is useful for support, drop free-text answers and anything large. */
function slim(body: Row): Row {
  const p: Row = body.payload ?? {};
  return {
    event: body.event ?? body.triggerEvent ?? null, created_at: body.created_at ?? body.createdAt ?? null,
    uri: p.uri ?? null, uid: p.uid ?? null, reschedule_uid: p.rescheduleUid ?? null, rescheduled: p.rescheduled ?? null,
    event_type: p.scheduled_event?.name ?? p.eventTitle ?? p.title ?? p.type ?? null, start: p.scheduled_event?.start_time ?? p.startTime ?? null, end: p.scheduled_event?.end_time ?? p.endTime ?? null,
    invitee_name: p.name ?? (Array.isArray(p.attendees) ? p.attendees[0]?.name : null) ?? null, tracking: p.tracking ?? null, metadata: p.metadata ?? null,
    cancel_reason: p.cancellation?.reason ?? p.cancellationReason ?? null,
  };
}

serve("booking-webhook", async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET" || req.method === "HEAD") return json({ ok: true, hint: "POST Calendly or Cal.com webhooks here" });   // Cal.com pings the URL when the hook is saved
  const ws = url.searchParams.get("ws") ?? "";
  const k = url.searchParams.get("k") ?? "";
  if (!UUID.test(ws) || !k) throw new HttpError(401, "E_FORBIDDEN", "ws and k are required");
  await rateLimit(`booking:${ws}`, 300, 60);
  const { data: sec } = await admin.from("outreach_workspace_secrets").select("booking_secret").eq("workspace_id", ws).maybeSingle();
  // compare against a dummy of the same length when the row is missing, so the answer takes the same time either way
  const expected = String(sec?.booking_secret ?? "x".repeat(k.length || 1));
  if (!timingSafeEqual(k, expected) || !sec?.booking_secret) throw new HttpError(401, "E_FORBIDDEN", "bad secret");

  let body: Row = {};
  try { body = await req.json(); } catch { return json({ ok: true, ignored: "not json" }); }
  const hint = (url.searchParams.get("p") ?? "").toLowerCase();
  const b = hint === "calcom" || hint === "cal.com" || (!hint && body.triggerEvent) ? parseCalcom(body) : hint === "calendly" || (!hint && body.event) ? parseCalendly(body) : (parseCalendly(body) ?? parseCalcom(body));
  if (!b) return json({ ok: true, ignored: String(body.event ?? body.triggerEvent ?? "unknown event") });   // e.g. Cal.com's test ping
  if (!b.externalId) { log({ fn: "booking-webhook", workspace: ws, warn: "booking without an id", provider: b.provider }); return json({ ok: true, ignored: "no booking id" }); }

  try {
    if (b.alsoRescheduled && b.alsoRescheduled !== b.externalId) {
      await rpc("record_booking", { p_ws: ws, p_provider: b.provider, p_external_id: String(b.alsoRescheduled), p_lead: b.leadId, p_email: b.email, p_status: "rescheduled", p_starts_at: null, p_payload: { rescheduled_to: b.externalId }, p_sender: null });
    }
    const r = await rpc<Row>("record_booking", { p_ws: ws, p_provider: b.provider, p_external_id: String(b.externalId), p_lead: b.leadId, p_email: b.email, p_status: b.status, p_starts_at: b.startsAt, p_payload: slim(body), p_sender: null });
    if (!r?.matched) log({ fn: "booking-webhook", workspace: ws, unmatched: true, provider: b.provider, status: b.status, had_lead_id: !!b.leadId, had_email: !!b.email, booking_id: r?.booking_id ?? null });
    return json({ ok: true, matched: !!r?.matched, status: b.status });
  } catch (e) {
    // still 200: a retry would hit the same error, and providers switch off hooks that keep failing
    log({ fn: "booking-webhook", workspace: ws, error: String((e as any)?.message ?? e), provider: b.provider });
    return json({ ok: true, stored: false });
  }
});
