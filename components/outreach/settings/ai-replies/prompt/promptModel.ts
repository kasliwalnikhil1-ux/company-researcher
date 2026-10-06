// Pure helpers for the guided prompt editor (sequence tab and library prompts): defaults, normalising, comparing,
// validating and a readable text form used by the version diff. No React here.
import { FLAG_LABEL } from '@/lib/outreach/aiReplies';
import type { PromptSettings, StageDef } from '@/lib/outreach/aiReplies';
import type { DraftPromptV2, PromptSectionsV2, ScenarioDraft } from '@/lib/outreach/aiRepliesSequence';

export const MAX_STAGES = 8;
export const STAGE_KEY_RE = /^[a-z][a-z0-9_]{1,29}$/;
export const LANG_RE = /^[a-z]{2,3}$/;
export const SKIP_FLAGS = ['asked_offer', 'pricing', 'meeting_request', 'meeting_time_proposed', 'explicit_interest'] as const;

/** The guided sections in prompt order. `situations` is the pre-cards free text: shown only while it can still be converted. */
export const SECTION_META: Array<{ key: keyof PromptSectionsV2; title: string; hint: string; rows: number; legacy?: boolean }> = [
  { key: 'who', title: 'Who I am', hint: 'Who the AI speaks for and one line on what you do and for whom.', rows: 4 },
  { key: 'flow', title: 'How a conversation goes', hint: 'The general shape of a conversation. Per-stage rules go in Conversation stages below.', rows: 6 },
  { key: 'situations', title: 'Situations (old free text)', hint: 'Replaced by the Scenario cards below. Convert it to cards, or clear it.', rows: 6, legacy: true },
  { key: 'handoff', title: 'Hand to a person when', hint: 'When the AI should pass the chat to your team without replying.', rows: 5 },
  { key: 'stop', title: 'Stop when', hint: 'After any of these the AI sends its reply (if the rule allows one) and a person takes over for good.', rows: 5 },
  { key: 'facts', title: 'Facts I can use', hint: 'Offer, proof points, prices, links. The AI may only use facts, numbers and links written here or in the attached knowledge.', rows: 7 },
  { key: 'style', title: 'Style', hint: 'Length, tone, language. Changing only this section counts as a style-only change.', rows: 4 },
];

export const DEFAULT_SETTINGS: PromptSettings = {
  stages: [
    { key: 'engage', label: 'Engage', early: true },
    { key: 'relate', label: 'Relate', early: true },
    { key: 'pitch', label: 'Pitch', pitch: true },
    { key: 'next_step', label: 'Next step' },
  ],
  min_exchanges_before_pitch: 2,
  skip_to_pitch_when: [...SKIP_FLAGS],
  vary_moves_in_early_stages: true,
  max_ai_replies_per_chat: 6,
  languages: ['en'],
  allow_language_switch: false,
  bot_question: 'escalate',
  handoff_stage_id: null,
  knowledge_source_ids: [],
  max_length: 600,
};

export const EMPTY_SECTIONS: PromptSectionsV2 = { who: '', flow: '', situations: '', handoff: '', stop: '', facts: '', style: '' };

type PromptLike = { editor_mode?: 'guided' | 'raw' | null; body?: string | null; sections?: Partial<PromptSectionsV2> | null; settings?: Partial<PromptSettings> | null; scenarios?: ScenarioDraft[] | null };

/** Fill any missing field so the editor never deals with undefined. */
export function normalize(p: PromptLike): DraftPromptV2 {
  const s = { ...DEFAULT_SETTINGS, ...(p.settings ?? {}) } as PromptSettings;
  return {
    editor_mode: p.editor_mode === 'raw' ? 'raw' : 'guided',
    body: p.body ?? '',
    sections: { ...EMPTY_SECTIONS, ...(p.sections ?? {}) },
    settings: {
      ...s,
      stages: (s.stages?.length ? s.stages : DEFAULT_SETTINGS.stages).map((st) => ({ ...st, instructions: st.instructions ?? '' })),
      skip_to_pitch_when: [...(s.skip_to_pitch_when ?? [])],
      languages: [...(s.languages?.length ? s.languages : ['en'])],
      knowledge_source_ids: [...(s.knowledge_source_ids ?? [])],
      handoff_stage_id: s.handoff_stage_id ?? null,
    },
    ...(p.scenarios ? { scenarios: p.scenarios.map((c) => ({ id: c.id ?? null, title: c.title, when_text: c.when_text, do_text: c.do_text, enabled: c.enabled !== false })) } : {}),
  };
}

