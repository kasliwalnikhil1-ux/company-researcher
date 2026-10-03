// outreach-mcp/tools_webchat.ts — web chat (web-chat-PRD.md §13.4): website inboxes, visitors, canned responses, settings.
// Reads through the member's RLS client / RPCs; writes are confirmation-gated. Webchat threads themselves use the existing
// inbox tools (inbox_pending / inbox_thread / inbox_send_reply): the send path routes to the web chat RPC by provider.
import type { McpServer } from "npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js";
import { type Ctx, tool, z, wsParam, resolveWs, requireRole, urpc, gate, untrusted, short } from "./ctx.ts";

type Row = Record<string, any>;

/**
 * Website agent mode in the app's words (lib/outreach/aiHub.ts websiteModeText): Off · Review · Auto · always |
 * Auto · outside business hours. Stored as ai_enabled + settings.ai.mode (off | first | offline_only | review).
 */
export function websiteModeLabel(i: Row): string {
  const m = i.settings?.ai?.mode;
  if (!i.ai_enabled || !m || m === "off") return "Off";
  return m === "review" ? "Review" : `Auto · ${m === "offline_only" ? "outside business hours" : "always"}`;
}

function inboxSummary(i: Row): Row {
  const s = i.settings ?? {};
  return {
    id: i.id, name: i.name, client_id: i.client_id, website_token: i.website_token, domains: i.allowed_domains, active: i.is_active, config_version: i.config_version,
    online: i.availability?.online, in_hours: i.availability?.in_hours, agents_online: (i.availability?.agents ?? []).length, collaborators: (i.members ?? []).length,
    ai: i.ai_enabled ? (s.ai?.mode ?? "off") : "off", ai_label: websiteModeLabel(i), reply_mailbox: i.reply_mailbox?.email ?? null, continuity: s.continuity?.enabled !== false,
    stats: i.stats, installed_on: Object.keys(i.installed_origins ?? {}), brand_name: s.appearance?.brand_name, mode: s.appearance?.mode,
  };
}

