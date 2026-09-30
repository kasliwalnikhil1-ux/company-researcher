'use client';

// Web chat (web-chat-PRD.md): types, query keys, hooks and helpers for Settings → Websites, the inbox (webchat threads,
// visitor panel) and the agent presence ping. Every hook maps to one `outreach_webchat_*` RPC (migration 051).

import { useCallback, useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from './api';
import type { Provider } from './types';

// ---------------------------------------------------------------------------
// Types (mirrors 049 / 050)
// ---------------------------------------------------------------------------
export type WebchatMode = 'bubble' | 'drawer' | 'sidebar' | 'modal' | 'inline' | 'embedded';
export type AiMode = 'off' | 'first' | 'offline_only';

export interface LauncherSettings { type: 'icon' | 'button'; size: 'sm' | 'md' | 'lg'; position: 'left' | 'right'; margin_bottom: number; margin_side: number; text: string }
export interface PreChatField { key: string; label: string; type: 'text' | 'email' | 'phone' | 'number' | 'list' | 'checkbox' | 'date' | 'url' | 'textarea'; visible: boolean; required: boolean; placeholder?: string; options?: string[]; pattern?: string }
export interface UrlRule { op: 'contains' | 'equals' | 'starts_with' | 'regex'; value: string; action: 'show' | 'hide' }

export interface WebchatSettings {
  appearance: { brand_name: string; logo_url: string | null; bot_avatar_url: string | null; welcome_title: string; welcome_tagline: string; accent: string; widget_bg: string; chat_bg: string; font: string; theme: 'light' | 'dark' | 'auto'; mode: WebchatMode; z_index: number; custom_css: string; drawer_side: 'left' | 'right'; panel_width: number; mobile: Record<string, unknown> };
  launcher: { desktop: LauncherSettings; mobile: LauncherSettings; show_unread_count: boolean; show_unread_previews: boolean; hide: boolean; online_dot: boolean };
  popup: { enabled: boolean; text: string; image_url: string | null; delay_s: number; position: 'above' | 'left' };
  messages: { greeting_enabled: boolean; greeting: string; reply_time: 'minutes' | 'hours' | 'day' | 'none'; available_message: string; unavailable_message: string; email_capture_prompt: string; end_message: string; placeholder: string; quick_replies: string[]; handoff_message: string; handoff_offline_message: string };
  pre_chat: { enabled: boolean; message: string; when: 'before_first' | 'offline_only'; fields: PreChatField[]; consent: { enabled: boolean; label: string; link: string | null; text_version: string } };
  features: { file_picker: boolean; emoji_picker: boolean; restart: boolean; end_conversation: boolean; allow_after_resolved: boolean; single_conversation: boolean; sounds: boolean; read_receipts: boolean; show_agent_names: boolean; transcript: boolean; email_capture: boolean; powered_by: boolean; show_offline_status: boolean; hide_outside_hours: boolean; markdown: boolean };
  csat: { enabled: boolean; scale: 'emoji' | 'thumbs'; ask_comment: boolean; by_email: boolean };
  continuity: { enabled: boolean; inactivity_min: number; digest_window_min: number; include_transcript_on_resolve: boolean };
  ai: { mode: AiMode; knowledge_source_ids: string[]; persona: string; allowed_topics: string; handoff: { keywords: string[]; max_turns: number; low_confidence_streak: number; leads_in_sequence: boolean }; show_sources: boolean; hourly_cap_per_visitor: number };
  targeting: { url_rules: UrlRule[]; hide_mobile: boolean; hide_desktop: boolean; identified_only: boolean; countries_include: string[]; countries_exclude: string[] };
  security: { rate_limits: { visitor_10s: number; visitor_1h: number; ip_1m: number; ip_1h: number; inbox_1m: number }; turnstile_enabled: boolean; turnstile_site_key: string | null; consent_mode: boolean; allow_localhost: boolean; attachments: { max_mb: number; allow_zip: boolean }; profanity_filter: boolean };
  assignment: { auto: boolean; capacity: number; unassign_offline_min: number };
  locale: { default: string; use_browser: boolean; strings: Record<string, Record<string, string>> };
}

export interface BusinessHours { tz?: string; weekly?: Record<string, Array<[string, string]>>; holidays?: string[] }

export interface WebchatInbox {
  id: string; workspace_id: string; client_id: string | null; sender_id: string; name: string; website_token: string; hmac_token: string | null;
  enforce_identity: boolean; allowed_domains: string[]; settings: WebchatSettings; config_version: number; ai_enabled: boolean; reply_mailbox_id: string | null;
  business_hours: BusinessHours; is_active: boolean; installed_origins: Record<string, string>; created_at: string; updated_at: string;
  members: Array<{ user_id: string; auto_assign: boolean; name: string; online: boolean }>;
  availability: { online: boolean; in_hours: boolean; next_open_at: string | null; timezone: string; agents: Array<{ name: string }>; reply_time: string; ai_mode: AiMode };
  stats: { open: number; unassigned: number; today: number; visitors_30d: number };
  reply_mailbox: { id: string; name: string | null; email: string | null; provider: Provider; status: string } | null;
}

export interface WebchatVisitor {
  id: string; workspace_id: string; inbox_id: string; identifier: string | null; identity_verified: boolean; name: string | null; email: string | null; email_verified: boolean; email_invalid: boolean;
  phone: string | null; avatar_url: string | null; company: string | null; lead_id: string | null; custom_attributes: Record<string, unknown>; consent: Record<string, unknown> | null;
  country: string | null; city: string | null; timezone: string | null; browser: string | null; os: string | null; device: string | null; locale: string | null; referrer: string | null; landing_url: string | null; utm: Record<string, string> | null;
  current_url: string | null; current_title: string | null; current_at: string | null; first_seen_at: string; last_seen_at: string | null; blocked_at: string | null; blocked: boolean;
  inbox: { id: string; name: string };
  pages: Array<{ url: string; title: string | null; at: string }>;
  events: Array<{ name: string; props: Record<string, unknown>; at: string; chat_id: string | null }>;
  conversations: Array<{ id: string; status: string; created_at: string; last_message_at: string | null; preview: string | null; csat: { rating: number; comment?: string } | null }>;
  conversation_count: number;
  lead: { id: string; full_name: string | null; company: string | null; title: string | null; email_work: string | null; last_replied_at: string | null; last_replied_channel: string | null; picture_url: string | null;
          enrollments: Array<{ id: string; status: string; sequence: string; sender: string | null; provider: Provider }>; relations: Array<{ sender: string | null; provider: Provider; relation: string; last_inbound_at: string | null; last_outbound_at: string | null }> } | null;
  lead_candidates: Array<{ id: string; full_name: string | null; company: string | null; email_work: string | null }>;
}

export interface CannedResponse { id: string; workspace_id: string; owner_id: string | null; short_code: string; content: string; created_at: string }
export interface WebchatCampaign { id: string; inbox_id: string; title: string; message: string; sender_kind: 'bot' | 'agent'; sender_user_id: string | null; quick_replies: string[]; rules: { url_rules?: UrlRule[]; time_on_page_s?: number; visitor?: 'all' | 'new' | 'returning' | 'identified'; business_hours_only?: boolean }; frequency: 'once' | 'session' | 'every'; display: 'popup' | 'open'; enabled: boolean; shown: number; clicked: number; started: number }
export interface WebchatReport { period: { from: string; to: string }; conversations: number; by_source: Record<string, number>; resolved: number; ai_resolved: number; handoffs: number; ai_turns: number; ai_feedback: { up: number; down: number }; first_response_median_s: number | null; first_response_p90_s: number | null; resolution_median_s: number | null; csat: { responses: number; avg: number | null }; csat_by_agent: Array<{ user_id: string; name: string; avg: number; n: number }>; visitor_to_lead: number; sequences_stopped: number; continuity: { sent: number; failed: number }; top_unanswered: Array<{ query: string; n: number }>; by_day: Array<{ day: string; n: number }> }
export interface AiTurn { id: string; query: string; answer: string | null; confidence: string | null; handoff: string | null; feedback: number | null; feedback_text: string | null; sources: Array<{ url: string | null; title: string }>; latency_ms: number | null; created_at: string; chat_id: string | null }

export const CHAT_STATUS_LABELS: Record<string, string> = { open: 'Open', pending: 'Pending', snoozed: 'Snoozed', resolved: 'Resolved' };
export const PRIORITY_LABELS: Record<string, string> = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' };

// ---------------------------------------------------------------------------
// Query keys + hooks
// ---------------------------------------------------------------------------
export const wk = {
  inboxes: (ws: string) => ['outreach', ws, 'webchat', 'inboxes'] as const,
  inbox: (id: string) => ['outreach', 'webchat', 'inbox', id] as const,
  visitor: (id: string) => ['outreach', 'webchat', 'visitor', id] as const,
  canned: (ws: string) => ['outreach', ws, 'webchat', 'canned'] as const,
  mailboxes: (ws: string) => ['outreach', ws, 'webchat', 'mailboxes'] as const,
  report: (ws: string, inbox: string | null, from: string, to: string) => ['outreach', ws, 'webchat', 'report', inbox, from, to] as const,
  turns: (inbox: string) => ['outreach', 'webchat', 'inbox', inbox, 'turns'] as const,
  history: (inbox: string) => ['outreach', 'webchat', 'inbox', inbox, 'history'] as const,
  campaigns: (inbox: string) => ['outreach', 'webchat', 'inbox', inbox, 'campaigns'] as const,
  defaults: () => ['outreach', 'webchat', 'defaults'] as const,
};

export function useWebchatInboxes(ws: string | null | undefined) {
  return useQuery({ queryKey: wk.inboxes(ws ?? ''), enabled: !!ws, refetchInterval: 60_000, queryFn: () => rpc<WebchatInbox[]>('webchat_inboxes', { p_ws: ws }) });
}
export function useWebchatInbox(id: string | null | undefined) {
  return useQuery({ queryKey: wk.inbox(id ?? ''), enabled: !!id, queryFn: () => rpc<WebchatInbox>('webchat_inbox_get', { p_id: id }) });
}
export function useWebchatDefaults() {
  return useQuery({ queryKey: wk.defaults(), staleTime: Infinity, queryFn: () => rpc<WebchatSettings>('webchat_default_settings') });
}
export function useWebchatVisitor(id: string | null | undefined) {
  return useQuery({ queryKey: wk.visitor(id ?? ''), enabled: !!id, refetchInterval: 30_000, queryFn: () => rpc<WebchatVisitor>('webchat_visitor', { p_id: id }) });
}
export function useCannedResponses(ws: string | null | undefined) {
  return useQuery({ queryKey: wk.canned(ws ?? ''), enabled: !!ws, queryFn: () => rpc<CannedResponse[]>('webchat_canned_list', { p_ws: ws }) });
}
export function useWebchatMailboxes(ws: string | null | undefined) {
  return useQuery({ queryKey: wk.mailboxes(ws ?? ''), enabled: !!ws, queryFn: () => rpc<Array<{ id: string; name: string | null; email: string | null; provider: Provider; status: string; client_id: string | null }>>('webchat_mailboxes', { p_ws: ws }) });
}
export function useWebchatReport(ws: string | null | undefined, inbox: string | null, from: string, to: string) {
  return useQuery({ queryKey: wk.report(ws ?? '', inbox, from, to), enabled: !!ws, queryFn: () => rpc<WebchatReport>('webchat_report', { p_ws: ws, p_inbox: inbox, p_from: from, p_to: to }) });
}
export function useAiTurns(inbox: string | null | undefined, limit = 100) {
  return useQuery({ queryKey: wk.turns(inbox ?? ''), enabled: !!inbox, queryFn: () => rpc<AiTurn[]>('webchat_ai_turns_list', { p_inbox: inbox, p_limit: limit }) });
}
export function useSettingsHistory(inbox: string | null | undefined) {
  return useQuery({ queryKey: wk.history(inbox ?? ''), enabled: !!inbox, queryFn: () => rpc<Array<{ version: number; at: string; by: string | null; diff: Record<string, unknown> }>>('webchat_settings_history', { p_inbox: inbox }) });
}

/** Invalidates everything about one inbox (and the workspace list). */
export function useInvalidateInbox(ws: string | null | undefined) {
  const qc = useQueryClient();
  return useCallback((id?: string) => {
    if (ws) qc.invalidateQueries({ queryKey: wk.inboxes(ws) });
    if (id) { qc.invalidateQueries({ queryKey: wk.inbox(id) }); qc.invalidateQueries({ queryKey: wk.history(id) }); }
  }, [qc, ws]);
}

export type InboxPatch = Partial<{ name: string; allowed_domains: string[]; client_id: string | null; is_active: boolean; ai_enabled: boolean; reply_mailbox_id: string | null; enforce_identity: boolean; business_hours: BusinessHours; settings: DeepPartial<WebchatSettings> }>;
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends Array<unknown> ? T[K] : DeepPartial<T[K]>) : T[K] };

