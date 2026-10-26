# PRD: Custom sending domain — platform emails from the customer's own domain

**Document:** Change PRD — send the platform's notification and client-facing emails from a domain the customer owns, through Resend, with a fallback that keeps safety emails arriving
**Version:** 1.2 · 26 October 2026 — every email goes to users' sign-in emails; the "owner" audience becomes "holder" per `sender-lifecycle-PRD.md` v1.2 §5.8.1 (outside address only for sign-in, permission, profile-change and disconnect emails, with the connecting member copied)
**v1.1:** platform domain is `updates.growthxai.com`; catalogue adds disconnect and billing emails from `sender-lifecycle-PRD.md` v1.1
**Applies to:** the app as built: F27 `notify` (Resend), Supabase Auth emails, `/outreach/settings`, and every email defined in `linkedin-outreach-platform-PRD.md`, `sender-lifecycle-PRD.md`, `linkedin-profile-management-PRD.md`, AI replies, `reply-notifications-PRD.md`, `leads-relationships-PRD.md`.
**Migration:** `0NN_sending_domains` (next free number). **New functions:** F56, F57, F58, F59. **Changed:** F27 (becomes the outbox sender), every caller of `notify`, Supabase Auth email settings.
**Names:** tables and columns follow the specs. The build prefixes tables with `outreach_`; adjust.
**Checked (26 Oct 2026):** Resend multi-tenant guide, domain webhooks and `domain.updated` payload, webhook event types; Supabase Send Email Hook, custom SMTP, Edge Function limits; Microsoft's SMTP AUTH Basic-auth retirement.

---

## 0. Summary

| # | What |
|---|---|
| 1 | A workspace on Scale or Enterprise can add its own sending domain (e.g. `notify.acmegrowth.com`). Emails to its clients and to outside account holders (people outside the team whose LinkedIn or WhatsApp it uses) then come from that domain |
| 2 | Sending still goes through **Resend**. The customer adds DNS records; they never give us a mailbox password |
| 3 | Emails to the customer's own team stay on the GrowthxAI domain |
| 4 | **Safety emails always arrive.** If the customer's domain isn't working, they go from the GrowthxAI domain instead, and the disconnect link always points to our app |
| 5 | All platform email moves to one sending path with an outbox, a log and delivery tracking |
| 6 | Supabase Auth emails go through the same path (Send Email Hook), so a client's login email can carry the agency's domain too |
| 7 | Bring-your-own SMTP is **not** offered (§2, D1) |

---

## 1. Today and the gap

| Today | Gap |
|---|---|
| F27 `notify` sends every app email through Resend from one GrowthxAI address | An agency's client sees GrowthxAI emails about the agency's work, and the client's employees get consent and reconnect emails from a company they've never heard of |
| Supabase Auth sends login, reset and invite emails through custom SMTP | Same: a client viewer's login email can't carry the agency's name |
| No log of what was emailed to whom | Support can't answer "did the account holder get the consent email?" |
| No delivery tracking | A bounced reconnect email looks the same as a sent one |
| Some specs call for emails that must never be suppressed (holder notices, revert links, disconnect links) | Nothing guarantees they're delivered if a sending setup breaks |

