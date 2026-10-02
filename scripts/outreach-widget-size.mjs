// Size check for the web chat widget files (public/widget/v1): each file's gzip size against its budget.
// The loader runs on every page view of every customer site, so it has the tightest budget; chat.js, video.js and
// ask.js are fetched only when they are needed. voice.js carries the voice provider's SDK (WebRTC) and is fetched only
// when a visitor starts a call; it is built by scripts/outreach-widget-build.mjs. Fails (exit 1) when a file is over its budget or does not parse.
//
//   node scripts/outreach-widget-size.mjs        (also part of `npm run lint`)
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'widget', 'v1');
// gzip budgets in bytes: what the file weighs today plus a little room. Raise one on purpose, in the same change that needs it.
const BUDGET = { 'loader.js': 13_600, 'chat.js': 47_500, 'video.js': 10_500, 'ask.js': 5_000, 'voice.js': 185_000 };

let failed = false;
for (const [file, budget] of Object.entries(BUDGET)) {
  let src;
  try { src = readFileSync(join(DIR, file)); } catch { console.error(`FAIL  ${file}: missing`); failed = true; continue; }
  try { new Function(src.toString('utf8')); } catch (e) { console.error(`FAIL  ${file}: does not parse (${e.message})`); failed = true; continue; }
  const gz = gzipSync(src, { level: 9 }).length, over = gz > budget;
  console.log(`${over ? 'FAIL' : 'ok  '}  ${file.padEnd(10)} ${(gz / 1024).toFixed(1).padStart(5)} KB gzip (${(src.length / 1024).toFixed(1)} KB raw), budget ${(budget / 1024).toFixed(1)} KB`);
  if (over) failed = true;
}
process.exit(failed ? 1 : 0);
