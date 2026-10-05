// Heuristic importer for free-form outbound Markdown (the shape of
// outbound-sequences-reply-library.md). It maps what it recognises into sequences, steps,
// versions, replies and guidance, keeps every other section verbatim as an editable block, and
// returns notes describing each judgement call so the user can review them before applying.

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
  Step,
  SubjectVariant,
  Version,
} from './types';
import {
  DEFAULT_CATEGORIES,
  DEFAULT_SENDER,
  DEFAULT_SIGNATURE,
  LONG_PROFILE,
  SHORT_PROFILE,
  TIMING_CATEGORY,
  sampleProspectMessage,
  suggestCategoryName,
} from './samples';
import { tokenNames } from './variables';
import { normKey, todayAt, uid, unescapeMd } from './util';

interface Sec {
  level: number;
  title: string;
  lines: string[];
  children: Sec[];
  path: string;
}

/** Defaults the tool uses because the source gives no timings. */
export const DEFAULT_DELAYS = [0, 3, 4, 7];
export function defaultDelay(index: number): number {
  return DEFAULT_DELAYS[Math.min(index, DEFAULT_DELAYS.length - 1)];
}

// ── section tree ────────────────────────────────────────────────────────────────────────────

function parseSections(md: string): Sec {
  const root: Sec = { level: 0, title: '', lines: [], children: [], path: '' };
  const stack: Sec[] = [root];
  let fence: string | null = null;
  for (const line of md.replace(/\r\n?/g, '\n').split('\n')) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) fence = fence === null ? f[1][0] : fence === f[1][0] ? null : fence;
    const h = fence === null ? /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line) : null;
    if (h && !f) {
      const level = h[1].length;
      while (stack[stack.length - 1].level >= level) stack.pop();
      const parent = stack[stack.length - 1];
      const title = h[2];
      const sec: Sec = {
        level,
        title,
        lines: [],
        children: [],
        path: parent.path ? `${parent.path} › ${unescapeMd(title)}` : unescapeMd(title),
      };
      parent.children.push(sec);
      stack.push(sec);
    } else stack[stack.length - 1].lines.push(line);
  }
  return root;
}

const RULE_RE = /^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/;

/** Own content of a section with separators and outer blank lines removed. */
function own(sec: Sec): string {
  return trimBlank(sec.lines.filter((l) => !RULE_RE.test(l)));
}

function trimBlank(lines: string[]): string {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a += 1;
  while (b > a && !lines[b - 1].trim()) b -= 1;
  return lines.slice(a, b).join('\n');
}

/** Section re-serialised as Markdown (own content plus sub-sections, original heading levels). */
function full(sec: Sec, includeHeading = false): string {
  const parts: string[] = [];
  if (includeHeading) parts.push(`${'#'.repeat(sec.level)} ${sec.title}`);
  const o = own(sec);
  if (o) parts.push(o);
  for (const c of sec.children) parts.push(full(c, true));
  return parts.join('\n\n');
}

const LIST_ITEM = /^\s{0,3}[-*+]\s+(.*)$/;

// ── matching helpers ────────────────────────────────────────────────────────────────────────

const STOP = new Set(['you', 'they', 'their', 'the', 'a', 'an', 'are', 'what', 'only', 'if', 'i', 'we', 'your', 'do', 'is', 'of', 'to', 'for', 'and', 'option', '1', '2', '3', '4', '5']);
const SYN: Record<string, string> = { known: 'know', sell: 'product', sells: 'product', products: 'product', launches: 'launch', ads: 'ad' };

function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of normKey(text).split(' ')) {
    if (!w || STOP.has(w)) continue;
    out.add(SYN[w] ?? w);
  }
  return out;
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n += 1;
  return n;
}

function seqText(seq: Sequence): string {
  return seq.steps.map((s) => s.versions.map((v) => v.body).join(' ') + s.subjects.map((x) => x.text).join(' ')).join(' ');
}

/** Best sequence for a short version / default label, by title words + shared placeholders. */
function matchSequence(label: string, body: string, seqs: Sequence[]): { seq?: Sequence; confident: boolean } {
  const lt = tokens(label);
  const vars = new Set(tokenNames(body));
  const scored = seqs
    .map((seq) => {
      const st = tokens(seq.name);
      const sv = new Set(tokenNames(seqText(seq)));
      let shared = 0;
      for (const v of vars) if (sv.has(v) && v !== 'first_name') shared += 1;
      return { seq, score: overlap(lt, st) * 2 + shared * 2 };
    })
    .sort((a, b) => b.score - a.score);
  if (!scored.length || scored[0].score === 0) return { confident: false };
  return { seq: scored[0].seq, confident: scored.length === 1 || scored[0].score > scored[1].score };
}