---

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| **D1** | **No bring-your-own SMTP.** Customers add a domain to our Resend account by DNS | Microsoft began rejecting username/password SMTP on Microsoft 365 on 1 Mar 2026 with full retirement scheduled for 30 Apr 2026. Google needs 2-step verification and app passwords. Edge Functions can't reach ports 25 or 587. A changed password would silently stop the safety emails. And it would share the customer's mailbox limits and reputation with their outreach |
| **D2** | One Resend account for all customer domains (Resend's "single account" option), each domain with its own **domain-scoped API key** | Customers don't need a Resend account. A leaked key can only send from its own domain |
| **D3** | Recommend a **subdomain** (`notify.` or `mail.`), never the domain used for cold outreach | Resend's own guidance. Outreach complaints shouldn't block password resets and consent emails, and the reverse |
| **D4** | Emails are typed. Each type says who receives it, whether it can be branded, and whether it is **safety-critical** (§3) | One rule table decides the domain, not each caller |
| **D5** | Safety-critical emails **fall back** to the GrowthxAI domain on any problem with the customer's domain, and carry "on behalf of {Agency} via GrowthxAI" plus a disconnect link to our app | These are the emails other specs depend on (consent, holder notices, revert, disconnect). A customer's DNS mistake can't be allowed to silence them |
| **D6** | Brandable but not safety-critical emails also fall back rather than wait | A client report a day late is worse than a client report from the wrong domain |
| **D7** | Emails to the customer's own team stay on the GrowthxAI domain | They know the product they use. Branding adds nothing there |
| **D8** | Auth emails move to a Supabase **Send Email Hook** on the same sending path. Branded only for people who are client viewers of exactly one branded workspace | Everyone else may belong to several workspaces; one brand can't fit them |
| **D9** | Plans: Launch uses the GrowthxAI domain only. Scale: one workspace domain. Enterprise: a workspace domain plus one per client, up to 10 (more on request) | Each domain counts toward our Resend domain limit and the domains add-on costs money |
| **D10** | Every email goes through an **outbox** and is **logged** with its delivery events | Retries without double-sending, and an answer to "was it delivered?" |

---

## 3. Email catalogue

Seeded in `email_types`. **Audience:**
- **team**: members of the workspace, always on their **sign-in email** (`auth.users.email`, read at send time). The app keeps no other address for a member. Billing emails may also go to the extra billing contacts a workspace owner adds in Settings → Billing.
- **holder**: whoever signs in to a sender account, resolved by `sender_email_recipients` (sender lifecycle §5.8.1). For a member's own account (*Mine*) that's the member's sign-in email. For an account marked *Someone else's* it's the outside address, with the member who connected the account copied. Callers pass the sender, never an address; `sendEmail` rejects an explicit `to` for holder emails.
- **client**: client viewers (on their sign-in email) and client contacts.
- **auth**: Supabase Auth.

**Domain rule:** `platform` = always GrowthxAI · `brand` = customer domain when usable, otherwise GrowthxAI. For holder emails, `brand` applies only when the recipient is an outside holder; to a member they come from the platform domain like any team email (D7).

| Key | Audience | Domain | Safety-critical | Source spec |
|---|---|---|---|---|
| `team_invite` | team | platform | no | platform FR-WS-04 |
| `reply_alert`, `mention`, `ai_handoff`, `assignment` | team | platform | no | reply notifications, AI replies |
| `manager_daily_digest` | team | platform | no | AI replies §13.3 |
| `sequence_stalled`, `sender_paused`, `removal_pending`, `health_alert` | team | platform | no | platform, sender lifecycle |
| `sender_disconnected_team` (combined, 4 h after the sign-in email) | team | platform | no (preference, default on) | sender lifecycle §5.8.3 |
| `sender_mass_disconnect` | team | platform | **yes** | sender lifecycle §5.8.4 |
| `billing_payment_failed`, `billing_action_required`, `billing_reminder`, `billing_suspension_tomorrow`, `billing_suspended`, `billing_removal_warning`, `billing_accounts_removed`, `billing_deletion_warning`, `billing_data_deleted`, `billing_reactivated`, `billing_plan_ending` | team (owners + billing contacts) | platform | **yes** | sender lifecycle §5.9, §5.10 |
| `export_ready` | team | platform | no | platform FR-IO-02 |
| **Holder emails: the only emails that can reach an outside address** | | | | |
| `sender_connect_request` (person asked to connect their account) | holder | brand | no | platform US-01 |
| `sender_connected_notice` (outside holders only: "{workspace} connected your account", with disconnect link) | holder | brand | **yes** | sender lifecycle §5.8.1 |
| `sender_reconnect_needed`, `sender_reconnect_manual` and reminders | holder | brand | **yes** | platform F6, sender lifecycle §5.8.2 |
| `ai_reply_consent_request` (outside holders only; members grant in the app) | holder | brand | **yes** | AI replies §4.1 |
| `profile_authority_request` (outside holders only; members grant in the app) | holder | brand | **yes** | profile management §4.2 |
| `profile_change_applied` (diff + revert link) | holder | brand | **yes** | profile management §4.3 |
| `sender_removed_notice`, `sender_auto_remove_notice`, `sender_erase_notice` | holder | brand | **yes** | sender lifecycle §3.4, §5.6 |
| `sender_holder_changed` (to the old outside address; to a member set as holder by someone else) | holder | brand | **yes** | sender lifecycle §5.8.1 |
| `sender_removal_billing_notice`, `sender_reconnect_after_billing` | holder | brand (platform while the workspace is suspended, since its domain is paused) | **yes** | sender lifecycle §5.9 |

`ai_reply_owner_digest` is retired: members see what the AI sent in the app, and it isn't one of the holder email kinds, so it doesn't go to outside holders (sender lifecycle open question 9).
| `client_viewer_invite` | client | brand | no | platform §11.3 |
| `client_report` | client | brand | no | MCP `report_client`, reports |
| `auth_magic_link`, `auth_signup`, `auth_recovery`, `auth_invite`, `auth_email_change`, `auth_reauthentication` | auth | brand only per D8, else platform | **yes** | Supabase Auth |

Rules attached to the catalogue:
- Every holder email **to an outside holder** includes, in the footer, "Sent on behalf of {workspace or client name} via GrowthxAI" and **Disconnect my account** (sender-lifecycle §4), linking to `app.growthxai.com`. A workspace can't remove this footer. The copy to the connecting member shows the same email with a banner "Copy: sent to avi@client.com" and no disconnect link (the link is the holder's alone).
- Holder emails to a member's own account carry **Open in GrowthxAI** instead of the disconnect link.
- No team, client or reply-notification email is ever sent to an outside holder's address.
- Safety-critical emails ignore workspace notification settings and can't be turned off.
- A new email type must be added to the catalogue before code can send it (`sendEmail` rejects unknown keys).

