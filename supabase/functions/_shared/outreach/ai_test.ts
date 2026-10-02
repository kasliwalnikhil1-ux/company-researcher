// SUPABASE_URL=http://localhost SUPABASE_SERVICE_ROLE_KEY=x SUPABASE_ANON_KEY=x deno test -A --node-modules-dir=none supabase/functions/_shared/outreach/ai_test.ts
// (ai.ts imports llm.ts → supabase.ts, which reads its env at load time; no database and no model is touched)
// The check in code for the built-in AI variables (ai-fields-json-changes.md §18): every word of the result must come from
// the lead's own field, apart from of / and / the / at / in / for / &. builtinPasses is pure.
import { builtinPasses, generateBuiltin, isBuiltinKey, BUILTIN_PROMPTS } from "./ai.ts";

function ok(got: boolean, want: boolean, label: string): void {
  if (got !== want) throw new Error(`${label}: want ${want}, got ${got}`);
}

Deno.test("a tidied first name passes", () => {
  ok(builtinPasses("Priya", ["DR. PRIYA", "DR. PRIYA SHARMA, MBA"]), true, "Priya from DR. PRIYA SHARMA, MBA");
  ok(builtinPasses("Priya", [null, "DR. PRIYA SHARMA, MBA 🚀"]), true, "found in the second source");
  ok(builtinPasses("Jean-Luc", ["JEAN-LUC", "Jean-Luc Picard"]), true, "hyphenated name");
  ok(builtinPasses("Zoë", ["ZOË", "ZOË KRAVITZ"]), true, "non-ASCII letters, case-insensitive");
  ok(builtinPasses("Priya", ["𝐏𝐫𝐢𝐲𝐚 𝐒𝐡𝐚𝐫𝐦𝐚"]), true, "styled letters compare as plain ones");
});

Deno.test("a tidied title may add joining words", () => {
  ok(builtinPasses("VP of Sales", ["VP Sales & Partnerships | Ex-Google"]), true, "VP of Sales");
  ok(builtinPasses("Founder & CEO", ["Founder & CEO @ Acme | Helping teams scale"]), true, "& is kept");
  ok(builtinPasses("Head of Growth", ["HEAD OF GROWTH - ACME"]), true, "all-caps source");
});

Deno.test("a tidied company passes", () => {
  ok(builtinPasses("Acme", ["Acme Technologies Pvt. Ltd. | We build payment rails", "ACME TECH"]), true, "Acme");
  ok(builtinPasses("Boston Consulting Group", ["THE BOSTON CONSULTING GROUP, INC."]), true, "BCG");
});

Deno.test("a word that is not in the source fails", () => {
  ok(builtinPasses("VP of Marketing", ["VP Sales & Partnerships | Ex-Google"]), false, "Marketing is invented");
  ok(builtinPasses("Priyanka", ["DR. PRIYA SHARMA, MBA"]), false, "a longer name is another word");
  ok(builtinPasses("Vice President of Sales", ["VP Sales"]), false, "an expanded abbreviation");
  ok(builtinPasses("Acme Inc", ["Acme Technologies"]), false, "an added suffix");
});

Deno.test("empty results and joining words alone fail", () => {
  ok(builtinPasses("", ["Priya"]), false, "empty");
  ok(builtinPasses("   ", ["Priya"]), false, "blank");
  ok(builtinPasses(null, ["Priya"]), false, "null");
  ok(builtinPasses("🚀", ["Priya 🚀"]), false, "no word at all");
  ok(builtinPasses("of the", ["Head Growth"]), false, "joining words only");
  ok(builtinPasses("Priya", []), false, "no source");
  ok(builtinPasses("Priya", [null, ""]), false, "empty source");
});

Deno.test("generateBuiltin makes no call when it does not need one", async () => {
  // no source text → null; a clean first name → returned as it is; an unknown key → null. None of these reaches the model.
  const none = await generateBuiltin({ workspaceId: "w", key: "company_conversation", source: [null, "  "] });
  if (none.text !== null || none.model !== null) throw new Error(`no source: ${JSON.stringify(none)}`);
  const clean = await generateBuiltin({ workspaceId: "w", key: "contact_first_name", source: ["Priya", "Priya Sharma"] });
  if (clean.text !== "Priya" || clean.model !== null) throw new Error(`clean first name: ${JSON.stringify(clean)}`);
  const unknown = await generateBuiltin({ workspaceId: "w", key: "icebreaker", source: ["Priya"] });
  if (unknown.text !== null) throw new Error(`unknown key: ${JSON.stringify(unknown)}`);
});

Deno.test("the three built-in keys have a prompt", () => {
  for (const k of ["contact_first_name", "company_conversation", "position_conversational"]) {
    if (!isBuiltinKey(k) || !BUILTIN_PROMPTS[k].includes('{"text"')) throw new Error(`missing prompt: ${k}`);
  }
  if (isBuiltinKey("icebreaker") || isBuiltinKey("toString")) throw new Error("isBuiltinKey accepts an unknown key");
});
