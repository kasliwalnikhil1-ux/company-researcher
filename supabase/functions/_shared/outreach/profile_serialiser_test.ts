// Golden-file tests for the profile multipart serialiser (PRD §7.4): every nested and array field in §1.1, the exact
// encoded body, strict unknown-key rejection, and the hard rules (notify_network false, open_to_work refused).
//   deno test --allow-read --node-modules-dir=none supabase/functions/_shared/outreach/profile_serialiser_test.ts
import { describeParts, encodeProfileEdit, fieldGroupsOf, fidelityOf, ProfileSerialiserError, sectionsForGroups, toFormData, unwrittenFieldsOf } from "./profile_serialiser.ts";

interface Golden { name: string; payload: unknown; expected?: Array<[string, string]>; error?: string; strict?: boolean }

const casesUrl = new URL("./profile_serialiser.golden.json", import.meta.url);
const cases: Golden[] = JSON.parse(await Deno.readTextFile(casesUrl));

function reviveBinary(v: unknown): unknown {
  // {"$binary": 12} → a Blob of that many bytes, so binary parts can be described in JSON
  if (Array.isArray(v)) return v.map(reviveBinary);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.$binary === "number") return new Blob([new Uint8Array(o.$binary)]);
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, reviveBinary(x)]));
  }
  return v;
}

let failed = 0;
const fail = (msg: string) => { failed++; console.error(`FAIL ${msg}`); };

for (const c of cases) {
  const payload = reviveBinary(c.payload) as Record<string, unknown>;
  try {
    const parts = encodeProfileEdit("acc_1", payload, { strict: c.strict !== false });
    if (c.error) { fail(`${c.name}: expected error ${c.error}, got a body`); continue; }
    const got = JSON.stringify(describeParts(parts));
    const want = JSON.stringify(c.expected);
    if (got !== want) fail(`${c.name}\n  want ${want}\n  got  ${got}`);
    // the FormData view carries exactly the same names, in the same order
    const names = [...toFormData(parts).keys()];
    const wantNames = parts.map(([k]) => k);
    if (JSON.stringify(names) !== JSON.stringify(wantNames)) fail(`${c.name}: FormData keys differ`);
  } catch (e) {
    if (!c.error) { fail(`${c.name}: unexpected error ${String((e as Error).message)}`); continue; }
    if (!(e instanceof ProfileSerialiserError) || e.code !== c.error) fail(`${c.name}: expected ${c.error}, got ${String((e as Error).message)}`);
  }
}
if (cases.length < 30) fail(`expected at least 30 golden cases, found ${cases.length}`);

// --- derived helpers
const same = (label: string, got: unknown, want: unknown) => { if (JSON.stringify(got) !== JSON.stringify(want)) fail(`${label}: want ${JSON.stringify(want)} got ${JSON.stringify(got)}`); };
same("fieldGroupsOf full", fieldGroupsOf({ headline: "h", summary: "s", picture_settings: { filter: "STUDIO" }, cover_picture_settings: {}, location: { id: "1" }, experience: { id: "e" }, education: { id: "ed" }, skills_follow: true, custom_link: { type: "WEBSITE", url: "https://x" } }),
  ["headline", "about", "photo", "cover", "location", "experience", "education", "skills", "custom_link"]);
same("fieldGroupsOf order is stable", fieldGroupsOf({ custom_link: { type: "WEBSITE", url: "https://x" }, headline: "h" }), ["headline", "custom_link"]);
same("unwrittenFieldsOf", unwrittenFieldsOf({ headline: "h", picture_settings: { filter: "EDGE" }, custom_link: { type: "BLOG", url: "https://x" } }), ["picture_settings", "custom_link"]);
same("sectionsForGroups never *", sectionsForGroups(["headline", "about", "experience", "custom_link", "photo"]), ["about", "experience"]);
same("sectionsForGroups empty for headline only", sectionsForGroups(["headline"]), []);
same("fidelity headline", fidelityOf("headline"), "full");
same("fidelity picture uploaded", fidelityOf("picture", { uploaded: true }), "full");
same("fidelity picture not uploaded", fidelityOf("picture"), "partial");
same("fidelity settings", fidelityOf("picture_settings"), "written_only");
same("fidelity custom_link", fidelityOf("custom_link"), "written_only");

if (failed) { console.error(`${failed} check(s) failed`); Deno.exit(1); }
console.log(`profile serialiser: ${cases.length} golden cases + helpers OK`);