---

## 4. Setting up a domain

**Settings → Email sending** (owner and managers; Scale and Enterprise).

### 4.1 Steps

1. **Choose the domain.** Field pre-filled with `notify.` + the workspace's website domain. Checks before anything is created:
   - valid hostname, at most 2 levels under a registrable domain;
   - not already active in another workspace (unique across the platform). If it is: "This domain is in use by another GrowthxAI workspace. Contact support";
   - warning (not blocking) if it equals the domain of any mailbox sender in the workspace or the root of one: "This looks like the domain you send outreach from. Use a subdomain like notify.acmegrowth.com so outreach complaints don't affect these emails."
2. **Create.** F56 calls `resend.domains.create({ name, region })`. Region `eu-west-1` by default; `us-east-1` if the workspace is set to US data. Then `resend.apiKeys.create({ name: 'ws:{workspace_id}:{domain}', permission: 'sending_access', domain_id })`. The key token is returned only once: it's stored encrypted (§6) immediately.
3. **Add DNS records.** Table of the records from Resend (type, host, value, priority), each with a copy button and its own status (Not found / Pending / Verified / Failed):
   - SPF: `MX` and `TXT` on `send.<domain>`;
   - DKIM: `TXT` on `resend._domainkey.<domain>`.
   Plus: **Email these records to my IT person** (sends the table to an address they enter, from the platform domain), and short guides for Cloudflare, GoDaddy, Namecheap, Squarespace (Google Domains), Hostinger, Route 53. The most common mistake is called out: providers that add the domain to the host name automatically (`send.notify.acme.com.notify.acme.com`).
4. **Verify.** **Check now** calls `resend.domains.verify(id)`. Afterwards the status updates by itself from the `domain.updated` webhook, backed by F59 checks every 10 minutes for 72 hours, then hourly for 7 days. After 7 days unverified: state `failed`, email to the person who started it.
5. **Sender identity.**
   - From name (default: workspace or client name)
   - From address local part (default `notifications`)
   - Reply-to (required): a real address they read, e.g. `support@acmegrowth.com`. Shown on every branded email so replies go to them, not to us
   - Logo, accent colour, footer line (optional)
6. **Send a test.** To the current user's address. Shows Sent → Delivered from the webhook, or the bounce reason.
7. **Turn on.** The domain becomes `active`. Every `brand` email type uses it from now on; the page lists them, read-only.

### 4.2 DMARC check

