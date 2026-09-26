// Action execution for worker-tick: the only path to Unipile writes (plus send-reply / imports / reconnect / sender-* / worker-enrich).
// Rules this file keeps (docs/outreach/PLAN-BUILD-CONTRACT.md):
//   - the graph comes from outreach_enrollment_graph (version pinning), the variant from outreach_node_config_for / payload.variant_id
//   - "did they reply?" and "are they blacklisted?" are asked of the database at SEND time (reply_blocked / suppression_reason)
//   - text is rendered at SEND time with outreach_render_context, so enrichment that arrived with the prefetch is used
//   - every LinkedIn read reserves a budget first (profile_view, post_fetch); no budget means "later", never "call anyway"
import { admin, log, rpc, emitEvent, randInt, sha256Hex, FUNCTIONS_BASE } from "./supabase.ts";
import { unipile, UnipileError, distanceToRelation, invitationPending } from "./unipile.ts";
import { handleUnipileError, isRejectCode, type Decision } from "./errors.ts";
import { renderTemplate, buildContext, type RenderContext } from "./render.ts";
import { recordReject } from "./health.ts";
import { notifySender } from "./notify.ts";
import { reconnectLink } from "./inbound.ts";
import { unsubscribeToken } from "./crypto.ts";
import { enrichBackoff, fetchPosts, fetchPostsBudgeted, postsToRows, saveProfile, sectionsFor, storedPosts, tomorrowMorning } from "./enrich.ts";
import { findEmail, companyDomainOf, finderConfigured } from "./finder.ts";
import { applyProfileChange } from "./profile.ts";
import { attendeeIdFor, commentLimit, isNotOnWhatsApp, messageLimit, phoneDigits, PROVIDER_WARNING_RE, type LeadIdentity } from "./channels.ts";

type Row = Record<string, any>;

export type ExecResult = { ok: true; response: unknown; branch?: string | null } | { ok: false; decision: Decision; code: string; retryAt?: Date; branch?: string | null };

const LIMITS = { invite_note: 300, invite_note_free: 200, message: 8000, comment: 1250, inmail_subject: 200, inmail_body: 1900 };
const VOICE_BUCKET = "outreach-attachments";
/** Action types that address a lead through its channel identity (Instagram / WhatsApp senders resolve it once per action). */
const IDENTITY_TYPES = new Set(["new_chat", "message", "follow", "unfollow", "like", "comment", "identifier_check", "profile_view", "post_fetch"]);

/** Node config with the enrollment's variant merged over it. Mirrors SQL outreach_node_config_for (text / note / subject / html + variant_id). */
async function resolveNodeConfig(enrollmentId: string, node: Row, payload: Row): Promise<Row> {
  const cfg: Row = { ...(node?.config ?? {}) };
  const variants: Row[] = Array.isArray(cfg.variants) ? cfg.variants : [];
  delete cfg.variants;
  if (!variants.length) return cfg;
  const pinned = payload?.variant_id ? variants.find((v) => v?.id === payload.variant_id) : null;
  if (pinned) {
    for (const k of ["text", "note", "subject", "html"]) if (pinned[k] !== undefined && pinned[k] !== null) cfg[k] = pinned[k];
    cfg.variant_id = pinned.id;
    return cfg;
  }
  // no variant on the action (queued text was refreshed, or the variant was removed by a publish): ask the database, the pick is sticky
  try { return await rpc<Row>("node_config_for", { p_enrollment: enrollmentId, p_node: node }); }
  catch (e) { log({ fn: "execute", warn: `node_config_for: ${String((e as any)?.message ?? e)}` }); return cfg; }
}

export async function loadContext(action: Row) {
  const [{ data: sender }, { data: lead }, { data: enrollment }] = await Promise.all([
    admin.from("outreach_senders").select("*").eq("id", action.sender_id).single(),
    action.lead_id ? admin.from("outreach_leads").select("*").eq("id", action.lead_id).maybeSingle() : Promise.resolve({ data: null } as any),
    action.enrollment_id ? admin.from("outreach_enrollments").select("*").eq("id", action.enrollment_id).maybeSingle() : Promise.resolve({ data: null } as any),
  ]);
  let sequence: Row | null = null, node: Row | null = null, lss: Row | null = null, nodeCfg: Row = {};
  if (enrollment) {
    const [{ data: seq }, graph] = await Promise.all([
      admin.from("outreach_sequences").select("id, status, settings, client_id, workspace_id, name").eq("id", enrollment.sequence_id).single(),
      rpc<Row | null>("enrollment_graph", { p_enrollment: enrollment.id }),   // pinned version when the lead is pinned, else the live graph
    ]);
    sequence = seq;
    node = graph?.nodes?.[action.node_id] ?? null;
    if (action.payload?.subtask && node?.config?.subtasks?.[action.payload.subtask_index]) {
      const st = node.config.subtasks[action.payload.subtask_index];
      node = { ...node, type: action.payload.subtask_type ?? st.type, config: { ...st }, branches: {} };
      nodeCfg = { ...st };
    } else if (node) {
      nodeCfg = await resolveNodeConfig(enrollment.id, node, action.payload ?? {});
    }
  }
  if (lead && sender) {
    const { data: st } = await admin.from("outreach_lead_sender_state").select("*").eq("lead_id", lead.id).eq("sender_id", sender.id).maybeSingle();
    lss = st;
    if (!lss && action.lead_id) {
      await admin.from("outreach_lead_sender_state").upsert({ lead_id: lead.id, sender_id: sender.id }, { onConflict: "lead_id,sender_id", ignoreDuplicates: true });
      lss = { lead_id: lead.id, sender_id: sender.id, relation: "none", replied: false };
    }
  }
  return { sender, lead, enrollment, sequence, node, nodeCfg, lss };
}

async function updateLeadFromProfile(lead: Row, prof: Row): Promise<Row> {
  const current = (prof.work_experience ?? []).find((w: Row) => w.current) ?? prof.work_experience?.[0];
  const patch: Record<string, unknown> = {
    provider_id: prof.provider_id ?? lead.provider_id,
    public_identifier: lead.public_identifier ?? (prof.public_identifier ? String(prof.public_identifier).toLowerCase() : null),
    first_name: prof.first_name ?? lead.first_name,
    last_name: prof.last_name ?? lead.last_name,
    full_name: [prof.first_name, prof.last_name].filter(Boolean).join(" ") || lead.full_name,
    headline: prof.headline ?? lead.headline,
    location: prof.location ?? lead.location,
    picture_url: prof.profile_picture_url ?? lead.picture_url,
    is_open_profile: typeof prof.is_open_profile === "boolean" ? prof.is_open_profile : lead.is_open_profile,
    company: current?.company ?? lead.company,
    company_id: current?.company_id ?? lead.company_id,
    title: current?.position ?? lead.title,
    profile_url: prof.public_profile_url ?? lead.profile_url,
    last_profile_fetch_at: new Date().toISOString(),
  };
  if (prof.contact_info?.emails?.length && !lead.email_work) patch.email_work = String(prof.contact_info.emails[0]).toLowerCase();
  const { data } = await admin.from("outreach_leads").update(patch).eq("id", lead.id).select("*").single();
  return data ?? { ...lead, ...patch };
}

async function syncRelationFromProfile(lead: Row, sender: Row, prof: Row, lss: Row | null): Promise<string> {
  const rel = distanceToRelation(prof.network_distance);
  const pending = invitationPending(prof);
  let relation = lss?.relation ?? "none";
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (rel === "first") { relation = "first"; patch.relation = "first"; if (!lss?.invite_accepted_at) patch.invite_accepted_at = new Date().toISOString(); patch.invite_detected_at = lss?.invite_detected_at ?? new Date().toISOString(); }
  else if (pending) { relation = "pending_out"; patch.relation = "pending_out"; }
  else if (relation === "first" && rel === "none") { /* keep: profile may be throttled */ }
  else if (relation !== "invalid" && relation !== "blocked" && rel === "none" && relation !== "pending_out") { patch.relation = "none"; relation = "none"; }
  if (Object.keys(patch).length > 1) await admin.from("outreach_lead_sender_state").update(patch).eq("lead_id", lead.id).eq("sender_id", sender.id);
  return relation;
}

interface FetchOpts { notify?: boolean; source: "prefetch" | "step" | "draft" | "background" | "manual"; backoffSections?: string }

