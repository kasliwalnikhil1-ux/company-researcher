// The studio's own Markdown format ("sequence-studio/1"). It reads as a normal document and
// re-imports without loss.
//
//   ---                         Front matter (JSON, which is valid YAML): format, scope, sender,
//   { … }                       signature, settings, variables (+ fallbacks), sample prospects,
//   ---                         categories. Sample values live here, never in the copy.
//   # Library title
//   ## Guidance                 ### <title>            + <!-- studio:block {…} -->
//   ## Sequences                ### Sequence: <name>   + <!-- studio:sequence {…} -->
//                               #### Block: <title>    + <!-- studio:block {…} -->
//                               #### Step N · <name>   + <!-- studio:step {…} -->
//                               **Subject variants**   + <!-- studio:subjects {…} --> + "- " list
//                               ##### Version: <name>  + <!-- studio:version {…} -->
//   ## Reply library            ### Reply: <title>     + <!-- studio:reply {…} -->
//   ## Conversations            ### Conversation: <n>  + <!-- studio:conversation {…} -->
//                               #### …                 + <!-- studio:turn {…} -->
//
// Free text sits between `<!-- studio:text <field> -->` and `<!-- /studio:text -->`, verbatim
// (placeholders, `\$`, hard breaks and headings included). Headings carry names; italic
// `_…_` lines and bold `**…**` label lines are generated descriptions and are ignored on import.
// Any other text found outside those markers is kept as an "unmapped" block, never dropped.

import type {
  Block,
  Category,
  Conversation,
  ImportNote,
  ImportResult,
  Library,
  Profile,
  Reply,
  Sequence,
  Settings,
  Step,
  Turn,
  Variable,
  Version,
} from './types';
import { emptyLibrary } from './importSource';
import { uid, unescapeMd } from './util';

export const FORMAT_ID = 'sequence-studio';
export const FORMAT_VERSION = 1;

interface FrontMatter {
  format: string;
  version: number;
  scope: 'library' | 'sequence';
  title: string;
  exportedAt: string;
  sourceFileName: string;
  sender: Library['sender'];
  senderIsDefault: boolean;
  signature: string;
  signatureIsDefault: boolean;
  settings: Settings;
  variables: Variable[];
  profiles: Profile[];
  activeProfileId: string;
  categories: Category[];
  about: string;
}

const meta = (obj: Record<string, unknown>) => JSON.stringify(obj).replace(/--/g, '-\\u002d');

function textBlock(field: string, text: string): string[] {
  return [`<!-- studio:text ${field} -->`, ...text.split('\n'), '<!-- /studio:text -->'];
}

function strip<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== '')) as Partial<T>;
}

function plainName(text: string): string {
  return unescapeMd(text).replace(/\n/g, ' ');
}

function blockLines(b: Block, owner: 'library' | 'sequence', level: number): string[] {
  const prefix = owner === 'sequence' ? 'Block: ' : '';
  const kindLabel = { guidance: 'Guidance', example: 'Example', note: 'Internal note — not sent', unmapped: 'Unmapped content (kept verbatim)' }[b.kind];
  return [
    `${'#'.repeat(level)} ${prefix}${b.title}`,
    `<!-- studio:block ${meta(strip({ id: b.id, kind: b.kind, owner, origin: b.origin }))} -->`,
    `_${kindLabel}${b.origin ? ` · from: ${b.origin}` : ''}_`,
    '',
    ...textBlock('body', b.body),
    '',
  ];
}