// ── builders ────────────────────────────────────────────────────────────────────────────────

function block(title: string, body: string, kind: Block['kind'], origin: string): Block {
  return { id: uid('blk'), title, kind, body, origin };
}

function newStep(name: string, index: number, origin: string): Step {
  return {
    id: uid('step'),
    name,
    delayDays: defaultDelay(index),
    delayIsDefault: true,
    threadMode: index === 0 ? 'new' : 'continue',
    threadIsDefault: index > 0,
    subjects: [],
    versions: [],
    includeSignature: true,
    quotePrevious: true,
    origin,
  };
}

function newVersion(name: string, body: string, kind: Version['kind'], origin: string): Version {
  return { id: uid('ver'), name, kind, body, previewText: '', origin };
}

/** Split `**Subject:** text` off the top of a message body. */
function takeSubject(text: string): { subject?: string; body: string } {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.trim());
  const m = i >= 0 ? /^\s*\*\*Subject:?\*\*:?\s*(.+?)\s*$/i.exec(lines[i]) : null;
  if (!m) return { body: text };
  return { subject: m[1], body: trimBlank(lines.slice(i + 1)) };
}

function addSubject(step: Step, text: string, origin: string): SubjectVariant {
  const existing = step.subjects.find((s) => s.text === text);
  if (existing) return existing;
  const s = { id: uid('sub'), text, origin };
  step.subjects.push(s);
  return s;
}

const MESSAGE_RE = /^(message|email|initial|opener|first email)\b/i;
const FOLLOW_RE = /^(follow[\s-]?up|bump|break[\s-]?up|close the loop)\b/i;
const EXAMPLE_RE = /^example\b/i;
const SUBJECTS_RE = /^subject( line)?s?( options?| ideas)?$/i;

function buildOptionSequence(sec: Sec, notes: ImportNote[]): Sequence {
  const seq: Sequence = { id: uid('seq'), name: sec.title, description: own(sec), steps: [], blocks: [], origin: sec.path };
  let pendingSubjects: { text: string; origin: string }[] = [];
  for (const child of sec.children) {
    const title = unescapeMd(child.title);
    if (SUBJECTS_RE.test(title.trim())) {
      const lines = own(child).split('\n');
      let i = 0;
      for (; i < lines.length; i += 1) {
        const m = LIST_ITEM.exec(lines[i]);
        if (m) pendingSubjects.push({ text: m[1].trim(), origin: child.path });
        else if (lines[i].trim()) break;
      }
      const rest = trimBlank(lines.slice(i));
      if (rest) {
        const label = /^([^\n]+?):\s*\n/.exec(rest + '\n');
        const title2 = label && !LIST_ITEM.test(label[1]) ? label[1].trim() : 'Notes';
        const body = label && !LIST_ITEM.test(label[1]) ? trimBlank(rest.split('\n').slice(1)) : rest;
        seq.blocks.push(block(title2, body, /example/i.test(title2) ? 'example' : 'guidance', `${child.path} › ${title2}`));
        notes.push({
          level: 'info',
          section: child.path,
          message: `"${title2}" list after the subject lines kept as a supporting ${/example/i.test(title2) ? 'example' : 'guidance'} block of the sequence.`,
        });
      }
      for (const c of child.children) {
        seq.blocks.push(block(unescapeMd(c.title), full(c), 'guidance', c.path));
        notes.push({ level: 'kept', section: c.path, message: 'Unrecognised sub-section kept as a guidance block.' });
      }
      if (seq.steps[0]) {
        for (const s of pendingSubjects) addSubject(seq.steps[0], s.text, s.origin);
        pendingSubjects = [];
      }
      continue;
    }
    if (EXAMPLE_RE.test(title) && seq.steps.length) {
      const step = seq.steps[seq.steps.length - 1];
      step.versions.push(newVersion(title, full(child), 'example', child.path));
      notes.push({ level: 'info', section: child.path, message: `Worked example kept as a selectable "example" version of "${step.name}".` });
      continue;
    }
    if (MESSAGE_RE.test(title) || FOLLOW_RE.test(title)) {
      const step = newStep(title, seq.steps.length, child.path);
      const { subject, body } = takeSubject(full(child));
      if (subject) step.selectedSubjectId = addSubject(step, subject, child.path).id;
      step.versions.push(newVersion(title, body, 'template', child.path));
      if (seq.steps.length === 0) for (const s of pendingSubjects.splice(0)) addSubject(step, s.text, s.origin);
      seq.steps.push(step);
      continue;
    }
    seq.blocks.push(block(title, full(child), 'guidance', child.path));
    notes.push({ level: 'ambiguous', section: child.path, message: 'Not recognised as a message, follow-up, example or subject list — kept as a guidance block of the sequence.' });
  }
  if (pendingSubjects.length) {
    seq.blocks.push(block('Subject Line Options', pendingSubjects.map((s) => `- ${s.text}`).join('\n'), 'guidance', sec.path));
    notes.push({ level: 'ambiguous', section: sec.path, message: 'Subject lines found but no message to attach them to — kept as a block.' });
  }
  for (const st of seq.steps) {
    st.selectedSubjectId ??= st.subjects[0]?.id;
    st.selectedVersionId = st.versions[0]?.id;
  }
  if (seq.steps.length > 1)
    notes.push({
      level: 'info',
      section: sec.path,
      message: `Follow-ups set to continue the first email's thread and given default delays (${seq.steps.map((s) => s.delayDays).join(', ')} days). The source specifies neither; both are labelled as tool defaults.`,
    });
  return seq;
}

