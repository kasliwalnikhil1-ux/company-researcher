/**
 * Voice for the website agent in the demo (069): fictional voices, the minutes pool, the Voice tab's state, the
 * call list and the report block, and THE SAMPLE CALL: no microphone, no voice provider. The Voice tab's test panel
 * loads its voice SDK through `window.__growthxaiWebchatVoice` (lib/outreach/voice.ts loadVoiceModule); the demo puts a
 * stand-in there at boot that plays a scripted call (built from the website's own Q&A and products) with its
 * transcript, spoken by the browser's local speech voices when there are any. Call recordings are a small WAV made here.
 */
import type { Ctx } from '../ctx';
import { websiteAnswer } from '../ai';
import type { DemoStore, Row } from '../store';
import { T, VOICE_LANGUAGE_CODES, settingsOf } from './core';
import { catalogueProducts, faqsFor } from './answer';

// ---------------------------------------------------------------------------- voices (fictional; no provider)
type VoiceOut = { voice_id: string; name: string; description: string | null; preview_url: string | null; category: string | null; gender: string | null; accent: string | null; age: string | null; use_case: string | null; language: string | null; languages: string[]; public_owner_id?: string | null; source: 'account' | 'library' };
const v = (voice_id: string, name: string, description: string, gender: string, accent: string, age: string, languages: string[], category = 'premade'): VoiceOut =>
  ({ voice_id, name, description, preview_url: null, category, gender, accent, age, use_case: 'conversational', language: languages[0], languages, source: 'account' });
export const ACCOUNT_VOICES: VoiceOut[] = [
  v('demoVoiceAria01', 'Aria', 'Warm and friendly, made for conversations', 'female', 'American', 'young', ['en', 'es']),
  v('demoVoiceTheo02', 'Theo', 'Calm, clear and reassuring', 'male', 'British', 'middle aged', ['en']),
  v('demoVoiceMira03', 'Mira', 'Bright and upbeat', 'female', 'Indian', 'young', ['en', 'hi']),
  v('demoVoiceJonas04', 'Jonas', 'Relaxed and natural', 'male', 'German', 'middle aged', ['de', 'en']),
  v('demoVoiceLuz05', 'Luz', 'Energetic and expressive', 'female', 'Mexican', 'young', ['es', 'en']),
  v('demoVoiceCamille06', 'Camille', 'Soft and polished', 'female', 'French', 'middle aged', ['fr', 'en']),
  v('demoVoiceOwen07', 'Owen', 'Friendly support voice', 'male', 'Australian', 'young', ['en']),
  v('demoVoiceNadia08', 'Nadia', 'Confident and professional', 'female', 'Arabic', 'middle aged', ['ar', 'en']),
];
export const LIBRARY_VOICES: VoiceOut[] = [
  ['demoLibIvy0001', 'Ivy', 'Gentle storyteller', 'female', 'Irish', 'young', ['en']],
  ['demoLibRavi0002', 'Ravi', 'Clear, patient explainer', 'male', 'Indian', 'middle aged', ['en', 'hi', 'ta']],
  ['demoLibSofia0003', 'Sofia', 'Warm sales voice', 'female', 'Spanish', 'young', ['es']],
  ['demoLibKenji0004', 'Kenji', 'Crisp and friendly', 'male', 'Japanese', 'young', ['ja', 'en']],
  ['demoLibElla0005', 'Ella', 'Cheerful helper', 'female', 'Canadian', 'young', ['en', 'fr']],
  ['demoLibMarco0006', 'Marco', 'Smooth and steady', 'male', 'Italian', 'middle aged', ['it', 'en']],
  ['demoLibAnouk0007', 'Anouk', 'Bright and efficient', 'female', 'Dutch', 'young', ['nl', 'en']],
  ['demoLibSam00008', 'Sam', 'Neutral, easy to follow', 'neutral', 'American', 'middle aged', ['en']],
].map(([id, name, d, g, a, age, l]) => ({ ...v(id as string, name as string, d as string, g as string, a as string, age as string, l as string[], 'professional'), source: 'library' as const, public_owner_id: 'demoOwner000001' }));

