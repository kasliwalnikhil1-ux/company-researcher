// deno test --node-modules-dir=none supabase/functions/_shared/outreach/plaintext_test.ts
import { htmlToText, textToDisplayHtml } from "./plaintext.ts";
import { renderTemplate } from "./render.ts";

function eq(got: string, want: string, label: string): void {
  if (got !== want) throw new Error(`${label}\n--- got ---\n${JSON.stringify(got)}\n--- want ---\n${JSON.stringify(want)}`);
}

Deno.test("paragraphs and <br>", () => {
  eq(htmlToText("<p>Hi {{first_name|there}},</p><p>Line one<br>line two</p>"), "Hi {{first_name|there}},\n\nLine one\nline two", "p/br");
});

Deno.test("builder unsubscribe snippet appended to a typed body keeps the author's line breaks", () => {
  const t = 'Hi {{first_name}},\n\nQuick question about {{company}}.\n\nThanks\n<p><a href="{{unsubscribe_link}}">Unsubscribe</a></p>';
  eq(htmlToText(t), "Hi {{first_name}},\n\nQuick question about {{company}}.\n\nThanks\n\nUnsubscribe ({{unsubscribe_link}})", "typed + snippet");
});

Deno.test("source newlines next to tags are formatting, not line breaks", () => {
  eq(htmlToText("<p>\n  Hello,\n</p>\n<p>Second<br/>\nthird</p>\n"), "Hello,\n\nSecond\nthird", "pretty html");
});

Deno.test("MCP-built bodies (newlines → <br/>)", () => {
  eq(htmlToText("Hi {{first_name}},<br/><br/>Short note.<br/><br/>Best,<br/>{{sender.signature}}"), "Hi {{first_name}},\n\nShort note.\n\nBest,\n{{sender.signature}}", "br only");
});

Deno.test("links", () => {
  eq(htmlToText('<a href="https://x.com/a">https://x.com/a</a>'), "https://x.com/a", "text is url");
  eq(htmlToText('<a href="https://x.com/">x.com</a>'), "https://x.com/", "text is url without scheme");
  eq(htmlToText('Book <a href="{{booking_link}}" data-disable-tracking="true">a call</a> today'), "Book a call ({{booking_link}}) today", "labelled link");
  eq(htmlToText('<a href="mailto:a@b.co">a@b.co</a>'), "a@b.co", "mailto");
  eq(htmlToText('<a href="#top">Top</a>'), "Top", "anchor");
});

Deno.test("entities, lists, styles", () => {
  eq(htmlToText("<style>p{color:red}</style><p>AT&amp;T &lt;3 &nbsp;&#39;ok&#x27;</p>"), "AT&T <3 'ok'", "entities");
  eq(htmlToText("<ul><li>One</li><li>Two</li></ul>"), "- One\n- Two", "list");
});

Deno.test("values are rendered after conversion and never decoded", () => {
  const text = renderTemplate(htmlToText("<p>Hi {{first_name}}</p>"), { lead: { first_name: "Tom &amp; Jerry <3" } } as any);
  eq(text, "Hi Tom &amp; Jerry <3", "raw value");
});

Deno.test("display html", () => {
  eq(textToDisplayHtml("A & B\nsee https://x.com/a."), 'A &amp; B<br>\nsee <a href="https://x.com/a">https://x.com/a</a>.', "display");
});
