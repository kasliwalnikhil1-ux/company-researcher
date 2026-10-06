// Private-note composer ↔ markdown. The composer edits formatted text (like a word processor); the note is still
// stored as the markdown subset NoteBody renders: **bold**, _italic_, `code`, [text](https://…), "- " / "1. " lists,
// one line per line. Mentions are chips in the editor and "@Name" in the markdown (encodeMentions turns them into
// tokens on submit, exactly as before).

export const NOTE_CHIP_CLASS = 'inline-flex items-center rounded px-1 py-px text-[0.92em] font-medium align-baseline bg-amber-100 text-amber-900 select-all';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function chipHtml(name: string, userId: string): string {
  return `<span contenteditable="false" data-mention-name="${esc(name)}" data-mention-id="${esc(userId)}" class="${NOTE_CHIP_CLASS}">@${esc(name)}</span>`;
}

// ---------------------------------------------------------------------------------------------- markdown → HTML

function inlineHtml(text: string, mentionRe: RegExp | null, byName: Map<string, string>): string {
  const parts = [
    mentionRe ? mentionRe.source : '(?!)',                       // 1 picked mention name
    '(`[^`\\n]+`)',                                               // 2 code
    '(\\*\\*[^*\\n]+?\\*\\*)',                                    // 3 bold
    '(?<![\\w*])(\\*[^*\\s](?:[^*\\n]*?[^*\\s])?\\*)(?![\\w*])',  // 4 bold (single star)
    '(?<![\\w_])(_[^_\\s](?:[^_\\n]*?[^_\\s])?_)(?![\\w_])',      // 5 italic
    '(\\[[^\\]\\n]+\\]\\(https?:\\/\\/[^)\\s]+\\))',              // 6 link
  ];
  const re = new RegExp(parts.join('|'), 'g');
  let out = '', last = 0;
  for (const m of text.matchAll(re)) {
    const [whole, mName, code, bold2, bold, italic, link] = m;
    const at = m.index ?? 0;
    out += esc(text.slice(last, at));
    if (mName) out += chipHtml(mName, byName.get(mName.toLowerCase()) ?? '');
    else if (code) out += `<code>${esc(code.slice(1, -1))}</code>`;
    else if (bold2) out += `<b>${inlineHtml(bold2.slice(2, -2), mentionRe, byName)}</b>`;
    else if (bold) out += `<b>${inlineHtml(bold.slice(1, -1), mentionRe, byName)}</b>`;
    else if (italic) out += `<i>${inlineHtml(italic.slice(1, -1), mentionRe, byName)}</i>`;
    else if (link) {
      const l = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(link);
      out += l ? `<a href="${esc(l[2])}">${inlineHtml(l[1], mentionRe, byName)}</a>` : esc(whole);
    } else out += esc(whole);
    last = at + whole.length;
  }
  return out + esc(text.slice(last));
}

/** Composer markdown → editor HTML. Only names in `picked` become chips (others stay plain "@Name" text). */
export function noteMarkdownToHtml(md: string, picked: Array<{ name: string; user_id: string }>): string {
  if (!md) return '';
  const byName = new Map(picked.map((p) => [p.name.toLowerCase(), p.user_id]));
  const names = [...picked].map((p) => p.name).sort((a, b) => b.length - a.length).map(reEsc);
  const mentionRe = names.length ? new RegExp(`(?<![\\w@])@(${names.join('|')})(?![\\w])`) : null;
  const out: string[] = [];
  let list = null as { tag: 'ul' | 'ol'; items: string[] } | null;
  const flush = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${i || '<br>'}</li>`).join('')}</${list.tag}>`); list = null; } };
  for (const line of md.replace(/\r\n?/g, '\n').split('\n')) {
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const tag = ul && !/^\s*\*[^*\s].*\*\s*$/.test(line) ? 'ul' : ol ? 'ol' : null;
    if (tag) {
      if (list?.tag !== tag) { flush(); list = { tag, items: [] }; }
      list!.items.push(inlineHtml((tag === 'ul' ? ul! : ol!)[1], mentionRe, byName));
      continue;
    }
    flush();
    out.push(`<div>${inlineHtml(line, mentionRe, byName) || '<br>'}</div>`);
  }
  flush();
  return out.join('');
}

// ---------------------------------------------------------------------------------------------- HTML → markdown

interface Run { t: string; b: boolean; i: boolean; code: boolean; href: string | null }
const PLAIN: Run = { t: '', b: false, i: false, code: false, href: null };
const BLOCK_TAGS = new Set(['DIV', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'TABLE', 'TR']);