export function useUpdateInbox(ws: string | null | undefined) {
  const inv = useInvalidateInbox(ws);
  return useMutation({ mutationFn: (v: { id: string; patch: InboxPatch }) => rpc<WebchatInbox>('webchat_inbox_update', { p_id: v.id, p_patch: v.patch }), onSuccess: (_r, v) => inv(v.id) });
}
export function useCreateInbox(ws: string | null | undefined) {
  const inv = useInvalidateInbox(ws);
  return useMutation({ mutationFn: (v: { name: string; domains: string[]; client_id: string | null }) => rpc<WebchatInbox>('webchat_inbox_create', { p_ws: ws, p_name: v.name, p_domains: v.domains, p_client: v.client_id }), onSuccess: () => inv() });
}
export function useDeleteInbox(ws: string | null | undefined) {
  const inv = useInvalidateInbox(ws);
  return useMutation({ mutationFn: (id: string) => rpc<void>('webchat_inbox_delete', { p_id: id }), onSuccess: () => inv() });
}
export function useSetInboxMembers(ws: string | null | undefined) {
  const inv = useInvalidateInbox(ws);
  return useMutation({ mutationFn: (v: { id: string; members: Array<{ user_id: string; auto_assign: boolean }> }) => rpc<WebchatInbox>('webchat_inbox_set_members', { p_id: v.id, p_members: v.members }), onSuccess: (_r, v) => inv(v.id) });
}
export function useRegenerateHmac(ws: string | null | undefined) {
  const inv = useInvalidateInbox(ws);
  return useMutation({ mutationFn: (id: string) => rpc<WebchatInbox>('webchat_inbox_regenerate_hmac', { p_id: id }), onSuccess: (_r, id) => inv(id) });
}
export function useRestoreSettings(ws: string | null | undefined) {
  const inv = useInvalidateInbox(ws);
  return useMutation({ mutationFn: (v: { id: string; version: number }) => rpc<WebchatInbox>('webchat_settings_restore', { p_inbox: v.id, p_version: v.version }), onSuccess: (_r, v) => inv(v.id) });
}
export function useSaveCanned(ws: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { id: string | null; short_code: string; content: string; personal: boolean }) => rpc<CannedResponse>('webchat_canned_save', { p_ws: ws, p_id: v.id, p_short_code: v.short_code, p_content: v.content, p_personal: v.personal }), onSuccess: () => { if (ws) qc.invalidateQueries({ queryKey: wk.canned(ws) }); } });
}
export function useDeleteCanned(ws: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => rpc<void>('webchat_canned_delete', { p_id: id }), onSuccess: () => { if (ws) qc.invalidateQueries({ queryKey: wk.canned(ws) }); } });
}
export function useCampaigns(inbox: string | null | undefined) {
  return useQuery({ queryKey: wk.campaigns(inbox ?? ''), enabled: !!inbox, queryFn: async () => { const { supabase } = await import('@/utils/supabase/client'); const { data, error } = await supabase.from('outreach_webchat_campaigns').select('*').eq('inbox_id', inbox!).order('created_at'); if (error) throw error; return (data ?? []) as WebchatCampaign[]; } });
}
export function useSaveCampaign(inbox: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { id: string | null; row: Partial<WebchatCampaign> }) => rpc<WebchatCampaign>('webchat_campaign_save', { p_inbox: inbox, p_id: v.id, p_row: v.row }), onSuccess: () => { if (inbox) qc.invalidateQueries({ queryKey: wk.campaigns(inbox) }); } });
}
export function useDeleteCampaign(inbox: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => rpc<void>('webchat_campaign_delete', { p_id: id }), onSuccess: () => { if (inbox) qc.invalidateQueries({ queryKey: wk.campaigns(inbox) }); } });
}

