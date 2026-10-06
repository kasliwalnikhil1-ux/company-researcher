/**
 * Website agent (web chat) in the demo: the settings defaults and merge (outreach_webchat_default_settings() as
 * 053 + 063 + 068 + 069 leave it), the checks a save runs (053 settings_check, 068 buttons_check / products_fix, 069
 * voice_check), business hours, availability and the inbox JSON the UI reads (outreach_webchat__inbox_json).
 * Relative imports only; no network.
 */
import { demoError, type Ctx } from '../ctx';
import type { DemoStore, Row } from '../store';

export const T = {
  inboxes: 'outreach_webchat_inboxes',
  members: 'outreach_webchat_inbox_members',
  visitors: 'outreach_webchat_visitors',
  pageViews: 'outreach_webchat_page_views',
  events: 'outreach_webchat_events',
  canned: 'outreach_webchat_canned_responses',
  campaigns: 'outreach_webchat_campaigns',
  blocks: 'outreach_webchat_blocks',
  history: 'outreach_webchat_settings_history',
  turns: 'outreach_webchat_ai_turns',
  suggestions: 'outreach_webchat_ai_suggestions',
  uploads: 'outreach_webchat_uploads',
  voiceAgents: 'outreach_webchat_voice_agents',
  voiceCalls: 'outreach_webchat_voice_calls',
  presence: 'outreach_webchat_agent_presence',
} as const;

const clone = <V,>(v: V): V => (v == null ? v : JSON.parse(JSON.stringify(v)));

/** outreach_webchat_default_settings() after 053, 063 (review_timeout_min), 068 (buttons, products) and 069 (voice). */
export const DEFAULT_SETTINGS: Row = {
  appearance: {
    brand_name: 'Chat', logo_url: null, bot_avatar_url: null, welcome_title: 'Hi there 👋', welcome_tagline: 'Ask us anything, or share your feedback.',
    accent: '#4f46e5', widget_bg: '#ffffff', chat_bg: '#f8f8fa', font: 'Inter', theme: 'auto', mode: 'bubble', z_index: 2147483000, custom_css: '', drawer_side: 'right', panel_width: 384, mobile: {},
  },
  launcher: {
    desktop: { type: 'icon', size: 'md', position: 'right', margin_bottom: 48, margin_side: 48, text: 'Chat with us' },
    mobile: { type: 'icon', size: 'md', position: 'right', margin_bottom: 36, margin_side: 36, text: 'Chat' },
    show_unread_count: true, show_unread_previews: true, hide: false, campaigns_open: false, online_dot: true,
    video: {
      enabled: true, url: null, kind: 'video', shape: 'circle', size: 120, ratio: '1:1', fit: 'cover', focus_x: 50, focus_y: 50, zoom: 100, border_color: '#ffffff', border_width: 3,
      expanded_width: 420, expanded_ratio: 'auto', sound: true, questions: [], questions_position: 'over', cta_text: 'Text', question_bg: '#111827', question_color: '#ffffff', cta_bg: null, cta_color: '#ffffff',
    },
  },
  popup: { enabled: false, text: "👋 Have a question? We're here to help.", image_url: null, delay_s: 3, position: 'above' },
  messages: {
    greeting_enabled: true, greeting: 'Hi! How can we help?', reply_time: 'minutes', available_message: "We're online",
    unavailable_message: "We're away. Leave a message.", email_capture_prompt: "What's your email so we can reply?",
    end_message: 'Thanks for chatting!', placeholder: 'Ask a question…', privacy_url: null, quick_replies: [], handoff_message: 'Connecting you to a person…',
    handoff_offline_message: "We're offline. Leave your email and we'll reply.",
  },
  pre_chat: {
    enabled: false, message: 'Tell us a bit about yourself so we can help.', when: 'before_first',
    fields: [
      { key: 'name', label: 'Name', type: 'text', visible: true, required: false, placeholder: '' },
      { key: 'email', label: 'Email', type: 'email', visible: true, required: true, placeholder: '' },
      { key: 'phone', label: 'Phone', type: 'phone', visible: false, required: false, placeholder: '' },
    ],
    consent: { enabled: false, label: 'I agree to be contacted about my request.', link: null, text_version: 'v1' },
  },
  features: {
    file_picker: true, emoji_picker: true, restart: true, end_conversation: true, allow_after_resolved: true, single_conversation: false, sounds: true, read_receipts: true,
    show_agent_names: true, transcript: true, email_capture: true, powered_by: true, show_offline_status: true, hide_outside_hours: false, markdown: true,
  },
  csat: { enabled: true, scale: 'emoji', ask_comment: true, by_email: true },
  continuity: { enabled: true, inactivity_min: 5, digest_window_min: 15, include_transcript_on_resolve: false },
  ai: {
    mode: 'off', knowledge_source_ids: [], persona: '', allowed_topics: '',
    handoff: { keywords: ['pricing quote', 'talk to a person', 'speak to a human', 'complaint', 'refund'], max_turns: 6, low_confidence_streak: 2, leads_in_sequence: true },
    show_sources: true, hourly_cap_per_visitor: 30, review_timeout_min: 10,
    products: { enabled: false, catalogue_ids: [], max: 3, show_prices: true, include_oos: false, add_to_cart: false, utm: true },
  },
  targeting: { url_rules: [], hide_mobile: false, hide_desktop: false, identified_only: false, countries_include: [], countries_exclude: [] },
  security: {
    rate_limits: { visitor_10s: 10, visitor_1h: 200, ip_1m: 20, ip_1h: 300, inbox_1m: 2000 },
    turnstile_enabled: false, turnstile_site_key: null, consent_mode: false, allow_localhost: false, attachments: { max_mb: 10, allow_zip: false }, profanity_filter: false,
  },
  assignment: { auto: true, capacity: 10, unassign_offline_min: 0 },
  locale: { default: 'en', use_browser: true, strings: {} },
  ask_buttons: [],
  selection_ask: { enabled: false, area: 'main, article', label: 'Ask AI' },
  shortcut: { enabled: null },
  voice: {
    enabled: false, voice_id: null, voice_name: null, speed: 1.0, stability: 0.5, language: null, languages: [], auto_language: true, hinglish: false,
    greeting: {}, instructions: '', max_minutes: 5, silence_end_s: 20, model: 'fast', tool_sound: 'typing', collect: ['name', 'phone', 'need'], record: true, retention_days: 30, consent_text: null,
    ui: { start_text: 'Voice', start_hint: 'Speak with our AI assistant', orb_1: null, orb_2: '#c7a3ff', avatar: 'logo', labels: {}, captions: true, show_on: { home: true, composer: true, launcher: false } },
  },
};

