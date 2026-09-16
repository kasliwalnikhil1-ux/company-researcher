# PRD — Smartlead MCP Layer

**Owner:** Aarushi · **Status:** Draft · **Scope:** internal email ops only

---

## 1. Context

The outreach platform runs LinkedIn through Unipile and email through Smartlead. Smartlead is a **single internal account** — our own agency mailboxes, our own prospecting. No client mailboxes, no per-tenant API keys, no reselling.

This PRD covers only the **MCP layer**: how an agent (Claude in chat, or a scheduled Claude job) reads and acts on Smartlead. It does not cover the sequencing runtime.

## 2. The split — read this before building

| Lane | Transport | Used for |
|---|---|---|
| **Runtime** | Smartlead REST API + webhooks → Supabase | Sending, reply capture, state machine, anything on a timer |
| **Agent** | Smartlead MCP | Reply drafting and approved sending, triage, diagnosis, copy edits, one-off campaign setup |

The line is **cold vs warm**, not read vs write.

- **Cold sequence sends** — automated, scheduled, to people who never asked — stay on REST. An agent deciding when to fire is not a scheduler.
- **Replies to a human who already wrote back**, sent one at a time on explicit approval, are the primary job of this layer.

## 2b. Primary workflow — approved reply

1. Agent pulls new replies from the master inbox.
2. For one lead: reads the full thread, drafts a reply in chat.
3. Aarushi edits in chat until it reads right.
4. Aarushi approves the exact final text.
5. Agent calls `reply_to_thread`, which posts into the existing thread from the mailbox that owns it.
6. Send is logged to Supabase with the approved body and timestamp.

Nothing sends without step 4. One approval equals one send — no batching five drafts behind a single yes.

## 3. Goals

- Run daily email ops in natural language instead of the Smartlead UI.
- Catch mailbox burn before it costs a domain.
- Let the same agent session see LinkedIn (Unipile) and email (Smartlead) state together.

## 4. Non-goals

- Multi-tenant / client-facing Smartlead access.
- Exposing MCP to anyone outside the team.
- Replacing the Supabase sequence engine.
- Lead sourcing or enrichment (separate concern).

## 5. Tool surface required

Smartlead's own MCP ships 116+ tools. We do not want all of them in context. Ship a **filtered allowlist** of roughly 20, grouped below.

### Read — mailbox health (highest value)

- `list_email_accounts` — all connected mailboxes, per-account config
- `get_warmup_status` — warmup state, warmup reputation per mailbox
- `get_account_deliverability` — bounce rate, spam rate, sends today
- `smart_delivery_test_results` — placement test outcomes (inbox / promos / spam)

### Read — campaigns and performance

- `list_campaigns` — id, status, mailboxes attached
- `get_campaign_analytics` — sent, open, reply, bounce, positive-reply counts
- `get_campaign_sequences` — current steps and copy
- `get_campaign_settings` — schedule, daily cap, rotation set

### Read — inbox and leads

- `list_replies` — master inbox, filtered by campaign / category / date, paginated
- `get_reply` — single thread by id
- `count_replies` — fast count for a daily digest
- `list_campaign_leads` — leads and their status in a campaign
- `list_lead_categories` — the category vocabulary

### Write — send

- `reply_to_thread` — the core tool. Wraps `POST /campaigns/{campaign_id}/reply-email-thread`. Replies in-thread to a lead from the master inbox, from the sender mailbox that owns the conversation.
  - Required: campaign id, thread/message reference, body.
  - Optional: `to` / cc / bcc (defaults to the lead), `add_signature` (default true), attachments.
  - Gated: fires only on explicit approval of the exact body.

### Write — scoped, reversible

- `pause_campaign` / `resume_campaign`
- `pause_lead` — stop follow-ups on one lead
- `update_lead_category` — mark Interested / Not now / Do not contact
- `update_campaign_schedule` — `POST /campaigns/{id}/schedule`. Controls *when the campaign sends*: `timezone`, `days_of_the_week` (1–5 for weekdays), `start_hour` / `end_hour`, min time between emails, max new leads per day.
- `update_campaign_settings` — daily cap, mailbox rotation set, tracking toggles.
- `update_campaign_sequences` — `POST /campaigns/{id}/sequences`. Controls *the steps and their spacing*. Each step carries `seq_number`, `seq_delay_details: { delay_in_days }`, and variants with `subject`, `email_body` (HTML) and `variant_label` for A/B. Three rules the tool description must state outright:
  - **The save replaces the entire sequence.** Always read the current sequence first and send every step back, or the omitted ones are gone.
  - **Cannot modify while the campaign is ACTIVE.** Pause, edit, resume — as one atomic operation in the tool, not three the agent might half-finish.
  - **Blank subject on step 2+ threads it as a reply** to step 1. Never "helpfully" fill in a missing subject.