// conversation actions from the thread (status / snooze / assign / priority / labels)
export function useConversationUpdate() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { chat: string; patch: Record<string, unknown> }) => rpc<Record<string, unknown>>('webchat_conversation_update', { p_chat: v.chat, p_patch: v.patch }), onSuccess: (_r, v) => { qc.invalidateQueries({ queryKey: ['outreach', 'chat', v.chat] }); qc.invalidateQueries({ queryKey: ['outreach'], predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[2] === 'chats' }); } });
}
export function useVisitorLinkLead() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { visitor: string; lead: string | null }) => rpc<WebchatVisitor>('webchat_visitor_link_lead', { p_id: v.visitor, p_lead: v.lead }), onSuccess: (_r, v) => { qc.invalidateQueries({ queryKey: wk.visitor(v.visitor) }); qc.invalidateQueries({ queryKey: ['outreach', 'chat'] }); } });
}
export function useVisitorUpdate() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { visitor: string; patch: Record<string, unknown> }) => rpc<WebchatVisitor>('webchat_visitor_update', { p_id: v.visitor, p_patch: v.patch }), onSuccess: (_r, v) => qc.invalidateQueries({ queryKey: wk.visitor(v.visitor) }) });
}
export function useVisitorBlock() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { inbox: string; visitor: string; block: boolean; note?: string }) => (v.block ? rpc<void>('webchat_block', { p_inbox: v.inbox, p_kind: 'visitor', p_value: v.visitor, p_note: v.note ?? null }) : rpc<void>('webchat_unblock', { p_inbox: v.inbox, p_kind: 'visitor', p_value: v.visitor })), onSuccess: (_r, v) => qc.invalidateQueries({ queryKey: wk.visitor(v.visitor) }) });
}

