# PRD: Sender lifecycle — pause, disable, remove, erase

**Document:** Change PRD — what happens to a sender account (LinkedIn, mailbox, Instagram, WhatsApp) when it is paused, disabled, removed or erased, and the schema change that keeps its history safe
**Version:** 1.0 · 26 October 2026
**Applies to:** the app as built, per `linkedin-outreach-platform-PRD.md` (FR-SN-05, FR-SN-11, F2 `process-inbound`, F13 `sender-disable`, schema §7), `instagram-whatsapp-channels-PRD.md`, `linkedin-profile-management-PRD.md`, AI replies, and the Oct 2026 pricing (prepaid per-account plans, 7-day trial with one sender).
**Replaces:** FR-SN-11 and the `DELETED → disabled` row of the `account_status` handler.
**Migration:** `0NN_sender_lifecycle` (next free number). **New functions:** F51, F52, F53. **Changed:** F2, F3, F4, F13, F32/F33 (AI replies), billing sync.
**Names:** tables and columns follow the specs. The build prefixes tables with `outreach_`; adjust.
**Checked:** Unipile API reference — Delete an account, Account status webhook (`DELETED`), pricing (billed on peak linked accounts per period), 26 Oct 2026.

---

## 0. Summary

| # | What |
|---|---|
| 1 | Four actions, each one step further than the last: **Pause → Disable → Remove → Erase** |
| 2 | **Pause** stops sending for a while. Leads stay in their sequences and continue on resume |
| 3 | **Disable** turns the sender off. Leads leave their sequences, the connection stays so late replies still arrive, and it can be turned back on |
| 4 | **Remove** unlinks the account from Unipile, wipes stored credentials and frees the paid account slot. **All history stays**: conversations, who was contacted, report numbers |
| 5 | **Erase** deletes the sender's conversations and personal data for good. Scheduled 24 h ahead, cancellable until then |
| 6 | A sender row can no longer be hard-deleted by accident. Today a delete cascades and wipes inbox history and the "already contacted" record |
| 7 | Reconnecting a removed LinkedIn profile brings its history back |
| 8 | The person who owns the account can always disconnect it themselves from a link in their email, without logging in |
| 9 | A nightly check deletes Unipile accounts nobody is using, so the platform doesn't pay for them |

---

## 1. Today and the gap

| In the spec today | Problem |
|---|---|
| FR-SN-11: disable cancels queued actions, exits enrolments, "deletes Unipile account on explicit confirm" | Disable and remove are one action with an optional step. No defined state for "removed" |
| Every child table references `senders` with `on delete cascade` (chats → messages, actions, enrollments, lead_sender_state, sender_events, sender_budgets, tasks, profile and AI-reply tables) | Deleting a sender row wipes all its conversations, the record of who it contacted (which stops a lead being contacted twice) and its report numbers |
| A disabled sender stays linked in Unipile | Unipile bills each linked account, on the peak count per period. Disabled senders cost money indefinitely |
| `account_status: DELETED` → sender `disabled` | If someone deletes the account in the Unipile dashboard, the app thinks it can be re-enabled. It can't |
| Compose is off when the sender isn't `ok` | A paused sender can't answer a person who replied, although replying to inbound is the safest action there is |
| Nothing about sequences, auto-enrol rules, imports, AI reply runs, profile changes or extension tokens | Each of these can be left pointing at a dead sender |
| Reconnecting creates a new sender | The old history is split from the new one, and warmup starts from zero |
| No erase | Nothing answers "delete my data" from the account owner |
| Trial senders are removed at the end of day 7 (pricing decision) | No defined mechanism. Workspace deletion doesn't unlink Unipile accounts either |

