# PRD: Sender lifecycle — pause, disable, remove, erase, disconnect alerts, payment failure

**Document:** Change PRD — what happens to a sender account (LinkedIn, mailbox, Instagram, WhatsApp) when it is paused, disabled, removed or erased; who is told when it disconnects; and what happens to a workspace's accounts and data when a payment fails
**Version:** 1.2 · 26 October 2026 — emails about an account go to the signed-in user's own email by default; the required "Owner email" field is replaced by an optional "Whose account is this?" (D13, §5.8.1)
**v1.1:** added disconnect alerts (§5.8), payment failure and suspension (§5.9), cancellation (§5.10); `billing_status` replaces `plan='suspended'` (D17)
**Applies to:** the app as built, per `linkedin-outreach-platform-PRD.md` (FR-SN-05, FR-SN-11, F2 `process-inbound`, F6 `worker-reconnect`, F13 `sender-disable`, F24 `stripe-webhook`, §15 Billing, schema §7), `instagram-whatsapp-channels-PRD.md`, `linkedin-profile-management-PRD.md`, AI replies, `custom-sending-domain-PRD.md` (all emails go through `sendEmail`), `reply-notifications-PRD.md` (team notification preferences), `health-page-PRD.md` (platform-wide disconnect alert), and the Oct 2026 pricing (prepaid per-account plans, monthly / quarterly / annual, no refunds, 7-day trial with one sender, trial data kept 30 days).
**Replaces:** FR-SN-11, the `DELETED → disabled` row of the `account_status` handler, platform PRD §15's `plan='suspended'` rule, and the connect wizard's free-text `owner_email` input (platform F10).
**Migration:** `0NN_sender_lifecycle` (next free number). **New functions:** F51, F52, F53, F60, F61. **Changed:** F2, F3, F4, F6, F10, F13, F24, F32/F33 (AI replies), `sendEmail`, billing sync, RLS write policies.
**Also changes (v1.2):** AI replies §4.1 and profile management §4.2: for a member's own account, consent and profile authority are granted in the app (`owner_is_operator`), with no email. `custom-sending-domain-PRD.md` §3: the "owner" audience becomes "holder" (§5.8.1).
**Names:** tables and columns follow the specs. The build prefixes tables with `outreach_`; adjust.
**Checked:** Unipile API reference — Delete an account, Account status webhook (`DELETED`), pricing (billed on peak linked accounts per period); Stripe Billing — subscription statuses, invoice webhooks, Smart Retries, hosted invoice page; 26 Oct 2026.

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
| 8 | When an account belongs to someone outside the team, that person can always disconnect it themselves from a link in their email, without logging in |
| 9 | A nightly check deletes Unipile accounts nobody is using, so the platform doesn't pay for them |
| 10 | **Disconnects:** a sign-in email goes out first, to whoever signs in to the account. If it's still down 4 hours later, the workspace's owners and managers get one email listing every disconnected account. Many accounts dropping at once triggers an immediate "likely an outage" email instead |
| 11 | **Every email goes to the main account email**: the email the user signed up and signs in with. Nobody types an address for their own accounts. The connect wizard asks only **"Whose account is this?"**: *Mine* (default) or *Someone else's*, with their email. For someone else's account, only sign-in links, permission requests, profile-change notices and disconnect notices go to that person, and the user who connected it is copied |
| 12 | **Payment failed:** emails on day 0, 3 and 6; read-only on day 7; accounts disconnected on day 21 (history kept); data deleted on day 67. Warnings 7 days before each step. Paying at any point before deletion brings everything back |

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
| On disconnect, F6 emails the sender's `owner_email` only | Nobody on the workspace's team is told. If a client's employee ignores the email, the account stays down unnoticed |
| `owner_email` is a free-text field in the connect wizard | Left empty, nobody gets the reconnect email. Filled in, it's a second address the user has to keep right, when they already have a sign-in email. A typo silently sends sign-in links to a stranger |
| A LinkedIn or Unipile outage disconnects many accounts at once | Every owner is emailed to reconnect, which doesn't help and can't work until the outage ends |
| Platform §15: `past_due` → banner; +7 days → `plan='suspended'`, senders paused | The app sends no billing emails; the card owner may miss Stripe's. Overwriting `plan` loses which plan to restore. Suspended workspaces keep their Unipile accounts linked forever |
| Nothing for cancellation | A cancelled workspace's accounts stay linked |

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
| **D8** | An **outside account holder** (§5.8.1) can remove their account from a link in any email we send them, without logging in. The workspace is told. Team members disconnect their own accounts in the app | It's their LinkedIn, WhatsApp or mailbox. They shouldn't have to ask an agency to let go of it |
| **D9** | Erase is scheduled 24 h ahead and can be cancelled until it runs. After it runs it can't be undone | A delete with no undo needs one last chance |
| **D10** | Reconnecting the same profile in the same workspace offers to restore the removed sender's history | One person, one sender record. History, health and warmup carry over |
| **D11** | The same profile can be live only once per workspace | Two sessions for one LinkedIn inside one workspace doubles every risk |
| **D12** | On disconnect, **whoever signs in to the account is told first**; the **team is told 4 hours later** if it's still down, in one email per workspace listing every such account, then at most once a day | Automatic reconnects and quick fixes sort out most drops within hours. One combined email beats a stream of them |
| **D13** | **All email goes to users' sign-in emails** (`auth.users.email`, read at send time, never copied). There is no "owner email" to type for your own account. The wizard asks **"Whose account is this?"**: *Mine* (default) or *Someone else's: [email]*. Only four kinds of email ever go to that outside address: sign-in links, permission requests, profile-change notices and disconnect notices, each copied to the member who connected it | The user already has an email they sign in with; a second one to maintain only goes stale or gets typed wrong. An outside person needs the sign-in link and a say over their own account, nothing else |
| **D14** | When several accounts drop together, sign-in emails are **held** and the team gets one "likely an outage" email | Asking ten people to reconnect during a LinkedIn or Unipile incident wastes their time and doesn't work |
| **D15** | Payment failure follows a fixed clock from the **first failed charge**, not Stripe's retry schedule: read-only on day 7, accounts removed on day 21, data erased on day 67 | Customers get the same, predictable dates whatever Stripe's retry settings are |
| **D16** | Billing emails go to the workspace's owners and billing contacts, from the platform domain, and can't be turned off | The person who entered the card is often not the person running outreach |
| **D17** | Billing state moves to `workspaces.billing_status`; `plan` keeps the plan name | Overwriting `plan` with `'suspended'` forgets which plan to restore |
| **D18** | While suspended, nothing can be sent, edited or enrolled, but everything can be read and exported, and prospects' replies keep arriving until the accounts are removed | Customers keep access to their data, and have a reason to come back |

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
| Who | Manager+ | Manager+ | Manager+, or an outside holder by link (§4) | Workspace owner |

