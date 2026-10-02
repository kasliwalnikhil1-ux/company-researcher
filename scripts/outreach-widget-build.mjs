#!/usr/bin/env node
// Builds public/widget/v1/voice.js from widget-src/voice.js (web-chat-voice-elevenlabs-PRD.md §8).
// The other widget files are hand-written and served as they are; voice.js is the one file that bundles a dependency:
// the voice provider's browser SDK (@elevenlabs/client, which brings livekit-client for WebRTC). The built file is
// committed like the rest of the widget, so deploying the app needs no build step for it.
//
//   node scripts/outreach-widget-build.mjs            build
//   node scripts/outreach-widget-build.mjs --check    exit 1 when public/widget/v1/voice.js is not what the source builds
//   node scripts/outreach-widget-build.mjs --sdk=<file> --out=<file>   tests: another module in place of the SDK
//
// The SDK and the bundler are NOT dependencies of the web app. They are installed, pinned, into
// node_modules/.cache/outreach-widget-voice on first use (npm must be on PATH). To move to a newer SDK: change the
// version below, build, run the widget tests, commit voice.js.
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PINS = { '@elevenlabs/client': '1.26.0', esbuild: '0.25.10' };
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cache = join(root, 'node_modules', '.cache', 'outreach-widget-voice');
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const check = process.argv.includes('--check');
const out = resolve(arg('out') ?? join(root, 'public', 'widget', 'v1', 'voice.js'));
const sdk = arg('sdk') ? resolve(arg('sdk')) : null;

// --- the pinned toolchain ------------------------------------------------------------------------------------------
const want = JSON.stringify({ name: 'outreach-widget-voice-build', private: true, dependencies: PINS }, null, 2);
const installed = (name) => { try { return JSON.parse(readFileSync(join(cache, 'node_modules', name, 'package.json'), 'utf8')).version; } catch { return null; } };
if (Object.entries(PINS).some(([name, v]) => installed(name) !== v)) {
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, 'package.json'), want);
  console.log(`Installing ${Object.entries(PINS).map(([n, v]) => `${n}@${v}`).join(', ')} into ${cache} …`);
  execSync('npm install --no-audit --no-fund --loglevel=error', { cwd: cache, stdio: 'inherit' });
}
const esbuild = createRequire(pathToFileURL(join(cache, 'package.json')))('esbuild');

// --- build ---------------------------------------------------------------------------------------------------------
const result = await esbuild.build({
  entryPoints: [join(root, 'widget-src', 'voice.js')],
  bundle: true, format: 'iife', platform: 'browser', target: ['es2020'], minify: true, write: false,
  legalComments: 'eof', charset: 'utf8', logLevel: 'warning',
  nodePaths: [join(cache, 'node_modules')],
  define: { 'process.env.NODE_ENV': '"production"' },
  ...(sdk ? { alias: { '@elevenlabs/client': sdk } } : {}),
  banner: { js: `/*! GrowthxAI web chat — voice v1. Built from widget-src/voice.js by scripts/outreach-widget-build.mjs${sdk ? ' (TEST BUILD: stand-in SDK)' : ` with @elevenlabs/client ${PINS['@elevenlabs/client']}`}. Do not edit. */` },
});
const built = result.outputFiles[0].text;

if (check) {
  const have = existsSync(out) ? readFileSync(out, 'utf8') : '';
  if (have.replace(/\r\n/g, '\n') !== built.replace(/\r\n/g, '\n')) { console.error(`${out} is out of date. Run: node scripts/outreach-widget-build.mjs`); process.exit(1); }
  console.log('voice.js is up to date.');
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, built);
  const { gzipSync } = await import('node:zlib');
  console.log(`${out}: ${(built.length / 1024).toFixed(1)} KB, ${(gzipSync(built, { level: 9 }).length / 1024).toFixed(1)} KB gzip`);
}
