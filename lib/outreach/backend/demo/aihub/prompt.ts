/**
 * Master prompts for AI replies, as the SQL builds them (040 / 041 / 042): the template, the default settings, the
 * guided-prompt compiler, the prompt JSON (`outreach__mp_json`) and the version bump (`outreach__mp_bump`).
 */
import type { DemoStore, Row } from '../store';
import { DEMO_WS_ID, MEMBER } from '../seed/ids';

const iso = (ms = Date.now()) => new Date(ms).toISOString();

export function defaultSettings(): Row {
  return {
    stages: [
      { key: 'engage', label: 'Engage', early: true, pitch: false, instructions: 'My first 1–2 replies.\n- Respond to what they actually said, in their words.\n- Ask one question about their situation: what they\'re working on, how they handle <problem> today.\n- Vary the approach between replies.\n- No pitch, no link, no prices.' },
      { key: 'relate', label: 'Relate', early: true, pitch: false, instructions: 'Next reply.\n- Connect what they told me to one relevant example or result from "Facts I can use".\n- One question that checks if it matters to them. Still no link.' },
      { key: 'pitch', label: 'Pitch', early: false, pitch: true, instructions: 'Only after at least 2 exchanges.\n- One or two lines on how we\'d help, tied to what they said. Not a feature list.' },
      { key: 'next_step', label: 'Next step', early: false, pitch: false, instructions: '- Suggest a short call and share <my calendar link>. If they\'d rather pick a time, offer two times from <my availability>.' },
    ],
    min_exchanges_before_pitch: 2,
    skip_to_pitch_when: ['asked_offer', 'pricing', 'meeting_request', 'meeting_time_proposed', 'explicit_interest'],
    vary_moves_in_early_stages: true,
    max_ai_replies_per_chat: 6,
    languages: ['en'],
    allow_language_switch: false,
    bot_question: 'escalate',
    handoff_stage_id: null,
    knowledge_source_ids: [],
    max_length: 600,
  };
}

const DEFAULT_STOP = 'Stop replying after any of these. A person takes over from there.\n- I\'ve shared my calendar link, or we\'ve agreed a meeting time.\n- They say they\'re interested and want to talk, and I\'ve told them how to book.\n- They ask to speak to someone directly.';

export function defaultSections(): Row {
  return {
    who: 'I\'m {{sender.first_name}}, {{sender.role}} at <my company>. <One line on what we do and for whom.>',
    flow: 'Move through these stages like a person would. Don\'t pitch in the first replies unless they ask.\nSkip ahead when they ask what we do, ask the price, ask for a call, or say they want the service.\n\nComing back after a gap\n- A few days later: pick up naturally, no apology.\n- Over a month later (Re-engage): acknowledge it lightly, recap in one line, ask what\'s changed.',
    situations: '- They ask the price → <e.g. "Say pricing depends on scope and offer a 15-min call">\n- They propose a meeting time → accept if it fits; otherwise offer two times.\n- Not interested → don\'t reply. Archive.\n- Out-of-office → don\'t reply.',
    handoff: '- They mention a contract, invoice, NDA, discount or legal terms.\n- They\'re upset or complaining.\n- They ask something not covered by "Facts I can use".',
    stop: DEFAULT_STOP,
    facts: '- <Offer, turnaround, clients/proof points, prices if I want the AI to share them, links>',
    style: '- 1–3 short sentences. LinkedIn chat: no subject, no signature.\n- Match their language and register.\n- No exclamation marks unless they used them. Never "I hope this finds you well".',
  };
}

export function defaultScenarios(): Row[] {
  return [
    { title: 'Pricing question', when_text: 'They ask what it costs, rates, budget, or a quote', do_text: 'Say pricing depends on scope; offer a 15-min call for an exact quote. Never invent a number.', enabled: true },
    { title: 'Meeting time proposed', when_text: 'They suggest a day or time to talk', do_text: 'Accept if it fits my availability; otherwise offer two times from it. Share the calendar link if I have one.', enabled: true },
    { title: 'Not now', when_text: 'They say later, next quarter, or that the timing is wrong', do_text: 'Thank them, ask if I can check back in <month>; no pitch. Create a follow-up task for that date.', enabled: true },
    { title: 'Not interested', when_text: 'They say no, not relevant, or please stop', do_text: 'Don\'t reply. Archive the conversation.', enabled: true },
    { title: 'Wrong person', when_text: 'They say someone else handles this and name them', do_text: 'Thank them, say I\'ll reach out to that person. Create a task with the contact exactly as they wrote it.', enabled: true },
    { title: 'Out of office', when_text: 'An automatic out-of-office or holiday reply', do_text: 'Don\'t reply.', enabled: true },
    { title: 'Just "thanks"', when_text: 'A bare thanks, 👍 or ok after my last message, with no question', do_text: 'Don\'t reply.', enabled: true },
  ];
}

