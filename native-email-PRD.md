# PRD: Native Email (IMAP/SMTP, simple sending)

**Product:** Outreach platform (LinkedIn multi-sender + email + WhatsApp/Instagram), Supabase + React
**Version:** 1.0 · 29 September 2026
**Replaces:** Unipile as the email transport (mailboxes currently cost ~$5.00–5.50/month each as Unipile linked accounts)
**Builds on:** `linkedin-outreach-platform-PRD.md` (unified inbox, sequences, action ledger, `worker-tick`), `web-chat-PRD.md` (email continuity reuses this transport)
**Implementation reference:** Chatwoot's email channel (MIT core) — https://github.com/chatwoot/chatwoot. Read it for IMAP fetch, threading and reply parsing edge cases; do not copy anything under `enterprise/`.

---

## 1. Decision summary

| Decision | Choice |
|---|---|
| Connection method | **IMAP + SMTP with an app password** for every provider in v1. No OAuth, so no Google app verification, no CASA security assessment, no Microsoft admin consent |
| What we build | Send 1:1 emails (sequence steps + manual replies), thread follow-ups, detect replies, detect bounces, show conversations in the unified inbox, reply from the inbox |
| What we don't build | Open tracking, click tracking, link rewriting, tracking pixels, warm-up, inbox rotation beyond the existing sender pool, bulk/newsletter sending, email finder changes |
| Where the long-running work lives | A small always-on **mail worker** (Node 20, ImapFlow + Nodemailer + mailparser). Supabase Edge Functions cannot hold IMAP connections open |
| What we store | Only mail that belongs to our conversations: messages we sent, and inbound messages that thread to them or come from a known lead. Never the rest of the mailbox |

Cost after migration: ~$0.25 per mailbox per month (worker compute + storage) versus $5.00–5.50 on Unipile.

---

## 2. Goals and non-goals

### Goals
1. A user connects any mailbox (Gmail, Google Workspace, Microsoft 365, Zoho, Fastmail, cPanel/custom domain) in under 2 minutes with host, port, username and app password — or a provider preset that fills host/port.
2. Sequence email steps send from that mailbox inside the sender's working hours, under per-mailbox caps.
3. Follow-ups land in the same thread in the recipient's client.
4. A reply stops the lead on every channel within 2 minutes of arriving (existing "reply stops everything" rule).
5. Hard bounces stop email steps for that address and suppress it workspace-wide.
6. Replies appear in the unified inbox; the operator replies from the inbox and the reply threads correctly.
7. The web chat channel can send email to offline visitors and receive their replies through the same transport (see `web-chat-PRD.md` §9).

### Non-goals (v1)
- Open/click tracking of any kind. No `<img>` pixel, no redirect domain. Say so in the UI: "We don't track opens. Replies are the signal."
- Warm-up networks.
- OAuth connections (Gmail API, Microsoft Graph) — P3, only if app-password setup becomes the top churn reason.
- Attachments in sequence steps (allowed in manual inbox replies only).
- Shared/team mailboxes with delegated access.

---

## 3. Provider matrix

Presets fill host, port and security; the user supplies email + app password. All values editable under "Advanced".

| Provider | IMAP | SMTP | App password requirement | Notes |
|---|---|---|---|---|
| Gmail / Google Workspace | `imap.gmail.com:993` TLS | `smtp.gmail.com:465` TLS (or 587 STARTTLS) | 2-Step Verification on; create at myaccount.google.com/apppasswords | Workspace admins can block app passwords — show that as the likely cause on auth failure. Gmail saves SMTP-sent mail to Sent automatically: **do not also APPEND** or Sent gets duplicates. Folder names: `[Gmail]/Sent Mail`, `[Gmail]/Spam` (localised — resolve via `SPECIAL-USE` flags, never by name) |
| Microsoft 365 | `outlook.office365.com:993` TLS | `smtp.office365.com:587` STARTTLS | Tenant must allow SMTP AUTH for the mailbox; app passwords need MFA with legacy app passwords enabled | Microsoft keeps SMTP AUTH basic auth for existing tenants until **31 Dec 2026**; tenants created from **1 Jan 2027** cannot use it; final removal date to be announced in H2 2027. Show a banner on M365 mailboxes and plan Graph OAuth (P3) before then. SMTP-sent mail is saved to Sent by Exchange — do not APPEND |
| Outlook.com / Hotmail (personal) | — | — | Not supported | Microsoft removed basic auth for personal Outlook.com accounts. Block at connect with a clear message |
| Zoho Mail | `imap.zoho.com:993` (region hosts: `.eu`, `.in`, `.com.au`) | `smtp.zoho.com:465` | App-specific password when 2FA on | Region picker in preset |
| Fastmail | `imap.fastmail.com:993` | `smtp.fastmail.com:465` | App password required | |
| Yahoo | `imap.mail.yahoo.com:993` | `smtp.mail.yahoo.com:465` | App password required | Low priority |
| Custom / cPanel / other | user-entered | user-entered | Usually the account password | Most do **not** save SMTP-sent mail to Sent — APPEND to the Sent folder after send (§6.4) |

