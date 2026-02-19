/**
 * Generic utility functions for handling dynamic summary/qualification data.
 * The AI returns a JSON summary whose keys depend on the user's personalization
 * schema. These helpers ensure the rest of the app treats the summary as a
 * generic Record<string, any> instead of relying on hard-coded field names.
 */

/**
 * Convert a snake_case key to a human-readable Title Case label.
 * e.g. "sales_opener_sentence" → "Sales Opener Sentence"
 */
export function summaryKeyToLabel(key: string): string {
  return key
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Format any summary value for display in the UI or CSV export.
 * Handles arrays, numbers (including 0-1 scores), booleans, and strings.
 */
export function formatSummaryValue(value: any): string {
  if (value === null || value === undefined) return '-';
  if (Array.isArray(value)) {
    const filtered = value.filter(v => v != null && String(v).trim() !== '');
    return filtered.length > 0 ? filtered.join(', ') : '-';
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  const str = String(value).trim();
  return str || '-';
}

/**
 * Format an array of strings in natural English:
 * ["a"] → "a", ["a","b"] → "a and b", ["a","b","c"] → "a, b, and c"
 */
export function formatArrayNatural(arr: string[]): string {
  if (!arr || arr.length === 0) return '';
  if (arr.length === 1) return arr[0];
  if (arr.length === 2) return `${arr[0]} and ${arr[1]}`;
  return `${arr.slice(0, -1).join(', ')}, and ${arr[arr.length - 1]}`;
}

/**
 * Generic: write all fields from a summary object into a CSV row.
 * Keys are converted to Title Case column names.
 * Arrays get formatted as natural-language lists.
 */
export function writeSummaryToCsvRow(
  summary: Record<string, any>,
  row: Record<string, string>,
): void {
  if (!summary || typeof summary !== 'object') return;

  for (const [key, value] of Object.entries(summary)) {
    if (value === null || value === undefined) continue;
    const label = summaryKeyToLabel(key);

    if (Array.isArray(value)) {
      const filtered = value.filter(
        (v: any) => v != null && typeof v === 'string' && v.trim(),
      );
      if (filtered.length > 0) {
        row[label] = formatArrayNatural(filtered);
      }
    } else {
      row[label] = String(value);
    }
  }
}

/**
 * Discover all unique summary keys across a list of companies.
 * Useful for building dynamic column lists.
 */
export function discoverSummaryKeys(
  companies: { summary: any }[],
): string[] {
  const keysSet = new Set<string>();
  for (const company of companies) {
    if (company.summary && typeof company.summary === 'object') {
      for (const key of Object.keys(company.summary)) {
        keysSet.add(key);
      }
    }
  }
  return Array.from(keysSet);
}

/**
 * Build a column-labels map from an array of summary key names.
 * Returns Record<key, label> where label is the Title Case version.
 */
export function buildSummaryColumnLabels(
  keys: string[],
): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const key of keys) {
    labels[key] = summaryKeyToLabel(key);
  }
  return labels;
}

/**
 * Read a value from a summary object and format it for cell display.
 */
export function getSummaryCellValue(
  summary: Record<string, any> | null | undefined,
  key: string,
): string {
  if (!summary || !(key in summary)) return '-';
  return formatSummaryValue(summary[key]);
}
