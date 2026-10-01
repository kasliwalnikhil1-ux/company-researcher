#!/usr/bin/env node
// Built-in clips for the web chat video bubble (Settings → Websites → Video bubble → "Built-in clips").
//
// Copies every MP4 / WebM / GIF / WebP from a folder into public/widget/v1/presets/ and writes presets.json, the list the
// settings screen shows. The widget plays a built-in clip from that folder (settings value `preset:<file>`), so the files
// ship with the Next.js app: run this, commit public/widget/v1/presets, deploy the app.
//
// Usage: node scripts/outreach-webchat-presets.mjs <folder>      (re-run after adding or removing files in the folder)
//        node scripts/outreach-webchat-presets.mjs               (rebuild presets.json from what is already in presets/)
// A file named "wave-hello.mp4" is listed as "Wave hello". Files over 20 MB are skipped: clips load on every page.

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'widget', 'v1', 'presets');
const KINDS = { '.mp4': 'video', '.m4v': 'video', '.webm': 'video', '.gif': 'image', '.webp': 'image' };
const MAX = 20 * 1048576;
const safe = (name) => name.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/-+\./g, '.').replace(/^-+|-+$/g, '');
const label = (file) => { const t = file.replace(/\.[^.]+$/, '').replace(/[-_.]+/g, ' ').trim(); return t.charAt(0).toUpperCase() + t.slice(1); };

mkdirSync(OUT, { recursive: true });
const from = process.argv[2] ? resolve(process.argv[2]) : null;
if (from) {
  if (!existsSync(from) || !statSync(from).isDirectory()) { console.error(`Not a folder: ${from}`); process.exit(1); }
  let copied = 0;
  for (const name of readdirSync(from).sort()) {
    const src = join(from, name), ext = extname(name).toLowerCase();
    if (!statSync(src).isFile()) continue;
    if (!KINDS[ext]) { console.log(`skip  ${name}  (not an MP4, WebM, GIF or WebP)`); continue; }
    if (statSync(src).size > MAX) { console.log(`skip  ${name}  (over 20 MB)`); continue; }
    copyFileSync(src, join(OUT, safe(name))); copied++;
    console.log(`copy  ${name}  ->  presets/${safe(name)}  (${(statSync(src).size / 1048576).toFixed(1)} MB)`);
  }
  if (!copied) console.log(`No clips found in ${from}.`);
}
const list = readdirSync(OUT).filter((f) => KINDS[extname(f).toLowerCase()]).sort().map((file) => ({ file, label: label(file), kind: KINDS[extname(file).toLowerCase()] }));
writeFileSync(join(OUT, 'presets.json'), JSON.stringify(list, null, 2) + '\n');
console.log(`presets.json: ${list.length} clip${list.length === 1 ? '' : 's'}`);
