// Turns the Markdown source of a message into what the recipient sees.
//
// Source text keeps Markdown syntax (`\$5`, `**bold**`, a trailing `\` hard break, soft-wrapped
// lines). In `html` format the Markdown is rendered the way a rich-text sender would deliver it;
// in `plain` format the text is delivered as typed (line breaks kept, only backslash escapes
// removed) and Gmail only auto-links URLs. Placeholders are resolved inside text runs, so a
// missing value surfaces as a `var` node with status "missing" instead of disappearing.

import { segments, type ResolveContext, type Segment, TOKEN_RE } from './variables';

export type Inline =
  | { t: 'text'; text: string }
  | { t: 'var'; name: string; raw: string; value: string; status: 'sample' | 'fallback' | 'missing' }
  | { t: 'b'; children: Inline[] }
  | { t: 'i'; children: Inline[] }
  | { t: 'code'; text: string }
  | { t: 'a'; href: string; children: Inline[] }
  | { t: 'br' };

export type BlockNode =
  | { t: 'p'; inl: Inline[] }
  | { t: 'h'; inl: Inline[] }
  | { t: 'ul'; items: Inline[][] }
  | { t: 'ol'; items: Inline[][]; start: number }
  | { t: 'quote'; blocks: BlockNode[] }
  | { t: 'hr' };

export type BodyFormat = 'html' | 'plain';

const HARD = '\u2028';
const PH_OPEN = '\uE000';
const PH_CLOSE = '\uE001';

interface Ctx {
  resolve: ResolveContext;
  tokens: string[];
}

// ── placeholders ────────────────────────────────────────────────────────────────────────────

function protect(text: string, tokens: string[]): string {
  return text.replace(TOKEN_RE, (raw) => {
    tokens.push(raw);
    return `${PH_OPEN}${tokens.length - 1}${PH_CLOSE}`;
  });
}

function restoreRaw(text: string, tokens: string[]): string {
  return text.replace(new RegExp(`${PH_OPEN}(\\d+)${PH_CLOSE}`, 'g'), (_, i) => tokens[Number(i)]);
}

/** Text run → text/var/br nodes. `soft` decides what a single newline becomes. */
function textNodes(text: string, ctx: Ctx, soft: 'space' | 'br'): Inline[] {
  const out: Inline[] = [];
  const raw = restoreRaw(text, ctx.tokens);
  const parts = raw.split(new RegExp(`[${HARD}${soft === 'br' ? '\n' : ''}]`));
  parts.forEach((part, i) => {
    if (i > 0) out.push({ t: 'br' });
    const flat = soft === 'space' ? part.replace(/\n/g, ' ') : part;
    for (const s of segments(flat, ctx.resolve) as Segment[]) {
      if (s.type === 'text') {
        if (s.text) out.push({ t: 'text', text: s.text });
      } else out.push({ t: 'var', name: s.name, raw: s.raw, value: s.value, status: s.status });
    }
  });
  return out;
}

// ── inline Markdown ─────────────────────────────────────────────────────────────────────────

const ESCAPABLE = '\\`*_{}[]()#+-.!|$<>~"\'&';
const URL_RE = /^(?:https?:\/\/|www\.)[^\s<>\u2028]+/i;

