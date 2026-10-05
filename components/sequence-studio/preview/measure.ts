// Reads what is actually visible in the rendered preview. No fixed character limits: every
// number comes from browser layout (Range rects of each character against the clipping box,
// the real ellipsis width in the row's own font, and the device viewport).

export interface Clip {
  text: string;
  total: number;
  visible: number;
}

export interface OpenedMeasure {
  lines: { text: string; above: boolean }[];
  aboveCount: number;
  subjectLines: number;
  bodyWidth: number;
  viewportHeight: number;
  bodyTop: number;
}

export interface Measures {
  inbox?: { subject?: Clip; snippet?: Clip };
  opened?: OpenedMeasure;
  fonts: { googleSans: boolean; roboto: boolean };
}

function textNodes(el: Element): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n = walker.nextNode();
  while (n) {
    out.push(n as Text);
    n = walker.nextNode();
  }
  return out;
}

function ellipsisWidth(clip: HTMLElement): number {
  const s = document.createElement('span');
  s.textContent = '…';
  s.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;';
  clip.appendChild(s);
  const w = s.getBoundingClientRect().width;
  s.remove();
  return w;
}

/** How many characters of `target` are visible inside its clipping ancestor. */
export function visibleText(target: HTMLElement, clip: HTMLElement): Clip {
  const box = clip.getBoundingClientRect();
  const overflow = clip.scrollWidth > clip.clientWidth + 1 || clip.scrollHeight > clip.clientHeight + 1;
  const ell = overflow ? ellipsisWidth(clip) : 0;
  const range = document.createRange();
  let text = '';
  let visible = 0;
  let stopped = false;
  for (const node of textNodes(target)) {
    for (let i = 0; i < node.length; i += 1) {
      const ch = node.data[i];
      text += ch;
      if (stopped) continue;
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const rects = range.getClientRects();
      const r = rects[rects.length - 1];
      if (!r || (r.width === 0 && /\s/.test(ch))) {
        visible = text.length;
        continue;
      }
      const lastLine = r.bottom + r.height > box.bottom + 0.5;
      const fits = r.bottom <= box.bottom + 0.5 && r.top >= box.top - 0.5 && r.right <= box.right - (overflow && lastLine ? ell : 0) + 0.5;
      if (fits) visible = text.length;
      else stopped = true;
    }
  }
  return { text, total: text.length, visible };
}

function countLines(el: Element): number {
  const range = document.createRange();
  const tops = new Set<number>();
  for (const node of textNodes(el)) {
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) if (r.width > 0) tops.add(Math.round(r.top));
  }
  return tops.size;
}

/** Rendered lines of the opened message body, and which sit above the fold (the bottom of the
 *  device viewport when the conversation first opens, i.e. scrolled to the top). */
export function openedLines(body: HTMLElement, scroller: HTMLElement, scale: number): Omit<OpenedMeasure, 'subjectLines'> {
  const range = document.createRange();
  const box = scroller.getBoundingClientRect();
  const offset = scroller.scrollTop * scale;
  const lines: { top: number; bottom: number; text: string }[] = [];
  for (const node of textNodes(body)) {
    for (let i = 0; i < node.length; i += 1) {
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const rects = range.getClientRects();
      const r = rects[rects.length - 1];
      const ch = node.data[i];
      if (!r || r.height === 0) continue;
      const top = r.top + offset;
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.top - top) < r.height / 2) {
        last.text += ch;
        last.bottom = Math.max(last.bottom, r.bottom + offset);
      } else lines.push({ top, bottom: r.bottom + offset, text: ch });
    }
  }
  const out = lines.map((l) => ({ text: l.text.trim(), above: l.bottom <= box.bottom + 0.5 }));
  const first = lines[0];
  return {
    lines: out,
    aboveCount: out.filter((l) => l.above).length,
    bodyWidth: Math.round(body.getBoundingClientRect().width / scale),
    viewportHeight: Math.round(box.height / scale),
    bodyTop: first ? Math.round((first.top - box.top) / scale) : 0,
  };
}

function fontAvailable(family: string): boolean {
  try {
    const c = document.createElement('canvas').getContext('2d');
    if (!c) return false;
    const sample = 'mmmmmmmmmmlli1WQ@#';
    c.font = '72px monospace';
    const base = c.measureText(sample).width;
    c.font = `72px "${family}", monospace`;
    return c.measureText(sample).width !== base;
  } catch {
    return false;
  }
}

export function measurePreview(root: HTMLElement, scale: number): Measures {
  const out: Measures = { fonts: { googleSans: fontAvailable('Google Sans'), roboto: fontAvailable('Roboto') } };
  const inbox = root.querySelector<HTMLElement>('[data-pane="inbox"]');
  if (inbox) {
    const pick = (name: string): Clip | undefined => {
      const el = inbox.querySelector<HTMLElement>(`[data-m="${name}"]`);
      const clip = el?.closest<HTMLElement>('[data-clip]');
      return el && clip ? visibleText(el, clip) : undefined;
    };
    out.inbox = { subject: pick('subject'), snippet: pick('snippet') };
  }
  const opened = root.querySelector<HTMLElement>('[data-pane="opened"]');
  const body = opened?.querySelector<HTMLElement>('[data-m="body"]');
  const scroller = opened?.querySelector<HTMLElement>('[data-m="viewport"]');
  const subj = opened?.querySelector<HTMLElement>('[data-m="open-subject"]');
  if (body && scroller) out.opened = { ...openedLines(body, scroller, scale), subjectLines: subj ? countLines(subj) : 0 };
  return out;
}
