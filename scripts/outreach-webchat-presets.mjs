#!/usr/bin/env node
// Built-in media for the web chat widget:
//   clips    Settings → Websites → Video bubble → "Built-in clips"   public/widget/v1/presets/  + presets.json
//   avatars  Settings → Websites → Appearance → "Bot avatar"         public/widget/v1/avatars/  + avatars.json
//
// Copies every matching file from a folder into the widget folder and writes the list the settings screen shows. The
// widget loads a built-in file from that folder (settings value `preset:<file>`), so the files ship with the Next.js
// app: run this, commit public/widget/v1/presets (or avatars), deploy the app.
//
// Usage: node scripts/outreach-webchat-presets.mjs [--avatars] <folder>   (re-run after adding or removing files in the folder)
//        node scripts/outreach-webchat-presets.mjs [--avatars]            (rebuild the list from what is already there)
// A file named "wave-hello.mp4" is listed as "Wave hello". Clips over 20 MB and avatars over 1 MB are skipped: clips load
// on every page, avatars every time the chat opens. Shrink them first (clips: 720p, ≤ 15 s; avatars: 256×256 squares).

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2), avatars = args.includes('--avatars');
const MODE = avatars
  ? { dir: 'avatars', list: 'avatars.json', what: 'avatar', types: 'JPG, PNG, WebP or GIF', max: 1, kinds: { '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.webp': 'image', '.gif': 'image' } }
  : { dir: 'presets', list: 'presets.json', what: 'clip', types: 'MP4, WebM, GIF or WebP', max: 20, kinds: { '.mp4': 'video', '.m4v': 'video', '.webm': 'video', '.gif': 'image', '.webp': 'image' } };
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'widget', 'v1', MODE.dir);
const KINDS = MODE.kinds;
const MAX = MODE.max * 1048576;
const safe = (name) => name.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/-+\./g, '.').replace(/^-+|-+$/g, '');
const label = (file) => { const t = file.replace(/\.[^.]+$/, '').replace(/[-_.]+/g, ' ').trim(); return t.charAt(0).toUpperCase() + t.slice(1); };

mkdirSync(OUT, { recursive: true });
const folder = args.find((a) => a !== '--avatars');
const from = folder ? resolve(folder) : null;
if (from) {
  if (!existsSync(from) || !statSync(from).isDirectory()) { console.error(`Not a folder: ${from}`); process.exit(1); }
  let copied = 0;
  for (const name of readdirSync(from).sort()) {
    const src = join(from, name), ext = extname(name).toLowerCase();
    if (!statSync(src).isFile()) continue;
    if (!KINDS[ext]) { console.log(`skip  ${name}  (not a ${MODE.types})`); continue; }
    if (statSync(src).size > MAX) { console.log(`skip  ${name}  (over ${MODE.max} MB)`); continue; }
    copyFileSync(src, join(OUT, safe(name))); copied++;
    console.log(`copy  ${name}  ->  ${MODE.dir}/${safe(name)}  (${(statSync(src).size / 1048576).toFixed(2)} MB)`);
  }
  if (!copied) console.log(`No ${MODE.what}s found in ${from}.`);
}
const list = readdirSync(OUT).filter((f) => KINDS[extname(f).toLowerCase()]).sort().map((file) => ({ file, label: label(file), kind: KINDS[extname(file).toLowerCase()] }));
writeFileSync(join(OUT, MODE.list), JSON.stringify(list, null, 2) + '\n');
console.log(`${MODE.list}: ${list.length} ${MODE.what}${list.length === 1 ? '' : 's'}`);
