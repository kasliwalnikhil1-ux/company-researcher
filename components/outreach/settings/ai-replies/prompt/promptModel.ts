// Pure helpers for the master prompt editor: defaults, normalising, comparing, validating and a readable text form
// used by the version diff. No React here.
import { FLAG_LABEL } from '@/lib/outreach/aiReplies';
import type { DraftPrompt, PromptSections, PromptSettings, StageDef } from '@/lib/outreach/aiReplies';

export const MAX_STAGES = 8;
export const STAGE_KEY_RE = /^[a-z][a-z0-9_]{1,29}$/;
export const LANG_RE = /^[a-z]{2,3}$/;
export const SKIP_FLAGS = ['asked_offer', 'pricing', 'meeting_request', 'meeting_time_proposed', 'explicit_interest'] as const;

export const SECTION_META: Array<{ key: keyof PromptSections; title: string; hint: string; rows: number }> = [
  { key: 'who', title: 'Who I am', hint: 'Who the AI speaks for and one line on what you do and for whom.', rows: 4 },
  { key: 'flow', title: 'How a conversation goes', hint: 'The general shape of a conversation. Per-stage rules go in the stage table below.', rows: 6 },
  { key: 'situations', title: 'Situations', hint: 'What to do when they ask the price, propose a time, say "not now", name someone else…', rows: 8 },
  { key: 'handoff', title: 'Hand to a person when', hint: 'When the AI should stop and pass the chat to your team.', rows: 5 },
  { key: 'facts', title: 'Facts I can use', hint: 'Offer, proof points, prices, links. The AI may only use facts, numbers and links written here.', rows: 7 },
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

export const EMPTY_SECTIONS: PromptSections = { who: '', flow: '', situations: '', handoff: '', facts: '', style: '' };

type PromptLike = { editor_mode?: 'guided' | 'raw' | null; body?: string | null; sections?: Partial<PromptSections> | null; settings?: Partial<PromptSettings> | null };

/** Fill any missing field so the editor never deals with undefined. */
export function normalize(p: PromptLike): DraftPrompt {
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
  };
}

const stable = (v: unknown): string => JSON.stringify(v, (_k, val) =>
  val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b))) : val);

const cleanStage = (s: StageDef) => ({ key: s.key, label: s.label.trim(), instructions: (s.instructions ?? '').trim(), early: !!s.early, pitch: !!s.pitch });
const cleanSettings = (s: PromptSettings) => ({ ...s, stages: s.stages.map(cleanStage), skip_to_pitch_when: [...s.skip_to_pitch_when].sort() });

export const settingsEqual = (a: PromptSettings, b: PromptSettings) => stable(cleanSettings(a)) === stable(cleanSettings(b));