function collectRuns(node: Node, fmt: Run, out: Run[], brAs: string) {
  if (node.nodeType === Node.TEXT_NODE) {
    const t = (node as Text).data.replace(/ /g, ' ').replace(/[​﻿]/g, '');
    if (t) out.push({ ...fmt, t });
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as HTMLElement;
  if (el.tagName === 'BR') { out.push({ ...fmt, t: brAs }); return; }
  if (el.dataset.mentionName) { out.push({ ...fmt, code: false, href: null, t: `@${el.dataset.mentionName}` }); return; }
  const f = { ...fmt };
  const tag = el.tagName;
  const fw = el.style?.fontWeight;
  if (tag === 'B' || tag === 'STRONG' || fw === 'bold' || Number(fw) >= 600) f.b = true;
  if (tag === 'I' || tag === 'EM' || el.style?.fontStyle === 'italic') f.i = true;
  if (tag === 'CODE') f.code = true;
  if (tag === 'A') { const h = el.getAttribute('href') ?? ''; if (/^https?:\/\/\S+$/i.test(h)) f.href = h; }
  for (const c of Array.from(el.childNodes)) collectRuns(c, f, out, brAs);
}

const wrapWs = (s: string, mark: string) => {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s)!;
  return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : s;
};

/** consecutive runs sharing `key` → one wrapped group, so "**see [this](…)**" stays one bold span */
function groupBy(runs: Run[], key: (r: Run) => string | boolean | null, wrap: (inner: string, k: string | boolean | null) => string, next: (rs: Run[]) => string): string {
  let out = '';
  for (let i = 0; i < runs.length;) {
    const k = key(runs[i]);
    let j = i;
    while (j < runs.length && key(runs[j]) === k) j++;
    out += wrap(next(runs.slice(i, j)), k);
    i = j;
  }
  return out;
}

function lineMd(runs: Run[]): string {
  const leaf = (rs: Run[]) => rs.map((r) => (r.code && r.t.trim() ? wrapWs(r.t.replace(/`/g, ''), '`') : r.t)).join('');
  const links = (rs: Run[]) => groupBy(rs, (r) => r.href, (s, h) => (h && s.trim() ? `[${s.replace(/[[\]]/g, '')}](${h})` : s), leaf);
  const italics = (rs: Run[]) => groupBy(rs, (r) => r.i, (s, on) => (on ? wrapWs(s, '_') : s), links);
  return groupBy(runs, (r) => r.b, (s, on) => (on ? wrapWs(s, '**') : s), italics);
}

/** runs of one block → its lines (a <br> splits lines; a trailing <br> is the editor's placeholder, not a line) */
function blockLines(runs: Run[]): string[] {
  const lines: Run[][] = [[]];
  for (const r of runs) {
    const pieces = r.t.split('\n');
    pieces.forEach((p, n) => { if (n > 0) lines.push([]); if (p) lines[lines.length - 1].push({ ...r, t: p }); });
  }
  if (lines.length > 1 && lines[lines.length - 1].length === 0) lines.pop();
  return lines.map((l) => lineMd(l).replace(/\s+$/, ''));
}

/** Editor DOM → composer markdown (lines joined by "\n"). */
export function noteHtmlToMarkdown(root: HTMLElement): string {
  const lines: string[] = [];
  let cur: Run[] | null = null;
  const flush = () => { if (cur) { lines.push(...blockLines(cur)); cur = null; } };
  const listItems = (list: HTMLElement) => {
    let n = 0;
    for (const li of Array.from(list.children)) {
      if (li.tagName !== 'LI') continue;
      const runs: Run[] = [];
      collectRuns(li, PLAIN, runs, ' ');
      n++;
      lines.push(`${list.tagName === 'OL' ? `${n}.` : '-'} ${lineMd(runs).trim()}`);
    }
  };
  const walk = (node: Node) => {
    for (const c of Array.from(node.childNodes)) {
      const el = c.nodeType === Node.ELEMENT_NODE ? (c as HTMLElement) : null;
      if (el && (el.tagName === 'UL' || el.tagName === 'OL')) { flush(); listItems(el); }
      else if (el && el.tagName === 'LI') { flush(); const runs: Run[] = []; collectRuns(el, PLAIN, runs, ' '); lines.push(`- ${lineMd(runs).trim()}`); }
      else if (el && BLOCK_TAGS.has(el.tagName) && !el.dataset.mentionName) { flush(); walk(el); flush(); }
      else { cur ??= []; collectRuns(c, PLAIN, cur, '\n'); }
    }
  };
  walk(root);
  flush();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n');
}