function stepLines(lib: Library, seq: Sequence, st: Step, index: number): string[] {
  const out: string[] = [];
  const from = st.threadMode === 'continue' ? seq.steps.find((s) => s.id === st.continueFromStepId) ?? seq.steps[index - 1] : undefined;
  out.push(`#### Step ${index + 1} · ${st.name}`);
  out.push(
    `<!-- studio:step ${meta(
      strip({
        id: st.id,
        delayDays: st.delayDays,
        delayIsDefault: st.delayIsDefault,
        threadMode: st.threadMode,
        continueFromStepId: st.continueFromStepId,
        threadIsDefault: st.threadIsDefault,
        includeSignature: st.includeSignature,
        quotePrevious: st.quotePrevious,
        selectedSubjectId: st.selectedSubjectId,
        selectedVersionId: st.selectedVersionId,
        origin: st.origin,
      }),
    )} -->`,
  );
  const delay = `${index === 0 ? 'Sent' : 'Sent'} ${st.delayDays} day${st.delayDays === 1 ? '' : 's'} after ${index === 0 ? 'the sequence starts' : 'the previous step'}${st.delayIsDefault ? ' (default added by the tool)' : ''}`;
  const thread = st.threadMode === 'new' ? 'starts a new thread' : `continues the thread of "${from?.name ?? 'the previous step'}" (subject inherited)`;
  out.push(`_${delay} · ${thread}_`, '');
  if (st.subjects.length) {
    const sel = st.subjects.find((s) => s.id === st.selectedSubjectId);
    out.push('**Subject variants**');
    out.push(`<!-- studio:subjects ${meta({ ids: st.subjects.map((s) => s.id), origins: st.subjects.map((s) => s.origin ?? '') })} -->`);
    if (sel) out.push(`_Selected: ${plainName(sel.text)}_`);
    out.push('');
    for (const s of st.subjects) out.push(`- ${s.text}`);
    out.push('');
  }
  for (const v of st.versions) {
    out.push(`##### Version: ${v.name}`);
    out.push(`<!-- studio:version ${meta(strip({ id: v.id, kind: v.kind, subjectId: v.subjectId, origin: v.origin }))} -->`);
    const subj = st.subjects.find((s) => s.id === v.subjectId);
    const bits = [
      { template: 'Template', example: 'Worked example from the source', short: 'Short version' }[v.kind],
      v.id === st.selectedVersionId ? 'selected' : '',
      subj ? `subject: ${plainName(subj.text)}` : '',
    ].filter(Boolean);
    out.push(`_${bits.join(' · ')}_`, '');
    if (v.previewText) out.push('**Preview text**', ...textBlock('previewText', v.previewText), '');
    out.push(...textBlock('body', v.body), '');
  }
  void lib;
  return out;
}