---

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| **D1** | Four separate actions, each including everything the one before it does | People mean different things by "turn it off". Each step is easy to explain and the further steps ask for more confirmation |
| **D2** | **Remove keeps history.** Only Erase deletes conversations | The inbox, reports and the "already contacted" check are the workspace's records. Removing an account shouldn't rewrite last month's numbers or let a lead be contacted again by mistake |
| **D3** | A sender row can't be deleted except by the erase function | The cascade was a loaded gun. Foreign keys move to `no action` (§6.2) |
| **D4** | Disable keeps the Unipile link, so replies that arrive later still show up. After 30 days disabled (setting, 7–90) the sender is removed automatically, with an email 7 days before | A prospect often replies a week after the last touch. But a sender left disabled for months is pure cost |
| **D5** | A paused sender can still send manual replies from the inbox. A disabled one can't | Pause is about stopping automation. Disable means the account is off |
| **D6** | Pause keeps leads in their sequences. Disable exits them with `exited_sender_disabled`. The disable dialog offers to re-enrol them with other senders through the normal enrol preview | Moving a lead mid-sequence to another person isn't safe without a fresh start. The preview shows exactly who would get what |
| **D7** | Pricing: a paused or disabled sender keeps its paid account slot. Remove frees the slot for another account, with no refund for the current period | It is still linked and still costs us. Plans are prepaid with no refunds |
| **D8** | The sender owner can remove their own account from a link in any email we send them, without logging in. The workspace is told | It's their LinkedIn, WhatsApp or mailbox. They shouldn't have to ask an agency to let go of it |
| **D9** | Erase is scheduled 24 h ahead and can be cancelled until it runs. After it runs it can't be undone | A delete with no undo needs one last chance |
| **D10** | Reconnecting the same profile in the same workspace offers to restore the removed sender's history | One person, one sender record. History, health and warmup carry over |
| **D11** | The same profile can be live only once per workspace | Two sessions for one LinkedIn inside one workspace doubles every risk |

---

## 3. The four actions

### 3.1 At a glance

| | Pause | Disable | Remove | Erase |
|---|---|---|---|---|
| Status | `paused` | `disabled` | `removed` | `erased` |
| Sequence and AI sends | Stop | Stop | Stop | Stop |
| Manual replies from inbox | **Yes** | No | No | No |
| Leads in sequences | Stay, continue on resume | Exit (`exited_sender_disabled`) | Already exited | Already exited |
| New messages keep syncing | Yes | Yes | No | No |
| Conversations and history | Kept | Kept | **Kept**, read-only | **Deleted** |
| "Already contacted" record | Kept | Kept | Kept | Kept, without content (§5.4) |
| Report numbers | Kept | Kept | Kept, shown as "Name (removed)" | Kept, shown as "Erased sender" |
| Unipile account | Linked | Linked | **Deleted** | Deleted |
| Stored cookies / app passwords / extension token | Kept | Kept | **Wiped** | Wiped |
| Paid account slot | Used | Used | **Freed** | Freed |
| Undo | Resume | Enable | Reconnect (owner logs in again) | None after it runs |
| Who | Manager+ | Manager+ | Manager+, or the sender owner by link | Workspace owner |

### 3.2 Pause

What happens:
- `senders.status = 'paused'`, `paused_by`, `paused_at`, optional `paused_until` (auto-resume).
- The planner and tick skip the sender (they already skip anything not `ok`). Queued actions stay queued.
- AI replies: no autopilot sends from this sender; scheduled runs drop back to draft. Drafts keep appearing.
- Timers keep running. Actions that fall due during the pause wait, and on resume the planner spreads them over the next days within the normal daily caps — never a burst on the first morning.
- `wait_connection` and other time-based branches don't fire their actions until resume; acceptances still arrive, because the connection is live.
- Manual replies work (D5): compose is enabled when the sender is `ok` **or** `paused`.

Resume: status back to `ok`, planner rebuilds tomorrow and spreads any backlog.

### 3.3 Disable

Dialog first, showing counts from a dry run (`sender_lifecycle_preview`, §7.1):

> Disable **Naman Kasliwal (LinkedIn)**?
> - 148 queued actions are cancelled
> - 63 leads leave 3 sequences. 2 sequences have no other sender and will stop sending
> - 1 import job and 1 auto-enrol rule are paused
> - New replies keep arriving. You can enable it again any time
> - It still uses one of your paid accounts. If it stays disabled for 30 days we remove it automatically
>
> What should happen to the 63 leads? **Exit them** (default) · **Re-enrol them with other senders** (opens the enrol preview)

