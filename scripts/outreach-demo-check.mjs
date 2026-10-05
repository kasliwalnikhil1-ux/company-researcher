#!/usr/bin/env node
/**
 * Product tour checks (docs/outreach/PRODUCT-TOUR.md §7).
 *
 * Static (run by `npm run lint`):
 *   contract     every rpc / callFn / db.from name of the outreach UI is in contract.names.ts (the types make each one need a demo handler)
 *   import graph nothing under lib/outreach/backend/demo reaches utils/supabase, lib/api, the real provider, React or components
 *   manifest     every app/outreach/**\/page.tsx has an entry in backend/demo/routes.ts, and every entry has a file
 *   notYet       demo handlers marked notYet() (0 allowed after the build-out; --allow-not-yet=N while building)
 *
 * Browser (`npm run demo:check:e2e`, needs the app running; --base=http://localhost:3000):
 *   every manifest route opens under /product-tour with data, the label "Demo", no error screen
 *   and no E_DEMO_QUERY / E_DEMO_MISSING; zero requests to Supabase data endpoints or /api during the whole run and
 *   zero runtime blocks; the scripted workflows; /outreach signed out still goes to sign-in.
 *   Playwright: `playwright-core` from node_modules, or PLAYWRIGHT_CORE=<path to playwright-core>; browser from
 *   CHROME_PATH (else the installed Chrome).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const failures = [];
const fail = (check, msg) => failures.push(`[${check}] ${msg}`);
const ok = (check, msg) => console.log(`ok  ${check}: ${msg}`);

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
}
const rel = (p) => relative(ROOT, p).replace(/\\/g, '/');

// --- contract ----------------------------------------------------------------
try {
  execFileSync(process.execPath, [join(ROOT, 'scripts/outreach-demo-contract.mjs'), '--check'], { stdio: 'pipe' });
  ok('contract', 'contract.names.ts lists every name the outreach UI uses');
} catch (e) { fail('contract', String(e.stdout ?? '') + String(e.stderr ?? '')); }

// --- import graph --------------------------------------------------------------
const DEMO_DIR = join(ROOT, 'lib/outreach/backend/demo');
const FORBIDDEN = [
  /^utils\/supabase\//, /^lib\/api(\.ts)?$/, /^lib\/outreach\/api\.ts$/, /^lib\/outreach\/backend\/real\.ts$/, /^lib\/outreach\/backend\/index\.ts$/,
  /^components\//, /^contexts\//, /^app\//,
];
const FORBIDDEN_PKGS = [/^react($|\/)/, /^react-dom/, /^@tanstack\//, /^@supabase\//, /^next($|\/)/];
const EXT = ['.ts', '.tsx', '.mjs', '.js', '/index.ts', '/index.tsx'];
function resolveImport(from, spec) {
  let base;
  if (spec.startsWith('@/')) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else return { pkg: spec };
  if (existsSync(base) && statSync(base).isFile()) return { file: base };
  for (const e of EXT) if (existsSync(base + e)) return { file: base + e };
  return { missing: spec };
}
function importsOf(file) {
  const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const out = [];
  for (const m of src.matchAll(/(?:^|[\s;])(?:import|export)\s+(type\s+)?(?:[^'"`;]*?\sfrom\s+)?['"]([^'"]+)['"]/g)) if (!m[1]) out.push(m[2]);
  for (const m of src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
  return out;
}
{
  const seen = new Map();   // file → path of files that led there
  const queue = walk(DEMO_DIR).filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => [f, [rel(f)]]);
  let bad = 0;
  while (queue.length) {
    const [file, chain] = queue.shift();
    if (seen.has(file)) continue;
    seen.set(file, chain);
    for (const spec of importsOf(file)) {
      const r = resolveImport(file, spec);
      if (r.pkg) { if (FORBIDDEN_PKGS.some((x) => x.test(r.pkg))) { fail('import-graph', `${chain.join(' → ')} → ${r.pkg}`); bad++; } continue; }
      if (r.missing) continue;
      const rp = rel(r.file);
      if (FORBIDDEN.some((x) => x.test(rp))) { fail('import-graph', `${chain.join(' → ')} → ${rp}`); bad++; continue; }
      queue.push([r.file, [...chain, rp]]);
    }
  }
  if (!bad) ok('import-graph', `${seen.size} modules reachable from the demo provider, none reaches production code`);
}

// --- manifest ------------------------------------------------------------------
{
  const pages = walk(join(ROOT, 'app/outreach')).filter((f) => /[\\/]page\.tsx$/.test(f)).map((f) => rel(f).replace(/^app\/outreach\//, ''));
  const manifest = readFileSync(join(DEMO_DIR, 'routes.ts'), 'utf8');
  const listed = [...manifest.matchAll(/file:\s*'([^']+)'/g)].map((m) => m[1]);
  const missing = pages.filter((p) => !listed.includes(p));
  const stale = listed.filter((p) => !pages.includes(p));
  for (const p of missing) fail('manifest', `app/outreach/${p} has no entry in lib/outreach/backend/demo/routes.ts`);
  for (const p of stale) fail('manifest', `routes.ts lists ${p}, which no longer exists`);
  if (!missing.length && !stale.length) ok('manifest', `${pages.length} routes, all in the manifest`);
}

// --- notYet ----------------------------------------------------------------------
{
  const allowed = Number(args['allow-not-yet'] ?? 0);
  const hits = walk(DEMO_DIR).filter((f) => /\.(ts|tsx)$/.test(f) && !/[\\/]ctx\.ts$/.test(f))
    .flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/\bnotYet\(/g)].map(() => rel(f)));
  if (hits.length > allowed) fail('notYet', `${hits.length} demo handler(s) still marked notYet (allowed ${allowed}): ${[...new Set(hits)].join(', ')}`);
  else ok('notYet', `${hits.length} handler(s) marked notYet (allowed ${allowed})`);
}

if (!args.e2e) finish();
else await e2e().then(finish, (e) => { fail('e2e', e?.stack ?? String(e)); finish(); });

function finish() {
  if (failures.length) {
    console.error(`\n${failures.length} product tour check(s) failed:`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log('\nproduct tour checks passed');
  process.exit(0);
}

// =================================================================================
async function e2e() {
  const require = createRequire(import.meta.url);
  const pw = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
  const jiti = require(join(ROOT, 'node_modules/jiti'))(join(ROOT, 'x.js'), { interopDefault: true });
  const { ROUTES } = jiti(join(DEMO_DIR, 'routes.ts'));
  const base = String(args.base ?? 'http://localhost:3000').replace(/\/$/, '');
  const supabaseHost = (() => { try { return new URL(readEnv('NEXT_PUBLIC_SUPABASE_URL')).host; } catch { return null; } })();
  const executablePath = process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => existsSync(p));
  const browser = await pw.chromium.launch({ headless: !args.headed, executablePath });
  // a browser that dies would leave awaits pending forever and Node would exit silently: fail loudly instead
  browser.on('disconnected', () => { if (!closing) { fail('e2e', 'the browser disconnected during the run'); finish(); } });
  let closing = false;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const prodCalls = [];
  const consoleErrors = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (supabaseHost && u.host === supabaseHost && !u.pathname.startsWith('/auth/v1/')) prodCalls.push(r.url());
    if (u.origin === base && u.pathname.startsWith('/api/')) prodCalls.push(r.url());
  });
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  const LABEL = 'Demo';
  const demo = (path) => `${base}${path.replace(/^\/outreach/, '/product-tour')}`;
  const gx = (fn, arg) => page.evaluate(fn, arg);
  const ready = async () => {
    await page.waitForFunction(() => !!window.__gxdemo, null, { timeout: 60_000 });
    await page.waitForTimeout(400);
  };

  // first load + skip the welcome card
  await page.goto(demo('/outreach'), { waitUntil: 'domcontentloaded' });
  await ready();
  await page.locator('[data-demo-explore]').click({ timeout: 15_000 }).catch(() => {});
  const placeholders = await gx(() => {
    const s = window.__gxdemo.runtime.store;
    const chat = s.t('outreach_chats').find((c) => c.last_direction === 'in') ?? s.t('outreach_chats')[0];
    const cat = s.t('outreach_knowledge_sources').find((k) => k.kind === 'catalogue' || k.type === 'catalogue') ?? s.t('outreach_knowledge_sources')[0];
    const v = s.t('outreach_ai_variables')[0];
    return { __first_chat__: chat?.id, __first_catalogue__: cat?.id, __first_variable__: v?.id };
  });

  // --- every screen ---
  let screens = 0;
  for (const r of ROUTES) {
    if (r.demo === false) continue;
    let url = r.url;
    for (const [k, v] of Object.entries(placeholders)) url = url.replace(k, v ?? 'missing');
    const errsBefore = consoleErrors.length;
    if (args.verbose) console.log(`   … ${url}`);
    await page.goto(demo(url), { waitUntil: 'domcontentloaded' });
    await ready();
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(800);
    const state = await gx(() => ({
      label: document.body.innerText.includes('Demo'),
      text: document.querySelector('main')?.innerText.trim().length ?? 0,
      boundary: /Application error|Unhandled Runtime Error|Something went wrong|This page could not be found/i.test(document.body.innerText),
      path: window.location.pathname,
      loading: !!document.querySelector('main .animate-spin') && (document.querySelector('main')?.innerText.trim().length ?? 0) < 40,
    }));
    const newErrs = consoleErrors.slice(errsBefore).filter((e) => /E_DEMO_QUERY|E_DEMO_MISSING|E_DEMO_BLOCKED|pageerror/.test(e));
    if (!state.label) fail('screen', `${url}: the demo label is missing`);
    if (state.boundary) fail('screen', `${url}: an error screen is showing`);
    if (state.text < 40 || state.loading) fail('screen', `${url}: the main region is empty or still loading`);
    if (!state.path.startsWith('/product-tour')) fail('screen', `${url}: left the tour (now on ${state.path})`);
    for (const e of newErrs) fail('screen', `${url}: ${e.slice(0, 300)}`);
    screens++;
  }
  ok('screens', `${screens} screens opened under /product-tour`);

  // --- workflows (through the same backend the screens use) ---
  await page.goto(demo('/outreach'), { waitUntil: 'domcontentloaded' });
  await ready();
  const wf = await gx(async () => {
    const { runtime, backend: db } = window.__gxdemo;
    const out = {};
    const rpc = async (n, a) => { const r = await db.rpc(n, a); if (r.error) throw new Error(`${n}: ${r.error.message}`); return r.data; };
    const ws = runtime.ctx.ws;
    const s = runtime.store;
    // 1. create → publish → enroll 10 → skip a day → step stats and report totals rise together
    try {
      // the same calls the template picker makes: create, save the graph, then the pool and activation
      const id = await rpc('create_sequence', { p_workspace: ws, p_name: 'Check sequence', p_client_id: null });
      await rpc('save_sequence', { p_id: id, p_graph: s.get('outreach_sequences', '00000000-0000-4000-8000-5a0000000001').graph });
      const listed = (await db.from('outreach_sequences').select('id').eq('id', id)).data?.length === 1;
      const pool = ['00000000-0000-4000-8000-5e0000000001'];
      await rpc('set_pool', { p_sequence: id, p_pool: pool });
      await rpc('set_sequence_status', { p_id: id, p_status: 'active' });
      const leads = s.t('outreach_leads').filter((l) => !l.do_not_contact && !s.t('outreach_enrollments').some((e) => e.lead_id === l.id && ['active', 'waiting_connection', 'waiting_delay', 'waiting_task', 'paused'].includes(e.status))).slice(0, 10).map((l) => l.id);
      const enr = await rpc('enroll_leads', { p_sequence: id, p_lead_ids: leads, p_include_replied: true });
      const sentBefore = s.t('outreach_actions').filter((a) => a.status === 'sent').length;
      const dashBefore = await rpc('dashboard', { p_ws: ws });
      runtime.sim.skipDay();
      const stats = (await db.from('outreach_node_stats').select('*').eq('sequence_id', id)).data ?? [];
      const sentAfter = s.t('outreach_actions').filter((a) => a.status === 'sent').length;
      const dashAfter = await rpc('dashboard', { p_ws: ws });
      out.w1 = { listed, enrolled: enr?.enrolled ?? enr?.[0]?.enrolled, stepSent: stats.reduce((n, r) => n + r.sent, 0), newSent: sentAfter - sentBefore,
        dash7Before: dashBefore?.stats_7d, dash7After: dashAfter?.stats_7d };
    } catch (e) { out.w1 = { error: String(e) }; }
    // 2. a simulated reply arrives → unread rises → reply → shows as sent
    try {
      const before = (await rpc('dashboard', { p_ws: ws })).unread;
      const eng = runtime.engine ?? null;
      const chat = s.t('outreach_chats').find((c) => c.provider === 'LINKEDIN' && c.lead_id && !c.unread);
      const { engineFor } = window.__gxdemoEngine ?? {};
      void eng; void engineFor;
      s.insert('_demo_sim_events', { kind: 'reply', due_at: new Date(Date.now() - 1000).toISOString(), chat_id: chat.id, lead_id: chat.lead_id, sender_id: chat.sender_id }, { silent: true });
      runtime.sim.advance(60_000);
      const after = (await rpc('dashboard', { p_ws: ws })).unread;
      out.w2 = { chatId: chat.id, before, after };
    } catch (e) { out.w2 = { error: String(e) }; }
    // 3. import a CSV (the same upload + imports-create the CSV screen makes) → the leads count rises → a filter finds them
    try {
      const before = s.t('outreach_leads').length;
      const csv = 'First name,Last name,Company,Job title,LinkedIn URL,Work email\n'
        + Array.from({ length: 5 }, (_, i) => `Checky,Person${i},Zephyrine Check Co,Founder,https://www.linkedin.com/in/demo-check-person-${i},check${i}@example.com`).join('\n');
      const path = `${ws}/${Date.now()}-check.csv`;
      await db.storage.from('outreach-imports').upload(path, new Blob([csv], { type: 'text/csv' }), { contentType: 'text/csv', upsert: false });
      const mapping = { 'First name': 'first_name', 'Last name': 'last_name', Company: 'company', 'Job title': 'title', 'LinkedIn URL': 'linkedin_url', 'Work email': 'email_work' };
      const fields = { storage_path: path, mapping, row_count: 5, mode: 'upsert' };
      await db.fn('imports-create', { ...fields, params: fields, workspace_id: ws, kind: 'csv', sender_id: null, client_id: null, list_id: '00000000-0000-4000-8000-1a0000000001', tag_ids: [], enrich: false }, {});
      await new Promise((r) => setTimeout(r, 1500));
      const after = s.t('outreach_leads').length;
      const found = (await db.from('outreach_leads').select('id', { count: 'exact' }).eq('workspace_id', ws).or('company.ilike.%Zephyrine%,full_name.ilike.%Zephyrine%')).count;
      out.w3 = { before, after, found };
    } catch (e) { out.w3 = { error: String(e) }; }
    out.sendersBefore = s.t('outreach_senders').filter((x) => !x.deleted_at).length;
    out.plan = s.get('outreach_workspaces', ws)?.plan;
    return out;
  });
  if (wf.w3?.error) fail('workflow 3', wf.w3.error);
  else if (!(wf.w3.after - wf.w3.before >= 5) || !(wf.w3.found >= 5)) fail('workflow 3', `import: leads ${wf.w3.before} → ${wf.w3.after}, filter found ${wf.w3.found}`);
  else ok('workflow 3', `CSV import added ${wf.w3.after - wf.w3.before} leads and the search finds them`);

  // 4. connect a demo sender through the fake connect screen → it can go into a sequence's pool
  {
    const pending = page.evaluate(async () => {
      const { runtime, backend: db } = window.__gxdemo;
      const r = await db.fn('sender-connect', { workspace_id: runtime.ctx.ws, provider: 'LINKEDIN', client_id: null, owner_email: 'check.sender@example.com', display_name: 'Check Sender', recruiter: false, timezone: 'America/New_York', connect_method: 'credentials' }, {});
      const id = r.sender_id;
      const row = runtime.store.get('outreach_senders', id);
      const seq = '00000000-0000-4000-8000-5a0000000003';
      const pool = [...(runtime.store.get('outreach_sequences', seq).sender_pool ?? []), id];
      const p = await db.rpc('set_pool', { p_sequence: seq, p_pool: pool });
      return { id, status: row?.status, pooled: (runtime.store.get('outreach_sequences', seq).sender_pool ?? []).includes(id), poolError: p.error?.message ?? null, link: r.link };
    });
    await page.locator('[data-demo-connect]').click({ timeout: 15_000 });
    const c = await pending;
    if (c.status !== 'ok' || !c.pooled) fail('workflow 4', JSON.stringify(c));
    else ok('workflow 4', `connected a demo sender through the fake connect screen and put it in a sequence pool (${c.link})`);
  }

  // 5. change plan through the fake checkout → billing shows the new plan
  {
    const pending = page.evaluate(async () => {
      const { runtime, backend: db } = window.__gxdemo;
      const ws = runtime.ctx.ws;
      const before = await db.fn('billing', { action: 'quote', workspace_id: ws, plan: 'scale', accounts: 15, period: 'monthly' }, {}).catch((e) => ({ error: String(e) }));
      if (before.error) return { error: before.error };
      const r = await db.fn('billing', { action: before.quote?.mode === 'checkout' ? 'checkout' : 'change', workspace_id: ws, quote_id: before.quote_id }, {});
      const state = (await db.rpc('billing_state', { p_ws: ws })).data;
      return { plan: state?.plan, accounts: state?.accounts_billed, mode: before.quote?.mode, status: r?.status ?? null };
    });
    await page.locator('[data-demo-pay]').click({ timeout: 10_000 }).catch(() => {});
    const b = await pending;
    if (b.error) fail('workflow 5', b.error);
    else if (b.plan === wf.plan && b.accounts !== 15) fail('workflow 5', `billing still shows ${b.plan} (${b.accounts} accounts) after the change`);
    else ok('workflow 5', `plan changed through the fake checkout: now ${b.plan}, ${b.accounts} accounts`);
  }
  if (wf.w1?.error) fail('workflow 1', wf.w1.error);
  else {
    if (!wf.w1.listed) fail('workflow 1', 'the new sequence is not in the list');
    if (!(wf.w1.enrolled > 0)) fail('workflow 1', `enroll_leads enrolled ${wf.w1.enrolled}`);
    if (!(wf.w1.stepSent > 0)) fail('workflow 1', 'step stats did not rise after a simulated day');
    if (!(wf.w1.newSent >= wf.w1.stepSent)) fail('workflow 1', `step stats (${wf.w1.stepSent}) exceed the new sends (${wf.w1.newSent})`);
    ok('workflow 1', `created, enrolled ${wf.w1.enrolled}, ${wf.w1.stepSent} step sends after a day (${wf.w1.newSent} sends in the workspace)`);
  }
  if (wf.w2?.error) fail('workflow 2', wf.w2.error);
  else if (!(wf.w2.after > wf.w2.before)) fail('workflow 2', `unread did not rise (${wf.w2.before} → ${wf.w2.after})`);
  else {
    // open it and answer through the real compose box
    await page.goto(demo(`/outreach/inbox/${wf.w2.chatId}`), { waitUntil: 'domcontentloaded' });
    await ready();
    const box = page.locator('textarea').last();
    await box.fill('Thanks, talk soon!', { timeout: 15_000 });
    await box.press('Enter').catch(() => {});
    await page.locator('button:has-text("Send")').last().click({ timeout: 3_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const shown = await page.locator('text=Thanks, talk soon!').count();
    if (!shown) fail('workflow 2', 'the reply did not show in the thread');
    else ok('workflow 2', `reply arrived (unread ${wf.w2.before} → ${wf.w2.after}), answered and shown as sent`);
  }

  // 7. tour: finish, skip, restart
  await page.goto(demo('/outreach'), { waitUntil: 'domcontentloaded' });
  await ready();
  await page.locator('[data-demo-restart-tour]').click();
  for (let i = 0; i < 10; i++) {
    // wait for this step's own popover (the previous one stays up until the next page and target are ready)
    await page.locator('.driver-popover-progress-text', { hasText: `${i + 1} of 10` }).waitFor({ timeout: 20_000 });
    await page.locator('.driver-popover-next-btn').click();
  }
  await page.waitForTimeout(500);
  const tourDone = await gx(() => window.sessionStorage.getItem('gxdemo:tour'));
  if (tourDone !== 'done') fail('workflow 7', `tour state after finishing is ${tourDone}`);
  // the finish card covers the bar until it is closed
  await page.locator('[data-demo-finish-explore]').click();
  await page.locator('[data-demo-restart-tour]').click();
  await page.locator('.driver-popover').waitFor({ timeout: 15_000 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const tourSkipped = await gx(() => window.sessionStorage.getItem('gxdemo:tour'));
  if (tourSkipped !== 'skipped') fail('workflow 7', `tour state after skipping is ${tourSkipped}`);
  else ok('workflow 7', 'tour finished, skipped and restarted');

  // 6. reset → starting numbers (no button in the bar any more: the runtime's reset, then a reload, as DemoProvider does)
  await gx(() => window.__gxdemo.runtime.reset());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await ready();
  const afterReset = await gx(() => ({ seqs: window.__gxdemo.runtime.store.t('outreach_sequences').length, leads: window.__gxdemo.runtime.store.t('outreach_leads').length }));
  if (afterReset.seqs !== 6 || afterReset.leads !== 400) fail('workflow 6', `after reset: ${JSON.stringify(afterReset)}`);
  else ok('workflow 6', 'reset restored the starting data');

  // --- no production calls, no runtime blocks ---
  const blockedCount = await gx(() => (window.__gxdemoBlocked ?? []).length);
  if (prodCalls.length) fail('network', `${prodCalls.length} request(s) to production data services: ${[...new Set(prodCalls)].slice(0, 5).join(', ')}`);
  if (blockedCount) fail('network', `the runtime guard blocked ${blockedCount} request(s)`);
  if (!prodCalls.length && !blockedCount) ok('network', 'zero requests to Supabase data endpoints or /api, zero runtime blocks');

  // --- real mode unchanged ---
  const real = await (await browser.newContext()).newPage();
  await real.goto(`${base}/outreach`, { waitUntil: 'domcontentloaded' });
  await real.waitForURL(/\/login|\/signup|\/auth/, { timeout: 30_000 }).catch(() => {});
  const realState = await real.evaluate(() => ({ path: window.location.pathname, demo: !!window.__gxdemo }));
  if (!/login|signup|auth/.test(realState.path)) fail('real mode', `/outreach signed out stayed on ${realState.path}`);
  if (realState.demo) fail('real mode', 'the demo backend loaded on /outreach');
  if (/login|signup|auth/.test(realState.path) && !realState.demo) ok('real mode', '/outreach signed out still goes to sign-in, no demo code');

  closing = true;
  await browser.close();
}

function readEnv(name) {
  if (process.env[name]) return process.env[name];
  for (const f of ['.env.local', '.env']) {
    const p = join(ROOT, f);
    if (!existsSync(p)) continue;
    const m = new RegExp(`^${name}=(.*)$`, 'm').exec(readFileSync(p, 'utf8'));
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return '';
}
