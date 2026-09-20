// Runs the shared render cases (render.cases.json) against the web copy of the renderer.
// No test framework on purpose: `npx tsx lib/outreach/render.test.ts` or
// `deno run --allow-read --allow-env --unstable-sloppy-imports lib/outreach/render.test.ts`, from the repo root.
// The Deno copy runs the same table in supabase/functions/_shared/outreach/render_test.ts.
import { readFileSync } from 'node:fs';
import { buildContext, missingVariables, renderTemplate, spintaxInfo, templateVariables } from './render';

interface RenderCase {
  name: string;
  kind: 'render' | 'build' | 'spintaxInfo' | 'missing' | 'variables';
  template: string;
  ctx?: any;
  rpc?: any;
  extras?: any;
  expected: unknown;
}

const file = process.env.RENDER_CASES ?? 'lib/outreach/render.cases.json';
const cases: RenderCase[] = JSON.parse(readFileSync(file, 'utf8'));

function actual(c: RenderCase): unknown {
  switch (c.kind) {
    case 'build': return renderTemplate(c.template, buildContext(c.rpc, c.extras));
    case 'spintaxInfo': return spintaxInfo(c.template);
    case 'missing': return missingVariables(c.template, c.ctx);
    case 'variables': return templateVariables(c.template);
    default: return renderTemplate(c.template, c.ctx);
  }
}

let failed = 0;
for (const c of cases) {
  const got = JSON.stringify(actual(c));
  const want = JSON.stringify(c.expected);
  if (got !== want) { failed++; console.error(`FAIL ${c.name}\n  want ${want}\n  got  ${got}`); }
}
// the pick must be stable: rendering twice with the same seed gives the same text
for (const c of cases) if ((c.kind === 'render' || !c.kind) && JSON.stringify(actual(c)) !== JSON.stringify(actual(c))) { failed++; console.error(`FAIL not deterministic: ${c.name}`); }

if (cases.length < 25) { failed++; console.error(`FAIL expected at least 25 cases, found ${cases.length}`); }
if (failed) { console.error(`${failed} of ${cases.length} render cases failed (lib/outreach/render.ts)`); process.exit(1); }
console.log(`ok: ${cases.length} render cases pass (lib/outreach/render.ts)`);