/** A sequence whose steps are `## Email N` sections with optional `### Version X` children. */
function buildEmailSequence(sec: Sec, notes: ImportNote[]): Sequence {
  const seq: Sequence = { id: uid('seq'), name: sec.title, description: own(sec), steps: [], blocks: [], origin: sec.path };
  for (const child of sec.children) {
    const title = unescapeMd(child.title);
    if (!/^email\s*\d+/i.test(title) && !MESSAGE_RE.test(title) && !FOLLOW_RE.test(title)) {
      seq.blocks.push(block(title, full(child), 'guidance', child.path));
      notes.push({ level: 'info', section: child.path, message: 'Kept as a guidance block of the sequence.' });
      continue;
    }
    const step = newStep(title, seq.steps.length, child.path);
    step.threadIsDefault = false;
    const versionSecs = child.children.filter((c) => /^version\b/i.test(unescapeMd(c.title)));
    const parts: { name: string; text: string; origin: string }[] = versionSecs.length
      ? versionSecs.map((v) => ({ name: unescapeMd(v.title), text: full(v), origin: v.path }))
      : [{ name: title, text: own(child), origin: child.path }];
    if (versionSecs.length && own(child)) {
      seq.blocks.push(block(`${title} — notes`, own(child), 'guidance', child.path));
      notes.push({ level: 'ambiguous', section: child.path, message: 'Text above the versions kept as a guidance block.' });
    }
    for (const c of child.children.filter((c) => !versionSecs.includes(c))) {
      seq.blocks.push(block(unescapeMd(c.title), full(c), 'guidance', c.path));
      notes.push({ level: 'ambiguous', section: c.path, message: 'Unrecognised sub-section kept as a guidance block.' });
    }
    for (const p of parts) {
      const { subject, body } = takeSubject(p.text);
      const v = newVersion(p.name, body, 'template', p.origin);
      if (subject) v.subjectId = addSubject(step, subject, p.origin).id;
      step.versions.push(v);
    }
    step.selectedVersionId = step.versions[0]?.id;
    step.selectedSubjectId = step.versions[0]?.subjectId ?? step.subjects[0]?.id;
    // Threading: a "Re: <earlier subject>" subject means the source shows it as a reply in that
    // thread. Anything else starts a new thread.
    const subj = step.subjects.find((s) => s.id === step.selectedSubjectId)?.text ?? '';
    const re = /^re:\s*(.+)$/i.exec(subj);
    if (seq.steps.length === 0) step.threadMode = 'new';
    else if (re) {
      const target = [...seq.steps].reverse().find((s) => s.subjects.some((x) => x.text === re[1]));
      step.threadMode = target ? 'continue' : 'new';
      step.continueFromStepId = undefined;
      if (target)
        notes.push({ level: 'info', section: child.path, message: `Continues the thread of "${target.name}" (source subject is "Re:" + its subject). The subject is now inherited; the "Re:" line is kept as an unused variant.` });
      else {
        step.threadIsDefault = true;
        notes.push({ level: 'ambiguous', section: child.path, message: `Subject starts with "Re:" but matches no earlier subject — set to start a new thread with that subject.` });
      }
    } else {
      step.threadMode = 'new';
      notes.push({ level: 'info', section: child.path, message: `Independent subject "${subj}" — set to start a new thread.` });
    }
    seq.steps.push(step);
  }
  notes.push({ level: 'info', section: sec.path, message: `Default delays added (${seq.steps.map((s) => s.delayDays).join(', ')} days); the source gives no timings.` });
  return seq;
}