/** `outreach__compile_master_prompt`. */
export function compilePrompt(sections: Row | null | undefined, settings: Row | null | undefined, scenarios?: Row[] | null): string {
  const s = sections ?? {};
  const t = (v: unknown) => String(v ?? '').trim();
  let stages = '';
  (settings?.stages ?? []).forEach((st: Row, i: number) => {
    stages += `Stage ${i + 1} · ${st.label ?? st.key}${st.pitch ? ' (pitch)' : st.early ? ' (early)' : ''}\n${t(st.instructions) || '-'}\n\n`;
  });
  let sit = '';
  if (scenarios?.length) for (const c of scenarios) if (c.enabled !== false) sit += `- ${t(c.title) || 'Situation'}: when ${t(c.when_text)} → ${t(c.do_text)}\n`;
  sit = sit.trim() || t(s.situations) || '-';
  return [
    `## Who I am\n${t(s.who) || '-'}`,
    `## How a conversation goes\n${t(s.flow) || '-'}${stages ? `\n\n${stages.trim()}` : ''}`,
    `## Situations\n${sit}`,
    `## Hand to a person when\n${t(s.handoff) || '-'}`,
    t(s.stop) ? `## Stop when\n${t(s.stop)}` : null,
    `## Facts I can use\n${t(s.facts) || '-'}`,
    `## Style\n${t(s.style) || '-'}`,
  ].filter(Boolean).join('\n\n').trim();
}

export function template(): Row {
  const sections = defaultSections(), settings = defaultSettings(), scenarios = defaultScenarios();
  return { editor_mode: 'guided', sections, settings, scenarios, body: compilePrompt(sections, settings, scenarios) };
}

// ---------------------------------------------------------------------------------------------------------------
export function cards(store: DemoStore, mpId: string): Row[] {
  return store.t('outreach_master_prompt_scenarios').filter((c) => c.master_prompt_id === mpId)
    .sort((a, b) => a.position - b.position || String(a.updated_at).localeCompare(String(b.updated_at)))
    .map((c) => ({ id: c.id, position: c.position, title: c.title, when_text: c.when_text, do_text: c.do_text, enabled: c.enabled, updated_at: c.updated_at }));
}
export function faqs(store: DemoStore, mpId: string): Row[] {
  return store.t('outreach_master_prompt_faqs').filter((f) => f.master_prompt_id === mpId)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .map((f) => ({ id: f.id, question: f.question, answer: f.answer, source: f.source, enabled: f.enabled, created_at: f.created_at }));
}
export function knowledgeOf(store: DemoStore, mp: Row): Row[] {
  const ids: string[] = mp.knowledge_source_ids ?? [];
  return store.t('outreach_knowledge_sources').filter((s) => ids.includes(s.id))
    .sort((a, b) => String(a.title).localeCompare(String(b.title)))
    .map((s) => ({ id: s.id, kind: s.kind, title: s.title, url: s.url, status: s.status, error: s.error, pages: s.pages, chunks: s.chunks, crawled_at: s.crawled_at }));
}

export function memberName(store: DemoStore, userId: string | null | undefined): string | null {
  if (!userId) return null;
  const m = store.t('outreach_members').find((x) => x.user_id === userId);
  return m ? (m.display_name ?? m.email ?? null) : null;
}

