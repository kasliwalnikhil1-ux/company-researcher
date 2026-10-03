/**
 * THE LIVE PREVIEW of the website agent in the demo.
 *
 * In the real product the widget (public/widget/v1/loader.js + chat.js + ask.js) talks to the public edge function
 * `outreach-webchat` with fetch and a Realtime socket. In the demo the Website agent's preview can run that same
 * widget inside an iframe holding a fictional sample page; the iframe's `fetch` is replaced (before the widget loads)
 * by `parent.__growthxaiDemoWidget.request(...)`, which is this module: every route the widget calls is answered here
 * from the demo store, in the edge function's shapes. Nothing leaves the browser:
 *   - the widget's API base is `demo:/outreach-webchat` (a scheme no network stack resolves);
 *   - the config has no `realtime` block, so the widget never opens a socket (it polls this module every 5 s instead),
 *     and WebSocket / XMLHttpRequest / EventSource / sendBeacon / window.open are disabled inside the iframe;
 *   - Turnstile and voice are off in the config the preview gets (voice has its sample call on the Voice tab);
 *   - the widget's localStorage is a `gxdemo:wc:` prefix in sessionStorage, so Reset demo clears it.
 * Answers come from the seeded Q&A / knowledge through ai.ts websiteAnswer, streamed in chunks on a timer as the real
 * `/chat` SSE does, with product cards from the website's catalogues. Conversations land in the inbox.
 */
import type { Ctx } from '../ctx';
import { demoStorage } from '../storage';
import type { Row } from '../store';
import { answerFor, catalogueProducts, faqsFor, handoffMatch, productCard } from './answer';
import { addMessage, autoAssign, botLine, conversationJson, handoff, isBlocked, linkLead, messageJson, postCsat, startConversation, systemEvent, visitorJson } from './chat';
import { T, availability, productSources, randHex, settingsOf } from './core';

export const DEMO_API = 'demo:/outreach-webchat';
const iso = (ms = Date.now()) => new Date(ms).toISOString();
type Realm = { Response: typeof Response; ReadableStream: typeof ReadableStream; TextEncoder: typeof TextEncoder; navigator?: Navigator };

/** The demo context the bridge works with: bound by the website handlers (they run before a preview can open). */
let bound: Ctx | null = null;
export function bindWidgetCtx(ctx: Ctx): void { bound = ctx; }

class HttpErr extends Error { constructor(public status: number, public code: string, msg: string) { super(msg); } }

// ---------------------------------------------------------------------------- the routes
function headerOf(init: Row, name: string): string {
  const h = init?.headers;
  if (!h) return '';
  if (typeof h.get === 'function') return String(h.get(name) ?? '');
  const k = Object.keys(h).find((x) => x.toLowerCase() === name);
  return k ? String(h[k]) : '';
}
const bodyOf = (init: Row): Row => { try { return typeof init?.body === 'string' ? JSON.parse(init.body) : {}; } catch { return {}; } };

