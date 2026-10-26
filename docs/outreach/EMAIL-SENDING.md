# Email sending: one path, an outbox, a log, and the customer's own domain

Reader: an engineer who maintains the outreach app. Built 26 Oct 2026 from `custom-sending-domain-PRD.md` v1.2 (phases 1–4 of its rollout; see the state of each at the end). Companion to [SENDER-LIFECYCLE.md](SENDER-LIFECYCLE.md) (who gets which email).

| Where | What |
|---|---|
| `migrations/outreach/099_email_outbox_sending_domains.sql` | catalogue `outreach_email_types`, `outreach_email_outbox`, `outreach_email_log`, `outreach_sending_domains` + `_keys`, the domain chooser, the outbox functions, delivery events + the bounce task, the reads, health / warm-up / plan sync / retention, the dispatcher rows and the nightly job |
| `migrations/outreach/102_email_log_offset.sql` | `outreach_email_log_search` gains `p_offset` (default limit 50): the log pages server-side with the shared `PaginationBar` |
| `migrations/outreach/tests/smoke_29_email_outbox.sql` | 50 assertions over the chooser, the queue, fallback, retries, events, the bounce task, the reads, domain checks, housekeeping (rolls back) |
| `supabase/functions/_shared/outreach/email.ts` | **the one sending path**: `sendEmail`, `sendHolderEmail`, `sendTeamEmail`, `outboxTick`, the direct send. The only file that calls Resend's send endpoint (`scripts/check-email-path.mjs` fails the build otherwise) |
| `_shared/outreach/notify.ts` | rendering (`layout`, `button`) and the typed senders (`notifySender`, `notifyWorkspace`, `notifyInvitation`); its positional `sendEmail(to, subject, html, text, {type, …})` queues through email.ts and needs a catalogue type |
| `_shared/outreach/resend_domains.ts` | Resend domains + domain-scoped API keys, DNS-over-HTTPS DMARC lookup, registrable root |
| `_shared/outreach/sending_domains.ts` | F56 actions (create · verify · identity · test · activate · pause · resume · remove · email records · DMARC) and F59 (verification tick, nightly run) |
| `_shared/outreach/webhook_sig.ts` | Standard Webhooks signature check (Resend's Svix headers, Supabase's hook headers) |
| `outreach-email-outbox` (F27) · `outreach-sending-domain` (F56) · `outreach-resend-webhook` (F57) · `outreach-auth-send-email` (F58) · `outreach-worker-sending-domains` (F59) | the functions |
| Settings → Email & booking → Sending domain (the first sub-tab; the others are Tracking domain · Unsubscribe link · Meeting booking · Email log, each its own route under /settings/email) · Clients → {client} → Email sending · Settings → Admin (the catalogue: which emails use a brand domain, which always come from the platform; operator knowledge, not shown to customers) · Settings → Admin → Health (email card) | the pages |

## How an email travels

1. A caller renders the HTML (`layout`) and calls `sendEmail` with a **catalogue type** (`outreach_email_types`: audience `team` · `holder` · `client` · `auth` · `platform`, domain rule `platform` · `brand`, `safety_critical`, an optional notification preference). Unknown types are refused by the database.
2. `outreach_email_enqueue` chooses the domain (`outreach_email_domain_for`, PRD §5.2): platform types, holder emails to a member, Launch plans, no domain, a domain that is not active or is paused, or a domain past its warm-up cap → the platform address (`fallback_reason` says why). Otherwise the workspace's domain, or the client's domain for a client-scoped email. The row is written with an idempotency key (`unique (workspace, key)`: the same email is sent once).
3. The dispatcher calls `outreach-email-outbox` every 15 s while a row is due. It sends with the domain's key (AES-GCM encrypted in `outreach_sending_domain_keys` with `OUTREACH_COOKIE_KEY`) or the platform key, with `Idempotency-Key` and tags. Outcomes: `sent` → log row; `domain_error` (403 / 422 naming the domain or key) → the domain is **paused** (`send_error`), the owners are emailed from the platform, and the same row is re-queued from the platform at once with `fell_back`; `transient` (429 / 5xx / network) → +30 s, +2 min, +10 min, +1 h, then failed, except a safety-critical brand email, which moves to the platform after the third try; `invalid` → failed, shown in the log.
4. Resend's webhooks (`outreach-resend-webhook`, Svix signature) update `outreach_email_log.delivery_status` and append `events`. A hard bounce or suppression on a holder email opens a `follow_up` task (`node_id = 'email_bounce'`) for the connecting member (outside holder) or the owners (a member's sign-in email is wrong). `domain.updated` / `domain.deleted` keep the domain row true.

**Holder emails** (`sendHolderEmail`) never take an address: `outreach_sender_email_recipients(sender, 'holder')` resolves whoever signs in to the account. An outside holder gets the "Sent on behalf of {workspace} via GrowthxAI" footer and the single-use **Disconnect my account** link bound to that address; the connecting member (or the owners) gets a "Copy: sent to …" without the link. A member's own account gets **Open in GrowthxAI** on the platform domain. `audience: 'outside_only'` is used for the connected notice, consent and profile-authority requests (members grant those in the app).

**Team emails** (`sendTeamEmail`) go to owners and managers on their **sign-in emails** (`auth.users.email`, read at send time), each one checked against their notification preference for the type (safety-critical types ignore it).

**Direct sends** (the auth hook, the domain test) bypass the queue but still write outbox + log rows (`direct: true`).