/** `outreach__mp_json`. */
export function mpJson(store: DemoStore, mp: Row | undefined, version?: number | null): Row | null {
  if (!mp) return null;
  const seq = mp.sequence_id ? store.get('outreach_sequences', mp.sequence_id) : undefined;
  const sit = String(mp.sections?.situations ?? '');
  const hasCards = store.t('outreach_master_prompt_scenarios').some((c) => c.master_prompt_id === mp.id);
  const base: Row = {
    exists: true, id: mp.id, scope: mp.scope, scope_id: mp.scope_id ?? null, sequence_id: mp.sequence_id ?? null, name: mp.name ?? null,
    scope_label: mp.scope === 'sequence' ? `Sequence · ${seq?.name ?? '?'}` : `Library · ${mp.name ?? '?'}`,
    substantive_version: mp.substantive_version, graduated: !!mp.graduated_at, inherited: null, template: template(),
    current_version: mp.version, copied_from_prompt_id: mp.copied_from_prompt_id ?? null, copied_from_version: mp.copied_from_version ?? null,
    scenarios: cards(store, mp.id), faqs: faqs(store, mp.id), knowledge: knowledgeOf(store, mp), knowledge_source_ids: [...(mp.knowledge_source_ids ?? [])],
    stop_present: /## Stop when/i.test(String(mp.body ?? '')),
    situations_text_convertible: mp.editor_mode === 'guided' && !['', '-'].includes(sit.trim()) && !hasCards,
  };
  if (version != null && version !== mp.version) {
    const v = store.t('outreach_master_prompt_versions').find((x) => x.master_prompt_id === mp.id && x.version === version);
    if (!v) throw Object.assign(new Error(`E_NOT_FOUND: version ${version} not found`), { code: 'E_NOT_FOUND' });
    return { ...base, editor_mode: v.editor_mode, version: v.version, body: v.body, sections: v.sections, settings: { ...defaultSettings(), ...(v.settings ?? {}) }, updated_at: v.created_at, updated_by_name: memberName(store, mp.updated_by), scenarios: v.scenarios ?? [], faqs: v.faqs ?? [] };
  }
  return { ...base, editor_mode: mp.editor_mode, version: mp.version, body: mp.body, sections: mp.sections ?? null, settings: { ...defaultSettings(), ...(mp.settings ?? {}) }, updated_at: mp.updated_at, updated_by_name: memberName(store, mp.updated_by) };
}

/** `outreach__mp_bump`: a new version (guided prompts recompile), with a snapshot of the cards and the Q&A. */
export function bump(store: DemoStore, mpId: string, kind: 'style' | 'substantive', note: string | null, edit: { editor_mode?: string; body?: string; sections?: Row | null; settings?: Row } = {}, by: string = MEMBER.maya): Row {
  const mp = store.get('outreach_master_prompts', mpId);
  if (!mp) throw Object.assign(new Error('E_NOT_FOUND'), { code: 'E_NOT_FOUND' });
  const em = edit.editor_mode ?? mp.editor_mode;
  const sec = em === 'guided' ? (edit.sections ?? mp.sections) : mp.sections;
  const st = edit.settings ?? mp.settings ?? {};
  const body = em === 'guided' ? compilePrompt(sec, { ...defaultSettings(), ...st }, cards(store, mpId)) : String(edit.body ?? mp.body ?? '').trim();
  if (body.length < 20) throw Object.assign(new Error('E_PAYLOAD_INVALID: the prompt is too short'), { code: 'E_PAYLOAD_INVALID' });
  const nv = (mp.version ?? 1) + 1;
  const now = iso();
  store.update('outreach_master_prompts', mpId, {
    editor_mode: em, version: nv, body, sections: sec, settings: st,
    substantive_version: kind === 'substantive' ? nv : mp.substantive_version, substantive_at: kind === 'substantive' ? now : mp.substantive_at,
    updated_by: by, updated_at: now,
  });
  store.insert('outreach_master_prompt_versions', {
    master_prompt_id: mpId, version: nv, editor_mode: em, body, sections: sec, settings: st, change_kind: kind, note: note ? note.slice(0, 500) : null,
    created_by: by, created_at: now, scenarios: cards(store, mpId), faqs: faqs(store, mpId),
  }, { noId: true });
  if (kind === 'substantive' && mp.scope === 'sequence') {
    store.update('outreach_sequence_reply_settings', (r) => r.sequence_id === mp.sequence_id, (r) => ({ warmup_remaining: Math.max(r.warmup_remaining ?? 0, 10), updated_at: now }));
  }
  return store.get('outreach_master_prompts', mpId)!;
}

