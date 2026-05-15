export interface TableData {
  headers: string[];
  rows: string[][];
}

export type JsonParseResult =
  | { ok: true; table: TableData }
  | { ok: false; error: string };

export function parseJsonArrayDetailed(text: string): JsonParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Invalid JSON: ${msg}. Check for smart quotes, unescaped newlines, or trailing commas.` };
  }
  if (!Array.isArray(data)) {
    return { ok: false, error: 'JSON must be an array of objects (e.g. [{...}, {...}]).' };
  }
  if (data.length === 0) {
    return { ok: false, error: 'JSON array is empty.' };
  }

  const headers: string[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      for (const k of Object.keys(item as Record<string, unknown>)) {
        if (!seen.has(k)) {
          seen.add(k);
          headers.push(k);
        }
      }
    }
  }
  if (headers.length === 0) {
    return { ok: false, error: 'JSON array contains no objects with keys.' };
  }

  const stringify = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  };

  const rows: string[][] = data.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return headers.map(() => '');
    }
    const obj = item as Record<string, unknown>;
    return headers.map(h => stringify(obj[h]));
  });

  return { ok: true, table: { headers, rows } };
}

export function parseJsonArray(text: string): TableData | null {
  const result = parseJsonArrayDetailed(text);
  return result.ok ? result.table : null;
}

export function parseMarkdownTable(text: string): TableData | null {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length < 2) return null;

  const splitRow = (line: string): string[] => {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map(c => c.trim());
  };

  const headers = splitRow(lines[0]);
  if (headers.length === 0) return null;

  let dataStart = 1;
  if (lines[1] && splitRow(lines[1]).every(c => /^:?-{2,}:?$/.test(c))) {
    dataStart = 2;
  }

  const rows = lines.slice(dataStart).map(l => {
    const cells = splitRow(l);
    while (cells.length < headers.length) cells.push('');
    while (cells.length > headers.length) cells.pop();
    return cells;
  }).filter(r => r.some(c => c.length > 0));

  if (rows.length === 0) return null;

  return { headers, rows };
}

const DOMAIN_HEADER_PRIORITY = ['domain', 'website', 'site', 'url', 'link', 'web'];
const DOMAIN_PATTERN = /^(https?:\/\/)?([\w-]+\.)+[a-z]{2,}(\/.*)?$/i;

export function isLikelyDomain(value: string | undefined | null): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return DOMAIN_PATTERN.test(trimmed);
}

export function detectDomainColumnIndex(headers: string[], rows: string[][]): number {
  const lowerHeaders = headers.map(h => h.toLowerCase());
  for (const name of DOMAIN_HEADER_PRIORITY) {
    const idx = lowerHeaders.findIndex(h => h === name || h.includes(name));
    if (idx >= 0) return idx;
  }

  let bestIdx = 0;
  let bestScore = -1;
  for (let col = 0; col < headers.length; col++) {
    const matches = rows.reduce((n, r) => {
      const cell = (r[col] || '').trim();
      return cell && DOMAIN_PATTERN.test(cell) ? n + 1 : n;
    }, 0);
    if (matches > bestScore) {
      bestScore = matches;
      bestIdx = col;
    }
  }
  return bestIdx;
}

export function moveColumnToFront(table: TableData, colIndex: number): TableData {
  if (colIndex <= 0 || colIndex >= table.headers.length) return table;
  const newHeaders = [table.headers[colIndex], ...table.headers.filter((_, i) => i !== colIndex)];
  const newRows = table.rows.map(r => [r[colIndex], ...r.filter((_, i) => i !== colIndex)]);
  return { headers: newHeaders, rows: newRows };
}

export function removeColumnAt(table: TableData, colIndex: number): TableData {
  return {
    headers: table.headers.filter((_, i) => i !== colIndex),
    rows: table.rows.map(r => r.filter((_, i) => i !== colIndex)),
  };
}

export function removeRowAt(table: TableData, rowIndex: number): TableData {
  return {
    headers: table.headers,
    rows: table.rows.filter((_, i) => i !== rowIndex),
  };
}

export function findAdContentColumnIndex(headers: string[]): number {
  const normalized = headers.map(h => (h || '').trim().toLowerCase());
  return normalized.indexOf('ad content');
}

export function looksLikeMarkdownTableOrJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.some(item => item && typeof item === 'object' && !Array.isArray(item));
      }
      if (parsed && typeof parsed === 'object') return true;
      return false;
    } catch {
      return false;
    }
  }
  const lines = trimmed.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  const linesWithPipes = lines.filter(l => l.includes('|')).length;
  if (linesWithPipes < 2) return false;
  // Strong signal: a markdown header separator row like `| --- | :---: |` immediately
  // following a header row means this is a markdown table regardless of trailing
  // non-pipe content (e.g. reference footnotes `[1]: https://...`).
  const SEPARATOR_RE = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].includes('|') && SEPARATOR_RE.test(lines[i]) && lines[i - 1].includes('|')) {
      return true;
    }
  }
  return linesWithPipes / lines.length >= 0.8;
}

export function buildRowNews(table: TableData, rowIndex: number, domainColIndex: number = 0): string {
  const row = table.rows[rowIndex];
  if (!row) return '';
  return table.headers
    .map((header, i) => {
      if (i === domainColIndex) return null;
      const cell = (row[i] || '').trim();
      if (!cell) return null;
      return `${header}: ${cell}`;
    })
    .filter((s): s is string => s !== null)
    .join('\n');
}