export function exportMarkdown(lib: Library, sequenceId?: string): string {
  const seqs = sequenceId ? lib.sequences.filter((s) => s.id === sequenceId) : lib.sequences;
  const convs = sequenceId ? lib.conversations.filter((c) => c.sequenceId === sequenceId) : lib.conversations;
  const replyIds = new Set(convs.flatMap((c) => c.turns.map((t) => t.replyId).filter(Boolean) as string[]));
  const replies = sequenceId ? lib.replies.filter((r) => replyIds.has(r.id)) : lib.replies;
  const fm: FrontMatter = {
    format: FORMAT_ID,
    version: FORMAT_VERSION,
    scope: sequenceId ? 'sequence' : 'library',
    title: lib.title,
    exportedAt: new Date().toISOString(),
    sourceFileName: lib.sourceFileName,
    sender: lib.sender,
    senderIsDefault: lib.senderIsDefault,
    signature: lib.signature,
    signatureIsDefault: lib.signatureIsDefault,
    settings: lib.settings,
    variables: lib.variables,
    profiles: lib.profiles,
    activeProfileId: lib.activeProfileId,
    categories: lib.categories,
    about:
      'Sequence Studio export. Placeholders like {{company}} are kept as written; sample values, fallbacks and settings live here. <!-- studio:… --> comments carry app metadata and are hidden when the Markdown is rendered.',
  };
  const out: string[] = ['---', JSON.stringify(fm, null, 2), '---', '', `# ${lib.title}`, ''];
  out.push(
    `_Exported from the Sequence Studio${sequenceId ? ` (one sequence: ${seqs[0]?.name ?? ''})` : ''}. Placeholders such as {{company}} are kept as written; sample values are stored in the front matter._`,
    '',
  );

  if (!sequenceId && lib.blocks.length) {
    out.push('## Guidance', '');
    for (const b of lib.blocks) out.push(...blockLines(b, 'library', 3));
  }

  out.push('## Sequences', '');
  for (const seq of seqs) {
    out.push(`### Sequence: ${seq.name}`);
    out.push(`<!-- studio:sequence ${meta(strip({ id: seq.id, origin: seq.origin }))} -->`);
    out.push(`_${seq.steps.length} step${seq.steps.length === 1 ? '' : 's'}${seq.origin ? ` · from: ${seq.origin}` : ''}_`, '');
    if (seq.description) out.push(...textBlock('description', seq.description), '');
    for (const b of seq.blocks) out.push(...blockLines(b, 'sequence', 4));
    seq.steps.forEach((st, i) => out.push(...stepLines(lib, seq, st, i)));
  }

  if (replies.length) {
    out.push('## Reply library', '');
    for (const r of replies) {
      const cat = lib.categories.find((c) => c.id === r.categoryId);
      out.push(`### Reply: ${r.title}`);
      out.push(`<!-- studio:reply ${meta(strip({ id: r.id, categoryId: r.categoryId, categoryIsSuggested: r.categoryIsSuggested, group: r.group, origin: r.origin }))} -->`);
      out.push(`_Category: ${cat?.name ?? 'none'}${r.categoryIsSuggested ? ' (suggested by the tool)' : ''} · Group: ${r.group || '—'}_`, '');
      out.push(...textBlock('body', r.body), '');
      if (r.internalNote) out.push('**Internal note — never sent**', ...textBlock('internalNote', r.internalNote), '');
    }
  }

  if (convs.length) {
    out.push('## Conversations', '');
    for (const c of convs) {
      const seq = lib.sequences.find((s) => s.id === c.sequenceId);
      const stepIndex = seq?.steps.findIndex((s) => s.id === c.afterStepId) ?? -1;
      out.push(`### Conversation: ${c.name}`);
      out.push(`<!-- studio:conversation ${meta(strip({ id: c.id, sequenceId: c.sequenceId, afterStepId: c.afterStepId, connectionIsSuggested: c.connectionIsSuggested }))} -->`);
      out.push(`_Prospect replies after: ${seq?.name ?? '?'} › Step ${stepIndex + 1}${stepIndex >= 0 ? ` · ${seq!.steps[stepIndex].name}` : ''}${c.connectionIsSuggested ? ' (suggested by the tool)' : ''}_`, '');
      for (const t of c.turns) {
        const reply = lib.replies.find((r) => r.id === t.replyId);
        const head = t.role === 'prospect' ? `Prospect${t.sample ? ' (fictional sample)' : ''}` : `Our reply${reply ? ` → ${plainName(reply.title)}` : ''}${t.custom ? ' (custom text)' : ''}`;
        out.push(`#### ${head}`);
        out.push(`<!-- studio:turn ${meta(strip({ id: t.id, role: t.role, replyId: t.replyId, custom: t.custom, sample: t.sample }))} -->`);
        if (t.role === 'prospect' || t.custom) out.push(...textBlock('text', t.text));
        else if (t.text) out.push(...textBlock('text', t.text));
        out.push('');
      }
    }
  }
  // Never collapse blank lines here: text blocks must stay byte-for-byte.
  return out.join('\n');
}

// ── import ──────────────────────────────────────────────────────────────────────────────────

export function isStudioMarkdown(md: string): boolean {
  const fm = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  return !!fm && /"format"\s*:\s*"sequence-studio"|format:\s*sequence-studio/.test(fm[1]);
}