/**
 * One profile fetch = lead fields + relation + enrichment (item 13 free path). Asks for the named full sections
 * (about, experience, education, skills, languages) unless LinkedIn is throttling this sender, then for previews.
 * The caller owns the profile_view budget: the claimed action's own reservation, or budgetedProfile() below.
 */
async function fetchAndStore(sender: Row, lead: Row, lss: Row | null, opts: FetchOpts): Promise<{ prof: Row; lead: Row; relation: string; full: boolean }> {
  const ident = lead.provider_id ?? lead.public_identifier;
  if (!ident) throw new UnipileError(422, "errors/invalid_recipient", "lead has no LinkedIn identifier", null);
  const sec = sectionsFor(sender);
  const query = sec.full ? sec.query : (opts.backoffSections ?? sec.query);
  const prof = await unipile.users.profile(sender.unipile_account_id, ident, { notify: opts.notify ?? false, linkedin_sections: query });
  const updated = await updateLeadFromProfile(lead, prof);
  const relation = await syncRelationFromProfile(updated, sender, prof, lss);
  await saveProfile(updated, prof, sender, opts.source, sec.requested);   // empty sections go through as empty = "unknown" in SQL
  return { prof, lead: updated, relation, full: sec.full };
}

/** A profile fetch that is NOT the claimed action itself: reserve profile_view → fetch → consume (release on failure). null = no budget left today. */
async function budgetedProfile(sender: Row, lead: Row, lss: Row | null, opts: FetchOpts): Promise<{ prof: Row; lead: Row; relation: string; full: boolean } | null> {
  const day = await rpc<string>("sender_local_date", { p_sender: sender.id, p_at: new Date().toISOString() });
  const reserved = await rpc<boolean>("reserve_budget", { p_sender: sender.id, p_day: day, p_type: "profile_view" }).catch(() => false);
  if (!reserved) return null;
  try {
    const r = await fetchAndStore(sender, lead, lss, opts);
    await rpc("consume_budget", { p_sender: sender.id, p_day: day, p_type: "profile_view" }).catch((e) => log({ fn: "execute", warn: `consume profile_view: ${String(e)}` }));
    return r;
  } catch (e) {
    await rpc("release_budget", { p_sender: sender.id, p_day: day, p_type: "profile_view" }).catch(() => null);
    throw e;
  }
}

interface ChatRowOpts { identity?: LeadIdentity | null; attendeeId?: string | null; isRequest?: boolean }

/**
 * The outreach_chats row for a connector chat id (provider = the sender's). `isRequest` (an Instagram chat we just
 * created lands in the recipient's Requests tab) is set on the INSERT of a new row only; an existing row keeps its flag.
 */
async function ensureChatRow(sender: Row, lead: Row | null, unipileChatId: string, subject?: string | null, opts: ChatRowOpts = {}): Promise<Row> {
  const channel = sender.provider === "INSTAGRAM" || sender.provider === "WHATSAPP";
  if (!channel) {
    // LinkedIn / mail: unchanged upsert
    const { data } = await admin.from("outreach_chats").upsert({
      workspace_id: sender.workspace_id, client_id: sender.client_id, sender_id: sender.id, lead_id: lead?.id ?? null, unipile_chat_id: unipileChatId, provider: sender.provider,
      attendee_provider_id: lead?.provider_id ?? lead?.email_work ?? null, attendee_public_identifier: lead?.public_identifier ?? null, attendee_name: lead?.full_name ?? null, attendee_picture_url: lead?.picture_url ?? null, subject: subject ?? null,
    }, { onConflict: "sender_id,unipile_chat_id" }).select("*").single();
    return data!;
  }
  const { data: existing } = await admin.from("outreach_chats").select("*").eq("sender_id", sender.id).eq("unipile_chat_id", unipileChatId).maybeSingle();
  const attendeeProviderId = opts.attendeeId ?? opts.identity?.provider_id ?? null;
  const attendeePub = opts.identity?.identifier ?? null;
  if (existing) {
    const patch: Record<string, unknown> = {};
    if (!existing.lead_id && lead?.id) patch.lead_id = lead.id;
    if (!existing.attendee_name && lead?.full_name) patch.attendee_name = lead.full_name;
    if (!existing.attendee_public_identifier && attendeePub) patch.attendee_public_identifier = attendeePub;
    if (subject && !existing.subject) patch.subject = subject;
    if (Object.keys(patch).length) { const { data } = await admin.from("outreach_chats").update(patch).eq("id", existing.id).select("*").single(); return data ?? { ...existing, ...patch }; }
    return existing;
  }
  const row: Record<string, unknown> = {
    workspace_id: sender.workspace_id, client_id: sender.client_id, sender_id: sender.id, lead_id: lead?.id ?? null, unipile_chat_id: unipileChatId, provider: sender.provider,
    attendee_provider_id: attendeeProviderId, attendee_public_identifier: attendeePub, attendee_name: lead?.full_name ?? null, attendee_picture_url: lead?.picture_url ?? null, subject: subject ?? null,
  };
  if (opts.isRequest) row.is_request = true;
  const { data, error } = await admin.from("outreach_chats").upsert(row, { onConflict: "sender_id,unipile_chat_id" }).select("*").single();
  if (error && opts.isRequest) {
    // the is_request column is added by 025; keep sending even while the migration is pending
    delete row.is_request;
    const { data: again } = await admin.from("outreach_chats").upsert(row, { onConflict: "sender_id,unipile_chat_id" }).select("*").single();
    return again!;
  }
  return data!;
}

/** Instagram: the recipient answered / we replied → the thread is no longer a message request. */
async function clearRequestFlag(chatId: string): Promise<void> {
  await admin.from("outreach_chats").update({ is_request: false }).eq("id", chatId).eq("is_request", true).then(({ error }) => { if (error) log({ fn: "execute", warn: `is_request: ${error.message}` }); });
}

// ---- channel identities (Instagram / WhatsApp)

/** The usable identity of a lead on the sender's provider (outreach_lead_identity: verified rows only; LinkedIn falls back to the lead). */
async function leadIdentity(lead: Row, provider: string): Promise<LeadIdentity | null> {
  const r = await rpc<Row | null>("lead_identity", { p_lead: lead.id, p_provider: provider });
  if (!r || typeof r !== "object") return null;
  return { id: r.id ?? null, identifier: r.identifier ?? null, provider_id: r.provider_id ?? null, verified: r.verified !== false, is_valid: r.is_valid ?? null };
}

/** Store the outcome of a provider read on the identity (validity + the messaging id). */
async function setIdentityCheck(identity: LeadIdentity | null, valid: boolean, providerId: string | null): Promise<void> {
  if (!identity?.id) return;
  await rpc("identity_set_check", { p_id: identity.id, p_valid: valid, p_provider_id: providerId }).catch((e) => log({ fn: "execute", warn: `identity_set_check: ${String((e as any)?.message ?? e)}` }));
}

/** Instagram profile response → lead fields (name, picture, profile URL) + the identity's messaging id + follow-back relation. */
async function applyInstagramProfile(sender: Row, lead: Row, identity: LeadIdentity | null, prof: Row, lss: Row | null): Promise<{ lead: Row; messagingId: string | null; followedBy: boolean }> {
  const messagingId = prof.provider_messaging_id ? String(prof.provider_messaging_id) : prof.provider_id ? String(prof.provider_id) : null;
  const handle = prof.public_identifier ? String(prof.public_identifier).toLowerCase() : identity?.identifier ?? null;
  const name = String(prof.full_name ?? prof.name ?? "").trim();
  const parts = name.split(/\s+/).filter(Boolean);
  const patch: Record<string, unknown> = { last_profile_fetch_at: new Date().toISOString() };
  if (name && !lead.full_name) { patch.full_name = name; patch.first_name = lead.first_name ?? parts[0] ?? null; patch.last_name = lead.last_name ?? (parts.slice(1).join(" ") || null); }
  if (prof.profile_picture_url && !lead.picture_url) patch.picture_url = prof.profile_picture_url;
  if (handle && !lead.profile_url && sender.provider === "INSTAGRAM") patch.profile_url = `https://www.instagram.com/${handle}`;
  const { data } = await admin.from("outreach_leads").update(patch).eq("id", lead.id).select("*").single();
  await setIdentityCheck(identity, true, messagingId);
  const followedBy = prof.relationship_status?.followed_by === true;
  if (followedBy && lss?.relation !== "first" && lss?.relation !== "blocked" && lss?.relation !== "invalid") {
    // they follow us back: the relation change is what advances a "wait for follow back" step (outreach_trg_relation)
    const now = new Date().toISOString();
    await admin.from("outreach_lead_sender_state").update({ relation: "first", invite_accepted_at: lss?.invite_accepted_at ?? now, invite_detected_at: now, updated_at: now }).eq("lead_id", lead.id).eq("sender_id", sender.id);
  }
  return { lead: data ?? { ...lead, ...patch }, messagingId, followedBy };
}

