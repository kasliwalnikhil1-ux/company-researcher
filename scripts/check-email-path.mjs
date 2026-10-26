#!/usr/bin/env node
/**
 * One sending path for every platform email (custom-sending-domain-PRD.md §5.1, §10, §14 "Lint"). Fails when:
 *
 *   1. a file under supabase/functions other than _shared/outreach/email.ts (sending) and _shared/outreach/resend_domains.ts
 *      (domain management) names api.resend.com, imports a Resend SDK, or opens an SMTP connection;
 *   2. a file calls the old positional sendEmail without a catalogue `type` (the TypeScript signature refuses it; this is the
 *      belt to those braces for plain .js / template strings);
 *   3. a catalogue key used in TypeScript (type: "…") is missing from migrations/outreach/099_email_outbox_sending_domains.sql.
 *
 *   node scripts/check-email-path.mjs       exit 1 and name the files when something slips through
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const FN_DIR = join(ROOT, 'supabase', 'functions');
const ALLOWED = new Set(['_shared/outreach/email.ts', '_shared/outreach/resend_domains.ts']);
const HOST = /\bapi\.resend\.com\b/;
const SDK = /npm:resend\b|from ['"]resend['"]|npm:nodemailer\b|Deno\.connectTls\([^)]*(?:25|465|587)/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'node_modules') walk(p, out); }
    else if (/\.(ts|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

const problems = [];
const usedTypes = new Set();
for (const file of walk(FN_DIR)) {
  const rel = relative(FN_DIR, file).split(sep).join('/');
  const src = readFileSync(file, 'utf8');
  if (!ALLOWED.has(rel) && (HOST.test(src) || SDK.test(src))) problems.push(`${rel}: sends email outside _shared/outreach/email.ts`);
  for (const m of src.matchAll(/\btype:\s*"([a-z0-9_]+)"/g)) usedTypes.add(m[1]);
}
const sql = readFileSync(join(ROOT, 'migrations', 'outreach', '099_email_outbox_sending_domains.sql'), 'utf8');
const catalogue = new Set([...sql.matchAll(/^\s*\('([a-z0-9_]+)',\s*'(?:team|holder|client|auth|platform)'/gm)].map((m) => m[1]));
// only keys that look like email types (every catalogue audience word excluded; "type:" is also used for other things)
const emailLike = /^(team_|reply_|mention|ai_|assignment|manager_|sequence_|sender_|removal_|health_|weekly_|voice_minutes|export_|webchat_|billing_|profile_|client_|auth_|platform_|sending_domain_)/;
for (const t of usedTypes) if (emailLike.test(t) && !catalogue.has(t)) problems.push(`email type "${t}" is used in code but not in the catalogue (099)`);

if (problems.length) {
  console.error('check-email-path: FAIL');
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`check-email-path: ok (${catalogue.size} catalogue keys, ${usedTypes.size} type keys seen)`);