const stable = (v: unknown): string => JSON.stringify(v, (_k, val) =>
  val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b))) : val);

const cleanStage = (s: StageDef) => ({ key: s.key, label: s.label.trim(), instructions: (s.instructions ?? '').trim(), early: !!s.early, pitch: !!s.pitch });
const cleanSettings = (s: PromptSettings) => ({ ...s, stages: s.stages.map(cleanStage), skip_to_pitch_when: [...s.skip_to_pitch_when].sort() });

export const settingsEqual = (a: PromptSettings, b: PromptSettings) => stable(cleanSettings(a)) === stable(cleanSettings(b));

/** Which parts differ between the saved prompt and the editor. Section titles, "Stages" and "Settings". */
export function changedParts(base: DraftPromptV2, edited: DraftPromptV2): string[] {
  const out: string[] = [];
  if (base.editor_mode !== edited.editor_mode) out.push('Editor mode');
  if (edited.editor_mode === 'raw') {
    if (base.body.trim() !== edited.body.trim()) out.push('Prompt text');
  } else {
    for (const m of SECTION_META) {
      if ((base.sections?.[m.key] ?? '').trim() !== (edited.sections?.[m.key] ?? '').trim()) out.push(m.title);
    }
    if (stable(base.settings.stages.map(cleanStage)) !== stable(edited.settings.stages.map(cleanStage))) out.push('Stages');
  }
  const { stages: _a, ...restA } = cleanSettings(base.settings);
  const { stages: _b, ...restB } = cleanSettings(edited.settings);
  void _a; void _b;
  if (stable(restA) !== stable(restB)) out.push('Settings');
  return out;
}

export const isDirty = (base: DraftPromptV2, edited: DraftPromptV2 | null) => !!edited && changedParts(base, edited).length > 0;

/** Style-only when nothing but the Style section changed. Raw text changes are treated as substantive: we can't tell. */
export const suggestKind = (parts: string[]): 'style' | 'substantive' => (parts.length > 0 && parts.every((p) => p === 'Style') ? 'style' : 'substantive');

export function slugKey(label: string): string {
  const s = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
  return /^[a-z]/.test(s) ? s : s ? `s_${s}`.slice(0, 30) : '';
}

/** Problems that block saving. Empty array = fine. */
export function validate(d: DraftPromptV2): string[] {
  const errs: string[] = [];
  const s = d.settings;
  if (d.editor_mode === 'raw') {
    if (d.body.trim().length < 20) errs.push('Write the prompt (at least a couple of sentences).');
  } else {
    if (!Object.values(d.sections ?? EMPTY_SECTIONS).some((v) => (v ?? '').trim())) errs.push('Fill in at least one section.');
    if (s.stages.length < 1 || s.stages.length > MAX_STAGES) errs.push(`Keep between 1 and ${MAX_STAGES} stages.`);
    const seen = new Set<string>();
    s.stages.forEach((st, i) => {
      const n = `Stage ${i + 1}`;
      if (!st.label.trim()) { errs.push(`${n} needs a name.`); return; }
      if (!STAGE_KEY_RE.test(st.key)) errs.push(`${n}: the key must start with a letter and use 2 to 30 lowercase letters, digits or underscores.`);
      else if (st.key === 'closing') errs.push(`${n}: "closing" is reserved. Pick another key.`);
      else if (seen.has(st.key)) errs.push(`${n}: another stage has the same name. Rename one of them.`);
      seen.add(st.key);
    });
  }
  const int = (v: number, lo: number, hi: number) => Number.isInteger(v) && v >= lo && v <= hi;
  if (!int(s.max_length, 100, 1000)) errs.push('Longest reply: a whole number from 100 to 1000 characters.');
  return errs;
}

