# PRD: Pricing and billing v2 — Launch, Scale, Enterprise (prepaid accounts)

**Document:** Implementation PRD for plans, account-based pricing, plan and account changes, and every billing edge case
**Version:** 1.2 · 1 October 2026 — trial 7 days / 1 account; at expiry the sender is disconnected (Unipile account deleted, our data kept 30 days, reconnect onto the same sender); no refunds
**Sources read:**
- Website: `outreach-app-website/src/data/pricing.ts` (plans, prices, steps, periods, feature table, FAQ) and `src/pages/pricing.astro`, `src/data/waitlist.ts`, `src/config/site.ts`.
- App as built: `supabase/functions/outreach-stripe-webhook`, `outreach-billing-sync` + `_shared/outreach/workers.ts#runBillingSync`, `outreach-sender-connect` (trial cap), `migrations/outreach/001_schema.sql` (`outreach_workspaces`, `outreach_billing_usage`), `015_platform.sql` (resume after billing, tracking-domain gate), `051_webchat_functions.sql` (inbox limits), `app/outreach/billing/page.tsx`, admin panel.
- Competitors: HeyReach help centre (upgrade/downgrade/cancel; plans and pricing), GetSales help centre (billing; new pricing plans), Expandi terms and conditions.

---

## 0. What changes, in one table

| | Today (as built) | After |
|---|---|---|
| Plans | `team`, `agency`, `agency_plus` | **Launch**, **Scale**, **Enterprise** (`launch`, `scale`, `enterprise`) |
| What's counted | LinkedIn senders + a separate mailbox add-on | **One count: accounts** = LinkedIn accounts + mailboxes + Instagram accounts + WhatsApp numbers |
| How quantity is set | Daily job sets Stripe quantity to the **peak** number of senders in the period, `proration_behavior: none` — postpaid, like Unipile charges us | **The customer chooses the number of accounts up front and pays for it in advance.** It's a limit, not a meter: they can connect up to that many. Usage never changes the bill |
| Price per account | One flat price per plan | Depends on **plan × number of accounts × billing period** (6 steps: 1, 5, 10, 20, 50, 100+; Monthly / Quarterly −10% / Annual −20%) |
| Changes | Checkout once; everything else in the Stripe portal | In-app plan/accounts/period changer with a live quote; increases now (prorated), decreases at renewal |
| Teammates | Free | Free (unchanged) |
| Early-supporter discount | Website only | Stored per workspace at sign-up; applied as a forever coupon |

---

## 1. Price book

### 1.1 Definitions
- **Account** (a "sender"): one LinkedIn account, mailbox, Instagram account or WhatsApp number connected to the workspace. All four count the same.
- **Accounts purchased**: the number on the subscription. The workspace can have at most this many accounts connected.
- **Step**: 1, 5, 10, 20, 50, 100. A count between two steps pays the per-account price of the step at or below it, for **every** account (all-units volume pricing, as the website states) — subject to the best-price rule (§2).
- **Teammates and client viewers**: unlimited and free on every plan.

### 1.2 Per-account monthly-equivalent prices (USD)

Quarterly and annual prices are the monthly price less 10% / 20%, rounded to the dollar — exactly what `listPerSender()` on the website computes. These 54 numbers are the price book; the website, the app and Stripe must all read the same file (§11.4).

| Plan | Period | 1–4 | 5–9 | 10–19 | 20–49 | 50–99 | 100+ |
|---|---|---|---|---|---|---|---|
| **Launch** | Monthly | 49 | 39 | 29 | 25 | 22 | 16 |
| | Quarterly | 44 | 35 | 26 | 23 | 20 | 14 |
| | Annual | 39 | 31 | 23 | 20 | 18 | 13 |
| **Scale** | Monthly | 69 | 49 | 40 | 35 | 30 | 20 |
| | Quarterly | 62 | 44 | 36 | 32 | 27 | 18 |
| | Annual | 55 | 39 | 32 | 28 | 24 | 16 |
| **Enterprise** | Monthly | 99 | 69 | 55 | 50 | 40 | 30 |
| | Quarterly | 89 | 62 | 50 | 45 | 36 | 27 |
| | Annual | 79 | 55 | 44 | 40 | 32 | 24 |

Invoice amount = per-account price × accounts billed × months in the period (1, 3 or 12). Quarterly and annual are paid up front.

### 1.3 Early-supporter discount (lifetime deal)
- Tiers from `waitlist.ts`: first 50 businesses 50% off, next 50 30%, next 50 10%.
- The tier is fixed **when the workspace signs up**, recorded on the workspace (`early_supporter_discount`), and applied as a Stripe coupon with `duration=forever` when they subscribe.
- It applies on top of everything: any plan, any number of accounts, any period, and survives upgrades, downgrades and account changes.
- It's lost only when the subscription **ends** (cancelled and the period has run out). Cancelling and then undoing the cancellation before the period ends keeps it.
- The website's `claimed` counter is typed in by hand today. It should read the real count from an app endpoint (§10.6).

### 1.4 Trial (decided)
- **7 days, 1 account, no card.** `trial_ends_at = created_at + 7 days`; `trial_account_limit = 1`.
- During the trial the workspace has **Scale** features, so people try AI auto-replies. Enterprise-only features stay off.
- **At the end of day 7 without a subscription, the sender is disconnected:** its Unipile account is deleted (so Unipile stops billing us for it), but the sender record stays in our database as **Disconnected**, with its conversations, relations and enrolments. Everything (sequences, leads, inbox history, settings) is kept, read-only, for **30 days**, then deleted (§5.1). Reconnecting is a normal sign-in on the same sender (§12.1).
- Subscribing during the trial ends the trial and starts the paid period that day.
- **No refunds** on anything (§4.7).

---

## 2. The volume-pricing trap, and the rule that fixes it

Because the step price applies to every account, some counts cost **more** than a bigger count. Launch monthly: 9 accounts = 9 × $39 = **$351**, 10 accounts = 10 × $29 = **$290**. Worst case: 99 accounts = $2,178 vs 100 accounts = $1,600.

Every count in these ranges costs the same or more than the next step:

| Plan | Monthly | Quarterly | Annual |
|---|---|---|---|
| Launch | 4→5, 8–9→10, 18–19→20, 44–49→50, 73–99→100 | 4→5, 8–9→10, 18–19→20, 44–49→50, 70–99→100 | 4→5, 8–9→10, 18–19→20, 45–49→50, 73–99→100 |
| Scale | 4→5, 9→10, 18–19→20, 43–49→50, 67–99→100 | same as monthly | same as monthly |
| Enterprise | 4→5, 8–9→10, 19→20, 40–49→50, 75–99→100 | 4→5, 9→10, 18–19→20, 40–49→50, 75–99→100 | 4→5, 8–9→10, 19→20, 40–49→50, 75–99→100 |

Without a rule, customers in these ranges either overpay (and churn when they notice) or buy the bigger step anyway.