const HEADING = /^(#{1,6})\s+(.*?)\s*$/;
const COMMENT = /^<!-- studio:([a-zA-Z]+)(?: (.*))? -->\s*$/;
const TEXT_OPEN = /^<!-- studio:text ([a-zA-Z]+) -->\s*$/;
const TEXT_CLOSE = /^<!-- \/studio:text -->\s*$/;

export function importStudioMarkdown(md: string, fileName: string): ImportResult {
  const notes: ImportNote[] = [];
  const text = md.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const fmMatch = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  const lib = emptyLibrary();
  lib.sourceFileName = fileName;
  let body = text;
  if (fmMatch) {
    body = text.slice(fmMatch[0].length);
    try {
      const fm = JSON.parse(fmMatch[1]) as Partial<FrontMatter>;
      if (fm.version && fm.version > FORMAT_VERSION) notes.push({ level: 'ambiguous', section: 'front matter', message: `File is format version ${fm.version}; this tool reads version ${FORMAT_VERSION}.` });
      lib.title = fm.title ?? lib.title;
      lib.sourceFileName = fm.sourceFileName || fileName;
      if (fm.sender) lib.sender = fm.sender;
      lib.senderIsDefault = fm.senderIsDefault ?? false;
      if (fm.signature != null) lib.signature = fm.signature;
      lib.signatureIsDefault = fm.signatureIsDefault ?? false;
      if (fm.settings) lib.settings = { ...lib.settings, ...fm.settings };
      lib.variables = fm.variables ?? [];
      lib.profiles = fm.profiles ?? [];
      lib.activeProfileId = fm.activeProfileId ?? lib.profiles[0]?.id ?? '';
      lib.categories = fm.categories ?? [];
      if (fm.scope === 'sequence') notes.push({ level: 'info', section: 'front matter', message: 'This file holds one sequence and its replies.' });
    } catch (e) {
      notes.push({ level: 'ambiguous', section: 'front matter', message: `Front matter is not valid JSON (${(e as Error).message}); settings, variables and sample values were not read.` });
    }
  }

  const lines = body.split('\n');
  let lastHeading = '';
  let seq: Sequence | null = null;
  let step: Step | null = null;
  let conv: Conversation | null = null;
  type Target = { obj: Record<string, unknown>; kind: string };
  let target: Target | null = null;
  let textField: string | null = null;
  let textBuf: string[] = [];
  let subjects: { ids: string[]; origins: string[]; n: number } | null = null;
  let titleSeen = false;
  const stray: { at: string; lines: string[] }[] = [];

  const nameFrom = (prefix: RegExp) => lastHeading.replace(prefix, '');

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (textField) {
      if (TEXT_CLOSE.test(line)) {
        if (target) target.obj[textField] = textBuf.join('\n');
        textField = null;
        textBuf = [];
      } else textBuf.push(line);
      continue;
    }
    const open = TEXT_OPEN.exec(line);
    if (open) {
      textField = open[1];
      textBuf = [];
      if (!target) notes.push({ level: 'ambiguous', section: `line ${i + 1}`, message: 'Text block with no element above it — kept as unmapped content.' });
      if (!target) target = { obj: (lib.blocks[lib.blocks.push({ id: uid('blk'), title: 'Unmapped text', kind: 'unmapped', body: '' }) - 1] as unknown) as Record<string, unknown>, kind: 'block' };
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      subjects = null;
      lastHeading = h[2];
      if (h[1].length === 1 && !titleSeen) {
        lib.title = h[2];
        titleSeen = true;
      }
      continue;
    }
    const c = COMMENT.exec(line);
    if (c) {
      const kind = c[1];
      let m: Record<string, unknown> = {};
      try {
        m = c[2] ? JSON.parse(c[2]) : {};
      } catch {
        notes.push({ level: 'ambiguous', section: `line ${i + 1}`, message: `Could not read studio:${kind} metadata; defaults used.` });
      }
      const id = (m.id as string) || uid(kind.slice(0, 4));
      switch (kind) {
        case 'sequence': {
          seq = { id, name: nameFrom(/^Sequence:\s*/), description: '', steps: [], blocks: [], origin: m.origin as string | undefined };
          lib.sequences.push(seq);
          step = null;
          conv = null;
          target = { obj: seq as unknown as Record<string, unknown>, kind };
          break;
        }
        case 'block': {
          const b: Block = { id, title: nameFrom(m.owner === 'sequence' ? /^Block:\s*/ : /^$/), kind: (m.kind as Block['kind']) ?? 'guidance', body: '', origin: m.origin as string | undefined };
          if (m.owner === 'sequence' && seq) seq.blocks.push(b);
          else lib.blocks.push(b);
          target = { obj: b as unknown as Record<string, unknown>, kind };
          break;
        }
        case 'step': {
          if (!seq) break;
          step = {
            id,
            name: nameFrom(/^Step\s+\d+\s*·\s*/),
            delayDays: Number(m.delayDays ?? 0),
            delayIsDefault: !!m.delayIsDefault,
            threadMode: m.threadMode === 'continue' ? 'continue' : 'new',
            continueFromStepId: m.continueFromStepId as string | undefined,
            threadIsDefault: !!m.threadIsDefault,
            subjects: [],
            selectedSubjectId: m.selectedSubjectId as string | undefined,
            versions: [],
            selectedVersionId: m.selectedVersionId as string | undefined,
            includeSignature: m.includeSignature !== false,
            quotePrevious: m.quotePrevious !== false,
            origin: m.origin as string | undefined,
          };
          seq.steps.push(step);
          target = { obj: step as unknown as Record<string, unknown>, kind };
          break;
        }
        case 'subjects':
          subjects = { ids: (m.ids as string[]) ?? [], origins: (m.origins as string[]) ?? [], n: 0 };
          break;
        case 'version': {
          if (!step) break;
          const v: Version = { id, name: nameFrom(/^Version:\s*/), kind: (m.kind as Version['kind']) ?? 'template', body: '', previewText: '', subjectId: m.subjectId as string | undefined, origin: m.origin as string | undefined };
          step.versions.push(v);
          target = { obj: v as unknown as Record<string, unknown>, kind };
          break;
        }
        case 'reply': {
          const r: Reply = {
            id,
            title: nameFrom(/^Reply:\s*/),
            categoryId: m.categoryId as string | undefined,
            categoryIsSuggested: !!m.categoryIsSuggested,
            group: (m.group as string) ?? '',
            body: '',
            internalNote: '',
            origin: m.origin as string | undefined,
          };
          lib.replies.push(r);
          seq = null;
          step = null;
          target = { obj: r as unknown as Record<string, unknown>, kind };
          break;
        }
        case 'conversation': {
          conv = { id, name: nameFrom(/^Conversation:\s*/), sequenceId: (m.sequenceId as string) ?? '', afterStepId: (m.afterStepId as string) ?? '', connectionIsSuggested: !!m.connectionIsSuggested, turns: [] };
          lib.conversations.push(conv);
          seq = null;
          step = null;
          target = { obj: conv as unknown as Record<string, unknown>, kind };
          break;
        }
        case 'turn': {
          if (!conv) break;
          const t: Turn = { id, role: m.role === 'us' ? 'us' : 'prospect', text: '', replyId: m.replyId as string | undefined, custom: !!m.custom, sample: !!m.sample };
          conv.turns.push(t);
          target = { obj: t as unknown as Record<string, unknown>, kind };
          break;
        }
        default:
          notes.push({ level: 'ambiguous', section: `line ${i + 1}`, message: `Unknown studio:${kind} marker ignored.` });
      }
      continue;
    }
    if (subjects && step) {
      const li = /^\s{0,3}[-*+]\s+(.*)$/.exec(line);
      if (li) {
        const k = subjects.n++;
        step.subjects.push({ id: subjects.ids[k] ?? uid('sub'), text: li[1].replace(/\s+$/, ''), origin: subjects.origins[k] || undefined });
        continue;
      }
    }
    if (!line.trim()) continue;
    if (/^_.*_\s*$/.test(line.trim()) || /^\*\*[^*]+\*\*\s*$/.test(line.trim())) continue;
    const where = lastHeading || '(top)';
    const last = stray[stray.length - 1];
    if (last && last.at === where) last.lines.push(line);
    else stray.push({ at: where, lines: [line] });
  }
  if (textField && target) {
    target.obj[textField] = textBuf.join('\n');
    notes.push({ level: 'ambiguous', section: 'end of file', message: `Text block "${textField}" was not closed; kept everything to the end of the file.` });
  }
  for (const s of stray) {
    lib.blocks.push({ id: uid('blk'), title: `Unmapped text near "${unescapeMd(s.at)}"`, kind: 'unmapped', body: s.lines.join('\n') });
    notes.push({ level: 'kept', section: s.at, message: `${s.lines.length} line(s) outside the studio markers kept as an unmapped block.` });
  }
  const fixes = repairLibrary(lib);
  for (const f of fixes) notes.push({ level: 'ambiguous', section: 'references', message: f });
  notes.unshift({
    level: 'info',
    section: 'file',
    message: `Sequence Studio file: ${lib.sequences.length} sequence(s), ${lib.sequences.reduce((n, s) => n + s.steps.length, 0)} step(s), ${lib.replies.length} replies, ${lib.conversations.length} conversations, ${lib.blocks.length} guidance blocks.`,
  });
  return { format: 'studio', library: lib, notes };
}