/** Which parts differ between the saved prompt and the editor. Labels are shown in the save dialog. */
export function changedParts(base: DraftPrompt, edited: DraftPrompt): string[] {
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

export const isDirty = (base: DraftPrompt, edited: DraftPrompt | null) => !!edited && changedParts(base, edited).length > 0;

/** Style-only when nothing but the Style section changed. Raw text changes are treated as substantive: we can't tell. */
export const suggestKind = (parts: string[]): 'style' | 'substantive' => (parts.length > 0 && parts.every((p) => p === 'Style') ? 'style' : 'substantive');

export function slugKey(label: string): string {
  const s = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
  return /^[a-z]/.test(s) ? s : s ? `s_${s}`.slice(0, 30) : '';
}

/** Problems that block saving. Empty array = fine. */
export function validate(d: DraftPrompt): string[] {
  const errs: string[] = [];
  const s = d.settings;
  if (d.editor_mode === 'raw') {
    if (d.body.trim().length < 20) errs.push('Write the prompt (at least a couple of sentences).');
  } else {
    if (!Object.values(d.sections ?? EMPTY_SECTIONS).some((v) => v.trim())) errs.push('Fill in at least one section.');
    if (s.stages.length < 1 || s.stages.length > MAX_STAGES) errs.push(`Keep between 1 and ${MAX_STAGES} stages.`);
    const seen = new Set<string>();
    s.stages.forEach((st, i) => {
      const n = `Stage ${i + 1}`;
      if (!st.label.trim()) errs.push(`${n} needs a name.`);
      if (!STAGE_KEY_RE.test(st.key)) errs.push(`${n}: the key must start with a letter and use 2–30 lowercase letters, digits or underscores.`);
      else if (st.key === 'closing') errs.push(`${n}: "closing" is reserved. Pick another key.`);
      else if (seen.has(st.key)) errs.push(`${n}: another stage already uses the key "${st.key}".`);
      seen.add(st.key);
    });
  }
  const int = (v: number, lo: number, hi: number) => Number.isInteger(v) && v >= lo && v <= hi;
  if (!int(s.min_exchanges_before_pitch, 0, 10)) errs.push('Exchanges before pitching: a whole number from 0 to 10.');
  if (!int(s.max_ai_replies_per_chat, 1, 10)) errs.push('AI replies per chat: a whole number from 1 to 10.');
  if (!int(s.max_length, 100, 1000)) errs.push('Longest reply: a whole number from 100 to 1000 characters.');
  if (!s.languages.length) errs.push('Add at least one language.');
  if (s.languages.some((l) => !LANG_RE.test(l))) errs.push('Languages are 2 or 3 letter codes, like en or hi.');
  return errs;
}

/** Guided body sent with a save or a simulation. The server compiles its own copy from `sections` + `settings`. */
export function compileGuided(sections: PromptSections, settings: PromptSettings): string {
  const parts: string[] = [];
  for (const m of SECTION_META) {
    let text = (sections[m.key] ?? '').trim();
    if (m.key === 'flow') {
      const stages = settings.stages.map((st, i) => `Stage ${i + 1} · ${st.label}${st.pitch ? ' (pitch)' : ''}${st.instructions?.trim() ? `\n${st.instructions.trim()}` : ''}`).join('\n\n');
      text = [text, stages].filter(Boolean).join('\n\n');
    }
    if (text) parts.push(`## ${m.title}\n${text}`);
  }
  return parts.join('\n\n');
}

/** The payload for save / simulate: guided body compiled, strings trimmed. */
export function forSend(d: DraftPrompt): DraftPrompt {
  const settings: PromptSettings = { ...d.settings, stages: d.settings.stages.map((st) => ({ ...cleanStage(st) })) };
  const sections = d.sections ?? EMPTY_SECTIONS;
  return { editor_mode: d.editor_mode, sections, settings, body: d.editor_mode === 'guided' ? compileGuided(sections, settings) : d.body };
}

/** A readable, line-by-line form of a prompt for the version diff. */
export function promptToText(d: DraftPrompt, pipelineStageName?: (id: string) => string | undefined): string {
  const s = d.settings;
  const lines: string[] = [`Editor: ${d.editor_mode === 'raw' ? 'Raw' : 'Guided'}`, ''];
  if (d.editor_mode === 'raw') lines.push(d.body, '');
  else {
    for (const m of SECTION_META) lines.push(`## ${m.title}`, (d.sections?.[m.key] ?? '').trim() || '(empty)', '');
    lines.push('## Stages');
    s.stages.forEach((st, i) => {
      lines.push(`${i + 1}. ${st.label} [${st.key}]${st.early ? ' · early' : ''}${st.pitch ? ' · pitch' : ''}`);
      if (st.instructions?.trim()) lines.push(...st.instructions.trim().split('\n').map((l) => `   ${l}`));
    });
    lines.push('');
  }
  lines.push('## Settings',
    `Exchanges before pitching: ${s.min_exchanges_before_pitch}`,
    `Skip to pitch when: ${s.skip_to_pitch_when.map((f) => FLAG_LABEL[f] ?? f).join(', ') || 'never'}`,
    `Vary the approach in early stages: ${s.vary_moves_in_early_stages ? 'yes' : 'no'}`,
    `AI replies per chat: ${s.max_ai_replies_per_chat}`,
    `Languages: ${s.languages.join(', ')}${s.allow_language_switch ? ' (may switch)' : ''}`,
    `"Are you a bot?": ${s.bot_question === 'disclose' ? 'say it is AI-assisted' : 'hand to a person'}`,
    `Hand over at pipeline stage: ${s.handoff_stage_id ? (pipelineStageName?.(s.handoff_stage_id) ?? s.handoff_stage_id) : 'none'}`,
    `Longest reply: ${s.max_length} characters`);
  return lines.join('\n');
}