### 3.2 Pause

What happens:
- `senders.status = 'paused'`, `paused_by`, `paused_at`, optional `paused_until` (auto-resume).
- The planner and tick skip the sender (they already skip anything not `ok`). Queued actions stay queued.
- AI replies: no autopilot sends from this sender; scheduled runs drop back to draft. Drafts keep appearing.
- Timers keep running. Actions that fall due during the pause wait, and on resume the planner spreads them over the next days within the normal daily caps — never a burst on the first morning.
- `wait_connection` and other time-based branches don't fire their actions until resume; acceptances still arrive, because the connection is live.
- Manual replies work (D5): compose is enabled when the sender is `ok` **or** `paused` — except when `pause_reason='billing'` (§5.9), where the workspace is read-only.

`pause_reason` is `manual` (a person paused it) or `billing` (§5.9). Resume on a billing pause is only possible by paying; the button shows "Update payment" instead.

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
> - To use this LinkedIn again, whoever signs in to it has to log in again. Its history comes back when they do
> - LinkedIn may still list our session under the account's active sessions. It can be ended there

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
5. `sender_removed_notice` to the account holder (§5.8.1): "Your account was disconnected from GrowthxAI by {name}", with how to end the LinkedIn session and, for WhatsApp, how to unlink the device in WhatsApp → Linked devices. Skipped when the holder is the member who just removed it.

What stays readable: conversations (read-only, "Sender removed"), lead timelines, per-lead "contacted by", every report. Report filters get **Include removed senders** (on by default for any period that includes their activity).

`removed_via` values: `app`, `owner_link`, `unipile_deleted`, `auto_after_disabled`, `trial_ended`, `workspace_deleted`, `reconcile`.

### 3.5 Erase

Workspace owner only. Typed confirmation of the sender's name. Then:

> Erase scheduled for **27 Oct, 12:15 IST**. Until then you can cancel. After that, conversations with this sender are deleted for good.

- `erase_scheduled_at = now() + 24 h`, `erase_requested_by`. If not removed yet, Remove runs now.
- F51 executes due erasures (§5.4). Cancelling clears `erase_scheduled_at`.
- An erase request from an **outside account holder** (reply to our email, or the link in §4) creates a task for the workspace owner and an email to them. The workspace decides; see open question 3 on legal deadlines.

---

## 4. Disconnect link for outside account holders

Only for accounts marked **Someone else's** (§5.8.1). Every holder email we send that person (connection confirmation, sign-in link, permission request, profile-change notice, disconnect notice) carries **"Disconnect my account from GrowthxAI"**.

- Signed, single-use token, valid 30 days, bound to the sender id **and the holder address it was sent to**. Changing the holder cancels open links.
- Landing page (no login): sender name, workspace name, what will happen (§3.4 in plain words), one button.
- Runs Remove with `removed_via='owner_link'`. No re-enrol option; leads exit.
- The member who connected it and the workspace's managers get an in-app alert and an email.
- The page also offers "Request deletion of my data", which files the §3.5 request.

A member's own account (**Mine**) doesn't get this link: its emails go to their sign-in email, and they disconnect it from the sender page. Their holder emails carry **Open in GrowthxAI** instead.

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
- Disabled senders with `auto_remove_at` within 7 days and no notice sent → email managers and the account holder (§5.8.1; `sender_auto_remove_notice`): "{name} will be removed on {date}. Enable it to keep it."
- Disabled senders past `auto_remove_at` → Remove with `removed_via='auto_after_disabled'`.

### 5.7 Unipile reconciliation (cost safety net)

F52 nightly, after the above:
1. `GET /api/v1/accounts` (paged).
2. Unipile account with no sender row pointing at it → **orphan**. Typical causes: a wizard abandoned after login, a failed duplicate cleanup, a crash between steps.
3. Orphans older than 24 h are deleted in Unipile, logged in `ops.unipile_reconcile_log`, and counted on the health page.
4. Sender rows that say `ok`/`paused`/`disabled` but whose account Unipile doesn't list → treat as §5.3.

Ships report-only in phase 1 (lists, deletes nothing) and switches to cleanup in phase 4.

### 5.8 Disconnect alerts (D12–D14)

A sender is **disconnected** when its status is `credentials` or `error` (platform FR-SN-05). Paused, disabled and removed senders don't count.

#### 5.8.1 Who gets emails about an account (D13)

**The main email.** Every email in this PRD goes to users' **sign-in emails**: the address on their GrowthxAI login (`auth.users.email`), looked up when the email is sent. If a user changes their login email, the next email goes to the new one. The app keeps no second address for a member.

**Connect wizard.** The "Owner email" field is removed. In its place, one question, defaulting to *Mine*:

> **Whose account is this?**
> (•) **Mine.** Emails about it go to aarushi@growthxai.com
> ( ) **Someone else's.** Their email: [__________]
>   *We'll send them the sign-in link and ask their permission before AI replies or profile changes. You're copied on everything we send them.*

