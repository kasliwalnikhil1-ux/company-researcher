# PRD: Product tour (`/product-tour`) — the real product in demo mode

**Source:** `product-tour-instructions.txt`.
**App:** `capitalxai-app` at commit `5aaef62`.
**Goal:** a visitor opens `/product-tour` and uses the whole outreach product with fictional data. They need no login and no connected accounts, and nothing ever reaches a production service. The tour runs the same pages, components, navigation and business logic as `/outreach`. Only the source of the data changes.

---

## 0. Summary

| # | Decision |
|---|---|
| 1 | `/product-tour/*` serves the **same route files** as `/outreach/*` through a rewrite. No page is copied |
| 2 | All data access in the outreach UI goes through one **backend** object with two interchangeable providers: **real** (Supabase, today's behaviour) and **demo** (in-memory, in the browser) |
| 3 | The demo provider holds a small local "database" (the same table names as production) plus local handlers for every RPC and edge-function call. Dashboards and reports are computed from that data, so screens always agree |
| 4 | A local **simulator** moves campaigns forward: sends, accepts, replies, bounces. It works on fictional prospects and uses the app's own sequence and template logic |
| 5 | Demo state lives in memory and in `sessionStorage`. **Reset demo** restores the starting data |
| 6 | Four guards mean a demo action cannot reach production: the mode is fixed from the URL, the demo provider has no access to the Supabase client, lint rules block direct calls, and a runtime block refuses any request to production hosts |
| 7 | A bar that is always visible: **"Demo"** · Restart tour · Reset demo · **Start your outreach** |
| 8 | A short, skippable Driver.js walkthrough of the main workflow (`driver.js` is already in `package.json`) |
| 9 | Staying in sync: typed contracts make the build fail when a feature is added without its demo side, plus a check script that opens every screen in demo mode |

**What the code looks like today** (this is what sets the size of the work):

| | Count |
|---|---|
| Route pages under `app/outreach` | 52 |
| Files importing the Supabase client in the outreach UI | 58 |
| Tables read or written directly (`supabase.from`) | 49 |
| Distinct SQL RPCs called through `rpc()` | 239 (312 call sites) |
| Edge functions called through `callFn()` | 19 |
| Realtime channels | 4 |
| Storage call sites | 11 |
| Files with literal `/outreach…` links | 100 (246 references) |

`rpc()` and `callFn()` already live in one file (`lib/outreach/api.ts`), which makes the switch between providers small. The direct `supabase.from` calls are the part that needs a mechanical change.

---

## 1. Scope

**In:** every screen an owner sees in the outreach product: Dashboard, Inbox, Senders (including profiles and connect), Leads (list, detail, import), Sequences (list, builder, versions, enroll), Tasks, AI (Needs you, Activity, Knowledge, Setup), Website assistant, Reports, Clients (including the client portal view), Billing, and all Settings pages.

**Out, and why:**

| Not in the tour | Reason |
|---|---|
| `/outreach/settings/admin` (platform admin) | Internal tool, not a customer feature. Hidden in demo |
| `/outreach/invite/[token]` | An entry page for a real invitation, not a product screen |
| Other products in the same app (`/crm`, `/investors`, …) | The tour is the outreach product |
| The public website widget running on a customer's site | The tour shows the widget in the existing in-app preview |
| Real voice calls | The Voice tab shows a sample call instead (§5) |

**The demo user** is the owner of one fictional agency workspace on the top plan, with every feature flag on, so nothing is locked.

---

## 2. Visitor experience

### 2.1 Entry

`/product-tour` opens the Dashboard in demo mode with a welcome card:

> **Explore GrowthxAI with sample data**
> Everything here is fictional. No messages are sent and nothing is saved to an account.
> **[ Take the 1-minute tour ]** · Explore on my own

It works signed out and signed in. A signed-in visitor still gets the demo, never their own data, and the CTA reads *"Back to my workspace"*.

### 2.2 Demo bar (always visible, above the app shell)

```
● Demo        ▶ Simulate activity: On ▾     ↻ Restart tour    Reset demo    [ Start your outreach → ]
```

| Control | Behaviour |
|---|---|
| Label | Always shown on every screen and in every modal's host page. Fixed, 40 px, never dismissible |
| Simulate activity | On / Paused / Fast, plus **Skip a day** (§4.4) |
| Restart tour | Starts the walkthrough from step 1 |
| Reset demo | Confirm → clears demo state and reloads the starting data. The current page stays open if it still exists, else the Dashboard |
| Start your outreach | A full page load to `/outreach?from=product-tour`. The normal flow takes over: `ProtectedRoute` → sign in / sign up → onboarding |

**Simulated actions say so.** Any action that would touch the outside world in the real product (send, connect, invite, pay, export, webhook test) shows the normal success state plus a small toast: *"Simulated. Nothing was sent."*

### 2.3 Walkthrough (Driver.js)

Eight steps across pages. The visitor can skip at any step, press Esc to skip, and go back.

| # | Page | Highlights | Text |
|---|---|---|---|
| 1 | Dashboard | The stats row | "This is a live workspace with sample data. Here's the whole flow in a minute." |
| 2 | Senders | A connected sender card | "Connect LinkedIn, email, WhatsApp or Instagram accounts. Each one has its own safe daily limits." |
| 3 | Leads | The table + Import button | "Bring in prospects from a CSV, a LinkedIn search or by hand." |
| 4 | Sequence builder (sample sequence) | The step canvas | "Build the steps: visit, connect, message, follow up, branch on replies." |
| 5 | Sequence builder | A message step with a variable | "Personalise every message with variables and AI lines." |
| 6 | Sequence page | The Start / Enroll button | "Start it and leads move through on their own. In this demo the activity is simulated." |
| 7 | Inbox | A conversation with a reply | "Replies from every channel land here. Answer them, or let AI draft." |
| 8 | Reports | The funnel | "See what works: accepted, replied, interested, meetings." Then **[ Start your outreach ]** · Keep exploring |

- **Driver config:** one `driver()` instance with `allowClose: true`, `showProgress: true`, `overlayClickBehavior: 'close'`.
- **Step definition:** each step is `{ route, element: '[data-tour="…"]', popover }`. A small controller navigates to `route`, waits up to 4 s for the element, then calls `drive(i)`. If the element never appears (for example on a narrow screen), the step shows as a centred popover.
- **Targets:** `data-tour` attributes on the real components (about 10 attributes). They are inert in real mode.
- **State:** `sessionStorage` `gxdemo:tour = step:<n> | done | skipped`. The tour starts only from the welcome card or **Restart tour**, never by itself on a later visit in the same session.
- **After finishing or skipping:** the whole product stays open to explore.

### 2.4 Free exploration (must work end to end)

| Workflow | What the visitor can do | Result everywhere |
|---|---|---|
| Campaigns (sequences) | Create, edit steps, publish, start, pause, resume, archive, delete; save versions | Shows in the list, the dashboard and reports. Validation uses the real `lib/outreach/graph.ts` |
| Prospects | Add by hand, import a CSV (parsed in the browser) or load the sample file; select, filter, tag, edit, change stage, delete; enroll | The lead table, lead page, sequence counts and filters update |
| Personalisation | Edit templates, insert variables, preview as a lead, create AI variables and fields, review lines | Preview uses the real `renderTemplate`. AI output is generated locally (§4.5) |
| Sending and progress | Start a sequence → the simulator sends, gets accepts and replies | Step counts, sender budgets, the inbox, tasks, the dashboard and reports all move together |
| Inbox | Open conversations, reply, add notes, assign, label, snooze, use AI draft | Replies appear as sent, and some prospects answer back later |
| Senders | Connect a demo account (a fake connect screen), pause, change limits and schedule, reconnect, remove | Sender pool, budgets, sequence pools |
| Reports | Change ranges, filters, clients; export | Numbers come from the same demo data. Export downloads a CSV built in the browser |
| Settings, billing, AI, website assistant, clients | Every control works on local state (§5) | — |

---

## 3. Architecture

### 3.1 One set of pages, two URL prefixes

- **Rewrite:** `proxy.ts` rewrites `/product-tour` → `/outreach` and `/product-tour/:path*` → `/outreach/:path*`, so the browser URL stays `/product-tour/...`. Add `/product-tour` to `GROWTHXAI_PATHS` in `lib/whitelabel.ts` so product domains serve it. The white-label job (B) never runs for this prefix.
- **Mode** comes from the browser URL once per page load, in `lib/outreach/mode.ts`:

  ```ts
  export const IS_DEMO: boolean =
    typeof window !== 'undefined' && /^\/product-tour(\/|$)/.test(window.location.pathname);
  ```

  It is a constant for the life of the page. Crossing between `/product-tour` and `/outreach` is always a **full page load**: the CTA and "Exit demo" use `window.location.assign`. A route-change watcher reloads the page if the URL prefix and `IS_DEMO` ever disagree.

- **Links.** The app has 246 literal `/outreach…` references. They stay as they are. Three thin wrappers in `lib/outreach/nav.tsx` translate at the edge:

  | Wrapper | Real mode | Demo mode |
  |---|---|---|
  | `Link` (wraps `next/link`) | unchanged | `href` starting `/outreach` → `/product-tour…` |
  | `useRouter()` (`push`, `replace`, `prefetch`) | unchanged | same translation |
  | `usePathname()` | unchanged | returns the path **as `/outreach/...`**, so every existing "is this nav item active" check keeps working |

  A codemod changes the imports in the ~100 outreach files (`next/link` and `next/navigation` → `@/lib/outreach/nav`). `components/MainLayout.tsx` needs the same change for its `pathname.startsWith('/outreach')` checks.

- **Server redirects.** Six pages are server components that call `redirect('/outreach/…')` (for example `app/outreach/ai/page.tsx`). Under the rewrite these would bounce a visitor out of the demo. Change each to a tiny client component that calls the wrapped `router.replace`.
- **Hydration.** The outreach layout already renders only a loader until the client has the workspace. Demo mode is read on the client, so the server and the first client render match.
- **Fallback, if the rewrite misbehaves on Next 16** (§10): move `app/outreach` under a dynamic segment `app/[mode]/…` that accepts only `outreach` and `product-tour`. Same files, no rewrite.

### 3.2 The backend seam

```
lib/outreach/backend/
  contract.ts     ← types: TableMap, RpcMap, FnMap, OutreachBackend
  index.ts        ← export const db: OutreachBackend  (picks the provider from IS_DEMO, loads it lazily)
  real.ts         ← the only file in the outreach UI allowed to import @/utils/supabase/client and call fetch
  demo/
    index.ts      ← DemoBackend (no imports from utils/supabase, lib/api, backend/real)
    store.ts      ← tables, persistence, reset, change events
    query.ts      ← the small query builder used by db.from() in demo
    rpc/*.ts      ← one file per area: dashboard, senders, leads, sequences, inbox, tasks, ai, webchat, reports, billing, settings, clients
    fn/*.ts       ← handlers for the 19 edge functions
    sim/*.ts      ← the simulator (§4.4)
    seed/*.ts     ← the starting data (§4.1)
    ai.ts         ← local "AI" output (§4.5)
```

```ts
export interface OutreachBackend {
  from<T extends keyof TableMap>(table: T): QueryBuilder<TableMap[T]>;              // select / insert / update / upsert / delete
  rpc<K extends keyof RpcMap>(name: K, args: RpcMap[K]['args']): Promise<RpcMap[K]['result']>;
  fn<K extends keyof FnMap>(name: K, body: FnMap[K]['body'], opts?: FnOpts): Promise<FnMap[K]['result']>;
  storage: { from(bucket: string): BucketApi };                                      // upload, remove, createSignedUrl, getPublicUrl
  channel(name: string): RealtimeChannelLike;                                        // .on(...).subscribe(), unsubscribe
  auth: { getUser(): Promise<{ id: string; email: string } | null> };
}
```

**Changes to existing code:**

| Today | Becomes |
|---|---|
| `import { supabase } from '@/utils/supabase/client'` in 58 outreach files | `import { db } from '@/lib/outreach/backend'`. `supabase.from` → `db.from`, `supabase.storage` → `db.storage`, `supabase.channel` → `db.channel`, `supabase.auth.getUser` → `db.auth.getUser`. A codemod; the call shapes stay the same |
| `rpc(name, args)` in `lib/outreach/api.ts` | The same function, now `return db.rpc(name, args)`. The name is typed as `keyof RpcMap` |
| `callFn(name, body, opts)` | The same function, now `return db.fn(name, body, opts)`. The token and 401-retry logic moves into `real.ts` |
| `fnUrl(name)` + `fetch` (3 places: downloads and streams) | `db.fn(name, body, { raw: true })`, which returns a `Response`-like object. Demo returns a local `Response` built from a Blob or a stream |
| `fetch('/widget/v1/presets/presets.json')` | Stays. It's a static file on our own origin and is on the allow-list (§3.4) |
| `useAuth()` / `useAccess()` in outreach components (9 places) | `useSessionUser()` / `useOutreachAccess()` from `lib/outreach/session.ts`. Real mode passes through; demo returns the demo owner with full access |
| `localStorage` in 12 outreach files (workspace id, filters, table layouts) | `kv` from `lib/outreach/storage.ts`. Real mode = `localStorage` as today. Demo = `sessionStorage` under the prefix `gxdemo:`, so a real user's saved filters are never touched |

**Real provider** = today's behaviour moved into one file. `db.from` returns `supabase.from(table)` unchanged, so there is no behaviour change in production.

**Demo provider:**
- **`from()`:** a query builder over the demo tables. It supports exactly the operations the app uses: `select` (column lists, `*`, `count`), embedded relations through a relations map (for example `outreach_leads(full_name, company)`), `eq / neq / in / is / ilike / or / gte / lte / contains`, `order`, `range`, `limit`, `single / maybeSingle`, and `insert / update / upsert / delete` with `.select()`. Anything else throws `E_DEMO_QUERY` with the table and operator, so the check script catches it.
- **`rpc()` and `fn()`:** a handler per name.
- **Loading:** `backend/index.ts` loads the provider with a dynamic `import()`, so the demo code and seed are downloaded only on `/product-tour`, and the real provider is not part of the demo chunk.

**No network mocking.** There is no MSW and no fetch interception that answers requests. In demo mode, calls go to local functions and never to the network.

### 3.3 Shell, sign-in and access in demo mode

| Piece | Demo behaviour |
|---|---|
| `app/outreach/layout.tsx` | When `IS_DEMO`: skip `ProtectedRoute`, render `DemoBar` above `MainLayout`, wrap in `DemoProvider` (loads the store, starts the simulator, hosts the tour). When not demo: exactly today's tree. `ProtectedRoute` itself is not changed |
| `OutreachWorkspaceProvider` | Unchanged code. Its `ensure_workspace` and workspace queries go through `db` and get the demo workspace |
| `MainLayout` | Takes a `demo` flag: shows only the outreach navigation, a "Demo user" block, and a menu with **Exit demo** and **Start your outreach**. It skips its own Supabase and `/api/reset-account` calls |
| `WebchatPresence` | Its presence ping goes through `db.rpc` → a local no-op |
| Root providers (`AuthProvider`, `AccessProvider`, …) | Unchanged. They already run on public pages. Their session lookups are sign-in calls, not outreach data, and are allowed (§3.4) |

**Invariant:** "sign-in is skipped" and "the demo provider is in use" both come from the same `IS_DEMO` constant. There is no state in which a visitor without a session reaches the real provider.

### 3.4 Guards: a demo action can never reach production

| # | Guard | How |
|---|---|---|
| 1 | Mode is the URL | `IS_DEMO` is fixed per page load; crossing the prefix is a full reload (§3.1) |
| 2 | The demo provider cannot call production | `backend/demo/**` may not import `@/utils/supabase/client`, `@/lib/api`, `backend/real`, or use `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon`. Enforced by ESLint (`no-restricted-imports`, `no-restricted-globals`) and by the import-graph check in §7 |
| 3 | The UI cannot bypass the seam | In `app/outreach/**`, `components/outreach/**` and `lib/outreach/**` (except `backend/real.ts`): no import of `@/utils/supabase/client` or `@/lib/api`, no bare `fetch` (except the allow-listed static paths), no `next/link` or `next/navigation`, no `localStorage` |
| 4 | Runtime block | On `/product-tour`, `DemoProvider` installs a guard on `fetch`, `XMLHttpRequest.open`, `WebSocket` and `sendBeacon`. It **refuses** any request to the Supabase project's `/rest/v1`, `/functions/v1`, `/storage/v1` or `/realtime/v1`, to `/api/*`, and to any host outside the allow-list. It answers nothing. It throws `E_DEMO_BLOCKED`, logs the URL and reports it to analytics. In development it also shows a red toast, so a leak is seen at once |

**Allow-list:** same-origin static files (`/_next/*`, `/widget/v1/*`, images, fonts), Supabase `/auth/v1/*` (session lookup by the root providers; no data), and Vercel Analytics.

**External actions and their local stand-ins:**

| Real action | In the demo |
|---|---|
| Connect LinkedIn / email / WhatsApp / Instagram (hosted auth, QR, cookies) | A fake connect dialog styled like the real step. "Connect demo account" adds a fictional sender that starts at warm-up level 1 |
| Send message / invite / InMail / email, reply from the inbox, edit or delete a message | A row is written locally; it shows as sent |
| Enrich profiles, find email, verify | Filled from a local pool after a short delay |
| AI: lines, fields, replies, drafts, sequence QA, website answers | Local generator (§4.5) |
| Payments (plan change, checkout, invoices) | A fake checkout step that "succeeds", then the plan and invoice list update locally |
| CRM OAuth, Slack, other integrations | "Connected (demo)" after a fake consent screen |
| Outbound webhooks test, API keys | A fake 200 result; a fake masked key |
| Invite a teammate | Adds a pending invite locally; no email |
| Imports | CSV parsed in the browser with `papaparse` (already a dependency); LinkedIn-search import returns fictional people |
| Exports | CSV built in the browser and downloaded |
| File uploads (attachments, voice notes, logos, video bubble) | Kept as in-memory object URLs for the session |
| Realtime | A local event bus fires when the demo data changes |

---

## 4. Demo data and behaviour

### 4.1 Starting data

The data is generated at load by typed builders with a fixed random seed. Every row is typed against `TableMap`, so a schema change breaks the build until the seed is updated. Dates are relative to "now", so charts always look current.

| Data | Amount |
|---|---|
| Workspace | 1 agency workspace, top plan, 4 members + 1 pending invite |
| Clients | 3 |
| Senders | 5 LinkedIn (active, warming up, needs reconnect, paused, Sales Navigator), 2 mailboxes, 1 WhatsApp, 1 Instagram, with budgets and health |
| Leads | 400, with profiles, posts, tags, lists and stages |
| Sequences | 6: two running, one paused, one draft, one finished, one multichannel. With versions and step stats |
| Enrollments and actions | ~700 enrollments, 60 days of actions |
| Conversations | 50 across LinkedIn, email, WhatsApp, Instagram and website chat (one with product cards, one with a voice call card), with notes |
| Tasks | 20 |
| AI | 3 variables (one with fields), 120 lines (12 waiting for review), 30 activity rows, 3 knowledge sources, 15 Q&A, 1 catalogue of 40 products, unanswered questions |
| Website assistant | 1 website with full settings |
| Reports | Computed from the rows above |
| Billing | Plan, usage, 3 invoices |
| Settings | Suppressions (25), webhooks (2), 1 API key, integrations, branding, notifications, audit log (50), alerts (3) |

**Fictional only:**
- People and companies are invented names.
- Emails use `example.com`, phones use the `+1 555 01xx` range, and avatars are initials or bundled illustrations.
- There are no real LinkedIn URLs. Profile links open a small note: *"This prospect is fictional."*
- There is no real brand, logo or photo.

### 4.2 State and Reset

- **Store:** one in-memory object, `{ tables, clock, rngSeed, meta }`.
- **Persistence:** saved to `sessionStorage` key `gxdemo:v<SEED_VERSION>:state`, debounced 500 ms. A reload keeps the visitor's changes. A new tab or session starts fresh.
- **Seed changes:** when `SEED_VERSION` changes, the old state is discarded.
- **Quota:** if `sessionStorage` is full or unavailable, the demo keeps working in memory only.
- **Reset demo:** clears every `gxdemo:*` key, rebuilds the seed, clears the React Query cache, and stays on the page.

### 4.3 Consistency

Every list, counter, dashboard tile and report is a **read over the same tables**:
- The demo `dashboard`, `node stats` and report RPCs compute their answers from `outreach_actions`, `outreach_enrollments`, `outreach_messages` and `outreach_chats` in the store. There are no hard-coded totals.
- After any write, the store emits a change event. The demo `channel()` forwards it and the React Query keys for the touched tables are invalidated, so open screens update.

### 4.4 Simulator

- **Clock:** the store's clock starts at the real time. While activity is **On** and the tab is visible, every 4 s of real time advances the clock by 2 simulated hours (**Fast**: 8 hours). **Skip a day** advances by 24 hours at once.
- **Each step of the clock**, for running sequences only:
  - **Actions:** each enrollment moves through its steps using the app's own graph logic (`lib/outreach/graph.ts`, `nodes.ts`) and message rendering (`renderTemplate` with a demo render context). Action steps write `outreach_actions` (sent), messages into the lead's chat, step stats and sender budget usage.
  - **Limits:** sender daily limits and working hours are respected, so pacing looks real and "Why not sending" answers make sense.
  - **Outcomes:** these use a seeded random generator with fixed rates: invite accepted 38%, reply after a message 14%, email opened 55%, bounced 2%, follow-back 30%.
  - **Replies:** a reply is picked from a bank of about 40 canned replies by intent (interested, not now, who is this, wrong person, out of office). It creates an unread conversation, a notification, a classification, the reply-stop on the enrollment, a stage change, and an AI draft when AI replies are on for that sequence.
- **After the visitor replies in the inbox:** the message shows as sent, and 30% of prospects answer again within two clock steps.
- **Deterministic:** the same seed and the same clicks give the same results, which keeps the checks stable.
- **Stops:** when the tab is hidden, when activity is Paused, or when no sequence is running.

### 4.5 Local "AI"

No model is called. `backend/demo/ai.ts` produces believable output from the data:

| Feature | Output |
|---|---|
| Personalised lines | Sentence templates filled from the lead's title, company, tenure, recent post and school, with the facts list the review screen expects |
| AI fields | Rule-based values per field type (choice from options, yes/no from profile signals, numbers from the profile) |
| AI replies and drafts | Canned replies per intent and stage, with the lead's name and the last message's topic |
| Sequence QA, compose assist | Fixed, sensible findings and rewrites |
| Website assistant | Answers from the seeded Q&A and knowledge by keyword match, streamed in chunks on a timer; product cards from the seeded catalogue |
| Voice | The Voice tab's test panel plays a bundled sample call with its transcript. There is no microphone and no ElevenLabs call |

Each output carries a small "Sample AI output" tag in the demo.

---

## 5. Section-by-section

| Section (route) | Reads | Actions that work locally |
|---|---|---|
| Dashboard `/outreach` | Computed tiles, alerts, why-not-sending | Dismiss alerts, jump links |
| Inbox `/inbox`, `/inbox/[chatId]` | Chats, messages, notes, labels, website chats | Reply, edit, delete, AI draft, notes, assign, snooze, label, resolve, send product cards |
| Senders `/senders`, `/senders/new`, `/senders/[id]`, `/senders/profiles` | Senders, budgets, events, warm-up, profiles | Connect (fake), pause/resume, limits, schedule, proxy, reconnect, remove, profile edits (applied locally) |
| Leads `/leads`, `/leads/[id]`, `/leads/import` | Leads, tags, lists, stages, timeline | Add, edit, bulk actions, tags, stages, import (CSV / sample / fictional search), enrich, export, suppress |
| Sequences `/sequences`, `/new`, `/[id]`, `/[id]/versions`, `/[id]/enroll` | Sequences, versions, step stats, enrollments | Create, edit, save draft, publish, start, pause, archive, delete, enroll, A/B, sender pool, preview as lead |
| Tasks `/tasks` | Tasks | Complete, skip, assign, call outcomes |
| AI `/ai/needs-you`, `/activity`, `/knowledge`, `/knowledge/catalogue/[id]`, `/setup/*` | Hub views, variables, lines, knowledge, catalogue | Approve, edit, skip, regenerate; create variables and fields; add knowledge (fake crawl with progress); Q&A; hide/pin products; modes |
| Website assistant `/websites`, `/websites/[id]` | Website settings, preview | Every setting, the live preview with local answers, Ask AI buttons, products, the voice tab with the sample call |
| Reports `/reports` | Computed reports | Ranges, filters, saved ranges, schedules (saved locally), export |
| Clients `/clients`, `/c`, `/c/[clientId]` | Clients, portal view | Create, edit, open the client portal view |
| Billing `/billing`, `/billing/change` | Plan, usage, invoices | Change plan with the fake checkout, add accounts, download a sample invoice |
| Settings `/settings/*` (workspace, members, branding, email, integrations, notifications, safety, suppressions, webhooks, api, ai, ai-replies, websites) | Their tables | Every form saves locally; invites, integrations, webhooks and keys are simulated (§3.4) |

`/outreach/ai-review`, `/settings/ai`, `/settings/ai-replies`, `/settings/billing`, `/settings/websites*` are redirects today and keep redirecting inside the demo (§3.1).

---

## 6. Staying in sync with the real app

| Mechanism | What it guarantees |
|---|---|
| **Shared pages** | A UI change shows in both modes at once. There is nothing to copy |
| **Typed contract** (`contract.ts`) | `rpc()` only accepts names in `RpcMap`, and `callFn()` only names in `FnMap`. The demo handler maps are typed `{ [K in keyof RpcMap]: Handler<K> }`. Adding an RPC or function without a demo handler is a **TypeScript build error**. Same for a new table: `TableMap` must have it and the seed must fill it |
| **Lint rules** (§3.4, guards 2–3) | New code can't call Supabase, `fetch`, `next/link` or `localStorage` directly in the outreach UI |
| **`notYet()` marker** | During the build-out only: a demo handler may be `notYet('reason')`, which returns an empty, correctly typed result and shows "Not in the demo yet". The check script counts them, and the count must be 0 from the end of Phase 3 |
| **Route manifest** (`backend/demo/routes.ts`) | Lists every `app/outreach/**/page.tsx` with sample ids for dynamic routes. The check script fails if a route file exists with no manifest entry |
| **Check script** (`scripts/outreach-demo-check.ts`, run by `npm run lint` and in CI) | See §7 |
| **Team rule** in `.cursorrules` and the repo's contribution notes | "A feature change includes its contract entry, demo handler, seed data and, if it adds a screen, its route manifest entry. A PR that changes `app/outreach` or `lib/outreach` runs the demo check." This also steers AI coding tools working in the repo |

---

## 7. Checks (`scripts/outreach-demo-check.ts`)

| Check | Fails when |
|---|---|
| Import graph | Anything under `backend/demo/**` reaches `utils/supabase`, `lib/api` or `backend/real` (directly or through another module) |
| Manifest | A route under `app/outreach` is missing from the manifest, or the manifest lists a route that no longer exists |
| `notYet` count | Above the allowed number for the phase (0 after Phase 3) |
| Every screen opens | Headless Chrome (`playwright-core`, already used for the widget tests) loads each manifest route under `/product-tour`. It fails on an error boundary, an uncaught error, `E_DEMO_QUERY`, or an empty main region |
| No production calls | During the whole run the browser's network log has **zero** requests to the Supabase data hosts or `/api/*`, and the runtime block (§3.4) fired zero times |
| Label | The demo bar text is visible on every screen |
| Workflows | Scripted, deterministic, in demo mode (list below) |
| Real mode unchanged | `/outreach` signed out still redirects to sign-in; the real provider is used when not on `/product-tour` |

**Scripted workflows:**
1. Create a sequence → it's in the list → publish → enroll 10 leads → skip a day → step stats above 0 → the reports' totals rise by the same numbers.
2. A simulated reply arrives → the inbox unread count rises → open it → reply → the message shows as sent.
3. Import the sample CSV → the leads count rises → filter finds them.
4. Connect a demo sender → it's selectable in a sequence's pool.
5. Change plan → billing shows the new plan.
6. Reset demo → everything is back to the starting numbers.
7. Tour: finish it, skip it, and restart it.

---

## 8. Files

| New | Purpose |
|---|---|
| `lib/outreach/mode.ts`, `nav.tsx`, `session.ts`, `storage.ts` | Mode constant; link, router and pathname wrappers; demo-aware user and access; storage wrapper |
| `lib/outreach/backend/**` | The contract and the two providers (§3.2) |
| `components/outreach/demo/DemoProvider.tsx`, `DemoBar.tsx`, `DemoWelcome.tsx`, `DemoConnectDialog.tsx`, `DemoCheckout.tsx`, `tour.ts` | Demo shell, bar, welcome card, fake connect and checkout, the Driver.js controller and steps |
| `scripts/outreach-demo-check.ts`, `scripts/outreach-demo-codemod.mjs` | The checks; the one-time import codemod |
| `docs/outreach/PRODUCT-TOUR.md` | How demo mode works and how to add a feature to it |

| Changed | Change |
|---|---|
| `proxy.ts`, `lib/whitelabel.ts` | The rewrite and the product-domain path |
| `app/outreach/layout.tsx` | The demo branch (§3.3) |
| `lib/outreach/api.ts` | `rpc` and `callFn` delegate to `db` |
| ~58 files using `supabase` directly, ~100 files using `next/link` / `next/navigation`, 12 using `localStorage`, 9 using `useAuth`/`useAccess` | Import changes by codemod |
| 6 redirect pages | Client redirects |
| `components/MainLayout.tsx` | The `demo` flag |
| About 10 components | `data-tour` attributes |
| `eslint.config.mjs`, `package.json` (`lint` runs the demo check), `.cursorrules` | Rules |

---

## 9. Build order

| Phase | Delivers | Demo handlers |
|---|---|---|
| 1. Seam, no behaviour change | Contract types, the real provider, the codemods, lint rules. Production behaves exactly as before. Ship this alone first | — |
| 2. Demo core | Rewrite, mode, demo shell and bar, store, query builder, seed, reset. Main workflows end to end: dashboard, senders, leads, sequences, inbox, tasks, reports. The simulator. The tour and the CTA | The RPCs and functions those screens call; the rest are `notYet` |
| 3. Everything else | AI hub, website assistant, clients and portal, billing, all settings, imports/exports, profiles | All remaining; `notYet` = 0 |
| 4. Lock in | The full check script in CI, the team rule, the docs page | — |

Phase 1 is the largest mechanical change (about 170 files touched by codemod) but carries no product change. It should be reviewed and released on its own, before any demo code exists.

---

## 10. Acceptance

- `/product-tour` works signed out, on desktop and mobile, with no account connected.
- Every route in the manifest opens with data. No empty or broken screen.
- The workflows in §2.4 and §7 work end to end and stay consistent across screens.
- Zero requests to production data services during any demo session, proved by the check.
- The label "Demo" is visible on every screen.
- The tour can be finished, skipped and restarted. After it, the whole product is explorable.
- **Reset demo** restores the starting data.
- **Start your outreach** lands in the normal `/outreach` sign-in flow.
- `/outreach` behaves exactly as before for real users. Signed-out access is still refused.
- Adding an RPC, edge-function call, table or screen without its demo side fails the build or the check.

---

## 11. To confirm during the build

| Item | If it differs |
|---|---|
| With a rewrite on Next 16, the client reads the browser path (`/product-tour/…`) on first render | Use the `app/[mode]/…` fallback in §3.1 |
| `sessionStorage` size for the full demo state (expected 1–2 MB) | Persist only the rows the visitor changed, on top of the seed |
| The query builder covers every `supabase.from` shape in use | The check lists any unsupported operator by file. Either add it, or move that read into an RPC handler |
| Root providers make no outreach data calls for signed-out visitors | If one does, route it through `db` or skip it when `IS_DEMO` |