Then, in one transaction:

| Item | Effect |
|---|---|
| `senders` | `status='disabled'`, `disabled_at`, `disabled_by`, `disable_reason`, `auto_remove_at = now() + auto_remove_after_days` |
| `actions` queued or reserved for this sender | `cancelled`, `decision='sender_disabled'`. An action already in flight to Unipile finishes and its result is recorded |
| `enrollments` live on this sender | `exited_sender_disabled` (existing trigger cancels their actions) |
| Sequences | Sender stays in the pool but is skipped. A sequence left with no `ok` sender raises the existing `sequence_stalled` alert with reason "no active sender" |
| Auto-enrol rules that target this sender | Paused, reason `sender_disabled` |
| Import jobs running as this sender | Paused. The job page offers "run as another sender" |
| AI reply runs | Scheduled runs cancelled; drafts kept |
| Profile changes queued | Cancelled |
| Tasks | Unchanged. They're work for people |
| `sender_events` | `kind='lifecycle', data={action:'disable', by, reason, counts}` |

Leads who already replied are untouched. They exited at the reply.

**Re-enrol with other senders** opens `enroll_preview` for the same sequences with `assignment: fresh_sender` (only a sender who has never contacted the lead). Leads start from step 1 with the new sender. The preview lists who is excluded and why (no fresh sender left, replied recently, suppressed). Nothing is enrolled until the person confirms.

Inbox: the conversations stay, marked "Sender disabled — enable to reply". Replies from prospects still arrive and still stop sequences on every other sender, through the normal reply-stop rule.

Enable: status `ok`, `auto_remove_at` cleared, auto-enrol rules and imports stay paused until someone resumes them (they were paused for a reason). Exited leads don't come back by themselves.

### 3.4 Remove

Dialog: everything from Disable, plus:

> Remove **Naman Kasliwal (LinkedIn)**?
> - The account is unlinked and its stored login is deleted
> - All conversations, contact history and report numbers stay
> - This frees one of your paid accounts
> - To use this LinkedIn again, the owner has to log in again. Its history comes back when they do
> - LinkedIn may still list our session under the owner's active sessions. They can end it there

Steps:
1. If not already disabled, run Disable (same effects, leads exit).
2. Set `removal_requested_at` and hide the sender from pickers. There's no separate "removing" status: the sender stays `disabled` until step 4.
3. `DELETE /api/v1/accounts/{unipile_account_id}`.
   - `2xx` or `404` → continue.
   - `5xx` / network error → retry hourly ×6, then alert managers ("Unipile didn't confirm the removal"). The sender stays disabled until it's confirmed. Our records never say "removed" while Unipile still has the account.
4. In one transaction:
   - `status='removed'`, `deleted_at=now()`, `removed_by`, `removed_via`.
   - Delete `private.sender_secrets` (cookies), IMAP/SMTP app passwords for mailbox senders, `private.sender_tokens` (extension). Log to `private.secret_access_log` with `fn='sender_remove'`.
   - Remove the sender from every `sequences.sender_pool`. A sequence left empty stalls with "no sender".
   - Delete auto-enrol rules that target only this sender; remove it from rules that list several.
   - Cancel import jobs running as this sender.
   - Revoke AI-reply consent and profile authority grants (`revoked_reason='sender_removed'`).
   - Close open `reconnect` tasks for it.
   - `unipile_account_id = null` (keeps the unique index free for a reconnect); the old id moves to `senders.unipile_account_id_history`.
5. Email the sender owner: "Your account was disconnected from GrowthxAI by {name}", with how to end the LinkedIn session and, for WhatsApp, how to unlink the device in WhatsApp → Linked devices.

What stays readable: conversations (read-only, "Sender removed"), lead timelines, per-lead "contacted by", every report. Report filters get **Include removed senders** (on by default for any period that includes their activity).

`removed_via` values: `app`, `owner_link`, `unipile_deleted`, `auto_after_disabled`, `trial_ended`, `workspace_deleted`, `reconcile`.