| Answer | Stored | Holder emails go to | Copied |
|---|---|---|---|
| Mine | `owner_user_id = connected_by`, `owner_email = null` | The member's sign-in email | — |
| Someone else's, and the email belongs to a member of this workspace | `owner_user_id` = that member, `owner_email = null`. The wizard says "That's {name} on your team. We'll email them on their sign-in email." | That member's sign-in email | — |
| Someone else's, anyone outside the workspace | `owner_user_id = null`, `owner_email` = their address | `owner_email` | The member who connected it (`connected_by`) |

Exactly one of `owner_user_id` and `owner_email` is set (constraint in §6.1). `connected_by` is always stored.

**Holder emails.** Only these go to the account holder; everything else goes to the team (owners, managers, members by their notification preferences) on their sign-in emails:

| Kind | Emails |
|---|---|
| Sign-in links | `sender_connect_request`, `sender_reconnect_needed`, `sender_reconnect_manual` and their reminders, `sender_reconnect_after_billing` |
| Permission requests | `ai_reply_consent_request`, `profile_authority_request` |
| Profile-change notices | `profile_change_applied` (diff and revert link) |
| Disconnect notices | `sender_connected_notice` (outside holders only: "{workspace} connected your LinkedIn to GrowthxAI", with the disconnect link), `sender_removed_notice`, `sender_auto_remove_notice`, `sender_erase_notice`, `sender_removal_billing_notice` |

For an outside holder these carry the §4 disconnect link and the "on behalf of {workspace} via GrowthxAI" footer, and come from the workspace's sending domain when it has one. For a member's own account they come from the GrowthxAI domain with **Open in GrowthxAI**, like any team email.

**Permission for "Mine".** When the account is the member's own, the AI-reply consent and profile authority are granted by the member in the app (one checkbox each, at the moment they turn the feature on), with no email. The grant uses the existing `granted_via = 'owner_is_operator'` (AI replies §4.1, profile management §4.2), with `granted_by_email` = the member's sign-in email. For an outside holder, the email request (`granted_via = 'signed_link'`) is the only way to grant; the member who connected the account can't grant on their behalf.

**When the holder or connector leaves.** A member who leaves the workspace, or whose user is deleted:
- Accounts they held (`owner_user_id`) send holder emails to `connected_by` if that's a different current member, otherwise to the workspace's owners. Each such account gets an in-app task for owners: "{name} has left. Who looks after {sender}?" Choosing a person sets `owner_user_id`; choosing *Someone else's* sets `owner_email`.
- Outside-held accounts they connected copy the workspace's owners instead.
- Their `owner_is_operator` AI-reply and profile grants are revoked (`revoked_reason='holder_left'`); the new holder grants again.

**Changing it later.** Sender page → **Whose account** → *Change* (manager+, or the current member holder). Every change:
- cancels open sign-in, permission and disconnect links;
- sends the old outside address, if there was one, "You're no longer the contact for {sender} on GrowthxAI";
- revokes AI-reply and profile grants (`revoked_reason='holder_changed'`), which the new holder grants again (in the app for a member, by email for an outside holder);
- is written to `audit_log`.

A member can mark an account *Mine* only for themselves: the change sets `owner_user_id` to the person making it. No one can attach an account to another member's sign-in email except by typing that member's email under *Someone else's* (the row above), and that member gets a notice: "{name} set you as the person who signs in to {sender}."

**Existing senders.** One-off migration, before the §6.1 constraint is validated:

| Today | Becomes |
|---|---|
| `owner_user_id` set (any `owner_email`) | Keep `owner_user_id`, clear `owner_email` (the old value goes to `audit_log`) |
| No `owner_user_id`; `owner_email` matches a workspace member's sign-in email | `owner_user_id` = that member, `owner_email = null` |
| No `owner_user_id`; `owner_email` is someone outside | Keep as *Someone else's*. Listed once on the senders page: "These accounts send sign-in emails outside your team. Check they're right." |
| Neither set | `owner_user_id` = the workspace's first owner; in-app task "Who signs in to {sender}?" |

`connected_by` is unknown for senders created before this change and stays null; where a copy would go to `connected_by`, it goes to the workspace's owners.

**Resolving recipients.** Callers never pick addresses themselves. `sender_email_recipients(sender, kind)` (§6.3) returns `to`, `cc` and whether the recipient is an outside holder, and `sendEmail` uses that to choose the domain and footer.

#### 5.8.2 Timeline for one disconnected account

