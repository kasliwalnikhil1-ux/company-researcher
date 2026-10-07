#!/usr/bin/env node
/**
 * The health build check (health-page-PRD.md §5.1, D11). Fails when a call could skip the measuring:
 *
 *   1. every Edge Function entry file (supabase/functions/<name>/index.ts) must use withHealth — directly, or through
 *      serve() from _shared/outreach/supabase.ts, which wraps the handler in it;
 *   2. no file under supabase/functions may name a provider's API host or import a provider SDK, except the client
 *      modules listed in ALLOWED, and each of those must import the wrapper (fetchWithHealth / recordCall);
 *   3. no file other than _shared/outreach/llm.ts may call an AI model provider directly (the AI hosts are only allowed there).
 *
 *   node scripts/check-health-coverage.mjs        exit 1 and name the files when something slips through
 *
 * Runs on every deploy (scripts/outreach-deploy-functions.sh) and in `npm run lint`.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const FN_DIR = join(ROOT, 'supabase', 'functions');

/** Provider API hosts (documentation hosts such as developer.unipile.com are not matched). */
const HOSTS = [
  /\bapi\d*\.unipile\.com\b/, /\baccount\.unipile\.com\/api\b/,
  /\bapi\.resend\.com\b/, /\bapi\.stripe\.com\b/, /\bapi\.elevenlabs\.io\b/,
  /\bgenerativelanguage\.googleapis\.com\b/, /\bapi\.anthropic\.com\b/, /\bapi\.openai\.com\b/, /\baiplatform\.googleapis\.com\b/,
];
const AI_HOSTS = [/\bgenerativelanguage\.googleapis\.com\b/, /\bapi\.anthropic\.com\b/, /\bapi\.openai\.com\b/, /\baiplatform\.googleapis\.com\b/];
/** Provider SDK packages: a module importing one must go through recordCall (and is not on the allow list, so it fails). */
const SDKS = [/npm:stripe\b/, /npm:resend\b/, /npm:openai\b/, /npm:@anthropic-ai\//, /npm:@google\/(generative-ai|genai)\b/, /npm:elevenlabs\b/, /npm:@elevenlabs\//, /npm:unipile-node-sdk\b/, /from ['"]stripe['"]/, /from ['"]openai['"]/, /from ['"]@anthropic-ai\//];
/** The client modules that may name a host, because every call in them goes through the wrapper. */
const ALLOWED = new Set([
  '_shared/health.ts',
  '_shared/outreach/llm.ts',         // the AI transports (D11: the only place an AI model is called)
  '_shared/outreach/notify.ts',      // Resend
  '_shared/outreach/stripe.ts',      // Stripe
  '_shared/outreach/elevenlabs.ts',  // ElevenLabs
  '_shared/outreach/unipile.ts',     // Unipile (host comes from UNIPILE_DSN; listed so a literal there is still wrapped)
]);
const WRAPPER_IMPORT = /from ['"](?:\.\.\/)+health\.ts['"]/;

function walk(dir) {
  const out = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { if (f !== 'node_modules') out.push(...walk(p)); } else if (/\.(ts|js|mjs)$/.test(f)) out.push(p);
  }
  return out;
}

const problems = [];
if (!existsSync(FN_DIR)) { console.error('check-health-coverage: supabase/functions not found'); process.exit(1); }

// 1. entry files
for (const name of readdirSync(FN_DIR)) {
  const entry = join(FN_DIR, name, 'index.ts');
  if (name.startsWith('_') || !existsSync(entry)) continue;
  const src = readFileSync(entry, 'utf8');
  const usesServe = /\bserve\(/.test(src) && /from ['"]\.\.\/_shared\/outreach\/supabase\.ts['"]/.test(src) && /\bserve\b/.test(src.split(/from ['"]\.\.\/_shared\/outreach\/supabase\.ts['"]/)[0].split('import').pop() ?? '');
  const usesWithHealth = /\bwithHealth\(/.test(src);
  if (!usesServe && !usesWithHealth) problems.push(`${name}/index.ts: the handler is not wrapped in withHealth (use serve() from _shared/outreach/supabase.ts, or withHealth(name, handler))`);
  if (/\bDeno\.serve\(/.test(src) && !usesWithHealth) problems.push(`${name}/index.ts: Deno.serve() without withHealth`);
}

// 2 + 3. hosts and SDKs
for (const file of walk(FN_DIR)) {
  const rel = relative(FN_DIR, file).split(sep).join('/');
  if (/_test\.ts$/.test(rel) || /\.golden\.json$/.test(rel)) continue;
  const src = readFileSync(file, 'utf8');
  const hostHits = HOSTS.filter((h) => h.test(src));
  const sdkHits = SDKS.filter((h) => h.test(src));
  const aiHits = AI_HOSTS.filter((h) => h.test(src));
  if (sdkHits.length) problems.push(`${rel}: imports a provider SDK (${sdkHits.map(String).join(', ')}); call it through recordCall() from a client module on the allow list`);
  if (aiHits.length && rel !== '_shared/outreach/llm.ts' && rel !== '_shared/health.ts') problems.push(`${rel}: calls an AI provider directly (${aiHits.map(String).join(', ')}); AI model calls are made only inside _shared/outreach/llm.ts`);
  else if (hostHits.length && !ALLOWED.has(rel)) problems.push(`${rel}: names a provider API host (${hostHits.map(String).join(', ')}); move the call into the client module and use fetchWithHealth`);
  if (ALLOWED.has(rel) && rel !== '_shared/health.ts' && !WRAPPER_IMPORT.test(src)) problems.push(`${rel}: is on the allow list but does not import the wrapper from _shared/health.ts`);
}

if (problems.length) {
  console.error(`check-health-coverage: ${problems.length} problem${problems.length === 1 ? '' : 's'}\n` + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
console.log('check-health-coverage: every function is wrapped and every provider call goes through the wrapper.');