/** Fix dangling references after an import or merge. Returns human-readable notes. */
export function repairLibrary(lib: Library): string[] {
  const out: string[] = [];
  if (!lib.profiles.length) lib.profiles.push({ id: uid('prof'), label: 'Sample prospect', recipientName: 'Sample Prospect', recipientEmail: 'prospect@example.com', values: {} });
  if (!lib.profiles.some((p) => p.id === lib.activeProfileId)) lib.activeProfileId = lib.profiles[0].id;
  for (const seq of lib.sequences) {
    seq.steps.forEach((st, i) => {
      if (i === 0 && st.threadMode === 'continue') st.threadMode = 'new';
      if (st.continueFromStepId && !seq.steps.slice(0, i).some((s) => s.id === st.continueFromStepId)) {
        st.continueFromStepId = undefined;
        out.push(`"${seq.name}" › ${st.name}: thread source not found — continues the previous step instead.`);
      }
      if (!st.subjects.some((s) => s.id === st.selectedSubjectId)) st.selectedSubjectId = st.subjects[0]?.id;
      if (!st.versions.some((v) => v.id === st.selectedVersionId)) st.selectedVersionId = st.versions[0]?.id;
      for (const v of st.versions) if (v.subjectId && !st.subjects.some((s) => s.id === v.subjectId)) v.subjectId = undefined;
    });
  }
  for (const r of lib.replies) if (r.categoryId && !lib.categories.some((c) => c.id === r.categoryId)) r.categoryId = undefined;
  for (const c of lib.conversations) {
    const seq = lib.sequences.find((s) => s.id === c.sequenceId) ?? lib.sequences[0];
    if (seq && seq.id !== c.sequenceId) {
      out.push(`Conversation "${c.name}": its sequence was not found — attached to "${seq.name}".`);
      c.sequenceId = seq.id;
    }
    if (seq && !seq.steps.some((s) => s.id === c.afterStepId)) c.afterStepId = seq.steps[0]?.id ?? '';
    for (const t of c.turns)
      if (t.replyId && !lib.replies.some((r) => r.id === t.replyId)) {
        out.push(`Conversation "${c.name}": linked reply missing — turn kept as custom text.`);
        t.replyId = undefined;
        t.custom = true;
      }
  }
  return out;
}

