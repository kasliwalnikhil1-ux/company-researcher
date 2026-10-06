# Product tour (`/product-tour`): how demo mode works

The product tour is the real outreach product, running on fictional data in the visitor's browser. No sign-in, no
connected accounts, and nothing reaches a production service. Spec: `product-tour-PRD.md` (repo root).

## One set of pages, two data providers

- `proxy.ts` rewrites `/product-tour` and `/product-tour/*` to the same `app/outreach/**` route files. The browser URL
  stays `/product-tour/…`.
- `/tour`, `/demo` and `/product` are aliases: the same tour, listed in `DEMO_PREFIXES` (`lib/outreach/mode.ts`, read by
  `proxy.ts`; also in `GROWTHXAI_PATHS`). `DEMO_PREFIX` is the prefix the visitor arrived on, so every link, redirect and
  return URL in the tour keeps it. Never build a tour path from a literal `/product-tour`: use `DEMO_PREFIX`,
  `toDemoPath()` or `tourPath()` (demo handlers), and `isDemoPath()` to test one.
- `lib/outreach/mode.ts`: `IS_DEMO` is read from the browser URL once per page load. Crossing between `/product-tour` and
  `/outreach` is always a full page load (`leaveDemo()`), and `DemoProvider` reloads the page if the URL ever leaves the
  prefix without one.
- `lib/outreach/backend/index.ts`: `db` is the only door to data. Real mode = `backend/real.ts` (Supabase, unchanged
  behaviour). Demo mode = `backend/demo/` (downloaded only on `/product-tour`).
  `rpc()` and `callFn()` in `lib/outreach/api.ts` delegate to `db`; components use `db.from / db.storage / db.channel`
  instead of the Supabase client.
- `lib/outreach/nav.tsx`: `Link`, `useRouter`, `usePathname` for the outreach UI. In demo mode `/outreach…` hrefs go to
  `/product-tour…`, and `usePathname()` reports `/outreach/…` so the existing active-state checks keep working.
- `lib/outreach/storage.ts`: `kv` (same calls as `localStorage`). Demo mode keeps it in `sessionStorage` under `gxdemo:`.
- `lib/outreach/session.ts`: `useSessionUser()` / `useOutreachAccess()`. Demo mode = the fictional owner, everything on.
- `app/outreach/layout.tsx`: demo branch = no `ProtectedRoute`, `DemoProvider` (loads the demo backend, the bar, the
  welcome card, the fake connect / checkout / consent steps, toasts, the Driver.js tour) around the same `MainLayout`
  (with its `demo` flag) and pages.

## The demo backend (`lib/outreach/backend/demo/`)

| File | What it is |
|---|---|
| `store.ts` | The in-memory "database" (production table names), seeded random, change events, `sessionStorage` persistence (`gxdemo:v<SEED_VERSION>:state`) |
| `query.ts` | `db.from()`: a PostgREST-compatible builder (select with embeds, filters incl. `or()`, order, range, single, insert/update/upsert/delete). Unsupported shapes throw `E_DEMO_QUERY` |
| `realtime.ts`, `storage.ts` | `db.channel()` fed by store events; `db.storage` buckets as object URLs |
| `ctx.ts` | Handler context and the complete-map types (`RpcHandlers`, `FnHandlers`) |
| `rpc/<area>.ts`, `fn/<area>.ts` | One handler per SQL RPC and edge function, by area |
| `seed/` | The starting data (`seed/index.ts` order; `seed/core.ts` + one file per area) |
| `sim/` | The engine (moves enrollments through the real sequence graphs), caps and working hours, computed tables (node stats, budgets), the clock |
| `ai.ts` | Local "AI" output (no model is called) |
| `routes.ts` | The route manifest |

Time: while activity is On, every 4 s is 2 simulated hours (Fast: 8 h); "Skip a day" is 24 h. Time moves by shifting
every stored timestamp into the past, so "now" stays the real now and waits fall due on their own. Working hours are
judged on `simWallClock` (real now + the offset), never on the real clock.

### Replies / Sent (migration 075)

- **Derived columns** (`inbox/direction.ts`): `outreach_chats.first_inbound_at / last_inbound_at / first_outbound_at /
  last_outbound_at / last_auto_reply_at / waiting_on / ai_answering` and `outreach_messages.replied_at / is_auto_reply /
  is_bounce / bounced_at` are recomputed from the messages before any read of either table (a `beforeRead` hook chained
  after the snooze wake-up, cached on `store.rev`), with 075's rules: `outreach__msg_kind`, the email bounce /
  auto-reply subject rules and the `ooo` intent (`_kind_intent` remembers the intent the flags were set for, so a
  correction away from `ooo` clears it), the window + step-credit rule for `replied_at`, `outreach__chat_ai_answering`.
  They are written onto the rows in place (no change event) and are read-only through `db.from()`.