function trimUrl(url: string): string {
  let u = url;
  for (;;) {
    const last = u[u.length - 1];
    if (/[.,;:!?'"*_]/.test(last)) u = u.slice(0, -1);
    else if (last === ')' && (u.match(/\(/g)?.length ?? 0) < (u.match(/\)/g)?.length ?? 0)) u = u.slice(0, -1);
    else return u;
  }
}

function hrefOf(url: string): string {
  return /^www\./i.test(url) ? `https://${url}` : url;
}

function parseInline(src: string, ctx: Ctx, soft: 'space' | 'br'): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push(...textNodes(buf, ctx, soft));
    buf = '';
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const prev = i > 0 ? src[i - 1] : ' ';
    if (c === '\\' && i + 1 < src.length && ESCAPABLE.includes(src[i + 1])) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push({ t: 'code', text: restoreRaw(src.slice(i + 1, end), ctx.tokens) });
        i = end + 1;
        continue;
      }
    }
    if (c === '*' && src[i + 1] === '*') {
      const end = src.indexOf('**', i + 2);
      if (end > i + 2 && !/\s/.test(src[i + 2])) {
        flush();
        out.push({ t: 'b', children: parseInline(src.slice(i + 2, end), ctx, soft) });
        i = end + 2;
        continue;
      }
    }
    if ((c === '*' || (c === '_' && !/[\p{L}\p{N}]/u.test(prev))) && src[i + 1] && !/\s/.test(src[i + 1])) {
      let end = i + 1;
      while ((end = src.indexOf(c, end)) !== -1) {
        const next = src[end + 1] ?? ' ';
        if (!/\s/.test(src[end - 1]) && (c === '*' ? next !== '*' : !/[\p{L}\p{N}]/u.test(next))) break;
        end += 1;
      }
      if (end > i + 1) {
        flush();
        out.push({ t: 'i', children: parseInline(src.slice(i + 1, end), ctx, soft) });
        i = end + 1;
        continue;
      }
    }
    if (c === '[') {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(src.slice(i));
      if (m) {
        flush();
        out.push({ t: 'a', href: hrefOf(restoreRaw(m[2], ctx.tokens)), children: parseInline(m[1], ctx, soft) });
        i += m[0].length;
        continue;
      }
    }
    if (c === '<') {
      const m = /^<((?:https?:\/\/|mailto:)[^>\s]+)>/i.exec(src.slice(i));
      if (m) {
        flush();
        out.push({ t: 'a', href: m[1], children: textNodes(m[1], ctx, soft) });
        i += m[0].length;
        continue;
      }
    }
    if ((c === 'h' || c === 'w' || c === 'H' || c === 'W') && !/[\p{L}\p{N}]/u.test(prev)) {
      const m = URL_RE.exec(src.slice(i));
      if (m) {
        const url = trimUrl(m[0]);
        flush();
        const href = hrefOf(restoreRaw(url, ctx.tokens));
        out.push({ t: 'a', href, children: textNodes(url, ctx, soft) });
        i += url.length;
        continue;
      }
    }
    buf += c;
    i += 1;
  }
  flush();
  return out;
}

/** Plain-text delivery: only escapes are removed and URLs become links (Gmail auto-links them). */
function parsePlainInline(src: string, ctx: Ctx): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push(...textNodes(buf, ctx, 'br'));
    buf = '';
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const prev = i > 0 ? src[i - 1] : ' ';
    if (c === '\\' && i + 1 < src.length && ESCAPABLE.includes(src[i + 1])) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if ((c === 'h' || c === 'w' || c === 'H' || c === 'W') && !/[\p{L}\p{N}]/u.test(prev)) {
      const m = URL_RE.exec(src.slice(i));
      if (m) {
        const url = trimUrl(m[0]);
        flush();
        out.push({ t: 'a', href: hrefOf(restoreRaw(url, ctx.tokens)), children: textNodes(url, ctx, 'br') });
        i += url.length;
        continue;
      }
    }
    buf += c;
    i += 1;
  }
  flush();
  return out;
}

// ── blocks ──────────────────────────────────────────────────────────────────────────────────

function joinParagraph(lines: string[]): string {
  return lines
    .map((line, i) => {
      if (i === lines.length - 1) return line.replace(/\\$/, '').replace(/ +$/, '');
      if (/(^|[^\\])\\$/.test(line)) return line.slice(0, -1) + HARD;
      if (/ {2,}$/.test(line)) return line.replace(/ +$/, '') + HARD;
      return line + '\n';
    })
    .join('');
}

const UL_RE = /^\s{0,3}[-*+]\s+(.*)$/;
const OL_RE = /^\s{0,3}(\d+)[.)]\s+(.*)$/;

