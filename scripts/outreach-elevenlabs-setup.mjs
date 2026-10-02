#!/usr/bin/env node
// One-time setup of the PLATFORM voice account for the website assistant's voice (web-chat-voice-elevenlabs-PRD.md
// §7.2, §15): create our post-call webhook in the account and bind it for every agent, with retries on. The same idea
// as outreach-unipile-setup for the connector's webhooks. Safe to run again: an existing webhook with our address is
// reused (its secret cannot be read back; create a new one with --new when the secret is lost).
//
//   OUTREACH_ELEVENLABS_API_KEY=…  node scripts/outreach-elevenlabs-setup.mjs            look, create if missing, bind
//   … node scripts/outreach-elevenlabs-setup.mjs --check                                   only report what is there
//   … node scripts/outreach-elevenlabs-setup.mjs --new                                     always create a new webhook
//
// Reads from the environment, then from .env.local:
//   OUTREACH_ELEVENLABS_API_KEY        the platform account's key (needs Agents write + workspace webhooks)
//   OUTREACH_FUNCTIONS_BASE_URL        default: <NEXT_PUBLIC_SUPABASE_URL>/functions/v1/
//   OUTREACH_ELEVENLABS_API_BASE       default: https://api.elevenlabs.io
// Prints the webhook's signing secret ONCE. Set it as the function secret OUTREACH_ELEVENLABS_WEBHOOK_SECRET
// (add both keys to .env.local and run scripts/outreach-set-secrets.sh), then deploy outreach-elevenlabs-webhook.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fileEnv = {};
if (existsSync(join(root, '.env.local'))) {
  for (const line of readFileSync(join(root, '.env.local'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) fileEnv[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const env = (k) => process.env[k] || fileEnv[k] || '';
const KEY = env('OUTREACH_ELEVENLABS_API_KEY');
const API = (env('OUTREACH_ELEVENLABS_API_BASE') || 'https://api.elevenlabs.io').replace(/\/+$/, '');
const FN_BASE = (env('OUTREACH_FUNCTIONS_BASE_URL') || `${(env('NEXT_PUBLIC_SUPABASE_URL') || '').replace(/\/+$/, '')}/functions/v1/`).replace(/\/?$/, '/');
const URL_ = `${FN_BASE}outreach-elevenlabs-webhook`;
const check = process.argv.includes('--check'), fresh = process.argv.includes('--new');

if (!KEY) { console.error('OUTREACH_ELEVENLABS_API_KEY is not set (environment or .env.local).'); process.exit(1); }
if (!/^https:\/\/[^/]+\/functions\/v1\/outreach-elevenlabs-webhook$/.test(URL_)) { console.error(`The webhook address does not look right: ${URL_}\nSet OUTREACH_FUNCTIONS_BASE_URL or NEXT_PUBLIC_SUPABASE_URL.`); process.exit(1); }

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, { method, headers: { 'xi-api-key': KEY, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${typeof json?.detail === 'string' ? json.detail : json?.detail?.message ?? text.slice(0, 300)}`);
  return json;
}

try {
  const list = (await call('GET', '/v1/workspace/webhooks'))?.webhooks ?? [];
  const mine = list.filter((w) => (w.webhook_url ?? w.settings?.webhook_url) === URL_);
  const settings = await call('GET', '/v1/convai/settings');
  const bound = settings?.webhooks?.post_call_webhook_id ?? null;
  console.log(`Webhook address: ${URL_}`);
  console.log(`In the account:  ${mine.length ? mine.map((w) => w.webhook_id).join(', ') : 'none with this address'}`);
  console.log(`Bound for agents: ${bound ?? 'nothing'}${bound && mine.some((w) => w.webhook_id === bound) ? ' (ours)' : bound ? ' (NOT ours)' : ''}; events: ${(settings?.webhooks?.events ?? []).join(', ') || 'default'}`);
  if (check) process.exit(mine.some((w) => w.webhook_id === bound) ? 0 : 1);

  let id = !fresh && mine[0]?.webhook_id;
  if (!id) {
    const made = await call('POST', '/v1/workspace/webhooks', { settings: { auth_type: 'hmac', name: 'GrowthxAI website assistant (post-call)', webhook_url: URL_ } });
    id = made.webhook_id;
    console.log(`\nCreated webhook ${id}.`);
    if (made.webhook_secret) {
      console.log('\nIts signing secret (shown once). Add it to .env.local and push the function secrets:');
      console.log(`  OUTREACH_ELEVENLABS_WEBHOOK_SECRET=${made.webhook_secret}`);
      console.log('  bash scripts/outreach-set-secrets.sh');
    } else console.log('The provider returned no secret: read it in its dashboard (Agents → Settings → Webhooks) and set OUTREACH_ELEVENLABS_WEBHOOK_SECRET.');
  } else {
    console.log(`\nReusing webhook ${id}. Its secret cannot be read back: if OUTREACH_ELEVENLABS_WEBHOOK_SECRET is not set, run again with --new.`);
  }
  if (bound !== id || !(settings?.webhooks?.events ?? []).includes('transcript')) {
    await call('PATCH', '/v1/convai/settings', { webhooks: { post_call_webhook_id: id, events: ['transcript'], send_audio: false } });
    console.log(`Bound webhook ${id} as the post-call webhook (event: transcript). Recordings are streamed on demand, never pushed.`);
  } else console.log('Already bound.');
  console.log('\nRetries: switch "Retry failed webhooks" on for this webhook in the provider\'s dashboard if it is not (the API does not expose it).');
  console.log('A call whose webhook never arrives is still fetched by the worker 10 minutes after it ended.');
} catch (e) {
  console.error(String(e?.message ?? e));
  process.exit(1);
}
