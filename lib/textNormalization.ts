// Normalizes common non-ASCII characters (smart quotes, em/en dashes,
// non-breaking spaces, ellipsis, bullets, etc.) to their plain-text
// equivalents so messages stay clean across email/LinkedIn/etc.
//
// Source is written with \uXXXX escapes so the file is pure ASCII and the
// mappings cannot drift due to editor encoding quirks.

const REPLACEMENTS: Record<string, string> = {
  // Curly quotes -> straight quotes
  '‘': "'", '’': "'",           // ' '  single quotes
  '‚': "'", '‛': "'",           // low / reversed single
  '“': '"', '”': '"',           // " "  double quotes
  '„': '"', '‟': '"',           // low / reversed double
  '′': "'", '″': '"',           // prime / double prime
  '«': '"', '»': '"',           // « »  guillemets
  '‹': "'", '›': "'",           // single guillemets
  '`': "'", '´': "'",           // grave / acute accent

  // Dashes -> hyphen-minus
  '‐': '-', '‑': '-',           // hyphen / non-breaking hyphen
  '‒': '-', '–': '-',           // figure / en dash
  '—': '-', '―': '-',           // em dash / horizontal bar
  '−': '-',                          // minus sign

  // Spaces -> regular space
  ' ': ' ', ' ': ' ', ' ': ' ',  // nbsp, figure, narrow nbsp
  ' ': ' ', ' ': ' ', ' ': ' ',  // en, em, three-per-em
  ' ': ' ', ' ': ' ', ' ': ' ',  // four/six-per-em, thin
  ' ': ' ', ' ': ' ', '　': ' ',  // hair, math, ideographic
  '​': '',                                  // zero-width space -> remove

  // Other punctuation
  '…': '...',                        // ellipsis
  '•': '*', '·': '*',           // bullet / middle dot
  '⁄': '/',                          // fraction slash
  '﻿': '',                           // BOM / zero-width no-break space
};

const NORMALIZE_REGEX =
  /[‘’‚‛“”„‟′″«»‹›`´‐‑‒–—―−           　​…•·⁄﻿]/g;

export function toPlainText(text: string): string {
  if (!text) return text;
  // Reset before test() and again before replace() — /g state is shared.
  NORMALIZE_REGEX.lastIndex = 0;
  if (!NORMALIZE_REGEX.test(text)) return text;
  NORMALIZE_REGEX.lastIndex = 0;
  return text.replace(NORMALIZE_REGEX, (char) => REPLACEMENTS[char] ?? char);
}