/** The demo site lives at about:srcdoc: pages are reported under the website's first domain instead. */
function siteUrl(inbox: Row, u: unknown): string | null {
  const d = (inbox.allowed_domains ?? []).find((x: string) => x && !x.startsWith('*.') && x !== 'localhost') ?? 'www.example.com';
  const s = String(u ?? '');
  if (!s) return null;
  if (/^about:|^blob:/.test(s)) { const hash = s.split('#')[1]; return `https://${d}/${hash ? `#${hash}` : ''}`; }
  return s.slice(0, 2000);
}

function uaParts(realm: Realm): { browser: string; os: string; device: string } {
  const ua = String(realm.navigator?.userAgent ?? '');
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : 'Other';
  return { browser, os, device: /Mobi|Android|iPhone/.test(ua) ? 'mobile' : 'desktop' };
}

function publicConfig(ctx: Ctx, inbox: Row): Row {
  const st = settingsOf(inbox);
  const mode = String(st.ai?.mode ?? 'off');
  return {
    ok: true, inbox_id: inbox.id, workspace_id: inbox.workspace_id, name: inbox.name, config_version: inbox.config_version, enforce_identity: !!inbox.enforce_identity, api_version: '1.0.0',
    settings: {
      appearance: st.appearance, launcher: st.launcher, popup: st.popup, messages: st.messages, pre_chat: st.pre_chat, features: st.features, csat: st.csat, targeting: st.targeting, locale: st.locale,
      security: { turnstile_enabled: false, turnstile_site_key: null, consent_mode: !!st.security?.consent_mode, attachments: st.security?.attachments },
      ai: { mode: inbox.ai_enabled && mode !== 'review' ? mode : 'off', show_sources: st.ai?.show_sources !== false,
        products: { enabled: st.ai?.products?.enabled === true && productSources(ctx.store, inbox.workspace_id, st).length > 0, show_prices: st.ai?.products?.show_prices !== false, add_to_cart: false, utm: st.ai?.products?.utm !== false } },
      continuity: { enabled: st.continuity?.enabled !== false },
      ask_buttons: (st.ask_buttons ?? []).filter((b: Row) => b.enabled !== false), selection_ask: st.selection_ask, shortcut: st.shortcut,
      // voice is the Voice tab's sample call in the demo: the preview widget never starts one
      voice: { enabled: false },
    },
    availability: availability(ctx, inbox),
    campaigns: ctx.store.t(T.campaigns).filter((c) => c.inbox_id === inbox.id && c.enabled !== false).map((c) => ({ id: c.id, title: c.title, message: c.message, sender_kind: c.sender_kind,
      sender_name: c.sender_kind === 'agent' && c.sender_user_id ? ctx.store.t('outreach_members').find((m) => m.user_id === c.sender_user_id)?.display_name ?? 'Agent' : st.appearance?.brand_name,
      quick_replies: c.quick_replies ?? [], rules: c.rules ?? {}, frequency: c.frequency, display: c.display })),
    blocked_countries: ctx.store.t(T.blocks).filter((b) => b.inbox_id === inbox.id && b.kind === 'country').map((b) => b.value),
  };
}

const parseVt = (t: string): { id: string; tv: number } | null => { const m = /^vt\.([0-9a-f-]{36})\.(\d+)$/.exec(String(t ?? '').replace(/^Bearer\s+/i, '')); return m ? { id: m[1], tv: Number(m[2]) } : null; };
const vtOf = (v: Row) => `vt.${v.id}.${v.token_version ?? 1}`;

function convsOf(ctx: Ctx, v: Row): Row[] {
  return ctx.store.t('outreach_chats').filter((c) => c.provider === 'WEBCHAT' && c.visitor_id === v.id)
    .sort((a, b) => String(b.last_message_at ?? b.created_at).localeCompare(String(a.last_message_at ?? a.created_at))).map((c) => conversationJson(ctx.store, c));
}

function own(ctx: Ctx, v: Row, chatId: string): Row {
  const c = ctx.store.get('outreach_chats', chatId);
  if (!c || c.provider !== 'WEBCHAT' || c.visitor_id !== v.id) throw new HttpErr(404, 'E_NOT_FOUND', 'conversation');
  return c;
}

async function hmacHex(secret: string, msg: string): Promise<string | null> {
  const subtle = (globalThis as unknown as { crypto?: Crypto }).crypto?.subtle;
  if (!subtle) return null;
  const enc = new TextEncoder();
  const key = await subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await subtle.sign('HMAC', key, enc.encode(msg)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain', 'text/csv', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);

/** POST /conversations/:id/messages (051 outreach_webchat_v_message, with 063 Review and 069 handoff words). */
function postMessage(ctx: Ctx, inbox: Row, v0: Row, chatId: string, b: Row): Row {
  const s = ctx.store, st = settingsOf(inbox);
  let c = own(ctx, v0, chatId);
  let v = v0;
  let ctype = String(b.content_type ?? 'text');
  let txt: string | null = String(b.text ?? '').slice(0, 5000);
  if (!['text', 'attachment', 'form_response'].includes(ctype)) throw new HttpErr(400, 'E_PAYLOAD_INVALID', 'content_type');
  const ups = (Array.isArray(b.attachments) ? b.attachments : []).map(String).slice(0, 5);
  const attachments = s.t(T.uploads).filter((u) => ups.includes(u.id) && u.visitor_id === v.id && !u.message_id).map((u) => ({ id: u.path, name: u.name, type: u.mime, size: u.size, storage: true }));
  if (ups.length && !attachments.length) throw new HttpErr(400, 'E_PAYLOAD_INVALID', 'attachments not found');
  if (attachments.length) ctype = 'attachment';
  if (ctype === 'text' && !txt.trim() && !attachments.length) throw new HttpErr(400, 'E_PAYLOAD_INVALID', 'text');
  if (b.echo_id) {
    const dup = s.t('outreach_messages').find((m) => m.chat_id === c.id && m.echo_id === String(b.echo_id));
    if (dup) return { message: messageJson(dup), conversation: conversationJson(s, c), ai: false, handoff: false, dropped: false, duplicate: true };
  }
  if (isBlocked(s, inbox, v)) {
    s.insert(T.events, { visitor_id: v.id, chat_id: c.id, name: 'message_dropped', props: { reason: 'blocked', len: txt.length }, at: iso() });
    return { message: { id: s.uid(), echo_id: b.echo_id ?? null, conversation_id: c.id, sender_type: 'visitor', content_type: ctype, text: txt, attachments: [], sent_at: iso(), content_attributes: {} }, conversation: conversationJson(s, c), ai: false, handoff: false, dropped: true };
  }
  let reopened = false, newconv = false;
  if (c.status === 'resolved') {
    if (st.features?.allow_after_resolved !== false) {
      c = s.update('outreach_chats', c.id, { status: 'open', resolved_at: null, resolved_by: null, unread: true, archived: false })[0];
      reopened = true;
      systemEvent(s, c, { kind: 'reopened' });
    } else {
      const r = startConversation(ctx, inbox, v, null, 'launcher', null);
      c = s.get('outreach_chats', r.conversation.id)!;
      newconv = true;
    }
  } else if (c.status === 'pending' || c.status === 'snoozed') {
    c = s.update('outreach_chats', c.id, { status: 'open', snoozed_until: null, unread: true })[0];
  }
  const given = b.content_attributes && typeof b.content_attributes === 'object' ? b.content_attributes : {};
  const attrs: Row = {};
  for (const k of ['form', 'values', 'message_id']) if (given[k] !== undefined) attrs[k] = given[k];
  const context = typeof b.context === 'string' && b.context.trim() ? b.context.trim().slice(0, 700) : null;
  const product = typeof b.product === 'string' && b.product.trim() ? b.product.trim().slice(0, 300) : null;
  if (context || product) attrs.internal = { ...(context ? { context } : {}), ...(product ? { product } : {}) };
  if (ctype === 'form_response' && attrs.form === 'email') {
    const em = String(attrs.values?.email ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) throw new HttpErr(400, 'E_PAYLOAD_INVALID', 'email');
    v = s.update(T.visitors, v.id, (x) => ({ email: x.email ?? em, email_invalid: false }))[0];
    linkLead(s, v);
    txt = null;
  }
  const m = addMessage(s, c, { direction: 'in', text: txt || null, content_type: ctype, content_attributes: attrs, sender_type: 'visitor', sender_name: v.name ?? 'Visitor', source: 'widget', echo_id: b.echo_id ? String(b.echo_id).slice(0, 64) : null, attachments });
  for (const a of attachments) s.update(T.uploads, (u) => u.path === a.id, { message_id: m.id, chat_id: c.id });
  s.update(T.visitors, v.id, { last_seen_at: iso() });
  s.update('outreach_chats', c.id, { visitor_last_seen_at: iso(), visitor_typing_at: null, visitor_typing_text: null });
  c = s.get('outreach_chats', c.id)!;
  const av = availability(ctx, inbox);
  let ai = false, ho = false;
  if (ctype === 'text' && !c.handed_off_at && !['off', 'review', null, undefined].includes(c.ai_mode) && inbox.ai_enabled) {
    ai = true;
    if (handoffMatch(st, txt ?? '')) ho = true;
    if (st.ai?.handoff?.leads_in_sequence !== false && c.lead_id && s.t('outreach_enrollments').some((e) => e.lead_id === c.lead_id && ['active', 'waiting_connection', 'waiting_delay', 'waiting_task', 'paused'].includes(e.status))) ho = true;
    if (!ho && s.t(T.turns).filter((t) => t.chat_id === c.id).length >= Number(st.ai?.handoff?.max_turns ?? 6)) ho = true;
    if (ho) { ai = false; handoff(ctx, c.id, 'visitor_request'); }
  }
  if (ctype === 'text' && (txt ?? '').trim() && !c.handed_off_at && c.ai_mode === 'review' && inbox.ai_enabled) writeSuggestion(ctx, inbox, c, m);
  if (!ai && st.features?.email_capture !== false && !av.online && !v.email && ctype !== 'form_response'
    && !s.t('outreach_messages').some((x) => x.chat_id === c.id && x.content_type === 'form' && x.content_attributes?.form === 'email')) {
    botLine(s, c, st.messages?.email_capture_prompt ?? null, 'form', { form: 'email', prompt: st.messages?.email_capture_prompt });
  }
  c = s.get('outreach_chats', c.id)!;
  if (!ai && !c.assigned_to && (c.handed_off_at || !c.ai_mode || c.ai_mode === 'off')) autoAssign(ctx, c.id);
  return { message: messageJson(m), conversation: conversationJson(s, s.get('outreach_chats', c.id)!), ai, handoff: ho, dropped: false, reopened, new_conversation: newconv };
}

/** Review mode (063): the assistant writes a suggestion for the agent; the visitor sees a live chat. */
function writeSuggestion(ctx: Ctx, inbox: Row, c: Row, m: Row): void {
  const s = ctx.store;
  s.update(T.suggestions, (g) => g.chat_id === c.id && (g.status === 'pending' || g.status === 'waiting'), { status: 'stale', resolved_at: iso() });
  const a = answerFor(s, inbox, String(m.text ?? ''), { context: m.content_attributes?.internal?.context, product: m.content_attributes?.internal?.product });
  s.insert(T.suggestions, { workspace_id: c.workspace_id, inbox_id: inbox.id, chat_id: c.id, message_id: m.id, text: a.answer, sources: a.sources, confidence: a.confidence, model: 'demo',
    status: 'waiting', attempts: 1, locked_at: null, error: null, used_message_id: null, resolved_by: null, away_at: null, products: a.cards, ready_at: iso(), resolved_at: null });
}

/** POST /chat: the answer as server-sent events (meta, token…, products, done), on a timer. */
function chatStream(ctx: Ctx, inbox: Row, v: Row, b: Row, realm: Realm): Response {
  const s = ctx.store;
  const c = own(ctx, v, String(b.conversation_id ?? ''));
  const q = s.get('outreach_messages', String(b.message_id ?? ''));
  const headers = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' };
  const enc = new realm.TextEncoder();
  const frame = (event: string, data: unknown) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const okNow = () => {
    const cc = s.get('outreach_chats', c.id);
    const agentAfter = q ? s.t('outreach_messages').some((x) => x.chat_id === c.id && x.direction === 'out' && x.sender_type === 'agent' && String(x.created_at) > String(q.created_at)) : true;
    return !!cc && !cc.handed_off_at && !agentAfter && !['off', 'review', null, undefined].includes(cc.ai_mode) && !!s.get(T.inboxes, inbox.id)?.ai_enabled;
  };
  if (!q || q.chat_id !== c.id || !okNow()) return new realm.Response(new realm.ReadableStream({ start(k) { k.enqueue(frame('skip', { reason: 'handled' })); k.close(); } }), { headers });
  const st = settingsOf(inbox);
  const started = Date.now();
  const internal = q.content_attributes?.internal ?? {};
  const a = answerFor(s, inbox, String(q.text ?? ''), { context: internal.context ?? (typeof b.context === 'string' ? b.context : null), product: internal.product ?? b.page?.product?.url ?? null });
  const pieces = a.answer.match(/\S+\s*/g) ?? [a.answer];
  const chunks: string[] = [];
  for (let i = 0; i < pieces.length; i += 3) chunks.push(pieces.slice(i, i + 3).join(''));
  const stream = new realm.ReadableStream({
    start(k) {
      let i = 0;
      k.enqueue(frame('meta', { sources: a.sources }));
      const tick = () => {
        try {
          if (i < chunks.length) { k.enqueue(frame('token', chunks[i++])); setTimeout(tick, 45 + (i % 4) * 15); return; }
          if (a.cards.length) k.enqueue(frame('products', { items: a.cards }));
          if (!okNow()) { k.enqueue(frame('cancelled', { reason: 'agent_replied' })); k.close(); return; }
          const recentLow = s.t(T.turns).filter((t) => t.chat_id === c.id).sort((x, y) => String(y.created_at).localeCompare(String(x.created_at))).slice(0, Number(st.ai?.handoff?.low_confidence_streak ?? 2)).filter((t) => t.confidence === 'low' || t.confidence === 'refused').length;
          const doHandoff = recentLow + (a.confidence !== 'high' ? 1 : 0) >= Number(st.ai?.handoff?.low_confidence_streak ?? 2);
          const turnId = s.uid();
          const msg = botLine(s, c, a.answer, 'text', { ai: true, sources: a.sources, confidence: a.confidence, turn_id: turnId, ...(a.cards.length ? { products: a.cards } : {}) });
          s.insert(T.turns, { id: turnId, workspace_id: c.workspace_id, inbox_id: inbox.id, chat_id: c.id, visitor_id: v.id, question_message_id: q.id, answer_message_id: msg.id, query: String(q.text ?? '').slice(0, 2000),
            answer: a.answer, sources: a.sources, confidence: a.confidence, handoff: doHandoff ? 'low_confidence' : null, page_url: siteUrl(inbox, b.page?.url), tokens_in: null, tokens_out: null,
            latency_ms: Date.now() - started, feedback: null, feedback_text: null, model: 'demo', products: a.cards.map((x) => x.id), context: internal.context ?? null, product_id: a.product_id,
            product_search: a.product_search, voice_call_id: null });
          s.update('outreach_chats', c.id, (x) => ({ ai_handled: x.handed_off_at ? x.ai_handled : true, ai_replies_count: (x.ai_replies_count ?? 0) + 1 }));
          const ho = doHandoff ? handoff(ctx, c.id, 'low_confidence') : null;
          k.enqueue(frame('done', { message: messageJson(s.get('outreach_messages', msg.id)!), turn_id: turnId, confidence: a.confidence, handoff: !!(ho && !ho.already) }));
          k.close();
        } catch (e) {
          try { k.enqueue(frame('error', { message: 'assistant_unavailable' })); k.close(); } catch { /* closed */ }
          console.error('[demo] website agent', e);
        }
      };
      setTimeout(tick, 380);
    },
  });
  return new realm.Response(stream, { headers });
}

async function route(ctx: Ctx, method: string, url: URL, init: Row, realm: Realm): Promise<Row | Response> {
  const s = ctx.store;
  const path = url.pathname.replace(/^.*\/outreach-webchat/, '').replace(/\/+$/, '') || '/';
  const token = url.searchParams.get('token') ?? headerOf(init, 'x-website-token');
  const inbox = s.t(T.inboxes).find((i) => i.website_token === token && !i.deleted_at);
  if (!inbox) throw new HttpErr(404, 'E_NOT_FOUND', 'unknown website token');
  const st = settingsOf(inbox);
  if (method === 'GET' && path === '/config') {
    if (!inbox.is_active) return { ok: false, error: 'inactive' };
    const origin = `https://${(inbox.allowed_domains ?? []).find((x: string) => x && !x.startsWith('*.') && x !== 'localhost') ?? 'www.example.com'}`;
    const seen = inbox.installed_origins?.[origin];
    if (!seen || Date.parse(seen) < Date.now() - 60_000) s.update(T.inboxes, inbox.id, (i) => ({ installed_origins: { ...(i.installed_origins ?? {}), [origin]: iso() } }));
    return publicConfig(ctx, s.get(T.inboxes, inbox.id)!);
  }
  if (!inbox.is_active) throw new HttpErr(403, 'E_INACTIVE', 'widget is off');
  const b = bodyOf(init);
  if (method === 'POST' && path === '/visitor') {
    const prior = parseVt(b.visitor_token);
    let v = prior ? s.t(T.visitors).find((x) => x.id === prior.id && x.inbox_id === inbox.id && (x.token_version ?? 1) === prior.tv) : undefined;
    if (v?.merged_into) v = s.get(T.visitors, v.merged_into);
    const ua = uaParts(realm);
    const landing = siteUrl(inbox, b.landing_url ?? b.page?.url);
    if (!v) {
      v = s.insert(T.visitors, { workspace_id: inbox.workspace_id, inbox_id: inbox.id, identifier: null, identity_verified: false, name: null, email: null, email_verified: false, email_invalid: false, phone: null,
        avatar_url: null, company: null, lead_id: null, custom_attributes: {}, consent: null, ip_hash: randHex(s, 16), country: 'US', city: 'Brooklyn', timezone: String(b.timezone ?? '').slice(0, 60) || null,
        browser: ua.browser, os: ua.os, device: ua.device, locale: String(b.locale ?? '').slice(0, 10) || null, referrer: b.referrer || null, landing_url: landing, utm: b.utm ?? null,
        current_url: landing, current_title: b.page?.title ?? null, current_at: iso(), token_version: 1, first_seen_at: iso(), last_seen_at: iso(), blocked_at: null, merged_into: null, voice_consent_at: null })[0];
    } else {
      v = s.update(T.visitors, v.id, { last_seen_at: iso(), browser: ua.browser, os: ua.os, device: ua.device })[0];
    }
    if (b.page?.url) {
      s.insert(T.pageViews, { visitor_id: v.id, url: siteUrl(inbox, b.page.url), title: b.page.title ?? null, referrer: b.referrer ?? null, utm: b.utm ?? null, at: iso() });
      s.update(T.visitors, v.id, { current_url: siteUrl(inbox, b.page.url), current_title: b.page.title ?? null, current_at: iso() });
    }
    return { visitor_token: vtOf(v), visitor: visitorJson(v), conversations: convsOf(ctx, v), blocked: isBlocked(s, inbox, v) };
  }
  const vt = parseVt(headerOf(init, 'authorization'));
  const v = vt ? s.t(T.visitors).find((x) => x.id === vt.id && x.inbox_id === inbox.id && (x.token_version ?? 1) === vt.tv) : undefined;
  if (!v) throw new HttpErr(401, 'E_VISITOR_TOKEN', 'visitor token missing or invalid');

  if (method === 'POST' && path === '/visitor/identify') {
    const identifier = b.identifier == null ? null : String(b.identifier).slice(0, 200);
    let verified = false;
    if (identifier && b.identifier_hash) {
      const want = await hmacHex(String(inbox.hmac_token ?? ''), identifier);
      verified = !!want && String(b.identifier_hash).toLowerCase() === want;
      if (!verified) throw new HttpErr(401, 'E_IDENTITY_INVALID', 'identifier_hash does not match');
    }
    if (inbox.enforce_identity && identifier && !verified) throw new HttpErr(401, 'E_IDENTITY_INVALID', 'identity validation is enforced: identifier_hash required');
    const em = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(b.email ?? '').trim()) ? String(b.email).trim().toLowerCase() : null;
    let target = v;
    if (verified && identifier) {
      const ex = s.t(T.visitors).find((x) => x.inbox_id === inbox.id && x.identifier === identifier && !x.merged_into && x.id !== v.id);
      if (ex) {
        s.update('outreach_chats', (c) => c.visitor_id === v.id, { visitor_id: ex.id });
        s.update(T.visitors, v.id, (x) => ({ merged_into: ex.id, token_version: (x.token_version ?? 1) + 1 }));
        target = ex;
      }
    }
    target = s.update(T.visitors, target.id, (x) => ({
      ...(verified ? { identifier, identity_verified: true, email_verified: em ? true : x.email_verified } : { custom_attributes: { ...(x.custom_attributes ?? {}), ...(b.custom_attributes ?? {}), ...(identifier ? { claimed_identifier: identifier } : {}) } }),
      name: b.name || x.name, email: em ?? x.email, phone: b.phone || b.phone_number || x.phone, company: b.company || b.company_name || x.company, last_seen_at: iso(),
      ...(verified ? { custom_attributes: { ...(x.custom_attributes ?? {}), ...(b.custom_attributes ?? {}) } } : {}),
    }))[0];
    linkLead(s, target);
    s.insert(T.events, { visitor_id: target.id, chat_id: null, name: 'identified', props: { verified, ...(verified ? { identifier } : {}) }, at: iso() });
    target = s.get(T.visitors, target.id)!;
    return { visitor: visitorJson(target), verified, conversations: convsOf(ctx, target), ...(target.id !== v.id ? { visitor_token: vtOf(target) } : {}) };
  }
  if (method === 'PATCH' && path === '/visitor/attributes') {
    s.update(T.visitors, v.id, (x) => { const ca = { ...(x.custom_attributes ?? {}), ...(b.custom_attributes ?? {}) }; for (const k of b.delete ?? []) delete ca[k]; return { custom_attributes: ca }; });
    if (b.conversation_id) {
      const c = own(ctx, v, String(b.conversation_id));
      s.update('outreach_chats', c.id, (x) => {
        const ca = { ...(x.custom_attributes ?? {}), ...(b.conversation_custom_attributes ?? {}) }; for (const k of b.conversation_delete ?? []) delete ca[k];
        let labels: string[] = [...new Set([...(x.labels ?? []), ...(b.add_labels ?? [])])]; if (b.remove_labels) labels = labels.filter((l) => !b.remove_labels.includes(l));
        return { custom_attributes: ca, labels: labels.slice(0, 50) };
      });
    }
    return { ok: true };
  }
  if (method === 'POST' && path === '/visitor/reset') { s.update(T.visitors, v.id, (x) => ({ token_version: (x.token_version ?? 1) + 1 })); return { ok: true }; }
  if (method === 'POST' && path === '/page-view') {
    const views: Row[] = Array.isArray(b.views) ? b.views.slice(0, 50) : [];
    for (const pv of views) if (pv?.url) s.insert(T.pageViews, { visitor_id: v.id, url: siteUrl(inbox, pv.url), title: pv.title ?? null, referrer: pv.referrer ?? null, utm: pv.utm ?? null, at: pv.at ?? iso() });
    const last = views[views.length - 1];
    if (last?.url) s.update(T.visitors, v.id, { current_url: siteUrl(inbox, last.url), current_title: last.title ?? null, current_at: iso(), last_seen_at: iso() });
    return { ok: true };
  }
  if (method === 'POST' && path === '/events') {
    if (b.name) s.insert(T.events, { visitor_id: v.id, chat_id: b.conversation_id ?? null, name: String(b.name).slice(0, 100), props: b.props ?? {}, at: iso() });
    return { ok: true };
  }
  if (method === 'POST' && path === '/feedback') {
    s.update(T.turns, (t) => t.id === b.turn_id && t.visitor_id === v.id, { feedback: Number(b.value) >= 0 ? 1 : -1, feedback_text: b.text ? String(b.text).slice(0, 1000) : null });
    return { ok: true };
  }
  const camp = /^\/campaigns\/([0-9a-f-]{36})\/hit$/.exec(path);
  if (method === 'POST' && camp) {
    const kind = ['shown', 'clicked', 'started'].includes(b.kind) ? b.kind : 'shown';
    s.update(T.campaigns, (c) => c.id === camp[1] && c.inbox_id === inbox.id, (c) => ({ [kind]: (c[kind] ?? 0) + 1 }));
    s.insert(T.events, { visitor_id: v.id, chat_id: null, name: `campaign_${kind}`, props: { campaign_id: camp[1] }, at: iso() });
    return { ok: true };
  }
  if (method === 'GET' && path === '/conversations') return { conversations: convsOf(ctx, v) };
  if (method === 'POST' && path === '/conversations') {
    const source = ['launcher', 'popup', 'campaign', 'sdk', 'standalone', 'email', 'button', 'ask', 'input', 'link', 'header_button', 'element_button', 'selection', 'voice'].includes(b.source) ? b.source : 'launcher';
    const page = b.page ? { ...b.page, url: siteUrl(inbox, b.page.url) } : null;
    return startConversation(ctx, inbox, v, b.form ?? null, source, page);
  }
  const conv = /^\/conversations\/([0-9a-f-]{36})(?:\/([a-z]+(?:\/[a-z]+)?))?$/.exec(path);
  if (conv) {
    const chatId = conv[1], action = conv[2] ?? '';
    if (method === 'GET' && !action) return { conversation: conversationJson(s, own(ctx, v, chatId)) };
    if (method === 'GET' && action === 'messages') {
      const c = own(ctx, v, chatId);
      const lim = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') ?? 50) || 50));
      const after = url.searchParams.get('after'), before = url.searchParams.get('before');
      let rows = s.t('outreach_messages').filter((m) => m.chat_id === c.id);
      if (after) rows = rows.filter((m) => Date.parse(m.created_at) > Date.parse(after)).sort((x, y) => String(x.created_at).localeCompare(String(y.created_at))).slice(0, lim);
      else rows = rows.filter((m) => !before || Date.parse(m.sent_at) < Date.parse(before)).sort((x, y) => String(y.sent_at).localeCompare(String(x.sent_at))).slice(0, lim);
      return { messages: rows.sort((x, y) => String(x.sent_at).localeCompare(String(y.sent_at))).map(messageJson) };
    }
    if (method === 'POST' && action === 'messages') return postMessage(ctx, inbox, v, chatId, b);
    if (method === 'POST' && action === 'typing') { const c = own(ctx, v, chatId); s.update('outreach_chats', c.id, { visitor_typing_at: b.on ? iso() : null, visitor_typing_text: b.on ? String(b.preview ?? '').slice(0, 300) : null, visitor_last_seen_at: iso() }, { silent: true }); return { ok: true }; }
    if (method === 'POST' && action === 'read') { const c = own(ctx, v, chatId); s.update('outreach_messages', (m) => m.chat_id === c.id && m.direction === 'out' && !m.read_by_visitor_at, { read_by_visitor_at: iso() }); return { ok: true }; }
    if (method === 'POST' && action === 'heartbeat') { const c = own(ctx, v, chatId); s.update('outreach_chats', c.id, { visitor_last_seen_at: iso() }, { silent: true }); return { agent_typing: !!c.agent_typing_at && Date.parse(c.agent_typing_at) > Date.now() - 8000, status: c.status }; }
    if (method === 'POST' && action === 'resolve') {
      let c = own(ctx, v, chatId);
      if (st.features?.end_conversation === false) throw new HttpErr(403, 'E_FORBIDDEN', 'end_conversation disabled');
      if (c.status !== 'resolved') { c = s.update('outreach_chats', c.id, { status: 'resolved', resolved_at: iso(), resolved_by: 'visitor', unread: false })[0]; systemEvent(s, c, { kind: 'resolved', by: 'visitor' }); postCsat(s, c.id); }
      return { conversation: conversationJson(s, s.get('outreach_chats', c.id)!) };
    }
    if (method === 'POST' && action === 'csat') {
      const c = own(ctx, v, chatId), rating = Number(b.rating);
      if (!(rating >= 1 && rating <= 5)) throw new HttpErr(400, 'E_PAYLOAD_INVALID', 'rating');
      s.update('outreach_chats', c.id, (x) => ({ csat: { rating, comment: b.comment ? String(b.comment).slice(0, 1000) : null, at: x.csat?.at ?? iso(), updated_at: iso(), assigned_to: x.assigned_to ?? null } }));
      s.update('outreach_messages', (m) => m.chat_id === c.id && m.content_type === 'csat', (m) => ({ content_attributes: { ...(m.content_attributes ?? {}), response: { rating, comment: b.comment ?? null } } }));
      s.insert(T.events, { visitor_id: v.id, chat_id: c.id, name: 'csat', props: { rating }, at: iso() });
      return { conversation: conversationJson(s, s.get('outreach_chats', c.id)!) };
    }
    if (method === 'GET' && action === 'transcript') {
      if (st.features?.transcript === false) throw new HttpErr(403, 'E_FORBIDDEN', 'transcripts are off');
      const c = own(ctx, v, chatId);
      return { messages: s.t('outreach_messages').filter((m) => m.chat_id === c.id).sort((x, y) => String(x.sent_at).localeCompare(String(y.sent_at))).map(messageJson) };
    }
    if (method === 'POST' && action === 'transcript') {
      const c = own(ctx, v, chatId);
      const em = String(b.email ?? '').trim().toLowerCase();
      if (em && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) throw new HttpErr(400, 'E_PAYLOAD_INVALID', 'email');
      if (em && !v.email) s.update(T.visitors, v.id, { email: em, email_invalid: false });
      ctx.ui.simulated('Transcript email simulated. Nothing was sent.');
      void c;
      return { ok: true };
    }
    if (method === 'POST' && action.startsWith('voice/')) return action === 'voice/start' ? { ok: false, reason: 'off' } : { ok: true };
  }
  if (method === 'POST' && path === '/uploads') {
    if (st.features?.file_picker === false) throw new HttpErr(403, 'E_FORBIDDEN', 'file uploads are off');
    const name = String(b.name ?? 'file').replace(/[^\w.-]+/g, '_').slice(0, 120), mime = String(b.type ?? 'application/octet-stream').toLowerCase(), size = Number(b.size ?? 0);
    const maxBytes = Math.min(Number(st.security?.attachments?.max_mb ?? 10), 10) * 1048576;
    if (!size || size > maxBytes) throw new HttpErr(413, 'E_TOO_LARGE', `max ${Math.round(maxBytes / 1048576)} MB`);
    if (/\.(exe|msi|bat|cmd|com|scr|ps1|sh|js|jar|vbs|dll|apk|dmg|pkg|deb|rpm|html?|svg)$/i.test(name) || !(ALLOWED_MIME.has(mime) || (st.security?.attachments?.allow_zip && mime === 'application/zip'))) throw new HttpErr(415, 'E_TYPE_BLOCKED', 'this file type is not allowed');
    const c = own(ctx, v, String(b.conversation_id ?? ''));
    const path_ = `${inbox.workspace_id}/${c.id}/${s.uid()}-${name}`;
    const up = s.insert(T.uploads, { inbox_id: inbox.id, visitor_id: v.id, chat_id: c.id, path: path_, name, mime, size, message_id: null })[0];
    return { upload_id: up.id, url: `demo-upload:${encodeURIComponent(path_)}`, path: path_ };
  }
  const att = /^\/attachments\/([0-9a-f-]{36})\/(.+)$/.exec(path);
  if (method === 'GET' && att) {
    own(ctx, v, att[1]);
    const r = await demoStorage().from('outreach-webchat').createSignedUrl(decodeURIComponent(att[2]));
    if (!r.data) throw new HttpErr(404, 'E_NOT_FOUND', 'attachment');
    return { url: r.data.signedUrl };
  }
  if (method === 'POST' && path === '/chat') return chatStream(ctx, inbox, v, b, realm);
  throw new HttpErr(404, 'E_NOT_FOUND', `no route ${method} ${path}`);
}

/** The iframe's `fetch`: the widget's routes, the upload PUT, and a refusal for anything else. */
export async function handleRequest(input: unknown, init: Row = {}, realm: Realm): Promise<Response> {
  const R = realm.Response;
  const json = (status: number, body: unknown) => new R(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const raw = String((input as { url?: string })?.url ?? input ?? '');
  const ctx = bound;
  if (!ctx) return json(503, { error: 'the demo is still loading', code: 'E_DEMO_NOT_READY' });
  await new Promise((r) => setTimeout(r, 60));
  try {
    if (raw.startsWith('demo-upload:')) {
      const p = decodeURIComponent(raw.slice('demo-upload:'.length));
      const body = init.body as Blob | undefined;
      if (body) await demoStorage().from('outreach-webchat').upload(p, body, { contentType: (body as Blob).type || undefined, upsert: true });
      return json(200, { Key: p });
    }
    if (!raw.startsWith(DEMO_API)) {
      console.warn('[demo] the preview widget asked for', raw, '- refused, nothing left the browser');
      return json(403, { error: 'E_DEMO_BLOCKED', code: 'E_DEMO_BLOCKED' });
    }
    const out = await route(ctx, String(init.method ?? 'GET').toUpperCase(), new URL(raw), init, realm);
    if (out instanceof (realm.Response as unknown as typeof Response) || out instanceof Response) return out as Response;
    return json(200, out);
  } catch (e) {
    if (e instanceof HttpErr) return json(e.status, { error: e.message, code: e.code });
    const msg = (e as Error)?.message ?? String(e);
    const m = /^(E_[A-Z_]+)(?::\s*(.*))?$/s.exec(msg);
    if (!m) console.error('[demo] website widget', e);
    return json(m ? 400 : 500, { error: m ? m[2] || m[1] : 'internal error', code: m ? m[1] : 'E_INTERNAL' });
  }
}

// ---------------------------------------------------------------------------- the sample page the preview loads
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const priceText = (p: Row) => (p.price == null ? '' : `${p.currency && p.currency !== 'USD' ? `${p.currency} ` : '$'}${Number(p.price).toFixed(Number(p.price) % 1 ? 2 : 0)}`);

/** The HTML of the preview iframe for a website: a fictional page of the brand, the bridge, then the real widget. */
export function previewPage(inboxId: string): string | null {
  const ctx = bound;
  if (!ctx) return null;
  const inbox = ctx.store.get(T.inboxes, inboxId);
  if (!inbox || inbox.deleted_at) return null;
  const st = settingsOf(inbox);
  const brand = String(st.appearance?.brand_name || inbox.name || 'Example');
  const accent = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(st.appearance?.accent)) ? st.appearance.accent : '#4f46e5';
  const products = catalogueProducts(ctx.store, inbox).slice(0, 4).map((p) => productCard(ctx.store, p));
  const faqs = faqsFor(ctx.store, inbox).slice(0, 3);
  const position = st.launcher?.desktop?.position === 'left' ? 'left' : 'right';
  const cards = products.length
    ? products.map((p) => `<article class="product-card" data-product-url="${esc(p.url)}">${p.image ? `<img src="${esc(p.image)}" alt="">` : `<div class="ph" aria-hidden="true">${esc(String(p.title).slice(0, 1))}</div>`}<h3>${esc(p.title)}</h3><p class="price">${esc(priceText(p))}</p></article>`).join('')
    : ['Answers in seconds', 'Hands over to your team', 'Learns from your Q&amp;A'].map((t, i) => `<article class="product-card"><div class="ph" aria-hidden="true">${i + 1}</div><h3>${t}</h3></article>`).join('');
  const asks = (faqs.length ? faqs.map((f) => f.question) : ['What do you offer?', 'How do I get started?', 'Can I talk to someone?'])
    .map((q) => `<li><a href="#" data-growthxai-ask="${esc(q)}">${esc(q)}</a></li>`).join('');
  // runs first, before the widget: the bridge, and every way out of the page switched off
  const boot = `(function(){var B=parent.__growthxaiDemoWidget,W=window;
W.fetch=function(u,i){return B.request(u,i||{},W)};
var no=function(){throw new Error('E_DEMO_BLOCKED: no network in the product tour')};
try{W.WebSocket=no;W.XMLHttpRequest=no;W.EventSource=no}catch(e){}
try{Object.defineProperty(navigator,'sendBeacon',{value:function(){return true},configurable:true})}catch(e){}
W.open=function(){B.notice('The pop-out chat is not part of the product tour.');return null};
var P='gxdemo:wc:',S=W.sessionStorage,L={getItem:function(k){try{return S.getItem(P+k)}catch(e){return null}},setItem:function(k,v){try{S.setItem(P+k,String(v))}catch(e){}},removeItem:function(k){try{S.removeItem(P+k)}catch(e){}},clear:function(){},key:function(){return null},length:0};
try{Object.defineProperty(W,'localStorage',{value:L,configurable:true})}catch(e){}
W.growthxaiSettings={position:${JSON.stringify(position)}};
})();`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(brand)}</title>
<script>${boot}</script>
<style>
*{box-sizing:border-box}body{margin:0;font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1f2937;background:#f8fafc}
header{position:sticky;top:0;background:#fff;border-bottom:1px solid #e5e7eb;z-index:1}header nav{display:flex;align-items:center;gap:18px;max-width:880px;margin:0 auto;padding:12px 20px}
header b{font-size:17px;margin-right:auto;color:#111827}header a{color:#4b5563;text-decoration:none;font-size:14px}
main{max-width:880px;margin:0 auto;padding:28px 20px 140px}.hero{background:${accent};color:#fff;border-radius:16px;padding:28px}.hero h1{margin:0 0 6px;font-size:26px}
.hero button{margin-top:12px;border:0;border-radius:999px;padding:9px 16px;font-weight:600;background:#fff;color:#111827;cursor:pointer}
h2{font-size:18px;margin:28px 0 10px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px}
.product-card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:12px}.product-card img,.product-card .ph{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:8px;background:#eef2ff;display:flex;align-items:center;justify-content:center;font-weight:700;color:${accent};font-size:28px}
.product-card h3{font-size:14px;margin:8px 0 2px}.price{margin:0;color:#6b7280;font-size:13px}ul{padding-left:18px}li a{color:${accent}}
.note{margin-top:28px;font-size:12px;color:#6b7280;border-top:1px solid #e5e7eb;padding-top:10px}
</style></head><body>
<header><nav><b>${esc(brand)}</b><a href="#">Home</a><a href="#">Products</a><a href="#">Pricing</a><a href="#">Contact</a></nav></header>
<main>
<section class="hero"><h1>Welcome to ${esc(brand)}</h1><div>${esc(st.appearance?.welcome_tagline ?? 'Ask us anything.')}</div><button type="button" data-growthxai="open">Chat with us <span data-growthxai-unread></span></button></section>
<h2>${products.length ? 'Popular right now' : 'What we do'}</h2><div class="grid">${cards}</div>
<h2>Questions people ask</h2><ul>${asks}</ul>
<article><h2>About us</h2><p>${esc(brand)} is a fictional company for the product tour. Select any text on this page to try Ask AI on a selection, or use the launcher in the corner.</p></article>
<p class="note">Product tour: a sample page. The assistant answers from your Q&amp;A, knowledge and catalogue on this device (sample AI output). Nothing is sent anywhere.</p>
</main>
<script async src="/widget/v1/loader.js" data-website-token="${esc(inbox.website_token)}" data-api="${DEMO_API}"></script>
</body></html>`;
}

/** `window.__growthxaiDemoWidget`: what the preview iframe (and WidgetPreview in demo mode) uses. Browser only. */
export function installWidgetBridge(): void {
  const w = globalThis as unknown as { window?: unknown; __growthxaiDemoWidget?: unknown };
  if (typeof w.window === 'undefined') return;
  w.__growthxaiDemoWidget = {
    page: (inboxId: string) => previewPage(inboxId),
    request: (input: unknown, init: Row, realm: Realm) => handleRequest(input, init, realm),
    notice: (text: string) => bound?.ui.toast(text),
  };
}