/** Guided body as the server compiles it (sections + stages + enabled scenario cards). The server compiles its own copy. */
export function compileGuided(sections: PromptSectionsV2, settings: PromptSettings, scenarios?: ScenarioDraft[] | null): string {
  const parts: string[] = [];
  const cards = (scenarios ?? []).filter((c) => c.enabled !== false);
  for (const m of SECTION_META) {
    let text = (sections[m.key] ?? '').trim();
    if (m.key === 'flow') {
      const stages = settings.stages.map((st, i) => `Stage ${i + 1} · ${st.label}${st.pitch ? ' (pitch)' : st.early ? ' (early)' : ''}\n${st.instructions?.trim() || '-'}`).join('\n\n');
      text = [text || '-', stages].filter(Boolean).join('\n\n');
    }
    if (m.key === 'situations') {
      const fromCards = cards.map((c) => `- ${c.title.trim()}: when ${c.when_text.trim()} → ${c.do_text.trim()}`).join('\n');
      text = fromCards || text || '-';
      parts.push(`## Situations\n${text}`);
      continue;
    }
    if (m.key === 'stop') { if (text) parts.push(`## Stop when\n${text}`); continue; }
    parts.push(`## ${m.title}\n${text || '-'}`);
  }
  return parts.join('\n\n');
}

/** The payload for save / simulate: guided body compiled, strings trimmed. */
export function forSend(d: DraftPromptV2): DraftPromptV2 {
  const settings: PromptSettings = { ...d.settings, stages: d.settings.stages.map((st) => ({ ...cleanStage(st) })) };
  const sections = d.sections ?? EMPTY_SECTIONS;
  return { ...d, editor_mode: d.editor_mode, sections, settings, body: d.editor_mode === 'guided' ? compileGuided(sections, settings, d.scenarios) : d.body };
}

/** A readable, line-by-line form of a prompt for the version diff. */
export function promptToText(d: DraftPromptV2, pipelineStageName?: (id: string) => string | undefined): string {
  const s = d.settings;
  const lines: string[] = [`Editor: ${d.editor_mode === 'raw' ? 'Raw' : 'Guided'}`, ''];
  if (d.editor_mode === 'raw') lines.push(d.body, '');
  else {
    for (const m of SECTION_META) {
      const text = (d.sections?.[m.key] ?? '').trim();
      if (m.legacy && !text) continue;
      lines.push(`## ${m.title}`, text || '(empty)', '');
    }
    lines.push('## Stages');
    s.stages.forEach((st, i) => {
      lines.push(`${i + 1}. ${st.label} [${st.key}]${st.early ? ' · early' : ''}${st.pitch ? ' · pitch' : ''}`);
      if (st.instructions?.trim()) lines.push(...st.instructions.trim().split('\n').map((l) => `   ${l}`));
    });
    lines.push('');
    if (d.scenarios?.length) {
      lines.push('## Scenarios');
      d.scenarios.forEach((c, i) => lines.push(`${i + 1}. ${c.title}${c.enabled === false ? ' (off)' : ''}: when ${c.when_text} → ${c.do_text}`));
      lines.push('');
    }
  }
  lines.push('## Settings',
    `Skip to pitch when: ${s.skip_to_pitch_when.map((f) => FLAG_LABEL[f] ?? f).join(', ') || 'never'}`,
    `Vary the approach in early stages: ${s.vary_moves_in_early_stages ? 'yes' : 'no'}`,
    `Reply in their language: ${s.allow_language_switch ? 'yes' : 'no'}`,
    `"Are you a bot?": ${s.bot_question === 'disclose' ? 'say it is AI-assisted' : 'hand to a person'}`,
    `Longest reply: ${s.max_length} characters`);
  void pipelineStageName;
  return lines.join('\n');
}