const isObj = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v);

/** outreach_webchat__merge: keys of b override a; nested objects merge; arrays / scalars replace. */
export function merge(a: unknown, b: unknown): any {   // eslint-disable-line @typescript-eslint/no-explicit-any
  if (isObj(a) && isObj(b)) {
    const out: Row = {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) out[k] = k in a && k in b ? merge(a[k], b[k]) : k in b ? clone(b[k]) : clone(a[k]);
    return out;
  }
  return b === undefined ? clone(a) : clone(b);
}

/** outreach_webchat__settings: the stored settings over the defaults. */
export const settingsOf = (inbox: Row): Row => merge(DEFAULT_SETTINGS, inbox.settings ?? {});

export const randHex = (store: DemoStore, bytes: number) => Array.from({ length: bytes }, () => store.int(0, 255).toString(16).padStart(2, '0')).join('');

export function inboxOr404(ctx: Ctx, id: unknown): Row {
  const i = ctx.store.get(T.inboxes, String(id ?? ''));
  if (!i || i.deleted_at || i.workspace_id !== ctx.ws) demoError('E_NOT_FOUND', 'Website not found');
  return i!;
}

export function agentName(store: DemoStore, ws: string, userId: string | null | undefined): string | null {
  if (!userId) return null;
  const m = store.t('outreach_members').find((x) => x.workspace_id === ws && x.user_id === userId);
  return m ? (m.display_name || String(m.email ?? '').split('@')[0] || 'Agent') : 'Agent';
}