/** `outreach_ai_seq_settings_ensure`: a sequence's settings row and its own prompt (from the workspace default or the template). */
export function ensureSeqSettings(store: DemoStore, sequenceId: string, by: string = MEMBER.maya): Row {
  const existing = store.get('outreach_sequence_reply_settings', sequenceId, 'sequence_id');
  if (existing?.master_prompt_id && store.get('outreach_master_prompts', existing.master_prompt_id)) return existing;
  const q = store.get('outreach_sequences', sequenceId);
  if (!q) throw Object.assign(new Error('E_NOT_FOUND: sequence'), { code: 'E_NOT_FOUND' });
  let mp = store.t('outreach_master_prompts').find((m) => m.scope === 'sequence' && m.sequence_id === sequenceId);
  const now = iso();
  if (!mp) {
    const wrs = store.get('outreach_workspace_reply_settings', q.workspace_id, 'workspace_id');
    const src = wrs?.default_prompt_id ? store.t('outreach_master_prompts').find((m) => m.id === wrs.default_prompt_id && m.scope === 'library') : undefined;
    if (src) {
      mp = store.insert('outreach_master_prompts', {
        workspace_id: q.workspace_id, scope: 'sequence', scope_id: sequenceId, sequence_id: sequenceId, name: null, editor_mode: src.editor_mode, version: 1,
        body: src.body, sections: src.sections, settings: src.settings, substantive_version: 1, substantive_at: now, graduated_at: null, graduation: null,
        copied_from_prompt_id: src.id, copied_from_version: src.version, knowledge_source_ids: [...(src.knowledge_source_ids ?? [])], updated_by: by, updated_at: now,
      })[0];
      for (const c of store.t('outreach_master_prompt_scenarios').filter((x) => x.master_prompt_id === src.id)) {
        store.insert('outreach_master_prompt_scenarios', { master_prompt_id: mp.id, position: c.position, title: c.title, when_text: c.when_text, do_text: c.do_text, enabled: c.enabled, updated_by: by, updated_at: now });
      }
      for (const f of store.t('outreach_master_prompt_faqs').filter((x) => x.master_prompt_id === src.id)) {
        store.insert('outreach_master_prompt_faqs', { master_prompt_id: mp.id, workspace_id: q.workspace_id, question: f.question, answer: f.answer, source: 'import', enabled: f.enabled, created_by: by, updated_at: now });
      }
      store.insert('outreach_master_prompt_versions', { master_prompt_id: mp.id, version: 1, editor_mode: mp.editor_mode, body: mp.body, sections: mp.sections, settings: mp.settings, change_kind: 'substantive', note: `Copied from the workspace default prompt "${src.name ?? 'Workspace default'}" v${src.version}`, created_by: by, created_at: now, scenarios: cards(store, mp.id), faqs: faqs(store, mp.id) }, { noId: true });
    } else {
      const t = template();
      mp = store.insert('outreach_master_prompts', {
        workspace_id: q.workspace_id, scope: 'sequence', scope_id: sequenceId, sequence_id: sequenceId, name: null, editor_mode: 'guided', version: 1,
        body: t.body, sections: t.sections, settings: t.settings, substantive_version: 1, substantive_at: now, graduated_at: null, graduation: null,
        copied_from_prompt_id: null, copied_from_version: null, knowledge_source_ids: [], updated_by: by, updated_at: now,
      })[0];
      t.scenarios.forEach((c: Row, i: number) => store.insert('outreach_master_prompt_scenarios', { master_prompt_id: mp!.id, position: i + 1, title: c.title, when_text: c.when_text, do_text: c.do_text, enabled: true, updated_by: null, updated_at: now }));
      store.insert('outreach_master_prompt_versions', { master_prompt_id: mp.id, version: 1, editor_mode: 'guided', body: mp.body, sections: mp.sections, settings: mp.settings, change_kind: 'substantive', note: 'Template', created_by: by, created_at: now, scenarios: t.scenarios, faqs: [] }, { noId: true });
    }
  }
  if (existing) return store.update('outreach_sequence_reply_settings', (r) => r === existing, { master_prompt_id: existing.master_prompt_id ?? mp.id })[0];
  return store.insert('outreach_sequence_reply_settings', {
    sequence_id: sequenceId, workspace_id: q.workspace_id ?? DEMO_WS_ID, mode: 'draft', master_prompt_id: mp.id, pitch_after_replies: 2, max_ai_replies_per_chat: 6,
    warmup_remaining: 20, handoff_stage_id: null, delay_min_s: 240, delay_max_s: 1200, debounce_quiet_s: 120, debounce_max_s: 600, stale_after_h: 12, languages: ['en'],
    disclosure: null, blocked_countries: null, returning_after_days: 3, dormant_after_days: 30, inactivity_days: 7, downgraded_at: null, downgrade_reason: null,
    breaker_reset_at: null, updated_by: by, updated_at: now,
  }, { noId: true })[0];
}

export const EU_EEA = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO'];
