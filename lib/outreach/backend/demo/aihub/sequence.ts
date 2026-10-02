/** A sequence's AI replies card (042): settings, the open conversations by stage, the senders and their consent. */
import { DEMO_USER_EMAIL } from '../seed/ids';
import type { DemoStore, Row } from '../store';
import { EU_EEA, defaultSettings, ensureSeqSettings, mpJson } from './prompt';

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const err = (code: string, msg?: string): never => { throw Object.assign(new Error(msg ? `${code}: ${msg}` : code), { code }); };

export function seqOrThrow(store: DemoStore, id: string): Row {
  return store.get('outreach_sequences', id) ?? err('E_NOT_FOUND', 'sequence');
}

const openChats = (store: DemoStore, seqId: string) => store.t('outreach_chats').filter((c) => c.reply_sequence_id === seqId && !c.ai_handed_off_at && !c.archived && c.ai_session_started_at);

export function seqSummary(store: DemoStore, seqId: string): Row {
  const q = seqOrThrow(store, seqId);
  const srs = store.get('outreach_sequence_reply_settings', seqId, 'sequence_id');
  const mp = srs?.master_prompt_id ? store.get('outreach_master_prompts', srs.master_prompt_id) : undefined;
  const stages: Row[] = mp?.settings?.stages ?? defaultSettings().stages;
  const mode = srs?.mode ?? 'draft';
  const groups = new Map<string, Row>();
  for (const c of openChats(store, seqId)) {
    const key = c.conversation_stage ?? (c.ai_session_kind === 'dormant' ? 're_engage' : 'engage');
    const i = stages.findIndex((s) => s.key === c.conversation_stage);
    const label = i >= 0 ? stages[i].label : c.ai_session_kind === 'dormant' && !c.conversation_stage ? 'Re-engage' : 'Engage';
    const g = groups.get(key) ?? { stage: key, label, n: 0, pos: i >= 0 ? i + 1 : 0 };
    g.n++;
    groups.set(key, g);
  }
  const week = Date.now() - 7 * 86_400_000;
  const chats = store.t('outreach_chats').filter((c) => c.reply_sequence_id === seqId);
  return {
    mode, effective_mode: q.status === 'active' ? mode : mode === 'off' ? 'off' : 'draft',
    warmup_remaining: srs?.warmup_remaining ?? null, downgraded_at: srs?.downgraded_at ?? null,
    open_conversations: openChats(store, seqId).length,
    open_by_stage: [...groups.values()].sort((a, b) => a.pos - b.pos).map(({ pos, ...g }) => { void pos; return g; }),
    handed_off_7d: chats.filter((c) => c.ai_handed_off_at && Date.parse(c.ai_handed_off_at) > week).length,
    handed_off_open: chats.filter((c) => c.ai_handed_off_at && !c.archived).length,
    drafts_waiting: store.t('outreach_ai_reply_runs').filter((r) => r.sequence_id === seqId && r.status === 'draft_ready' && r.decision === 'send').length,
    unanswered_open: store.t('outreach_ai_unanswered_questions').filter((u) => u.sequence_id === seqId && u.status === 'open').length,
  };
}

const ownerIsMe = (s: Row, userId: string) => s.owner_user_id === userId || String(s.owner_email ?? '').toLowerCase() === DEMO_USER_EMAIL.toLowerCase();

/** The LinkedIn senders a sequence sends from. */
export function linkedinPool(store: DemoStore, q: Row): Row[] {
  const ids = new Set<string>([...(q.sender_pool ?? []), ...((q.sender_pools?.LINKEDIN ?? []) as string[])]);
  return store.t('outreach_senders').filter((s) => ids.has(s.id) && !s.deleted_at && s.provider === 'LINKEDIN');
}

export function liveConsent(store: DemoStore, senderId: string): Row | undefined {
  const now = Date.now();
  return store.t('outreach_ai_reply_consent').find((k) => k.sender_id === senderId && !k.revoked_at && Date.parse(k.expires_at) > now);
}
export function pendingLink(store: DemoStore, senderId: string): Row | undefined {
  const now = Date.now();
  return store.t('outreach_ai_reply_consent_links').filter((l) => l.sender_id === senderId && !l.used_at && !l.cancelled_at && Date.parse(l.expires_at) > now)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
}

export function seqRepliesGet(store: DemoStore, seqId: string, userId: string): Row {
  const q = seqOrThrow(store, seqId);
  const srs = ensureSeqSettings(store, seqId, userId);
  const mp = store.get('outreach_master_prompts', srs.master_prompt_id);
  const senders = linkedinPool(store, q).sort((a, b) => String(a.display_name).localeCompare(String(b.display_name))).map((s) => {
    const k = liveConsent(store, s.id);
    const pl = pendingLink(store, s.id);
    return {
      sender_id: s.id, sender_name: s.display_name ?? null, owner_email: s.owner_email ?? null, owner_is_me: ownerIsMe(s, userId),
      consent: k ? 'granted' : pl ? 'pending' : 'missing', consent_id: k?.id ?? null, granted_via: k?.granted_via ?? null,
      pending_link_id: pl?.id ?? null, pending_link_expires_at: pl?.expires_at ?? null,
    };
  });
  const wrs = store.get('outreach_workspace_reply_settings', q.workspace_id, 'workspace_id');
  return {
    sequence_id: seqId, sequence_name: q.name, sequence_status: q.status, mode: srs.mode, master_prompt_id: srs.master_prompt_id, prompt: mpJson(store, mp),
    pitch_after_replies: srs.pitch_after_replies, max_ai_replies_per_chat: srs.max_ai_replies_per_chat, warmup_remaining: srs.warmup_remaining,
    handoff_stage_id: srs.handoff_stage_id ?? null, delay_min_s: srs.delay_min_s, delay_max_s: srs.delay_max_s, debounce_quiet_s: srs.debounce_quiet_s,
    debounce_max_s: srs.debounce_max_s, stale_after_h: srs.stale_after_h, languages: [...(srs.languages ?? ['en'])], disclosure: srs.disclosure ?? null,
    blocked_countries: srs.blocked_countries == null ? null : [...srs.blocked_countries], blocked_countries_default: EU_EEA,
    returning_after_days: srs.returning_after_days, dormant_after_days: srs.dormant_after_days, inactivity_days: srs.inactivity_days ?? null,
    downgraded_at: srs.downgraded_at ?? null, downgrade_reason: srs.downgrade_reason ?? null, updated_at: srs.updated_at,
    senders, workspace_cap: wrs?.max_ai_sends_per_sender_day ?? null,
    ...seqSummary(store, seqId),
  };
}