// ---------------------------------------------------------------------------- business hours
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
function localParts(ms: number, tz: string): { date: string; dow: number; minutes: number } {
  let f: Intl.DateTimeFormat;
  try { f = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
  catch { f = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { date: `${p.year}-${p.month}-${p.day}`, dow, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}
const toMin = (s: unknown) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(s ?? '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

/** outreach_webchat__in_hours: no weekly schedule = always open; intervals may cross midnight; holidays are closed. */
export function inHours(bh: Row | null | undefined, ms = Date.now()): boolean {
  if (!bh || !isObj(bh.weekly)) return true;
  const lp = localParts(ms, String(bh.tz || 'UTC'));
  if (Array.isArray(bh.holidays) && bh.holidays.includes(lp.date)) return false;
  for (const iv of (bh.weekly[DAYS[lp.dow]] ?? []) as unknown[][]) {
    const f = toMin(iv?.[0]), t = toMin(iv?.[1]); if (f == null || t == null) continue;
    if (f <= t ? lp.minutes >= f && lp.minutes < t : lp.minutes >= f || lp.minutes < t) return true;
  }
  for (const iv of (bh.weekly[DAYS[(lp.dow + 6) % 7]] ?? []) as unknown[][]) {
    const f = toMin(iv?.[0]), t = toMin(iv?.[1]); if (f == null || t == null) continue;
    if (f > t && lp.minutes < t) return true;
  }
  return false;
}

/** outreach_webchat__next_open: the next opening time within two weeks (15-minute steps are precise enough here). */
export function nextOpen(bh: Row | null | undefined, ms = Date.now()): string | null {
  if (!bh || !isObj(bh.weekly)) return null;
  const step = 15 * 60_000;
  for (let t = Math.ceil(ms / step) * step; t < ms + 14 * 86_400_000; t += step) if (inHours(bh, t)) return new Date(t).toISOString();
  return null;
}

// ---------------------------------------------------------------------------- availability
/** Members with a presence ping in the last 10 minutes. The demo visitor has the app open, so they are always online. */
export function onlineUserIds(ctx: Ctx, inbox: Row): string[] {
  const members = ctx.store.t(T.members).filter((m) => m.inbox_id === inbox.id);
  const fresh = Date.now() - 10 * 60_000;
  return members.filter((m) => m.user_id === ctx.userId
    || ctx.store.t(T.presence).some((p) => p.workspace_id === inbox.workspace_id && p.user_id === m.user_id && p.state === 'online' && Date.parse(p.last_seen_at) > fresh)).map((m) => m.user_id);
}

export function availability(ctx: Ctx, inbox: Row): Row {
  const st = settingsOf(inbox);
  const online = onlineUserIds(ctx, inbox);
  const inh = inHours(inbox.business_hours);
  const mode = String(st.ai?.mode ?? 'off');
  return {
    online: inh && online.length > 0, in_hours: inh, next_open_at: inh ? null : nextOpen(inbox.business_hours),
    timezone: inbox.business_hours?.tz ?? 'UTC', agents: online.slice(0, 3).map((u) => ({ name: agentName(ctx.store, inbox.workspace_id, u) })),
    reply_time: st.messages?.reply_time ?? 'minutes',
    // 063: the widget never hears about Review
    ai_mode: inbox.ai_enabled && mode !== 'review' ? mode : 'off',
  };
}

/** outreach_webchat__inbox_json. */
export function inboxJson(ctx: Ctx, i: Row): Row {
  const s = ctx.store;
  const role = s.t('outreach_members').find((m) => m.workspace_id === i.workspace_id && m.user_id === ctx.userId)?.role ?? 'owner';
  const online = new Set(onlineUserIds(ctx, i));
  const chats = s.t('outreach_chats').filter((c) => c.webchat_inbox_id === i.id);
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const since30 = Date.now() - 30 * 86_400_000;
  const mb = i.reply_mailbox_id ? s.get('outreach_senders', i.reply_mailbox_id) : undefined;
  const { hmac_token: _h, ...rest } = i; void _h;
  return {
    ...rest,
    settings: settingsOf(i),
    hmac_token: role === 'owner' || role === 'manager' ? i.hmac_token : null,
    members: s.t(T.members).filter((m) => m.inbox_id === i.id).map((m) => ({ user_id: m.user_id, auto_assign: m.auto_assign !== false, name: agentName(s, i.workspace_id, m.user_id), online: online.has(m.user_id) })),
    availability: availability(ctx, i),
    stats: {
      open: chats.filter((c) => c.status === 'open' || c.status === 'pending').length,
      unassigned: chats.filter((c) => c.status === 'open' && !c.assigned_to).length,
      today: chats.filter((c) => Date.parse(c.created_at) > today.getTime()).length,
      visitors_30d: s.t(T.visitors).filter((v) => v.inbox_id === i.id && v.last_seen_at && Date.parse(v.last_seen_at) > since30).length,
    },
    reply_mailbox: mb ? { id: mb.id, name: mb.display_name, email: mb.owner_email, provider: mb.provider, status: mb.status } : null,
  };
}

// ---------------------------------------------------------------------------- checks on save
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const VOICE_LANGS = ['en', 'ja', 'zh', 'de', 'hi', 'fr', 'ko', 'pt', 'it', 'es', 'id', 'nl', 'tr', 'fil', 'pl', 'sv', 'bg', 'ro', 'ar', 'cs', 'el', 'fi', 'hr', 'ms', 'sk', 'da', 'ta', 'uk', 'ru', 'hu', 'no', 'vi'];
export const VOICE_LANGUAGE_CODES = VOICE_LANGS;
const bad = (what: string): never => demoError('E_PAYLOAD_INVALID', what);

/** 069 outreach_webchat__voice_check (the parts a form can get wrong). */
export function checkVoice(v: Row | null | undefined): void {
  if (v == null) return;
  if (!isObj(v)) bad('voice');
  for (const k of ['enabled', 'auto_language', 'hinglish', 'record']) if (k in v && typeof v[k] !== 'boolean') bad(`voice.${k} is on or off`);
  if (v.voice_id != null && !/^[A-Za-z0-9]{8,64}$/.test(String(v.voice_id))) bad('voice.voice_id');
  if (String(v.voice_name ?? '').length > 120) bad('voice.voice_name');
  if ('speed' in v && (typeof v.speed !== 'number' || v.speed < 0.7 || v.speed > 1.2)) bad('voice.speed is 0.7 to 1.2');
  if ('stability' in v && (typeof v.stability !== 'number' || v.stability < 0 || v.stability > 1)) bad('voice.stability is 0 to 1');
  if (v.language != null && !VOICE_LANGS.includes(String(v.language))) bad('voice.language is not a language voice supports');
  if (v.languages != null) {
    if (!Array.isArray(v.languages)) bad('voice.languages');
    if (v.languages.length > 10) bad('voice.languages (10 at most)');
    if (v.languages.some((l: unknown) => !VOICE_LANGS.includes(String(l)))) bad('voice.languages has a language voice does not support');
    if (new Set(v.languages).size !== v.languages.length) bad('voice.languages (a language is listed twice)');
  }
  if (v.greeting != null) {
    if (!isObj(v.greeting)) bad('voice.greeting');
    for (const [k, x] of Object.entries(v.greeting)) {
      if (!VOICE_LANGS.includes(k)) bad(`voice.greeting (unknown language ${k.slice(0, 12)})`);
      if (String(x ?? '').length > 300) bad('voice.greeting (300 characters at most)');
    }
  }
  if (String(v.instructions ?? '').length > 2000) bad('voice.instructions (2,000 characters at most)');
  if ('max_minutes' in v && (!Number.isInteger(v.max_minutes) || v.max_minutes < 1 || v.max_minutes > 30)) bad('voice.max_minutes is 1 to 30');
  if ('silence_end_s' in v && (!Number.isInteger(v.silence_end_s) || v.silence_end_s < 10 || v.silence_end_s > 120)) bad('voice.silence_end_s is 10 to 120');
  if ('retention_days' in v && (!Number.isInteger(v.retention_days) || v.retention_days < 1 || v.retention_days > 365)) bad('voice.retention_days is 1 to 365');
  if (v.model != null && !['fast', 'smart'].includes(v.model)) bad('voice.model');
  if (v.tool_sound != null && !['typing', 'none'].includes(v.tool_sound)) bad('voice.tool_sound');
  if (v.collect != null && (!Array.isArray(v.collect) || v.collect.some((c: unknown) => !['name', 'phone', 'need', 'budget'].includes(String(c))))) bad('voice.collect');
  if (String(v.consent_text ?? '').length > 400) bad('voice.consent_text (400 characters at most)');
  const ui = v.ui;
  if (ui != null) {
    if (!isObj(ui)) bad('voice.ui');
    if (String(ui.start_text ?? '').length > 40) bad('voice.ui.start_text (40 characters at most)');
    if (String(ui.start_hint ?? '').length > 80) bad('voice.ui.start_hint (80 characters at most)');
    for (const k of ['orb_1', 'orb_2']) if (ui[k] != null && !HEX.test(String(ui[k]))) bad(`voice.ui.${k}`);
    if (ui.avatar != null && !['logo', 'bot', 'none'].includes(ui.avatar)) bad('voice.ui.avatar');
  }
}

/** 068 outreach_webchat__url_rules_check. */
function checkRules(v: unknown, path: string) {
  if (v == null) return;
  if (!Array.isArray(v) || v.length > 20) bad(`${path} (a list, 20 rules at most)`);
  for (const r of v as Row[]) {
    if (!isObj(r)) bad(path);
    if (!['contains', 'equals', 'starts_with', 'regex'].includes(r.op)) bad(`${path}.op`);
    if (!['show', 'hide'].includes(r.action)) bad(`${path}.action`);
    if (typeof r.value !== 'string' || r.value.length > 500) bad(`${path}.value`);
  }
}

/** The 053 + 068 + 069 checks of a merged settings object, then the 063 / 051 enum checks. */
export function checkSettings(ns: Row): void {
  const ap = ns.appearance ?? {};
  if (ap.accent != null && !HEX.test(String(ap.accent))) bad('accent');
  if (String(ap.brand_name ?? '').length > 40) bad('brand_name');
  if (String(ap.custom_css ?? '').length > 20000) bad('custom_css');
  if (JSON.stringify(ns).length > 200000) bad('settings too large');
  const pu = ns.messages?.privacy_url;
  if (pu && (!/^https:\/\/[^\s"<>]+$/i.test(String(pu)) || String(pu).length > 1000)) bad('privacy_url must be an https link');
  // 068 buttons_check
  if (ns.launcher?.campaigns_open != null && typeof ns.launcher.campaigns_open !== 'boolean') bad('launcher.campaigns_open');
  const buttons = ns.ask_buttons;
  if (buttons != null) {
    if (!Array.isArray(buttons)) bad('ask_buttons');
    if (buttons.length > 10) bad('ask_buttons (10 buttons at most per website)');
    const ids = new Set<string>();
    for (const b of buttons as Row[]) {
      if (!isObj(b)) bad('ask_buttons');
      if (typeof b.id !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(b.id)) bad('ask_buttons.id');
      if (ids.has(b.id)) bad('ask_buttons (two buttons share an id)');
      ids.add(b.id);
      if (!['header', 'element'].includes(b.kind)) bad('ask_buttons.kind');
      if (typeof b.selector !== 'string' || !b.selector.trim() || b.selector.length > 200 || /[<>{}]/.test(b.selector)) bad('ask_buttons.selector (a CSS selector, 200 characters at most)');
      if (b.kind === 'header' && !['start', 'end'].includes(b.position ?? 'end')) bad('ask_buttons.position (start or end)');
      if (b.kind === 'element' && !['before', 'after', 'inside'].includes(b.position ?? 'after')) bad('ask_buttons.position (before, after or inside)');
      if ('label' in b && (typeof b.label !== 'string' || !b.label.trim() || b.label.length > 30)) bad('ask_buttons.label (30 characters at most)');
      if (!['filled', 'outline', 'text', 'match'].includes(b.style ?? 'filled')) bad('ask_buttons.style');
      if (!['open', 'ask', 'prefill'].includes(b.click ?? 'open')) bad('ask_buttons.click');
      if (b.kind === 'header' && (b.click ?? 'open') !== 'open') bad('ask_buttons.click (a header button opens the chat)');
      if (String(b.text ?? '').length > 300) bad('ask_buttons.text (300 characters at most)');
      if (['ask', 'prefill'].includes(b.click ?? 'open') && !String(b.text ?? '').trim()) bad('ask_buttons.text (the question or the text to prefill)');
      if (!['none', 'page', 'product'].includes(b.context ?? 'none')) bad('ask_buttons.context');
      if (b.mode != null && !['bubble', 'drawer', 'sidebar', 'modal', 'inline'].includes(b.mode)) bad('ask_buttons.mode');
      checkRules(b.url_rules, 'ask_buttons.url_rules');
    }
  }
  const sa = ns.selection_ask;
  if (sa != null && (!isObj(sa) || String(sa.area ?? '').length > 200 || /[<>{}]/.test(String(sa.area ?? '')) || String(sa.label ?? '').length > 30)) bad('selection_ask');
  const pr = ns.ai?.products;
  if (pr != null) {
    if (!isObj(pr)) bad('ai.products');
    if (pr.max != null && (!Number.isInteger(pr.max) || pr.max < 1 || pr.max > 6)) bad('ai.products.max (1 to 6 cards per answer)');
    if (pr.catalogue_ids != null && (!Array.isArray(pr.catalogue_ids) || pr.catalogue_ids.length > 20)) bad('ai.products.catalogue_ids');
  }
  checkVoice(ns.voice);
  // 053 video bubble
  const vb = ns.launcher?.video;
  if (vb != null) {
    if (!isObj(vb)) bad('launcher.video');
    // an uploaded clip in the demo is an in-memory object URL (blob:)
    if (vb.url && (!/^(https:\/\/[^\s"<>]+|preset:[a-z0-9][a-z0-9._-]*|blob:[^\s"<>]+)$/i.test(String(vb.url)) || String(vb.url).length > 1000)) bad('launcher.video.url');
    if (vb.kind != null && !['video', 'image'].includes(vb.kind)) bad('launcher.video.kind');
    if (vb.shape != null && !['circle', 'rounded', 'square'].includes(vb.shape)) bad('launcher.video.shape');
    if (vb.fit != null && !['cover', 'contain'].includes(vb.fit)) bad('launcher.video.fit');
    for (const k of ['border_color', 'question_bg', 'question_color', 'cta_bg', 'cta_color']) if (vb[k] != null && !HEX.test(String(vb[k]))) bad(`launcher.video.${k}`);
    if (String(vb.cta_text ?? '').length > 40) bad('launcher.video.cta_text');
    if (vb.questions != null && (!Array.isArray(vb.questions) || vb.questions.length > 6)) bad('launcher.video.questions (6 at most)');
  }
  if (ns.ai?.mode != null && !['off', 'first', 'offline_only', 'review'].includes(ns.ai.mode)) bad('ai.mode');
  if (ap.mode != null && !['bubble', 'drawer', 'sidebar', 'modal', 'inline', 'embedded'].includes(ap.mode)) bad('appearance.mode');
}

/** Catalogues a website may recommend from: its picks that exist in the workspace and hold a product (068 __product_sources). */
export function productSources(store: DemoStore, ws: string, st: Row): string[] {
  const ids: unknown[] = Array.isArray(st.ai?.products?.catalogue_ids) ? st.ai.products.catalogue_ids : [];
  return ids.map(String).filter((id) => {
    const src = store.get('outreach_knowledge_sources', id);
    return src && src.workspace_id === ws && (src.kind === 'catalogue' || src.detect_products) && store.t('outreach_products').some((p) => p.source_id === id && !p.deleted_at);
  });
}

/** 068 __products_fix: picks that are not catalogues are dropped; switching on needs a catalogue with products. */
export function productsFix(store: DemoStore, ws: string, ns: Row, patch: Row): Row {
  const pr = ns.ai?.products;
  if (!isObj(pr)) return ns;
  if (Array.isArray(pr.catalogue_ids)) pr.catalogue_ids = pr.catalogue_ids.filter((id: unknown) => { const s = store.get('outreach_knowledge_sources', String(id)); return s && s.workspace_id === ws && (s.kind === 'catalogue' || s.detect_products); });
  if (pr.enabled === true && productSources(store, ws, ns).length === 0) {
    if (patch?.settings?.ai?.products?.enabled === true && !('restored_from' in patch)) bad('add a product catalogue and wait until its products are in before switching on product recommendations');
    pr.enabled = false;
  }
  return ns;
}

export function validTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** Plan limit on websites (058 webchat_inboxes): launch 1, scale 3, enterprise unlimited. */
export function websiteLimit(store: DemoStore, ws: string): number | null {
  const plan = String(store.get('outreach_workspaces', ws)?.plan ?? 'scale');
  return plan === 'enterprise' || plan === 'agency_plus' ? null : plan === 'launch' ? 1 : 3;
}