/** Add an imported library to the current one (ids that clash are re-issued). */
export function mergeLibraries(base: Library, add: Library): Library {
  const taken = new Set<string>();
  const collect = (l: Library) => {
    l.sequences.forEach((s) => {
      taken.add(s.id);
      s.steps.forEach((st) => {
        taken.add(st.id);
        st.subjects.forEach((x) => taken.add(x.id));
        st.versions.forEach((v) => taken.add(v.id));
      });
      s.blocks.forEach((b) => taken.add(b.id));
    });
    l.replies.forEach((r) => taken.add(r.id));
    l.conversations.forEach((c) => {
      taken.add(c.id);
      c.turns.forEach((t) => taken.add(t.id));
    });
    l.blocks.forEach((b) => taken.add(b.id));
    l.categories.forEach((c) => taken.add(c.id));
    l.profiles.forEach((p) => taken.add(p.id));
  };
  collect(base);
  const map = new Map<string, string>();
  const re = (id: string | undefined, prefix: string) => {
    if (!id) return id;
    if (map.has(id)) return map.get(id)!;
    const next = taken.has(id) ? uid(prefix) : id;
    map.set(id, next);
    taken.add(next);
    return next;
  };
  const out: Library = JSON.parse(JSON.stringify(base));
  // Categories: reuse by name.
  for (const c of add.categories) {
    const same = out.categories.find((x) => x.name.toLowerCase() === c.name.toLowerCase());
    if (same) map.set(c.id, same.id);
    else out.categories.push({ ...c, id: re(c.id, 'cat')! });
  }
  for (const v of add.variables) if (!out.variables.some((x) => x.name === v.name)) out.variables.push({ ...v });
  for (const p of add.profiles) {
    const same = out.profiles.find((x) => x.id === p.id || x.label === p.label);
    if (same) for (const [k, val] of Object.entries(p.values)) if (!(k in same.values)) same.values[k] = val;
  }
  for (const s of add.sequences) {
    const ns: Sequence = JSON.parse(JSON.stringify(s));
    ns.id = re(s.id, 'seq')!;
    ns.blocks.forEach((b) => (b.id = re(b.id, 'blk')!));
    ns.steps.forEach((st) => {
      st.id = re(st.id, 'step')!;
      st.subjects.forEach((x) => (x.id = re(x.id, 'sub')!));
      st.versions.forEach((v) => (v.id = re(v.id, 'ver')!));
    });
    ns.steps.forEach((st) => {
      st.continueFromStepId = st.continueFromStepId ? map.get(st.continueFromStepId) ?? st.continueFromStepId : undefined;
      st.selectedSubjectId = st.selectedSubjectId ? map.get(st.selectedSubjectId) ?? st.selectedSubjectId : undefined;
      st.selectedVersionId = st.selectedVersionId ? map.get(st.selectedVersionId) ?? st.selectedVersionId : undefined;
      st.versions.forEach((v) => (v.subjectId = v.subjectId ? map.get(v.subjectId) ?? v.subjectId : undefined));
    });
    out.sequences.push(ns);
  }
  for (const r of add.replies) out.replies.push({ ...r, id: re(r.id, 'rep')!, categoryId: r.categoryId ? map.get(r.categoryId) ?? r.categoryId : undefined });
  for (const c of add.conversations)
    out.conversations.push({
      ...c,
      id: re(c.id, 'conv')!,
      sequenceId: map.get(c.sequenceId) ?? c.sequenceId,
      afterStepId: map.get(c.afterStepId) ?? c.afterStepId,
      turns: c.turns.map((t) => ({ ...t, id: re(t.id, 'turn')!, replyId: t.replyId ? map.get(t.replyId) ?? t.replyId : undefined })),
    });
  for (const b of add.blocks) out.blocks.push({ ...b, id: re(b.id, 'blk')! });
  repairLibrary(out);
  return out;
}

export function importMarkdown(md: string, fileName: string, importSource: (md: string, f: string) => ImportResult): ImportResult {
  return isStudioMarkdown(md) ? importStudioMarkdown(md, fileName) : importSource(md, fileName);
}
