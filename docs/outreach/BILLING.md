# Billing v2: Launch, Scale, Enterprise (prepaid accounts)

Built from [`pricing-billing-PRD.md`](../../pricing-billing-PRD.md) (v1.2, 1 Oct 2026). This page says where each part lives, where the build differs from the PRD, how to roll it out, and what still has to be checked against real Stripe.

**Status on 1 Oct 2026:** code complete in the working tree. Nothing is applied to the live database, nothing is deployed, no Stripe object exists. Rollout is section 5.

## 1. The switch that makes rollout safe

Everything is behind one platform flag, `outreach_flags.billing_enforced` (default **off**).

| | Flag off (today) | Flag on |
|---|---|---|
| Account limit | none | trial: 1; paid: accounts bought; comp workspace: what an admin set (empty = none) |
| Plan features | everything on | by plan (`outreach_plan_features`) |
| Trial expiry | never | end of day 7: account disconnected, 30 days read-only, then deleted |
| Stripe checkout, changes, webhook | work as soon as Stripe keys are set | same |
| Past-due suspension (day 7) | applies whenever Stripe reports past due | same |

The flag exists because the three live workspaces are all on `trial`, their trials are over, and they have 17 accounts connected. With enforcement on and no plan set, the next hourly run would disconnect those accounts on the connector. So: set a plan for every workspace that must keep working (`/admin` → Outreach workspaces → plan Enterprise, accounts empty), then turn the flag on in **Settings → Admin → Billing** (localhost only). The switch lists what would expire or pause and asks for confirmation when that list is not empty.

A second flag, `billing_data_deletion` (default off), gates the automatic deletion of workspaces past their date. While it is off the daily job only reports them.

## 2. Where things are

| Part | Files |
|---|---|
| Price book (the one source) | `pricing/v1.json` → `node scripts/pricing-sync.mjs` writes `supabase/functions/_shared/outreach/pricing.gen.ts` and `migrations/outreach/058_billing_seed.sql`. `--check` fails when either is stale |
| Price rules (best price, now vs renewal) | `_shared/outreach/pricing_core.ts`, used by the edge functions (`pricing.ts`) and the web app (`lib/outreach/pricing.ts`). SQL twin: `outreach_quote_accounts()` |
| Schema | `migrations/outreach/056_billing_enums.sql` (run alone), `057_billing_schema.sql`, `058_billing_seed.sql` |
| Functions | `059_billing_functions.sql`: slots, reservations, guard trigger, features, disconnect, over-limit, subscription state, hourly tick, notices, purge, early supporters, `outreach_billing_state()` |
| Plan gates | `060_billing_gates.sql`: patches the live functions in place (tracking domains, webhooks, API keys, white-label, client reports, AI Auto, inbox limit, AI allowance, priority, "why not sending") and adds triggers for clients / client viewers |
| Cron | `061_billing_cron.sql`: `outreach-billing` hourly, `outreach-billing-daily` 03:15 |
| Admin RPCs | `migrations/platform/003_billing_admin.sql` |
| Stripe client | `_shared/outreach/stripe.ts` (plain HTTP, pinned API version, idempotency keys, signature check) |
| Billing logic | `_shared/outreach/billing_core.ts` (no I/O), `billing.ts` (quote, change, checkout, cancel, resume, sync from Stripe) |
| Owner endpoint | `outreach-billing` (quote, change, checkout, cancel_scheduled_change, cancel, resume, portal, pay_now, abandon_payment, sync) |
| Webhook | `outreach-stripe-webhook` (events only) |
| Job | `outreach-billing-sync` → `billing_sync.ts` (`{mode:"hourly"}` / `{mode:"daily"}`) |
| Disconnect | `_shared/outreach/disconnect.ts`, `outreach_disconnect_sender()`, `outreach_account_deletions` (retry queue) |
| Website endpoints | `outreach-public` (`/pricing`, `/early-supporters`) |
| Emails | `_shared/outreach/billing_emails.ts` |
| Stripe catalogue | `scripts/stripe-setup.ts` (3 products, 9 volume prices, 3 coupons, portal configuration, webhook endpoint; `--check` compares Stripe with the JSON) |
| App | `app/outreach/billing/page.tsx`, `app/outreach/billing/change/page.tsx`, `lib/outreach/billing.ts`, `components/outreach/PlanGate.tsx`, senders screens, `components/admin/OutreachTab.tsx`, `components/outreach/settings/admin/BillingAdminCard.tsx` |

## 3. How it works, in short

**Accounts.** A sender occupies an account while it is not deleted, not `disabled`, not `disconnected`, and bound to a connected account. Website chat inboxes never count. `outreach_slots(ws)` returns `{billed, used, reserved, available}`. A sign-in link reserves one account for its lifetime (15 minutes for a new connection, 60 for a reconnect). The `outreach_senders_slot_guard` trigger refuses any insert or update that would take an account the workspace does not have, whatever code path it comes from. When an account is freed (disabled, disconnected, deleted), `outreach_senders_slot_freed` lets accounts paused for the plan limit back in, oldest pause first; a manual Resume of such an account is refused.