### 3.5 Erase

Workspace owner only. Typed confirmation of the sender's name. Then:

> Erase scheduled for **27 Oct, 12:15 IST**. Until then you can cancel. After that, conversations with this sender are deleted for good.

- `erase_scheduled_at = now() + 24 h`, `erase_requested_by`. If not removed yet, Remove runs now.
- F51 executes due erasures (§5.4). Cancelling clears `erase_scheduled_at`.
- An erase request from the **sender owner** (reply to our email, or the link in §4) creates a task for the workspace owner and an email to them. The workspace decides; see open question 3 on legal deadlines.

---

## 4. Owner disconnect link

Every email we send a sender owner (connection confirmation, reconnect request, AI-reply consent, profile change notice, weekly digest) carries **"Disconnect my account from GrowthxAI"**.

- Signed, single-use token, valid 30 days, bound to the sender id.
- Landing page (no login): sender name, workspace name, what will happen (§3.4 in plain words), one button.
- Runs Remove with `removed_via='owner_link'`. No re-enrol option; leads exit.
- The workspace's managers get an in-app alert and an email.
- The page also offers "Request deletion of my data", which files the §3.5 request.

---

## 5. Other flows

### 5.1 Reconnecting a removed sender (D10)

On `CREATION_SUCCESS`, F2 already fetches the own profile. Add:
1. Look for a sender in the same workspace with `status='removed'`, same `provider` and same `provider_user_id` (LinkedIn provider id, Instagram user id, WhatsApp E.164 number, mailbox address).
2. If found, the new connection is attached to the old row instead of creating a new one: new `unipile_account_id`, `status='connecting'`, `deleted_at=null`, `restored_at=now()`. The just-created placeholder row is dropped (it has no history).
3. The connect wizard shows "We found **Naman Kasliwal**'s history from before (removed 12 Sep). Restored." with a **Start fresh instead** link, which keeps them separate.
4. Warmup comes back at the old level minus one for each full 30 days away, never below 1. Quiet periods apply as for any reconnect (`outreach_allowed_from`, 72 h before profile edits).
5. AI-reply consent and profile authority must be granted again. Sequences, rules and pools are **not** restored; the user adds the sender back where they want it.

### 5.2 Duplicate connection (D11)

Unique partial index on `(workspace_id, provider, provider_user_id)` for live senders (§6.1). Connecting a profile that's already live in the workspace stops at the wizard: "This LinkedIn is already connected as **Naman Kasliwal**." The extra Unipile account just created is deleted straight away.

### 5.3 Account deleted outside the app

`account_status: DELETED` for an account we didn't remove (someone used the Unipile dashboard, or Unipile cleaned it up) → Remove with `removed_via='unipile_deleted'`, skipping the Unipile call. Managers are alerted. Today's spec sends it to `disabled`, which offers an Enable that can't work.

Webhooks that arrive for an account id we've removed are stored with `processed_at` and `error='sender_removed'`, and change nothing.

### 5.4 Erase — what is deleted and what is kept

Runs in one transaction per sender, in this order:

| Data | Erase does |
|---|---|
| Attachments in Storage for this sender's chats | Deleted (Storage API, before the transaction; listed in the job row so a retry finishes them) |
| `messages`, `chats` | Deleted |
| `ai_reply_runs`, AI drafts | Deleted |
| `tasks` with this `sender_id` | Deleted |
| `profile_snapshots`, `profile_changes`, `profile_change_readouts`, `profile_qa` | Deleted |
| `sender_events`, `sender_budgets`, `sender_budgets_hourly` | Deleted |
| `ai_reply_consent`, `profile_authority` | Deleted |
| `actions` | **Kept** with `payload = null`, `response = null` (no message text). Type, status and dates stay, so report counts don't change |
| `enrollments` | **Kept** (no personal content) |
| `lead_sender_state` | **Kept**: relation and dates, so the lead isn't treated as never contacted. `unipile_chat_id` and `invitation_id` set to null |
| `audit_log` rows about this sender | `diff = null` |
| `senders` row | Becomes a tombstone: `display_name='Erased sender'`, `public_identifier`, `provider_user_id`, `owner_email`, `owner_user_id`, `user_agent`, `proxy_ip_hint`, `schedule` cleared; `status='erased'`, `erased_at` |
| `leads` | **Untouched.** Leads belong to the workspace, not to the sender |

