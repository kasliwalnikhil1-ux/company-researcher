// Runs the shared render cases (lib/outreach/render.cases.json) against the Deno copy of the renderer.
// deno test --allow-read --node-modules-dir=none supabase/functions/_shared/outreach/render_test.ts
import { buildContext, missingVariables, renderTemplate, spintaxInfo, templateVariables } from "./render.ts";

interface RenderCase { name: string; kind?: string; template: string; ctx?: any; rpc?: any; extras?: any; expected: unknown }

const casesUrl = new URL("../../../../lib/outreach/render.cases.json", import.meta.url);
const cases: RenderCase[] = JSON.parse(await Deno.readTextFile(casesUrl));

function actual(c: RenderCase): unknown {
  switch (c.kind) {
    case "build": return renderTemplate(c.template, buildContext(c.rpc, c.extras));
    case "spintaxInfo": return spintaxInfo(c.template);
    case "missing": return missingVariables(c.template, c.ctx);
    case "variables": return templateVariables(c.template);
    default: return renderTemplate(c.template, c.ctx);
  }
}

function same(got: unknown, want: unknown, label: string): void {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`${label}\n  want ${w}\n  got  ${g}`);
}

Deno.test("the shared table has at least 25 cases", () => {
  if (cases.length < 25) throw new Error(`found ${cases.length}`);
});

for (const c of cases) {
  Deno.test(`render: ${c.name}`, () => {
    same(actual(c), c.expected, c.name);
    same(actual(c), actual(c), `${c.name} (deterministic)`);
  });
}

Deno.test("two seeds can give different text, one seed always gives the same", () => {
  const t = "{Hi|Hello|Hey|Good day|Greetings} {a|b|c|d|e} {1|2|3|4|5}";
  const outs = new Set<string>();
  for (let i = 0; i < 20; i++) outs.add(renderTemplate(t, { lead: {}, seed: `seed-${i}` }));
  if (outs.size < 5) throw new Error(`expected variety across seeds, got ${outs.size}`);
  same(renderTemplate(t, { lead: {}, seed: "seed-3" }), renderTemplate(t, { lead: {}, seed: "seed-3" }), "stable");
});
