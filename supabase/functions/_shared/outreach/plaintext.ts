// Plain-text email (workspace settings.email_plain_text, or a send_email step's plain_text).
// Unipile sends a text/plain email when the send carries the custom header Content-Type: text/plain; charset=utf-8
// (developer.unipile.com/docs/send-email, "Send a plain text email"). The body is then sent as-is, so it must be real
// text: no tags, no entities. A plain-text email is never tracked: there is nowhere to put a pixel, and rewritten links
// would show the recipient a redirect URL.

export const PLAIN_TEXT_HEADER = { name: "Content-Type", value: "text/plain; charset=utf-8" } as const;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™", bull: "•", middot: "·" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const stripTags = (s: string) => s.replace(/<[^>]*>/g, "");

/** HTML → readable text. Paragraphs become blank lines, <br> a line break, list items "- ", links "text (url)" (just the url when the text is the url).
 *  Run it on the TEMPLATE before rendering: {{variables}} and {spin|tax} pass through untouched, and rendered values are never entity-decoded. */
export function htmlToText(html: string): string {
  let s = html.replace(/\r\n?/g, "\n");
  s = s.replace(/<!--[\s\S]*?-->/g, "").replace(/<(head|style|script|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  // A body is often typed as text with a snippet of HTML added (the unsubscribe <p>), so a newline the author typed stays a
  // line break. Only a newline right next to a <br> or a block tag is source formatting and is dropped.
  const BLOCK = "(?:br|p|div|li|ul|ol|h[1-6]|tr|td|th|table|tbody|thead|blockquote|pre|section|article|header|footer|hr)";
  s = s.replace(new RegExp(`(<\\/?${BLOCK}\\b[^>]*>)[ \\t]*\\n\\s*`, "gi"), "$1").replace(new RegExp(`\\s*\\n[ \\t]*(?=<\\/?${BLOCK}\\b)`, "gi"), "");
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_m, attrs: string, inner: string) => {
    const href = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const url = decodeEntities((href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim()).replace(/^mailto:/i, "");
    const label = decodeEntities(stripTags(inner)).replace(/\s+/g, " ").trim();
    if (!url || url.startsWith("#")) return label;
    if (!label || label === url || label.replace(/^https?:\/\//i, "").replace(/\/$/, "") === url.replace(/^https?:\/\//i, "").replace(/\/$/, "")) return url;
    return `${label} (${url})`;
  });
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n- ").replace(/<\/li\s*>/gi, "");
  s = s.replace(/<\/?(p|div|h[1-6]|ul|ol|table|blockquote|pre|section|article|header|footer)\b[^>]*>/gi, "\n\n");
  s = s.replace(/<\/tr\s*>/gi, "\n").replace(/<\/t[dh]\s*>/gi, " ");
  s = s.replace(/<hr\b[^>]*>/gi, "\n\n---\n\n");
  s = decodeEntities(stripTags(s));
  return s
    .split("\n").map((l) => l.replace(/[ \t ]+/g, " ").trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Text shown in the inbox for a plain-text email: escaped, links clickable, line breaks kept. */
export function textToDisplayHtml(text: string): string {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return esc.replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]]/g, (u) => `<a href="${u}">${u}</a>`).replace(/\n/g, "<br>\n");
}
