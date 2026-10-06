# PRD: Reply alerts — desktop notification and sound when a reply arrives

**Document:** Change PRD — browser notifications and a sound for new replies, with per-person settings and a permission flow
**Version:** 1.0 · 6 October 2026
**Applies to:** the app as built (`/outreach/inbox`, `/outreach/settings/notifications`), including the notification centre from `private-notes-PRD.md` (`notifications`, `notification_prefs`), `inbox-replies-sent-PRD.md`, AI replies v1.2 and website chat.
**Migration:** `0NN_reply_alerts` (next free number). **New function:** F47.
**Names:** tables and columns follow the specs. The build prefixes tables with `outreach_`; adjust.
**Checked:** MDN Notifications API, Chrome autoplay policy, iOS web push requirements, 6 Oct 2026.

---

## 0. Summary

| # | What |
|---|---|
| 1 | When a person replies, the people who should know get a **desktop notification** (the browser's own, e.g. Chrome's) and a **sound** |
| 2 | Each person chooses what they're alerted about and how, in **Settings → Notifications**. Choices are saved to their user and follow them to every browser |
| 3 | The app asks for the browser's permission only after the person clicks **Turn on**. Never on page load |
| 4 | Works while the app is open in any tab, including a background tab (step 1), and when no tab is open (step 2, Web Push) |
| 5 | No double alerts: one notification per conversation, one tab makes the sound, nothing fires for the conversation you're already reading |
| 6 | The same sound and desktop rules apply to the alerts that already exist: mentions, AI handoffs, assignments, website chat |

---

## 1. Today and the gap

| Exists in the specs | Missing |
|---|---|
| A notification centre: bell, toast, `notifications` table, Realtime | A desktop notification for a new reply |
| `notification_prefs` per user and kind (push, email, email delay) | Any sound |
| A Settings → Notifications page | A rule for who is alerted about which reply |
| Push for mentions and AI handoffs, described as "web-chat Web Push" | A permission flow, and what to show when the browser has blocked notifications |
| | A setting for sound choice, volume, pausing, hiding message text |

A reply is the most valuable event in the product, and it is the only one a person has to notice by looking at the inbox. This PRD closes that.

---

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| **D1** | Preferences are stored per user in the database. Permission and the on/off switch for a browser are stored in that browser | The browser owns its permission. It can't be granted "for the user" on a machine they haven't used |
| **D2** | Sound and desktop notifications stay off until the person turns them on once | A sound nobody asked for, after a deploy, in an office, is a bad first impression |
| **D3** | The app shows its own small prompt first. The browser's permission prompt appears only after a click on **Turn on** | Firefox and Safari refuse permission requests that don't come from a click, and Chrome hides or blocks prompts on sites where people keep dismissing them. A blocked permission can't be asked for again |
| **D4** | One notification per conversation. New messages in the same conversation update it | Three messages in a minute should be one alert |
| **D5** | The server decides whether an alert may make a sound or show on the desktop. The browser only decides whether this is the right moment on this device | One place holds the rules (preferences, pause, quiet hours), so the open app and Web Push can't disagree |
| **D6** | Replies the AI is answering don't alert by default | The person is alerted when the AI hands the conversation over, which already exists |
| **D7** | Built-in sounds only. No uploads | Enough for v1 |

---

## 3. What triggers an alert

### 3.1 The event

A message from a person arrives in a conversation. It is the same event that puts a conversation into **Replies → Needs reply**.

| Alerts | Doesn't alert |
|---|---|
| A reply to a sequence step or to a teammate's message | Our own messages, including ones sent from the owner's phone |
| A reply to a connection-request note | Auto-replies and out-of-office messages |
| A person who writes first on LinkedIn, WhatsApp, Instagram or email | Bounces, reactions, read receipts |
| A website chat message (uses the existing website chat kind) | A connection request being accepted with no message |
| | Messages older than 10 minutes when we receive them (history sync, messages delivered after a sender reconnects). They show as unread only |