After erase, the profile can be connected again, but as a new sender: the tombstone has no identifier to match on.

### 5.5 Trial end and workspace deletion

- **Trial end (day 7):** every sender in the workspace is removed with `removed_via='trial_ended'` (Unipile unlinked, credentials wiped, history kept). The workspace becomes read-only.
- **Trial data deleted (30 days after expiry):** each sender is erased (§5.4), then the workspace is deleted.
- **Workspace deletion:** each live sender is removed first, so no Unipile account is left behind, then the workspace delete cascades as today. This works with the `no action` foreign keys because the whole workspace goes in one statement (§6.2).

### 5.6 Auto-remove after disable (D4)

F52 nightly:
- Disabled senders with `auto_remove_at` within 7 days and no notice sent → email managers and the sender owner: "{name} will be removed on {date}. Enable it to keep it."
- Disabled senders past `auto_remove_at` → Remove with `removed_via='auto_after_disabled'`.

### 5.7 Unipile reconciliation (cost safety net)

F52 nightly, after the above:
1. `GET /api/v1/accounts` (paged).
2. Unipile account with no sender row pointing at it → **orphan**. Typical causes: a wizard abandoned after login, a failed duplicate cleanup, a crash between steps.
3. Orphans older than 24 h are deleted in Unipile, logged in `ops.unipile_reconcile_log`, and counted on the health page.
4. Sender rows that say `ok`/`paused`/`disabled` but whose account Unipile doesn't list → treat as §5.3.

Ships report-only in phase 1 (lists, deletes nothing) and switches to cleanup in phase 4.

---

## 6. Data model

### 6.1 Columns and statuses

```sql
-- 0NN_sender_lifecycle
alter type sender_status_t add value if not exists 'removed';
alter type sender_status_t add value if not exists 'erased';

alter table senders
  add column paused_at        timestamptz,
  add column paused_by        uuid references auth.users(id),
  add column pause_resume_at  timestamptz,               -- optional auto-resume
  add column disabled_at      timestamptz,
  add column disabled_by      uuid references auth.users(id),
  add column disable_reason   text,
  add column auto_remove_after_days int not null default 30 check (auto_remove_after_days between 7 and 90),
  add column auto_remove_at   timestamptz,
  add column auto_remove_notice_at timestamptz,
  add column removal_requested_at timestamptz,
  add column removed_by       uuid references auth.users(id),
  add column removed_via      text check (removed_via in
      ('app','owner_link','unipile_deleted','auto_after_disabled','trial_ended','workspace_deleted','reconcile')),
  add column unipile_account_id_history text[] not null default '{}',
  add column restored_at      timestamptz,
  add column erase_scheduled_at timestamptz,
  add column erase_requested_by uuid references auth.users(id),
  add column erased_at        timestamptz;
-- deleted_at (existing) is the removal time.

-- One live sender per identity per workspace (D11)
create unique index senders_one_live_identity
  on senders(workspace_id, provider, provider_user_id)
  where provider_user_id is not null and status not in ('removed','erased');

create index on senders(status, auto_remove_at) where status = 'disabled';
create index on senders(erase_scheduled_at) where erase_scheduled_at is not null and erased_at is null;

create table private.sender_owner_links (
  token_sha256 text primary key,
  sender_id    uuid not null references senders(id),
  purpose      text not null check (purpose in ('disconnect','erase_request')),
  expires_at   timestamptz not null,
  used_at      timestamptz,
  used_ip      inet,
  created_at   timestamptz not null default now()
);

create table ops.unipile_reconcile_log (
  id bigserial primary key,
  run_at timestamptz not null default now(),
  unipile_account_id text not null,
  finding text not null check (finding in ('orphan','missing_in_unipile')),
  action  text not null check (action in ('reported','deleted','sender_marked_removed')),
  sender_id uuid
);
```