export function listVoices(store: DemoStore, ws: string, q: URLSearchParams, library: boolean): Row {
  const lang = (q.get('language') ?? '').toLowerCase().slice(0, 3), search = (q.get('search') ?? '').trim().toLowerCase();
  const gender = q.get('gender') ?? '', accent = (q.get('accent') ?? '').toLowerCase();
  const added = store.meta<VoiceOut[]>('webchat:voicesAdded', () => []);
  let list = library ? LIBRARY_VOICES : q.get('tab') === 'mine' ? added : ACCOUNT_VOICES;
  if (lang) list = list.filter((x) => x.languages.includes(lang));
  if (gender) list = list.filter((x) => x.gender === gender);
  if (accent) list = list.filter((x) => String(x.accent ?? '').toLowerCase().includes(accent));
  if (search) list = list.filter((x) => `${x.name} ${x.description} ${x.accent} ${x.gender}`.toLowerCase().includes(search));
  void ws;
  return library ? { voices: list, has_more: false, own_account: false } : { voices: list, own_account: false };
}

// ---------------------------------------------------------------------------- limits and the minutes pool
/** outreach__voice_limits while billing is not enforced (the flag voice_default_limits), by plan otherwise. */
export function voiceLimits(store: DemoStore, ws: string): Row {
  const plan = String(store.get('outreach_workspaces', ws)?.plan ?? 'scale');
  if (plan === 'enterprise') return { included: 300, max_minutes: 30, concurrency: 10, own_key: true };
  if (plan === 'launch') return { included: 0, max_minutes: 5, concurrency: 2, own_key: false };
  return { included: 100, max_minutes: 10, concurrency: 5, own_key: true };
}

const callMinutes = (c: Row) => {
  const end = c.ended_at ? Date.parse(c.ended_at) : Math.min(Date.now(), Date.parse(c.started_at) + (c.max_minutes ?? 5) * 60_000);
  const secs = c.duration_s != null ? Number(c.duration_s) : Math.max(0, (end - Date.parse(c.started_at)) / 1000);
  return Math.ceil(Math.max(0, secs) / 60);
};

/** outreach__voice_pool: whole minutes this month, test calls included. */
export function voicePool(store: DemoStore, ws: string): Row {
  const lim = voiceLimits(store, ws);
  const month = new Date(); month.setUTCDate(1); month.setUTCHours(0, 0, 0, 0);
  let used = 0, tests = 0;
  for (const c of store.t(T.voiceCalls)) {
    if (c.workspace_id !== ws || c.account !== 'platform' || Date.parse(c.started_at) < month.getTime()) continue;
    if (c.status === 'failed' && c.duration_s == null) continue;
    const m = callMinutes(c); used += m; if (c.test) tests += m;
  }
  const total = Number(lim.included ?? 0);
  return { month: new Date().toISOString().slice(0, 7), used, test_used: tests, limit: total, included: lim.included, extra: 0, own_key: false, ok: used < total };
}

const voiceLanguages = (st: Row): string[] => {
  const vs = st.voice ?? {};
  const loc = String(st.locale?.default ?? 'en').slice(0, 2).toLowerCase();
  const main = VOICE_LANGUAGE_CODES.includes(String(vs.language)) ? String(vs.language) : VOICE_LANGUAGE_CODES.includes(loc) ? loc : 'en';
  return [main, ...((Array.isArray(vs.languages) ? vs.languages : []) as string[]).filter((l) => l !== main && VOICE_LANGUAGE_CODES.includes(l))];
};