### 3.2 Who is alerted

Workspace members who can read the conversation, narrowed by each person's **Notify me about** setting:

| Setting | Conversations |
|---|---|
| Assigned to me | Assigned to me, or unassigned on a sender I own |
| **Assigned to me and unassigned** (default) | The above, plus any unassigned conversation I can see |
| Everything I can see | Every conversation my role and client scope allow |

- **AI is answering it** (sequence on Auto, not handed off): no reply alert, unless the person ticked *Also when the AI is handling the reply*.
- If the same message also hands the conversation to that person (AI handoff), they get the handoff alert only.
- Client viewers can use this too. They only ever see their own client's conversations.

### 3.3 What happens on this device

| Where the person is | Bell and unread | Toast | Sound | Desktop notification |
|---|---|---|---|---|
| Reading that conversation (tab visible and focused) | Marked read | No | No | No |
| In the app, on another page or conversation | Yes | Yes | Yes | No (yes if *Notify even when I'm looking at the app* is on) |
| App open in a background tab or minimised window | Yes | No | Yes | Yes |
| No tab open (step 2) | Yes, when they come back | No | The operating system's own sound | Yes |
| Paused, or outside their quiet hours | Yes | No | No | No |

---

## 4. What the person sees and hears

### 4.1 Desktop notification

```
┌───────────────────────────────────────────────┐
│ ▣  Priya Nair · Razorpay                      │
│    Sure, happy to chat next week. What did    │
│    you have in mind?                          │
│    LinkedIn · to Naman                        │
└───────────────────────────────────────────────┘
```

| Part | Content |
|---|---|
| Title | Lead name · company. Company left out when unknown. Website chat: "Website visitor · {website name}" |
| Body | The first 120 characters of their message, then "{channel} · to {sender name}". With several new messages: "3 new messages", then the latest one |
| With *Show the message text* off | Body is "New reply on LinkedIn" |
| Icon | The app icon. Not the lead's photo |
| More than one workspace | The workspace name is added to the last line |

- **Click:** focuses an open app tab (or opens one) at `/outreach/inbox/[chatId]?m=<message id>` and marks the alert read.
- **One per conversation:** the notification's tag is the conversation id. A new message replaces the old notification. It alerts again only if more than 30 seconds have passed since the last alert for that conversation.
- **Many at once:** more than 5 conversations within 60 seconds collapse into one notification, "6 new replies", which opens Replies → Needs reply.
- **Clearing:** opening the conversation, on any device, removes its notification on every device where the app is open.

### 4.2 Sound

- Four built-in sounds: **Ping** (default), **Chime**, **Pop**, **Knock**. Short (under 1 second), under 30 KB each, served from the app.
- Volume 0–100, default 70. A **Test** button plays the chosen sound at the chosen volume.
- At most one sound every 3 seconds, and one per conversation every 30 seconds.
- When the app plays its own sound, the desktop notification is shown silent, so the person never hears two sounds for one reply.
- **Browser rule to design around:** a tab may only play sound after the person has clicked or typed in it at least once. The app unlocks sound on the first click or key press in each tab. If a sound is blocked anyway, nothing breaks and nothing retries; Settings shows *"Click anywhere in the app once so it can play sounds."*

### 4.3 In the app

- Toast: name, first line of the message, **Open**. Uses the existing toast.
- Browser tab title: `(3) Inbox · GrowthxAI Outreach`. The number is unread conversations, the same number as the Replies badge.
- A dot on the tab icon while there is anything unread.
- Installed as an app (PWA): the same number on the app icon.

---

## 5. Permission

### 5.1 The app's own prompt

Shown once at the top of the inbox, the first time a person opens it after this ships:

```
🔔  Know the moment someone replies
    Get a desktop notification and a sound when a prospect answers.
    [✓] Also play a sound
    [ Turn on ]   Not now
```

| Choice | Result |
|---|---|
| **Turn on** | The browser's permission prompt appears, called from this click. See §5.2 |
| **Not now** | Banner closes. It comes back once, 7 days later. After a second *Not now* it never returns; Settings is the only way in |

The banner isn't shown when the browser has already granted or blocked notifications, when the browser can't show them, or inside the product tour demo.

The same **Turn on** button is in Settings → Notifications.

### 5.2 After the browser's prompt

| Browser's answer | What the app does |
|---|---|
| **Allowed** | Turns on desktop notifications for this browser and, if ticked, sound. Sends a test notification: *"You're set. Replies will show up like this."* Saves the choices to the user |
| **Blocked** | No error. The banner becomes: *"Notifications are blocked for this site in your browser."* with the steps to allow them (click the icon left of the address bar → Notifications → Allow → reload). Sound can still be turned on, since it needs no permission |
| **Closed without answering** | Treated as *Not now* |

### 5.3 States on the Settings page

| State of this browser | Shown as | Control |
|---|---|---|
| Never asked | Off | **Turn on** |
| Allowed, switched on | On | **Turn off** (for this browser only) |
| Allowed, switched off by the person | Off | **Turn on** (no browser prompt needed) |
| Blocked | Blocked by your browser | Steps to allow |
| Can't show notifications | Not available here | The reason: private window · iPhone or iPad not added to the Home Screen · page not on HTTPS |

- The app re-reads the browser's permission on every load. If someone blocks it later in browser settings, the page shows Blocked; it doesn't nag.
- A granted permission can still be silenced by the computer itself (macOS notification settings for the browser, Windows Do not disturb). The app can't detect that. **Send a test notification** is always on the Settings page, with a line under it: *"Didn't see it? Check your computer's notification settings for this browser."*

---

## 6. Settings → Notifications

```
This browser · Chrome on Windows
  Desktop notifications      On            [ Turn off ]
  [ Send a test notification ]

Sound
  [✓] Play a sound       Sound [ Ping ▾ ]    Volume ────●──    [ ▶ Test ]

Notify me about
  ( ) Conversations assigned to me
  (•) Assigned to me and unassigned
  ( ) Every conversation I can see
  [ ] Also when the AI is handling the reply

                               In app    Desktop    Sound
  New reply                      ✓         [✓]       [✓]
  Website chat message           ✓         [✓]       [✓]
  Mention in a note              ✓         [✓]       [✓]
  AI handed a conversation to me ✓         [✓]       [✓]
  Conversation assigned to me    ✓         [✓]       [ ]

Options
  [✓] Show the message text in notifications
  [ ] Notify even when I'm looking at the app
  [ ] Only notify me between [09:00] and [19:00] on [Mon–Fri]   (Asia/Kolkata)

Pause       [ Pause for 1 hour ▾ ]      30 minutes · 1 hour · until tomorrow 9:00 · until I turn it back on

Your browsers                                                    (step 2)
  Chrome on Windows · this browser · on
  Chrome on Android · last used 3 Oct · on                       [ Remove ]
```

- Every change saves at once. No Save button.
- In app is always on and can't be unticked.
- Email columns that exist today for mentions and handoffs stay where they are. This PRD adds no email for replies (§15 Q3).
- **Pause** is also in the bell menu, with the time left shown beside the bell.
- Paused and quiet hours stop sound and desktop notifications. The bell and unread counts keep collecting.

### 6.1 What is stored, and where

| Stored on the user (database, follows them everywhere) | Stored in the browser |
|---|---|
| Notify me about · AI option | The browser's permission (owned by the browser) |
| Per-alert Desktop and Sound ticks | Desktop notifications on or off for this browser |
| Sound on, sound choice, volume | Step 2: this browser's push subscription (also saved on the server so it can be reached) |
| Show message text · notify when looking at the app | |
| Quiet hours · pause | |
| Whether the prompt was answered or dismissed | |

Settings are per person per workspace, like `notification_prefs` today.

---

## 7. How it's delivered

### 7.1 Step 1: the app is open in any tab

```
F2 stores their message
  → notify_reply(message_id)             picks recipients (§3.2), applies their settings,
                                         writes one notifications row each with alert_desktop / alert_sound
  → Realtime (notifications insert + update, filtered to the user)
  → every open tab updates the bell, unread count and tab title
  → the alerting tab applies §3.3: toast, sound, desktop notification
```

- **Alerting tab:** when several app tabs are open, only one alerts: the tab the person used most recently. Tabs agree on this through a browser lock (Web Locks, with a BroadcastChannel heartbeat as fallback). If that tab closes, the next most recent takes over.
- **Desktop notifications go through a service worker** (`registration.showNotification`), not through the page. Reasons: it's the only way that works on Android, and the click still works after the tab that raised it is closed. Step 1 needs only a minimal service worker that handles notification clicks. It caches nothing and intercepts no requests.
- Target: alert within 2 seconds of the message being stored.

### 7.2 Step 2: no tab is open (Web Push)

- When a person turns on desktop notifications in a browser, the app also creates a push subscription and saves it.
- `notify_reply` queues a push for each recipient whose row has `alert_desktop = true` and who has at least one saved browser.
- **F47 `notify-push`** sends them. On arrival the service worker decides:

| Open app tabs in this browser | Service worker does |
|---|---|
| One is visible and focused | Nothing. The page handles it (§3.3) |
| Open but in the background | Shows the notification, silent. The page plays the sound |
| None | Shows the notification with the operating system's sound, or silent if the person's Sound tick is off |

- Because the page and the service worker use the same tag, a reply can never produce two notifications.
- Target: notification within 15 seconds of the message being stored.
- The browser has to be running for a push to arrive. On a phone that is always the case.
- If website chat already built Web Push (service worker, keys, subscription table), reuse it and skip the parts of §8 marked *if missing* (§15 Q1).

---

## 8. Data

```sql
-- 0NN_reply_alerts

-- Per person, per workspace
create table notification_settings (
  user_id          uuid not null references auth.users(id) on delete cascade,
  workspace_id     uuid not null references workspaces(id) on delete cascade,
  scope            text not null default 'mine_unassigned'
                   check (scope in ('mine','mine_unassigned','all')),
  include_ai_handled boolean not null default false,
  sound_enabled    boolean not null default false,          -- D2: off until turned on
  sound_name       text not null default 'ping' check (sound_name in ('ping','chime','pop','knock')),
  sound_volume     smallint not null default 70 check (sound_volume between 0 and 100),
  show_preview     boolean not null default true,
  alert_when_visible boolean not null default false,
  quiet_hours      jsonb,                                   -- null = always. {days:[1,2,3,4,5], start:"09:00", end:"19:00", tz:"Asia/Kolkata"}
  paused_until     timestamptz,                             -- 'infinity' = until turned back on
  enabled_at       timestamptz,                             -- first time they turned alerts on
  prompt_dismissed_at   timestamptz,
  prompt_dismiss_count  smallint not null default 0,
  updated_at       timestamptz not null default now(),
  primary key (user_id, workspace_id)
);

-- Existing table: "Desktop" in the UI is the existing push column. Add sound.
alter table notification_prefs add column sound boolean not null default true;
-- A missing row means the defaults in §6 (assigned: sound off).

-- Existing table: one row per alert. Add what the reply alert needs.
alter table notifications
  add column message_id    uuid references messages(id) on delete cascade,
  add column count         int not null default 1,
  add column alert_desktop boolean not null default false,
  add column alert_sound   boolean not null default false,
  add column updated_at    timestamptz not null default now();
create unique index notifications_open_reply on notifications (user_id, chat_id)
  where kind = 'reply_new' and read_at is null;             -- D4: one open reply alert per conversation

-- Step 2, if missing
create table if not exists push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  endpoint     text not null unique,
  p256dh       text not null,
  auth         text not null,
  label        text,                        -- "Chrome on Windows"
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user on push_subscriptions (user_id);
select pgmq.create('push');                 -- if missing
```

- New notification kind: `reply_new`. Existing kinds keep their names.
- RLS: a person reads and writes only their own `notification_settings`, `notification_prefs` and `push_subscriptions`. `notifications` rows are written only by SQL functions.
- Push keys (VAPID) live in Vault. The public key is sent to the browser.

---

## 9. Functions

| Function | Does |
|---|---|
| `notify_reply(message_id)` | Called by F2 right after it stores a person's message. Skips the cases in §3.1. Finds recipients (§3.2). For each: inserts a `reply_new` row, or, if an unread one exists for that conversation, updates its text, `message_id`, `count + 1` and `updated_at`. Sets `alert_desktop` and `alert_sound` from `notification_alert_flags`. Queues a push when `alert_desktop` and the person has a saved browser |
| `notification_alert_flags(user, workspace, kind, at)` | The one place the rules live: the person's Desktop and Sound ticks for that kind, `sound_enabled`, pause, quiet hours. Returns `{desktop, sound}` |
| Existing alert creators (mention, AI handoff, assignment, website chat) | Call `notification_alert_flags` too, so §3.3 and the Sound column apply to them |
| `notifications_mark_read(chat_id)` | Called when a conversation is opened. Marks its alerts read; Realtime tells the person's other tabs and browsers to close the matching notification |
| `notification_settings_save(patch)` · `notification_pref_set(kind, desktop?, sound?)` | Save settings. Create the row on first use |
| `push_subscribe(endpoint, keys, label)` · `push_unsubscribe(endpoint)` | Save or remove this browser. `push_unsubscribe` also runs on log out |
| **F47 `notify-push`** (Edge Function; reads the `push` queue every 10 s) | Sends Web Push to each saved browser of the recipient. Time to live 1 hour, high urgency, collapse key = conversation id. A "gone" answer from the push service (404 / 410) deletes that subscription. If the alert was read before sending, it's dropped |

Realtime: the app's subscription to `notifications` adds **update** events (today: insert only), for the merged rows and for clearing.

F44 `note-notify` already sends pushes for mentions. It can put them on the same `push` queue so F47 is the only sender; that tidy-up is optional.

If F2 already creates a notification for each reply (the product tour spec says a reply creates "a notification"), `notify_reply` replaces that code (§15 Q2).

---

## 10. Browser support

| Browser | App open | No tab open | Sound |
|---|---|---|---|
| Chrome, Edge, Arc on a computer | Yes | Yes, while the browser is running | Yes, after one click in the tab |
| Firefox | Yes | Yes | Yes |
| Safari on Mac (16 and later) | Yes | Yes | Yes |
| Brave | Yes | Only with Brave's "Use Google services for push messaging" switched on **(confirm)** | Yes |
| Chrome on Android | Yes | Yes | Yes |
| iPhone and iPad | Only when the app is added to the Home Screen (iOS 16.4 and later) | Same | Limited |
| Private or incognito window | No | No | Yes |

HTTPS is required everywhere.

---

## 11. Edge cases

| Case | Behaviour |
|---|---|
| Three messages from one person in a minute | One notification, updated. One sound |
| Replies in 12 conversations at once | One summary notification. One sound |
| A sender reconnects and yesterday's messages arrive | Unread only. No sound, no desktop notification |
| App open in four tabs | One toast, one sound, one notification, from the most recently used tab |
| App open on a laptop and a desktop | Both alert. Reading on one clears the other |
| Tab was reloaded and not clicked yet | Sound may be blocked by the browser. The desktop notification still shows. Step 2: it carries the system sound instead |
| Chrome put the tab to sleep to save memory | Step 1 can't alert. Step 2 covers it: the push arrives and the service worker shows the notification |
| Person is reading that conversation | Nothing fires. The message appears in the thread |
| Person replies from another device before looking | The conversation is no longer waiting on us; the alert is marked read and cleared |
| AI is answering | No reply alert. The handoff alert fires if the AI hands over |
| Paused or outside quiet hours | Bell and unread update. Nothing else. Not replayed afterwards |
| Permission blocked after it was allowed | Settings shows Blocked. Sound still works |
| Computer has notifications off for the browser | The app can't tell. The test button and its hint are the way to find out |
| Person logs out | This browser's push subscription is removed. No alerts for a logged-out browser |
| Person is removed from the workspace or loses access to the client | No rows are created for them. Alerts already on screen open a "no access" page |
| Person belongs to two workspaces | Alerts arrive for both. The notification names the workspace. Clicking switches to it |
| Message text is sensitive, screen is shared | *Show the message text* off shows "New reply on LinkedIn" |
| Notification clicked with no app tab open | A new tab opens at the conversation |
| Product tour demo | No permission prompt, no real notifications. The settings page saves locally |

---

## 12. Rollout

| Step | Contents |
|---|---|
| 1 | Migration. `notify_reply`, `notification_alert_flags`. Settings page sections: This browser, Sound, Notify me about, the alert table, Options, Pause. The app's prompt and the permission flow. Minimal service worker. App-open alerts with the alerting-tab rule, merging per conversation and the summary notification. Tab title and icon dot. Existing kinds use the same rules |
| 2 | Web Push: subscriptions, F47, the service worker's push handling, Your browsers list, removal on log out |
| 3 | Quiet hours. Installed-app icon number. Product tour demo settings |

Ship step 1 to your own workspace first and use it for a week before step 2.

---

## 13. Tests

- A reply produces exactly one alert per recipient across four open tabs, and across page + push.
- Recipients match each scope setting, including "unassigned on a sender I own" and a member outside the client's scope (no alert).
- No alert for: our own message, phone-sent message, auto-reply, bounce, reaction, message older than 10 minutes, AI-handled conversation (default).
- The §3.3 table, row by row: focused on the conversation, elsewhere in the app, background tab, no tab, paused, quiet hours.
- Permission: prompt only after a click; Allowed sends the test notification; Blocked shows the steps and never re-prompts; *Not now* returns once after 7 days, then never.
- Settings saved on one browser apply on another after reload. The browser on/off switch doesn't.
- Sound: chosen sound and volume play; rate limits hold; a blocked play fails quietly and Settings shows the hint; no double sound with the desktop notification.
- Merging: second message updates the same row and notification; re-alerts only after 30 seconds.
- Clearing: opening the conversation removes the notification on a second open browser.
- Push: a dead subscription is deleted after a "gone" answer; logging out removes the subscription; a push for an already-read alert isn't sent.
- Clicking a notification focuses an existing tab, or opens one, at the right message.

---

## 14. Metrics

- Share of active people who turned alerts on, and share who got Blocked.
- Median time from a reply arriving to the conversation being opened, for people with alerts on and off.
- Share of replies first opened from a notification click.
- People who paused or turned sound off within a week of turning it on (a sign the defaults are too loud).

---

## 15. Open questions

1. **Is Web Push already built?** The private notes spec refers to "web-chat Web Push", but the website chat spec wasn't among the files I could read. If the service worker, keys and subscription table exist, step 2 is mostly wiring.
2. **Does a reply already create a notification today?** The product tour spec suggests it does. If so, this replaces how its recipients are chosen.
3. **Email for replies.** Not included. An option like "email me if a reply is still unread after 30 minutes" would use the same delay setting mentions already have. Say if you want it.
4. **Default scope.** "Assigned to me and unassigned" means a solo owner hears every reply, which is right for you today. For a 100-sender agency owner it may be a lot; the summary notification and Pause are the guard.
5. **Brave.** Push in Brave is believed to need a setting switched on. Confirm on a real install before writing help text.