### 6.2 Foreign keys: stop the cascade (D3)

Every foreign key that points at `senders(id)` changes from `on delete cascade` to `on delete no action`. `no action` is checked at the end of the statement, so deleting a whole workspace (which cascades to senders and to their children in the same statement) still works, while deleting one sender row with history fails.

```sql
do $$
declare r record;
begin
  for r in
    select c.conname, c.conrelid::regclass as tbl, a.attname as col
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
    where c.contype = 'f' and c.confrelid = 'senders'::regclass and c.confdeltype = 'c'
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
    execute format('alter table %s add constraint %I foreign key (%I) references senders(id) on delete no action',
                   r.tbl, r.conname, r.col);
  end loop;
end $$;
```

This covers today's tables (`chats`, `actions`, `enrollments`, `lead_sender_state`, `sender_events`, `sender_budgets`, `sender_budgets_hourly`, `tasks`, `private.sender_secrets`, `ai_reply_runs`, `ai_reply_consent`, `profile_*`) and any added since. A CI check fails the build if a new migration adds `on delete cascade` to `senders`.

`messages → chats` stays `cascade`: erase deletes chats on purpose.

### 6.3 SQL functions

All `security definer`, called by F13 and the workers, each writing `sender_events(kind='lifecycle')` and `audit_log`.

| Function | Does |
|---|---|
| `sender_lifecycle_preview(sender, action)` | Counts for the dialog: queued actions, live enrolments by sequence, sequences left without an `ok` sender, rules, imports, scheduled AI runs, queued profile changes |
| `sender_pause(sender, resume_at?)` / `sender_resume(sender)` | §3.2 |
| `sender_disable(sender, reason)` / `sender_enable(sender)` | §3.3, one transaction |
| `sender_remove_begin(sender, via)` | Disable if needed, set `removal_requested_at` |
| `sender_remove_finish(sender)` | §3.4 step 4, called only after Unipile confirmed |
| `sender_erase_schedule(sender)` / `sender_erase_cancel(sender)` | §3.5 |
| `sender_erase_execute(sender)` | §5.4 table rows, in that order |
| `sender_restore_match(workspace, provider, provider_user_id)` | §5.1 lookup |

Status changes go through `sender_transition(sender, from, to)` with compare-and-set, so a webhook and a user can't race.

---

## 7. Functions

### 7.1 Changed

**F13 `sender-disable` → `sender-lifecycle`**
- `POST {sender_id, action: 'preview'|'pause'|'resume'|'disable'|'enable'|'remove'|'erase_schedule'|'erase_cancel', reason?, resume_at?, reenrol?: boolean}`
- Role check: manager+ for everything except `erase_*` (owner).
- `remove` calls `sender_remove_begin`, then Unipile `DELETE`, then `sender_remove_finish`; on Unipile failure returns `202 {state:'removal_pending'}` and F52 retries.
- `disable` with `reenrol: true` returns the `enroll_preview` payload for the client to show.

**F2 `process-inbound`**
- `account_status: DELETED` → if `removal_requested_at` is set, `sender_remove_finish`; otherwise §5.3.
- `CREATION_SUCCESS` → §5.1 restore match and §5.2 duplicate check before the onboarding gate.
- Any event for a removed or erased sender → stored, ignored.
- Messages for a `paused` or `disabled` sender are processed normally (inbox, reply-stop on other senders).

**F3 `worker-tick` / F4 `worker-planner`** — no logic change (they skip anything not `ok`). Planner adds the backlog-spreading rule on resume (§3.2).

**F15 `send-reply`** — allowed when the sender is `ok` or `paused`.

**AI replies (F32/F33)** — a run for a sender that isn't `ok` becomes `draft_ready`; on disable or remove, scheduled runs are cancelled.

**Billing sync** — paid accounts in use = senders with status in `connecting, ok, credentials, error, paused, disabled`. `removed` and `erased` don't count. The connect wizard blocks a new account when every paid slot is used and points to removing one or adding an account to the plan.

### 7.2 New