export function registerWebchat(server: McpServer, ctx: Ctx): void {
  tool(server, ctx, {
    name: "webchat_inboxes_list", title: "Website chat inboxes", cls: "read", minRole: "client_viewer", annotations: { readOnlyHint: true },
    description: "List the website chat inboxes (one per site) with online state, collaborators, the Website agent mode (ai = the stored value off | first | offline_only | review; ai_label says it as the app does: Off · Review · Auto), open / waiting counts and where the widget was seen installed. Settings details: webchat_inbox_get. Switch the assistant with website_assistant_set_mode.",
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
    description: "Web chat numbers for a period (inclusive dates): conversations by source, resolved, AI-resolved, handoffs, first response / resolution times, CSAT, visitors converted to leads, sequences stopped by a chat, continuity emails, top unanswered questions, and `products` (answers with product cards, cards shown, clicks, add-to-carts, top recommended / top clicked products, and `not_found`: what visitors asked for that no product matched). `by_source` names how the chat was opened (launcher, popup, campaign, the site's own button / ask / input / link, header_button, element_button, selection).",
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
    input: { ...wsParam, id: z.string().optional(), shortcut: z.string().min(1).max(40).describe("Letters, digits, - and _ (leading / optional)."), content: z.string().min(1).max(5000), personal: z.boolean().optional(), confirmation_token: z.string().optional() },
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
    description: "Change settings of a website inbox. `settings` is merged section by section (appearance, launcher, popup, messages, pre_chat, features, csat, continuity, ai, targeting, security, assignment, locale, selection_ask, shortcut; `ask_buttons` is a list of at most 10 and is replaced whole; `ai.products` holds the product recommendation settings and can only be enabled once a picked catalogue has products); `voice` (the website agent's voice) is read-only here and is changed in the app; top-level fields: name, allowed_domains, is_active, ai_enabled, enforce_identity, reply_mailbox_id, business_hours. Every save is a version and reaches the widget within 5 minutes. The Website agent mode is ai_enabled + settings.ai.mode, which may be off | first (Auto, always) | offline_only (Auto, outside business hours) | review (the AI suggests, a person sends); website_assistant_set_mode is the simple way to switch it. Confirmation-gated; show the user exactly what changes.",
    input: { inbox_id: z.string(), patch: z.record(z.string(), z.unknown()).describe("e.g. {\"settings\":{\"messages\":{\"greeting\":\"Hi!\"}}} or {\"is_active\":false}"), confirmation_token: z.string().optional() },
  }, async (a) => {
    const i = await urpc<Row>(ctx, "webchat_inbox_get", { p_id: a.inbox_id });
    const ws = resolveWs(ctx, i.workspace_id);
    requireRole(ws, "manager");
    // voice is set up in the app (the Voice tab keeps a draft, tests it and publishes the agent): readable here, not writable
    if (a.patch.settings && typeof a.patch.settings === "object" && "voice" in (a.patch.settings as Record<string, unknown>)) {
      return { error: "E_NOT_SUPPORTED", message: `Voice settings are changed in the app: Website agents → ${i.name} → Voice. They can be read with webchat_inbox_get (settings.voice) and the calls with webchat_voice_calls_list.` };
    }
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
    input: { chat_id: z.string(), status: z.enum(["open", "pending", "snoozed", "resolved"]).optional(), snoozed_until: z.string().optional().describe("ISO time (with status snoozed)"), assigned_to: z.string().nullable().optional(), priority: z.enum(["urgent", "high", "medium", "low"]).nullable().optional(), labels: z.array(z.string()).optional(), confirmation_token: z.string().optional() },
  }, async (a) => {
    const { chat_id, confirmation_token: _token, ...patch } = a;   // the token confirms the call; it is not part of the patch
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    if (!Object.keys(clean).length) return { error: "nothing to change" };
    const g = await gate(ctx, "webchat_conversation_update", a as Record<string, unknown>, `Conversation ${chat_id}: ${Object.entries(clean).map(([k, v]) => `${k} → ${JSON.stringify(v)}`).join(", ")}`, null);
    if (!g.proceed) return g.result;
    const r = await urpc<Row>(ctx, "webchat_conversation_update", { p_chat: chat_id, p_patch: clean });
    return { conversation: { id: r.id, status: r.status, assigned_to: r.assigned_to, priority: r.priority, labels: r.labels, snoozed_until: r.snoozed_until } };
  });

  // ---- voice calls with the website agent (migration 069)
  tool(server, ctx, {
    name: "webchat_voice_calls_list", title: "Voice calls with the website agent", cls: "read", minRole: "client_viewer", annotations: { readOnlyHint: true },
    description: "Voice calls visitors had with the website agent (they talk instead of type; the same conversation in the inbox holds the transcript as messages). Each call: when, how long, how it ended (visitor | agent_end_call | switch = the visitor went back to text chat | handoff = a person took over, with handoff_reason | takeover | silence | max_duration | error), the provider's summary and title, whether the question was resolved (successful: success | failure | unknown), the details the visitor gave by voice (collected: visitor_name, visitor_phone, need, budget), the language, has_audio, and chat_id for inbox_thread. `minutes` is this month's voice allowance (used / limit; limit null = the workspace's own voice account, no cap). Test calls from the Voice tab are marked test. Voice settings are read with webchat_inbox_get (settings.voice) and changed in the app only.",
    input: { ...wsParam, inbox_id: z.string().optional().describe("One website; omit for every website."), from: z.string().optional().describe("YYYY-MM-DD (default: 30 days ago)"), to: z.string().optional().describe("YYYY-MM-DD (default: today)"), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional() },
  }, async (a) => {
    const ws = resolveWs(ctx, a.workspace_id);
    const r = await urpc<Row>(ctx, "hub_voice_calls", { p_ws: ws.id, p_inbox: a.inbox_id ?? null, p_from: a.from ?? null, p_to: a.to ?? null, p_limit: a.limit ?? 25, p_offset: a.offset ?? 0 });
    const calls = ((r?.calls ?? []) as Row[]).map((k) => ({ ...k, visitor_name: untrusted("webchat_visitor", k.visitor_name), title: untrusted("voice_call", k.title), summary: untrusted("voice_call", k.summary),
      collected: k.collected && Object.keys(k.collected).length ? { untrusted_content: true, source: "voice_call", value: k.collected } : {} }));
    return { total: r?.total ?? calls.length, calls, minutes: r?.pool ?? null };
  });

  // ---- product catalogues (migration 068): what a website's assistant recommends from, and cards an agent can send
  tool(server, ctx, {
    name: "catalogue_search", title: "Search the product catalogue", cls: "read", minRole: "member", annotations: { readOnlyHint: true },
    description: "Search the workspace's product catalogues (AI → Knowledge → Product catalogue: a Shopify or WooCommerce store, a product feed, a CSV, or products found on a crawled website). Returns up to 20 products with id, title, price, currency, link, picture, in-stock flag, type and whether the product is hidden from the AI. `query` matches title, type, tags, brand, option values and description (an empty query lists the catalogue); `max_price` is read in the catalogue's currency; `catalogue_id` limits the search to one catalogue. Send products into a website chat with webchat_send_products.",
    input: { ...wsParam, query: z.string().max(300).optional(), max_price: z.number().positive().optional(), catalogue_id: z.string().optional().describe("One catalogue (a knowledge source id); omit for every catalogue."), limit: z.number().int().min(1).max(20).optional() },
  }, async (a) => {
    const ws = resolveWs(ctx, a.workspace_id);
    const rows = (await urpc<Row[]>(ctx, "hub_product_search", { p_ws: ws.id, p_query: a.query ?? null, p_max_price: a.max_price ?? null, p_source: a.catalogue_id ?? null, p_inbox: null, p_limit: a.limit ?? 20 })) ?? [];
    return {
      products: rows.map((p) => ({ id: p.id, title: untrusted("product_catalogue", p.title), price: p.price ?? null, compare_at: p.compare_at ?? null, currency: p.currency ?? null, url: p.url, image: p.image ?? null,
        in_stock: p.available !== false, type: p.product_type ?? null, brand: p.vendor ?? null, tags: p.tags ?? [], hidden_from_ai: !!p.ai_hidden, catalogue_id: p.source_id })),
      count: rows.length,
    };
  });

  tool(server, ctx, {
    name: "webchat_send_products", title: "Send product cards into a website chat (confirmation required)", cls: "gated", minRole: "member",
    description: "Send 1 to 6 products as cards (picture, name, price, View button) into a website chat, as the connected member. The cards are built from the catalogue, never from text: pass product ids from catalogue_search. `text` is an optional line above the cards. Only for website chats (chat provider WEBCHAT). Confirmation-gated like every send.",
    input: { chat_id: z.string(), product_ids: z.array(z.string()).min(1).max(6), text: z.string().max(2000).optional(), confirmation_token: z.string().optional() },
  }, async (a) => {
    const g = await gate(ctx, "webchat_send_products", a as Record<string, unknown>, `Send ${a.product_ids.length} product card${a.product_ids.length === 1 ? "" : "s"} into website chat ${a.chat_id}${a.text ? ` with the line "${short(a.text, 100)}"` : ""}`, null);
    if (!g.proceed) return g.result;
    const m = await urpc<Row>(ctx, "hub_webchat_send_products", { p_chat: a.chat_id, p_product_ids: a.product_ids, p_text: a.text ?? null, p_suggestion: null });
    return { sent: { message_id: m.id, chat_id: m.chat_id, products: (m.content_attributes?.products ?? []).map((p: Row) => ({ id: p.id, title: p.title, price: p.price ?? null, currency: p.currency ?? null })) } };
  });
}