F56 and F59 look up `_dmarc.<root domain>` over DNS-over-HTTPS (Edge Functions have no raw DNS). No record → warning: "Gmail and Yahoo expect a DMARC record on domains that send to them. Ask your IT person to add one (p=none is enough to start)." Not blocking.

### 4.3 Per-client domains (Enterprise)

Same flow from **Clients → {client} → Email sending**. Resolution order for a client-scoped email: client's active domain → workspace's active domain → GrowthxAI.

---

## 5. Sending

### 5.1 One path for every email

`/supabase/functions/_shared/email.ts` exports one function. No other code sends email.

```ts
sendEmail({
  workspace_id, client_id?,      // context for branding and logging
  type,                          // key from email_types
  to,                            // one address
  data,                          // template variables
  idempotency_key,               // e.g. `${type}:${entity_id}:${version}`
}): Promise<{ outbox_id }>
```

It renders the template, decides the domain (§5.2), writes an `email_outbox` row and enqueues it. F27 (renamed `email-outbox`) sends it.

### 5.2 Choosing the domain

```
domain_for(type, workspace_id, client_id):
  if email_types[type].domain_rule == 'platform': return PLATFORM
  if plan(workspace) == 'launch':                 return PLATFORM
  d = active_domain(client_id) ?? active_domain(workspace_id)
  if d is null:                                    return PLATFORM
  if d.state != 'active' or d.paused:              return PLATFORM (fallback_reason = d.state)
  if d.sent_today >= d.daily_cap:                  return PLATFORM (fallback_reason = 'warmup_cap')
  return d
```

`PLATFORM` = `notifications@updates.growthxai.com`, its own Resend domain and key, separate from any domain GrowthxAI uses for outreach.

### 5.3 Sending and fallback (F27 `email-outbox`)

Every 15 s, take up to 50 due outbox rows (`for update skip locked`):
1. Send with the chosen domain's key: `from: "{from_name}" <{local}@{domain}>`, `reply_to`, `tags: [workspace_id, email_type]`, `headers: {'Idempotency-Key': idempotency_key}`.
2. Success → `status='sent'`, store `resend_email_id`.
3. Error that points at the domain (domain not verified, key revoked, domain not allowed for key) → pause the domain (`paused_reason='send_error'`), notify the workspace's owners on the platform domain, and **resend the same email from PLATFORM immediately** with `fell_back=true`.
4. Rate limit or 5xx → retry at +30 s, +2 min, +10 min, +1 h. A safety-critical email that still hasn't sent after the third try is retried from PLATFORM.
5. Invalid recipient → `failed`, no retry, shown in the log.

Duplicate protection: `email_outbox.idempotency_key` is unique per workspace; `sendEmail` returns the existing row instead of creating a second one.

### 5.4 Delivery tracking (F57)

Resend webhook endpoint (signature verified) for `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed`, `email.suppressed`, and `domain.updated`, `domain.deleted`:
- Email events update `email_log.status` and append to `email_log.events`.
- A hard bounce on a safety-critical holder email to an outside address creates a task for the connecting member and the workspace's managers: "The sign-in email to priya@client.com bounced. Check who signs in to this account." (A bounce on a member's sign-in email goes to the workspace owners: that member's login email is wrong.)
- `domain.updated` updates the domain's `resend_status` and per-record statuses. `verified` → state `active` if the user already confirmed sender identity, else `ready`. `failed` or `partially_failed` on an active domain → pause, fall back, notify.
- `domain.deleted` (deleted outside the app) → state `removed`.

### 5.5 Domain health

F59 nightly, per active domain, last 7 days:

| Signal | Threshold | Action |
|---|---|---|
| Hard bounce rate | > 4% with at least 25 sends | Pause, fall back, notify owners |
| Complaint rate | > 0.1% with at least 100 sends, or any 3 complaints | Pause, fall back, notify owners |
| DNS records | Any record no longer found | Pause, fall back, notify owners with the missing record |
| DMARC | Missing | Warning only |

Re-enabling after a pause is a button for owners, after the cause is fixed (records re-verified, or a note for bounces/complaints).

### 5.6 New-domain warm-up

Resend asks for a warm-up on each new domain. These emails are low-volume and expected by their recipients, so the cap is simple: 50 brand emails a day for the first 7 days, 200 a day for days 8–14, then no cap. Anything over the cap goes from PLATFORM the same day (`fallback_reason='warmup_cap'`) instead of waiting.

