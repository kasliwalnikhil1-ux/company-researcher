// outreach-mcp/tools_webchat.ts — web chat (web-chat-PRD.md §13.4): website inboxes, visitors, canned responses, settings.
// Reads through the member's RLS client / RPCs; writes are confirmation-gated. Webchat threads themselves use the existing
// inbox tools (inbox_pending / inbox_thread / inbox_send_reply): the send path routes to the web chat RPC by provider.
import type { McpServer } from "npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js";
import { type Ctx, tool, z, wsParam, resolveWs, requireRole, urpc, gate, untrusted, short } from "./ctx.ts";

type Row = Record<string, any>;

function inboxSummary(i: Row): Row {
  const s = i.settings ?? {};
  return {
    id: i.id, name: i.name, client_id: i.client_id, website_token: i.website_token, domains: i.allowed_domains, active: i.is_active, config_version: i.config_version,
    online: i.availability?.online, in_hours: i.availability?.in_hours, agents_online: (i.availability?.agents ?? []).length, collaborators: (i.members ?? []).length,
    ai: i.ai_enabled ? (s.ai?.mode ?? "off") : "off", reply_mailbox: i.reply_mailbox?.email ?? null, continuity: s.continuity?.enabled !== false,
    stats: i.stats, installed_on: Object.keys(i.installed_origins ?? {}), brand_name: s.appearance?.brand_name, mode: s.appearance?.mode,
  };
}