/** Agent presence (PRD §5.7): a ping every 60 s while an outreach tab is open; offline when the last tab closes. */
export function useWebchatPresence(ws: string | null | undefined, enabled = true) {
  const state = useRef<'online' | 'busy'>('online');
  useEffect(() => {
    if (!ws || !enabled) return;
    let stop = false;
    const ping = () => { if (stop || document.hidden && Date.now() - lastActive.current > 10 * 60_000) return; rpc('webchat_presence', { p_ws: ws, p_state: state.current }).catch(() => {}); };
    const lastActive = { current: Date.now() };
    const activity = () => { lastActive.current = Date.now(); };
    ['mousemove', 'keydown', 'click', 'touchstart'].forEach((e) => window.addEventListener(e, activity, { passive: true }));
    ping();
    const t = setInterval(ping, 60_000);
    const off = () => { try { navigator.sendBeacon?.('/api/noop', ''); } catch { /* ignore */ } };
    window.addEventListener('pagehide', off);
    return () => { stop = true; clearInterval(t); window.removeEventListener('pagehide', off); ['mousemove', 'keydown', 'click', 'touchstart'].forEach((e) => window.removeEventListener(e, activity)); };
  }, [ws, enabled]);
}

/** Agent typing indicator for a webchat thread: throttled to one call per 2 s, "off" after 4 s idle. */
export function useAgentTyping(chatId: string | null, isWebchat: boolean) {
  const last = useRef(0);
  const offTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return useCallback((text: string) => {
    if (!isWebchat || !chatId) return;
    const now = Date.now();
    if (text && now - last.current > 2000) { last.current = now; rpc('webchat_agent_typing', { p_chat: chatId, p_on: true }).catch(() => {}); }
    if (offTimer.current) clearTimeout(offTimer.current);
    offTimer.current = setTimeout(() => { rpc('webchat_agent_typing', { p_chat: chatId, p_on: false }).catch(() => {}); }, 4000);
  }, [chatId, isWebchat]);
}