/** outreach_hub_voice_state. */
export function voiceState(ctx: Ctx, inbox: Row): Row {
  const s = ctx.store, st = settingsOf(inbox);
  const agents: Row = {};
  for (const a of s.t(T.voiceAgents).filter((x) => x.inbox_id === inbox.id)) {
    agents[a.which] = { exists: !!a.el_agent_id, account: a.account ?? 'platform', synced_at: a.synced_at ?? null, sync_error: a.sync_error ?? null, sync_attempts: a.sync_attempts ?? 0, archived: !!a.archived, draft_at: a.draft_at ?? null };
  }
  const test = s.t(T.voiceAgents).find((x) => x.inbox_id === inbox.id && x.which === 'test');
  const qa = faqsFor(s, inbox).length;
  const ids = new Set((st.ai?.knowledge_source_ids ?? []).map(String));
  const src = s.t('outreach_knowledge_sources').filter((x) => x.workspace_id === inbox.workspace_id && x.kind !== 'catalogue' && x.status === 'ready' && ids.has(String(x.id))).length;
  const mode = inbox.ai_enabled ? String(st.ai?.mode ?? 'off') : 'off';
  return {
    inbox_id: inbox.id, account: 'platform', pool: voicePool(s, inbox.workspace_id), limits: voiceLimits(s, inbox.workspace_id), languages: voiceLanguages(st), agents,
    draft: test?.draft ?? null,
    requires: { assistant_auto: !!inbox.ai_enabled && ['first', 'offline_only'].includes(String(st.ai?.mode)), assistant_mode: mode, knowledge: src > 0 || qa >= 5, sources: src, qa_pairs: qa, active: inbox.is_active !== false },
  };
}

/** A call's conversation: its own chat_id, or the website chat whose thread carries the call's card (the inbox seed's). */
export function chatOfCall(store: DemoStore, call: Row): string | null {
  if (call.chat_id) return call.chat_id;
  const card = store.t('outreach_messages').find((m) => m.content_type === 'event' && m.content_attributes?.kind === 'voice_call' && m.content_attributes?.call_id === call.id);
  return card?.chat_id ?? null;
}

export function callJson(store: DemoStore, call: Row): Row {
  const inbox = store.get(T.inboxes, call.inbox_id);
  const chatId = chatOfCall(store, call);
  const chat = chatId ? store.get('outreach_chats', chatId) : undefined;
  const visitor = store.get(T.visitors, call.visitor_id ?? chat?.visitor_id);
  return {
    id: call.id, inbox_id: call.inbox_id, website: inbox?.name ?? '', chat_id: chatId, visitor_id: visitor?.id ?? call.visitor_id ?? null, visitor_name: visitor?.name ?? chat?.attendee_name ?? null,
    test: !!call.test, status: call.status, started_at: call.started_at, ended_at: call.ended_at ?? null, ended_reason: call.ended_reason ?? null, handoff_reason: call.handoff_reason ?? null,
    duration_s: call.duration_s ?? null, language: call.language ?? null, title: call.title ?? null, summary: call.summary ?? null, successful: call.successful ?? null,
    collected: call.collected ?? {}, has_audio: !!call.has_audio, agent_turns: call.agent_turns ?? 0, account: call.account ?? 'platform', cost_usd: null,
  };
}