| When | Who | What |
|---|---|---|
| T0, login-and-password senders | Holder (§5.8.1) | `sender_reconnect_needed`: fresh sign-in link (existing F6 behaviour) |
| T0, cookie senders | — | F6 retries silently every hour, up to 4 times |
| T0 + ~4 h, cookie senders still down | Holder | `sender_reconnect_manual`: instructions to sign in again (existing) |
| T0 | Team | In-app alert and dashboard "needs attention" entry. No email yet |
| 4 h after the sign-in email, still down | Owners and managers of the workspace (and of the sender's client, if client-scoped) | `sender_disconnected_team`, combined per workspace (§5.8.3) |
| Day 1 and day 3, still down | Holder | Reminder (existing "daily reminder max 3"; now exactly two reminders after the first email) |
| Every 24 h, still down | Team | The next combined email lists it again, marked "down 2 days", until reconnected, removed or disabled |
| Day 7, still down | Team | Last combined email for that account: "Down for 7 days. Disable it to stop these emails, or remove it." No further team emails for it; it stays on the dashboard |
| Reconnected | Team | Listed once under "Back online" in the next combined email, if one goes out anyway. No email of its own |

#### 5.8.3 The team email

F60 runs every 15 minutes. For each workspace, it collects senders that:
- are still disconnected, and
- had their sign-in email sent at least 4 hours ago, and
- haven't been in a team email in the last 24 hours (and are under 7 days down).

If there are any, one `sender_disconnected_team` email goes to each owner and manager whose notification preferences allow it (`reply-notifications-PRD.md`, kind `sender_disconnected`, default on), on their sign-in email:

> **3 accounts need signing in again**
>
> | Account | Signs in | Down since | Sign-in email sent | What to do |
> |---|---|---|---|---|
> | Naman Kasliwal (LinkedIn) | Naman (team) | 25 Oct, 14:10 | 25 Oct, 14:10 · reminded 26 Oct | Ask Naman to open the email, or send a new link |
> | Avi Shah (LinkedIn) | avi@client.com (outside, copied to Priya) | 26 Oct, 09:02 | 26 Oct, 13:05 (cookie retries failed) | Ask Avi to sign in again |
> | Acme WhatsApp | You | 24 Oct | 24 Oct · reminded 25 Oct, 27 Oct | Reconnect by scanning the QR code |
>
> Sequences on these accounts are on hold until they're back. **Open senders**

Each row links to the sender page, which has **Send a new sign-in link** (re-sends the holder email and resets its reminder count).

**No double emails.** A person is shown the accounts they hold themselves only if others are in the email too; if every account in their email is one they already got the sign-in email for, they get no team email. A solo user with their own accounts therefore gets the sign-in email and its two reminders, not a team email on top.

#### 5.8.4 Many accounts at once (D14)

Two levels:

| Scope | Trigger | Effect |
|---|---|---|
| Workspace | At least 3 senders, and at least 30% of the workspace's live senders, became disconnected within 60 minutes | Immediate `sender_mass_disconnect` to owners and managers (can't be turned off): "{n} accounts disconnected within an hour. This is usually a LinkedIn or Unipile problem, not your accounts. We're holding the sign-in emails for 2 hours." Sign-in emails for those senders wait 2 hours; F6 cookie retries continue. If they reconnect by themselves, nobody gets a sign-in email |
| Platform | More than 10% of all live senders across the platform disconnected within 60 minutes (the health page alert) | All sign-in emails held for 2 hours; platform admins alerted. Workspaces get the workspace email above only if their own threshold is also met |

After the hold, any sender still down follows §5.8.2 from the sign-in email onwards. A hold is extended by 2 hours at most once, by a platform admin from the health page.

#### 5.8.5 What a disconnect does to sending
Unchanged from the platform spec: the planner and tick skip senders that aren't `ok`, queued actions wait, and the planner spreads the backlog after reconnection. A disconnect is not a Disable: leads stay in their sequences.

### 5.9 Payment failure and suspension (D15–D18)

#### 5.9.1 Billing status

`workspaces.billing_status`: `trialing` · `active` · `past_due` · `suspended` · `canceled`. The plan name stays in `workspaces.plan`. RLS write policies check `billing_status in ('trialing','active','past_due')` instead of `plan <> 'suspended'`.

Stripe events handled by F24:

| Stripe event | Effect |
|---|---|
| `invoice.payment_failed` on a subscription invoice, workspace `active` | `billing_status='past_due'`, `past_due_since=now()` (first failure only), store `hosted_invoice_url`. Day-0 email |
| `invoice.payment_failed` again while `past_due` or `suspended` | Store the latest invoice URL. No new email (the schedule below handles reminders) |
| `invoice.payment_action_required` | `billing_action_required=true`; email "Confirm your payment" with the hosted invoice link (cards that need the bank's approval for recurring charges, common with Indian cards). Doesn't start the clock if the invoice isn't failed yet |
| `invoice.paid` for the overdue invoice | Reactivate (§5.9.4) |
| `customer.subscription.updated` → `active` | Reactivate if not already |
| `customer.subscription.deleted` | Cancellation (§5.10) |

Stripe settings (Billing → Revenue recovery): Smart Retries on; Stripe's own customer emails for failed payments on; after all retries fail, **mark the subscription as unpaid** (not cancel), so the account isn't cancelled behind the app's back. The app's clock (D15) decides suspension, removal and erasure, whatever Stripe's retry count.

#### 5.9.2 Timeline

Days count from `past_due_since`. F61 runs hourly and acts on the workspace's timezone at 10:00 local for emails, so they don't arrive at 3 a.m.

| Day | State | What happens | Email (owners + billing contacts) |
|---|---|---|---|
| 0 | `past_due` | Everything runs. Banner for owners and managers: "Your payment failed. Update your card to avoid interruption." Members see nothing | `billing_payment_failed` — amount, card ending, reason from Stripe, **Pay invoice** (hosted invoice link, works without login) and **Update card** (billing page) |
| 3 | `past_due` | Same | `billing_reminder` |
| 6 | `past_due` | Banner turns red for everyone: "Sending stops tomorrow." | `billing_suspension_tomorrow` |
| 7 | **`suspended`** | Every live sender paused with `pause_reason='billing'`. Sequences, AI replies, imports, auto-enrol rules and profile edits stop. Read-only for everyone: inbox, leads, reports and exports stay available; no sending, editing or enrolling (D18). Prospects' replies keep syncing and still stop sequences. Custom sending domains pause (`paused_reason='plan'`) | `billing_suspended` — "Your workspace is paused. Replies keep arriving; pay to answer them." |
| 14 | `suspended` | — | `billing_removal_warning` — "Your connected accounts will be disconnected on {day 21}. Your history is kept." Also `sender_removal_billing_notice` to each account's holder (§5.8.1) who doesn't already get the billing emails: an outside holder gets "{agency}'s workspace is paused; your account will be disconnected on {date}", a member gets "Your LinkedIn {name} will be disconnected on {date} because of a billing issue. Ask {owner name} to update payment." |
| 21 | `suspended` | Every sender **removed** (§3.4) with `removed_via='billing'`: Unipile unlinked, credentials wiped, history kept. Replies stop arriving | `billing_accounts_removed` |
| 60 | `suspended` | — | `billing_deletion_warning` — "Your workspace data will be deleted on {day 67}. Pay or export before then." Includes **Export everything** |
| 67 | `canceled` | Each sender erased (§5.4), then the workspace deleted (§5.5). Stripe subscription cancelled | `billing_data_deleted` (to the owners' addresses captured before deletion) |

Billing contacts: `workspaces.billing_emails citext[]` (Settings → Billing → "Also send billing emails to"), plus the Stripe customer's email if different. Duplicates removed.

#### 5.9.3 What each role sees while suspended
- **Owners:** full-screen notice on login with **Pay invoice**, **Update card**, **Export data**; the app behind it read-only.
- **Managers and members:** read-only app with a banner "This workspace is paused because of billing. Ask {owner name} to update payment."
- **Client viewers:** read-only, no billing details: "This workspace is temporarily paused."
- **MCP:** read tools work; every write returns `E_BILLING_SUSPENDED` with remedy "The workspace owner needs to update payment."

#### 5.9.4 Reactivation (payment at any point before day 67)
1. `billing_status='active'`, `past_due_since=null`.
2. Senders with `pause_reason='billing'` resume; the planner spreads any backlog over the next days within caps (§3.2).
3. Custom sending domains with `paused_reason='plan'` resume.
4. Senders removed on day 21: each account's holder (§5.8.1) gets `sender_reconnect_after_billing` with a sign-in link; reconnecting restores their history (§5.1). Their sequences pools must be re-added by the team; the reactivation email lists them.
5. Email to owners and billing contacts: `billing_reactivated`, listing anything that needs a person (accounts to reconnect, sequences without senders).

A partial payment or a new card without paying the invoice doesn't reactivate. Only `invoice.paid` for the overdue invoice (or the subscription going `active`) does.

### 5.10 Cancellation

The customer cancels in the billing page (no refunds; access runs to the end of the paid period).
- Until the period ends: everything works; banner "Your plan ends on {date}."
- At period end (`customer.subscription.deleted`): `billing_status='canceled'`, all senders **removed** immediately (they'd only cost money), read-only access to inbox, leads, reports and exports for **60 days**, then erase and delete as day 67 above, with the same warning email 7 days before.
- Resubscribing within the 60 days restores the workspace; owners reconnect accounts and get their history back (§5.1).
- Trial expiry keeps its own rule (§5.5: removed at day 7, data deleted 30 days later).

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
  add column pause_reason     text check (pause_reason in ('manual','billing')),
  add column pause_resume_at  timestamptz,               -- optional auto-resume
  add column connected_by     uuid references auth.users(id),
  add column disconnected_at  timestamptz,               -- entered credentials/error; cleared on ok
  add column holder_notified_at timestamptz,             -- first sign-in email for this disconnect
  add column holder_reminders_sent smallint not null default 0,
  add column holder_email_held_until timestamptz,        -- §5.8.4 hold
  add column team_notified_at timestamptz,               -- last combined team email that listed it
  add column disabled_at      timestamptz,
  add column disabled_by      uuid references auth.users(id),
  add column disable_reason   text,
  add column auto_remove_after_days int not null default 30 check (auto_remove_after_days between 7 and 90),
  add column auto_remove_at   timestamptz,
  add column auto_remove_notice_at timestamptz,
  add column removal_requested_at timestamptz,
  add column removed_by       uuid references auth.users(id),
  add column removed_via      text check (removed_via in
      ('app','owner_link','unipile_deleted','auto_after_disabled','trial_ended','workspace_deleted','reconcile',
       'billing','canceled')),
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
create index on senders(workspace_id, disconnected_at) where status in ('credentials','error');

-- Whose account is this (D13, §5.8.1). Uses the platform's existing columns:
--   owner_user_id set, owner_email null  → a member's account; emails go to their sign-in email
--   owner_user_id null, owner_email set  → someone outside the workspace; holder emails only, connected_by copied
alter table senders
  add constraint senders_one_holder check (
    status = 'erased'
    or (owner_user_id is not null and owner_email is null)
    or (owner_user_id is null and owner_email is not null)
  ) not valid;
-- Run the §5.8.1 migration of existing senders, then:
alter table senders validate constraint senders_one_holder;

-- AI-reply and profile grants: no new column. A member holder's in-app grant uses the existing
-- granted_via = 'owner_is_operator' with granted_by_email = their sign-in email at the time;
-- an outside holder's uses granted_via = 'signed_link'.
-- revoked_reason gains 'holder_left' and 'holder_changed' in ai_reply_consent and profile_authority.

-- Billing state (D17)
alter table workspaces
  add column billing_status text not null default 'active'
      check (billing_status in ('trialing','active','past_due','suspended','canceled')),
  add column past_due_since    timestamptz,
  add column suspended_at      timestamptz,
  add column billing_action_required boolean not null default false,
  add column overdue_invoice_id text,
  add column overdue_invoice_url text,               -- Stripe hosted invoice page
  add column billing_emails    citext[] not null default '{}',
  add column canceled_at       timestamptz,
  add column data_delete_at    timestamptz;           -- day 67, or canceled_at + 60 days
-- Workspaces currently stored as plan = 'suspended': set billing_status = 'suspended',
-- then set plan from the Stripe subscription's price (one-off script, run before the RLS change).
-- RLS write policies: replace "plan <> 'suspended'" with
--   billing_status in ('trialing','active','past_due')

-- Each billing step runs once per overdue period
create table ops.billing_steps (
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  past_due_since timestamptz not null,
  step          text not null check (step in ('d0','d3','d6','suspend','d14','remove','d60','erase',
                                              'cancel_remove','cancel_d53','cancel_erase','reactivated')),
  done_at       timestamptz not null default now(),
  primary key (workspace_id, past_due_since, step)
);

-- Disconnect holds (§5.8.4)
create table ops.disconnect_holds (
  id          bigserial primary key,
  scope       text not null check (scope in ('workspace','platform')),
  workspace_id uuid,
  started_at  timestamptz not null default now(),
  held_until  timestamptz not null,
  extended    boolean not null default false,
  sender_count int not null
);

create table private.sender_owner_links (
  token_sha256 text primary key,
  sender_id    uuid not null references senders(id),
  purpose      text not null check (purpose in ('disconnect','erase_request')),
  sent_to      citext not null,          -- the outside holder address; link dies if owner_email changes
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
| `sender_mark_disconnected(sender)` / `sender_mark_reconnected(sender)` | Sets / clears `disconnected_at`, `holder_notified_at`, `holder_reminders_sent`, `team_notified_at`; checks §5.8.4 thresholds and opens a hold |
| `sender_email_recipients(sender, kind)` | `kind` = `holder` or `team`. **holder:** member-held → `to` = that member's current `auth.users.email`, `outside=false`; outside-held → `to` = `owner_email`, `cc` = `connected_by`'s sign-in email (or the workspace owners' if `connected_by` is null or has left), `outside=true` (the copy is sent as a separate email marked "Copy", not a Cc header, so the disconnect link stays the holder's); member holder who has left → `to` = `connected_by` or the workspace owners. **team:** owners/managers (and client managers for client-scoped senders) by notification preference, sign-in emails only. Read at send time; nothing is cached |
| `sender_set_holder(sender, holder)` | `holder` = `{mine: true}` or `{email}`. Resolves a member email to `owner_user_id`; enforces "Mine only for yourself"; cancels links, revokes grants, sends the old-address notice, writes `audit_log` (§5.8.1) |
| `workspace_billing_step(workspace, step)` | Runs one §5.9.2 step once (insert into `ops.billing_steps`, then the effect); returns false if already done |
| `workspace_suspend(workspace)` / `workspace_reactivate(workspace)` | §5.9.2 day 7 / §5.9.4 |

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

**F15 `send-reply`** — allowed when the sender is `ok` or `paused` with `pause_reason='manual'`, and the workspace isn't suspended.

**F6 `worker-reconnect`** — calls `sender_mark_disconnected` when a sender enters `credentials` or `error`; sends sign-in emails through `sendEmail` to `sender_email_recipients(sender,'holder')`, only when no hold applies (§5.8.4); sends exactly two reminders (day 1, day 3); `sender_mark_reconnected` on `OK` / `RECONNECTED`. No longer reads `owner_email` directly.

**F24 `stripe-webhook`** — handles the events in §5.9.1; never changes `plan`; writes `billing_status`, `past_due_since`, invoice fields; on `invoice.paid` for the overdue invoice calls `workspace_reactivate`.

**Connect wizard (F10)** — input `owner_email?` is replaced by `holder?: {mine: true} | {email}` (default `{mine: true}`); the "Owner email" field is replaced by **Whose account is this?** (§5.8.1); `connected_by` always stored. For *Someone else's* with an outside email, sends `sender_connected_notice` once the account is `ok`. The invite flow (`sender_connect_request`, platform US-01) sets the holder to the invited address.

**Every caller of `sendEmail` for a sender-related email** — passes `sender_id` and the email type; `sendEmail` calls `sender_email_recipients` for the type's audience (`custom-sending-domain-PRD.md` §3) and refuses an explicit address for `holder` emails, so no code path can send to a stale or typed address.

**AI replies (F32/F33)** — a run for a sender that isn't `ok` becomes `draft_ready`; on disable or remove, scheduled runs are cancelled.

**Billing sync** — paid accounts in use = senders with status in `connecting, ok, credentials, error, paused, disabled`. `removed` and `erased` don't count. The connect wizard blocks a new account when every paid slot is used and points to removing one or adding an account to the plan.

### 7.2 New

| Fn | Trigger | Purpose |
|---|---|---|
| F51 `worker-sender-erase` | cron every 15 min | Run due erasures: Storage deletes, then `sender_erase_execute`. Idempotent; a half-done Storage delete is finished on the next run |
| F52 `worker-sender-housekeeping` | cron nightly (02:30 UTC) | Auto-remove notices and removals (§5.6), Unipile removal retries, reconciliation (§5.7), pause auto-resume |
| F53 `sender-owner-link` | HTTP, no login | Outside holder's disconnect and erase-request pages (§4) |
| F60 `worker-account-alerts` | cron every 15 min | §5.8: sign-in reminders, combined team emails (with the no-double-email rule), mass-disconnect detection and holds, releasing holds |
| F61 `worker-billing` | cron hourly | §5.9.2 and §5.10: for each `past_due`, `suspended` or `canceled` workspace, run every step that's due (emails at 10:00 workspace time); each step once via `ops.billing_steps` |

```sql
select cron.schedule('sender-erase',        '*/15 * * * *', $$select ops.invoke('worker-sender-erase')$$);
select cron.schedule('sender-housekeeping', '30 2 * * *',   $$select ops.invoke('worker-sender-housekeeping')$$);
select cron.schedule('account-alerts',      '*/15 * * * *', $$select ops.invoke('worker-account-alerts')$$);
select cron.schedule('billing',             '5 * * * *',    $$select ops.invoke('worker-billing')$$);
```

### 7.3 Emails added by this PRD

Added to the catalogue in `custom-sending-domain-PRD.md` §3. All go through `sendEmail` with an idempotency key of `{type}:{sender_or_workspace}:{period_start}:{step}`.

| Key | Audience | Domain | Safety-critical | Section |
|---|---|---|---|---|
| `sender_disconnected_team` | team (owners, managers) | platform | no (preference, default on) | §5.8.3 |
| `sender_mass_disconnect` | team (owners, managers) | platform | yes | §5.8.4 |
| `sender_connected_notice` | holder (outside only) | brand | yes | §5.8.1 |
| `sender_holder_changed` (to the old outside address; to a member set as holder by someone else) | holder | brand for outside, platform for members | yes | §5.8.1 |
| `sender_reconnect_after_billing` | holder | brand for outside, platform for members | yes | §5.9.4 |
| `sender_removal_billing_notice` | holder | brand for outside, platform for members | yes | §5.9.2 day 14 |

"Holder" replaces the earlier "owner" audience: the member's sign-in email for their own account, or the outside address with the connecting member copied (§5.8.1).
| `billing_payment_failed`, `billing_action_required`, `billing_reminder`, `billing_suspension_tomorrow`, `billing_suspended`, `billing_removal_warning`, `billing_accounts_removed`, `billing_deletion_warning`, `billing_data_deleted`, `billing_reactivated`, `billing_plan_ending` | owners + billing contacts | platform | yes | §5.9, §5.10 |

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

### 8.4 Disconnects
- Sender list badge "Disconnected 6 h · sign-in email sent 13:05 · reminded 1×". "Sign-in email held: likely outage" during a hold.
- Sender page: **Send a new sign-in link**; **Whose account**: "Yours (aarushi@growthxai.com)", "Naman's (team)" or "Avi Shah · avi@client.com (outside, Priya copied)", with **Change** (§5.8.1 rules).
- Senders list: an **Outside** chip on accounts held by someone outside the workspace.
- Dashboard "needs attention": one line per disconnected account, oldest first.
- Settings → Notifications: "Disconnected accounts (combined email after 4 hours)" toggle per person, default on. The outage email has no toggle.

### 8.5 Billing
- Banners per §5.9.2 and §5.9.3, shown on every page: amber (day 0–5, owners and managers), red (day 6, everyone), full-screen for owners when suspended.
- Settings → Billing: status, overdue amount, **Pay invoice** (Stripe hosted invoice), **Update card** (Stripe customer portal), the dates for each next step ("Accounts disconnect on 16 Nov · data deleted on 2 Jan"), **Also send billing emails to** (`billing_emails`), **Export everything**.
- Senders list while suspended: every row "Paused · billing", Resume replaced by **Update payment**.

---

## 9. MCP

- `senders_list` / `sender_get` return the new statuses and `auto_remove_at`, `erase_scheduled_at`; `senders_list` hides removed unless `include_removed: true`.
- `why_not_sending` adds causes `E_SENDER_PAUSED`, `E_SENDER_DISABLED`, `E_SENDER_REMOVED`, `E_POOL_NO_ACTIVE_SENDER`.
- New, confirmation-gated, manager+, not for unattended tokens: `sender_pause`, `sender_resume`.
- Disable, remove and erase stay **app-only**, as the MCP PRD already rules for connecting and disconnecting senders: ending someone's account connection is a human act.
- `senders_list` adds `disconnected_at`, `holder_notified_at`, `holder_reminders_sent`, `holder_email_held_until`, and `holder: {kind: 'member'|'outside', name?, email?}`. `alerts_list` includes disconnects and mass-disconnect holds.
- No MCP tool sets or changes an account's holder: it decides where sign-in links go, so it stays in the app.
- `workspace_context` adds `billing_status` and the next billing step and date. While suspended every write tool returns `E_BILLING_SUSPENDED`; no MCP tool can pay, change cards or reactivate.

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
| Outside holder uses the disconnect link while an agency sequence runs | Removed immediately; leads exit; connecting member and managers alerted |
| Erase cancelled with 5 minutes left | Cancelled; nothing deleted |
| Erase job crashes halfway through Storage deletes | Next run finishes them; the transaction for rows runs only after Storage is done |
| Pause with auto-resume during a weekend | Resumes at the time set; planner places backlog inside working windows only |
| Disabled for 30 days | Notice at day 23, removed on day 30 |
| Trial ends with a sequence running | Senders removed, workspace read-only, history visible for 30 days |
| Someone tries `delete from senders` in SQL | Fails while history exists (`no action` FK). Only `sender_erase_execute` empties it first |
| Mailbox sender (IMAP app password) removed | App password wiped; same flow without the Unipile call for non-Unipile mailboxes |
| WhatsApp sender removed | Unipile unlinked; the removal notice explains WhatsApp → Linked devices → log out |
| Account reconnects 3 hours after dropping | The holder may have had the sign-in email; the team never is emailed |
| Account drops and comes back several times a day | Each drop resets the 4-hour clock; the team email lists it once a day at most, marked "unstable: dropped 4 times today" |
| Sign-in email to an outside holder bounces | `email.bounced` → task for the connecting member and managers "The sign-in email to {address} bounced. Check who signs in to {sender}" (sending domain PRD §5.4); the account shows in the next team email with "sign-in email bounced". The copy to the member still arrives, so they can forward the link |
| Member changes their GrowthxAI login email | Next email goes to the new address; nothing to update on any sender |
| Member who holds accounts leaves the workspace | Holder emails go to `connected_by` or the owners; owners get a task per account (§5.8.1); `owner_is_operator` grants revoked, so AI replies and direct profile edits stop until someone grants again |
| Under *Someone else's*, user types their own sign-in email | Treated as *Mine* |
| Under *Someone else's*, user types a teammate's email | Linked to that teammate; they get a "you were set as the person who signs in" notice and can change it |
| Same outside person holds accounts in two workspaces | Each workspace sends its own emails with its own footer and disconnect link; one link removes only its own sender |
| Mass disconnect, then half reconnect on their own | Only those still down after the hold get sign-in emails |
| Disconnected sender in a suspended workspace | No owner or team emails: the workspace is paused for billing, so the reconnect can wait for payment |
| Payment fails on day 0, paid on day 2 | Back to active; nothing was paused; no further emails |
| Paid on day 10 (suspended) | Reactivated; billing-paused senders resume; backlog spread |
| Paid on day 30 (accounts removed) | Reactivated; owners get sign-in emails; history restored on reconnect; team re-adds senders to sequences |
| Paid on day 68 | Data already erased; the subscription is new, the workspace starts empty |
| Card needs bank approval (`payment_action_required`) | "Confirm your payment" email with the invoice link; the clock only starts if the charge actually fails |
| Owner changes the card but the retry hasn't run | Still `past_due` until `invoice.paid`; **Pay invoice** charges now |
| Customer cancels mid-period | Works to period end; then accounts removed, 60 days read-only, then erased |
| Trial ends without paying | §5.5 rule (removed at day 7, deleted 30 days later), not the billing timeline |

---

## 11. Rollout

| Phase | Contents | Risk |
|---|---|---|
| **1** | Migration: statuses, columns, unique live-identity index, FK change, CI check. Reconciliation in report-only mode. `DELETED` → removed | None for users; the FK change blocks accidental deletes from day one |
| **2** | Pause (with manual replies), Disable/Enable with the preview dialog and re-enrol option, inbox banners, sequence pool states | Low |
| **3** | Remove (two-step with Unipile), credential wipe, reconnect restore, duplicate block, owner disconnect link, trial-end and workspace-delete hooks, plan slot counting | Medium: test on own senders first |
| **4** | Erase with 24 h schedule, auto-remove after 30 days disabled, reconciliation cleanup on, MCP pause/resume | Medium: erase is irreversible, ship last |
| **5** | "Whose account is this?" + `sender_email_recipients` + migration of existing senders (§5.8.1), disconnect alerts (F60, team email, holds), `billing_status` migration and RLS change, F24 events, F61 timeline through day 21, billing banners and page, cancellation | Medium: run the billing clock in "emails only" mode for one week first (no suspension), checking the dates it would have acted on |
| **6** | Billing erase at day 67 and cancellation erase | High: irreversible, ship after phase 5 has run for a month |

Phase 5's "Whose account is this?" change and disconnect alerts can ship before the rest of phase 3 and 4: they only change where emails go and add new ones. Ship `sender_email_recipients` first and route F6 through it, then remove the old field.

Before phase 3 on real accounts, test on one internal LinkedIn sender of each login type (credentials, cookies) whether Unipile's delete also ends the session on LinkedIn's side and whether the account holder's own browser stays logged in (open question 1).

---

## 12. Tests

- **Schema:** deleting a sender with a chat fails; deleting its workspace succeeds and leaves nothing behind; a migration adding `on delete cascade` to `senders` fails CI.
- **Disable:** counts in the preview equal the rows changed; in-flight action completes; enrolments exit; stalled sequence alert fires; enable doesn't revive exited leads.
- **Pause:** manual reply sends; no automated action runs; backlog after a 5-day pause is spread within caps.
- **Remove:** Unipile 2xx / 404 / 5xx paths; secrets and extension token gone; pools, rules, imports cleaned; reports for last month unchanged before and after.
- **Restore:** reconnect same profile → same sender id, history visible, warmup level per §5.1; "Start fresh" keeps them separate.
- **Duplicate:** second live connection blocked and its Unipile account deleted.
- **Erase:** scheduled, cancelled, executed; report totals unchanged; lead still counts as contacted; no message text left in `actions`, `audit_log` or Storage.
- **Disconnect link:** only in emails to outside holders; single use, expiry, works without login, dies when the holder changes, alerts the connecting member and managers.
- **Reconcile:** orphan reported (phase 1) then deleted (phase 4); missing-in-Unipile sender handled as §5.3.
- **Disconnect alerts:** sign-in email at T0 (credentials) or after 4 failed retries (cookies); team email exactly 4 h after the sign-in email, combined per workspace, at most once a day per account, stops after 7 days; reconnect before 4 h → no team email; a solo user holding all the listed accounts gets no team email; mass disconnect opens a hold and the hold suppresses sign-in emails until it ends; suspended workspace → no disconnect emails.
- **Recipients:** *Mine* → every email to the member's current sign-in email, no disconnect link, no copy; change the login email → next email goes to the new one. *Someone else's* (outside) → only the §5.8.1 holder emails reach that address, each with the connecting member in cc and the disconnect link; reply alerts, digests, billing and team emails never reach it. A teammate's email under *Someone else's* links to the teammate. `sendEmail` rejects an explicit address for a holder email. Holder leaves → fallback recipients and owner task. Change → old links dead, grants revoked, old-address notice sent. Migration table in §5.8.1 applied to fixtures with each of the four starting states.
- **Billing clock:** a fake clock walks days 0 → 67 and asserts each email, the suspension, the removal and the erase happen once, at 10:00 workspace time; replaying a Stripe webhook changes nothing; paying on days 2, 10, 30 and 68 gives §10's outcomes.
- **Read-only:** every write RPC and MCP write tool refuses while suspended; reads and exports work.
- **Plan kept:** `plan` unchanged through suspension and reactivation.

---

## 13. Open questions

1. **Does Unipile's delete end the provider session?** For LinkedIn credentials logins the session shows under the account's active sessions; for cookie logins it's shared with their browser. Confirm both before telling users what happens on LinkedIn's side.
2. **Same profile in two workspaces** (an agency and the client both connecting one LinkedIn). D11 only covers one workspace. Leaning: warn at connect time, don't block, since workspaces can't see each other.
3. **Erase requests from an outside account holder.** Under GDPR the controller usually has one month to answer an erasure request; the DPDP Act has its own rules. Who is the controller for an agency's client's employee's LinkedIn conversations (the agency, the client, or us as processor)? Needs legal input before phase 4; until then the request goes to the workspace owner as a task.
4. **Auto-remove default.** 30 days balances late replies against Unipile cost. Revisit once there's data on how late replies to disabled senders actually arrive.
5. **Prepaid slots.** When a removed account frees a slot mid-period, can the customer use it for a different account immediately? Leaning yes, since we pay Unipile on peak simultaneous accounts, so a swap doesn't raise our cost.
6. **Billing days.** 7 / 21 / 67 are a starting point. Annual customers who already paid a year may deserve a longer grace before accounts are removed; decide before the first annual plan renews.
7. **Stripe's own emails.** Keep Stripe's failed-payment emails on alongside ours (two emails on day 0), or turn them off and rely on ours? Leaning: keep them for the card owner, since Stripe's email is the one with the card details.
8. **Team email threshold.** 4 hours suits LinkedIn. WhatsApp sessions drop and recover differently; revisit per channel once there's data.
9. **"What the AI sent as you" digest for outside holders.** The AI-reply PRD's `ai_reply_owner_digest` isn't one of the four holder email kinds, so under D13 it no longer goes to outside holders; members see the same in the app. An outside person who consented to AI writing as them may expect to see what was sent. Leaning: offer it as a choice on the consent page ("Send me a weekly summary"), off by default.
