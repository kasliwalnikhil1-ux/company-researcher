'use client';

// Web chat (web-chat-PRD.md): types, query keys, hooks and helpers for Website agents (/outreach/websites), the inbox (webchat threads,
// visitor panel) and the agent presence ping. Every hook maps to one `outreach_webchat_*` RPC (migration 051).

import { useCallback, useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from './api';
import { db } from './backend';
import { IS_DEMO } from './mode';
import type { Provider } from './types';

// ---------------------------------------------------------------------------
// Types (mirrors 049 / 050)
// ---------------------------------------------------------------------------
export type WebchatMode = 'bubble' | 'drawer' | 'sidebar' | 'modal' | 'inline' | 'embedded';
/** Stored assistant mode. The app shows Off / Review / Auto (lib/outreach/aiHub.ts websiteHubMode): 'first' = Auto, always; 'offline_only' = Auto, outside business hours. */
export type AiMode = 'off' | 'first' | 'offline_only' | 'review';

export interface LauncherSettings { type: 'icon' | 'button'; size: 'sm' | 'md' | 'lg'; position: 'left' | 'right'; margin_bottom: number; margin_side: number; text: string }
export interface PreChatField { key: string; label: string; type: 'text' | 'email' | 'phone' | 'number' | 'list' | 'checkbox' | 'date' | 'url' | 'textarea'; visible: boolean; required: boolean; placeholder?: string; options?: string[]; pattern?: string }
export interface UrlRule { op: 'contains' | 'equals' | 'starts_with' | 'regex'; value: string; action: 'show' | 'hide' }
/**
 * A suggested question on the video bubble. With its own clip (migration 062) the clip plays in the expanded view when the
 * question is clicked; with a page link, the page opens in a new tab. Stored as a plain text when it has neither.
 */
export interface VideoQuestion { text: string; text_variants?: VideoText[]; video_url?: string | null; video_kind?: 'video' | 'image'; video_variants?: VideoClip[]; link_url?: string | null; link_text?: string | null }
/** A question's wording in one language (migration 072). `text` mirrors the default (first) language's wording. */
export interface VideoText { lang: string; text: string }
/** A language the video bubble's clips come in (migration 065). `flag` names a file in public/widget/v1/flags (<flag>.svg). */
export interface VideoLanguage { code: string; label: string; flag: string }
/** One clip in one language: the main clip (`launcher.video.variants`) or a question's answer clip (`video_variants`). */
export interface VideoClip { lang: string; url: string; kind: 'video' | 'image' }
/** launcher.video (migration 053): a GIF / video bubble instead of the launcher icon; a click expands it with suggested questions. */
export interface VideoBubbleSettings {
  enabled: boolean; url: string | null; kind: 'video' | 'image'; shape: 'circle' | 'rounded' | 'square'; size: number; ratio: string; fit: 'cover' | 'contain';
  focus_x: number; focus_y: number; zoom: number; border_color: string; border_width: number; expanded_width: number; expanded_ratio: string; sound: boolean;
  /** With languages, `variants` holds the main clip per language and `url` / `kind` mirror the default (first) language's clip. */
  languages?: VideoLanguage[]; variants?: VideoClip[];
  questions: Array<string | VideoQuestion>; questions_position: 'over' | 'below'; cta_text: string; question_bg: string; question_color: string; cta_bg: string | null; cta_color: string;
}

// ---- your own buttons, Ask AI buttons, product recommendations (web-chat-buttons-products-changes.md; migration 068)
export type ButtonShell = Exclude<WebchatMode, 'embedded'>;
/** An Ask AI button the widget places on the site: in the header, or next to every element a selector finds. */
export interface AskButton {
  id: string; kind: 'header' | 'element'; selector: string;
  /** header: start | end of the element · element: before | after | inside (at the end). */
  position: 'start' | 'end' | 'before' | 'after' | 'inside';
  label: string; style: 'filled' | 'outline' | 'text' | 'match'; icon: boolean;
  /** open the chat · ask `text` as the visitor · put `text` in the message box. A header button opens. */
  click: 'open' | 'ask' | 'prefill'; text?: string | null;
  context?: 'none' | 'page' | 'product';
  /** The shell it opens in; null = the website's own. On a phone the chat is always full screen. */
  mode?: ButtonShell | null;
  url_rules: UrlRule[]; enabled: boolean;
}
export interface SelectionAsk { enabled: boolean; area: string; label: string }
export interface ProductsSettings { enabled: boolean; catalogue_ids: string[]; max: number; show_prices: boolean; include_oos: boolean; add_to_cart: boolean; utm: boolean }
export const PRODUCTS_DEFAULTS: ProductsSettings = { enabled: false, catalogue_ids: [], max: 3, show_prices: true, include_oos: false, add_to_cart: false, utm: true };
export const SELECTION_ASK_DEFAULTS: SelectionAsk = { enabled: false, area: 'main, article', label: 'Ask AI' };
export const MAX_ASK_BUTTONS = 10;
export const HEADER_SELECTOR = 'header nav, header';
export const BUTTON_SHELLS: Array<{ value: ButtonShell; label: string }> = [
  { value: 'sidebar', label: 'Sidebar (docked, the page stays visible)' }, { value: 'bubble', label: 'Bubble (popup panel)' }, { value: 'drawer', label: 'Drawer (slides in)' },
  { value: 'modal', label: 'Modal (centred)' }, { value: 'inline', label: 'Inline (bottom pill)' },
];
/** A new button with the defaults of its kind: a header button opens in the sidebar, an element button in the website's own shell. */
export function newAskButton(kind: AskButton['kind'], taken: string[]): AskButton {
  let id = '';
  do { id = `${kind === 'header' ? 'hdr' : 'el'}-${Math.random().toString(36).slice(2, 8)}`; } while (taken.includes(id));
  return kind === 'header'
    ? { id, kind, selector: HEADER_SELECTOR, position: 'end', label: 'Ask AI', style: 'filled', icon: true, click: 'open', mode: 'sidebar', url_rules: [], enabled: true }
    : { id, kind, selector: '', position: 'after', label: 'Ask AI', style: 'filled', icon: true, click: 'open', text: '', context: 'none', mode: null, url_rules: [], enabled: true };
}
/** Whether ⌘K / Ctrl+K toggles the chat: the stored switch, or (never touched) on for the modal shell only. */
export const shortcutOn = (s: Pick<WebchatSettings, 'appearance' | 'shortcut'>) => s.shortcut?.enabled ?? s.appearance.mode === 'modal';

export interface WebchatSettings {
  appearance: { brand_name: string; logo_url: string | null; bot_avatar_url: string | null; welcome_title: string; welcome_tagline: string; accent: string; widget_bg: string; chat_bg: string; font: string; theme: 'light' | 'dark' | 'auto'; mode: WebchatMode; z_index: number; custom_css: string; drawer_side: 'left' | 'right'; panel_width: number; mobile: Record<string, unknown> };
  launcher: { desktop: LauncherSettings; mobile: LauncherSettings; show_unread_count: boolean; show_unread_previews: boolean;
    /** true = "My own buttons": no launcher, video bubble, popup or unread previews; the chat opens only from the site's buttons and links. */
    hide: boolean;
    /** With "My own buttons": may a proactive campaign open the chat (default no). */
    campaigns_open?: boolean;
    online_dot: boolean; video?: VideoBubbleSettings };
  popup: { enabled: boolean; text: string; image_url: string | null; delay_s: number; position: 'above' | 'left' };
  messages: { greeting_enabled: boolean; greeting: string; reply_time: 'minutes' | 'hours' | 'day' | 'none'; available_message: string; unavailable_message: string; email_capture_prompt: string; end_message: string; placeholder: string; privacy_url?: string | null; quick_replies: string[]; handoff_message: string; handoff_offline_message: string };
  pre_chat: { enabled: boolean; message: string; when: 'before_first' | 'offline_only'; fields: PreChatField[]; consent: { enabled: boolean; label: string; link: string | null; text_version: string } };
  features: { file_picker: boolean; emoji_picker: boolean; restart: boolean; end_conversation: boolean; allow_after_resolved: boolean; single_conversation: boolean; sounds: boolean; read_receipts: boolean; show_agent_names: boolean; transcript: boolean; email_capture: boolean; powered_by: boolean; show_offline_status: boolean; hide_outside_hours: boolean; markdown: boolean };
  csat: { enabled: boolean; scale: 'emoji' | 'thumbs'; ask_comment: boolean; by_email: boolean };
  continuity: { enabled: boolean; inactivity_min: number; digest_window_min: number; include_transcript_on_resolve: boolean };
  ai: { mode: AiMode; knowledge_source_ids: string[]; persona: string; allowed_topics: string; handoff: { keywords: string[]; max_turns: number; low_confidence_streak: number; leads_in_sequence: boolean }; show_sources: boolean; hourly_cap_per_visitor: number; review_timeout_min?: number; products?: ProductsSettings };
  targeting: { url_rules: UrlRule[]; hide_mobile: boolean; hide_desktop: boolean; identified_only: boolean; countries_include: string[]; countries_exclude: string[] };
  security: { rate_limits: { visitor_10s: number; visitor_1h: number; ip_1m: number; ip_1h: number; inbox_1m: number }; turnstile_enabled: boolean; turnstile_site_key: string | null; consent_mode: boolean; allow_localhost: boolean; attachments: { max_mb: number; allow_zip: boolean }; profanity_filter: boolean };
  assignment: { auto: boolean; capacity: number; unassign_offline_min: number };
  locale: { default: string; use_browser: boolean; strings: Record<string, Record<string, string>> };
  ask_buttons?: AskButton[];
  selection_ask?: SelectionAsk;
  /** Voice for the assistant (069): lib/outreach/voice.ts */
  voice?: Partial<import('./voice').VoiceSettings>;
  /** null = follow the shell (on for the modal shell only). */
  shortcut?: { enabled: boolean | null };
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
export interface WebchatReport { voice?: import('./voice').VoiceReport; period: { from: string; to: string }; conversations: number; by_source: Record<string, number>; resolved: number; ai_resolved: number; handoffs: number; ai_turns: number; ai_feedback: { up: number; down: number }; first_response_median_s: number | null; first_response_p90_s: number | null; resolution_median_s: number | null; csat: { responses: number; avg: number | null }; csat_by_agent: Array<{ user_id: string; name: string; avg: number; n: number }>; visitor_to_lead: number; sequences_stopped: number; continuity: { sent: number; failed: number }; top_unanswered: Array<{ query: string; n: number }>; by_day: Array<{ day: string; n: number }>; products?: ProductsReport }
export interface ProductsReportRow { id: string; n: number; title: string; url: string; image: string | null; removed: boolean }
/** The report's Products block (migration 068). */
export interface ProductsReport {
  answers: number; answers_with_products: number; cards_shown: number; clicks: number; add_to_carts: number;
  top_recommended: ProductsReportRow[]; top_clicked: ProductsReportRow[]; not_found: Array<{ query: string; chat_id: string | null; at: string }>;
}
/** How a conversation started (outreach_chats.source), in the report's words. */
export const SOURCE_LABELS: Record<string, string> = {
  launcher: 'Launcher', popup: 'Popup', campaign: 'Campaign', sdk: 'From code', standalone: 'Standalone page', email: 'Email',
  button: 'Own button', ask: 'Ask button', input: 'Ask box', link: 'Link', header_button: 'Header Ask AI', element_button: 'Ask AI next to an element', selection: 'Ask AI on selected text', voice: 'Voice call',
};
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
  return useQuery({ queryKey: wk.campaigns(inbox ?? ''), enabled: !!inbox, queryFn: async () => { const { data, error } = await db.from('outreach_webchat_campaigns').select('*').eq('inbox_id', inbox!).order('created_at'); if (error) throw error; return (data ?? []) as WebchatCampaign[]; } });
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
    const off = () => { if (IS_DEMO) return; try { navigator.sendBeacon?.('/api/noop', ''); } catch { /* ignore */ } };
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

// ---------------------------------------------------------------------------
// Launcher clip (launcher.video, migration 053)
// ---------------------------------------------------------------------------
export const VIDEO_BUBBLE_DEFAULTS: VideoBubbleSettings = {
  enabled: true, url: null, kind: 'video', shape: 'circle', size: 120, ratio: '1:1', fit: 'cover', focus_x: 50, focus_y: 50, zoom: 100, border_color: '#ffffff', border_width: 3,
  expanded_width: 420, expanded_ratio: 'auto', sound: true, questions: [], questions_position: 'over', cta_text: 'Text', question_bg: '#111827', question_color: '#ffffff', cta_bg: null, cta_color: '#ffffff',
  languages: [], variants: [],
};
/** The stored question list (texts and / or objects) as objects, for editing and for the preview. */
export function videoQuestions(list: Array<string | VideoQuestion> | null | undefined): VideoQuestion[] {
  return (Array.isArray(list) ? list : []).map((q) => (typeof q === 'string' ? { text: q } : { ...q, text: String(q?.text ?? '') }));
}
/**
 * What gets saved: empty questions dropped, a question with no clip and no link as a plain text (the shape older widgets
 * read). With languages, the answer clips are the per-language list and `video_url` mirrors the default language's clip.
 */
export function packVideoQuestions(list: VideoQuestion[], max = 6, languages: VideoLanguage[] = []): Array<string | VideoQuestion> {
  return list.map((q) => {
    const texts = orderVideoTexts(q, languages), text = (texts[0]?.lang === languages[0]?.code ? texts[0]?.text : null) ?? q.text.trim();
    const link_url = q.link_url?.trim() || null, link_text = q.link_text?.trim() || null;
    const variants = orderVideoClips(q.video_variants, languages), first = variants[0];
    const video_url = languages.length ? first?.url ?? null : q.video_url?.trim() || null, video_kind = languages.length ? first?.kind : q.video_kind;
    // the wording per language is kept only when some language other than the default has its own
    const text_variants = texts.some((t) => t.lang !== languages[0]?.code) ? texts : [];
    if (!video_url && !link_url && !text_variants.length) return text;
    return { text, ...(text_variants.length ? { text_variants } : {}), ...(video_url ? { video_url, video_kind: video_kind ?? mediaKind(video_url) } : {}), ...(variants.length ? { video_variants: variants } : {}), ...(link_url ? { link_url, ...(link_text ? { link_text } : {}) } : {}) };
  }).filter((q) => (typeof q === 'string' ? q : q.text)).slice(0, max);
}

// Languages of the video bubble (migration 065): the same clips in several languages, switched with a strip of flags.
export const MAX_VIDEO_LANGUAGES = 8;
/** The languages offered in the settings screen. Every `flag` has its file in public/widget/v1/flags. */
export const VIDEO_LANGUAGES: VideoLanguage[] = [
  { code: 'en-US', label: 'English (US)', flag: 'us' }, { code: 'en-GB', label: 'English (UK)', flag: 'gb' }, { code: 'en-AU', label: 'English (Australia)', flag: 'au' }, { code: 'en-IN', label: 'English (India)', flag: 'in' },
  { code: 'en-CA', label: 'English (Canada)', flag: 'ca' }, { code: 'en-NZ', label: 'English (New Zealand)', flag: 'nz' }, { code: 'en-IE', label: 'English (Ireland)', flag: 'ie' }, { code: 'en-SG', label: 'English (Singapore)', flag: 'sg' },
  { code: 'en-ZA', label: 'English (South Africa)', flag: 'za' }, { code: 'hi-IN', label: 'Hindi', flag: 'in' }, { code: 'bn-IN', label: 'Bengali (India)', flag: 'in' }, { code: 'bn-BD', label: 'Bengali (Bangladesh)', flag: 'bd' },
  { code: 'ta-IN', label: 'Tamil', flag: 'in' }, { code: 'te-IN', label: 'Telugu', flag: 'in' }, { code: 'mr-IN', label: 'Marathi', flag: 'in' }, { code: 'gu-IN', label: 'Gujarati', flag: 'in' },
  { code: 'kn-IN', label: 'Kannada', flag: 'in' }, { code: 'ml-IN', label: 'Malayalam', flag: 'in' }, { code: 'pa-IN', label: 'Punjabi', flag: 'in' }, { code: 'ur-PK', label: 'Urdu', flag: 'pk' },
  { code: 'es-ES', label: 'Spanish (Spain)', flag: 'es' }, { code: 'es-MX', label: 'Spanish (Mexico)', flag: 'mx' }, { code: 'fr-FR', label: 'French', flag: 'fr' }, { code: 'fr-CA', label: 'French (Canada)', flag: 'ca' },
  { code: 'de-DE', label: 'German', flag: 'de' }, { code: 'pt-PT', label: 'Portuguese (Portugal)', flag: 'pt' }, { code: 'pt-BR', label: 'Portuguese (Brazil)', flag: 'br' }, { code: 'it-IT', label: 'Italian', flag: 'it' },
  { code: 'nl-NL', label: 'Dutch', flag: 'nl' }, { code: 'pl-PL', label: 'Polish', flag: 'pl' }, { code: 'sv-SE', label: 'Swedish', flag: 'se' }, { code: 'da-DK', label: 'Danish', flag: 'dk' },
  { code: 'nb-NO', label: 'Norwegian', flag: 'no' }, { code: 'fi-FI', label: 'Finnish', flag: 'fi' }, { code: 'el-GR', label: 'Greek', flag: 'gr' }, { code: 'cs-CZ', label: 'Czech', flag: 'cz' },
  { code: 'ro-RO', label: 'Romanian', flag: 'ro' }, { code: 'hu-HU', label: 'Hungarian', flag: 'hu' }, { code: 'uk-UA', label: 'Ukrainian', flag: 'ua' }, { code: 'ru-RU', label: 'Russian', flag: 'ru' },
  { code: 'tr-TR', label: 'Turkish', flag: 'tr' }, { code: 'ar-SA', label: 'Arabic', flag: 'sa' }, { code: 'ar-AE', label: 'Arabic (UAE)', flag: 'ae' }, { code: 'he-IL', label: 'Hebrew', flag: 'il' },
  { code: 'ja-JP', label: 'Japanese', flag: 'jp' }, { code: 'ko-KR', label: 'Korean', flag: 'kr' }, { code: 'zh-CN', label: 'Chinese (Simplified)', flag: 'cn' }, { code: 'zh-TW', label: 'Chinese (Traditional)', flag: 'tw' },
  { code: 'id-ID', label: 'Indonesian', flag: 'id' }, { code: 'ms-MY', label: 'Malay', flag: 'my' }, { code: 'vi-VN', label: 'Vietnamese', flag: 'vn' }, { code: 'th-TH', label: 'Thai', flag: 'th' },
  { code: 'fil-PH', label: 'Filipino', flag: 'ph' },
];
export function flagUrl(flag: string): string { return `${widgetOrigin()}/widget/v1/flags/${flag}.svg`; }
/** A question's wording in one language: its own, else (for the default language) the plain text, else empty. */
export function videoQuestionText(q: VideoQuestion, lang: string, languages: VideoLanguage[]): string {
  const own = (q.text_variants ?? []).find((t) => t && t.lang === lang);
  return own ? own.text : lang === languages[0]?.code ? q.text : '';
}
/** The wording per language in the order of the languages, empty ones and removed languages dropped. */
export function orderVideoTexts(q: VideoQuestion, languages: VideoLanguage[]): VideoText[] {
  return languages.flatMap((l) => { const t = videoQuestionText(q, l.code, languages).trim(); return t ? [{ lang: l.code, text: t.slice(0, 120) }] : []; });
}
/** A per-language clip list in the order of the languages, one clip per language, clips of removed languages dropped. */
export function orderVideoClips(list: VideoClip[] | null | undefined, languages: VideoLanguage[]): VideoClip[] {
  const all = Array.isArray(list) ? list : [];
  return languages.flatMap((l) => { const c = all.find((x) => x && x.lang === l.code && !!mediaUrl(x.url)); return c ? [{ lang: l.code, url: c.url, kind: c.kind ?? mediaKind(c.url) }] : []; });
}
/** The clips one step can play, as the widget picks them (video.js clips()): one per language, else the single clip. */
export function videoClips(url: string | null | undefined, kind: 'video' | 'image' | undefined, variants: VideoClip[] | null | undefined, languages: VideoLanguage[]): Array<{ lang: string | null; url: string; kind: 'video' | 'image' }> {
  const list = orderVideoClips(variants, languages);
  return list.length ? list : url && mediaUrl(url) ? [{ lang: null, url, kind: kind ?? mediaKind(url) }] : [];
}
/** The video bubble settings as they are saved (and as the preview draws them). */
export function packVideoBubble(d: VideoBubbleSettings, maxQuestions = 6): VideoBubbleSettings {
  const languages = (d.languages ?? []).slice(0, MAX_VIDEO_LANGUAGES).map((l) => ({ code: l.code, label: l.label.trim() || VIDEO_LANGUAGES.find((x) => x.code === l.code)?.label || l.code, flag: l.flag }));
  const variants = orderVideoClips(d.variants, languages), main = variants[0];
  return { ...d, languages, variants, url: languages.length ? main?.url ?? null : d.url, kind: languages.length ? main?.kind ?? d.kind : d.kind, questions: packVideoQuestions(videoQuestions(d.questions), maxQuestions, languages) };
}
export const WEBCHAT_MEDIA_BUCKET = 'outreach-webchat-media';
export const WEBCHAT_MEDIA_MAX_MB = 20;
/** What the bucket accepts, by extension (browsers report '' for some of these). */
const MEDIA_TYPES: Record<string, { mime: string; kind: 'video' | 'image' }> = {
  mp4: { mime: 'video/mp4', kind: 'video' }, m4v: { mime: 'video/mp4', kind: 'video' }, webm: { mime: 'video/webm', kind: 'video' }, gif: { mime: 'image/gif', kind: 'image' }, webp: { mime: 'image/webp', kind: 'image' },
};
export const WEBCHAT_MEDIA_ACCEPT = 'video/mp4,video/webm,image/gif,image/webp,.mp4,.m4v,.webm,.gif,.webp';
export function mediaKind(nameOrUrl: string): 'video' | 'image' { return /\.(gif|webp|a?png|jpe?g)(\?|#|$)/i.test(nameOrUrl) ? 'image' : 'video'; }
/** The address a clip plays from: `preset:<file>` is a built-in clip that ships next to the widget files. */
export function mediaUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /^preset:([\w.-]+)$/i.exec(url);
  return m ? `${widgetOrigin()}/widget/v1/presets/${m[1]}` : /^https:\/\//i.test(url) || (IS_DEMO && /^blob:/i.test(url)) ? url : null;
}
/** The address a bot avatar shows from: `preset:<file>` is a built-in avatar in public/widget/v1/avatars (the loader resolves it the same way). */
export function avatarUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /^preset:([\w.-]+)$/i.exec(url);
  return m ? `${widgetOrigin()}/widget/v1/avatars/${m[1]}` : /^https?:\/\//i.test(url) || (IS_DEMO && /^blob:/i.test(url)) ? url : null;
}
export interface WebchatPreset { file: string; label: string; kind: 'video' | 'image' }
function usePresetList(dir: 'presets' | 'avatars') {
  return useQuery({ queryKey: ['outreach', 'webchat', dir], staleTime: 10 * 60_000, queryFn: async () => {
    // eslint-disable-next-line no-restricted-globals -- a static file on our own origin (allowed in the product tour too)
    try { const r = await fetch(`/widget/v1/${dir}/${dir}.json`, { cache: 'no-cache' }); if (!r.ok) return []; const j = await r.json(); return (Array.isArray(j) ? j : []).filter((x) => x && typeof x.file === 'string' && /^[\w.-]+$/.test(x.file)) as WebchatPreset[]; } catch { return []; }
  } });
}
/** Built-in clips: public/widget/v1/presets/presets.json, written by scripts/outreach-webchat-presets.mjs. */
export function useWebchatPresets() { return usePresetList('presets'); }
/** Built-in bot avatars: public/widget/v1/avatars/avatars.json, written by scripts/outreach-webchat-presets.mjs --avatars. */
export function useWebchatAvatars() { return usePresetList('avatars'); }
/** A video picked for upload may be this big: it is shrunk in the browser first, and the result must fit WEBCHAT_MEDIA_MAX_MB. */
export const WEBCHAT_VIDEO_INPUT_MAX_MB = 300;
const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;
/**
 * Shrink a video for the widget before it uploads (lib/videoCompression, mediabunny, loaded only here): the short
 * side at most 720px, H.264 + AAC, metadata first so it starts playing before it has fully downloaded. The bubble is
 * at most 240px and the expanded view 720px, so nothing visible is lost. Hands back the original when the browser
 * cannot re-encode it or the saving is under 10%.
 */
async function optimiseWebchatVideo(file: File, onProgress?: (percent: number) => void): Promise<File> {
  try {
    const { canCompressVideo, compressVideoForWeb } = await import('@/lib/videoCompression');
    if (!canCompressVideo()) return file;
    return (await compressVideoForWeb(file, { maxShortSide: 720, maxBitrate: 1_500_000 }, onProgress)).file;
  } catch (e) {
    console.warn('Video not compressed, uploading the original:', e);
    return file;
  }
}
export type WebchatUploadStatus = { stage: 'compressing'; percent: number } | { stage: 'uploading' };
/**
 * Upload a launcher clip to the public media bucket under `<ws>/<inbox>/<ts>-<name>` and return its public address.
 * A video is compressed first (optimiseWebchatVideo); `original` is its size before that. Older uploads of the inbox
 * are removed, except the ones in `keep`: every clip the published settings or the draft on screen still point at (the
 * main clip and each question's clip).
 */
export async function uploadWebchatMedia(ws: string, inboxId: string, picked: File, keep: Array<string | null | undefined> = [], onStatus?: (s: WebchatUploadStatus) => void): Promise<{ url: string; kind: 'video' | 'image'; size: number; original: number }> {
  let file = picked;
  let t = MEDIA_TYPES[(file.name.split('.').pop() ?? '').toLowerCase()];
  if (!t) throw new Error('Use an MP4 or WebM video, or a GIF / WebP image.');
  if (t.kind === 'video') {
    if (file.size > WEBCHAT_VIDEO_INPUT_MAX_MB * 1048576) throw new Error(`That video is ${mb(file.size)}. The limit is ${WEBCHAT_VIDEO_INPUT_MAX_MB} MB.`);
    onStatus?.({ stage: 'compressing', percent: 0 });
    file = await optimiseWebchatVideo(file, (percent) => onStatus?.({ stage: 'compressing', percent }));
    t = MEDIA_TYPES[(file.name.split('.').pop() ?? '').toLowerCase()] ?? t;
  }
  if (file.size > WEBCHAT_MEDIA_MAX_MB * 1048576) throw new Error(t.kind === 'video' && file !== picked
    ? `Even compressed, that video is ${mb(file.size)}. The limit is ${WEBCHAT_MEDIA_MAX_MB} MB: trim it shorter and try again.`
    : `That file is ${mb(file.size)}. The limit is ${WEBCHAT_MEDIA_MAX_MB} MB.`);
  onStatus?.({ stage: 'uploading' });
  const bucket = db.storage.from(WEBCHAT_MEDIA_BUCKET), dir = `${ws}/${inboxId}`;
  const name = `${Date.now()}-${file.name.replace(/[^\w.-]+/g, '_').slice(-80)}`;
  const { error } = await bucket.upload(`${dir}/${name}`, file, { contentType: t.mime, cacheControl: '31536000', upsert: false });
  if (error) throw new Error(`Could not upload ${file.name}: ${error.message}`);
  const url = bucket.getPublicUrl(`${dir}/${name}`).data.publicUrl;
  try {
    const { data } = await bucket.list(dir, { limit: 100 });
    // files only: the logo/ and avatar/ folders (uploadWebchatImage) have their own tidy-up
    const stale = (data ?? []).filter((o) => o.id && !o.name.includes('/')).map((o) => `${dir}/${o.name}`).filter((path) => !path.endsWith(`/${name}`) && !keep.some((u) => u && u.endsWith(`/${path}`)));
    if (stale.length) await bucket.remove(stale);
  } catch { /* tidy-up only */ }
  return { url, kind: t.kind, size: file.size, original: picked.size };
}
/** The toast after an upload: the saving when the clip was compressed. */
export function uploadedNote(r: { size: number; original: number }, what = 'Video'): string {
  return r.size < r.original ? `${what} compressed from ${mb(r.original)} to ${mb(r.size)} and uploaded. Save to publish it.` : `${what} uploaded. Save to publish it.`;
}
/** What the logo / bot avatar pickers open: anything the browser can draw; the crop step re-encodes it. */
export const WEBCHAT_IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif';
/**
 * Upload a cropped header logo, bot avatar or popup image (WebP, or PNG where the browser cannot encode WebP) under
 * `<ws>/<inbox>/<folder>/` and return its public address. Its own folder keeps it out of the clip tidy-up; older images
 * of that folder go, except the ones in `keep`.
 */
export async function uploadWebchatImage(ws: string, inboxId: string, folder: 'logo' | 'avatar' | 'popup', file: File, keep: Array<string | null | undefined> = []): Promise<string> {
  const what = folder === 'popup' ? 'image' : folder;
  if (file.type !== 'image/webp' && file.type !== 'image/png') throw new Error(`The cropped ${what} must be a WebP or PNG image.`);
  const bucket = db.storage.from(WEBCHAT_MEDIA_BUCKET), dir = `${ws}/${inboxId}/${folder}`;
  const name = `${Date.now()}.${file.type === 'image/png' ? 'png' : 'webp'}`;
  const { error } = await bucket.upload(`${dir}/${name}`, file, { contentType: file.type, cacheControl: '31536000', upsert: false });
  if (error) throw new Error(`Could not upload the ${what}: ${error.message}`);
  const url = bucket.getPublicUrl(`${dir}/${name}`).data.publicUrl;
  try {
    const { data } = await bucket.list(dir, { limit: 100 });
    const stale = (data ?? []).map((o) => `${dir}/${o.name}`).filter((path) => !path.endsWith(`/${name}`) && !keep.some((u) => u && u.endsWith(`/${path}`)));
    if (stale.length) await bucket.remove(stale);
  } catch { /* tidy-up only */ }
  return url;
}

// ---------------------------------------------------------------------------
// "Use your own button" (Installation tab): no JavaScript needed, the attributes go on any element
// ---------------------------------------------------------------------------
export const OWN_BUTTON_SNIPPETS: Array<{ key: string; label: string; lang: string; code: string }> = [
  { key: 'open', label: 'Any element opens the chat', lang: 'html', code: '<button data-growthxai="open">Chat with us</button>' },
  { key: 'ask', label: 'Ask a question', lang: 'html', code: '<a href="#" data-growthxai-ask="What\'s your return policy?">Returns question?</a>' },
  { key: 'prefill', label: 'Put a text in the message box', lang: 'html', code: '<button data-growthxai-prefill="I\'d like a quote for ">Get a quote</button>' },
  { key: 'badge', label: 'Unread badge on your button', lang: 'html', code: '<button data-growthxai="open">Help <span data-growthxai-unread></span></button>' },
  { key: 'form', label: 'A search-style box', lang: 'html', code: '<form data-growthxai="ask-form"><input name="q" placeholder="Ask AI anything"><button>Ask</button></form>' },
  { key: 'shopify', label: 'Shopify product page', lang: 'liquid', code: '{%- comment -%} Shopify product page {%- endcomment -%}\n<button data-growthxai-ask="Is this good for a wedding?"\n        data-growthxai-context="product:{{ product.handle }}">Ask about this piece</button>' },
  { key: 'react', label: 'React / Next.js', lang: 'jsx', code: '<button onClick={() => window.growthxai?.ask(\'Do you ship to Dubai?\')}>Shipping?</button>' },
  { key: 'link', label: 'A link (emails, ads, QR codes)', lang: 'text', code: 'https://your-site.com/any-page?gx=open\nhttps://your-site.com/any-page?gx_q=Do%20you%20do%20custom%20sizes%3F\n<a href="#ask-ai">Ask AI</a>' },
];
export const OWN_BUTTON_ATTRIBUTES: Array<[string, string]> = [
  ['data-growthxai="open"', 'Opens the chat ("close" and "toggle" close / toggle it)'],
  ['data-growthxai-ask="…"', 'Opens the chat and sends this question as the visitor'],
  ['data-growthxai-prefill="…"', 'Opens the chat with this text in the message box, not sent'],
  ['data-growthxai-mode="sidebar"', 'Opens in this shell (bubble, drawer, sidebar, modal, inline) until the page reloads'],
  ['data-growthxai-context="…"', 'Background for the AI on that question, never shown. product:<handle | sku | url> names a catalogue product'],
  ['data-growthxai-label="pricing-page"', 'Adds a label to the conversation'],
  ['data-growthxai-unread', 'Its text is kept at the unread count; data-count="3"; hidden at 0'],
  ['data-growthxai="call"', 'Starts a voice call with the assistant (when Voice is on for this website)'],
];

export const HMAC_SAMPLES: Array<{ label: string; code: (secret: string) => string }> = [
  { label: 'Node.js', code: (s) => `const crypto = require('crypto');\nconst hash = crypto.createHmac('sha256', '${s}').update(String(userId)).digest('hex');\n// in the page:\nwindow.growthxai.setUser(String(userId), { email, name, identifier_hash: hash });` },
  { label: 'Python', code: (s) => `import hmac, hashlib\nhash = hmac.new(b'${s}', str(user_id).encode(), hashlib.sha256).hexdigest()` },
  { label: 'PHP', code: (s) => `$hash = hash_hmac('sha256', (string)$userId, '${s}');` },
  { label: 'Ruby', code: (s) => `hash = OpenSSL::HMAC.hexdigest('sha256', '${s}', user_id.to_s)` },
  { label: 'Go', code: (s) => `mac := hmac.New(sha256.New, []byte("${s}"))\nmac.Write([]byte(userID))\nhash := hex.EncodeToString(mac.Sum(nil))` },
];

export const CSP_NOTES = (apiHost: string, appOrigin: string, turnstile = false, video = false, productImageHosts: string[] = [], voice = false, presetAvatar = false) => [
  `script-src ${appOrigin}${turnstile ? ' https://challenges.cloudflare.com' : ''}`,
  `connect-src ${apiHost} ${apiHost.replace(/^http/, 'ws')}${voice ? ' https://api.elevenlabs.io wss://api.elevenlabs.io https://livekit.rtc.elevenlabs.io wss://livekit.rtc.elevenlabs.io' : ''}`,
  ...(voice ? ['worker-src blob:  (voice: the audio processing runs in a worklet)', 'media-src blob:  (voice: the assistant\'s audio)', 'Permissions-Policy: microphone=(self)  (if your site sends one: voice needs the microphone)'] : []),
  `img-src ${apiHost}${video || presetAvatar ? ` ${appOrigin}` : ''}${productImageHosts.length ? ` ${productImageHosts.join(' ')}` : ''} data:${productImageHosts.length ? '  (product pictures on the cards come from the catalogue\'s image hosts)' : ''}`,
  ...(video ? [`media-src ${apiHost} ${appOrigin}  (the launcher clip; add your own host if the clip is on it)`] : []),
  turnstile ? `frame-src https://challenges.cloudflare.com  (Turnstile runs its check in an iframe)` : `frame-src: none needed (the widget uses Shadow DOM, not an iframe)`,
  `style-src: no change needed (styles are constructed stylesheets inside the Shadow root)`,
];

export function fmtSeconds(s: number | null | undefined): string {
  if (s == null) return '—';
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}