---

## 6. Data model

```sql
-- 0NN_sending_domains

create table sending_domains (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  client_id         uuid references clients(id) on delete cascade,   -- null = workspace domain
  domain            citext not null,
  resend_domain_id  text unique,
  resend_api_key_id text,
  region            text not null default 'eu-west-1',
  state             text not null default 'setup'
      check (state in ('setup','verifying','ready','active','paused','failed','removed')),
  resend_status     text,          -- Resend: not_started | pending | verified | partially_verified | partially_failed | failed
  records           jsonb not null default '[]',  -- [{record, type, name, value, priority, status}]
  from_name         text,
  from_local_part   text not null default 'notifications'
      check (from_local_part ~ '^[a-z0-9._-]{1,64}$'),
  reply_to          citext,
  branding          jsonb not null default '{}',  -- {logo_path, accent, footer}
  dmarc_found       boolean,
  verified_at       timestamptz,
  activated_at      timestamptz,
  paused_at         timestamptz,
  paused_reason     text check (paused_reason in ('send_error','dns','bounces','complaints','manual','plan')),
  warmup_started_at timestamptz,
  daily_cap         int,             -- null = no cap
  last_checked_at   timestamptz,
  created_by        uuid references auth.users(id),
  created_at        timestamptz not null default now(),
  removed_at        timestamptz
);
create unique index sending_domains_live_domain on sending_domains(domain) where state <> 'removed';
create unique index sending_domains_one_per_scope on sending_domains(workspace_id, coalesce(client_id, '00000000-0000-0000-0000-000000000000'))
  where state <> 'removed';

create table private.sending_domain_keys (
  sending_domain_id uuid primary key references sending_domains(id) on delete cascade,
  api_key_enc       bytea not null,    -- pgsodium, key in Vault
  created_at        timestamptz not null default now()
);

create table email_types (
  key             text primary key,
  audience        text not null check (audience in ('team','holder','client','auth')),
  domain_rule     text not null check (domain_rule in ('platform','brand')),
  safety_critical boolean not null default false,
  template        text not null           -- template file name
);
-- seeded with §3

create table email_outbox (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid references workspaces(id) on delete cascade,  -- null for platform-level auth before a workspace exists
  client_id        uuid,
  type             text not null references email_types(key),
  to_address       citext not null,
  subject          text not null,
  html             text not null,
  text_body        text,
  sending_domain_id uuid references sending_domains(id),             -- null = PLATFORM
  from_address     text not null,
  reply_to         text,
  idempotency_key  text not null,
  status           text not null default 'queued'
      check (status in ('queued','sending','sent','failed','cancelled')),
  attempts         int not null default 0,
  next_attempt_at  timestamptz not null default now(),
  fell_back        boolean not null default false,
  fallback_reason  text,
  resend_email_id  text,
  last_error       text,
  created_at       timestamptz not null default now(),
  sent_at          timestamptz
);
create unique index on email_outbox(coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'), idempotency_key);
create index on email_outbox(status, next_attempt_at) where status in ('queued','sending');

create table email_log (
  outbox_id        uuid primary key references email_outbox(id) on delete cascade,
  workspace_id     uuid,
  type             text not null,
  to_address       citext not null,
  from_address     text not null,
  delivery_status  text not null default 'sent'
      check (delivery_status in ('sent','delivered','delayed','bounced','complained','failed','suppressed')),
  bounce_type      text,
  events           jsonb not null default '[]',
  updated_at       timestamptz not null default now()
);
create index on email_log(workspace_id, type, updated_at desc);
create index on email_log(to_address);

select pgmq.create('email_outbox');
```

**Retention.** `email_outbox.html` and `text_body` are cleared after 30 days (they contain links with tokens). `email_log` is kept 13 months.

**RLS.** `sending_domains`: owner/manager read and write through F56 only. `email_log`: owners and managers read their workspace's rows (support view in §8). `email_outbox`, `private.*`: service role only.

---

## 7. Auth emails through the same path (D8)

