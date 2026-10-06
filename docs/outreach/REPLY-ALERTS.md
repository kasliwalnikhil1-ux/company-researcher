# Reply alerts — desktop notification and sound when someone replies

Built 6 Oct 2026 from `reply-notifications-PRD.md` (v1.0). Steps 1, 2 and 3 of the PRD rollout are all in this build.
This file is the contract: where things live, every deviation from the PRD, the rollout order and how to test.

## 1. Where things live

| Part | Files |
|---|---|
| SQL | `migrations/outreach/076_reply_alerts.sql` (tables, triggers, RPCs) · `077_reply_alerts_cron.sql` (push sender every 10 s, daily cleanup) |
| SQL tests | `migrations/outreach/tests/smoke_21_reply_alerts.sql` (31 checks) |
| F47 | `supabase/functions/outreach-notify-push/index.ts` · `_shared/outreach/webpush.ts` (VAPID + RFC 8291 aes128gcm on WebCrypto) · `webpush_test.ts` (6 tests incl. the RFC 8291 §5 vector) |
| Service worker | `public/outreach-sw.js` (scope `/outreach`; no fetch handler, caches nothing) |
| Sounds | `public/sounds/alerts/{ping,chime,pop,knock}.wav`, built by `scripts/outreach-alert-sounds.mjs` (16 kHz mono, all < 1 s and < 30 KB) |
| Browser runtime | `lib/outreach/alerts/browser.ts` (support, permission, this browser's switch, SW bridge, sounds, alerting-tab election) |
| React | `lib/outreach/alerts/index.ts` (settings hooks, Turn on flow, Web Push subscribe), `lib/outreach/alerts/engine.ts` (§3.3 decisions, tab title / icon dot / app badge) |
| UI | `components/outreach/alerts/*` (prompt banner, settings sections, toast, kind icons), `components/outreach/inbox/notes/NotificationBell.tsx` (kinds, merged counts, Pause), `app/outreach/settings/notifications/page.tsx` |
| Wiring | `components/outreach/Shell.tsx` (engine + tab badge), `components/outreach/inbox/InboxView.tsx` (banner, read on open), `app/outreach/inbox/page.tsx` (`?chip=needs_reply`), `contexts/AuthContext.tsx` (log out removes this browser's push subscription), `next.config.mjs` (SW never cached, sounds cached a week) |
| Tour | `lib/outreach/backend/demo/rpc/alerts.ts`, `'notify-push'` in `demo/fn/settings.ts` |

## 2. PRD → built

| PRD | Built |
|---|---|
| `notification_settings` | `outreach_notification_settings` (same columns) |
| `notification_prefs.sound boolean not null default true` | `outreach_notification_prefs.sound boolean` **nullable**: null = the kind's default (on; off for "assigned"). A row created earlier for a mention's email setting must not switch on the assignment sound |
| `notifications` + message_id, count, alert_desktop, alert_sound, updated_at | the same, plus `alert_muted` (paused / quiet hours: the page shows no toast either), `alerted_at` (merges re-alert after 30 s), `data` (display parts: channel, to, text, ws_name) |
| unique open reply alert per (user, chat) | per (user, chat, kind) for `reply_new` and `webchat_message` |
| `push_subscriptions` + `pgmq.create('push')` | `outreach_push_subscriptions`; **no pgmq on this project** → `outreach_push_queue` table (claimed with `for update skip locked`) |
| `notify_reply(message_id)` called by F2 | `outreach_alert_on_message(message_id)`, called by a **deferred constraint trigger** on `outreach_messages` (fires at commit). Covers every path (Unipile webhook, email, website chat, backfill) without touching F2, and sees the final state of the transaction (a website chat handed off in the same transaction alerts once, as a handoff) |
| `notification_alert_flags` | `outreach_alert_flags(user, ws, kind, at)` → `{desktop, sound, muted}`; a BEFORE INSERT trigger on notifications stamps every row with it, so mentions and AI handoffs follow the same rules |
| `notifications_mark_read(chat_id)` | `outreach_alerts_mark_chat_read(chat_id)` (the caller's reply / website chat / assignment alerts) |
| `notification_settings_save(patch)` · `notification_pref_set` | `outreach_alert_settings_save(ws, patch)` · `outreach_alert_pref_set(ws, kind, desktop, sound)`; `outreach_alert_settings_get(ws)` |
| `push_subscribe` / `push_unsubscribe` | `outreach_push_subscribe` / `outreach_push_unsubscribe` / `outreach_push_subscriptions_list` |
| F47 `notify-push` reads the queue every 10 s | `outreach-notify-push`: cron every 10 s (only when something is due) **and** nudged by each new alert (at most once every 2 s) → typically on screen in 1–3 s |
| VAPID keys in Vault | yes: created by F47 on first use (`outreach_push_vapid_init`), names `outreach_vapid_public` / `outreach_vapid_private_jwk`. JWT `sub` = `OUTREACH_VAPID_SUBJECT` or `OUTREACH_WEB_ORIGIN` |

RPC names avoid the `outreach_notification%` prefix on purpose: the 046 grant loop revokes everything under it that is not on its list (the loop at the end of 046_chat_notes.sql; 045 fixed the same trap for the AI RPCs). `outreach_notifications_list` (046) was replaced in place (adds `message_id`, `count`, `data`, `updated_at`; sorted by `updated_at`).

## 3. Rules as built

- **Triggers an alert**: a message whose 075 kind is `person` (not ours, not an auto-reply, not a bounce, not a system event / CSAT), stored within 10 minutes of its `sent_at`.
- **AI answering → no reply alert** unless the person ticked the option. LinkedIn: `ai_answering` already set, or `outreach__ai_effective(chat).mode = 'autopilot'` (evaluated at commit, before `ai_reply_enqueue` runs). Website chat: not handed off and `ai_mode` not off / review (075's rule).
- **Recipients**: members who can read the chat (owners/managers all; members by client scope; client viewers only their clients' chats and only with the client-viewer feature), then scope: `mine` (assigned to me, or unassigned on a sender I own — owner matched by `owner_user_id`, else by e-mail), `mine_unassigned` (default), `all`.
- **Merging**: a new message updates the open alert (text, message, count +1); it alerts again only when the last alert is ≥ 30 s old.
- **Clearing**: opening a conversation reads *your* alerts on it (all your devices). **Our message** (app, phone, AI) reads *everyone's* open reply alerts on it — the conversation no longer waits on us. A reply the classifier later marks out-of-office is taken back.
- **Assignment**: "Ravi assigned you …" when someone else (or auto-assignment) assigns you; not for self-assignment, not in the transaction that handed the chat over, not twice with a reply alert. An older unread assignment of the same chat is replaced.
- **Website chat handoff**: assignee → "AI handed … to you"; nobody assigned → a website chat alert ("Asked for a person: …") to everyone in scope.
- **AI handoff on LinkedIn**: the 046 handoff note now alerts as `ai_handoff` ("AI handed X to you") instead of `note_mention`.
- **This device** (`engine.ts`): only the most recently used app tab acts (registry in storage + a claim under a Web Lock; a non-alerting tab steps in after 2 s if nobody claimed). Reading that chat → mark read only. Visible elsewhere → toast + sound (+ desktop only with "Notify even when I'm looking"). Background → sound + desktop. The desktop notification is silent when the app plays its own sound; if the browser blocked the sound, the notification carries the system sound.
- **Service worker**: tag = conversation; same alert from page and push = one notification; > 5 conversations within 60 s → "6 new replies" (opens Replies → Needs reply), later ones bump the count silently. Push with a visible focused app tab → nothing; with only background tabs → silent; with none → the system sound unless the Sound tick is off.

## 4. Deviations and limits

- **Out-of-office on LinkedIn** is only known after the classifier runs (seconds later): the sound / desktop notification may already have fired; the bell entry is then marked read.
- **Private windows**: Firefox private windows have no service worker → "Not available here: private window". Chrome incognito reports notifications as denied → shown as **Blocked**. There is no reliable detection beyond that.
- **Tab title** gets the `(3) ` prefix on whatever title the page has; the page title itself is not renamed to "Inbox · GrowthxAI Outreach".
- **Notification icon** is the app icon `/android-chrome-192x192.png` (no white-label icon).
- **Push endpoints** are limited to real push services (FCM, Mozilla, Apple, Windows): F47 POSTs to them, so any other URL is refused (SQL and F47 both check).
- A browser refused 10 times in a row (e.g. 403 after a key change) is removed; 404 / 410 remove it at once.
- **Not built**: §14 metrics, email for replies (§15 Q3), Brave help text (§15 Q5 unconfirmed). The tour seed has no reply alerts (the bell shows the seeded mentions).
- Open questions answered: Q1 — Web Push did not exist; built here. Q2 — no reply notification existed; nothing replaced.

## 5. Rollout

**Status 6 Oct 2026:** steps 1–4 done (075, 076, smoke_20/21 on live, all 55 outreach functions deployed, 077 cron on). A real Chrome + FCM end-to-end push (alert row → F47 → service worker) took 6.7 s. Step 5 (web app) is pending.

1. `075_inbox_replies_sent.sql` (required: 076 uses its message kinds and `ai_answering`).
2. `076_reply_alerts.sql`, then `smoke_21` (retry on `deadlock detected`: the ALTERs wait behind the workers).
3. Deploy `outreach-notify-push` (`bash scripts/outreach-deploy-functions.sh notify-push`, `OUTREACH_DEPLOY_EXTRA_ARGS=--use-api` without Docker). No other function changes.
4. `077_reply_alerts_cron.sql`.
5. Web app. Shipping the app before 076 is harmless (settings page shows an error card, nothing alerts).
6. PRD advice: own workspace for a week before relying on step 2.

## 6. Testing

- SQL: `cat 075 076 tests/smoke_21 > t.sql; bash scripts/outreach-sql.sh t.sql` (rolled back by its final raise). The alert triggers are deferred, so the test runs `set constraints … immediate`, and switches back to deferred for the one-transaction handoff case.
- Edge: `deno test --node-modules-dir=none supabase/functions/_shared/outreach/webpush_test.ts`; `deno check --node-modules-dir=none outreach-notify-push/index.ts` from `supabase/functions`.
- Service worker without a login: in a Playwright context with `permissions: ['notifications']`, open `/login`, register `/outreach-sw.js` with scope `/outreach`, `postMessage({type:'gx-alert-show', data})` and read `registration.getNotifications()`; push via CDP `ServiceWorker.deliverPushMessage` (the first push after `ServiceWorker.enable` can lag ~1 s).
- Tour: `/product-tour/settings/notifications` (saves locally), bell Pause / Resume in `/product-tour/inbox`.