- `get_campaign_sequences` — read before any write above; returns step ids, delays, bodies and variants.
- `add_leads_to_campaign` — `POST /campaigns/{id}/leads`. Max 400 leads per request. Body is a `lead_list` array (email, first/last name, company_name, phone_number, website, location, linkedin_profile, company_url, `custom_fields` as free key-value pairs) plus a `settings` object: `ignore_global_block_list`, `ignore_unsubscribe_list`, `ignore_community_bounce_list`, `ignore_duplicate_leads_in_other_campaign`, `return_lead_ids`. All four ignore flags stay **false** — the agent never overrides a block list or an unsubscribe. Response returns `added_count`, `skipped_count` and `skipped_leads` with reasons; surface the skipped ones rather than swallowing them.
- `create_draft_campaign` — new campaign, always in DRAFTED status

### Explicitly excluded

Delete tools, mailbox disconnect, domain/mailbox purchase (Smart Senders), credit-consuming prospect search. An agent should never spend money or destroy state.

## 6. Guardrails

1. **Approve the exact text.** The body that goes on the wire is the body shown in chat, verbatim. No rewriting, tightening or re-personalising between approval and the call. Same pattern already used for client-portal replies.
2. **One approval, one send.** Never batch. Never infer approval from "looks good, do the rest".
3. **Reply only into existing threads.** No tool that opens a new cold thread with an arbitrary address.
4. **No campaign START.** Setting a campaign to START begins real cold sending from connected mailboxes — that stays a human action in the UI. New campaigns land in DRAFTED.
5. **Adding leads to a live campaign is a send.** A lead added to a running campaign gets cold-emailed at the next sending window, with no further approval. So: adding to a DRAFTED or PAUSED campaign is routine; adding to one in START requires the count, the campaign name and an explicit yes first.
6. **Skip the non-humans.** Before drafting, check the thread: out-of-office, bounce notifications and auto-responders get categorised, not answered. An unsubscribe or "stop contacting me" gets categorised Do Not Contact and no reply.
7. **Audit trail.** Every send writes to Supabase: lead, campaign, mailbox, approved body, timestamp. If it is not in the log it did not happen.
8. **Session cap.** A ceiling on sends per session, so a loop or a misread never turns into fifty emails.
9. **Pagination bounded.** Reply and lead listings pull one page at a time with an explicit cap, so a broad question does not dump the account into context.

## 7. Workflows it must support day one

- **Morning digest** — new replies since yesterday, categorised, with the positive ones surfaced first, plus any mailbox whose bounce or spam rate moved.
- **Burn check** — which mailboxes are over bounce threshold, which are still warming, which should be pulled from rotation today. Output is a pause/reduce recommendation, applied only on confirmation.
- **Reply triage and send** — read a thread, categorise the lead, pause its follow-ups, draft the reply, send on approval. This is the one that has to feel fast: reading a reply and having a good draft waiting should take one message.
- **Copy iteration** — read a sequence's step-level reply rates, propose new copy, update the sequence after approval.
- **Cross-channel view** — for a named prospect, show LinkedIn state from Supabase alongside Smartlead campaign state, so the same person is not hit twice in one day.

## 8. Success criteria

- Every reply answered from chat, without opening the Smartlead UI.
- Median time from a lead replying to our reply landing drops below an hour on working days.
- A mailbox going bad is caught by the digest, not by a reply-rate drop two weeks later.
- Zero sends that were not approved verbatim.

## 9. Open questions

- Which MCP build: Smartlead's own, or the LeadMagic community server? Official first, for maintenance.
- Does the Smartlead plan issue scoped or read-only API keys?
- Does the cross-channel view live as an MCP tool over Supabase, or as direct DB access in the same session?
- Does the chosen MCP build actually expose the reply endpoint, or only reads? If not, wrap `reply-email-thread` ourselves as a one-tool MCP alongside it.
- Does a reply sent through the API count against the mailbox's daily sending limit, and does it pause that lead's remaining sequence steps automatically or do we have to pause explicitly?
- Signature: Smartlead's stored per-mailbox signature, or written into the body?
