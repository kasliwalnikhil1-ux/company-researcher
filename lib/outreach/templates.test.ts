// Every ready-made sequence must pass the same checks the server runs at activation (strict), with every step reachable.
// No test framework on purpose: `npx tsx lib/outreach/templates.test.ts` from the repo root.
import { validateGraph } from './graph';
import { SEQUENCE_TEMPLATES } from './templates';

let failed = 0;
const ids = new Set<string>();
for (const t of SEQUENCE_TEMPLATES) {
  if (ids.has(t.id)) { console.error(`duplicate template id ${t.id}`); failed++; }
  ids.add(t.id);
  const g = t.build();
  const { errors, warnings } = validateGraph(g, { strict: true, hasFreeSender: true });
  const problems = [...errors, ...warnings.filter((w) => w.code === 'W_UNREACHABLE' || w.code === 'W_BRANCH_MISSING')];
  // a rotate step must point at a step that exists
  for (const n of Object.values(g.nodes)) {
    if (n.type === 'rotate_sender' && !g.nodes[n.config?.restart_from]) problems.push({ node_id: n.id, code: 'E_RESTART_FROM', message: 'restart_from points to a missing step' });
    if (n.id !== 'start' && (n.type === 'start')) problems.push({ node_id: n.id, code: 'E_START', message: 'extra start step' });
  }
  if (problems.length) {
    failed++;
    console.error(`✗ ${t.name}`);
    for (const p of problems) console.error(`    ${p.node_id ?? '-'}: ${p.message}`);
  } else {
    console.log(`✓ ${t.name} (${Object.keys(g.nodes).length} steps, ${warnings.length} advisory warnings)`);
  }
}
if (failed) { console.error(`${failed} template(s) failed`); process.exit(1); }
console.log(`${SEQUENCE_TEMPLATES.length} templates OK`);
