# Smartlead MCP layer — setup & runbook

The agent lane for the team's single internal Smartlead account (built from `smartlead-mcp-prd.md`). Everything is prefixed `smartlead_` / `smartlead-` so it stays separable from the investor product, the outreach platform and the CRM. It does **not** cover the sequencing runtime (REST + webhooks → Supabase) — that lane is separate by design.

## What exists

| Piece | Where |
|---|---|
| SQL (members, settings, approval tokens, audit log, call log) | `migrations/smartlead/001_schema.sql` (applied 2026-09-19 as `smartlead_001_schema`) |
| MCP connector (edge function) | `supabase/functions/smartlead-mcp/` → `https://ktwqkvjuzsunssudqnrt.supabase.co/functions/v1/smartlead-mcp/mcp` |
| Claude skill | `claude-skill/smartlead/` (+ `smartlead.zip`) |
| Deploy script | `scripts/smartlead-deploy-functions.sh` |

Function layout: `index.ts` (Hono / Streamable HTTP / OAuth PRM — same skeleton as `crm-mcp`), `ctx.ts` (auth, membership gate, approval tokens, send caps, error contract), `smartlead.ts` (the only file that calls Smartlead; normalisers, auto-reply detection), `tools_mailboxes.ts`, `tools_campaigns.ts`, `tools_inbox.ts`, `tools_leads.ts`, `resources_prompts.ts`. Self-contained (no `_shared` import).

## One thing left to do: the API key

```bash
SUPABASE_ACCESS_TOKEN=$CAPITALXAI_SUPABASE_ACCESS_TOKEN supabase secrets set SMARTLEAD_API_KEY=<key> --project-ref ktwqkvjuzsunssudqnrt
```
(Smartlead → Settings → API.) No redeploy needed. Until then every Smartlead tool returns `E_NOT_CONFIGURED`; `smartlead_whoami` reports `smartlead_api_key_configured`. The key stays in the function: it is a query parameter on Smartlead's API, so `smartlead.ts` redacts it from every error and never logs URLs.

Then connect it in Claude: Settings → Connectors → Add custom connector → the MCP URL above → sign in with a CapitalxAI account that is in `smartlead_members`. Upload `claude-skill/smartlead.zip` as a skill.

## Access

`smartlead_members` — seeded from `crm_members` (the same internal team). Members get all tools; anyone else only `smartlead_whoami`. Add someone: `select smartlead_add_member('person@…');` (run as a member, or as SQL admin insert a row). Deactivate: `select smartlead_set_member_active('<uuid>', false);`.

## Tool surface (26, vs Smartlead's 116+)