export function registerWebchat(server: McpServer, ctx: Ctx): void {
  tool(server, ctx, {
    name: "webchat_inboxes_list", title: "Website chat inboxes", cls: "read", minRole: "client_viewer", annotations: { readOnlyHint: true },
    description: "List the website chat inboxes (one per site) with online state, collaborators, AI mode, open / waiting counts and where the widget was seen installed. Settings details: webchat_inbox_get.",
    input: { ...wsParam },
  }, async (a) => {
    const ws = resolveWs(ctx, a.workspace_id);
    const rows = (await urpc<Row[]>(ctx, "webchat_inboxes", { p_ws: ws.id })) ?? [];
    return { inboxes: rows.map(inboxSummary) };
  });

  tool(server, ctx, {
    name: "webchat_inbox_get", title: "Website chat inbox settings", cls: "read", minRole: "client_viewer", annotations: { readOnlyHint: true },
    description: "Full settings of one website inbox (appearance, launcher, messages, pre-chat form, features, CSAT, continuity, AI, targeting, security, business hours) plus availability and stats. The HMAC secret is never returned here.",
    input: { inbox_id: z.string() },
  }, async (a) => {
    const i = await urpc<Row>(ctx, "webchat_inbox_get", { p_id: a.inbox_id });
    const { hmac_token: _h, ...rest } = i;
    return { ...rest, summary: inboxSummary(i) };
  });

  tool(server, ctx, {
    name: "webchat_visitor_get", title: "Website visitor", cls: "read", minRole: "client_viewer", annotations: { readOnlyHint: true },
    description: "Who a website visitor is: identity (verified / unverified), device and location, current page and pages visited, custom attributes, conversations, the linked lead with its outreach context, and lead candidates by email. Use the visitor_id from an inbox thread (chat.visitor_id).",
    input: { visitor_id: z.string() },
  }, async (a) => {
    const v = await urpc<Row>(ctx, "webchat_visitor", { p_id: a.visitor_id });
    return {
      ...v,
      name: untrusted("webchat_visitor", v.name), company: untrusted("webchat_visitor", v.company),
      custom_attributes: v.custom_attributes && Object.keys(v.custom_attributes).length ? { untrusted_content: true, source: "webchat_visitor_attributes", value: v.custom_attributes } : v.custom_attributes,
      pages: (v.pages ?? []).slice(0, 20), events: (v.events ?? []).slice(0, 20),
    };
  });

  tool(server, ctx, {
    name: "webchat_report", title: "Web chat report", cls: "read", minRole: "client_viewer", annotations: { readOnlyHint: true },
    description: "Web chat numbers for a period (inclusive dates): conversations by source, resolved, AI-resolved, handoffs, first response / resolution times, CSAT, visitors converted to leads, sequences stopped by a chat, continuity emails, top unanswered questions.",
    input: { ...wsParam, inbox_id: z.string().optional().describe("One inbox; omit for the whole workspace."), from: z.string().describe("YYYY-MM-DD"), to: z.string().describe("YYYY-MM-DD") },
  }, async (a) => {
    const ws = resolveWs(ctx, a.workspace_id);
    const r = await urpc<Row>(ctx, "webchat_report", { p_ws: ws.id, p_inbox: a.inbox_id ?? null, p_from: a.from, p_to: a.to });
    const summary = `${r.conversations} conversations (${r.resolved} resolved, ${r.ai_resolved} by the assistant alone, ${r.handoffs} handoffs); CSAT ${r.csat?.avg ?? "n/a"} on ${r.csat?.responses ?? 0} responses; ${r.visitor_to_lead} visitors matched a lead, ${r.sequences_stopped} sequences stopped by a chat.`;
    return { ...r, summary };
  });

  tool(server, ctx, {
    name: "canned_responses_list", title: "Canned responses", cls: "read", minRole: "client_viewer", annotations: { readOnlyHint: true },
    description: "Canned responses for web chat replies: type /shortcut at the start of a reply and the platform expands it (variables {{contact.name}}, {{contact.first_name}}, {{agent.name}}).",
    input: { ...wsParam },
  }, async (a) => {
    const ws = resolveWs(ctx, a.workspace_id);
    const rows = (await urpc<Row[]>(ctx, "webchat_canned_list", { p_ws: ws.id })) ?? [];
    return { canned: rows.map((r) => ({ id: r.id, shortcut: `/${r.short_code}`, content: r.content, personal: !!r.owner_id })) };
  });

  tool(server, ctx, {
    name: "canned_response_save", title: "Save a canned response (confirmation required)", cls: "gated", minRole: "member", annotations: { idempotentHint: true },
    description: "Create or update a canned response. Shared by default; personal = only for the connected member. Confirmation-gated.",
    input: { ...wsParam, id: z.string().optional(), shortcut: z.string().min(1).max(40).describe("Letters, digits, - and _ (leading / optional)."), content: z.string().min(1).max(5000), personal: z.boolean().optional() },
  }, async (a) => {
    const ws = resolveWs(ctx, a.workspace_id);
    requireRole(ws, "member");
    const g = await gate(ctx, "canned_response_save", a as Record<string, unknown>, `${a.id ? "Update" : "Create"} canned response /${a.shortcut.replace(/^\//, "")} (${a.personal ? "personal" : "shared"}): "${short(a.content, 100)}"`, ws.id);
    if (!g.proceed) return g.result;
    const r = await urpc<Row>(ctx, "webchat_canned_save", { p_ws: ws.id, p_id: a.id ?? null, p_short_code: a.shortcut, p_content: a.content, p_personal: !!a.personal });
    return { saved: { id: r.id, shortcut: `/${r.short_code}`, personal: !!r.owner_id } };
  });

  tool(server, ctx, {
    name: "webchat_settings_update", title: "Update website chat settings (confirmation required)", cls: "gated", minRole: "manager", annotations: { idempotentHint: true },
    description: "Change settings of a website inbox. `settings` is merged section by section (appearance, launcher, popup, messages, pre_chat, features, csat, continuity, ai, targeting, security, assignment, locale); top-level fields: name, allowed_domains, is_active, ai_enabled, enforce_identity, reply_mailbox_id, business_hours. Every save is a version and reaches the widget within 5 minutes. Confirmation-gated; show the user exactly what changes.",
    input: { inbox_id: z.string(), patch: z.record(z.string(), z.unknown()).describe("e.g. {\"settings\":{\"messages\":{\"greeting\":\"Hi!\"}}} or {\"is_active\":false}") },
  }, async (a) => {
    const i = await urpc<Row>(ctx, "webchat_inbox_get", { p_id: a.inbox_id });
    const ws = resolveWs(ctx, i.workspace_id);
    requireRole(ws, "manager");
    const keys = Object.keys(a.patch);
    const sections = a.patch.settings && typeof a.patch.settings === "object" ? Object.keys(a.patch.settings as Record<string, unknown>) : [];
    const g = await gate(ctx, "webchat_settings_update", a as Record<string, unknown>, `Update website "${i.name}": ${keys.filter((k) => k !== "settings").join(", ")}${sections.length ? ` + settings sections ${sections.join(", ")}` : ""} → new version v${(i.config_version ?? 0) + 1}`, ws.id, a.patch);
    if (!g.proceed) return g.result;
    const r = await urpc<Row>(ctx, "webchat_inbox_update", { p_id: a.inbox_id, p_patch: a.patch });
    return { updated: inboxSummary(r) };
  });

  tool(server, ctx, {
    name: "webchat_conversation_update", title: "Web chat conversation actions (confirmation required)", cls: "gated", minRole: "member", annotations: { idempotentHint: true },
    description: "Resolve, reopen, snooze, assign, set priority or labels on a web chat conversation. Resolving sends the CSAT prompt. Confirmation-gated.",
    input: { chat_id: z.string(), status: z.enum(["open", "pending", "snoozed", "resolved"]).optional(), snoozed_until: z.string().optional().describe("ISO time (with status snoozed)"), assigned_to: z.string().nullable().optional(), priority: z.enum(["urgent", "high", "medium", "low"]).nullable().optional(), labels: z.array(z.string()).optional() },
  }, async (a) => {
    const { chat_id, ...patch } = a;
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    if (!Object.keys(clean).length) return { error: "nothing to change" };
    const g = await gate(ctx, "webchat_conversation_update", a as Record<string, unknown>, `Conversation ${chat_id}: ${Object.entries(clean).map(([k, v]) => `${k} → ${JSON.stringify(v)}`).join(", ")}`, null);
    if (!g.proceed) return g.result;
    const r = await urpc<Row>(ctx, "webchat_conversation_update", { p_chat: chat_id, p_patch: clean });
    return { conversation: { id: r.id, status: r.status, assigned_to: r.assigned_to, priority: r.priority, labels: r.labels, snoozed_until: r.snoozed_until } };
  });
}