### 7.1 Setup
- Supabase Auth → Hooks → **Send Email** → HTTPS → F58 `auth-send-email`, deployed with `--no-verify-jwt`, verifying the hook signature with the hook secret from Vault.
- With the hook enabled, Supabase stops using SMTP for these emails. **Keep the Resend SMTP settings filled in anyway**: if F58 breaks, disabling the hook in the dashboard makes Supabase fall back to SMTP within seconds. This is in the runbook.

### 7.2 Behaviour
1. Receive `{ user, email_data: { token, token_hash, redirect_to, email_action_type, site_url, token_new, token_hash_new } }`.
2. Build the link(s) from `site_url`, `token_hash` and `redirect_to`, per action type. For `email_change` with secure change on: two emails — `token_hash_new` + `token` go to the **current** address (`user.email`), `token_hash` + `token_new` to the **new** address (the `_new` suffix does not mean the new address).
3. Decide branding: brand only if every membership of the user is `client_viewer` and all of them sit in workspaces (or clients) that resolve to the **same** active domain. Otherwise PLATFORM.
4. **Send directly, not through the queue** (the user is waiting): branded domain with a 3 s timeout; on any error, PLATFORM with a 3 s timeout; both written to the outbox and log as already-sent rows.
5. Both failed → return HTTP 500 with the error, so Supabase shows the failure to the user instead of a silent "check your email".

---

## 8. UI

### 8.1 Settings → Email sending
- Status card: domain, state chip (Setup · Verifying · Ready · Active · Paused · Failed), "Emails to your clients and account owners come from notifications@notify.acmegrowth.com", warm-up progress, last 7 days delivered / bounced / complained.
- Records table with per-record status and copy buttons, **Check now**, **Email to IT person**.
- Sender identity and branding form, **Send test**.
- **Which emails use this domain** (read-only list from §3) and, separately, **Always from GrowthxAI** (team emails, safety footer).
- Pause / Resume, Remove domain (deletes the Resend domain and key; emails go from GrowthxAI from then on).
- Banner when paused, with the cause and the fix.

### 8.2 Email log (owners and managers)
**Settings → Email log**: filter by type, recipient, status, date. Each row: time, type, to, from (shows "GrowthxAI (fallback: DNS)" when it fell back), status with events timeline. Search by recipient answers "did the account holder get the consent email?". Bodies aren't shown (tokens).

### 8.3 Elsewhere
- Sender page: last holder email sent and its status ("Sign-in email to priya@client.com · bounced 26 Oct").
- Platform admin (health page): domains by state, fallback rate, bounce and complaint rates, outbox backlog, auth hook errors.

---

## 9. Lifecycle of a domain

| Event | Effect |
|---|---|
| Plan downgraded below Scale | All domains `paused_reason='plan'`; email goes from GrowthxAI; domains removed after 30 days unless the plan returns |
| Workspace deleted / trial data deleted | Resend domain and key deleted, row `removed` |
| Client deleted | That client's domain removed |
| Domain removed by the customer | Resend domain and key deleted; queued emails re-resolved to the next domain in §5.2 |
| Domain deleted in Resend directly | `domain.deleted` → `removed`, owners notified |
| DNS records removed later | `domain.updated` (or F59) → pause, fall back, notify with the missing record |

---

## 10. Functions

| Fn | Trigger | Purpose |
|---|---|---|
| F27 `email-outbox` (changed from `notify`) | cron every 15 s, queue | §5.3 |
| F56 `sending-domain` | HTTP, owner/manager | Create, verify, update identity, test, pause, resume, remove; DMARC lookup |
| F57 `resend-webhook` | HTTP from Resend, signature verified | §5.4 |
| F58 `auth-send-email` | Supabase Send Email Hook | §7 |
| F59 `worker-sending-domains` | cron every 10 min (verification), nightly 04:00 UTC (health, warm-up caps, cleanup) | §4.1 step 4, §5.5, §5.6, §9 |

```sql
select cron.schedule('email-outbox',          '15 seconds',   $$select ops.invoke('email-outbox')$$);
select cron.schedule('sending-domains-check', '*/10 * * * *', $$select ops.invoke('worker-sending-domains?mode=verify')$$);
select cron.schedule('sending-domains-daily', '0 4 * * *',    $$select ops.invoke('worker-sending-domains?mode=daily')$$);
```

