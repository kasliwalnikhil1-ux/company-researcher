let counter = 0;

export function uid(prefix: string): string {
  counter = (counter + 1) % 1679616;
  return `${prefix}_${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 6)}${counter.toString(36)}`;
}

export function clone<T>(value: T): T {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

/** Markdown escapes removed, for showing headings/titles as text. */
export function unescapeMd(text: string): string {
  return text.replace(/\\([\\`*_{}[\]()#+\-.!|$<>~"'&])/g, '$1');
}

export function normKey(text: string): string {
  return unescapeMd(text)
    .toLowerCase()
    .replace(/[^a-z0-9$]+/g, ' ')
    .trim();
}

export function todayAt(hh: number, mm: number): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(hh)}:${p(mm)}`;
}

export function move<T>(list: T[], from: number, to: number): void {
  if (to < 0 || to >= list.length || from === to) return;
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item);
}
