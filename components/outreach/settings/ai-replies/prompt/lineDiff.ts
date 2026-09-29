// Minimal line diff (longest common subsequence). Prompts are a few hundred lines at most, so O(n·m) is fine;
// above MAX_CELLS it falls back to "everything removed / everything added" rather than freezing the tab.
export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string };

const MAX_CELLS = 4_000_000;

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  // trim the common head and tail first: most edits touch a few lines in the middle
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const head: DiffLine[] = a.slice(0, start).map((text) => ({ kind: 'same', text }));
  const tail: DiffLine[] = a.slice(endA).map((text) => ({ kind: 'same', text }));
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  const n = x.length, m = y.length;

  if (n * m > MAX_CELLS) {
    return [...head, ...x.map((text) => ({ kind: 'del' as const, text })), ...y.map((text) => ({ kind: 'add' as const, text })), ...tail];
  }

  // lcs[i][j] = LCS length of x[i..] and y[j..], stored flat
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = x[i] === y[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  const mid: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { mid.push({ kind: 'same', text: x[i] }); i++; j++; }
    else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) { mid.push({ kind: 'del', text: x[i] }); i++; }
    else { mid.push({ kind: 'add', text: y[j] }); j++; }
  }
  while (i < n) mid.push({ kind: 'del', text: x[i++] });
  while (j < m) mid.push({ kind: 'add', text: y[j++] });
  return [...head, ...mid, ...tail];
}

/** Collapse long runs of unchanged lines to `context` lines around each change. `null` marks a gap. */
export function withContext(lines: DiffLine[], context = 3): Array<DiffLine | null> {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, idx) => {
    if (l.kind === 'same') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) keep[k] = true;
  });
  const out: Array<DiffLine | null> = [];
  lines.forEach((l, idx) => {
    if (keep[idx]) out.push(l);
    else if (out.length === 0 || out[out.length - 1] !== null) out.push(null);
  });
  return out;
}
