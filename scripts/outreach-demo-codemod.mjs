#!/usr/bin/env node
/**
 * One-time codemod for the product tour seam (docs/outreach/PRODUCT-TOUR.md, phase 1). Safe to re-run: it only
 * rewrites patterns that are still there.
 *
 *   @/utils/supabase/client  supabase.x       → @/lib/outreach/backend  db.x
 *   next/link, next/navigation (client hooks)  → @/lib/outreach/nav
 *   localStorage.getItem/setItem/removeItem    → kv.… from @/lib/outreach/storage
 *   useAuth() from @/contexts/AuthContext      → useSessionUser() from @/lib/outreach/session
 *
 * Usage: node scripts/outreach-demo-codemod.mjs [--dry]
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SCAN = ['app/outreach', 'components/outreach', 'lib/outreach', 'contexts/OutreachWorkspaceContext.tsx'];
// Not part of the outreach product a visitor can open, or the seam itself.
const SKIP = [
  /lib[\\/]outreach[\\/](backend[\\/]|nav\.tsx$|mode\.ts$|storage\.ts$|session\.ts$|errors\.ts$)/,
  /app[\\/]outreach[\\/]invite[\\/]/,
  /\.test\.tsx?$/,
];
const dry = process.argv.includes('--dry');

function files(p) {
  const abs = join(ROOT, p);
  if (!existsSync(abs)) return [];
  if (statSync(abs).isFile()) return [abs];
  return readdirSync(abs).flatMap((f) => files(join(p, f)));
}

function addImport(src, line) {
  if (src.includes(line)) return src;
  // after the last top-level import statement (imports may span lines)
  const re = /^import[\s\S]*?from\s+['"][^'"]+['"];?[ \t]*$/gm;
  let last = null, m;
  while ((m = re.exec(src))) last = m;
  if (!last) {
    const directive = /^(['"])use client\1;?\s*\n/.exec(src);
    const at = directive ? directive[0].length : 0;
    return `${src.slice(0, at)}${line}\n${src.slice(at)}`;
  }
  const at = last.index + last[0].length;
  return `${src.slice(0, at)}\n${line}${src.slice(at)}`;
}

let changed = 0;
for (const f of SCAN.flatMap(files)) {
  if (!/\.(ts|tsx)$/.test(f) || SKIP.some((r) => r.test(f))) continue;
  const before = readFileSync(f, 'utf8');
  let s = before;

  // 1. Supabase client → db
  if (/from ['"]@\/utils\/supabase\/client['"]/.test(s)) {
    s = s.replace(/import\s*\{\s*supabase\s*\}\s*from\s*['"]@\/utils\/supabase\/client['"];?/, "import { db } from '@/lib/outreach/backend';");
    s = s.replace(/\bsupabase(\s*)\./g, 'db$1.');
  }

  // 2. next/link and next/navigation client hooks → nav wrappers (a server `redirect` import is left for the manual pass)
  s = s.replace(/from\s+['"]next\/link['"]/g, "from '@/lib/outreach/nav'");
  s = s.replace(/import\s*\{([^}]*)\}\s*from\s*['"]next\/navigation['"]/g, (all, names) => (/\b(redirect|notFound|permanentRedirect)\b/.test(names) ? all : `import {${names}} from '@/lib/outreach/nav'`));

  // 3. localStorage → kv
  if (/\b(?:window\.)?localStorage\.(getItem|setItem|removeItem)\(/.test(s)) {
    s = s.replace(/\b(?:window\.)?localStorage\.(getItem|setItem|removeItem)\(/g, 'kv.$1(');
    s = addImport(s, "import { kv } from '@/lib/outreach/storage';");
  }

  // 4. useAuth → useSessionUser (only the `{ user }` shape)
  if (/import\s*\{\s*useAuth\s*\}\s*from\s*['"]@\/contexts\/AuthContext['"]/.test(s) && !/useAuth\(\)\.(?!user\b)|\{[^}]*\b(signOut|session|signIn)\b[^}]*\}\s*=\s*useAuth\(\)/.test(s)) {
    s = s.replace(/import\s*\{\s*useAuth\s*\}\s*from\s*['"]@\/contexts\/AuthContext['"];?/, "import { useSessionUser } from '@/lib/outreach/session';");
    s = s.replace(/\buseAuth\(\)/g, 'useSessionUser()');
  }

  if (s !== before) {
    changed++;
    if (!dry) writeFileSync(f, s);
    console.log(`${dry ? '[dry] ' : ''}${relative(ROOT, f)}`);
  }
}
console.log(`[codemod] ${changed} file(s) ${dry ? 'would change' : 'changed'}`);