**Changes.** `pricing.splitChange(from, to)` splits a request into what goes up (now) and what goes down (renewal). The quote for the "now" part is Stripe's own invoice preview, pinned to a `proration_date`; confirming re-previews with the same date and refuses (`E_QUOTE_STALE`) if the amount moved. The update uses `proration_behavior=always_invoice` and `payment_behavior=pending_if_incomplete`, so a declined card or an unfinished 3-D Secure step changes nothing. The "renewal" part is a two-phase subscription schedule that releases after the new period starts.

**State.** One function writes billing state for a Stripe-billed workspace: `outreach_billing_apply_subscription()`. The webhook, every owner action and the hourly catch-up all read the live subscription from Stripe and pass what it says; event order and repeats do not matter. Events are stored once in `outreach_billing_events`.

**Disconnect.** `outreach_disconnect_sender()` marks the sender `disconnected`, moves its account id to `previous_unipile_account_id` and queues the connector delete (tried at once, retried with backoff for 24 hours, then an operator alert). Reconnect is a fresh sign-in bound to the same sender; a different account is refused and removed.

## 4. Where the build differs from the PRD

| PRD | Built | Why |
|---|---|---|
| Migration `054_billing_v2.sql` | `056`–`061` | 054 and 055 were taken; the enum value must be added in its own transaction |
| Enrolment status `waiting_reconnect` | No new status. Enrolments on a disconnected sender keep their status and wait, exactly like on a signed-out sender | The engine has one waiting path (sender not `ok`); a new status would touch reports, the planner and every status map. "Why isn't this sending?" answers `E_SENDER_DISCONNECTED` |
| Disconnect cancels queued actions | Queued actions stay queued | Same reason: after a reconnect the sender picks up through the normal quiet period, as after any re-login |
| Delete the connector account, then mark the sender | The sender is marked first, the delete is queued and retried | Nothing can send in between, and a late connector webhook finds no sender for the old account id |
| `connecting` occupies an account | A row still signing in is covered by its reservation, not counted as used | Otherwise an abandoned sign-in would hold an account forever |
| Client secret stored in `pending_payment` | Not stored; it is returned once to the browser. `pending_payment` holds the invoice id and Stripe's hosted invoice link | A client secret in the database is a liability; the hosted link finishes the same payment |
| `plan_before_suspension` in `settings` | A column | Owners can edit `settings`. They could also update `plan` itself through RLS; `057` now limits owner updates to `name` and `settings` |
| Over-limit: pause extras | Working accounts are paused; accounts that need a sign-in anyway are disconnected | They cannot send either way, and a disconnected account stops costing us |
| Suspended workspaces | Reads keep working (reports, lists); writes are refused | The PRD says "read-only". `outreach_require()` now refuses only in a read-write transaction |
| Trial claims per company | By the creator's email domain; free-mail domains count per user | As written in #38 |
| Stripe API | Pinned to `2026-08-26.dahlia` (`STRIPE_API_VERSION` overrides) | Field paths differ between versions; pinning keeps them fixed |
| Automatic tax | Off until `STRIPE_TAX_ENABLED=true` | Stripe collects nothing, silently, without an active registration |
| Website copy (§11.5), help-centre pages | Not done | Other repositories. The website can read `outreach-public/pricing` and `/early-supporters`, or import `pricing/v1.json` |

## 5. Rollout

Nothing below has been run. Each step is safe on its own while `billing_enforced` is off.