| Fn | Trigger | Purpose |
|---|---|---|
| F51 `worker-sender-erase` | cron every 15 min | Run due erasures: Storage deletes, then `sender_erase_execute`. Idempotent; a half-done Storage delete is finished on the next run |
| F52 `worker-sender-housekeeping` | cron nightly (02:30 UTC) | Auto-remove notices and removals (§5.6), Unipile removal retries, reconciliation (§5.7), pause auto-resume |
| F53 `sender-owner-link` | HTTP, no login | Owner disconnect and erase-request pages (§4) |

```sql
select cron.schedule('sender-erase',        '*/15 * * * *', $$select ops.invoke('worker-sender-erase')$$);
select cron.schedule('sender-housekeeping', '30 2 * * *',   $$select ops.invoke('worker-sender-housekeeping')$$);
```

---

## 8. UI

### 8.1 Senders list
- Filter chips: **Active · Paused · Disabled · Removed**. Removed are hidden from the default view.
- Row badges: "Paused until 2 Nov", "Disabled — removed in 12 days", "Removal pending" (Unipile not confirmed yet), "Erase scheduled 27 Oct 12:15".
- Plan usage line: "7 of 10 accounts used · 1 disabled (still uses a slot)".

### 8.2 Sender page → Account section
Replaces today's "Danger" tab:

| Button | Shown when | Style |
|---|---|---|
| Pause / Resume | ok / paused | Normal |
| Disable / Enable | ok, paused / disabled | Normal |
| Remove | not removed | Destructive, dialog §3.4 |
| Erase… | owner, any status except erased | Destructive, typed name, dialog §3.5 |
| Reconnect | removed | Starts the connect wizard for this sender (restores history, §5.1) |

Every dialog shows the counts from `sender_lifecycle_preview` before the button is enabled.

### 8.3 Elsewhere
- **Inbox:** conversation banner per state: "Sender paused — replies still go out" · "Sender disabled — enable to reply" · "Sender removed — read only". Erased conversations no longer exist.
- **Sequences:** pool picker shows paused/disabled senders greyed with the reason; removed senders aren't listed. A sequence with no `ok` sender shows "Not sending: no active sender".
- **Reports:** removed senders as "Name (removed)", erased as "Erased sender"; **Include removed senders** toggle.
- **Lead timeline:** touches from a removed sender keep their sender name with "(removed)".

---

## 9. MCP

- `senders_list` / `sender_get` return the new statuses and `auto_remove_at`, `erase_scheduled_at`; `senders_list` hides removed unless `include_removed: true`.
- `why_not_sending` adds causes `E_SENDER_PAUSED`, `E_SENDER_DISABLED`, `E_SENDER_REMOVED`, `E_POOL_NO_ACTIVE_SENDER`.
- New, confirmation-gated, manager+, not for unattended tokens: `sender_pause`, `sender_resume`.
- Disable, remove and erase stay **app-only**, as the MCP PRD already rules for connecting and disconnecting senders: ending someone's account connection is a human act.

---

## 10. Edge cases

| Case | Behaviour |
|---|---|
| Action already sent to Unipile when Disable runs | It finishes; result recorded; nothing new starts |
| Disable the only sender of an active sequence | Dialog warns; sequence stalls with "no active sender"; existing stall alert fires |
| Prospect replies to a disabled sender | Message syncs, shows in the inbox, stops their sequences on other senders. Can't be answered until enabled |
| Prospect replies to a removed sender | Unipile no longer delivers it. It reaches the person's own LinkedIn/WhatsApp/mailbox only |
| Unipile `DELETE` returns 404 | Already gone; treated as success |
| Unipile `DELETE` fails | Sender stays disabled, "Removal pending", hourly retry ×6, then manager alert |
| Account deleted in the Unipile dashboard | §5.3: removed, history kept, managers alerted |
| Same LinkedIn reconnected after removal | §5.1: history restored, or "Start fresh" |
| Same LinkedIn connected twice while live | §5.2: blocked, extra Unipile account deleted |
| Owner uses the disconnect link while an agency sequence runs | Removed immediately; leads exit; agency alerted |
| Erase cancelled with 5 minutes left | Cancelled; nothing deleted |
| Erase job crashes halfway through Storage deletes | Next run finishes them; the transaction for rows runs only after Storage is done |
| Pause with auto-resume during a weekend | Resumes at the time set; planner places backlog inside working windows only |
| Disabled for 30 days | Notice at day 23, removed on day 30 |
| Trial ends with a sequence running | Senders removed, workspace read-only, history visible for 30 days |
| Someone tries `delete from senders` in SQL | Fails while history exists (`no action` FK). Only `sender_erase_execute` empties it first |
| Mailbox sender (IMAP app password) removed | App password wiped; same flow without the Unipile call for non-Unipile mailboxes |
| WhatsApp sender removed | Unipile unlinked; owner email explains WhatsApp → Linked devices → log out |