function splitNote(body: string): { body: string; note: string } {
  const paras = body.split(/\n\s*\n/);
  const keep: string[] = [];
  const notes: string[] = [];
  for (const p of paras) {
    const t = p.trim();
    if (/^\*[^*\s][\s\S]*[^*\s]\*$/.test(t) || /^_[^_\s][\s\S]*[^_\s]_$/.test(t) || /^(internal|note)\s*:/i.test(t)) notes.push(t);
    else keep.push(p);
  }
  return { body: trimBlank(keep.join('\n\n').split('\n')), note: notes.join('\n\n') };
}

// ── main ────────────────────────────────────────────────────────────────────────────────────

export function emptyLibrary(): Library {
  return {
    title: 'Outbound library',
    sender: { ...DEFAULT_SENDER },
    senderIsDefault: true,
    signature: DEFAULT_SIGNATURE,
    signatureIsDefault: true,
    variables: [],
    profiles: [],
    activeProfileId: '',
    categories: [],
    sequences: [],
    replies: [],
    conversations: [],
    blocks: [],
    settings: { stopOnReply: true, startAt: todayAt(9, 14), bodyFormat: 'html', replyAfterHours: 5, answerAfterHours: 1 },
    sourceFileName: '',
  };
}

type Kind = 'sequences' | 'email-sequence' | 'short-versions' | 'replies' | 'framework' | 'guidance';

function classify(sec: Sec): Kind {
  const title = unescapeMd(sec.title);
  const kids = sec.children.map((c) => unescapeMd(c.title));
  if (/framework|principle|guidance|which opening|how to use/i.test(title)) return /framework/i.test(title) ? 'framework' : 'guidance';
  if (/shorter|short versions|high[- ]volume/i.test(title)) return 'short-versions';
  if (kids.some((k) => /^email\s*\d+/i.test(k))) return 'email-sequence';
  if (sec.children.some((c) => c.children.some((g) => MESSAGE_RE.test(unescapeMd(g.title)) || FOLLOW_RE.test(unescapeMd(g.title))))) return 'sequences';
  if (/repl|payment|rights|confidential|closing|next steps|objection|responses|faq/i.test(title) && sec.children.length) return 'replies';
  return 'guidance';
}