### Rule: best price
**If a bigger step costs the same or less, the customer gets the bigger step at its price.** Someone who asks for 8 accounts on Launch monthly is billed for 10 at $290 and can connect 10.
- In the picker: *"10 accounts cost less than 8 ($290 vs $312). You'll get 10."*
- Stored as `accounts_requested` (8) and `accounts_billed` (10). The connection limit is `accounts_billed`.
- Decreases into a range are blocked with the reason: *"8 accounts would cost more than your current 10."*
- Implemented once, in the price book function `quote(plan, period, n)`, used by the app, the backend and the website slider.

This keeps the published prices and Stripe's standard volume tiers unchanged. The cost: in the 67–99 range a customer may get up to ~30 spare accounts. If they connect them, we pay Unipile for them (§12). **Alternative** (Decision D2): make the per-account price fall gradually between steps (straight line from one step's price to the next). That removes every inversion while keeping the headline step prices; totals rise with every account. It needs a website copy change ("drops with every account you add") and custom Stripe prices.

---

## 3. How the competitors handle changes

| | HeyReach | GetSales | Expandi |
|---|---|---|---|
| Pricing shape | Per sender, two tiers (<10 / 10+), monthly/quarterly/yearly; agency bundles of 25/50; Unlimited flat | Per seat with volume steps (1/10/20/50/100), monthly / 6-month / 12-month | Per seat |
| Adding seats | Immediate, prorated for the remaining days of the period | From Settings → Billing (proration not documented) | Prorated amount added to the **next** invoice |
| Removing seats | At the start of the next billing cycle; no refund or credit | Not documented | Prorated amount on the next invoice |
| Plan downgrade | At the next cycle; plan access stays until then; accounts over the new count are **disconnected automatically** at renewal | Up/down from Billing page | — |
| Billing cycles mixed? | No: added seats follow the existing cycle; "not possible to have portions of senders distributed on different billing cycles" | — | — |
| Cancel | No refund for the current period; access until period end; then campaigns paused, accounts disconnected; can't connect accounts or launch campaigns once cancelled | — | Fees non-refundable; account active until end of cycle |
| No subscription | — | Sender profiles and automations stop | — |

Our rules (§4) follow HeyReach's shape, which is the market norm and the easiest to explain: **more now, less later, no refunds for reductions, one billing cycle per workspace**. We improve on it in three places: we pause excess accounts instead of disconnecting them, we let the customer pick which ones stay, and we show the exact charge before every change.

---

## 4. Change rules

### 4.1 The principle
Every change is split into what goes **up** and what goes **down**:

| Dimension | Goes up → applies **now**, prorated charge today | Goes down → applies **at renewal**, no refund |
|---|---|---|
| Accounts | 5 → 10 | 10 → 5 |
| Plan | Launch → Scale → Enterprise | Enterprise → Scale → Launch |
| Billing period | Monthly → Quarterly → Annual | Annual → Quarterly → Monthly |

A change that mixes directions is split: the "up" parts apply now, the "down" parts are scheduled for renewal. Example: Launch 20 → Scale 10 = plan up **now** (Scale 20 for the rest of the period, prorated) + accounts down **at renewal** (Scale 10 from the next period).

There is exactly one subscription and one billing cycle per workspace. Added accounts always join the existing cycle.

### 4.2 Increase accounts (e.g. 5 → 10)
- Applies the moment payment succeeds; the new accounts can be connected straight away.
- Charge today = (new period total − current period total) × time left in the period.
- The per-account price of **all** accounts changes to the new step's price from now on (that's how the 5→10 price drop reaches the customer).
- If the payment fails or needs 3-D Secure and isn't completed, **nothing changes** (Stripe `payment_behavior=pending_if_incomplete`).

**Example — Launch, monthly, 15 days left of 30:**
5 accounts = 5 × $39 = $195/month. 10 accounts = 10 × $29 = $290/month.
Charge today = ($290 − $195) × 15/30 = **$47.50**. Next invoice: **$290**.

**Example — Launch, annual, 8 months left, 10 → 20:**
10 × $23 × 12 = $2,760/yr. 20 × $20 × 12 = $4,800/yr.
Charge today = ($4,800 − $2,760) × 8/12 = **$1,360**. Renewal: $4,800.

### 4.3 Decrease accounts (e.g. 10 → 5)
- Scheduled for the end of the current period. Until then, all 10 can still be used. No refund or credit.
- From renewal the per-account price is the smaller step's price: 5 × $39 = $195/month.
- If more than 5 accounts are connected at renewal, the extras are **paused** (`status_reason = 'over_plan_limit'`), not deleted and not disconnected immediately (§6.4). The customer picks which to keep in the change screen; if they don't, we keep the 5 with the most activity in the last 14 days.
- The scheduled decrease can be cancelled any time before renewal.
- Blocked if the new count falls in a best-price range that costs more (§2).

### 4.4 Upgrade plan (e.g. Launch → Scale)
- Applies now; features switch on at once. Charge today = price difference × time left.
- **Example — 10 accounts, monthly, 20 days left of 30:** Launch $290, Scale 10 × $40 = $400. Charge today = $110 × 20/30 = **$73.33**.

### 4.5 Downgrade plan (e.g. Scale → Launch)
- Scheduled for renewal; features stay until then.
- The change screen lists exactly what will switch off, with counts (§7.3), e.g. *"3 sequences on Auto will switch to Draft · 2 client viewers will lose access · 1 tracking domain will stop being used."*
- Nothing is deleted. Upgrading again later brings the settings back.

### 4.6 Change billing period
- **Longer** (monthly → quarterly → annual): applies now. The unused part of the current period is credited, and the new period starts today.
  **Example — Launch 10, monthly, 20 days left:** credit $290 × 20/30 = $193.33. Annual = 10 × $23 × 12 = $2,760. Charge today = **$2,566.67**. Renews in 12 months.
- **Shorter** (annual → quarterly → monthly): applies at the end of the current term.

### 4.7 Cancel
- Cancels **at the end of the current period**. Full access until then. **No refunds** — not for cancellations, reductions, downgrades or unused time, on any billing period.
- At period end: subscription ends, plan becomes `cancelled`, every sender pauses (`billing_cancelled`), sequences stop sending, the workspace becomes read-only (inbox readable, nothing sends). Data kept for **90 days** with emails at 30, 7 and 1 day before deletion. (Trials follow their own 30-day rule, §5.1.)
- **Undo cancel** before the period ends: everything continues as if nothing happened (early-supporter discount kept).
- **Coming back** after the period ended: a new subscription at list price (early-supporter discount gone); data restored if still within the 90 days.
- Cancel reasons are asked in our own cancel screen (multiple choice + text), not in the Stripe portal.

### 4.8 Changes while something else is pending
| Situation | Rule |
|---|---|
| Decrease scheduled, then an increase | The scheduled change is replaced by the new target; if the new target is higher than now, it applies now |
| Downgrade scheduled, then upgrade | Scheduled downgrade cancelled; upgrade applies now |
| Cancellation scheduled, then any change | Asked: *"Resume your subscription?"* — the change resumes it |
| Payment past due | Only "pay now" and decreases/cancel are allowed; increases and upgrades are blocked until paid |
| A previous upgrade's payment is incomplete (3-D Secure pending) | Show the pending payment; no other change until it's completed or abandoned |