## Setting up a domain (F56)

Scale and Enterprise (`outreach_plan_features.custom_sending_domain`; `client_sending_domains` = Enterprise, limit 10). `check` runs the PRD §4.1 rules (hostname, two levels, unique across the platform, root-domain and outreach-mailbox warnings). `create` calls Resend `POST /domains` (region `eu-west-1`, `us-east-1` for a workspace set to US data) and `POST /api-keys` scoped to that domain; the token is encrypted at once. The records come back for the page (`records[]`, each with a status and a `hint` when public DNS cannot see it). `verify` = "Check now"; the dispatcher row `sending-domains-verify` re-checks every 10 min for 72 h, then hourly, and after 7 days unverified the domain fails and the person who started it is emailed. Sender identity (`update`: from name, local part, reply-to required, branding) → `test` (a direct send to the current user) → `activate` (state `active`, warm-up cap 50/day for 7 days, 200 for the next 7, then none). `pause` / `resume` (a DNS or send-error pause re-verifies first; a revoked key gets a new one; bounces / complaints need a note). `remove` deletes the key and the domain on Resend and re-routes queued rows.

**Nightly** (`outreach-sending-domains-daily`, 04:00 UTC): hard-bounce rate > 4 % with ≥ 25 sends or complaints > 0.1 % / any 3 → pause + owners emailed; every active domain re-checked on Resend (records gone → pause `dns`); DMARC flag refreshed; plan sync (below Scale → paused `plan`, 30 days later removed); provider rows deleted for removed domains; retention (bodies cleared after 30 days, log and outbox after 13 months).

## Auth emails (F58)

`outreach-auth-send-email` is the Supabase **Send Email** hook: it builds the verify links from `token_hash` (two emails for a secure email change, tokens paired per PRD §7.2), brands only a pure client viewer whose workspaces resolve to one active domain, sends directly (domain, then platform), and returns 500 when both fail so the user sees an error. **It is deployed but not enabled**: enabling is a dashboard change (Auth → Hooks → Send Email → HTTPS, URI of the function, copy the secret to `SUPABASE_AUTH_HOOK_SECRET`). Keep the Resend SMTP settings filled in: disabling the hook falls back to SMTP within seconds.

## Deviations from the PRD, and why

| PRD | Built | Why |
|---|---|---|
| `pgmq` queue, `private.sending_domain_keys` with pgsodium | a status column on `outreach_email_outbox` claimed with `for update skip locked`; keys AES-GCM encrypted by the edge function | neither extension exists on this project; the cookie-secret scheme already does the same job |
| `email-outbox` on a 15-second pg_cron | a row on the 084 dispatcher (`email-outbox`, every 15 s, only when a row is due) | the dispatcher rule: no sub-minute cron, no call when the queue is empty |
| templates named per type and rendered inside `sendEmail` | callers keep rendering with `layout` and pass the type; `template` in the catalogue names the renderer | ~40 existing senders; the type decides domain, audience and preference, which is the point of the catalogue |
| `sendEmail({type, to, data, idempotency_key})` | the same shape plus `subject`/`html`; holder emails use `sendHolderEmail` (no address), team emails `sendTeamEmail` | see above |
| every email through the outbox | the auth hook and the domain test send directly (the user is waiting) and log afterwards; the flag `email_outbox_enabled = false` makes every send direct (escape hatch) | PRD §7.2 asks for the direct auth send; the flag is for an outbox incident |
| PLATFORM = `notifications@updates.growthxai.com` | the From comes from `OUTREACH_EMAIL_FROM` (live: `updates@updates.growthxai.com`) | the live secret decides; change it there when the mailbox changes |
| Resend's `domain.updated` as the main verification signal | the webhook and the dispatcher tick both call `refreshDomain`; whichever comes first wins | a missed webhook never stalls a setup |
| `email_log` bounce task "for the connecting member and the workspace's managers" | one task assigned to the connecting member (or the first owner), visible to managers in Tasks | one task per bounce, not one per manager |
| health page on the platform admin | `outreach_email_platform_stats()` + an Email card under Settings → Admin → Health | same numbers, existing page |
| `ai_reply_owner_digest` retired | kept for members only (their own account); never sent to an outside holder | PRD open question 9 |

## Rollout state (26 Oct 2026)

| Phase | State |
|---|---|
| 1 catalogue, outbox, log, F27, F57, lint | **LIVE 26 Oct 2026**: `099` applied, `smoke_29` green against the live database, every outreach function deployed |
| 2 F56 setup flow, F59 verification | live (same) |
| 3 brand routing, fallback, health pauses, warm-up caps, log UI, sender-page line | live (same); the web app pages are built but not yet deployed |
| 4 F58 auth hook, per-client domains, MCP read tool | live; **the hook is not enabled** (dashboard step above); `email_log_search` + `workspace_context.sending_domain` on the connector |

Still to do after the deploy (checked 26 Oct 2026: none of the three secrets exist yet; the webhook function answers 503 `E_NOT_CONFIGURED` until then): set `RESEND_WEBHOOK_SECRET` (create the endpoint in Resend → Webhooks pointing at `…/functions/v1/outreach-resend-webhook` with the email.* and domain.* events), set `OUTREACH_PLATFORM_ALERT_EMAIL`, and check that `outreach_email_platform_stats().outbox_backlog` drains (the dispatcher row `email-outbox`). The first customer domain should be Kaptured's own workspace (PRD §13 phase 2).