// ---------------------------------------------------------------------------
// Install snippet + guides (PRD §4.1)
// ---------------------------------------------------------------------------
export const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
export const WEBCHAT_API = `${SUPABASE_URL}/functions/v1/outreach-webchat`;
export function widgetOrigin(): string { return typeof window === 'undefined' ? (process.env.NEXT_PUBLIC_APP_URL || '') : window.location.origin; }
export function loaderUrl(): string { return `${widgetOrigin()}/widget/v1/loader.js`; }
export function standaloneUrl(token: string): string { return `${widgetOrigin()}/chat/${token}`; }

export function snippetHtml(token: string, opts: { position?: 'left' | 'right'; locale?: string } = {}): string {
  const settings = JSON.stringify({ position: opts.position ?? 'right', ...(opts.locale ? { locale: opts.locale } : {}) });
  return `<script>
  window.growthxaiSettings = ${settings};
  (function(d,t){var g=d.createElement(t),s=d.getElementsByTagName(t)[0];
   g.src="${loaderUrl()}"; g.async=true;
   g.dataset.websiteToken="${token}"; g.dataset.api="${WEBCHAT_API}";
   s.parentNode.insertBefore(g,s);})(document,"script");
</script>`;
}

export const INSTALL_GUIDES: Array<{ key: string; label: string; body: (token: string) => string }> = [
  { key: 'html', label: 'Plain HTML', body: (t) => `Paste this before </body> on every page:\n\n${snippetHtml(t)}` },
  { key: 'gtm', label: 'Google Tag Manager', body: (t) => `Tags → New → Custom HTML. Paste the snippet, trigger: All Pages.\n\n${snippetHtml(t)}` },
  { key: 'wordpress', label: 'WordPress', body: (t) => `Appearance → Theme File Editor → footer.php, before </body> (or use a "Insert Headers and Footers" plugin):\n\n${snippetHtml(t)}` },
  { key: 'shopify', label: 'Shopify', body: (t) => `Online Store → Themes → Edit code → layout/theme.liquid, before </body>:\n\n${snippetHtml(t)}` },
  { key: 'webflow', label: 'Webflow', body: (t) => `Project settings → Custom code → Footer code:\n\n${snippetHtml(t)}` },
  { key: 'wix', label: 'Wix', body: (t) => `Settings → Custom code → Add code → Body end, all pages:\n\n${snippetHtml(t)}` },
  { key: 'framer', label: 'Framer', body: (t) => `Site settings → General → Custom code → End of <body> tag:\n\n${snippetHtml(t)}` },
  { key: 'nextjs', label: 'Next.js', body: (t) => `In app/layout.tsx:\n\nimport Script from 'next/script';\n// inside <body>\n<Script id="growthxai-chat" strategy="afterInteractive">{\`\n  window.growthxaiSettings = { position: "right" };\n  (function(d,t){var g=d.createElement(t),s=d.getElementsByTagName(t)[0];g.src="${loaderUrl()}";g.async=true;g.dataset.websiteToken="${t}";g.dataset.api="${WEBCHAT_API}";s.parentNode.insertBefore(g,s);})(document,"script");\n\`}</Script>` },
  { key: 'astro', label: 'Astro', body: (t) => `In your layout, before </body>:\n\n<script is:inline>\n  window.growthxaiSettings = { position: "right" };\n  (function(d,t){var g=d.createElement(t),s=d.getElementsByTagName(t)[0];g.src="${loaderUrl()}";g.async=true;g.dataset.websiteToken="${t}";g.dataset.api="${WEBCHAT_API}";s.parentNode.insertBefore(g,s);})(document,"script");\n</script>` },
  { key: 'react', label: 'React SPA', body: (t) => `useEffect(() => {\n  const g = document.createElement('script');\n  g.src = '${loaderUrl()}'; g.async = true;\n  g.dataset.websiteToken = '${t}'; g.dataset.api = '${WEBCHAT_API}';\n  document.body.appendChild(g);\n  return () => { window.growthxai?.destroy?.(); g.remove(); };\n}, []);\n\n// Route changes are picked up automatically (history.pushState hooks).` },
];

