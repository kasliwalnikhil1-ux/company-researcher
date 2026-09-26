// outreach-mcp/tools_channels.ts — Instagram & WhatsApp channels (instagram-whatsapp-channels-PRD §6, §8, §11.4, §12;
// CHANNELS-BUILD-CONTRACT §3, §5).
//
// Consent is the WhatsApp gate: a new chat to a lead needs a recorded consent basis, and the basis is something a
// PERSON states. This file records what the human said (basis + evidence, attested by the signed-in member) and never
// infers consent from a bio, a CSV column or a hunch. Every rule lives in the outreach_consent_* / outreach_identity_*
// SQL functions; this file only shapes arguments and output. Reports are the platform's own report functions
// (one source of numbers): nothing here counts rows, divides or re-derives a share.
import type { McpServer } from "npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js";
import { type Ctx, tool, z, wsParam, resolveWs, requireRole, urpc, unwrap, McpError, gate, periodSchema, period, wsTz, short } from "./ctx.ts";

type Row = Record<string, any>;

export const CHANNELS = ["LINKEDIN", "INSTAGRAM", "WHATSAPP"] as const;
const CONSENT_CHANNELS = ["WHATSAPP", "INSTAGRAM"] as const;
export const CONSENT_BASES = ["inbound", "form_optin", "existing_customer", "linkedin_reply", "explicit_share", "imported_attested"] as const;

export const CHANNEL_LABEL: Record<string, string> = { LINKEDIN: "LinkedIn", INSTAGRAM: "Instagram", WHATSAPP: "WhatsApp", GMAIL: "Gmail", OUTLOOK: "Outlook", IMAP: "IMAP" };
export const channelLabel = (p: string | null | undefined) => (p ? CHANNEL_LABEL[p] ?? p : "");

const BASIS_MEANING: Record<string, string> = {
  inbound: "they messaged us first (recorded automatically on an inbound WhatsApp message)",
  form_optin: "they opted in on a form; the evidence url or note says which",
  existing_customer: "a prior commercial relationship; the evidence url or note says which",
  linkedin_reply: "they replied to us on LinkedIn and shared or accepted contact",
  explicit_share: "they gave their number in a conversation we hold (evidence: the message)",
  imported_attested: "WEAKEST BASIS: an operator attested consent at import. Flagged amber in every report and in the app; the consent report alerts when it exceeds 30 % of contacted leads",
};

const WEAKEST = "imported_attested is the weakest basis: an operator's attestation, not the lead's own act. It is flagged amber in every report.";

/** Evidence object → one quotable phrase, verbatim values. */
export function evidenceText(ev: Row | null | undefined): string {
  if (!ev || typeof ev !== "object") return "none given";
  const parts: string[] = [];
  if (ev.message_id) parts.push(`message ${ev.message_id}`);
  if (ev.chat_id) parts.push(`chat ${ev.chat_id}`);
  if (ev.form_id) parts.push(`form ${ev.form_id}`);
  if (ev.url) parts.push(`url ${ev.url}`);
  if (ev.note) parts.push(`note "${String(ev.note).replace(/\s+/g, " ").slice(0, 200)}"`);
  if (ev.imported_from) parts.push(`imported from ${ev.imported_from}`);
  for (const [k, v] of Object.entries(ev)) if (!["message_id", "chat_id", "form_id", "url", "note", "imported_from", "attested_by"].includes(k) && v != null && v !== "") parts.push(`${k} ${String(v).slice(0, 120)}`);
  return parts.length ? parts.join(", ") : "none given";
}

const consentLine = (c: Row) => ({
  id: c.id, lead_id: c.lead_id, lead: c.lead_name, channel: c.channel, basis: c.basis,
  weakest_basis: c.basis === "imported_attested" ? true : undefined,
  obtained_at: c.obtained_at, expires_at: c.expires_at, evidence: c.evidence && Object.keys(c.evidence).length ? c.evidence : undefined,
  attested_by_email: c.attested_by_email, revoked_at: c.revoked_at, revoked_reason: c.revoked_reason,
});