- **RPCs** (`inbox/sent.ts`, wired in `rpc/inbox.ts`): `inbox_sent_list` (the six sources of `outreach_sent_items`,
  keyset `{at, id}` paging, filters, the 90-day cap, `E_FORBIDDEN` for client viewers when
  `settings.inbox_show_sent_to_clients = false`) and `inbox_counts`. Before answering they do what the real workers
  would have done by now: AI holds that are over go out, snoozed chats wake up.
- **Scheduled comes from the engine's planner** (`sim/engine.ts`): a blocked send step gets the sender's next slot
  (working hours, today's allowance, a stable spread), `planAhead` plans the send after a delay / a reply window that
  ends before the end of the next working day, and a step with a planned slot waits for it, so "Scheduled · 14:20"
  goes out at 14:20. A reply (stop on reply), a branch or the end of the enrollment cancels what it no longer needs,
  so those rows leave Scheduled. The clock sends AI holds whose time it moved past (`sendDueHolds`).
- **Seed** (`seed/sent.ts`, after the inbox seed): leads that just accepted (first message planned), agency leads whose
  reply window ends (email planned), Leo's disconnected account holding three invitations, one paused lead, two AI
  replies in their hold (one warm-up), four recoverable failed steps (rate limit, timeout, LinkedIn error, an
  invitation sent too recently), a bounced email with its mailer-daemon notice, two email out-of-office replies (one
  followed by a real answer) and two replies sent from outside the app (`origin: external_device`). LinkedIn never gets
  an out-of-office in the tour.

## Guards: the demo can never reach production

1. The mode is the URL, fixed per page load.
2. `backend/demo/**` cannot import the Supabase client, `lib/api`, the real provider, React or components, and cannot
   use `fetch` / XHR / WebSocket / EventSource / `sendBeacon` (ESLint + the import-graph check).
3. The outreach UI cannot bypass the seam: no Supabase client, `lib/api`, `next/link`, `next/navigation`,
   `localStorage` or bare `fetch` in `app/outreach`, `components/outreach`, `lib/outreach` (ESLint).
4. Runtime block (`components/outreach/demo/guard.ts`): on `/product-tour`, any request to the Supabase data endpoints,
   to `/api/*` or to an unknown host is refused (`E_DEMO_BLOCKED`) and counted.

## Adding or changing a feature (keep the tour in sync)

1. Build the feature as usual, through `db` / `rpc` / `callFn` and `@/lib/outreach/nav`.
2. `npm run demo:contract`: adds any new RPC, function or table name to `backend/contract.names.ts`.
3. `npx tsc --noEmit`: a new name without a demo handler is a type error in `backend/demo/rpc/index.ts` or `fn/index.ts`.
   Add the handler in the area file (`rpc/<area>.ts`), computed from the store, same shape as the SQL / function.
4. Seed the rows the screen needs (`seed/<area>.ts`). Fictional only: invented names, `@example.com`, `+1 555 01xx`. Photos come only from `public/faces` (160px WebP, ~2.5 KB, face box filling the middle half; `w*` women / `m*` men; w01–w09 and m01–m07 are the marketing site's portraits): senders by name in `seed/faces.ts`, leads via `seedFaces`, which runs last.
5. A new screen: add it to `backend/demo/routes.ts`.
6. Something that would touch the outside world (send, connect, pay, export, webhook): show the normal success state and
   call `ctx.ui.simulated()`; for a hosted step use `await ctx.ui.dialog({ kind: 'connect' | 'checkout' | 'consent', … })`.
7. `npm run lint` (runs `demo:check`) and, with the app running, `npm run demo:check:e2e -- --base=http://localhost:3000`.

## Checks

`scripts/outreach-demo-check.mjs`: contract up to date, import graph, route manifest, `notYet` count (0); with `--e2e`:
every manifest route opens under `/product-tour` with the demo label and no error, the scripted workflows, zero
requests to Supabase data endpoints or `/api`, zero runtime blocks, and `/outreach` signed out still goes to sign-in.
Playwright comes from `playwright-core` (or `PLAYWRIGHT_CORE=<path>`), the browser from `CHROME_PATH` or the installed Chrome.