---

## 11. Rollout

| Phase | Contents | Risk |
|---|---|---|
| **1** | Migration: statuses, columns, unique live-identity index, FK change, CI check. Reconciliation in report-only mode. `DELETED` → removed | None for users; the FK change blocks accidental deletes from day one |
| **2** | Pause (with manual replies), Disable/Enable with the preview dialog and re-enrol option, inbox banners, sequence pool states | Low |
| **3** | Remove (two-step with Unipile), credential wipe, reconnect restore, duplicate block, owner disconnect link, trial-end and workspace-delete hooks, plan slot counting | Medium: test on own senders first |
| **4** | Erase with 24 h schedule, auto-remove after 30 days disabled, reconciliation cleanup on, MCP pause/resume | Medium: erase is irreversible, ship last |

Before phase 3 on real accounts, test on one internal LinkedIn sender of each login type (credentials, cookies) whether Unipile's delete also ends the session on LinkedIn's side and whether the owner's own browser stays logged in (open question 1).

---

## 12. Tests

- **Schema:** deleting a sender with a chat fails; deleting its workspace succeeds and leaves nothing behind; a migration adding `on delete cascade` to `senders` fails CI.
- **Disable:** counts in the preview equal the rows changed; in-flight action completes; enrolments exit; stalled sequence alert fires; enable doesn't revive exited leads.
- **Pause:** manual reply sends; no automated action runs; backlog after a 5-day pause is spread within caps.
- **Remove:** Unipile 2xx / 404 / 5xx paths; secrets and extension token gone; pools, rules, imports cleaned; reports for last month unchanged before and after.
- **Restore:** reconnect same profile → same sender id, history visible, warmup level per §5.1; "Start fresh" keeps them separate.
- **Duplicate:** second live connection blocked and its Unipile account deleted.
- **Erase:** scheduled, cancelled, executed; report totals unchanged; lead still counts as contacted; no message text left in `actions`, `audit_log` or Storage.
- **Owner link:** single use, expiry, works without login, alerts managers.
- **Reconcile:** orphan reported (phase 1) then deleted (phase 4); missing-in-Unipile sender handled as §5.3.

---

## 13. Open questions

1. **Does Unipile's delete end the provider session?** For LinkedIn credentials logins the session shows under the owner's active sessions; for cookie logins it's shared with their browser. Confirm both before telling users what happens on LinkedIn's side.
2. **Same profile in two workspaces** (an agency and the client both connecting one LinkedIn). D11 only covers one workspace. Leaning: warn at connect time, don't block, since workspaces can't see each other.
3. **Erase requests from the sender owner.** Under GDPR the controller usually has one month to answer an erasure request; the DPDP Act has its own rules. Who is the controller for an agency's client's employee's LinkedIn conversations (the agency, the client, or us as processor)? Needs legal input before phase 4; until then the request goes to the workspace owner as a task.
4. **Auto-remove default.** 30 days balances late replies against Unipile cost. Revisit once there's data on how late replies to disabled senders actually arrive.
5. **Prepaid slots.** When a removed account frees a slot mid-period, can the customer use it for a different account immediately? Leaning yes, since we pay Unipile on peak simultaneous accounts, so a swap doesn't raise our cost.
