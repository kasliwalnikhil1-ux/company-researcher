import type { Library, Profile, Variable } from './types';

// Placeholders are `{{ anything except braces }}`, so names like `product/category` work.
export const TOKEN_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

export function tokenNames(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(TOKEN_RE)) out.push(m[1]);
  return out;
}

export type VarStatus = 'sample' | 'fallback' | 'missing';

export type Segment =
  | { type: 'text'; text: string }
  | { type: 'var'; name: string; raw: string; value: string; status: VarStatus };

export interface ResolveContext {
  profile?: Profile;
  variables: Variable[];
}

export function resolveVar(name: string, ctx: ResolveContext): { value: string; status: VarStatus } {
  const sample = ctx.profile?.values[name];
  if (sample != null && sample.trim() !== '') return { value: sample, status: 'sample' };
  const fallback = ctx.variables.find((v) => v.name === name)?.fallback ?? '';
  if (fallback.trim() !== '') return { value: fallback, status: 'fallback' };
  return { value: '', status: 'missing' };
}

export function segments(text: string, ctx: ResolveContext): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ type: 'text', text: text.slice(last, at) });
    const r = resolveVar(m[1], ctx);
    out.push({ type: 'var', name: m[1], raw: m[0], value: r.value, status: r.status });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}

/** Resolved string. Missing values stay as the raw `{{name}}` token — never invented. */
export function resolveText(text: string, ctx: ResolveContext): string {
  return segments(text, ctx)
    .map((s) => (s.type === 'text' ? s.text : s.status === 'missing' ? s.raw : s.value))
    .join('');
}

export function missingIn(text: string, ctx: ResolveContext): string[] {
  const out = new Set<string>();
  for (const s of segments(text, ctx)) if (s.type === 'var' && s.status === 'missing') out.add(s.name);
  return [...out];
}

/** Every text field in the library that can hold placeholders, with a label for usage lists. */
export function eachText(lib: Library, visit: (text: string, where: string) => void) {
  for (const seq of lib.sequences) {
    visit(seq.description, `${seq.name} › description`);
    for (const b of seq.blocks) visit(b.body, `${seq.name} › ${b.title}`);
    seq.steps.forEach((st, i) => {
      for (const s of st.subjects) visit(s.text, `${seq.name} › Step ${i + 1} subject`);
      for (const v of st.versions) {
        visit(v.body, `${seq.name} › Step ${i + 1} › ${v.name}`);
      }
    });
  }
  for (const r of lib.replies) {
    visit(r.body, `Reply › ${r.title}`);
    visit(r.internalNote, `Reply › ${r.title} (internal note)`);
  }
  for (const c of lib.conversations) for (const t of c.turns) visit(t.text, `Conversation › ${c.name}`);
  for (const b of lib.blocks) visit(b.body, `Guidance › ${b.title}`);
  visit(lib.signature, 'Signature');
}

export interface VariableUsage {
  name: string;
  count: number;
  places: string[];
  declared: boolean;
}

/** Declared variables plus every placeholder found in the library, in first-seen order. */
export function variableUsage(lib: Library): VariableUsage[] {
  const map = new Map<string, VariableUsage>();
  for (const v of lib.variables) map.set(v.name, { name: v.name, count: 0, places: [], declared: true });
  eachText(lib, (text, where) => {
    for (const name of tokenNames(text)) {
      let u = map.get(name);
      if (!u) {
        u = { name, count: 0, places: [], declared: false };
        map.set(name, u);
      }
      u.count += 1;
      if (!u.places.includes(where)) u.places.push(where);
    }
  });
  return [...map.values()];
}

function renameIn(text: string, from: string, to: string): string {
  return text.replace(TOKEN_RE, (raw, name: string) => (name === from ? `{{${to}}}` : raw));
}

/** Rename a variable everywhere: every placeholder, its declaration and the sample values. */
export function renameVariable(lib: Library, from: string, to: string) {
  const r = (t: string) => renameIn(t, from, to);
  for (const seq of lib.sequences) {
    seq.description = r(seq.description);
    for (const b of seq.blocks) b.body = r(b.body);
    for (const st of seq.steps) {
      for (const s of st.subjects) s.text = r(s.text);
      for (const v of st.versions) {
        v.body = r(v.body);
        v.previewText = r(v.previewText);
      }
    }
  }
  for (const rep of lib.replies) {
    rep.body = r(rep.body);
    rep.internalNote = r(rep.internalNote);
  }
  for (const c of lib.conversations) for (const t of c.turns) t.text = r(t.text);
  for (const b of lib.blocks) b.body = r(b.body);
  lib.signature = r(lib.signature);
  const existing = lib.variables.find((v) => v.name === to);
  const decl = lib.variables.find((v) => v.name === from);
  if (decl && !existing) decl.name = to;
  else if (decl && existing) lib.variables = lib.variables.filter((v) => v !== decl);
  else if (!decl && !existing) lib.variables.push({ name: to, fallback: '', description: '' });
  for (const p of lib.profiles) {
    if (from in p.values) {
      if (!(to in p.values) || !p.values[to]) p.values[to] = p.values[from];
      delete p.values[from];
    }
  }
}

export function ensureDeclared(lib: Library, name: string): Variable {
  let v = lib.variables.find((x) => x.name === name);
  if (!v) {
    v = { name, fallback: '', description: '' };
    lib.variables.push(v);
  }
  return v;
}