/** outreach_webchat__voice_report. */
export function voiceReport(store: DemoStore, ws: string, inboxIds: Set<string>, f: number, t: number): Row {
  const calls = store.t(T.voiceCalls).filter((k) => k.workspace_id === ws && inboxIds.has(k.inbox_id) && !k.test && k.status !== 'failed' && Date.parse(k.started_at) >= f && Date.parse(k.started_at) < t);
  const visitors = store.t(T.visitors).filter((x) => inboxIds.has(x.inbox_id) && x.last_seen_at && Date.parse(x.last_seen_at) >= f && Date.parse(x.first_seen_at ?? x.created_at) < t).length;
  const count = (rows: Row[], key: (r: Row) => string) => rows.reduce<Record<string, number>>((m, r) => { const k = key(r); m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const ids = new Set(calls.map((c) => c.id));
  const turns = store.t(T.turns).filter((x) => x.voice_call_id && ids.has(x.voice_call_id) && String(x.query ?? '').trim());
  const top = (rows: Row[]) => Object.entries(count(rows, (r) => String(r.query).slice(0, 120))).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10).map(([query, n]) => ({ query, n }));
  const durs = calls.filter((c) => c.duration_s != null).map((c) => Number(c.duration_s));
  const leads = new Set(calls.map((c) => { const id = chatOfCall(store, c); return id ? store.get('outreach_chats', id)?.lead_id : null; }).filter(Boolean));
  return {
    calls: calls.length, minutes: calls.reduce((n, c) => n + Math.ceil(Number(c.duration_s ?? 0) / 60), 0), avg_seconds: durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : null,
    per_100_visitors: visitors > 0 ? Math.round((calls.length * 1000) / visitors) / 10 : null,
    switched: calls.filter((c) => c.ended_reason === 'switch').length, handed_off: calls.filter((c) => c.ended_reason === 'handoff').length,
    handoff_reasons: count(calls.filter((c) => c.ended_reason === 'handoff'), (c) => c.handoff_reason ?? 'other'),
    ended_by: count(calls.filter((c) => c.ended_at), (c) => c.ended_reason ?? 'visitor'),
    resolved: calls.filter((c) => c.successful === 'success').length, judged: calls.filter((c) => c.successful === 'success' || c.successful === 'failure').length,
    with_name: calls.filter((c) => String(c.collected?.visitor_name ?? '') !== '').length, with_phone: calls.filter((c) => String(c.collected?.visitor_phone ?? '') !== '').length,
    leads: leads.size, languages: count(calls, (c) => c.language ?? 'en'),
    top_questions: top(turns), unanswered: top(turns.filter((x) => x.confidence === 'low')), cost_usd: null, pool: voicePool(store, ws),
  };
}

// ---------------------------------------------------------------------------- the sample call
export interface Turn { role: 'agent' | 'user' | 'tool'; text: string; tool?: string; result?: Row }

const brandOf = (inbox: Row) => String(settingsOf(inbox).appearance?.brand_name || inbox.name || 'our');
const firstSentences = (t: string, n = 2) => (String(t).replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+/g) ?? [t]).slice(0, n).join(' ').trim();
const price = (p: Row) => (p.price == null ? '' : ` at ${p.currency && p.currency !== 'USD' ? `${p.currency} ` : '$'}${Number(p.price).toFixed(Number(p.price) % 1 ? 2 : 0)}`);

/** The sample call for a website: its greeting, a question from its own Q&A, products from its catalogue, a callback request. */
export function sampleTurns(store: DemoStore, inbox: Row, language?: string | null): Turn[] {
  const st = settingsOf(inbox), brand = brandOf(inbox);
  const lang = language || voiceLanguages(st)[0];
  const greeting = String(st.voice?.greeting?.[lang] || st.voice?.greeting?.en || '').trim() || `Hi! I'm the ${brand} assistant. What can I help you with today?`;
  const qa = faqsFor(store, inbox);
  const q1 = qa[0] ?? { question: `What does ${brand} do, and how quickly can we get started?`, answer: `${brand} runs your outreach from one place, with safe daily limits for every account. Most teams are live within a day, and we help you set up your first campaign.` };
  const products = st.ai?.products?.enabled ? catalogueProducts(store, inbox).filter((p) => p.price != null).sort((a, b) => Number(a.price) - Number(b.price)).slice(0, 2) : [];
  const turns: Turn[] = [
    { role: 'agent', text: greeting },
    { role: 'user', text: q1.question },
    { role: 'tool', text: '', tool: 'search_knowledge', result: { found: 2 } },
    { role: 'agent', text: firstSentences(q1.answer, 2) },
  ];
  if (products.length) {
    const budget = Math.ceil(Number(products[products.length - 1].price) / 10) * 10 + 10;
    turns.push(
      { role: 'user', text: `Nice. And do you have something under ${budget} dollars? It is a gift for a colleague.` },
      { role: 'tool', text: '', tool: 'find_products', result: { found: products.length, products: products.map((p) => p.title).join(', ') } },
      { role: 'agent', text: products.length > 1 ? `Two good picks: ${products[0].title}${price(products[0])}, and ${products[1].title}${price(products[1])}. I can put both in the chat with their links.` : `A good pick is ${products[0].title}${price(products[0])}. I can put it in the chat with its link.` },
    );
  }
  turns.push(
    { role: 'user', text: 'Great, thanks. Could someone from your team call me back tomorrow? I am Jordan, my number is plus one, five five five, zero one four two.' },
    { role: 'tool', text: '', tool: 'save_contact', result: { result: 'saved' } },
    { role: 'agent', text: 'Thanks Jordan. I have saved your number, and someone from the team will call you tomorrow. Is there anything else I can help with?' },
    { role: 'user', text: 'No, that is everything. Thank you!' },
    { role: 'agent', text: 'You are welcome. Have a lovely day!' },
  );
  return turns;
}