1. **Database.** `056` alone, then `057`, `058`, `059`, `060`, then `migrations/platform/003_billing_admin.sql`. Run `bash scripts/outreach-smoke.sh` (smoke_14 has 43 assertions; smoke_12 and smoke_13 were updated for the new plan names; smoke_04 fails on ten private-notes functions, as it did before this work).
2. **Stripe sandbox.** `STRIPE_SECRET_KEY=… OUTREACH_FUNCTIONS_BASE_URL=… deno run -A --node-modules-dir=none scripts/stripe-setup.ts`. Put the printed values in `.env.local`, then `scripts/outreach-set-secrets.sh`. The old `STRIPE_PRICE_*` variables are no longer read.
3. **Functions.** Deploy all outreach functions (shared files changed): `OUTREACH_DEPLOY_EXTRA_ARGS="--use-api" bash scripts/outreach-deploy-functions.sh`. New: `outreach-billing`, `outreach-public`.
4. **Cron.** `061_billing_cron.sql` (after step 3: the old billing-sync does not know the modes).
5. **App.** Deploy the Next.js app. Set `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` for in-app 3-D Secure (without it the app sends the customer to Stripe's invoice page).
6. **Verify in Stripe test mode** (section 6).
7. **Give every existing workspace a plan**, then turn on `billing_enforced`.
8. Live Stripe: run the setup script with the live key, set the live secrets, register for Stripe Tax, set `STRIPE_TAX_ENABLED=true`.
9. Website copy (PRD §11.5).

## 6. Verify in Stripe test mode

These could not be checked from the build machine (no Stripe key). The fake Stripe in `scripts/outreach-billing-e2e.ts` encodes what the code assumes.

| # | Question (PRD §17) | Where it shows |
|---|---|---|
| 1 | Volume-tiered price with `interval_count=3` | `stripe-setup.ts` creates `*_quarterly_v1`; it fails loudly if Stripe refuses |
| 2 | Proration of a volume-tiered quantity change re-prices every unit | Every quote carries `proration_check {expected_cents, stripe_cents, ok}` and logs `proration_mismatch` when Stripe's preview differs from the PRD's formula. If it does, charge our own figure as an invoice item (`immediateUpdateParams` in `billing_core.ts` is the one place to change) |
| 3 | A schedule and `pending_if_incomplete` on the same subscription | The code never has both: it releases the schedule, updates, then schedules again |
| 4 | Portal with cancel and plan changes off | Open the portal from Billing after the setup script ran |
| 5 | Preview with `always_invoice` returns only the prorations | `chargeTodayFromPreview` handles both shapes; check `includes_renewal` in a quote |

On 1 Oct 2026 the screens were also clicked through in a browser against the local stack, the real `outreach-billing` and `outreach-stripe-webhook` functions and the fake Stripe: subscribe, signed webhook (and its repeat), upgrade with a scheduled decrease, the decrease landing at renewal with two accounts paused, the disconnected sender page, a locked feature, the enforcement switch.

Use test clocks for: 5 → 10 mid-period, Launch → Scale, monthly → annual, a scheduled decrease landing at renewal, a failed renewal through day 7 and day 21, cancel and undo.

Also ask the connector's support (PRD §17 #5): does a signed-out account count for billing; does an account deleted mid-period carry into the next period; does a re-linked account return the same chat and message ids.

## 7. Tests

| Test | Command | Covers |
|---|---|---|
| Price book and change rules | `deno test -A --node-modules-dir=none supabase/functions/_shared/outreach/pricing_test.ts` | 54 prices, every best-price range of §2, §4 split rules |
| Billing rules | `… billing_core_test.ts` (needs `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` set to anything) | Stripe object → workspace state, §4 worked examples, what is sent to Stripe, signature check |
| Database | `smoke_14_billing.sql` | Slots, reservations, guard trigger, features, disconnect, over-limit, lifecycle, grants |
| Admin | `migrations/platform/tests/smoke_01_admin.sql` | Comp workspaces, the enforcement switch |
| End to end | `scripts/outreach-billing-e2e.ts` with `scripts/outreach-fake-stripe.ts` (local stack only) | 45 checks: checkout, prorated increase, decline, 3-D Secure, scheduled decrease at renewal, monthly → annual, cancel and undo |
| Generated files | `node scripts/pricing-sync.mjs --check` | JSON = edge copy = seed SQL |
| Stripe catalogue | `scripts/stripe-setup.ts --check` | JSON = Stripe prices and coupons |

## 8. Known gaps

| Gap | Effect | Where to fix |
|---|---|---|
| Not run against real Stripe | Field paths and proration behaviour rest on Stripe's docs for `2026-08-26.dahlia` and on the fake | Section 6 |
| Migration 056–060 not dry-run on the live database | A new enum value cannot be used in the transaction that adds it, so the usual "migration + smoke test, rolled back" run needs `056` applied first. All 25 in-place patches were checked to match the live function bodies | Apply `056`, then dry-run the rest with `smoke_14` |
| Website inbox limit has no upgrade note in the UI | The server refuses (`E_PLAN_LIMIT`); the page shows the raw message | `app/outreach/websites/page.tsx` (new, someone else's work in progress): `usePlanFeature(ws, 'webchat_inboxes')` |
| CRM "Sync now" stays clickable on a plan without CRM sync | The server skips the sync; the button does nothing useful | `components/outreach/settings/IntegrationPanel.tsx` |
| Admin console has no field for a trial's account limit | The RPC accepts `trial_account_limit`; only the UI is missing | `components/admin/OutreachTab.tsx` |
| `custom_price_id` and the early-supporter discount set by an admin do not change a live Stripe subscription | They apply at the next checkout or plan change | Change the subscription in Stripe as well |
| Members can read the workspace row, billing columns included | The hosted invoice link of a pending payment is visible to every member | Column-level `select` grants on `outreach_workspaces` |
| Two lines of old plan names in the website-chat screens ("Pro and Agency plans") | Copy only | `components/outreach/settings/websites/sections.tsx`, `app/outreach/websites/page.tsx` |
| Website copy (PRD §11.5) and help-centre pages | Still say 14 days / 3 accounts | `outreach-app-website`, `outreach-app-docs` |

## 9. Decisions still open (PRD §16)

D2 (round-up vs smooth curve): built as round-up. D3: self-serve stops at 100. D4: Enterprise can be bought in the app. D6: the website rounds discounted prices to the dollar, Stripe does not. D7: AI allowance is 100 / 100 / 200 percent of the platform allowance; change `ai_limits` in `pricing/v1.json`. D8: rented accounts count as accounts. D9: Indian cards and e-mandates, not addressed. D10: monthly → annual starts the new period today.