/**
 * Instagram messaging needs the profile's messaging id. When the identity has none yet: a budgeted profile read
 * (reserve profile_view → GET /users/{handle} → consume) that also stores the id on the identity. null = no budget today.
 */
async function ensureInstagramMessagingId(sender: Row, lead: Row, identity: LeadIdentity, lss: Row | null): Promise<{ identity: LeadIdentity; lead: Row } | null> {
  if (identity.provider_id) return { identity, lead };
  const ident = identity.identifier;
  if (!ident) throw new UnipileError(422, "errors/invalid_recipient", "lead has no Instagram handle", null);
  const day = await rpc<string>("sender_local_date", { p_sender: sender.id, p_at: new Date().toISOString() });
  const reserved = await rpc<boolean>("reserve_budget", { p_sender: sender.id, p_day: day, p_type: "profile_view" }).catch(() => false);
  if (!reserved) return null;
  try {
    const prof = await unipile.users.profile(sender.unipile_account_id, ident);
    await rpc("consume_budget", { p_sender: sender.id, p_day: day, p_type: "profile_view" }).catch((e) => log({ fn: "execute", warn: `consume profile_view: ${String(e)}` }));
    const r = await applyInstagramProfile(sender, lead, identity, prof, lss);
    return { identity: { ...identity, provider_id: r.messagingId }, lead: r.lead };
  } catch (e) {
    await rpc("release_budget", { p_sender: sender.id, p_day: day, p_type: "profile_view" }).catch(() => null);
    throw e;
  }
}

/** Instagram posts of a lead (GET /users/{id}/posts, the post_fetch endpoint). NO budget handling: the caller owns the reservation. */
async function fetchInstagramPosts(sender: Row, lead: Row, identity: LeadIdentity, limit = 5): Promise<Row[]> {
  const ident = identity.provider_id ?? identity.identifier;
  if (!ident) throw new UnipileError(422, "errors/invalid_recipient", "lead has no Instagram identifier", null);
  const res = await unipile.users.posts(sender.unipile_account_id, String(ident), limit);
  const rows = postsToRows(res.items ?? []).slice(0, 5);
  await rpc("save_lead_posts", { p_lead: lead.id, p_posts: rows, p_sender: sender.id }).catch((e) => log({ fn: "execute", lead_id: lead.id, error: `save_lead_posts: ${String((e as any)?.message ?? e)}` }));
  return rows;
}

/** Instagram posts behind the post_fetch budget: reserve → list → consume (release on failure). */
async function fetchInstagramPostsBudgeted(sender: Row, lead: Row, identity: LeadIdentity): Promise<{ ok: true; posts: Row[] } | { ok: false; reason: "no_budget" }> {
  const day = await rpc<string>("sender_local_date", { p_sender: sender.id, p_at: new Date().toISOString() });
  const reserved = await rpc<boolean>("reserve_budget", { p_sender: sender.id, p_day: day, p_type: "post_fetch" }).catch(() => false);
  if (!reserved) return { ok: false, reason: "no_budget" };
  try {
    const posts = await fetchInstagramPosts(sender, lead, identity, 5);
    await rpc("consume_budget", { p_sender: sender.id, p_day: day, p_type: "post_fetch" }).catch((e) => log({ fn: "execute", warn: `consume post_fetch: ${String(e)}` }));
    return { ok: true, posts };
  } catch (e) {
    await rpc("release_budget", { p_sender: sender.id, p_day: day, p_type: "post_fetch" }).catch(() => null);
    throw e;
  }
}

/** One extra like / follow beyond the claimed action: reserve → call → consume (release on failure). false = no budget left (stop quietly). */
async function budgeted(sender: Row, type: string, call: () => Promise<unknown>): Promise<boolean> {
  const day = await rpc<string>("sender_local_date", { p_sender: sender.id, p_at: new Date().toISOString() });
  const reserved = await rpc<boolean>("reserve_budget", { p_sender: sender.id, p_day: day, p_type: type }).catch(() => false);
  if (!reserved) return false;
  try {
    await call();
    await rpc("consume_budget", { p_sender: sender.id, p_day: day, p_type: type }).catch((e) => log({ fn: "execute", warn: `consume ${type}: ${String(e)}` }));
    return true;
  } catch (e) {
    await rpc("release_budget", { p_sender: sender.id, p_day: day, p_type: type }).catch(() => null);
    throw e;
  }
}

async function recordOutbound(sender: Row, lead: Row | null, chat: Row, text: string | null, html: string | null, unipileMessageId: string | null, actionId: string, isInviteNote = false, attachments: unknown[] = []) {
  const { data: msg } = await admin.from("outreach_messages").upsert({
    workspace_id: sender.workspace_id, chat_id: chat.id, unipile_message_id: unipileMessageId, direction: "out", text, html, attachments, sent_at: new Date().toISOString(), action_id: actionId, is_invite_note: isInviteNote,
  }, { onConflict: "unipile_message_id", ignoreDuplicates: false }).select("id").maybeSingle();
  if (lead) await admin.from("outreach_lead_sender_state").update({ last_outbound_at: new Date().toISOString(), unipile_chat_id: chat.unipile_chat_id, updated_at: new Date().toISOString() }).eq("lead_id", lead.id).eq("sender_id", sender.id);
  return msg;
}

/**
 * The lead's latest own post, for like / comment steps. Uses what the prefetch already stored when it is under a day old;
 * otherwise lists posts behind the post_fetch budget. "no_budget" → the caller retries tomorrow morning (never a skip).
 */
type PostRef = { id: string; text: string; url: string | null };

/** The lead's recent own posts (newest first) that are inside max_age_days. Instagram lists through the identity, LinkedIn through the lead. */
async function recentPosts(sender: Row, lead: Row, identity: LeadIdentity | null, maxAgeDays: number): Promise<PostRef[] | "no_budget"> {
  let rows = await storedPosts(lead.id, 24);
  if (rows === null) {
    if (sender.provider === "INSTAGRAM") {
      if (!identity) return [];
      const res = await fetchInstagramPostsBudgeted(sender, lead, identity);
      if (!res.ok) return "no_budget";
      rows = res.posts;
    } else {
      const res = await fetchPostsBudgeted(sender, lead, 5);
      if (!res.ok) return res.reason === "no_budget" ? "no_budget" : [];
      rows = res.posts;
    }
  }
  const cutoff = Date.now() - maxAgeDays * 86400000;
  const out: PostRef[] = [];
  for (const p of rows) {
    if (!p?.id) continue;
    const t = p.date ? Date.parse(p.date) : NaN;
    if (isNaN(t) || t >= cutoff) out.push({ id: String(p.id), text: String(p.text ?? ""), url: p.url ?? null });
  }
  return out;
}

// ---- email helpers (item 20)
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const looksHtml = (s: string) => /<\s*(?:p|br|div|a|span|table|ul|ol|li|h[1-6]|strong|em|b|i|img|html|body)\b[^>]*>/i.test(s);

/** Plain text → HTML: escaped, line breaks kept, URLs linked (so the unsubscribe / booking URLs become real anchors). */
function textToHtml(text: string): string {
  return esc(text).replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]]/g, (u) => `<a href="${u}">${u}</a>`).replace(/\r?\n/g, "<br>\n");
}

/** Unipile rewrites links for click tracking unless the anchor carries data-disable-tracking. The unsubscribe and booking links must stay clean. */
function protectLinks(html: string, urls: Array<string | null | undefined>): string {
  const keep = urls.filter((u): u is string => !!u).flatMap((u) => [u, esc(u)]);
  if (!keep.length) return html;
  return html.replace(/<a\b([^>]*)>/gi, (tag, attrs: string) => {
    if (/data-disable-tracking/i.test(attrs)) return tag;
    const href = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
    const h = href?.[1] ?? href?.[2] ?? "";
    return h && keep.includes(h) ? `<a${attrs} data-disable-tracking="true">` : tag;
  });
}