- **Mailbox health:** `list_email_accounts`, `get_warmup_status`, `get_account_deliverability`, `smart_delivery_test_results`
- **Campaigns (read):** `list_campaigns`, `get_campaign_analytics`, `get_campaign_sequences`, `get_campaign_settings`
- **Inbox / leads (read):** `list_replies`, `get_reply`, `count_replies`, `list_campaign_leads`, `list_lead_categories`
- **Send:** `reply_to_thread` ⚠
- **Scoped writes:** `pause_campaign`, `resume_campaign` ⚠, `pause_lead`, `update_lead_category`, `update_campaign_schedule`, `update_campaign_settings`, `update_campaign_sequences` ⚠, `add_leads_to_campaign` ⚠ (ACTIVE campaigns), `create_draft_campaign`
- **Added beyond the PRD list:** `prospect_cross_channel` (PRD §7 workflow / §9 open question → an MCP tool over Supabase, read through the caller's RLS), `list_sent_replies` (reads the audit log), `smartlead_whoami`
- **Excluded on purpose:** deletes, mailbox disconnect/suspend, Smart Senders purchases, Smart Prospect search, placement-test creation, campaign START, lead resume, send-single-email.

⚠ = two-step confirmation: first call returns `effect_summary` + `confirmation_token` and does nothing; the second call needs identical arguments + the token.

## How each guardrail (PRD §6) is enforced

| # | Guardrail | Where |
|---|---|---|
| 1 | Approve the exact text | `gate()` in `ctx.ts`: token bound to a SHA-256 of the arguments (body included). The summary shows the body verbatim; a changed character → `E_CONFIRMATION_MISMATCH`. `approved_body` + `body_sha256` are logged. The only transformation is transport: a plain-text body gets `\n` → `<br>` (`toEmailHtml`), stored as `sent_body_html`. |
| 2 | One approval, one send | Token consumed atomically (`update … where used_at is null`), 10-minute TTL, bound to tool + user. No batch tool exists. |
| 3 | Reply only into existing threads | `reply_to_thread` loads the message history and requires an inbound message (`E_NO_INBOUND`). `send-single-email` is not wrapped. |
| 4 | No campaign START | `create_draft_campaign` → DRAFTED. `resume_campaign` refuses anything not PAUSED (`E_NOT_PAUSED`) and is gated. `update_campaign_sequences` sends START only to undo its own pause. |
| 5 | Adding leads to a live campaign is a send | `add_leads_to_campaign` gates unless the status is positively DRAFTED/PAUSED/STOPPED/COMPLETED/ARCHIVED. The four `ignore_*` flags are hard-coded `false`; there is no parameter for them. |
| 6 | Skip the non-humans | `detectAuto()` (bounce / OOO / auto-responder / unsubscribe) flags rows in `list_replies` / `get_reply` and blocks `reply_to_thread` (`E_NON_HUMAN`). Conservative on purpose; a false positive is answered from the Smartlead UI. |
| 7 | Audit trail | `smartlead_reply_log` row inserted `pending` **before** the Smartlead call; insert failure aborts the send (`E_AUDIT_FAILED`); updated to `sent` / `failed`. RLS: members read, only the service role writes. |
| 8 | Session cap | The MCP is stateless per request, so the cap is rolling: `max_sends_per_hour_per_user` (10) and `max_sends_per_day_team` (40), counted from the audit log. `E_SEND_CAP`. Change with `select smartlead_set_setting('max_sends_per_hour_per_user', '15');` |
| 9 | Pagination bounded | replies ≤ 20/page (Smartlead's max), leads ≤ 100/page, mailboxes ≤ 500, `count_replies` ≤ 200 threads; pass-through payloads go through `trim()`. |

Also: if the lead writes again between approval and send → `E_THREAD_MOVED`. Network errors on writes are never retried (the request may have landed). SMTP/IMAP credentials that Smartlead returns on `/email-accounts` are dropped by a whitelist (`mailboxBrief`) and `trim()` strips any `password|secret|token|api_key` key.

## Settings (`smartlead_settings`)

`max_sends_per_hour_per_user` 10 · `max_sends_per_day_team` 40 · `bounce_rate_threshold` 0.03 · `warmup_spam_rate_threshold` 0.05 · `warmup_min_reputation` 90 · `timezone` "Asia/Kolkata". Members change them with `smartlead_set_setting(key, jsonb)`; the agent has no tool for it.

## Deploying

```bash
OUTREACH_DEPLOY_EXTRA_ARGS="--use-api" bash scripts/smartlead-deploy-functions.sh     # --use-api when Docker is not running
cd supabase/functions && deno check --node-modules-dir=none smartlead-mcp/index.ts    # type-check
```
`--no-verify-jwt` is intentional (the `.well-known` document and the 401 challenge must be public; bearer auth is enforced in-function).

## Verified on 2026-09-19 / not yet verified

Verified live: OAuth metadata, 401 challenge, login → `tools/list` (26 tools, 5 prompts, 2 resources), `smartlead_whoami`, membership seeding, `E_NOT_CONFIGURED` path, audit-log read through RLS, reply validation, single-use token SQL, offline tests of the normalisers and auto-reply detection.

**Not verified — no API key was available:** every call that reaches Smartlead. Endpoints and bodies follow `https://api.smartlead.ai/llms-full.txt`, but Smartlead's documented response shapes are inconsistent, so the normalisers read each field from several candidate names and every read tool takes `raw: true` to show the unmodified payload. First session with the key, check in this order:
1. `list_campaigns`, `list_email_accounts` (ids/addresses/warmup filled in?)
2. `list_replies(limit:3, raw:true)` → are `lead_id`, `campaign_id`, `they_wrote` populated?
3. `get_reply` on one thread → does every message have a `stats_id`, and is `reply_target.email_stats_id` set? (`reply_to_thread` refuses to send without it.)
4. `get_account_deliverability(raw:true)` → per-mailbox rows present? If not, the verdicts rest on connection + warmup only (the tool says so).
5. `update_campaign_schedule` on a DRAFTED test campaign — Smartlead's two doc sets disagree on the body (flat `timezone/days_of_the_week/…` per the PRD and the classic API, vs a nested `schedule` object); the flat form is implemented.
6. One real `reply_to_thread` to a seed inbox you own, then `list_sent_replies`.

## PRD open questions — where this lands

- *Which MCP build?* Neither: our own filtered server over the REST API, because the guardrails (verbatim approval, audit-before-send, caps, no START) have to live server-side and neither third-party build has them.
- *Scoped / read-only API keys?* Still open; this design assumes a full key held only in the function secret.
- *Cross-channel view?* An MCP tool (`prospect_cross_channel`) reading `outreach_*` through the caller's RLS.
- *Reply endpoint exposed?* Yes — `reply_to_thread` wraps `POST /campaigns/{id}/reply-email-thread`.
- *Does an API reply count against the mailbox's daily limit / pause the sequence?* Unknown. The skill pauses the lead explicitly (`update_lead_category(pause_lead:true)`) so it does not depend on the answer. Check `sent_today` before/after the first real reply.
- *Signature?* Smartlead's stored per-mailbox signature (`add_signature` default true); the skill tells the agent not to type one.