async function loadLead(ctx: Ctx, leadId: string): Promise<Row> {
  const { data, error } = await ctx.user.from("outreach_leads").select("id, workspace_id, full_name, company, do_not_contact, unsubscribed").eq("id", leadId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new McpError("E_NOT_FOUND", `lead ${leadId} not found or not visible to you`);
  return data as Row;
}

const periodText = (p: Row | undefined) => (p ? `${p.from} to ${p.to}${p.timezone ? ` (${p.timezone})` : ""}` : "the period");
const pctText = (v: unknown) => (v === null || v === undefined ? "n/a" : `${v}%`);

export function registerChannels(server: McpServer, ctx: Ctx): void {
  // ---------------------------------------------------------------- consent
  tool(server, ctx, {
    name: "consent_list", title: "Consent records", cls: "read", minRole: "client_viewer",
    description: "Recorded consent bases (WhatsApp, and Instagram where known) of a workspace or one lead: basis, when it was obtained, the evidence, who attested it, expiry and revocation. Active records only unless include_revoked. Bases: inbound (they wrote first; recorded automatically), form_optin, existing_customer, linkedin_reply, explicit_share, imported_attested (the WEAKEST basis: an operator's attestation at import, flagged amber in every report). WhatsApp needs an active record before a new chat; replies into an existing chat never need one. Use consent_grant to record what a human states.",
    input: { ...wsParam, lead_id: z.string().optional(), channel: z.enum(CONSENT_CHANNELS).optional(), basis: z.enum(CONSENT_BASES).optional(), include_revoked: z.boolean().optional(), limit: z.number().int().min(1).max(500).optional().describe("default 200") },
  }, async (a) => {
    const ws = resolveWs(ctx, a.workspace_id);
    const rows = (await urpc<Row[]>(ctx, "consent_list", { p_ws: ws.id, p_lead: a.lead_id ?? null, p_channel: a.channel ?? null, p_basis: a.basis ?? null, p_include_revoked: a.include_revoked === true, p_limit: a.limit ?? 200 })) ?? [];
    const attested = rows.filter((r) => r.basis === "imported_attested" && !r.revoked_at).length;
    return {
      workspace: ws.name, count: rows.length, consents: rows.map(consentLine),
      basis_meaning: Object.fromEntries([...new Set(rows.map((r) => r.basis))].map((b) => [b, BASIS_MEANING[b]])),
      note: attested ? `${attested} active record(s) rest on imported_attested. ${WEAKEST}` : undefined,
    };
  });

  tool(server, ctx, {
    name: "consent_grant", title: "Record consent (confirmation required)", cls: "gated", minRole: "member",
    description: "Record a consent basis for a lead on WhatsApp (or Instagram, advisory) so a new chat may be planned. THE HUMAN MUST STATE THE BASIS AND THE EVIDENCE: you record what the human said. Never infer consent from a bio, a website, a CSV column, a phone number's presence or a hunch, and never pick a basis yourself; if the human cannot name one, there is no consent and the lead is not contacted on WhatsApp. An agent may not attest on a human's behalf: the record carries the signed-in member as the attesting person, and the confirmation summary quotes lead name, channel, basis and evidence verbatim so they can check it. Bases: inbound, form_optin (needs evidence url or note), existing_customer (needs evidence url or note), linkedin_reply, explicit_share (evidence: the message_id / chat_id where they shared the number), imported_attested (weakest; flagged amber in every report; the consent report alerts above 30 %). Evidence keys: url, note, form_id, message_id, chat_id. An older active record for the same lead + channel is replaced. Two-step confirmation.",
    input: {
      lead_id: z.string(), channel: z.enum(CONSENT_CHANNELS), basis: z.enum(CONSENT_BASES),
      evidence: z.object({ url: z.string().max(2000).optional(), note: z.string().max(2000).optional(), form_id: z.string().max(200).optional(), message_id: z.string().max(200).optional(), chat_id: z.string().max(200).optional() }).optional().describe("What the human pointed at, verbatim. form_optin / existing_customer need url or note."),
      obtained_at: z.string().optional().describe("ISO date/time the consent was given (default now)"),
      expires_at: z.string().optional().describe("ISO date/time after which the basis no longer counts (optional)"),
      confirmation_token: z.string().optional(),
    },
  }, async (a) => {
    const lead = await loadLead(ctx, a.lead_id);
    const ws = resolveWs(ctx, lead.workspace_id); requireRole(ws, "member");
    const ev = a.evidence ?? {};
    const name = lead.full_name ?? a.lead_id;
    const summary = `Record ${channelLabel(a.channel)} consent for ${name}${lead.company ? ` (${lead.company})` : ""}: basis "${a.basis}", evidence: ${evidenceText(ev)}.${a.obtained_at ? ` Obtained ${a.obtained_at}.` : ""}${a.expires_at ? ` Expires ${a.expires_at}.` : ""} Attested by ${ctx.email ?? ctx.userId}.${a.basis === "imported_attested" ? ` ${WEAKEST}` : ""}${lead.do_not_contact || lead.unsubscribed ? " NOTE: this lead is suppressed; consent does not lift a suppression." : ""}`;
    const g = await gate(ctx, "consent_grant", a as Record<string, unknown>, summary, ws.id);
    if (!g.proceed) return g.result;
    const id = await urpc<string>(ctx, "consent_grant", { p_lead: a.lead_id, p_channel: a.channel, p_basis: a.basis, p_evidence: ev, p_obtained_at: a.obtained_at ?? null, p_expires_at: a.expires_at ?? null });
    return { consent_id: id, lead_id: a.lead_id, lead: name, channel: a.channel, basis: a.basis, evidence: Object.keys(ev).length ? ev : undefined, attested_by_email: ctx.email, weakest_basis: a.basis === "imported_attested" || undefined, note: a.basis === "imported_attested" ? WEAKEST : undefined, next: a.channel === "WHATSAPP" ? "The planner may now start a WhatsApp chat with this lead (still subject to a verified number, the identifier check, the sender's quiet period and its new-chat level)." : "Instagram consent is advisory: it is shown, it does not gate the engagement ladder." };
  });

  tool(server, ctx, {
    name: "consent_revoke", title: "Revoke consent (confirmation required)", cls: "gated", minRole: "member",
    description: "Revoke a consent record. Live enrollments of that lead whose current channel is the consent channel exit (exited_suppressed, reason consent_revoked) and queued actions on senders of that channel are cancelled. Replies into an existing chat stay possible. Irreversible without a new consent_grant. Two-step confirmation.",
    input: { consent_id: z.string(), reason: z.string().min(2).max(200).optional().describe("default 'manual'"), confirmation_token: z.string().optional() },
    annotations: { destructiveHint: true },
  }, async (a) => {
    const { data: c, error } = await ctx.user.from("outreach_lead_consent").select("id, workspace_id, lead_id, channel, basis, revoked_at, outreach_leads(full_name)").eq("id", a.consent_id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!c) throw new McpError("E_NOT_FOUND", `consent ${a.consent_id} not found or not visible to you`);
    const ws = resolveWs(ctx, (c as Row).workspace_id); requireRole(ws, "member");
    if ((c as Row).revoked_at) return { consent_id: a.consent_id, already_revoked_at: (c as Row).revoked_at };
    const name = (c as Row).outreach_leads?.full_name ?? (c as Row).lead_id;
    const ch = channelLabel((c as Row).channel);
    const g = await gate(ctx, "consent_revoke", a as Record<string, unknown>, `Revoke ${ch} consent (basis "${(c as Row).basis}") of ${name}. Reason: ${a.reason ?? "manual"}. Every live ${ch} enrollment of this lead exits and its queued ${ch} actions are cancelled; the lead, its history and its chats are kept. Replying to a message they send stays allowed. A new chat needs a new consent record.`, ws.id);
    if (!g.proceed) return g.result;
    await urpc(ctx, "consent_revoke", { p_id: a.consent_id, p_reason: a.reason ?? "manual" });
    return { consent_id: a.consent_id, revoked: true, lead_id: (c as Row).lead_id, lead: name, channel: (c as Row).channel, effect: `live ${ch} enrollments of the lead exited (consent_revoked); queued ${ch} actions cancelled; history kept` };
  });

  // ---------------------------------------------------------------- identities
  tool(server, ctx, {
    name: "identity_list", title: "Lead identities", cls: "read", minRole: "client_viewer",
    description: "The handles / numbers the platform knows for one lead, per channel: LinkedIn slug, Instagram handle, WhatsApp number (E.164), with verified (only verified identities are used for outreach), source (import | inbound | profile_fetch | operator | enrichment | backfill), is_valid (WhatsApp: the number check; null = not checked yet) and last_checked_at. Identities are never inferred across channels: a LinkedIn profile does not imply a WhatsApp number.",
    input: { lead_id: z.string() },
  }, async (a) => {
    const lead = await loadLead(ctx, a.lead_id);
    const rows = (await urpc<Row[]>(ctx, "identity_list", { p_lead: a.lead_id })) ?? [];
    return {
      lead_id: lead.id, lead: lead.full_name, count: rows.length,
      identities: rows.map((r) => ({ id: r.id, channel: r.provider, identifier: r.identifier, provider_id: r.provider_id, verified: r.verified, source: r.source, is_valid: r.is_valid, last_checked_at: r.last_checked_at, created_at: r.created_at, usable: r.verified && r.is_valid !== false ? true : undefined })),
      note: rows.some((r) => !r.verified) ? "Unverified identities are shown but never used for an outreach action until a person verifies them in the app or an inbound message proves them." : undefined,
    };
  });

  tool(server, ctx, {
    name: "identity_add", title: "Add a lead identity", cls: "write", minRole: "member",
    description: "Record an Instagram handle, a WhatsApp number or a LinkedIn slug for a lead. UNVERIFIED BY DEFAULT: an unverified identity is shown but never used for an outreach action until a person verifies it in the app or an inbound message proves it. Pass verified:true only when the human states the identifier comes from the lead themselves (they wrote it in a message, it is on their card). Never guess a handle or a number from a name, a bio or a LinkedIn profile. WhatsApp numbers need a country code (+91 98765 43210 or 0091…); a bare local number is refused (E_PAYLOAD_INVALID), the platform never guesses the country. Instagram handles may be given as @handle or an instagram.com URL. If the identifier already belongs to another lead the platform refuses (E_IDENTITY_CONFLICT) and names that lead.",
    input: { lead_id: z.string(), provider: z.enum(CHANNELS), identifier: z.string().min(1).max(200).describe("Handle, E.164 number or LinkedIn slug/URL, as the human gave it"), source: z.enum(["operator", "import", "inbound", "enrichment"]).optional().describe("default operator"), verified: z.boolean().optional().describe("default false"), provider_id: z.string().max(200).optional().describe("The provider's own id when known (rare)") },
  }, async (a) => {
    const lead = await loadLead(ctx, a.lead_id);
    const ws = resolveWs(ctx, lead.workspace_id); requireRole(ws, "member");
    const id = await urpc<string>(ctx, "identity_add", { p_lead: a.lead_id, p_provider: a.provider, p_identifier: a.identifier, p_source: a.source ?? "operator", p_verified: a.verified === true, p_provider_id: a.provider_id ?? null });
    const rows = (await urpc<Row[]>(ctx, "identity_list", { p_lead: a.lead_id }).catch(() => [] as Row[])) ?? [];
    const row = rows.find((r) => r.id === id);
    return {
      identity_id: id, lead_id: a.lead_id, lead: lead.full_name, channel: a.provider, identifier: row?.identifier ?? a.identifier, verified: row?.verified ?? a.verified === true, source: row?.source ?? a.source ?? "operator",
      note: (row?.verified ?? a.verified === true) ? undefined : "Recorded as unverified: it is shown on the lead but not used for outreach until a person verifies it in the app or an inbound message proves it.",
      next: a.provider === "WHATSAPP" ? "Before any new WhatsApp chat the platform checks the number is on WhatsApp (identifier_check) and needs a recorded consent basis (consent_list / consent_grant)." : a.provider === "INSTAGRAM" ? "Instagram outreach follows the engagement ladder (sequence_templates: instagram_ladder); the profile read fills the provider id." : undefined,
    };
  });

  // ---------------------------------------------------------------- capacity
  tool(server, ctx, {
    name: "channel_capacity", title: "Channel capacity (Instagram / WhatsApp / LinkedIn)", cls: "read", minRole: "client_viewer",
    description: "Per sender, from the platform's own ledger: channel, status, level (WhatsApp: the new-chat governor level 0–4 = 2/5/10/20/35 new chats a day; Instagram: warm-up level 0–5, level 0 cannot DM), quiet_until (a freshly connected WhatsApp number waits 24 h before outreach), today {type: remaining} (new_chat, message, follow, like, comment, profile_view, identifier_check…) and for Instagram hour {cap, remaining} (10 metered actions an hour, replies excluded). Remaining numbers are what the planner can still spend, never a target. Filter by client.",
    input: { ...wsParam, client_id: z.string().optional(), provider: z.enum(CHANNELS).optional().describe("Only senders of this channel") },
  }, async (a) => {
    const ws = resolveWs(ctx, a.workspace_id);
    const rows = ((await urpc<Row[]>(ctx, "channel_capacity", { p_ws: ws.id, p_client: a.client_id ?? null })) ?? []).filter((r) => !a.provider || r.provider === a.provider);
    return {
      workspace: ws.name, count: rows.length,
      senders: rows.map((r) => ({
        sender_id: r.sender_id, name: r.name, channel: r.provider, status: r.status, level: r.level,
        quiet_until: r.quiet_until && new Date(r.quiet_until) > new Date() ? r.quiet_until : undefined,
        today: r.today, hour: r.hour ?? undefined,
        note: r.provider === "WHATSAPP" && r.level === 0 ? "Level 0: 2 new chats a day until 7 days connected, 5 inbound conversations and an attested account age over 6 months." : r.provider === "INSTAGRAM" && r.level === 0 ? "Level 0: follow, like and view only; no DMs until level 1." : undefined,
      })),
      note: "Instagram: at most 10 metered actions an hour and a daily total per level (15/30/50/70/85/100). WhatsApp: new chats per governor level, messages into existing chats 100 a day, replies uncapped. A sender inside its quiet period plans no outbound work.",
    };
  });

  // ---------------------------------------------------------------- reports (thin RPC calls; one source of numbers)
  tool(server, ctx, {
    name: "report_channels", title: "Channel efficiency report", cls: "read", minRole: "client_viewer",
    description: "One row per channel (linkedin, instagram, whatsapp, email) for a period, from the platform's report function: senders, actions (metered outbound: invites + new chats + messages + InMails + emails + likes + comments + follows), new_chats, replies, replies_per_100_actions, interested, blocks, reply_rate. Instagram and WhatsApp are lower-volume, higher-conversion channels: the right answer to a low ceiling is better targeting, not more senders. Quote the numbers as returned. Default period 30d.",
    input: { ...wsParam, period: periodSchema, client_id: z.string().optional() },
  }, async (a) => {
    const ws = resolveWs(ctx, a.workspace_id);
    const p = period(a.period ?? "30d", wsTz(ws));
    const r = await urpc<Row>(ctx, "report_channels", { p_ws: ws.id, p_client: a.client_id ?? null, p_from: p.from, p_to: p.to });
    const rows: Row[] = r?.rows ?? [];
    return { workspace: ws.name, period: r?.period ?? p, rows, summary: rows.length ? `From ${periodText(r?.period ?? p)}: ${rows.map((x) => `${x.channel}: ${x.actions ?? 0} action(s), ${x.new_chats ?? 0} new chat(s), ${x.replies ?? 0} repl${Number(x.replies) === 1 ? "y" : "ies"} (${x.replies_per_100_actions ?? "n/a"} per 100 actions, reply rate ${pctText(x.reply_rate)}), ${x.interested ?? 0} interested, ${x.blocks ?? 0} block(s)`).join("; ")}.` : `No channel activity from ${periodText(r?.period ?? p)}.` };
  });

  tool(server, ctx, {
    name: "report_consent", title: "WhatsApp consent report", cls: "read", minRole: "client_viewer",
    description: "The artefact produced if a client's number is challenged: leads contacted on WhatsApp (a new chat started by one of the workspace's WhatsApp senders in the period) by consent basis, with the evidence and who attested each record. Returns contacted, by_basis {basis: {leads, share_pct}}, imported_attested_share_pct, alert (true when imported_attested exceeds 30 % of contacted leads: the weakest basis, flagged amber) and rows [{lead, basis, obtained_at, evidence, attested_by_email, first_new_chat_at, sender_name}]. Quote it; never recompute a share. Default period 30d.",
    input: { ...wsParam, period: periodSchema, client_id: z.string().optional(), limit: z.number().int().min(1).max(500).optional().describe("Rows to return (default 100)") },
  }, async (a) => {
    const ws = resolveWs(ctx, a.workspace_id);
    const p = period(a.period ?? "30d", wsTz(ws));
    const r = await urpc<Row>(ctx, "consent_report", { p_ws: ws.id, p_client: a.client_id ?? null, p_from: p.from, p_to: p.to });
    const rows: Row[] = r?.rows ?? [];
    const shown = rows.slice(0, a.limit ?? 100);
    const byBasis = Object.entries((r?.by_basis ?? {}) as Record<string, Row>).map(([b, v]) => `${b} ${v.leads ?? 0} (${pctText(v.share_pct)})${b === "imported_attested" ? " [weakest basis, amber]" : ""}`).join(", ");
    return {
      workspace: ws.name, period: r?.period ?? p, contacted: r?.contacted ?? 0, by_basis: r?.by_basis, imported_attested_share_pct: r?.imported_attested_share_pct, alert: r?.alert || undefined,
      rows_found: rows.length, returned: shown.length,
      rows: shown.map((x) => ({ lead_id: x.lead_id, lead: x.lead_name, basis: x.basis, weakest_basis: x.basis === "imported_attested" ? true : undefined, obtained_at: x.obtained_at, evidence: x.evidence && Object.keys(x.evidence).length ? x.evidence : undefined, attested_by_email: x.attested_by_email, first_new_chat_at: x.first_new_chat_at, sender: x.sender_name })),
      summary: `From ${periodText(r?.period ?? p)}: ${r?.contacted ?? 0} lead(s) contacted on WhatsApp for the first time${byBasis ? `; by basis: ${byBasis}` : ""}.${r?.alert ? ` ALERT: ${pctText(r?.imported_attested_share_pct)} rest on imported_attested, above the 30 % threshold. Tell the user: this is the weakest basis and a client challenge would rest on the operator's attestation alone.` : ""}`,
      next: rows.length ? "report_export(kind:'leads') is the CSV path for a full export; this tool returns the rows the app's Consent tab shows." : undefined,
    };
  });

  tool(server, ctx, {
    name: "report_blocks", title: "Blocks and restrictions log", cls: "read", minRole: "client_viewer",
    description: "Detected blocks per sender for a period (Instagram / WhatsApp: a recipient blocked the sender, a send to a previously valid number failed, a chat went one-way after our first message), each with the lead, the code and the 5 actions that preceded it (preceding: [{at, type, lead_id}]), plus by_sender totals. A block on WhatsApp demotes the sender one governor level immediately. This log is how the governor's thresholds get tuned with real data; report it, do not explain it away. Optional sender filter. Default period 30d.",
    input: { ...wsParam, period: periodSchema, client_id: z.string().optional(), sender_id: z.string().optional(), limit: z.number().int().min(1).max(500).optional().describe("Rows to return (default 100)") },
  }, async (a) => {
    const ws = resolveWs(ctx, a.workspace_id);
    const p = period(a.period ?? "30d", wsTz(ws));
    const r = await urpc<Row>(ctx, "report_blocks", { p_ws: ws.id, p_client: a.client_id ?? null, p_from: p.from, p_to: p.to, p_sender: a.sender_id ?? null });
    const rows: Row[] = r?.rows ?? [];
    const shown = rows.slice(0, a.limit ?? 100);
    const bySender: Row[] = r?.by_sender ?? [];
    return {
      workspace: ws.name, period: r?.period ?? p, rows_found: rows.length, returned: shown.length,
      by_sender: bySender,
      rows: shown.map((x) => ({ at: x.at, sender_id: x.sender_id, sender: x.sender_name, channel: x.provider, lead_id: x.lead_id, lead: x.lead_name, code: x.code, preceding: x.preceding })),
      summary: bySender.length ? `From ${periodText(r?.period ?? p)}: ${bySender.map((s) => `${s.name} ${s.blocks} block(s)`).join(", ")}.` : `No blocks detected from ${periodText(r?.period ?? p)}.`,
    };
  });
}

export { unwrap, short };