function extFor(mime: string, path: string): string {
  const fromPath = /\.([a-z0-9]{2,5})$/i.exec(path)?.[1];
  if (fromPath) return fromPath.toLowerCase();
  return ({ "audio/mp4": "m4a", "audio/m4a": "m4a", "audio/x-m4a": "m4a", "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/webm": "webm", "audio/wav": "wav", "audio/x-wav": "wav" } as Record<string, string>)[mime] ?? "m4a";
}

// ---------------------------------------------------------------------------
export async function executeAction(action: Row): Promise<ExecResult> {
  const { sender, lead, enrollment, sequence, node, nodeCfg, lss } = await loadContext(action);
  const type: string = action.action_type;
  const offLinkedIn = type === "find_email" || type === "call_api";
  if (!sender || (!sender.unipile_account_id && !offLinkedIn)) return { ok: false, decision: { kind: "sender_credentials", reason: "no_account" }, code: "E_SENDER_NOT_OK" };
  const payload: Row = action.payload ?? {};
  const cfg: Row = { ...nodeCfg, ...payload };
  const nodeType: string = payload.subtask ? (payload.subtask_type ?? node?.type ?? "") : (node?.type ?? "");
  const isPrefetch = !!payload.prefetch;
  const provider: string = String(sender.provider ?? "LINKEDIN").toUpperCase();
  const isChannel = provider === "INSTAGRAM" || provider === "WHATSAPP";
  const isVoice = (type === "message" || type === "new_chat") && (nodeType === "send_voice_note" || cfg.voice === true);
  const hasBranch = (b: string) => !!node?.branches && node.branches[b] != null;
  const branchOrSkip = (name: string, reason: string): Decision => (hasBranch(name) ? { kind: "branch", name, reason } : { kind: "skip_node", reason });
  const baseCtx = { actionType: type, attempt: action.attempt ?? 1, senderTimezone: sender.timezone ?? "UTC", hasBranch, provider };
  const later = (reason: string, code: string): ExecResult => ({ ok: false, decision: { kind: "retry", at: tomorrowMorning(sender.timezone ?? "UTC"), reason }, code });

  // ---- pre-checks (PRD F3 step 2)
  if (lead?.do_not_contact || lead?.unsubscribed) return { ok: false, decision: { kind: "suppressed", reason: lead.unsubscribed ? "unsubscribed" : "do_not_contact" }, code: lead.unsubscribed ? "unsubscribed" : "do_not_contact" };
  if (enrollment) {
    const live = ["active", "waiting_connection", "waiting_delay", "waiting_task"];
    if (!live.includes(enrollment.status)) return { ok: false, decision: { kind: "fail_enrollment", reason: "enrollment_not_live" }, code: "E_ENROLLMENT_NOT_LIVE" };
    if (sequence?.status !== "active") return { ok: false, decision: { kind: "retry", at: new Date(Date.now() + 6 * 3600_000), reason: "sequence_not_active" }, code: "E_SEQUENCE_PAUSED" };
    // item 17: a blacklist entry added mid-campaign still stops the next step (workspace, client and sequence scope)
    const why = await rpc<string | null>("enrollment_suppression_reason", { p_enrollment: enrollment.id });
    if (why) return { ok: false, decision: { kind: "suppressed", reason: why }, code: String(why).slice(0, 120) };
    // item 1: the database decides whether a reply blocks this enrollment (any sender, any channel; honours scope, OOO resume, re-enrol)
    if (!cfg.send_always && !isPrefetch && ["message", "new_chat", "inmail", "email", "invite"].includes(type)) {
      const blocked = await rpc<boolean>("enrollment_reply_blocked", { p_enrollment: enrollment.id, p_action_sender: sender.id });
      if (blocked) return { ok: false, decision: { kind: "replied", reason: "replied" }, code: "E_REPLIED" };
    }
    // keep the variant on the action row so per-variant stats stay right when the text was re-resolved at send time
    if (cfg.variant_id && !isPrefetch && action.variant_id !== cfg.variant_id) await admin.from("outreach_actions").update({ variant_id: cfg.variant_id }).eq("id", action.id);
  }
  if (type === "invite") {
    const used = await rpc<number>("weekly_invites_used", { p_sender: sender.id, p_day: new Date().toISOString().slice(0, 10) });
    const { data: ceil } = await admin.from("outreach_platform_ceilings").select("per_week").eq("action_type", "invite").single();
    if (used > (ceil?.per_week ?? 150)) return { ok: false, decision: { kind: "retry", at: new Date(Date.now() + 24 * 3600_000), reason: "weekly_cap" }, code: "E_CAP_HIT_WEEKLY" };
    if (lss?.relation === "first") return { ok: false, decision: branchOrSkip("connected", "already_connected"), code: "already_connected" };
    if (lss?.relation === "pending_out") return { ok: false, decision: { kind: "skip_node", reason: "invitation_pending" }, code: "invitation_pending" };
    if (lss?.relation === "invalid" || lss?.relation === "blocked") return { ok: false, decision: { kind: "fail_enrollment", reason: `relation_${lss.relation}` }, code: "E_RELATION_INVALID" };
  }

  let l: Row | null = lead;
  // Instagram / WhatsApp: the lead is addressed through its channel identity (outreach_lead_identities), resolved once per action.
  let identity: LeadIdentity | null = null;
  if (isChannel && l && IDENTITY_TYPES.has(type)) {
    identity = await leadIdentity(l, provider);
    if (!identity) return { ok: false, decision: { kind: "fail_enrollment", reason: "no_identity" }, code: "E_NO_IDENTITY" };
    if (lss?.relation === "blocked") return { ok: false, decision: { kind: "fail_enrollment", reason: "relation_blocked" }, code: "E_RELATION_INVALID" };
  }
  try {
    if ((type === "message" || type === "new_chat") && provider === "LINKEDIN" && lss?.relation !== "first" && !cfg.send_always) {
      // LinkedIn only: verify with a live, budgeted profile fetch (may have been accepted without note / stale state)
      let relation = lss?.relation ?? "none";
      if (l && (l.provider_id || l.public_identifier)) {
        const r = await budgetedProfile(sender, l, lss, { source: "step" });
        if (!r) return later("no_profile_view_budget", "E_BUDGET_PROFILE_VIEW");
        l = r.lead; relation = r.relation;
      }
      if (relation !== "first") return { ok: false, decision: branchOrSkip("not_connected", "not_connected"), code: "E_RELATION_REQUIRED" };
    }

    // render context, built at send time from the database (same function the builder preview calls)
    let rctx: RenderContext = { lead: l ?? {}, sender };
    let unsubscribeUrl: string | null = null;
    const needsText = ["invite", "message", "new_chat", "inmail", "reply", "comment", "email", "call_api"].includes(type) && !isPrefetch;
    if (l && needsText) {
      const json = await rpc<Row>("render_context", { p_lead: l.id, p_sender: sender.id, p_enrollment: enrollment?.id ?? null });
      unsubscribeUrl = `${FUNCTIONS_BASE}outreach-unsubscribe?l=${l.id}&t=${await unsubscribeToken(l.id)}`;
      let booking: string | null = json?.sender?.booking_link ?? null;
      if (!booking && enrollment && enrollment.sender_id !== sender.id) {   // a mailbox has no booking link of its own: use the person's
        const { data: owner } = await admin.from("outreach_senders").select("booking_link").eq("id", sender.parent_sender_id ?? enrollment.sender_id).maybeSingle();
        booking = owner?.booking_link ?? null;
      }
      rctx = buildContext(json, { unsubscribe_link: unsubscribeUrl, booking_link: booking });
    }

    switch (type) {
      case "profile_view": {
        if (!l) throw new UnipileError(422, "errors/invalid_recipient", "no lead", null);
        if (provider === "INSTAGRAM") {
          // GET /users/{handle|id}: name + picture on the lead, the messaging id on the identity, followed_by → relation 'first'
          const ident = identity!.provider_id ?? identity!.identifier;
          if (!ident) throw new UnipileError(422, "errors/invalid_recipient", "lead has no Instagram handle", null);
          const prof = await unipile.users.profile(sender.unipile_account_id, String(ident));
          const r = await applyInstagramProfile(sender, l, identity, prof, lss);
          let posts: number | string | null = null;
          if (cfg.needs_posts === true && r.messagingId) {
            try { const pr = await fetchInstagramPostsBudgeted(sender, r.lead, { ...identity!, provider_id: r.messagingId }); posts = pr.ok ? pr.posts.length : pr.reason; }
            catch (e) { posts = "error"; log({ fn: "execute", action_id: action.id, warn: `posts after profile: ${String((e as any)?.message ?? e)}` }); }
          }
          return { ok: true, response: { provider_id: r.messagingId, followed_by: r.followedBy, following: prof.relationship_status?.following ?? null, followers_count: prof.followers_count ?? null, is_private: prof.is_private ?? null, posts } };
        }
        if (provider === "WHATSAPP") {
          // GET /users/{digits}: "is this number on WhatsApp?" as a profile read (name + picture); never spends a new_chat
          const digits = phoneDigits(identity!.identifier);
          if (!digits) throw new UnipileError(422, "errors/invalid_recipient", "lead has no phone number", null);
          try {
            const prof = await unipile.users.profile(sender.unipile_account_id, digits);
            const patch: Record<string, unknown> = { last_profile_fetch_at: new Date().toISOString() };
            if (prof.name && !l.full_name) patch.full_name = String(prof.name);
            if (prof.profile_picture_url && !l.picture_url) patch.picture_url = prof.profile_picture_url;
            await admin.from("outreach_leads").update(patch).eq("id", l.id);
            await setIdentityCheck(identity, true, prof.id ? String(prof.id) : prof.provider_id ? String(prof.provider_id) : null);
            return { ok: true, response: { valid: true, provider_id: prof.id ?? prof.provider_id ?? null, is_business: prof.is_business ?? null } };
          } catch (e) {
            if (!isNotOnWhatsApp(e)) throw e;
            await setIdentityCheck(identity, false, null);
            await admin.from("outreach_lead_sender_state").update({ relation: "invalid", updated_at: new Date().toISOString() }).eq("lead_id", l.id).eq("sender_id", sender.id);
            return { ok: false, decision: branchOrSkip("invalid", "not_on_whatsapp"), code: "E_IDENTIFIER_INVALID" };
          }
        }
        const isRefresh = nodeType === "refresh_profile" || cfg.refresh === true;
        if (isRefresh) {
          // item 13 freshness: skip when enriched within N days; a never-enriched lead is ALWAYS refreshed
          const staleDays = Number(cfg.only_if_stale_days ?? 90);
          const { data: p } = await admin.from("outreach_lead_profiles").select("enriched_at").eq("lead_id", l.id).maybeSingle();
          if (p?.enriched_at && Date.now() - new Date(p.enriched_at).getTime() < staleDays * 86400000) return { ok: false, decision: { kind: "skip_node", reason: "profile_fresh" }, code: "profile_fresh" };
          if (enrichBackoff(sender)) return { ok: false, decision: { kind: "retry", at: new Date(new Date(sender.enrich_backoff_until).getTime() + randInt(5, 30) * 60_000), reason: "enrich_backoff" }, code: "enrich_backoff" };
        }
        const notify = isPrefetch || isRefresh ? cfg.notify === true : cfg.notify !== false;   // prefetch + refresh never show up as a profile visit
        const r = await fetchAndStore(sender, l, lss, { notify, source: isPrefetch ? "prefetch" : "step" });
        let posts: number | string | null = null;
        if (cfg.needs_posts === true) {
          // posts are their own endpoint and their own allowance; a failure here never fails the profile fetch
          try { const pr = await fetchPostsBudgeted(sender, r.lead, 5); posts = pr.ok ? pr.posts.length : pr.reason; }
          catch (e) { posts = "error"; log({ fn: "execute", action_id: action.id, warn: `posts after prefetch: ${String((e as any)?.message ?? e)}` }); }
        }
        return { ok: true, response: { provider_id: r.prof.provider_id, network_distance: r.prof.network_distance, relation: r.relation, is_open_profile: r.prof.is_open_profile, connections_count: r.prof.connections_count, full_sections: r.full, posts } };
      }
      case "post_fetch": {
        // queued by the planner when a step's text needs {{enrich.recent_post}} / an AI line and no profile prefetch is due.
        // The claim already reserved this action's post_fetch budget, so the call is made directly.
        if (provider === "INSTAGRAM") {
          if (!l || !(identity?.provider_id ?? identity?.identifier)) return { ok: false, decision: { kind: "skip_node", reason: "no_provider_id" }, code: "no_provider_id" };
          const rows = await fetchInstagramPosts(sender, l, identity!, 5);
          return { ok: true, response: { posts: rows.length } };
        }
        if (provider === "WHATSAPP") return { ok: false, decision: { kind: "skip_node", reason: "unsupported_post_fetch" }, code: "unsupported_post_fetch" };
        if (!l?.provider_id) return { ok: false, decision: { kind: "skip_node", reason: "no_provider_id" }, code: "no_provider_id" };
        const rows = await fetchPosts(sender, l, 5);
        return { ok: true, response: { posts: rows.length } };
      }
      case "follow": {
        if (provider === "INSTAGRAM") {
          // POST /users/invite with the user id or the username as provider_id
          if (!l) throw new UnipileError(422, "errors/invalid_recipient", "no lead", null);
          const ident = identity!.provider_id ?? identity!.identifier;
          if (!ident) throw new UnipileError(422, "errors/invalid_recipient", "lead has no Instagram handle", null);
          const r = await unipile.users.follow(sender.unipile_account_id, String(ident));
          await emitEvent(sender.workspace_id, "lead.followed", { lead_id: l.id, sender_id: sender.id, provider });
          return { ok: true, response: { followed: true, identifier: ident, result: r?.object ?? null } };
        }
        // Unipile has no follow endpoint for LinkedIn (checked 20 Sep 2026: POST /linkedin/user/{id} only offers recruiter pipeline actions and saveLead;
        // /users/following is read-only). The step is skipped so the sequence carries on; wire it here when the endpoint exists.
        return { ok: false, decision: { kind: "skip_node", reason: "unsupported_follow" }, code: "unsupported_follow" };
      }
      case "unfollow":
        // no unfollow endpoint on any provider: the step is skipped so the sequence carries on
        return { ok: false, decision: { kind: "skip_node", reason: "unsupported_unfollow" }, code: "unsupported_unfollow" };
      case "identifier_check": {
        // WhatsApp "is this number on?": its own action type and budget; NEVER spends a new_chat
        if (provider !== "WHATSAPP") return { ok: false, decision: { kind: "skip_node", reason: "unsupported_identifier_check" }, code: "unsupported_identifier_check" };
        if (!l) throw new UnipileError(422, "errors/invalid_recipient", "no lead", null);
        const digits = phoneDigits(identity!.identifier);
        if (!digits) return { ok: false, decision: branchOrSkip("invalid", "no_phone"), code: "E_IDENTIFIER_INVALID" };
        try {
          const prof = await unipile.users.profile(sender.unipile_account_id, digits);
          const pid = prof.id ? String(prof.id) : prof.provider_id ? String(prof.provider_id) : null;
          await setIdentityCheck(identity, true, pid);
          const patch: Record<string, unknown> = {};
          if (prof.name && !l.full_name) patch.full_name = String(prof.name);
          if (prof.profile_picture_url && !l.picture_url) patch.picture_url = prof.profile_picture_url;
          if (Object.keys(patch).length) await admin.from("outreach_leads").update(patch).eq("id", l.id);
          if (lss?.relation === "invalid") await admin.from("outreach_lead_sender_state").update({ relation: "none", updated_at: new Date().toISOString() }).eq("lead_id", l.id).eq("sender_id", sender.id);
          return { ok: true, response: { valid: true, provider_id: pid, is_business: prof.is_business ?? null }, branch: hasBranch("valid") ? "valid" : null };
        } catch (e) {
          if (!isNotOnWhatsApp(e)) throw e;
          await setIdentityCheck(identity, false, null);
          await admin.from("outreach_lead_sender_state").update({ relation: "invalid", updated_at: new Date().toISOString() }).eq("lead_id", l.id).eq("sender_id", sender.id);
          await emitEvent(sender.workspace_id, "lead.identifier_invalid", { lead_id: l.id, sender_id: sender.id, provider, code: e instanceof UnipileError ? e.code : String(e) });
          return { ok: false, decision: branchOrSkip("invalid", "not_on_whatsapp"), code: "E_IDENTIFIER_INVALID" };
        }
      }
      case "find_email": {
        if (!l) return { ok: false, decision: branchOrSkip("not_found", "no_lead"), code: "no_lead" };
        if (l.email_work && l.email_status === "verified") return { ok: false, decision: branchOrSkip("found", "already_verified"), code: "already_verified" };
        if (!companyDomainOf(l)) return { ok: false, decision: branchOrSkip("not_found", "no_company_domain"), code: "no_company_domain" };
        if (!(await finderConfigured(sender.workspace_id))) return { ok: false, decision: branchOrSkip("not_found", "no_finder_key"), code: "no_finder_key" };
        const hit = await findEmail(sender.workspace_id, l);
        if (!hit) return { ok: true, response: { found: false }, branch: hasBranch("not_found") ? "not_found" : null };
        await rpc("set_lead_email", { p_lead: l.id, p_email: hit.email, p_status: hit.status, p_source: hit.source });
        await emitEvent(sender.workspace_id, "lead.email_found", { lead_id: l.id, status: hit.status, source: hit.source });
        return { ok: true, response: { found: true, status: hit.status, source: hit.source }, branch: hasBranch("found") ? "found" : null };
      }
      case "invite": {
        if (!l) throw new UnipileError(422, "errors/invalid_recipient", "no lead", null);
        if (!l.provider_id) {
          const r = await budgetedProfile(sender, l, lss, { source: "step" });
          if (!r) return later("no_profile_view_budget", "E_BUDGET_PROFILE_VIEW");
          l = r.lead;
          if (r.relation === "first") return { ok: false, decision: branchOrSkip("connected", "already_connected"), code: "already_connected" };
          if (r.relation === "pending_out") return { ok: false, decision: { kind: "skip_node", reason: "invitation_pending" }, code: "invitation_pending" };
          rctx = { ...rctx, lead: { ...rctx.lead, ...l } };
        }
        let note = renderTemplate(cfg.text ?? cfg.note ?? "", rctx).trim();
        const limit = sender.is_premium ? LIMITS.invite_note : LIMITS.invite_note_free;
        if (!sender.is_premium && !cfg.require_note_for_free && note.length > LIMITS.invite_note_free) note = "";
        if (note.length > limit) note = note.slice(0, limit);
        const res = await unipile.users.invite({ account_id: sender.unipile_account_id, provider_id: l!.provider_id, message: note || undefined });
        const now = new Date().toISOString();
        await admin.from("outreach_lead_sender_state").update({ relation: "pending_out", invitation_id: res.invitation_id ?? null, invite_sent_at: now, invite_had_note: !!note, invite_withdrawn_at: null, updated_at: now }).eq("lead_id", l!.id).eq("sender_id", sender.id);
        await emitEvent(sender.workspace_id, "invite.sent", { lead_id: l!.id, sender_id: sender.id, invitation_id: res.invitation_id ?? null, note: !!note });
        return { ok: true, response: { invitation_id: res.invitation_id, usage: res.usage ?? null, note_length: note.length, variant_id: cfg.variant_id ?? null } };
      }
      case "withdraw": {
        if (!l || !lss?.invitation_id) return { ok: false, decision: { kind: "skip_node", reason: "no_invitation" }, code: "no_invitation" };
        await unipile.users.cancelInvite(sender.unipile_account_id, lss.invitation_id);
        const now = new Date().toISOString();
        await admin.from("outreach_lead_sender_state").update({ relation: "none", invite_withdrawn_at: now, invitation_id: null, updated_at: now }).eq("lead_id", l.id).eq("sender_id", sender.id);
        await emitEvent(sender.workspace_id, "invite.withdrawn", { lead_id: l.id, sender_id: sender.id });
        return { ok: true, response: { withdrawn: true } };
      }
      case "message":
      case "new_chat":
      case "inmail":
      case "reply": {
        // `message` = into a chat that already exists; `new_chat` = creating the conversation (every provider, LinkedIn included).
        // The planner decides which one a step spends; the executor never turns a `message` into a chat start.
        if (!l) throw new UnipileError(422, "errors/invalid_recipient", "no lead", null);
        let chatId: string | null = lss?.unipile_chat_id ?? null;
        let existingChat: Row | null = null;
        if (!chatId && type !== "inmail") {
          const { data: c } = await admin.from("outreach_chats").select("*").eq("sender_id", sender.id).eq("lead_id", l.id).not("unipile_chat_id", "is", null).order("last_message_at", { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
          if (c) { existingChat = c; chatId = c.unipile_chat_id; }
        }
        if (type === "message" && !chatId) return { ok: false, decision: branchOrSkip("no_chat", "no_chat"), code: "no_chat" };
        let messageId: string | null = null;
        let subject: string | null = null;
        let attendeeId: string | null = l.provider_id ?? null;
        let createdChat = false;

        if (isChannel) {
          if (provider === "WHATSAPP") {
            // consent is re-checked at SEND time (the planner checked it at plan time); replies into an existing chat are never gated
            if (type === "new_chat" && !chatId) {
              const consent = await rpc<boolean>("lead_has_consent", { p_lead: l.id, p_channel: "WHATSAPP" });
              if (!consent) return { ok: false, decision: branchOrSkip("no_consent", "no_consent"), code: "E_NO_CONSENT" };
              if (identity!.is_valid === false) return { ok: false, decision: branchOrSkip("invalid", "not_on_whatsapp"), code: "E_IDENTIFIER_INVALID" };
            }
          } else if (provider === "INSTAGRAM") {
            if (isVoice) return { ok: false, decision: { kind: "skip_node", reason: "unsupported_voice_note" }, code: "unsupported_voice_note" };
            if (!chatId) {
              const r = await ensureInstagramMessagingId(sender, l, identity!, lss);
              if (!r) return later("no_profile_view_budget", "E_BUDGET_PROFILE_VIEW");
              identity = r.identity; l = r.lead;
              rctx = { ...rctx, lead: { ...rctx.lead, ...l } };
            }
          }
          attendeeId = attendeeIdFor(provider, identity);
          if (!chatId && !attendeeId) throw new UnipileError(422, "errors/invalid_recipient", "lead has no usable identity on this channel", null);
        }
        const chatOpts = (): ChatRowOpts => ({ identity, attendeeId, isRequest: provider === "INSTAGRAM" && createdChat });
        const startChat = (fields: { text?: string; subject?: string; voice_message?: Blob; linkedin?: Record<string, unknown> }) =>
          unipile.chats.start({ account_id: sender.unipile_account_id, attendees_ids: [attendeeId!], ...fields, ...(provider === "LINKEDIN" ? { linkedin: fields.linkedin ?? { api: "classic" } } : {}) });

        if (isVoice) {
          // item 25: one real recording per (sequence, step, sender), sent through Unipile's voice_message field (LinkedIn prefers .m4a; WhatsApp accepts it too)
          if (!enrollment) return { ok: false, decision: { kind: "skip_node", reason: "no_voice_clip" }, code: "no_voice_clip" };
          const { data: clip } = await admin.from("outreach_voice_clips").select("path, mime, duration_s").eq("sequence_id", enrollment.sequence_id).eq("node_id", action.node_id).eq("sender_id", sender.id).maybeSingle();
          if (!clip?.path) return { ok: false, decision: { kind: "skip_node", reason: "no_voice_clip" }, code: "no_voice_clip" };
          const objectPath = String(clip.path).replace(new RegExp(`^/?${VOICE_BUCKET}/`), "");
          const { data: blob, error: dlErr } = await admin.storage.from(VOICE_BUCKET).download(objectPath);
          if (dlErr || !blob) { log({ fn: "execute", action_id: action.id, warn: `voice clip download failed: ${dlErr?.message ?? "empty"}` }); return { ok: false, decision: { kind: "skip_node", reason: "no_voice_clip" }, code: "no_voice_clip" }; }
          const file = new File([blob], `voice-note.${extFor(clip.mime, objectPath)}`, { type: clip.mime || "audio/mp4" });
          if (chatId) { const r = await unipile.chats.send(chatId, { account_id: sender.unipile_account_id, voice_message: file }); messageId = r.message_id ?? null; }
          else { const r = await startChat({ voice_message: file }); chatId = r.chat_id ?? null; messageId = r.message_id ?? null; createdChat = !!chatId; }
          if (chatId) {
            const chat = await ensureChatRow(sender, l, chatId, null, chatOpts());
            await recordOutbound(sender, l, chat, "[Voice note]", null, messageId, action.id, false, [{ type: "audio", voice_note: true, storage_path: objectPath, mime: clip.mime, duration_s: clip.duration_s ?? null }]);
            if (provider === "INSTAGRAM" && !createdChat && (existingChat?.is_request || chat.is_request) && chat.last_direction === "in") await clearRequestFlag(chat.id);
            await emitEvent(sender.workspace_id, "message.sent", { lead_id: l.id, sender_id: sender.id, chat_id: chat.id, type: "voice_note", new_chat: createdChat });
          }
          return { ok: true, response: { chat_id: chatId, message_id: messageId, voice: true, new_chat: createdChat } };
        }

        const text = renderTemplate(cfg.text ?? "", rctx).trim().slice(0, type === "inmail" ? LIMITS.inmail_body : messageLimit(provider));
        if (!text) return { ok: false, decision: { kind: "fail_enrollment", reason: "empty_text" }, code: "E_PAYLOAD_INVALID" };
        if (type === "inmail") {
          if (provider !== "LINKEDIN") return { ok: false, decision: { kind: "skip_node", reason: "unsupported_inmail" }, code: "unsupported_inmail" };
          if (cfg.open_profile_only && l.is_open_profile === false) return { ok: false, decision: branchOrSkip("no_credit", "not_open_profile"), code: "not_open_profile" };
          subject = renderTemplate(cfg.subject ?? "", rctx).slice(0, LIMITS.inmail_subject);
          const r = await unipile.chats.start({ account_id: sender.unipile_account_id, attendees_ids: [l.provider_id], text, subject: subject || undefined, linkedin: { api: cfg.api ?? "classic", inmail: true } });
          chatId = r.chat_id ?? chatId; messageId = r.message_id ?? null;
        } else if (chatId) {
          const r = await unipile.chats.send(chatId, { account_id: sender.unipile_account_id, text });
          messageId = r.message_id ?? null;
        } else {
          const r = await startChat({ text });
          chatId = r.chat_id ?? null; messageId = r.message_id ?? null; createdChat = !!chatId;
        }
        if (chatId) {
          const chat = await ensureChatRow(sender, l, chatId, subject, chatOpts());
          await recordOutbound(sender, l, chat, text, null, messageId, action.id);
          // an Instagram request THEY sent us is accepted by our answer; a request WE sent stays one until they reply
          if (provider === "INSTAGRAM" && !createdChat && (existingChat?.is_request || chat.is_request) && chat.last_direction === "in") await clearRequestFlag(chat.id);
          await emitEvent(sender.workspace_id, "message.sent", { lead_id: l.id, sender_id: sender.id, chat_id: chat.id, type, new_chat: createdChat });
        }
        return { ok: true, response: { chat_id: chatId, message_id: messageId, variant_id: cfg.variant_id ?? null, new_chat: createdChat } };
      }
      case "like":
      case "comment": {
        if (!l) throw new UnipileError(422, "errors/invalid_recipient", "no lead", null);
        if (provider === "WHATSAPP") return { ok: false, decision: { kind: "skip_node", reason: `unsupported_${type}` }, code: `unsupported_${type}` };
        if (provider === "LINKEDIN" && !l.provider_id) {
          const r = await budgetedProfile(sender, l, lss, { source: "step" });
          if (!r) return later("no_profile_view_budget", "E_BUDGET_PROFILE_VIEW");
          l = r.lead;
        }
        const posts = await recentPosts(sender, l!, identity, cfg.max_age_days ?? 90);
        if (posts === "no_budget") return later("no_post_fetch_budget", "E_BUDGET_POST_FETCH");   // tomorrow morning, not a skip
        const post = posts[0];
        if (!post) return { ok: false, decision: { kind: "skip_node", reason: "no_recent_post" }, code: "no_recent_post" };
        if (type === "like") {
          // like_recent_posts: up to cfg.count (≤ 3) recent posts. The first like is the claimed action; every extra like
          // reserves and consumes its own `like` budget and the loop stops quietly when none is left.
          const count = Math.max(1, Math.min(3, Number(cfg.count ?? 1) || 1));
          const liked: string[] = [];
          await unipile.posts.react({ account_id: sender.unipile_account_id, post_id: post.id, reaction_type: cfg.reaction ?? "like" });
          liked.push(post.id);
          let budgetOut = false;
          for (const extra of posts.slice(1, count)) {
            try {
              const ok = await budgeted(sender, "like", () => unipile.posts.react({ account_id: sender.unipile_account_id, post_id: extra.id, reaction_type: cfg.reaction ?? "like" }));
              if (!ok) { budgetOut = true; break; }
              liked.push(extra.id);
            } catch (e) {
              // an extra like that the provider refuses (already reacted, post gone) never fails the step
              log({ fn: "execute", action_id: action.id, warn: `extra like: ${String((e as any)?.message ?? e)}` });
              if (e instanceof UnipileError && (e.status === 429 || e.status === 401 || e.status === 403 || e.status >= 500)) throw e;
            }
          }
          return { ok: true, response: { post_id: post.id, share_url: post.url, liked, requested: count, budget_out: budgetOut } };
        }
        const text = renderTemplate(cfg.text ?? "", { ...rctx, lead: { ...rctx.lead, post: post.text } }).trim().slice(0, commentLimit(provider));
        if (!text) return { ok: false, decision: { kind: "skip_node", reason: "empty_text" }, code: "E_PAYLOAD_INVALID" };
        const r = await unipile.posts.comment(post.id, { account_id: sender.unipile_account_id, text });
        return { ok: true, response: { post_id: post.id, comment_id: r.comment_id ?? null } };
      }
      case "endorse": {
        if (!l) throw new UnipileError(422, "errors/invalid_recipient", "no lead", null);
        // needs the skills section with endorsement ids: a budgeted profile read that also enriches (skills only while backed off)
        const r = await budgetedProfile(sender, l, lss, { source: "step", backoffSections: "skills" });
        if (!r) return later("no_profile_view_budget", "E_BUDGET_PROFILE_VIEW");
        l = r.lead;
        const skills = (r.prof.skills ?? []).filter((s: Row) => s.endorsement_id != null && !s.endorsed).slice(0, Math.max(1, Math.min(5, cfg.count ?? 1)));
        if (!skills.length) return { ok: false, decision: { kind: "skip_node", reason: "no_skills" }, code: "no_skills" };
        const done: string[] = [];
        for (const s of skills) { await unipile.linkedin.endorse({ account_id: sender.unipile_account_id, profile_id: l!.provider_id, skill_endorsement_id: Number(s.endorsement_id) }); done.push(s.name); }
        return { ok: true, response: { endorsed: done } };
      }
      case "email": {
        if (!l) throw new UnipileError(422, "errors/invalid_recipient", "no lead", null);
        const pref = cfg.to ?? "any";
        const to = pref === "work" ? l.email_work : pref === "personal" ? l.email_personal : (l.email_work ?? l.email_personal);
        if (!to) return { ok: false, decision: branchOrSkip("no_email", "no_email"), code: "E_NO_EMAIL" };
        if (l.email_status === "invalid" && to === l.email_work) return { ok: false, decision: branchOrSkip("bounced", "email_invalid"), code: "email_invalid" };
        if (lss?.email_bounced) return { ok: false, decision: branchOrSkip("bounced", "bounced"), code: "email_bounced" };
        const subject = renderTemplate(cfg.subject ?? "", rctx).trim();
        const template: string = cfg.html ?? cfg.text ?? "";
        const isHtml = typeof cfg.html === "string" ? true : looksHtml(template);
        // {{sender.signature}} is the MAILBOX's signature (this action runs on the mailbox sender). A plain-text signature inside an HTML body keeps its line breaks.
        const sig = String(rctx.sender?.signature ?? "");
        const htmlCtx: RenderContext = isHtml && sig && !looksHtml(sig) ? { ...rctx, sender: { ...(rctx.sender ?? {}), signature: esc(sig).replace(/\r?\n/g, "<br>") } } : rctx;
        let html = isHtml ? renderTemplate(template, htmlCtx) : textToHtml(renderTemplate(template, rctx));
        if (!html.trim()) return { ok: false, decision: { kind: "fail_enrollment", reason: "empty_text" }, code: "E_PAYLOAD_INVALID" };
        html = protectLinks(html, [unsubscribeUrl, rctx.booking_link]);
        let replyTo: string | undefined;
        if ((cfg.thread ?? "continue") === "continue") {
          const { data: prev } = await admin.from("outreach_messages").select("unipile_message_id, outreach_chats!inner(sender_id, lead_id)").eq("direction", "out").eq("outreach_chats.sender_id", sender.id).eq("outreach_chats.lead_id", l.id).not("unipile_message_id", "is", null).order("sent_at", { ascending: false }).limit(1).maybeSingle();
          replyTo = (prev as any)?.unipile_message_id ?? undefined;
        }
        let tracking: Record<string, unknown> | undefined;
        if (cfg.track !== false) {
          tracking = { opens: true, links: true, label: action.id };
          const domain = await rpc<string | null>("tracking_domain_for", { p_sender: sender.id }).catch(() => null);
          if (domain) tracking.custom_domain = domain;   // only an ACTIVE domain is ever returned; otherwise Unipile's default is used
        }
        // RFC 8058 one-click unsubscribe. Unipile's send-email accepts these two header names in custom_headers.
        const headers = unsubscribeUrl ? [{ name: "List-Unsubscribe", value: `<${unsubscribeUrl}>` }, { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" }] : undefined;
        const bcc = sender.bcc_address && String(sender.bcc_address).toLowerCase() !== String(to).toLowerCase() ? [{ identifier: String(sender.bcc_address) }] : undefined;
        const r = await unipile.mails.send({ account_id: sender.unipile_account_id, to: [{ identifier: to, display_name: l.full_name ?? undefined }], bcc, subject: subject || undefined, body: html, reply_to: replyTo, tracking_options: tracking, custom_headers: headers });
        const threadKey = replyTo ? (lss?.unipile_chat_id ?? r.provider_id ?? r.tracking_id) : (r.provider_id ?? r.tracking_id);
        const chat = await ensureChatRow(sender, l, threadKey, subject);
        await recordOutbound(sender, l, chat, html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(), html, r.provider_id ?? r.tracking_id, action.id);
        await emitEvent(sender.workspace_id, "email.sent", { lead_id: l.id, sender_id: sender.id, tracking_id: r.tracking_id });
        return { ok: true, response: { tracking_id: r.tracking_id, provider_id: r.provider_id, to, bcc: !!bcc, custom_tracking_domain: tracking?.custom_domain ?? null, variant_id: cfg.variant_id ?? null } };
      }
      case "profile_edit":
        // Profile Studio (PRD §7): pre-snapshot → one PATCH → provisional applied; outreach-worker-profile verifies ≥60 s later.
        return await applyProfileChange(action, sender);
      case "call_api": {
        const url = renderTemplate(cfg.url ?? "", rctx);
        if (!url) return { ok: false, decision: branchOrSkip("error", "no_url"), code: "E_PAYLOAD_INVALID" };
        const u = new URL(url);
        for (const [k, v] of Object.entries(cfg.query ?? {})) { const val = renderTemplate(String(v), rctx); if (!(cfg.remove_empty && !val)) u.searchParams.set(k, val); }
        const headers: Record<string, string> = { "content-type": "application/json" };
        for (const [k, v] of Object.entries(cfg.headers ?? {})) headers[k] = renderTemplate(String(v), rctx);
        let body: string | undefined;
        if ((cfg.method ?? "POST") !== "GET") {
          body = cfg.body ? renderTemplate(String(cfg.body), rctx) : JSON.stringify({ lead: l, sender: { id: sender.id, display_name: sender.display_name }, enrollment_id: enrollment?.id ?? null, sequence_id: sequence?.id ?? null });
        }
        const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 15000);
        try {
          const res = await fetch(u.toString(), { method: cfg.method ?? "POST", headers, body, signal: ctrl.signal });
          const txt = await res.text();
          if (!res.ok) return { ok: false, decision: branchOrSkip("error", `http_${res.status}`), code: `http_${res.status}` };
          return { ok: true, response: { status: res.status, body: txt.slice(0, 2000) } };
        } finally { clearTimeout(t); }
      }
      default:
        return { ok: false, decision: { kind: "skip_node", reason: `unsupported_${type}` }, code: "E_UNSUPPORTED" };
    }
  } catch (e) {
    if (type === "find_email" && !(e instanceof UnipileError)) {
      // a finder outage is not a LinkedIn problem: try again later, never pause the sender
      const attempt = action.attempt ?? 1;
      if (attempt >= 3) return { ok: false, decision: branchOrSkip("not_found", "finder_error"), code: "finder_error" };
      return { ok: false, decision: { kind: "retry", at: new Date(Date.now() + randInt(20, 60) * 60_000), reason: "finder_error" }, code: String((e as any)?.message ?? e).slice(0, 120) };
    }
    const decision = handleUnipileError(e, baseCtx);
    const code = e instanceof UnipileError ? `${e.status}:${e.code}` : String((e as any)?.message ?? e).slice(0, 120);
    if (isChannel && e instanceof UnipileError) {
      // block signal: the recipient blocked this account (WhatsApp / Instagram). Recorded before the lead is marked invalid.
      if (e.code === "blocked_recipient" && (type === "new_chat" || type === "message") && lead) {
        await rpc("record_block", { p_sender: sender.id, p_lead: lead.id, p_code: code, p_action: action.id }).catch((err) => log({ fn: "execute", warn: `record_block: ${String((err as any)?.message ?? err)}` }));
      }
      // Instagram "We suspect automated behavior": surfaced verbatim, one level down, 48 h pause (the operator may resume)
      if (provider === "INSTAGRAM" && e.status === 403 && PROVIDER_WARNING_RE.test(`${e.message ?? ""} ${JSON.stringify(e.body ?? "")}`)) {
        const text = String(e.message || (e.body as any)?.detail || (e.body as any)?.title || "We suspect automated behavior on your account").slice(0, 500);
        await rpc("sender_provider_warning", { p_sender: sender.id, p_text: text }).catch((err) => log({ fn: "execute", warn: `sender_provider_warning: ${String((err as any)?.message ?? err)}` }));
        return { ok: false, decision: { kind: "sender_pause", hours: 48, reason: "provider_warning" }, code };
      }
    }
    if (isRejectCode(e)) {
      const paused = await recordReject(sender.id);
      if (paused) return { ok: false, decision: { kind: "sender_pause", hours: 24, reason: "reject_burst" }, code };
    }
    if (e instanceof UnipileError && e.code === "checkpoint_error") await admin.from("outreach_sender_events").insert({ sender_id: sender.id, kind: "checkpoint", data: { code } });
    if (decision.kind === "sender_credentials") {
      await admin.from("outreach_senders").update({ status: "credentials", status_reason: code, last_disconnect_at: new Date().toISOString() }).eq("id", sender.id).eq("status", "ok");
      if (sender.auth_method !== "cookie") { const link = await reconnectLink(sender).catch(() => null); await notifySender(sender.id, "reconnect_needed", { link }); }
    }
    if (decision.kind === "branch" && decision.name === "connected" && lead) {
      await admin.from("outreach_lead_sender_state").update({ relation: "first", invite_accepted_at: lss?.invite_accepted_at ?? new Date().toISOString(), updated_at: new Date().toISOString() }).eq("lead_id", lead.id).eq("sender_id", sender.id);
    }
    if (e instanceof UnipileError && e.code === "already_invited_recently" && lead) {
      await admin.from("outreach_lead_sender_state").update({ relation: "pending_out", updated_at: new Date().toISOString() }).eq("lead_id", lead.id).eq("sender_id", sender.id);
    }
    return { ok: false, decision, code };
  }
}

/** Persist the outcome through the ledger functions. */
export async function settle(action: Row, result: ExecResult): Promise<void> {
  if (result.ok) {
    await rpc("complete_action", { p_id: action.id, p_response: result.response ?? null, p_branch: result.branch ?? null });
    return;
  }
  const d = result.decision;
  // d.kind is the fail_action decision name, including the clean exits 'replied' (→ exited_replied) and 'suppressed' (→ exited_suppressed)
  const args: Record<string, unknown> = { p_id: action.id, p_code: result.code, p_decision: d.kind, p_retry_at: null, p_branch: null };
  if (d.kind === "retry") args.p_retry_at = d.at.toISOString();
  if (d.kind === "sender_cap_hit") args.p_retry_at = d.until.toISOString();
  if (d.kind === "sender_pause") args.p_retry_at = new Date(Date.now() + d.hours * 3600_000).toISOString();
  if (d.kind === "branch") args.p_branch = d.name;
  if (d.kind === "suppressed") args.p_code = d.reason || result.code;
  await rpc("fail_action", args);
}

export const _test = { sha256Hex, randInt, textToHtml, protectLinks };