Detection: after login, read the IMAP `CAPABILITY` and greeting to confirm the provider (Gmail advertises `X-GM-EXT-1`). Store `provider` from detection, not from the preset the user picked.

---

## 4. Architecture

```
React app ──► Edge Fn mailbox-connect (validate, store secret in Vault)
                         │
worker-tick (existing) ──► pgmq 'email_send' ──► MAIL WORKER (Node 20, always on)
                                                   ├─ Sender: Nodemailer SMTP, per-mailbox serial
                                                   ├─ Syncer: ImapFlow IDLE (INBOX) + poll (Sent, Spam)
                                                   ├─ Parser: mailparser → threading → classify
                                                   └─ writes: messages, chats, lead state, bounces
                                                          │
Unified inbox (Realtime) ◄────────────────────────────────┘
```

- **Mail worker** runs on Fly.io/Railway/Render (not Supabase). Horizontal scaling by consistent hashing of `mailbox_id` across instances; each mailbox owned by exactly one instance at a time (Postgres advisory lock `pg_try_advisory_lock(hashtext(mailbox_id))` held for the connection's life).
- **Connections:** one IMAP connection per mailbox for IDLE on INBOX. Gmail allows ~15 simultaneous IMAP connections per account; we use at most 2 (IDLE + short-lived poll). Reconnect with exponential backoff (5s → 10 min, jitter).
- **Polling:** IDLE is not reliable everywhere; also poll INBOX every 2 minutes with `UID SEARCH UID <last_uid+1>:*`. Poll Sent every 10 minutes (catches replies the user sent from their own mail client — see §7.5). Poll Spam every 30 minutes for replies filtered there.
- **Queues:** `pgmq` — `email_send` (from `worker-tick`), `email_inbound` (parsed messages for the existing `process-inbound` pipeline). Worker never calls business logic directly; it writes normalised rows and enqueues.
- **Libraries:** `imapflow` (MIT), `nodemailer` (MIT), `mailparser` (MIT), `email-reply-parser`-style quote stripping (port Chatwoot's approach or use `planer`/`talon` logic).

---

## 5. Connecting a mailbox

### 5.1 Flow
1. User picks provider → sees a 3-step guide with a link to that provider's app-password page and screenshots.
2. Enters email, display name, app password (masked). Advanced: IMAP/SMTP host, port, security (TLS / STARTTLS), IMAP username if different from email.
3. `mailbox-connect` Edge Function calls the worker's `/verify` endpoint (mTLS/shared secret), which:
   - IMAP: connect, `LOGIN`, `LIST` with `SPECIAL-USE`, select INBOX, read `UIDVALIDITY` and `UIDNEXT`.
   - SMTP: connect, `EHLO`, `AUTH`, then `RSET` and quit. **No test email is sent** unless the user clicks "Send test".
   - DNS: fetch SPF (`TXT` on the domain), DMARC (`_dmarc.`), MX. DKIM: try common selectors (`google`, `selector1`, `selector2`, `default`, `zoho`, `fm1`) — report "found / not found", never block.
4. On success: secret stored in Supabase Vault (`vault.create_secret`), row in `mailboxes` with `status='ok'`, sync cursor set to **current `UIDNEXT`** (we do not backfill history; §7.6 covers optional backfill).
5. Show a health card: IMAP ok, SMTP ok, SPF/DKIM/DMARC status, daily cap, working hours.

### 5.2 Error mapping (show the human sentence, log the raw)

| Raw | Code | User sees |
|---|---|---|
| IMAP `AUTHENTICATIONFAILED`, SMTP `535` | `E_MAILBOX_AUTH` | "Wrong app password, or app passwords are turned off for this account." + provider-specific hint (Workspace admin block, M365 SMTP AUTH disabled) |
| SMTP `535 5.7.139` (M365) | `E_M365_SMTP_AUTH_DISABLED` | "SMTP AUTH is off for this mailbox. Your Microsoft 365 admin can enable it." |
| Connection timeout / ECONNREFUSED | `E_MAILBOX_UNREACHABLE` | "Can't reach the server. Check host and port." |
| TLS error / self-signed | `E_MAILBOX_TLS` | "The server's certificate isn't valid." Allow "trust anyway" only for custom hosts, logged |
| No Sent folder found | `E_NO_SENT_FOLDER` | Ask user to pick one from the folder list |
| Outlook.com personal domain | `E_PROVIDER_UNSUPPORTED` | "Personal Outlook.com accounts can't connect with a password any more." |

### 5.3 Plan limits
Mailbox allowance per plan comes from `plan_entitlements` (pricing plan: 1 per sender until native email ships, then Core 2 / Pro 5 / Agency 5 per sender, pooled). Enforced at connect: `E_MAILBOX_ALLOWANCE`.

---

## 6. Sending

### 6.1 Where sends come from
- **Sequence steps:** `worker-tick` claims an `email` action (existing ledger, `action_type='email'`) and enqueues `{action_id, mailbox_id, lead_id, enrollment_id, rendered subject/body, thread_ref?}` onto `email_send`.
- **Manual inbox replies:** `inbox_send_reply` enqueues with `priority=high` and `source='manual'`. Manual replies bypass working hours but **not** the daily cap's hard ceiling.
- **Web chat continuity emails:** enqueued by the web chat service with `source='webchat'` (see web chat PRD).

### 6.2 Caps and pacing (per mailbox, enforced in the worker at send time AND at planning)

| Setting | Default | Range | Note |
|---|---|---|---|
| Daily sequence sends | 30 | 1–50 | Hard ceiling 50 in v1. Manual replies don't count toward the sequence cap but do count toward a hard 150/day total |
| Min gap between sends | random 4–9 min | 1–30 min | Serial per mailbox |
| Working hours | sender's schedule | — | Timezone of the sender |
| New mailbox ramp | day 1–3: 10, day 4–7: 20, then default | — | Applied automatically, visible on the card |
| Provider hard limits (safety net) | Gmail consumer 500/day, Workspace 2,000/day | — | Never approached; if SMTP returns `550 5.4.5` daily limit, pause the mailbox until midnight PT |

### 6.3 Message construction
- `Message-ID: <{uuidv7}@{mailbox domain}>` — generated by us, stored before sending. Never let the server generate it (we need it for threading and dedupe).
- `From: "{display name}" <{address}>`; `Reply-To` only when the user sets one.
- `Date`, `MIME-Version`, `Content-Type`. Plain text by default; "simple HTML" option renders minimal HTML (paragraphs, links, bold) plus an exact text alternative (`multipart/alternative`). No remote images inserted by us, no CSS frameworks.
- Signature per mailbox (plain + HTML), appended below the body with `-- ` separator in text part.
- Follow-up in thread: `Subject: Re: {original subject}` (unless the step overrides the subject — then it's a new thread), `In-Reply-To: <{previous Message-ID}>`, `References: <{root}> … <{previous}>` (keep the full chain, trimmed to the last 10 IDs).
- Optional unsubscribe line (workspace setting, default on for sequences): a plain sentence ("Not relevant? Reply 'no' and I won't follow up.") — no link. Optional `List-Unsubscribe: <mailto:{address}?subject=unsubscribe>` header (default off; one-click RFC 8058 URL is only required for bulk senders and we cap far below that).
- Headers we never add: tracking IDs, `X-Mailer` identifying the platform (leave Nodemailer's off), `Precedence: bulk`.
- Encoding: UTF-8, quoted-printable for text; encode non-ASCII display names (RFC 2047).

### 6.4 Send pipeline (worker)
1. Pre-checks (fail fast, idempotent): mailbox `status='ok'`; lead not suppressed / not `do_not_contact`; address not in `email_suppressions`; enrollment still active; lead has not replied on any channel since planning; cap and gap OK. Failure → re-queue or fail the action with a code (§11).
2. Insert `messages` row `direction='out', status='sending'` with our Message-ID **before** SMTP (dedupe key `(mailbox_id, rfc_message_id)` unique).
3. SMTP send via a pooled Nodemailer transport per mailbox (`pool: true, maxConnections: 1`).
4. Result:
   - `250` → `status='sent'`, `sent_at`, store server response (queue ID).
   - `4xx` → retry with backoff (2, 10, 30 min), max 3; then `failed`.
   - `5xx` on RCPT (`550 5.1.1` user unknown etc.) → treat as **hard bounce** immediately (§8).
   - `5xx` policy/spam (`550 5.7.x`) → `failed`, pause the mailbox if 3 in 24 h (`E_MAILBOX_BLOCKED`), notify.
   - Network error after DATA sent → **unknown**: mark `status='unknown'`, do not retry automatically; check Sent folder on next poll for our Message-ID and resolve to `sent` if found. This avoids double-sending.
5. For providers that don't auto-save (custom/cPanel/Zoho when configured): `APPEND` the exact raw MIME to the Sent folder with `\Seen`.
6. Update action → `completed`, enrollment advances.

### 6.5 Crash safety
- Idempotency: the `email_send` job carries `action_id`; the worker checks `messages` for an existing row for that `action_id` in `sent|unknown` before sending.
- Visibility timeout on pgmq longer than the max SMTP transaction (120 s).

---

## 7. Receiving and reply detection

### 7.1 What we fetch
For each new UID in INBOX (and Spam, Sent on their pollers): fetch `ENVELOPE`, `BODYSTRUCTURE`, headers `Message-ID, In-Reply-To, References, Auto-Submitted, X-Autoreply, X-Autorespond, Precedence, List-Id, Content-Type, Return-Path, X-Failed-Recipients`. Fetch the full body **only** if the message matches (§7.2). Everything else is discarded — never stored.

### 7.2 Matching an inbound message to a conversation (in order)
1. `In-Reply-To` or any `References` ID equals a `messages.rfc_message_id` we sent or stored → that conversation.
2. Gmail only: `X-GM-THRID` equals a thread ID we recorded for a sent message → that conversation (covers replies whose client dropped headers).
3. From address equals a lead's email **and** that lead has an outbound email to them from this mailbox in the last 90 days → that lead's email conversation on this mailbox.
4. Web chat continuity addresses (plus-address token, see web chat PRD) → that web chat conversation.
5. Otherwise: ignore. Do not store. (Optional workspace setting "Create leads from unknown senders" — default off.)

### 7.3 Classifying a matched inbound message

| Type | Detection | Effect |
|---|---|---|
| Bounce / DSN | `Content-Type: multipart/report; report-type=delivery-status`, or from `MAILER-DAEMON`/`postmaster` with a DSN-like subject | §8 — never counts as a reply |
| Auto-reply / OOO | `Auto-Submitted` present and not `no`; `X-Autoreply`/`X-Autorespond` present; `Precedence: auto_reply`; subject matches OOO patterns (EN + common: "Out of office", "Automatic reply", "Abwesenheit", "Réponse automatique", "Fuera de la oficina") | Stored, shown in inbox tagged **Auto-reply**, intent `ooo`. **Does not stop the sequence.** Parse a return date if present ("back on 14 October") → store `ooo_until`; planner delays the next step to `ooo_until + 1 working day` |
| Mailing-list / bulk | `List-Id` or `Precedence: bulk/list` | Ignore |
| Human reply | everything else that matched | `lead_sender_state.replied=true` → exits enrollments on every channel (existing trigger), `ai_classify` queued, inbox unread, enrich-on-reply (existing setting) |
| Unsubscribe request | AI intent `not_interested` with unsubscribe wording, or body ≈ "unsubscribe / remove me / stop" | Suppress email for the lead workspace-wide, tag `unsubscribed` |

### 7.4 Body handling
- Store both `text` and sanitised `html` (DOMPurify server-side; strip scripts, forms, remote images replaced with a "load images" placeholder in the inbox).
- Extract the **new content** above quoted history for the inbox preview and AI (`reply_text`), keep the full body for "show quoted". Handle: Gmail `On … wrote:`, Outlook `From: … Sent: …` blocks and `-----Original Message-----`, Apple Mail, localised variants, `>` quoting, signatures (`-- `). Chatwoot's reply parsing is a good reference for these cases.
- Attachments: store in Supabase Storage (`email-attachments/{workspace}/{message}/{name}`), max 25 MB per message; block executables by MIME sniffing, not extension.
- Inline images (`cid:`) rewritten to signed Storage URLs.

### 7.5 Replies sent outside the platform
If the operator replies to a lead from Gmail/Outlook directly, the Sent poller sees a message whose `In-Reply-To` matches a known conversation → store as `direction='out', source='external'` so the inbox stays complete. Does not consume the sequence cap.

### 7.6 Sync state and edge cases
- Cursor per folder: `(uidvalidity, last_uid)`. If `UIDVALIDITY` changes → rescan the last 14 days by `SINCE` date and dedupe on `Message-ID` (+ `(mailbox_id, folder, uid)`).
- Dedupe inbound by `rfc_message_id`; messages without a Message-ID get a synthetic key `sha256(from|date|subject|first 1 KB)`.
- A message moved from Spam to INBOX by the user appears twice → dedupe handles it.
- Mailbox renamed folders / non-English folder names → always resolve via `SPECIAL-USE` (`\Sent`, `\Junk`, `\All`); fall back to user selection.
- Optional backfill at connect ("Import last 30 days of conversations with existing leads"): scan Sent + INBOX `SINCE` 30 days, keep only messages to/from lead addresses. Default off.
- Large mailboxes: never `FETCH 1:*`; always UID ranges in batches of 200.

---

## 8. Bounces

- **Synchronous:** SMTP `5.1.x` on RCPT/DATA → hard bounce at send time.
- **Asynchronous (DSN):** parse `message/delivery-status` part (RFC 3464): `Final-Recipient`, `Action: failed|delayed`, `Status: 5.x.x|4.x.x`, `Diagnostic-Code`. Link to our message via the attached original headers (`text/rfc822-headers` or `message/rfc822` → `Message-ID`), else `X-Failed-Recipients` + recency.
- Non-standard NDRs (Exchange, Gmail "Address not found", Yahoo): regex fallbacks on subject/body for `550`, `5.1.1`, "does not exist", "user unknown", "mailbox unavailable".
- **Hard (5.x.x):** `messages.status='bounced'`, lead flag `email_bounced`, address into `email_suppressions (reason='hard_bounce')`, stop email steps for that lead (other channels continue), condition node `email_bounced` becomes true.
- **Soft (4.x.x / `Action: delayed`):** record only; after 3 soft bounces for the same address in 14 days → treat as hard.
- **Mailbox protection:** if hard bounces exceed 5% of the last 100 sends (min 20 sends) → pause sequence sending on that mailbox (`E_MAILBOX_BOUNCE_RATE`), notify owner, require a manual resume.

---

## 9. Mailbox health

States: `connecting → ok → (auth_failed | unreachable | paused | disabled)`.
- 3 consecutive IMAP or SMTP auth failures → `auth_failed`, stop sending, email the owner ("Reconnect: your app password stopped working" — common after a Google password change, which revokes app passwords).
- Unreachable > 30 min → `unreachable`, retries continue in background.
- Health card shows: last successful sync, last send, sends today / cap, bounce rate (30 days), reply rate (30 days), SPF/DKIM/DMARC status.
- No open rate anywhere in the product.

---

## 10. Data model (additions)

```sql
create type mailbox_status_t as enum ('connecting','ok','auth_failed','unreachable','paused','disabled');

create table mailboxes (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  sender_id       uuid references senders(id) on delete set null,   -- owning sender profile, optional
  address         citext not null,
  display_name    text,
  provider        text not null,                  -- gmail|workspace|m365|zoho|fastmail|yahoo|custom
  imap_host text not null, imap_port int not null, imap_tls text not null,   -- tls|starttls
  smtp_host text not null, smtp_port int not null, smtp_tls text not null,
  username        text not null,
  secret_id       uuid not null,                  -- vault.secrets id holding the app password
  sent_folder     text, spam_folder text,
  append_to_sent  boolean not null default false,
  signature_text  text, signature_html text,
  daily_cap       int not null default 30 check (daily_cap between 1 and 50),
  min_gap_sec     int not null default 240,
  max_gap_sec     int not null default 540,
  ramp_started_at timestamptz,
  status          mailbox_status_t not null default 'connecting',
  status_reason   text,
  dns_check       jsonb not null default '{}',    -- {spf, dkim, dmarc, mx, checked_at}
  last_sync_at    timestamptz, last_send_at timestamptz,
  created_at      timestamptz not null default now(),
  unique (workspace_id, address)
);

create table mailbox_sync_state (
  mailbox_id uuid references mailboxes(id) on delete cascade,
  folder text, uidvalidity bigint not null, last_uid bigint not null,
  updated_at timestamptz not null default now(),
  primary key (mailbox_id, folder)
);

-- messages (existing table) gains:
alter table messages
  add rfc_message_id text, add in_reply_to text, add references_ids text[],
  add gmail_thread_id text, add imap_uid bigint, add imap_folder text,
  add email_status text,                 -- sending|sent|unknown|failed|bounced
  add reply_text text,                   -- new content without quoted history
  add is_auto_reply boolean not null default false,
  add source text;                       -- sequence|manual|external|webchat
create unique index on messages (chat_id, rfc_message_id) where rfc_message_id is not null;
create index on messages (rfc_message_id);

create table email_bounces (
  id bigserial primary key, workspace_id uuid, mailbox_id uuid, message_id uuid,
  recipient citext not null, kind text check (kind in ('hard','soft')),
  status_code text, diagnostic text, raw_excerpt text, created_at timestamptz default now()
);

create table email_suppressions (
  workspace_id uuid references workspaces(id) on delete cascade,
  address citext, reason text check (reason in ('hard_bounce','unsubscribed','manual','complaint')),
  created_at timestamptz default now(), primary key (workspace_id, address)
);
```

`billing_usage.active_mailboxes` counts `mailboxes.status in ('ok','paused','connecting')`.

---

## 11. Error codes (added to `why_not_sending`)

`E_MAILBOX_AUTH`, `E_M365_SMTP_AUTH_DISABLED`, `E_MAILBOX_UNREACHABLE`, `E_MAILBOX_TLS`, `E_NO_SENT_FOLDER`, `E_PROVIDER_UNSUPPORTED`, `E_MAILBOX_ALLOWANCE`, `E_MAILBOX_DAILY_CAP`, `E_MAILBOX_PAUSED`, `E_MAILBOX_BLOCKED`, `E_MAILBOX_BOUNCE_RATE`, `E_EMAIL_SUPPRESSED`, `E_EMAIL_BOUNCED`, `E_NO_EMAIL` (existing).

---

## 12. UI

- **Settings → Mailboxes:** list with status dot, address, provider, sends today / cap, bounce rate, reply rate, last sync. Connect button → provider picker → guide → form → verify → health card.
- **Mailbox detail:** caps, gaps, ramp, working hours (inherited from sender unless overridden), signature editor (plain + simple HTML preview), Sent/Spam folder pickers, "Send test email", "Reconnect", "Pause", DNS check with fix instructions.
- **Sequence builder → Send Email node:** mailbox selection (sender's mailbox / pool), subject, body with variables, "send in previous thread" toggle (default on for follow-ups), plain/simple HTML toggle, preview with the lead's real data.
- **Inbox:** email threads render like chat with quoted history collapsed; attachment chips; "Auto-reply" and "Bounced" tags; reply composer threads automatically; "Show original" (raw headers) for debugging.
- **Copy:** anywhere metrics appear, no open rate column. Tooltip: "We don't track opens."

---

## 13. MCP / API

- MCP read: `mailboxes_list`, `mailbox_health`. Write (confirmation-gated): `mailbox_pause`, `mailbox_resume`. Existing `inbox_send_reply` works unchanged for email threads.
- Outbound webhooks: `email.sent`, `email.failed`, `email.bounced`, `email.replied`, `mailbox.status_changed` (HMAC-SHA256 signed body, same scheme as existing webhooks).

---

## 14. Security & privacy

- App passwords only in Supabase Vault; the worker fetches per connection through a service-role RPC, holds in memory, never logs. Rotate: reconnect flow overwrites the secret.
- Worker ↔ Supabase over service role with IP allowlist; worker `/verify` endpoint behind a shared secret + mTLS.
- Only matched messages stored (§7.1). Unmatched mail is never written to disk or logs (log only counts).
- Retention follows the workspace lifecycle in the pricing plan: trial data deleted 7 days after trial end; cancelled workspaces 30 days after period end. Deleting a mailbox deletes its credentials immediately and its messages with the workspace purge.
- DPA/sub-processor list: add the worker host.

---

## 15. Migration from Unipile mailboxes

1. Ship native email behind a flag; new mailboxes use it.
2. For each Unipile mailbox: banner "Reconnect with an app password (2 min) — keeps all your threads". On reconnect, match by address, carry `rfc_message_id` values already stored from Unipile mail webhooks so in-flight threads continue.
3. If an in-flight thread lacks a stored Message-ID, the next follow-up starts a new thread (documented, rare).
4. After 30 days, disconnect remaining Unipile mailboxes (with 2 reminders) — each removal lowers the Unipile peak bill.

---

## 16. Rollout

| Phase | Scope |
|---|---|
| P0 | Mail worker skeleton, connect + verify, Vault secrets, SMTP send with our Message-ID, Sent APPEND logic, caps/gaps, idempotency |
| P1 | IMAP sync (IDLE + polls), matching, reply detection, auto-reply detection, bounce parsing, suppressions, inbox rendering + reply |
| P2 | Health states, DNS checks, bounce-rate guard, ramp, migration off Unipile, web chat continuity hooks |
| P3 (conditional) | Microsoft Graph OAuth before the SMTP AUTH retirement bites; Gmail OAuth only if app-password setup is the top churn reason (needs Google verification + annual CASA for restricted scopes) |

---

## 17. Test plan (must-pass before GA)

- Threading shows as one thread in: Gmail web, Outlook web, Outlook desktop, Apple Mail, iOS Mail — for 3-step sequences with and without subject override.
- Reply detection for replies from each of those clients, plus mobile clients that strip `References`.
- OOO from Gmail, Exchange, Zoho → not a reply; `ooo_until` parsed for EN.
- DSN fixtures: Gmail, Exchange/M365, Yahoo, Postfix, Exim, Zoho — hard and soft.
- Crash during SMTP DATA → no duplicate send; resolves via Sent check.
- UIDVALIDITY change → no duplicates, no missed replies.
- App password revoked → `auth_failed` within 3 cycles, owner emailed, sequences on that mailbox paused.
- Gmail: no duplicate in Sent. Custom host: exactly one copy in Sent.
- Non-ASCII subjects, display names, bodies (Hindi, Arabic RTL, emoji).
- 500 mailboxes on one worker instance: memory < 1 GB, reconnect storm after restart spread over 5 min.

---

## 18. Metrics

Per mailbox and workspace: sent, failed, bounced (hard/soft), replied, auto-replies, reply rate, bounce rate, time-to-reply-detection (p95 target < 2 min with IDLE, < 3 min polling). Platform: mailboxes connected, share of mailboxes in `auth_failed`, Unipile mailboxes remaining.

---

## 19. Risks

| Risk | Mitigation |
|---|---|
| Workspace admins block app passwords | Clear error + admin instructions; OAuth path in P3 |
| Microsoft SMTP AUTH retirement (new tenants from 1 Jan 2027, final date TBA) | Banner on M365 mailboxes; Graph OAuth in P3 |
| Double sends on network failure | Our own Message-ID + `unknown` state + Sent-folder reconciliation |
| Missed replies (clients dropping headers) | Fallback matching by lead address + recency; Gmail thread ID |
| Storing unrelated personal mail | Match-before-fetch; unmatched bodies never fetched |
| Deliverability damage to customer domains | Low caps, ramp, bounce-rate pause, DNS checks, no tracking domains |

---

## 20. Open questions

1. Worker host: Fly.io vs Railway vs Render — pick for always-on TCP + per-region IPs (India + US).
2. Should manual inbox replies be allowed outside working hours by default? (Current: yes.)
3. Do we offer "Create leads from unknown senders" at all in v1? (Current: setting, default off.)
4. Confirm Workspace app-password availability for the first 10 design-partner domains before GA.