/** A typed question during the sample call: answered from the website's Q&A like the chat assistant. */
export function sampleReply(store: DemoStore, inbox: Row, text: string): string {
  const r = websiteAnswer(store, text, faqsFor(store, inbox));
  return r.matched ? firstSentences(r.answer, 2) : 'Good question. I do not have that in my notes yet, so I will pass it to the team and they will follow up.';
}

/** Seconds each spoken turn lasts in the sample (words at a calm pace). */
export const turnSeconds = (t: Turn) => (t.role === 'tool' ? 0.8 : Math.min(11, Math.max(1.6, t.text.split(/\s+/).length * 0.36)));

/**
 * A small WAV (8 kHz, 8-bit mono) that sounds like a muffled conversation: voiced syllables at two pitches, one per
 * speaker, timed like the transcript. Built on demand, never stored.
 */
export function sampleWav(turns: Turn[]): Blob {
  const rate = 8000;
  const segs: Array<{ f0: number; secs: number }> = [];
  for (const t of turns) { if (t.role === 'tool') { segs.push({ f0: 0, secs: 0.9 }); continue; } segs.push({ f0: t.role === 'agent' ? 205 : 132, secs: turnSeconds(t) }, { f0: 0, secs: 0.55 }); }
  const total = Math.ceil(segs.reduce((n, s) => n + s.secs, 0.4) * rate);
  const buf = new Uint8Array(44 + total);
  const dv = new DataView(buf.buffer);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + total, true); str(8, 'WAVE'); str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true); str(36, 'data'); dv.setUint32(40, total, true);
  let i = 44, phase = 0, seed = 12345;
  for (const s of segs) {
    const n = Math.round(s.secs * rate);
    for (let k = 0; k < n && i < buf.length; k++, i++) {
      if (!s.f0) { buf[i] = 128; continue; }
      const t = k / rate;
      const syl = (t * 4.2) % 1, word = Math.floor(t * 4.2) % 5 === 4 ? 0.15 : 1;   // a short pause every few syllables
      const env = Math.pow(Math.max(0, Math.sin(Math.PI * syl)), 0.7) * word * Math.min(1, t * 6, (s.secs - t) * 6);
      const f = s.f0 * (1 + 0.07 * Math.sin(2 * Math.PI * 0.6 * t) + 0.04 * Math.sin(2 * Math.PI * 3.1 * t));
      phase += (2 * Math.PI * f) / rate;
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const x = 0.55 * Math.sin(phase) + 0.28 * Math.sin(2 * phase) + 0.14 * Math.sin(3 * phase) + 0.06 * Math.sin(5 * phase) + 0.03 * ((seed / 0x7fffffff) - 0.5);
      buf[i] = Math.max(0, Math.min(255, Math.round(128 + 92 * env * x)));
    }
  }
  while (i < buf.length) buf[i++] = 128;
  return new Blob([buf], { type: 'audio/wav' });
}

// ---------------------------------------------------------------------------- the voice SDK stand-in (browser only)
type On = { connect?(id: string): void; mode?(m: 'speaking' | 'listening'): void; message?(m: { role: 'user' | 'agent'; text: string }): void; tool?(t: { name: string; id: string; type: string }): void; toolResult?(t: { name: string; id: string; error: boolean; result?: string }): void; end?(reason: 'user' | 'agent' | 'error'): void };
/** The script the next session plays: set by voice-admin test-session (it runs before the panel opens the session). */
let nextSession: { callId: string; turns: Turn[]; reply: (text: string) => string } | null = null;
export function queueSampleSession(callId: string, turns: Turn[], reply: (text: string) => string): void { nextSession = { callId, turns, reply }; }

