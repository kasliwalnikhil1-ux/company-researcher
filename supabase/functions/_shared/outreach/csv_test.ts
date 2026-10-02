// deno test --node-modules-dir=none --allow-env supabase/functions/_shared/outreach/csv_test.ts
// The CSV reader and the identifier rule of the import worker. workers.ts builds a database client at load, so the two settings it reads get a stand-in.
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test");
const { parseCsv, csvPublicIdentifier, CSV_MAX_ROWS } = await import("./workers.ts");

function eq(a: unknown, b: unknown, label: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }

/** The reader as it was before it was rewritten for memory: the rewrite must give the same cells for every input. */
function parseCsvByChar(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
}

Deno.test("parseCsv: cells", () => {
  eq(parseCsv("a,b,c\n1,2,3\n"), [["a", "b", "c"], ["1", "2", "3"]], "plain");
  eq(parseCsv("a,b\r\n1,2\r\n"), [["a", "b"], ["1", "2"]], "crlf");
  eq(parseCsv("a,b\r1,2"), [["a", "b"], ["1", "2"]], "cr only, no last newline");
  eq(parseCsv('name,notes\n"Co, Ltd","said ""hi""\nsecond line"\n'), [["name", "notes"], ["Co, Ltd", 'said "hi"\nsecond line']], "quotes, comma, newline in a cell");
  eq(parseCsv('a,b\n,\n"",x\n'), [["a", "b"], ["", ""], ["", "x"]], "empty cells");
  eq(parseCsv("a,b\n\n\n1,2\n\n"), [["a", "b"], ["1", "2"]], "blank lines dropped");
  eq(parseCsv('a\nx"y"z\n'), [["a"], ["xyz"]], "quote in the middle of a cell");
  eq(parseCsv('a,b\n"open,1\n2'), [["a", "b"], ["open,1\n2"]], "quote never closed");
  eq(parseCsv(""), [], "empty file");
  eq(parseCsv("﻿name,email\nA,a@b.co\n")[0][0].trim(), "name", "a byte order mark is trimmed off the first header");
});

Deno.test("parseCsv: same cells as the character reader", () => {
  const pieces = ['"', '""', ",", "\n", "\r\n", "\r", "a", "bc", " ", "é", "정", "x,y", '"q"', ""];
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let t = 0; t < 3000; t++) {
    let s = "";
    for (let k = 0, len = 1 + Math.floor(rnd() * 24); k < len; k++) s += pieces[Math.floor(rnd() * pieces.length)];
    eq(parseCsv(s), parseCsvByChar(s), JSON.stringify(s));
  }
});

Deno.test("parseCsv: a file of the largest size", () => {
  const line = (i: number) => `Person ${i},"Co ${i}, Ltd",https://www.linkedin.com/in/p-${i}/,p${i}@example.invalid,"note ""${i}"""`;
  const text = "name,company,linkedin,email,notes\n" + Array.from({ length: CSV_MAX_ROWS }, (_, i) => line(i)).join("\n") + "\n";
  const rows = parseCsv(text);
  eq(rows.length, CSV_MAX_ROWS + 1, "row count");
  eq(rows[CSV_MAX_ROWS], [`Person ${CSV_MAX_ROWS - 1}`, `Co ${CSV_MAX_ROWS - 1}, Ltd`, `https://www.linkedin.com/in/p-${CSV_MAX_ROWS - 1}/`, `p${CSV_MAX_ROWS - 1}@example.invalid`, `note "${CSV_MAX_ROWS - 1}"`], "last row");
});

Deno.test("csvPublicIdentifier", () => {
  const cases: Array<[string, string | null]> = [
    ["https://www.linkedin.com/in/dipti-khalate/", "dipti-khalate"],
    ["https://uk.linkedin.com/in/shirley-paris", "shirley-paris"],
    ["http://www.linkedin.com/in/Emily-Sutter-4ab43b95?trk=x", "emily-sutter-4ab43b95"],
    ["linkedin.com/in/abc", "abc"], ["in/John-Doe", "john-doe"], ["John-Doe", "john-doe"],
    ["https://www.linkedin.com/in/florian-r%c3%b6der-518a65190/", "florian-röder-518a65190"],
    ["https://www.linkedin.com/in/%ea%b2%bd%ec%84%9d-%ec%b0%a8-47aa1919b/", "경석-차-47aa1919b"],
    ["100%-real", "100%-real"],
    ["https://www.linkedin.com/company/zalora", null], ["https://example.com/x", null], ["", null],
    // every way one person's profile gets written resolves to the same identifier
    ["https://www.linkedin.com/in/namankas/?isSelfProfile=true", "namankas"], ["https://www.linkedin.com/in/namankas", "namankas"], ["https://www.linkedin.com/in/namankas/", "namankas"],
    ["in/namankas/?isSelfProfile=true", "namankas"], ["in/namankas", "namankas"], ["namankas", "namankas"],
    ["/in/namankas/", "namankas"], ["@namankas", "namankas"], ["  NamanKas  ", "namankas"], ["www.linkedin.com/in/namankas#about", "namankas"], ["https://www.linkedin.com/mwlite/in/namankas", "namankas"],
    // not a profile: another LinkedIn page, a name, an email, a website
    ["linkedin.com/company/zalora", null], ["https://www.linkedin.com/sales/lead/ACwAAA,NAME", null], ["Naman Kas", null], ["naman@example.com", null], ["example.com/naman", null],
  ];
  for (const [v, want] of cases) eq(csvPublicIdentifier(v), want, v);   // components/outreach/leads/helpers.test.ts checks the same values on the upload screen's rule
});