function parseBlocks(lines: string[], ctx: Ctx): BlockNode[] {
  const out: BlockNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push({ t: 'hr' });
      i += 1;
      continue;
    }
    const h = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      out.push({ t: 'h', inl: parseInline(h[1], ctx, 'space') });
      i += 1;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) q.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      out.push({ t: 'quote', blocks: parseBlocks(q, ctx) });
      continue;
    }
    const ul = UL_RE.exec(line);
    const ol = OL_RE.exec(line);
    if (ul || ol) {
      const re = ul ? UL_RE : OL_RE;
      const items: string[][] = [];
      while (i < lines.length) {
        const l = lines[i];
        const m = re.exec(l);
        if (m) items.push([ul ? m[1] : m[2]]);
        else if (l.trim() && !UL_RE.test(l) && !OL_RE.test(l) && items.length) items[items.length - 1].push(l.trim());
        else break;
        i += 1;
      }
      const parsed = items.map((it) => parseInline(joinParagraph(it), ctx, 'space'));
      out.push(ul ? { t: 'ul', items: parsed } : { t: 'ol', items: parsed, start: Number(ol![1]) });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s{0,3}(#{1,6}\s|>)/.test(lines[i]) &&
      !(para.length && (UL_RE.test(lines[i]) || OL_RE.test(lines[i])))
    )
      para.push(lines[i++]);
    out.push({ t: 'p', inl: parseInline(joinParagraph(para), ctx, 'space') });
  }
  return out;
}

export function renderBody(source: string, resolve: ResolveContext, format: BodyFormat): BlockNode[] {
  const ctx: Ctx = { resolve, tokens: [] };
  const text = protect(source.replace(/\r\n?/g, '\n'), ctx.tokens);
  if (format === 'html') return parseBlocks(text.split('\n'), ctx);
  // Plain: paragraphs split on blank lines, every newline kept, trailing `\` markers removed.
  return text
    .split(/\n\s*\n/)
    .filter((p) => p.trim())
    .map((p) => ({
      t: 'p' as const,
      inl: parsePlainInline(
        p
          .split('\n')
          .map((l) => l.replace(/(^|[^\\])\\$/, '$1').replace(/ +$/, ''))
          .join('\n'),
        ctx,
      ),
    }));
}

/** One-line inline render (subjects, list items). */
export function renderInline(source: string, resolve: ResolveContext): Inline[] {
  const ctx: Ctx = { resolve, tokens: [] };
  return textNodes(protect(source, ctx.tokens), ctx, 'space');
}

// ── plain text (snippets, counts) ───────────────────────────────────────────────────────────

export function inlineText(inl: Inline[]): string {
  return inl
    .map((n) => {
      switch (n.t) {
        case 'text':
          return n.text;
        case 'var':
          return n.status === 'missing' ? n.raw : n.value;
        case 'code':
          return n.text;
        case 'br':
          return '\n';
        default:
          return inlineText(n.children);
      }
    })
    .join('');
}

export function blocksText(blocks: BlockNode[]): string {
  return blocks
    .map((b) => {
      switch (b.t) {
        case 'p':
        case 'h':
          return inlineText(b.inl);
        case 'ul':
          return b.items.map((it) => `• ${inlineText(it)}`).join('\n');
        case 'ol':
          return b.items.map((it, k) => `${b.start + k}. ${inlineText(it)}`).join('\n');
        case 'quote':
          return blocksText(b.blocks);
        case 'hr':
          return '';
      }
    })
    .filter((s) => s !== '')
    .join('\n\n');
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Remove the italic internal-note markers the source uses (`*Ensure …*`) for display. */
export function stripOuterItalic(text: string): string {
  const t = text.trim();
  const m = /^\*([^*][\s\S]*[^*])\*$/.exec(t) || /^_([^_][\s\S]*[^_])_$/.exec(t);
  return m ? m[1] : t;
}
