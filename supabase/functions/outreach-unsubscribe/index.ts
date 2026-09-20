// Item 20 — unsubscribe link + RFC 8058 one-click unsubscribe. Public: deploy with --no-verify-jwt, no auth header needed.
//   GET  ?l=<lead id>&t=<token>   → a small confirmation page with one button. GET never unsubscribes by itself:
//                                    mail scanners and link previews open every link in an email.
//   POST ?l=<lead id>&t=<token>   → verifies the token and calls outreach_unsubscribe_lead. This is both the page's button and the
//                                    mailbox provider's one-click request (List-Unsubscribe-Post: List-Unsubscribe=One-Click).
// The token is HMAC-SHA256(OUTREACH_CRON_SECRET, "unsub:<lead id>") (crypto.ts). Invalid token → 400 page. Nothing is deleted:
// the lead keeps its history, the existing `unsubscribed` flag exits every sequence and cancels queued actions.
// Hosting note: on the default *.supabase.co domain Supabase serves HTML from GET requests as text/plain. Use a custom functions
// domain (OUTREACH_FUNCTIONS_BASE_URL), or set OUTREACH_UNSUBSCRIBE_PAGE_URL to a web page that shows the button and POSTs here
// (JSON answers are returned when the request asks for application/json).
import { admin, serve, json, log, rpc, CORS, WEB_ORIGIN } from "../_shared/outreach/supabase.ts";
import { verifyUnsubscribeToken } from "../_shared/outreach/crypto.ts";

type Row = Record<string, any>;
// Default: the web app's public /unsubscribe page (app/unsubscribe/page.tsx). Set OUTREACH_UNSUBSCRIBE_PAGE_URL="off" to serve the HTML from here instead (needs a custom functions domain).
const PAGE_ENV = (Deno.env.get("OUTREACH_UNSUBSCRIBE_PAGE_URL") ?? "").trim();
const PAGE_URL = PAGE_ENV === "off" ? "" : (PAGE_ENV || `${WEB_ORIGIN.replace(/\/$/, "")}/unsubscribe`);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** The public subset of the workspace branding (same fields as SQL outreach__public_branding: no sender address details). */
async function brandingFor(workspaceId: string | null): Promise<Row> {
  if (!workspaceId) return {};
  try {
    const { data } = await admin.from("outreach_workspaces").select("name, branding").eq("id", workspaceId).is("deleted_at", null).maybeSingle();
    const b: Row = { ...(data?.branding ?? {}) };
    delete b.email_from_address; delete b.email_from_name;
    return { workspace_name: data?.name ?? null, ...b };
  } catch { return {}; }
}

function page(opts: { status: number; title: string; body: string; brand: Row; action?: string | null }): Response {
  const b = opts.brand ?? {};
  const accent = /^#[0-9a-fA-F]{6}$/.test(String(b.accent ?? "")) ? String(b.accent) : "#1f2937";
  const name = b.product_name || b.workspace_name || "";
  const logo = /^https:\/\//.test(String(b.logo_url ?? "")) ? `<img src="${esc(b.logo_url)}" alt="${esc(name)}" style="max-height:36px;max-width:180px">` : (name ? `<div class="name">${esc(name)}</div>` : "");
  const support = b.support_email ? `<p class="muted">Questions? Write to <a href="mailto:${esc(b.support_email)}">${esc(b.support_email)}</a>.</p>` : "";
  const form = opts.action ? `<form method="post" action="${esc(opts.action)}"><button type="submit">Unsubscribe</button></form>` : "";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${esc(opts.title)}</title>
<style>
  body{margin:0;background:#f6f7f9;color:#111827;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  main{max-width:440px;margin:12vh auto;padding:32px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;text-align:center}
  .name{font-weight:600;font-size:18px} h1{font-size:20px;margin:20px 0 8px} p{margin:8px 0;color:#374151} .muted{color:#6b7280;font-size:14px;margin-top:20px}
  button{margin-top:16px;padding:10px 22px;border:0;border-radius:8px;background:${accent};color:#fff;font-size:16px;cursor:pointer} a{color:${accent}}
</style></head>
<body><main>${logo}<h1>${esc(opts.title)}</h1><p>${esc(opts.body)}</p>${form}${support}</main></body></html>`;
  return new Response(html, { status: opts.status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex", ...CORS } });
}

serve("unsubscribe", async (req) => {
  const url = new URL(req.url);
  const leadId = (url.searchParams.get("l") ?? url.searchParams.get("lead") ?? "").trim();
  const token = (url.searchParams.get("t") ?? url.searchParams.get("token") ?? "").trim();
  const wantsJson = (req.headers.get("accept") ?? "").includes("application/json");
  const bad = (brand: Row = {}) => wantsJson
    ? json({ ok: false, code: "E_INVALID_LINK", error: "This unsubscribe link is not valid." }, 400)
    : page({ status: 400, title: "This link is not valid", body: "The unsubscribe link is incomplete or has been changed. Use the link from the email again, or reply to the email and ask to be removed.", brand });

  if (req.method !== "GET" && req.method !== "POST" && req.method !== "HEAD") return json({ error: "method not allowed", code: "E_METHOD" }, 405);

  // cheap abuse guard; a real recipient never gets near it
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const allowed = await rpc<boolean>("rate_limit", { p_key: `unsub:${ip}`, p_limit: 60, p_window_secs: 60 }).catch(() => true);
  if (!allowed) return json({ error: "too many requests", code: "E_RATE_LIMITED" }, 429);

  if (!UUID_RE.test(leadId) || !(await verifyUnsubscribeToken(leadId, token))) return bad();

  const { data: lead } = await admin.from("outreach_leads").select("id, workspace_id, unsubscribed").eq("id", leadId).maybeSingle();
  if (!lead) return bad();
  const brand = await brandingFor(lead.workspace_id);
  // query-only form target: it resolves against the page URL, so it works behind /functions/v1/ and behind a custom domain alike
  const self = `?l=${encodeURIComponent(leadId)}&t=${encodeURIComponent(token)}`;

  if (req.method === "GET" || req.method === "HEAD") {
    if (wantsJson) return json({ ok: true, unsubscribed: !!lead.unsubscribed, branding: brand });
    if (PAGE_URL) {
      const to = new URL(PAGE_URL); to.searchParams.set("l", leadId); to.searchParams.set("t", token);
      return new Response(null, { status: 303, headers: { location: to.toString(), "cache-control": "no-store", ...CORS } });
    }
    if (lead.unsubscribed) return page({ status: 200, title: "You are unsubscribed", body: "You will not get any more emails from us.", brand });
    return page({ status: 200, title: "Unsubscribe from these emails?", body: "Press the button and we will stop emailing you. It takes effect right away.", brand, action: self });
  }

  // POST: the page's button, a web page calling with JSON, or the mailbox provider's one-click request (body: List-Unsubscribe=One-Click)
  const bodyText = await req.text().catch(() => "");
  const oneClick = /List-Unsubscribe\s*=\s*One-Click/i.test(bodyText);
  const ok = await rpc<boolean>("unsubscribe_lead", { p_lead: leadId, p_source: oneClick ? "one_click" : "link" });
  log({ fn: "unsubscribe", lead_id: leadId, one_click: oneClick, ok });
  if (!ok) return bad(brand);
  if (oneClick || wantsJson) return json({ ok: true, unsubscribed: true });
  return page({ status: 200, title: "You are unsubscribed", body: "You will not get any more emails from us. Nothing else is needed.", brand });
});