### 4.9 Quote before every change
Every change screen shows, from the server (`billing_quote`), before the customer confirms:
- **Charged today** (with the proration explained in one line),
- **Next invoice** date and amount,
- **What changes now** and **what changes on {date}**,
- Best-price note if it applies, early-supporter discount line if any, tax if applicable.

The amount charged must equal the quote. The server computes the quote with Stripe's invoice preview for the same change.

---

## 5. Lifecycle

### 5.1 Trial → paid

| When | What happens |
|---|---|
| Sign-up | Trial starts: 7 days, **1 account**, Scale features, no card |
| Day 5 | Email + in-app banner: *"Your trial ends in 2 days. Subscribe to keep your account connected."* |
| Day 6 | Email: *"Tomorrow your LinkedIn account will be disconnected"* (names the account) |
| **End of day 7** (`trial_ends_at`) without a subscription | Plan → `trial_expired`. The sender is **disconnected** (§12.1): Unipile account deleted, sender row kept with `status = 'disconnected'`, `status_reason = 'trial_expired'`, `unipile_account_id` moved to `previous_unipile_account_id`; every enrolment on it paused. Workspace read-only: inbox, sequences, leads and reports visible; nothing sends; the sender shows *Disconnected — subscribe to reconnect* |
| Day 7 → day 37 | Subscribe any time. Sequences, leads, history and settings are all still there. The person clicks **Reconnect** on the sender and signs in again (a new Unipile hosted-auth link bound to the same sender — the app's existing `reconnectLink` "fresh bind" path). The new Unipile account attaches to the **same** sender record, so its conversations, relations and enrolments carry on. If they use *Connect account* instead, the existing duplicate merge (`absorbDuplicateSender`, matched by LinkedIn provider id) folds it into the old sender. Emails at day 14, 30 and 36 |
| Day 37 (30 days after expiry) | Workspace data deleted (workers + storage), user account kept so they can start again with a new trial-less workspace (one trial per user/company, §14 #38) |

- **Subscribe** (during or after the trial): pick plan, accounts and period → quote → Stripe Checkout (card, billing details, tax ID) → paid period starts today, trial ends. Minimum accounts = 1.
- Owner (platform admin) can extend a trial from the admin panel (existing).
- "Disconnected" means the Unipile account is deleted, so a lapsed trial stops costing us from the next Unipile billing period, while the person can still reconnect onto the same sender (§12.1).

### 5.2 Renewal
- Stripe invoices at period end with the scheduled changes applied (subscription schedule phase, §8.4).
- On `invoice.paid`: renewal recorded; scheduled decreases enforced (§6.4).

### 5.3 Failed payment (keeps today's behaviour, made explicit)
| Day | What happens |
|---|---|
| 0 | `invoice.payment_failed` → `past_due`, red banner for the owner, email with a pay link; Stripe Smart Retries run |
| 3 | Reminder email |
| 7 | Workspace **suspended**: senders paused (`billing_suspended`), nothing sends, inbox read-only (current `runBillingSync` rule) |
| 21 | Stripe cancels the subscription after the last retry → treated as cancelled (§4.7), 90-day data clock starts |
| Any time | Payment succeeds → `outreach_resume_after_billing` restores the plan and resumes paused senders (existing function) |

### 5.4 Disputes
`charge.dispute.created` → suspend at once, notify the platform admin. `charge.dispute.closed` won → resume.

---

## 6. Accounts: enforcing the limit

### 6.1 What occupies an account
A sender occupies one account when `deleted_at is null and status not in ('disabled','disconnected')`. That includes `ok`, `paused`, `credentials`, `error`, `connecting`. Disabling, deleting or disconnecting a sender frees the account immediately; **reconnecting a disconnected sender needs a free account**, like connecting a new one.

### 6.2 Connecting
- `outreach_slots(ws)` returns `{billed, used, reserved, available}`.
- Creating a hosted-auth link (LinkedIn, Instagram, WhatsApp), adding a mailbox (Unipile or native IMAP) and re-enabling a disabled sender each need `available ≥ 1`. Otherwise `E_ACCOUNT_LIMIT` with remedy *"Add an account"*.
- A hosted-auth link **reserves** an account for its 15-minute life (`outreach_slot_reservations`), released when the link expires, fails or completes. This stops two simultaneous links from creating 11 accounts on a 10-account plan.
- A database trigger on `outreach_senders` insert/update rejects any change that would push `used` above `billed`, so no code path can exceed the limit.
- In the UI, the Connect button at the limit becomes **Add an account — $X today**, which opens the change screen pre-set to +1.

### 6.3 Swapping accounts
Deleting one account and connecting another in the same period is allowed and free (the account is a slot). This costs us an extra Unipile account for that month (§12). We log swaps and alert the platform admin above 5 swaps per workspace per month.

### 6.4 Over the limit
It can happen only when a decrease or downgrade takes effect, or a payment for an increase is reversed. (A trial never goes over: its one sender is disconnected at expiry, §5.1.) Then:
1. Extras are paused with `status_reason = 'over_plan_limit'`: the customer's choice from the change screen, else lowest activity in the last 14 days, never the account the owner signed in with first.
2. Enrolments on paused senders wait (they don't move to other senders: the LinkedIn relationship belongs to the sender). `why_not_sending` explains: *"Paused: your plan has 5 accounts and 7 are connected."*
3. Banner on the Senders page: *"2 accounts are paused because your plan has 5. Add accounts or remove some."*
4. Adding accounts resumes them in the order they were paused.

---

## 7. Plans and features

### 7.1 Feature matrix (from the website's comparison table)

| Feature key | Launch | Scale | Enterprise | Where it's enforced |
|---|---|---|---|---|
| All channels, sequences, inbox, AI intent tagging, reports, A/B, warm-up, pools, Claude/ChatGPT connector, Calendly/Cal.com | ✔ | ✔ | ✔ | — |
| AI drafting (Draft mode, Draft with AI) | ✔ | ✔ | ✔ | — |
| `ai_auto_reply` — AI replies sends by itself (Auto mode) | — | ✔ | ✔ | sequence AI settings; reply worker |
| AI first lines and variables | Early access | Early access | Early access | — |
| Bring your own AI key | Early access | Early access | Early access | — |
| `clients` — clients kept apart | — | ✔ | ✔ | client create RPC; RLS scope |
| `client_viewer` — client-viewer portal and logins | — | ✔ | ✔ | invite member; login |
| `client_reports` — per-client reports and exports | — | ✔ | ✔ | report/export RPCs |
| `tracking_domains` — custom tracking domains | — | ✔ | ✔ | existing check in `015_platform.sql` (rename plans) |
| `white_label` | — | — | ✔ | branding settings; app domain |
| `webhooks` — signed webhooks | — | — | ✔ | webhook create; delivery worker; `call_webhook` node |
| `public_api` (early access) | — | — | ✔ | API key create; API gateway |
| `crm_sync` (early access) | — | — | ✔ | CRM OAuth; sync worker |
| `priority_processing` | — | — | ✔ | worker queue priority |
| `ai_limits` | Standard | Standard | Higher | AI pool (numbers: Decision D7) |
| `webchat_inboxes` (not on the pricing page yet) | 1 | 3 | Unlimited | existing check in `051_webchat_functions.sql` |

Stored as a seeded table (`outreach_plan_features`) and read through `outreach_has_feature(ws, key)` / `outreach_plan_limit(ws, key)`. Every server-side check uses these functions; no code compares plan names directly. Errors are `E_PLAN_REQUIRED` with the plan that unlocks the feature, so the UI can show *"Available on Scale — Upgrade"*.

### 7.2 Trial and suspended
- Trial: Scale's features, 1 account.
- Suspended / cancelled: features are whatever the last plan had (so settings stay visible), but nothing sends.

### 7.3 What a downgrade switches off (applied at renewal)

| Feature lost | What happens | On re-upgrade |
|---|---|---|
| AI auto-reply (Scale → Launch) | Sequences on **Auto** switch to **Draft**; scheduled AI replies become drafts | Mode returns to Auto |
| Clients | Client separation stays in the data; client filters still work for the team; new clients can't be created | Full |
| Client viewers | Their logins are disabled (not deleted); they see *"Your agency's plan no longer includes client access"* | Logins re-enabled |
| Per-client reports/exports | Hidden; scheduled client reports stop | Resume |
| Tracking domains | Links use the default tracking domain; the custom domain config is kept | Custom domain used again |
| White-label (Enterprise → Scale) | Default branding; custom app domain redirects to the default domain | Restored |
| Webhooks | Delivery paused (events not queued); `call_webhook` sequence steps skip with `E_PLAN_REQUIRED` | Delivery resumes for new events |
| Public API | API keys return `402 E_PLAN_REQUIRED`; keys kept | Keys work again |
| CRM sync | Sync paused; connection kept | Sync resumes from where it stopped |
| Priority processing | Normal queue | Priority |
| Webchat inboxes over the limit | The newest extra inboxes go inactive (widget shows "leave a message" only) | Active |

The change screen lists each of these that applies, with counts, before the customer confirms.

---

## 8. Stripe design

### 8.1 Products and prices
- One product per plan: `Launch`, `Scale`, `Enterprise`.
- One **volume-tiered** recurring price per plan × period (9 prices), `tiers_mode=volume`, with tiers up to 4 / 9 / 19 / 49 / 99 / ∞ matching §1.2. Quarterly = `interval=month, interval_count=3`; annual = `interval=year`. Unit amounts per period (×1, ×3, ×12).
- Lookup keys: `{plan}_{period}_v1` (e.g. `scale_annual_v1`). A future price change creates `_v2` prices; existing subscribers stay on `_v1` until they change plan (§13 grandfathering).
- Quantity on the subscription item = `accounts_billed` (after the best-price rule).
- Enterprise custom deals: a per-customer price created from the admin panel (`enterprise_custom_{workspace}`), still quantity-based.

### 8.2 Coupons
`early_50`, `early_30`, `early_10`: `percent_off`, `duration=forever`. Attached at Checkout from `workspace.early_supporter_discount`. Never attached by the customer (promotion codes off).

### 8.3 Immediate changes
`POST /subscriptions/{id}` with the new price and/or quantity, `proration_behavior=always_invoice`, `payment_behavior=pending_if_incomplete`, and `billing_cycle_anchor=now` only for a longer billing period. If 3-D Secure is needed, return the payment intent's client secret to the app to confirm; until then the subscription keeps its old items (`pending_update`).

### 8.4 Scheduled changes (decreases, downgrades, shorter periods)
Stripe **Subscription Schedule** on the subscription: phase 1 = current items until `current_period_end`; phase 2 = new plan/quantity/period. Cancelling the scheduled change releases the schedule. Our DB mirrors it in `scheduled_change` for display. When the customer makes an immediate change while a schedule exists, the schedule is updated in the same request.

### 8.5 Customer portal
Configured for: payment methods, invoices, billing address and tax IDs **only**. Plan switching, quantity changes and cancellation are **off** in the portal — they go through our screens so the rules above and the slot checks always run.

### 8.6 Webhooks handled
`checkout.session.completed`, `customer.subscription.created|updated|deleted`, `subscription_schedule.updated|released|completed`, `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`, `charge.dispute.created|closed`. Each event is stored (`outreach_billing_events`, unique on `event.id`) so repeats are ignored; handlers read the current subscription from Stripe rather than trusting event order.

### 8.7 Tax
Stripe Tax on, billing address required, tax ID collection on (reverse charge where it applies). Currency USD only. See Decision D9 for Indian customers.

---

## 9. Data model

```sql
-- 054_billing_v2.sql (next free number in migrations/outreach)

-- Plans
alter table outreach_workspaces drop constraint if exists outreach_workspaces_plan_check;
update outreach_workspaces set plan = case plan when 'team' then 'launch' when 'agency' then 'scale'
                                                when 'agency_plus' then 'enterprise' else plan end;
update outreach_workspaces set settings = jsonb_set(settings, '{plan_before_suspension}',
  to_jsonb(case settings->>'plan_before_suspension' when 'team' then 'launch' when 'agency' then 'scale'
                                                     when 'agency_plus' then 'enterprise' else settings->>'plan_before_suspension' end))
 where settings ? 'plan_before_suspension';
alter table outreach_workspaces add constraint outreach_workspaces_plan_check
  check (plan in ('trial','trial_expired','launch','scale','enterprise','suspended','cancelled'));
alter table outreach_workspaces alter column trial_ends_at set default now() + interval '7 days';

alter table outreach_workspaces
  add column billing_period       text check (billing_period in ('monthly','quarterly','annual')),
  add column accounts_requested   int  check (accounts_requested >= 1),
  add column accounts_billed      int  check (accounts_billed >= 1),
  add column trial_account_limit  int  not null default 1,
  add column current_period_start timestamptz,
  add column current_period_end   timestamptz,
  add column cancel_at_period_end boolean not null default false,
  add column cancelled_at         timestamptz,
  add column data_delete_after    timestamptz,
  add column scheduled_change     jsonb,     -- {plan, accounts_billed, billing_period, effective_at, keep_sender_ids[]}
  add column pending_payment      jsonb,     -- {payment_intent_id, client_secret, change, created_at}
  add column stripe_schedule_id   text,
  add column price_version        text not null default 'v1',
  add column early_supporter_tier int,
  add column early_supporter_discount numeric(3,2) not null default 0
             check (early_supporter_discount in (0, 0.10, 0.30, 0.50)),
  add column custom_price_id      text;      -- Enterprise custom deals

-- Price book (seeded from the shared pricing JSON; one row per plan × period × step)
create table outreach_price_book (
  version        text not null,              -- 'v1'
  plan           text not null check (plan in ('launch','scale','enterprise')),
  billing_period text not null check (billing_period in ('monthly','quarterly','annual')),
  step_min       int  not null,              -- 1, 5, 10, 20, 50, 100
  per_account_monthly numeric(8,2) not null, -- the §1.2 number
  stripe_price_lookup_key text not null,     -- e.g. scale_annual_v1
  primary key (version, plan, billing_period, step_min)
);

-- Features per plan
create table outreach_plan_features (
  plan        text not null,
  feature     text not null,
  enabled     boolean not null,
  limit_value int,                           -- e.g. webchat_inboxes 1/3/null
  primary key (plan, feature)
);

-- Slot reservations for hosted-auth links
create table outreach_slot_reservations (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outreach_workspaces(id) on delete cascade,
  purpose      text not null,                -- 'hosted_auth' | 'mailbox' | 're_enable'
  expires_at   timestamptz not null,
  released_at  timestamptz
);
create index on outreach_slot_reservations(workspace_id) where released_at is null;

-- Every billing change, with the quote shown and the result
create table outreach_billing_changes (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references outreach_workspaces(id) on delete cascade,
  requested_by  uuid references auth.users(id),
  from_state    jsonb not null,              -- {plan, accounts_billed, billing_period}
  to_state      jsonb not null,
  immediate     jsonb,                       -- part applied now
  scheduled     jsonb,                       -- part applied at renewal
  quote         jsonb not null,              -- {charge_today_cents, next_invoice_cents, next_invoice_at, lines[]}
  status        text not null check (status in ('quoted','applied','scheduled','pending_payment','failed','cancelled')),
  stripe_invoice_id text,
  created_at    timestamptz not null default now()
);

-- Stripe events (idempotency + audit)
create table outreach_billing_events (
  stripe_event_id text primary key,
  workspace_id    uuid references outreach_workspaces(id) on delete set null,
  type            text not null,
  payload         jsonb not null,
  received_at     timestamptz not null default now(),
  processed_at    timestamptz,
  error           text
);

-- Early-supporter ledger: tier assigned at sign-up, in order
create table outreach_early_supporters (
  workspace_id uuid primary key references outreach_workspaces(id) on delete cascade,
  position     int not null unique,          -- 1, 2, 3 … in sign-up order
  tier         int not null,
  discount     numeric(3,2) not null,
  assigned_at  timestamptz not null default now()
);

-- Senders: disconnect support (status 'disconnected' = Unipile account deleted, our data kept)
alter table outreach_senders
  add column previous_unipile_account_id text,
  add column disconnected_at timestamptz;
-- status values: add 'disconnected' to the sender status check/enum
-- status_reason values added: 'over_plan_limit', 'billing_cancelled', 'trial_expired', 'user_disconnected'
-- enrollment status: add 'waiting_reconnect' (paused, resumes on reconnect)

-- outreach_billing_usage: kept for reporting only; never used to set quantity again.
```

### 9.1 SQL functions
| Function | Does |
|---|---|
| `outreach_quote_accounts(plan, period, n, version)` | Best-price rule: returns `{requested: n, billed, per_account, period_total}` |
| `outreach_slots(ws)` | `{billed, used, reserved, available}`; trial uses `trial_account_limit` |
| `outreach_slot_reserve(ws, purpose)` / `outreach_slot_release(id)` | Reservations for links |
| Trigger `outreach_senders_slot_guard` | Rejects insert / re-enable when `used + 1 > billed` (`E_ACCOUNT_LIMIT`) |
| `outreach_has_feature(ws, key)` / `outreach_plan_limit(ws, key)` | Feature checks for RLS, RPCs and workers |
| `outreach_enforce_account_limit(ws, keep_ids uuid[])` | Pauses extras (§6.4); resumes in order when accounts are added |
| `outreach_apply_plan_features(ws, old_plan, new_plan)` | Applies §7.3 switch-offs and restorations |
| `outreach_resume_after_billing(ws)` (existing) | Map the old plan names; resume senders paused for `billing_suspended` and `billing_cancelled`; not `over_plan_limit`. Senders already **disconnected** (14 days paused, or a lapsed trial) aren't resumed automatically — they come back with Reconnect (§12.1) |

---

## 10. Backend

### 10.1 New endpoint: `outreach-billing` (replaces the user-invoked part of `outreach-stripe-webhook`)
Owner only (as today). Actions:

| Action | Input | Output |
|---|---|---|
| `quote` | `{plan, accounts, period}` | Split into immediate/scheduled parts, charge today, next invoice, best-price note, feature switch-offs with counts, senders that would be paused |
| `change` | Same + `quote_id` + `keep_sender_ids?` | Applies §4: Stripe update (now) and/or schedule (renewal). Returns `applied` / `scheduled` / `requires_action` (client secret) |
| `cancel_scheduled_change` | — | Releases the schedule |
| `checkout` | `{plan, accounts, period}` | Stripe Checkout session (subscription mode, volume price, quantity, coupon, tax, `client_reference_id`) |
| `cancel` | `{reason, comment}` | `cancel_at_period_end=true` |
| `resume` | — | Undo cancel |
| `portal` | — | Portal session (payment method, invoices, tax only) |

Rules: a quote expires after 15 minutes; `change` re-quotes and refuses if the amount moved (`E_QUOTE_STALE`). Each request carries an idempotency key derived from the quote id.

### 10.2 `outreach-stripe-webhook` (rewrite of the event half)
- Verify signature (existing), store the event (unique id), fetch the live subscription, then derive: `plan` from the price's product, `billing_period` from the interval, `accounts_billed` from the quantity, `current_period_*`, `cancel_at_period_end`, `scheduled_change` from the schedule, `stripe_status`.
- `planFromSub` regex on lookup keys is replaced by an exact lookup in `outreach_price_book` (plus `custom_price_id`).
- On quantity or plan going down at renewal: `outreach_enforce_account_limit` and `outreach_apply_plan_features`.
- On `customer.subscription.deleted`: plan `cancelled`, senders paused `billing_cancelled`, `data_delete_after = now() + 90 days`, early-supporter entitlement cleared.

### 10.3 `outreach-billing-sync` (cron daily) — what it stops and keeps doing
- **Stops** changing Stripe quantities. The peak-usage loop in `runBillingSync` is deleted.
- Keeps recording `outreach_billing_usage` (for reports and Unipile cost tracking).
- Keeps: past-due day-7 suspension.
- Trial expiry changes from "pause senders" to the §5.1 disconnect: `outreach_disconnect_sender(sender, 'trial_expired')` (§12.1), set `plan = 'trial_expired'` and `data_delete_after = trial_ends_at + 30 days`. Runs **hourly** (not daily) so the disconnect happens at the end of day 7, not up to a day later.
- Adds: reconciliation — if `used > billed` without a reason, pause extras and alert the platform admin; expire stale slot reservations; data deletion for workspaces past `data_delete_after` (with the warning emails before).

### 10.4 `outreach-sender-connect` and mailbox / IG / WA connect paths
Replace the hard-coded `count >= 3` trial check (now 1 via `trial_account_limit`) with `outreach_slot_reserve` → `E_ACCOUNT_LIMIT` when none available. Same for adding mailboxes (Unipile and native IMAP) and re-enabling senders (`outreach-sender-manage`).

### 10.5 Feature checks
Replace every plan-name comparison (`015_platform.sql` tracking domains, `051_webchat_functions.sql` inbox limits, billing page, admin, `TrackingDomainCard`) with `outreach_has_feature` / `outreach_plan_limit`, and add the missing checks from §7.1 (AI Auto mode, clients, client viewers, client reports, white-label, webhooks, API, CRM sync, priority).

### 10.6 Public endpoints for the website
- `GET /outreach-public/pricing` → the price book and features (so the website and app can't drift; the website may also build from the shared JSON, §11.4).
- `GET /outreach-public/early-supporters` → `{claimed, tiers}` for the waitlist ladder instead of the hand-typed `claimed: 100`.

---

## 11. Frontend

### 11.1 Billing page (`app/outreach/billing`)
```
Your plan
Scale · 10 accounts · Monthly                       $400 / month   (early supporter −30%: $280)
7 of 10 accounts used                                [Add accounts]
Next invoice: 14 Oct 2026 · $280
Scheduled: switches to Launch · 5 accounts on 14 Oct  [Cancel this change]

[Change plan]   [Payment method & invoices]   [Cancel subscription]
```
- Replaces the Team/Agency/Agency Plus picker and the "peak senders" usage view.
- Usage chart stays as "Accounts connected over time" (information only).
- Past-due, suspended, cancelled and trial states each get one clear banner with one button.

### 11.2 Change plan screen
The same three controls as the pricing page: **plan cards** (Launch / Scale / Enterprise with highlights), **accounts** (stepper with step markers 1/5/10/20/50/100, any number allowed, up to 100; above 100 → "Talk to us"), **period** (Monthly / Quarterly −10% / Annual −20%). Live server quote on the right:
- per-account price and total, best-price note, early-supporter line;
- **Today** vs **On {renewal date}** columns;
- switch-off list (§7.3) for downgrades;
- "Choose which accounts to keep" list when the count goes below what's connected;
- **Confirm and pay $X** (or **Schedule change**).

### 11.3 Elsewhere in the app
- **Senders page:** meter *"7 of 10 accounts"*; Connect button becomes *Add an account — $X today* at the limit; paused-by-plan badges.
- **Feature gates:** locked features show a small *Scale* / *Enterprise* tag and an upgrade link that opens the change screen with that plan selected. Examples: AI replies Auto toggle, Clients, Invite client viewer, Tracking domains, White-label, Webhooks, API keys, CRM.
- **Workspace settings:** plan label map updated (Trial, Launch, Scale, Enterprise, Suspended, Cancelled).
- **Admin panel** (`components/admin`): plan list updated; set trial end; set `accounts_billed` override and custom Enterprise price; apply/remove early-supporter discount; view billing changes and Stripe events.
- **MCP:** `workspace_context` returns `{plan, accounts: {billed, used}, billing_period}`; `why_not_sending` adds `E_ACCOUNT_LIMIT` / `over_plan_limit`; billing changes are not exposed to MCP.

### 11.4 One source of prices
Move the price book and feature matrix into a shared JSON (`pricing/v1.json`) used by: the website (`src/data/pricing.ts` imports it), the app (quote preview), the DB seed (`outreach_price_book`, `outreach_plan_features`) and the Stripe setup script (`scripts/stripe-setup.ts` creates/updates the 9 prices and 3 coupons by lookup key). A test fails if the Stripe prices or DB rows differ from the JSON.

### 11.5 Website copy to change
| Where | Now | Change to |
|---|---|---|
| FAQ "Can I change plans?" | "The new price applies from the next billing period" | "Yes. Upgrades and extra accounts apply straight away; you pay the difference for the rest of your billing period. Downgrades and fewer accounts apply from your next billing period." |
| FAQ "What counts as an account?" | "Add them from the billing portal" | "Add them from Billing in the app; they're ready to connect as soon as you pay the difference." |
| Pricing data comment | "a count in between pays the price of the step at or below it" | add: "If a bigger step costs the same or less, you get the bigger step." |
| `trialNote` / `trialNoteShort` (`config/site.ts`) | "14 days free · 3 LinkedIn accounts · no card" | "7 days free · 1 account · no card" / "7 days · no card" |
| Pricing hero subtitle, page description, bottom CTA, `waitlistLine` | "Try it free for 14 days with up to 3 accounts" | "Try it free for 7 days with 1 account, no card." |
| FAQ "What happens at the end of the trial?" | "Your senders pause until you subscribe. Nothing is deleted…" | "Your account is disconnected at the end of day 7. Your sequences, leads and conversations stay for 30 days: subscribe and reconnect, and everything carries on. After 30 days they're deleted." |
| Billing promises: "Try it free for 14 days first, with no card." | | "Try it free for 7 days first, with no card." |
| Refund TODO (promises and FAQ) | — | Add FAQ "Do you offer refunds?" → "No. You can cancel any time and keep access until the end of the period you paid for; we don't refund the rest of a period, reductions or unused accounts." |
| App billing page | "Up to 3 senders, no card required" | "1 account, no card required" |
| Billing promises | "Cancel from the billing portal" | "Cancel from Billing in the app, no call needed. You keep access until the end of the period you paid for." |

---

## 12. Our Unipile cost (prepaid in, postpaid out)

Unipile bills us the **peak** number of connected accounts each month; we bill customers a **prepaid** number. The two only match if we keep connections tidy:
1. **The limit caps our cost:** customers can never connect more than `accounts_billed` (+ trial accounts), so our peak ≤ what's been paid for.
2. **Disconnect what we don't need** (§12.1): a sender deleted or disabled → delete its Unipile account the same day. Senders paused for `billing_suspended`, `billing_cancelled` or `over_plan_limit` for **14 days** → disconnected; the person reconnects later with a normal sign-in.
3. **Swaps:** a deleted-then-replaced account counts twice in Unipile's peak that month. Tracked (§6.3).
4. **Trials:** 1 Unipile account per trial, disconnected at the end of day 7 without a subscription. It still counts in that Unipile billing period (they bill the peak), so the worst case is one account for one period.
5. **Best-price spare accounts:** a customer with 70 requested / 100 billed can connect 100; that's paid for, so fine.
6. **Report:** a daily platform report of Unipile connected accounts vs total `accounts_billed` + trial accounts, with the gap explained.

### 12.1 How "disconnect" works on Unipile

What Unipile's public docs say (checked 1 Oct 2026):
- **Billing:** "Billing is based on the peak number of linked accounts active simultaneously" in each 30-day period; "all accounts appear on your dashboard home regardless of their current status".
- **Account endpoints:** List, Connect, Retrieve, **Reconnect** (hosted auth with `type: "reconnect"` and the existing `account_id`), **Delete** ("Unlink the given account to Unipile"), Restart ("restart the sources of a frozen account"), Resync, checkpoint and proxy calls.
- There is **no "pause" or "stop billing but keep the account" call.** The only way to stop paying for an account is **Delete**.
- Reconnect works only on an account that still exists. After Delete, the account id is gone; signing in again creates a **new** Unipile account (hosted auth `type: "create"`).

So "disconnect" in our product means: **delete the Unipile account, keep everything on our side, and let the person sign in again later onto the same sender.** The app already has both halves:
- `reconnectLink()` in `_shared/outreach/inbound.ts` checks `accountExistsOnDsn()`; when the account is gone it issues a `type: "create"` hosted link with `name` / `notify_url` bound to the **same sender id** ("fresh bind").
- `absorbDuplicateSender()` merges a newly connected account into an existing sender with the same `provider_user_id`, moving the new `unipile_account_id` onto the old sender.

New SQL/edge function `outreach_disconnect_sender(sender_id, reason)`:
1. Cancel queued actions for the sender; pause its enrolments (`waiting_reconnect`), never exit them.
2. `DELETE /accounts/{unipile_account_id}`; on success set `status = 'disconnected'`, `status_reason = reason` (`trial_expired`, `billing_suspended`, `billing_cancelled`, `over_plan_limit`, `user_disconnected`), `previous_unipile_account_id = unipile_account_id`, `unipile_account_id = null`, `disconnected_at = now()`. Keep secrets needed for a cookie/extension reconnect only if the owner chose browser sign-in; otherwise purge them.
3. If Delete fails (network/5xx), retry with backoff up to 24 h; the sender is already paused, so nothing sends meanwhile. Alert after 24 h (we'd be paying for it).
4. Audit + sender event `disconnected`.

Reconnect (UI: **Reconnect** on a disconnected sender; MCP: `sender_reconnect_link`):
1. Needs a free account (§6.2) and an active plan (or a trial with its 1 account free).
2. `reconnectLink()` fresh-bind → hosted auth → `CREATION_SUCCESS` → the new account attaches to the sender; `provider_user_id` must match the old one, otherwise the new Unipile account is deleted and the user is told to connect it as a new sender (§14 #24e).
3. Status `connecting` → `ok`; the existing post-reconnect quiet period applies before outreach resumes; paused enrolments resume.
4. Unipile resyncs messages for the new account (`SYNC_SUCCESS` backfill). Conversations and messages must dedupe against what we already have: match chats by the provider's chat/attendee ids and messages by the provider message id, **not** by Unipile's ids, which change with the new account (test in §15).

Two things to confirm with Unipile support before launch (§17):
- Does an account in `CREDENTIALS` (signed out) state still count as "linked" for billing? (Their wording suggests yes; we delete rather than rely on it.)
- When an account is deleted mid-period, it still counts toward that period's peak — confirm nothing is charged for it in the **next** period.

---

## 13. Migration from the current build

1. No paying customers yet, so no live subscriptions to convert. Any test subscriptions (`stripe_subscription_id is not null`) are cancelled in test mode and recreated.
2. Run `054_billing_v2.sql` (plan renames, new columns and tables, seeds).
3. Run `scripts/stripe-setup.ts` against test, then live: 3 products, 9 volume prices, 3 coupons, portal configuration, webhook endpoint with the §8.6 events.
4. Replace env vars `STRIPE_PRICE_TEAM_SENDER`, `STRIPE_PRICE_AGENCY_SENDER`, `STRIPE_PRICE_AGENCY_PLUS_SENDER`, `STRIPE_PRICE_MAILBOX_ADDON` with lookup-key resolution.
5. Assign early-supporter positions to existing workspaces in sign-up order.
6. Deploy backend (webhook, billing endpoint, billing-sync, sender-connect, feature checks), then frontend, then website copy.
7. **Grandfathering for later price changes:** a future v2 price book creates `_v2` prices; existing subscribers keep `_v1` for account increases and decreases; a plan change moves them to the current version, and the quote says so.

---

## 14. Edge cases

| # | Case | Behaviour |
|---|---|---|
| 1 | Picks 8 accounts on Launch monthly | Billed 10 at $290 (best price), can connect 10 |
| 2 | Wants to go from 10 to 8 | Blocked: 8 costs more than 10 |
| 3 | 10 → 7 | Allowed at renewal: 7 × $39 = $273 |
| 4 | Adds accounts on the last day of the period | Tiny prorated charge today; full new price from tomorrow |
| 5 | Adds accounts on an annual plan in month 11 | Charged for one month at the annual rate; same anniversary |
| 6 | Increase payment needs 3-D Secure | Change pending; app shows the 3-D Secure step; nothing applied until done |
| 7 | Increase payment declined | Nothing changes; error shown with *Update card* |
| 8 | Two owners click "Add account" at once | Quote ids + idempotency key; second request gets `E_QUOTE_STALE` and re-quotes |
| 9 | Two hosted-auth links on the last free account | The second can't reserve: `E_ACCOUNT_LIMIT` |
| 10 | Unipile connects an account after its reservation expired and the slot was taken | Guard trigger rejects; the Unipile account is deleted; the user sees *"No free account — add one and connect again"* |
| 11 | Decrease scheduled; customer connects more accounts before renewal | Allowed up to the current limit; at renewal the extras pause (their keep list is respected, new ones paused first) |
| 12 | Downgrade Scale → Launch with sequences on Auto | At renewal they switch to Draft; listed in the change screen |
| 13 | Downgrade Enterprise → Scale with webhook steps in live sequences | Steps skip with `E_PLAN_REQUIRED` from renewal; sequences keep running |
| 14 | Upgrade + fewer accounts (Launch 20 → Scale 10) | Plan up now (Scale 20, prorated); accounts down at renewal (Scale 10) |
| 15 | Monthly → annual mid-month | Credit for unused days, annual charged now, new anniversary today |
| 16 | Annual → monthly | At the end of the annual term |
| 17 | Cancel then add accounts | Asked to resume first; resuming keeps the discount |
| 18 | Cancelled and period ended; comes back after 40 days | New subscription at list price (no early-supporter discount); data restored (within 90 days); senders need fresh logins if their Unipile accounts were deleted after 14 days |
| 19 | Comes back after 120 days | Data deleted; starts fresh |
| 20 | Past due, tries to add accounts | Blocked: *"Pay the open invoice first"* |
| 21 | Past due 7 days | Suspended; paying resumes everything automatically |
| 22 | Card dispute | Suspended at once |
| 23 | Trial user tries to connect a second account | `E_ACCOUNT_LIMIT`: *"Your trial includes 1 account. Subscribe to add more."* — the button opens Subscribe with 2 accounts preselected |
| 24 | Subscribes on day 2 of the trial | Paid period starts that day; trial ends; no refund of anything later |
| 24a | Trial user deletes their account and connects a different one during the trial | Allowed (still 1 at a time); the first Unipile account is deleted immediately |
| 24b | Subscribes on day 20 (after expiry) | Clicks Reconnect on the disconnected sender, signs in; new Unipile account attaches to the same sender; history and enrolments carry on (72 h quiet period before outreach restarts, as after any reconnect) |
| 24e | Reconnects with a **different** LinkedIn account on the disconnected sender | Rejected: *"This sender was Priya Nair's LinkedIn. Connect this account as a new sender instead."* (provider id must match) |
| 24c | Subscribes on day 40 | Data is gone; starts fresh on a paid plan |
| 24d | A late Unipile webhook arrives for the deleted account | Ignored: no sender has that `unipile_account_id` any more (it's in `previous_unipile_account_id`); logged |
| 25 | Wants 150 accounts | Self-serve stops at 100 → "Talk to us"; admin sets a custom quantity at the 100+ price or an Enterprise custom price |
| 26 | Early supporter upgrades or adds accounts | Discount stays on everything |
| 27 | Early supporter downgrades | Discount stays |
| 28 | Rented LinkedIn accounts we supply | Count as accounts (Decision D8); the rental fee is billed separately |
| 29 | Disables a sender, then wants it back at the limit | Re-enable needs a free account |
| 30 | Swaps accounts 10 times in a month | Allowed; logged; admin alerted after 5 (Unipile cost) |
| 31 | Workspace owner leaves; manager needs billing | Ownership transfer (existing) — only owners manage billing |
| 32 | Agency wants one pool of accounts across several workspaces | Not in v1: one subscription per workspace (HeyReach's agency "seat pool" is a later option) |
| 33 | Tax ID added after an invoice | Applies from the next invoice (Stripe behaviour) |
| 34 | Price book changes to v2 | Existing subscribers keep v1 for account changes; plan change moves them to v2, shown in the quote |
| 35 | Stripe webhook arrives out of order or twice | Event id stored; handler always reads the live subscription |
| 36 | Customer changes quantity in the Stripe portal | Impossible: portal has plan/quantity changes off |
| 37 | Admin sets a plan manually (comp workspace) | Allowed with no Stripe subscription; `accounts_billed` set by admin; billing-sync skips Stripe for it |
| 38 | Same person or company signs up again for a second trial | One trial per user and per company email domain (free-mail domains excepted by user only); a second workspace starts without a trial and must subscribe to connect |
| 39 | Customer asks for a refund (annual bought by mistake, cancelled on day 1, card charged for added accounts) | No refund. Support can only cancel at period end. The quote screen states "Payments are non-refundable" above every Confirm button |

---

## 15. Tests

- **Price book parity:** website JSON = DB seed = Stripe prices (all 54 numbers and tier boundaries).
- **Best price:** for every plan, period and n in 1..100, `quote(n).period_total ≤ quote(m).period_total` for all m > n, and the billed count matches §2.
- **Proration:** for 5→10, Launch→Scale, monthly→annual, annual +10 accounts, the charged amount equals the quote (Stripe test clocks at day 1, 15 and 29 of the period). Verify Stripe's proration on a volume-tiered quantity change re-prices **all** units; if it doesn't, compute the proration ourselves and add it as an invoice item with `proration_behavior=none` (§17 Q2).
- **Scheduled changes:** decrease, downgrade and shorter period apply exactly at renewal with test clocks; cancelling them releases the schedule.
- **Slots:** trigger blocks the 11th account; reservations expire; concurrent link creation can't exceed the limit; over-limit pausing follows the keep list.
- **Downgrade effects:** every row of §7.3, applied at renewal and restored on re-upgrade.
- **Lifecycle:** trial expiry, subscribe mid-trial, failed payment day 0/7/21, recovery resumes senders, dispute, cancel/undo/expire, 90-day deletion with warning emails.
- **Webhooks:** duplicate and out-of-order events produce the same final state.
- **Unipile hygiene:** deleted/disabled senders and 14-day billing-paused senders are deleted at Unipile; daily cost report matches.
- **Disconnect → reconnect:** trial expiry disconnects at the end of day 7 (Unipile account gone, sender kept, enrolments `waiting_reconnect`); reconnecting the same LinkedIn on day 20 attaches to the same sender, resumes enrolments after the quiet period, and the resynced history creates **no duplicate** chats or messages; reconnecting a different LinkedIn is rejected and its Unipile account deleted.

---

## 16. Decisions needed before building

| # | Decision | Recommendation |
|---|---|---|
| D1 | ~~Trial length and trial data~~ | **Decided:** 7 days, 1 account, no card; sender disconnected at the end of day 7 (Unipile account deleted, reconnect later onto the same sender); data kept 30 days after expiry, then deleted (§1.4, §5.1) |
| D2 | **Best-price round-up vs a smooth per-account curve** (§2) | Round-up for v1: no change to published prices or Stripe tiers |
| D3 | Self-serve above 100 accounts | Stop at 100; above that through sales |
| D4 | Enterprise self-serve (the website button says "Book a demo") | Allow in-app upgrade to Enterprise at list price; keep the website button as is |
| D5 | ~~Refund policy~~ | **Decided:** no refunds, on any plan or billing period |
| D6 | Early-supporter prices on the website are rounded to the dollar; Stripe's coupon is exact (e.g. 30% off $39 = $27.30, the site shows $27) | Show cents on the website for discounted prices |
| D7 | AI limits: "Standard" vs "Higher" | Set numbers per account per month before launch |
| D8 | Rented LinkedIn accounts: count towards purchased accounts or extra | Count as accounts; rental billed separately |
| D9 | **Indian customers and cards:** RBI e-mandate rules for recurring card payments add an authentication step above a limit, and recurring charges may fail more often | Confirm with Stripe for your entity; offer annual/quarterly by invoice for Indian customers if needed |
| D10 | Monthly → annual: start the new annual period today (recommended, matches Stripe) or at the next renewal | Today |

---

## 17. Open questions to verify in Stripe test mode

1. Volume-tiered price + `interval_count=3` for quarterly: supported together (expected yes).
2. Proration on a quantity change for a volume-tiered price: does Stripe re-price all units and prorate the difference of totals? If not, compute it ourselves (§15).
3. Subscription schedule + `pending_if_incomplete` on the same subscription: confirm an immediate change while a schedule exists updates both cleanly.
4. Portal configuration with cancellation off and plan changes off, while still showing invoices and payment methods.
5. **Unipile (support ticket):** does a `CREDENTIALS`-state account count for billing; does an account deleted mid-period carry into the next period's peak; does a re-linked LinkedIn account return the same provider message and chat ids so our dedupe holds (§12.1).

---

## 18. Rollout

| Step | Contents |
|---|---|
| 1 | Shared price JSON, DB migration and seeds, Stripe setup script (test mode), feature functions with plan-name replacements — no customer-visible change |
| 2 | Billing endpoint (quote/checkout/change/cancel/resume), webhook rewrite, billing-sync change (no more peak quantity), slot enforcement |
| 3 | Billing page, change screen, senders meter, feature gates, admin panel |
| 4 | Stripe test clocks run through §15; then live prices, webhook and portal; website copy (§11.5) |
| 5 | Unipile hygiene jobs and the daily cost report |

---

**Sources:** [HeyReach — upgrade, downgrade or cancel](https://help.heyreach.io/en/articles/14723622-how-to-upgrade-downgrade-or-cancel-your-heyreach-subscription) · [HeyReach — plans and pricing](https://help.heyreach.io/en/articles/14741630-heyreach-plans-and-pricing-what-s-included-and-how-to-choose) · [GetSales — billing and settings](https://help.getsales.io/en/articles/10217777-billing-setting) · [GetSales — new pricing plans](https://help.getsales.io/en/articles/14780804-new-getsales-pricing-plans-send-enrich-and-scale) · [Expandi — terms and conditions](https://expandi.io/terms-conditions/) · [Stripe — tiered pricing](https://edge-docs.stripe.com/subscriptions/pricing-models/tiered-pricing)