const ALLOWED = ['mode', 'pitch_after_replies', 'max_ai_replies_per_chat', 'handoff_stage_id', 'delay_min_s', 'delay_max_s', 'debounce_quiet_s', 'debounce_max_s',
  'stale_after_h', 'languages', 'disclosure', 'blocked_countries', 'returning_after_days', 'dormant_after_days', 'inactivity_days'];

export function seqRepliesSet(store: DemoStore, seqId: string, patch: Row, note: string | null, userId: string): Row {
  const q = seqOrThrow(store, seqId);
  const srs = ensureSeqSettings(store, seqId, userId);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) err('E_PAYLOAD_INVALID', 'patch must be an object');
  const bad = Object.keys(patch).filter((k) => !ALLOWED.includes(k));
  if (bad.length) err('E_PAYLOAD_INVALID', `unknown field(s) ${bad.join(', ')}`);
  if ('mode' in patch && !['off', 'draft', 'autopilot'].includes(patch.mode)) err('E_PAYLOAD_INVALID', 'mode is off, draft or autopilot');
  if ('languages' in patch && (!Array.isArray(patch.languages) || !patch.languages.length || patch.languages.some((x: unknown) => !/^[a-z]{2,3}$/.test(String(x))))) err('E_PAYLOAD_INVALID', 'languages are ISO codes like en or hi');
  if (Array.isArray(patch.blocked_countries) && patch.blocked_countries.some((c: unknown) => !/^[A-Z]{2}$/.test(String(c)))) err('E_PAYLOAD_INVALID', 'countries are two-letter codes like DE or FR');
  if (patch.handoff_stage_id && !store.get('outreach_stages', patch.handoff_stage_id)) err('E_PAYLOAD_INVALID', 'hand-off stage not found');
  if (srs.downgraded_at && patch.mode === 'autopilot' && String(note ?? '').trim().length < 3) err('E_PAYLOAD_INVALID', `Auto was switched off automatically (${srs.downgrade_reason}). Add a note saying why it can go back on`);
  const next: Row = { ...srs };
  for (const k of ALLOWED) if (k in patch) next[k] = k === 'disclosure' ? (String(patch[k] ?? '').trim() || null) : patch[k];
  const range = (v: number, a: number, b: number) => Number.isFinite(Number(v)) && Number(v) >= a && Number(v) <= b;
  if (!range(next.pitch_after_replies, 0, 5) || !range(next.max_ai_replies_per_chat, 1, 10) || !(Number(next.delay_min_s) >= 60) || !(Number(next.delay_max_s) <= 3600)
    || !(Number(next.delay_max_s) > Number(next.delay_min_s)) || !range(next.debounce_quiet_s, 30, 600) || !range(next.debounce_max_s, 60, 1800)
    || !(Number(next.debounce_max_s) >= Number(next.debounce_quiet_s)) || !range(next.stale_after_h, 1, 72) || !range(next.returning_after_days, 1, 30)
    || !range(next.dormant_after_days, 7, 365) || !(Number(next.dormant_after_days) > Number(next.returning_after_days))
    || (next.inactivity_days != null && !range(next.inactivity_days, 1, 60)) || (next.disclosure && String(next.disclosure).length > 200)) {
    err('E_PAYLOAD_INVALID', 'a value is out of range (pitch after 0–5, 1–10 replies per conversation, delay 1–60 min with max above min, debounce 30–600 s / 60–1800 s, stale 1–72 h, disclosure up to 200 characters, returning 1–30 days, dormant 7–365 days above returning, quiet 1–60 days)');
  }
  const was = srs.mode;
  if (patch.mode === 'autopilot') { next.downgraded_at = null; next.downgrade_reason = null; if (was !== 'autopilot') next.breaker_reset_at = iso(); }
  next.updated_by = userId; next.updated_at = iso();
  store.update('outreach_sequence_reply_settings', (r) => r.sequence_id === seqId, next);
  let demoted = 0;
  if (patch.mode === 'off' || patch.mode === 'draft') {
    for (const r of store.t('outreach_ai_reply_runs').filter((x) => x.sequence_id === seqId && x.status === 'scheduled')) {
      store.update('outreach_ai_reply_runs', r.id, { status: patch.mode === 'off' ? 'cancelled' : 'draft_ready', cancel_reason: patch.mode === 'off' ? 'other' : null, scheduled_send_at: null, updated_at: iso() });
      store.update('outreach_chats', r.chat_id, { ai_run_status: patch.mode === 'off' ? 'cancelled' : 'draft_ready', ai_scheduled_send_at: null });
      demoted++;
    }
  }
  void q;
  return { ...seqRepliesGet(store, seqId, userId), applies_to: openChats(store, seqId).length, demoted };
}