export const HMAC_SAMPLES: Array<{ label: string; code: (secret: string) => string }> = [
  { label: 'Node.js', code: (s) => `const crypto = require('crypto');\nconst hash = crypto.createHmac('sha256', '${s}').update(String(userId)).digest('hex');\n// in the page:\nwindow.growthxai.setUser(String(userId), { email, name, identifier_hash: hash });` },
  { label: 'Python', code: (s) => `import hmac, hashlib\nhash = hmac.new(b'${s}', str(user_id).encode(), hashlib.sha256).hexdigest()` },
  { label: 'PHP', code: (s) => `$hash = hash_hmac('sha256', (string)$userId, '${s}');` },
  { label: 'Ruby', code: (s) => `hash = OpenSSL::HMAC.hexdigest('sha256', '${s}', user_id.to_s)` },
  { label: 'Go', code: (s) => `mac := hmac.New(sha256.New, []byte("${s}"))\nmac.Write([]byte(userID))\nhash := hex.EncodeToString(mac.Sum(nil))` },
];

export const CSP_NOTES = (apiHost: string, appOrigin: string, turnstile = false) => [
  `script-src ${appOrigin}${turnstile ? ' https://challenges.cloudflare.com' : ''}`,
  `connect-src ${apiHost} ${apiHost.replace(/^http/, 'ws')}`,
  `img-src ${apiHost} data:`,
  turnstile ? `frame-src https://challenges.cloudflare.com  (Turnstile runs its check in an iframe)` : `frame-src: none needed (the widget uses Shadow DOM, not an iframe)`,
  `style-src: no change needed (styles are constructed stylesheets inside the Shadow root)`,
];

export function fmtSeconds(s: number | null | undefined): string {
  if (s == null) return '—';
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}