/** The browser's own speech voices (localService only: those never reach a network service). */
function speaker() {
  const w = globalThis as unknown as { speechSynthesis?: SpeechSynthesis; SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance };
  const ss = w.speechSynthesis, U = w.SpeechSynthesisUtterance;
  let local: SpeechSynthesisVoice[] = [];
  try { local = (ss?.getVoices() ?? []).filter((x) => x.localService && /^en/i.test(x.lang)); } catch { local = []; }
  return {
    say(text: string, role: 'agent' | 'user', done: () => void): () => void {
      const fallback = setTimeout(done, turnSeconds({ role, text }) * 1000 + 300);
      if (!ss || !U || !local.length) return () => clearTimeout(fallback);
      clearTimeout(fallback);
      let finished = false;
      const fin = () => { if (finished) return; finished = true; clearTimeout(guard); done(); };
      const guard = setTimeout(fin, turnSeconds({ role, text }) * 1000 * 2 + 2000);
      const u = new U(text);
      u.voice = role === 'agent' ? local[0] : local[1] ?? local[0];
      u.pitch = role === 'agent' ? 1.08 : 0.85; u.rate = 1.04; u.onend = fin; u.onerror = fin;
      try { ss.speak(u); } catch { fin(); }
      return () => { finished = true; clearTimeout(guard); try { ss.cancel(); } catch { /* ignore */ } };
    },
  };
}

function session(o: { on: On }): Promise<Row> {
  const plan = nextSession ?? { callId: 'sample', turns: [{ role: 'agent' as const, text: 'Hi! This is a sample call from the product tour.' }], reply: () => 'Thanks for your message.' };
  nextSession = null;
  const queue: Turn[] = plan.turns.slice();
  let stopped = false, mode: 'speaking' | 'listening' = 'listening', cancel: (() => void) | null = null, timer: ReturnType<typeof setTimeout> | null = null, n = 0;
  const sp = speaker();
  const later = (ms: number, fn: () => void) => { timer = setTimeout(() => { timer = null; if (!stopped) fn(); }, ms); };
  const step = () => {
    if (stopped) return;
    const t = queue.shift();
    if (!t) { later(700, () => { stopped = true; o.on.end?.('agent'); }); return; }
    if (t.role === 'tool') {
      const id = `tool-${++n}`;
      o.on.tool?.({ name: t.tool!, id, type: 'webhook' });
      later(650 + (n % 3) * 150, () => { o.on.toolResult?.({ name: t.tool!, id, error: false, result: JSON.stringify(t.result ?? {}) }); later(250, step); });
      return;
    }
    if (t.role === 'agent') { mode = 'speaking'; o.on.mode?.('speaking'); o.on.message?.({ role: 'agent', text: t.text }); cancel = sp.say(t.text, 'agent', () => { mode = 'listening'; o.on.mode?.('listening'); later(500, step); }); return; }
    mode = 'listening'; o.on.mode?.('listening');
    cancel = sp.say(t.text, 'user', () => { o.on.message?.({ role: 'user', text: t.text }); later(450, step); });
  };
  later(600, () => { o.on.connect?.(plan.callId); step(); });
  return Promise.resolve({
    id: () => plan.callId,
    end: async () => { stopped = true; if (timer) clearTimeout(timer); cancel?.(); },
    mute: () => {},
    // a typed message is answered next, before the rest of the script
    text: (text: string) => { queue.unshift({ role: 'agent', text: plan.reply(text) }); },
    activity: () => {},
    context: () => {},
    level: () => (mode === 'speaking' ? 0.35 + 0.3 * Math.abs(Math.sin(Date.now() / 120)) : 0.05),
    open: () => !stopped,
  });
}

/** Puts the stand-in where loadVoiceModule looks first, so /widget/v1/voice.js (and the voice provider) never loads. */
export function installSampleVoice(): void {
  const w = globalThis as unknown as { window?: unknown; __growthxaiWebchatVoice?: unknown };
  if (typeof w.window === 'undefined') return;
  w.__growthxaiWebchatVoice = { session };
  // the browser loads its speech voices lazily: ask once now so they are there when a sample call starts
  try { (globalThis as unknown as { speechSynthesis?: SpeechSynthesis }).speechSynthesis?.getVoices(); } catch { /* no speech in this browser */ }
}