Every existing `notify(...)` call is replaced with `sendEmail(...)` and a catalogue key. A lint rule fails the build on any direct Resend or SMTP call outside `_shared/email.ts`.

---

## 11. MCP

- `workspace_context` adds `sending_domain: {domain, state, paused_reason}` per workspace and client.
- New read tool `email_log_search(to?, type?, status?, since?)` (managers+), so "did the reconnect email reach Priya?" can be answered in chat.
- No write tools: DNS and domain setup stay in the app.

---

## 12. Edge cases

| Case | Behaviour |
|---|---|
| Customer adds records with the domain appended twice | Records show Not found; the guide explains the fix; F59 keeps checking for 7 days |
| Domain verified but sender identity not filled in | State `ready`, not used until **Turn on** |
| Same domain entered by a second workspace | Blocked by the unique index; support handles transfers |
| Customer uses their outreach root domain | Allowed after the warning; health checks pause it fast if complaints rise |
| Customer's DMARC is `p=reject` and alignment fails | Resend's DKIM signs with the customer's domain, so alignment passes; if it doesn't, bounces trigger the health pause |
| Key revoked in Resend by mistake | First send fails → pause, fall back, notify; **Resume** creates a new key |
| Safety email during a pause | Goes from GrowthxAI with the on-behalf-of footer |
| Warm-up cap reached | Overflow from GrowthxAI the same day |
| Reply to a branded email | Goes to the customer's reply-to, never to us |
| Reply to a platform email | `support@growthxai.com` |
| Client viewer in two agencies' workspaces | Auth emails from GrowthxAI (D8) |
| Auth hook down | Users see an error; runbook: disable the hook, SMTP takes over |
| Email change with secure change | Two emails, tokens paired per §7.2 |
| Recipient on Resend's suppression list | `email.suppressed` → log status `suppressed`; holder emails create the same task as a bounce |

---

## 13. Rollout

| Phase | Contents |
|---|---|
| **1** | `email_types` catalogue, `sendEmail`, outbox, log, F27 rewrite, F57 delivery webhooks, platform domain `updates.growthxai.com`, all existing emails moved onto it, lint rule. No customer-visible change except the safety footer on emails to outside holders |
| **2** | F56 setup flow, F59 verification, sender identity, test send, DMARC warning, Scale workspaces on Kaptured's own workspace first |
| **3** | `brand` routing, fallback, health pauses, warm-up caps, email log UI, sender-page delivery line |
| **4** | F58 Auth hook (branded client-viewer logins), Enterprise per-client domains, MCP read tools |

---

## 14. Tests

- **Routing:** each catalogue key × plan × domain state returns the expected domain (table test).
- **Fallback:** domain-not-verified error on send → one email delivered from PLATFORM, `fell_back=true`, domain paused, owners notified; no duplicate.
- **Idempotency:** the same `sendEmail` twice → one outbox row, one email.
- **Safety:** a safety-critical email with every brand failure mode (unverified, paused, key revoked, cap reached, 5xx ×3) is delivered.
- **Webhooks:** signature check; `domain.updated` with each status; bounce on a holder email creates the task.
- **Auth hook:** each `email_action_type`, secure email change token pairing, branding rule for single- vs multi-workspace client viewers, both-domains-down returns 500.
- **Lint:** a direct Resend call outside `_shared/email.ts` fails CI.
- **Retention:** bodies cleared after 30 days; log kept.

---

## 15. Open questions

1. **Resend plan and domain add-on.** Confirm the domain count on our Resend plan and the add-on price before setting the Enterprise per-client limit at 10.
2. **API rate limit.** One Resend account sends for every customer. Confirm our team's request-rate limit and ask for an increase before phase 3, as Resend's multi-tenant guide suggests.
3. **Custom return path.** If Resend supports a custom return-path subdomain on domain creation, use it so bounces align with the customer's domain. Check the domains API reference.
4. **DNS-over-HTTPS provider** for the DMARC lookup (Cloudflare `1.1.1.1` or Google) and its rate limits.
5. **Auth hook timeout.** Confirm Supabase's timeout for HTTP hooks; the 3 s + 3 s send budget in §7.2 must fit inside it.