export function importSourceMarkdown(md: string, fileName: string): ImportResult {
  const notes: ImportNote[] = [];
  const lib = emptyLibrary();
  lib.sourceFileName = fileName;
  const root = parseSections(md);
  if (own(root)) {
    lib.blocks.push(block('Preamble', own(root), 'guidance', '(before the first heading)'));
    notes.push({ level: 'kept', section: '(top of file)', message: 'Text before the first heading kept as a guidance block.' });
  }

  let tops = root.children;
  // A single leading H1 whose children are ordinary sections is the document title.
  if (tops[0]?.level === 1) {
    lib.title = unescapeMd(tops[0].title);
    const first = tops[0];
    const firstKind = classify(first);
    // The title section's own sub-sections are guidance unless they are clearly sequences.
    if (firstKind !== 'sequences' && firstKind !== 'email-sequence' && firstKind !== 'short-versions') {
      if (own(first)) lib.blocks.push(block('Introduction', own(first), 'guidance', first.path));
      for (const c of first.children) lib.blocks.push(block(unescapeMd(c.title), full(c), 'guidance', c.path));
      notes.push({ level: 'info', section: first.path, message: `Used as the library title; its ${first.children.length} sub-section(s) kept as guidance.` });
      tops = tops.slice(1);
    }
  }

  const shortSecs: Sec[] = [];
  let frameworkCats: Category[] = [];
  const replySecs: Sec[] = [];

  for (const sec of tops) {
    const kind = classify(sec);
    const title = unescapeMd(sec.title);
    if (kind === 'sequences') {
      if (own(sec)) lib.blocks.push(block(title, own(sec), 'guidance', sec.path));
      for (const c of sec.children) {
        if (c.children.some((g) => MESSAGE_RE.test(unescapeMd(g.title)) || FOLLOW_RE.test(unescapeMd(g.title)))) {
          lib.sequences.push(buildOptionSequence(c, notes));
        } else {
          lib.blocks.push(block(unescapeMd(c.title), full(c), 'guidance', c.path));
          notes.push({ level: 'kept', section: c.path, message: 'No messages found — kept as a guidance block.' });
        }
      }
      notes.push({ level: 'info', section: sec.path, message: `Imported as ${sec.children.length} sequence(s).` });
    } else if (kind === 'email-sequence') {
      lib.sequences.push(buildEmailSequence(sec, notes));
    } else if (kind === 'short-versions') {
      shortSecs.push(sec);
    } else if (kind === 'replies') {
      replySecs.push(sec);
    } else if (kind === 'framework') {
      lib.blocks.push(block(title, full(sec), 'guidance', sec.path));
      const found: Category[] = [];
      const walk = (s: Sec) => {
        for (const c of s.children) {
          const m = /^\d+[.)]\s*(.+)$/.exec(unescapeMd(c.title));
          if (m) found.push({ id: uid('cat'), name: m[1].trim(), description: own(c), addedByTool: false });
          walk(c);
        }
      };
      walk(sec);
      if (found.length) {
        frameworkCats = found;
        notes.push({ level: 'info', section: sec.path, message: `Kept as guidance. Its ${found.length} numbered buckets (${found.map((f) => f.name).join(', ')}) became the reply categories.` });
      }
    } else {
      lib.blocks.push(block(title, full(sec), 'guidance', sec.path));
      notes.push({ level: 'info', section: sec.path, message: 'Kept as a guidance block (not email content).' });
    }
  }

  // Shorter versions → alternative "short" versions on step 1 of the matching sequence.
  for (const sec of shortSecs) {
    const intro = own(sec);
    if (intro) lib.blocks.push(block(`${unescapeMd(sec.title)} — intro`, intro, 'guidance', sec.path));
    for (const c of sec.children) {
      const name = unescapeMd(c.title);
      const body = full(c);
      const m = matchSequence(name, body, lib.sequences);
      if (m.seq && m.seq.steps[0]) {
        m.seq.steps[0].versions.push(newVersion(`Short version: ${name}`, body, 'short', c.path));
        notes.push({
          level: m.confident ? 'info' : 'ambiguous',
          section: c.path,
          message: `Added as a selectable "short" version of Step 1 in "${m.seq.name}"${m.confident ? '' : ' (closest match — please check)'}.`,
        });
      } else {
        lib.blocks.push(block(name, body, 'unmapped', c.path));
        notes.push({ level: 'ambiguous', section: c.path, message: 'Could not match this short version to a sequence — kept as an unmapped block.' });
      }
    }
  }

  // Best Defaults: "- **Label:** `subject`" pre-selects the subject in the sequence that has it.
  const bestDefaults = [...lib.blocks].flatMap((b) => [...b.body.matchAll(/^\s*[-*]\s+\*\*([^*]+?):?\*\*:?\s*`([^`]+)`/gm)].map((m) => ({ label: m[1], subject: m[2], origin: b.title })));
  for (const d of bestDefaults) {
    const hits = lib.sequences.filter((s) => s.steps[0]?.subjects.some((x) => x.text === d.subject));
    if (hits.length === 1) {
      const st = hits[0].steps[0];
      st.selectedSubjectId = st.subjects.find((x) => x.text === d.subject)!.id;
      notes.push({ level: 'info', section: d.origin, message: `"${d.subject}" pre-selected as the subject of "${hits[0].name}" (listed under Best Defaults for "${d.label}").` });
    }
  }

  // Categories.
  lib.categories = frameworkCats.length ? frameworkCats : DEFAULT_CATEGORIES.map((c) => ({ ...c, id: uid('cat') }));
  if (!frameworkCats.length) notes.push({ level: 'info', section: '(categories)', message: 'No reply framework found — default categories added.' });

  // Replies.
  const recommended = lib.sequences.find((s) => /recommended/i.test(s.name)) ?? lib.sequences[0];
  let timingUsed = false;
  for (const sec of replySecs) {
    const group = unescapeMd(sec.title);
    if (own(sec)) lib.blocks.push(block(`${group} — intro`, own(sec), 'guidance', sec.path));
    for (const c of sec.children) {
      const { body, note } = splitNote(own(c));
      const reply: Reply = {
        id: uid('rep'),
        title: c.title,
        categoryIsSuggested: true,
        group,
        body,
        internalNote: note,
        origin: c.path,
      };
      if (c.children.length) {
        reply.body = [reply.body, ...c.children.map((g) => full(g, true))].filter(Boolean).join('\n\n');
        notes.push({ level: 'ambiguous', section: c.path, message: 'Sub-headings inside this reply were appended to its body.' });
      }
      if (note) notes.push({ level: 'info', section: c.path, message: `Italic line moved to the internal note (never shown in previews): ${note}` });
      const catName = suggestCategoryName(c.title);
      let cat = lib.categories.find((x) => normKey(x.name) === normKey(catName));
      if (!cat && catName === TIMING_CATEGORY.name) {
        cat = { ...TIMING_CATEGORY, id: uid('cat') };
        lib.categories.push(cat);
        timingUsed = true;
      }
      reply.categoryId = (cat ?? lib.categories[0])?.id;
      lib.replies.push(reply);
    }
    notes.push({ level: 'info', section: sec.path, message: `Imported ${sec.children.length} replies (group "${group}"). Categories were suggested by the tool from each title.` });
  }
  if (timingUsed) notes.push({ level: 'info', section: '(categories)', message: `"${TIMING_CATEGORY.name}" category added by the tool for timing / not-interested replies.` });

  // One conversation per reply, prompted by a suggested step of the recommended sequence.
  if (recommended?.steps.length) {
    const steps = recommended.steps;
    const pick = (r: Reply): Step => {
      const cat = lib.categories.find((c) => c.id === r.categoryId)?.name ?? '';
      if (/timing/i.test(cat)) return steps[steps.length - 1];
      if (/quality/i.test(cat) || /sample/i.test(normKey(r.title))) return steps[Math.min(2, steps.length - 1)];
      return steps[0];
    };
    for (const r of lib.replies) {
      const c: Conversation = {
        id: uid('conv'),
        name: unescapeMd(r.title),
        sequenceId: recommended.id,
        afterStepId: pick(r).id,
        connectionIsSuggested: true,
        turns: [
          { id: uid('turn'), role: 'prospect', text: sampleProspectMessage(r.title), custom: false, sample: true },
          { id: uid('turn'), role: 'us', text: '', replyId: r.id, custom: false, sample: false },
        ],
      };
      lib.conversations.push(c);
    }
    if (lib.replies.length)
      notes.push({
        level: 'info',
        section: '(conversations)',
        message: `Created ${lib.replies.length} reply branches on "${recommended.name}" with fictional prospect messages (marked as samples). The prompting step was suggested by the tool.`,
      });
  }

  // Variables + sample prospects.
  const names: string[] = [];
  const see = (t: string) => {
    for (const n of tokenNames(t)) if (!names.includes(n)) names.push(n);
  };
  for (const s of lib.sequences) {
    see(s.description);
    s.blocks.forEach((b) => see(b.body));
    for (const st of s.steps) {
      st.subjects.forEach((x) => see(x.text));
      st.versions.forEach((v) => see(v.body));
    }
  }
  lib.replies.forEach((r) => see(r.body));
  lib.blocks.forEach((b) => see(b.body));
  lib.variables = names.map((name) => ({ name, fallback: '', description: '' }));
  const mk = (p: Omit<Profile, 'id'>): Profile => ({
    ...p,
    id: uid('prof'),
    values: Object.fromEntries(names.filter((n) => p.values[n] != null).map((n) => [n, p.values[n]])),
  });
  lib.profiles = [mk(SHORT_PROFILE), mk(LONG_PROFILE)];
  lib.activeProfileId = lib.profiles[0].id;
  notes.push({ level: 'info', section: '(variables)', message: `Found ${names.length} placeholders: ${names.map((n) => `{{${n}}}`).join(', ')}. Short and long fictional sample prospects added; fallbacks left empty.` });
  if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/m.test(md)) notes.push({ level: 'info', section: '(layout)', message: 'Horizontal rules were treated as section separators.' });

  return { format: 'source', library: lib, notes };
}
