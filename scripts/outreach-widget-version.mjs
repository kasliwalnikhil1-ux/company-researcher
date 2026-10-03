// Stamps the web chat loader with a hash of each file it fetches (chat.js, video.js, ask.js, voice.js), so those files
// can be cached by browsers for a year: the loader asks for `chat.js?v=<hash>`, and a changed file gets a new address.
// Runs before every `npm run build` (the `prebuild` script), so a deploy always carries the right hashes even when
// nobody ran it by hand. The loader itself stays on a short cache (next.config.mjs).
//
//   node scripts/outreach-widget-version.mjs           write the hashes into public/widget/v1/loader.js
//   node scripts/outreach-widget-version.mjs --check   exit 1 when they are out of date
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'widget', 'v1');
const FILES = ['chat.js', 'video.js', 'ask.js', 'voice.js'];
const MARK = /var VER = \{[^}]*\};(\s*\/\/ widget-version)/;

// line endings normalised: a Windows checkout (CRLF) and the build machine (LF) get the same hash
const hash = (f) => createHash('sha256').update(readFileSync(join(DIR, f), 'utf8').replace(/\r\n/g, '\n')).digest('hex').slice(0, 10);
const ver = Object.fromEntries(FILES.map((f) => [f, hash(f)]));
const loaderPath = join(DIR, 'loader.js');
const loader = readFileSync(loaderPath, 'utf8');
if (!MARK.test(loader)) { console.error('loader.js has no "var VER = {...};   // widget-version" line'); process.exit(1); }
const next = loader.replace(MARK, (_, tail) => `var VER = ${JSON.stringify(ver)};${tail}`);

if (process.argv.includes('--check')) {
  if (next !== loader) { console.error('public/widget/v1/loader.js has stale file hashes. Run: node scripts/outreach-widget-version.mjs'); process.exit(1); }
  console.log('widget file hashes are up to date.');
} else {
  if (next !== loader) writeFileSync(loaderPath, next);
  console.log(`loader.js: ${FILES.map((f) => `${f}?v=${ver[f]}`).join('  ')}`);
}
