# CapitalxAI Outreach vs. GetSales, HeyReach, Expandi, Dripify

**What users love that we already have, and which of their complaints we've solved** (20 Sep 2026)

This maps [linkedin-outreach-tools-review-analysis.md](linkedin-outreach-tools-review-analysis.md) against what is **actually built** in `/outreach`. It is based on the code (SQL, edge functions and UI), not the PRD. When something is only in the PRD, or only reachable through the Claude connector (MCP), it says so.

**Status key:** ✅ Have / Solved · ◐ Partly · ❌ Not built

---

## At a glance

| | Count |
|---|---|
| Loved competitor features we have in full | 11 of 16 |
| Loved competitor features we have in part | 5 of 16 |
| Competitor complaints we solve in full | 17 |
| Competitor complaints we solve in part | 9 |
| Competitor complaints still open for us too | 10 (see Part 3) |

**Strongest story:** multi-sender rotation, LinkedIn + Gmail/Outlook/IMAP in one sequence and one inbox, and layered account-safety limits that the database enforces, so nobody (including an AI agent) can raise volume past them. Session reconnect runs automatically from a Chrome extension, and every reply gets AI intent tagging.

**Biggest honest gap:** a reply on one channel or sender doesn't stop the lead's steps on another. That is the exact complaint Expandi users have ("email replies don't pause the lead").

---

## Part 1: Features users love in other tools that we have

| Loved feature | Loved in | What we have | Status |
|---|---|---|---|
| **Multi-sender rotation** | HeyReach (core appeal), GetSales | Many LinkedIn accounts and mailboxes per workspace. Each sequence has a sender pool with round-robin, least-loaded or fixed assignment, plus "rotate sender" and "change sender" steps. A lead can only be in one live sequence per sender, so the same person never gets double-sequenced from one account | ✅ |
| **Unified inbox** | HeyReach Unibox, GetSales, Dripify | LinkedIn and email threads from every sender in one inbox. Filters for sender, channel, intent, client, unread, "Mine" and archived. Assign to a teammate, archive, mark read/unread, attachments, j/k/e/u shortcuts. You can edit or delete a sent LinkedIn message within 60 min | ✅ |
| **LinkedIn + email in one sequence** | GetSales, Expandi | An email step lives in the same flow as LinkedIn steps, with "bounced" and "no email" branches, open/click tracking and threaded follow-ups. Gmail, Outlook and any IMAP mailbox connect through hosted sign-in | ✅ |
| **Flexible branching builder** | GetSales, Expandi, Dripify (visual) | Drag-and-drop canvas with 25 step types. Branch on replied, accepted, connection degree, bounced, has email, open profile, Premium sender, tag, stage, company, title, headline, location or any custom field. Wait-for-accept has its own timeout branch (default 14 days) | ✅ |
| **Account safety** | All four | Daily caps take the lowest of three limits (platform ceiling, warm-up level, manual cap) and are then scaled by account health. Warm-up levels 0–5 (invites from 4 to 45 a day). Accounts with fewer than 150 connections are held at level 0 for 28 days. Per-sender working hours and timezone, human-like random timing, a proxy per sender, and stale invites withdrawn automatically after 21 days | ✅ |
| **Cloud-based, runs 24/7** | Expandi, Dripify | Everything runs server-side on a schedule. The Chrome extension only keeps the LinkedIn session fresh; it doesn't run the campaign | ✅ |
| **Sales Navigator import** | Expandi, Dripify | Import from LinkedIn, Sales Navigator or Recruiter search URLs (up to 1,000/2,500), from CSV with column mapping, or from your existing connections | ✅ |
| **Wide range of LinkedIn actions** | Expandi, Dripify | Profile visit, like latest post, comment, endorse skills (1–5), invite with note, message, InMail (Classic/Sales Navigator/Recruiter), withdraw invite. While waiting for an invite to be accepted, the sequence can do background visits or likes. Any step can be switched to a manual task | ✅ |
| **Built-in light CRM** | GetSales | Pipeline stages, tags, lists, custom fields, per-lead timeline, tasks, and bulk changes of up to 10k leads at a time. Sequences can set tags, lists and stages as steps | ✅ |
| **Team workspaces** | Expandi, GetSales | Roles: owner, manager, member and client viewer, plus a separate "can reply" permission. Invites go out by email | ✅ |
| **Time savings / automated follow-ups** | All four | Every inbound reply is classified by AI, and "interested" or "question" replies automatically create a follow-up task due in 4 hours. Claude can triage every pending reply and draft answers through the connector | ✅ |
| **Agency / client workspaces** | HeyReach, GetSales | Clients are optional partitions. A client viewer sees only their own client page, with stats, inbox and replies | ◐ No white-label |
| **Rich personalization** | Expandi | Variables with fallbacks (`{{first_name\|there}}`), custom and sender fields, and a live preview on a real lead. An AI copy brief writes a draft that a person approves before it sends | ◐ No spintax, no dynamic images or GIFs |
| **Analytics / A/B testing** | GetSales, Dripify, Expandi | Dashboard (today's usage per sender, 7-day invites, accepts, messages, replies and rates), per-step counts on each sequence, 30-day client stats, CSV exports | ◐ No A/B split step; full per-sequence and per-sender reports exist only through the connector |
| **Integrations** | HeyReach, GetSales, Expandi | Signed outbound webhooks (retries, auto-disable), "call webhook" and "call API" steps inside a sequence, and a Claude connector with about 60 tools | ◐ No public API, no native HubSpot/Salesforce/Pipedrive |
| **Waterfall email enrichment** | GetSales | Not in `/outreach` itself. Found emails can be imported as custom fields or by CSV | ◐ Outside the product |

---

## Part 2: Competitor complaints we have solved

### Solved

| Their complaint | Whose users say it | How we solve it |
|---|---|---|
| **LinkedIn only; needs Smartlead/Zapier for email** | HeyReach | Email is a native channel in the same sequence and the same inbox |
| **Email is Gmail-only** | Dripify | Gmail, Outlook and IMAP |
| **No combined LinkedIn + email inbox** | Dripify | One inbox for both channels, with a channel icon on every thread |
| **No shared inbox; teammates can't reply for each other** | Expandi | Threads can be assigned to teammates, there's a "Mine" filter, and a "can reply" permission per member |
| **No multi-account view; agencies switch accounts by hand** | Dripify, Expandi | All senders in one workspace, each with a sender badge on its threads, and optional client partitions |
| **Session drops; accounts have to be reconnected by hand; one user was down for a month** | HeyReach | LinkedIn status events flip the sender's status as soon as the session breaks. Cookie-mode senders reconnect themselves (hourly, up to 4 tries) using fresh cookies from the Chrome extension, which syncs every 3 hours. Password-mode senders get a hosted reconnect link with reminders. Broken senders show on the dashboard's "attention" list and fire a `sender.disconnected` webhook |
| **Safe volume is far below the advertised 75+ a day** | Dripify | We don't advertise volume that isn't safe. New accounts start at 4 invites a day and step up only after 14 days of good health. Ceilings are 80 invites/day and 150/week, and free LinkedIn accounts are capped at level 1 |
| **Can't see how campaign limits add up against account limits** | Expandi | The dashboard shows each sender's usage today and why it's throttled. The connector's "why not sending" and "sender capacity" tools explain exactly which cap, schedule or health rule is blocking |
| **Easy to produce spammy outreach** | HeyReach | Caps are database rules, so neither users nor the AI agent can raise them. An AI check reviews a sequence before it goes live. Suppression covers domain, profile, email, do-not-contact and unsubscribe. Sequences stop on reply by default |
| **Shallow sequence logic: only accepted / not-accepted, no sub-sequences** | HeyReach | Branch on 15+ conditions, and a "send to sequence" step hands a lead to another sequence |
| **No tagging; no bulk save; messy lead management** | Dripify | Tags, lists, stages, custom fields and bulk operations |
| **Existing LinkedIn connections and messages must be synced by hand** | GetSales | Connecting a sender pulls in its recent chats (150 chats, 30 messages each). Existing connections can be imported as leads. Accepted invites are detected by webhook and by polling |
| **Hard to add steps to a sequence that has already run** | GetSales | Running leads always follow the latest saved flow, so a step added later reaches everyone who hasn't passed that point yet |
| **Duplicate messages or tasks after updates** | GetSales | Every action has a unique idempotency key, a sender claims one action at a time under a database lock, stuck reservations are cleared every 5 min, and inbound messages are de-duplicated by message ID |
| **Weak AI assistant / no AI reply handling** | GetSales, HeyReach | AI classifies every reply (interested, question, not now, not interested, out of office, wrong person, unclear), and you can override it. AI drafts copy and replies for a person to approve, and AI reviews a sequence before it goes live. Claude can run the whole reply triage through the connector |
| **Exports locked on lower plans / need CSV to analyse** | Dripify, Expandi | CSV export of leads, messages, actions and audit log, not gated by plan |
| **7-day trial, card required** | Expandi | 14-day trial with up to 3 senders and no card (see billing caveat below) |

### Partly solved

| Their complaint | Whose users say it | What we do | What's still missing |
|---|---|---|---|
| **Bans despite "safety" claims** | Expandi (major), Dripify, GetSales, HeyReach | Layered caps, warm-up lock for new accounts, health score (below 70 cuts caps to 60%, below 50 pauses 24h), 3 rate-limit errors in an hour pause the sender for 24h, and LinkedIn's weekly invite-limit error blocks invites until the date LinkedIn gives | No tool can guarantee no bans. A proxy is only replaced by hand if it fails |
| **Can't edit live campaigns; delete and rebuild** | Dripify (major), all partly | Every save creates a version, with a diff view and one-click restore. Deleting a step that has leads on it asks whether to skip or cancel them. Queued message text and waits can be changed in flight | Changing already-queued text or timing is connector-only (no UI yet). Leads aren't pinned to a version, so any save changes what in-flight leads do |
| **Campaigns stall or won't start; unclear why** | HeyReach, Expandi | "Why not sending" diagnostic, and the throttle reason shows on the dashboard | No automatic alert when a campaign quietly stops moving |
| **Lost work; auto-save fails** | Expandi, HeyReach | Unsaved-changes guard, Ctrl+S, version history | No auto-save of the editor |
| **Inbox confusion: which sender or step triggered a reply** | GetSales, Dripify | Each thread shows the sender and channel. The lead panel shows the lead's current sequence and step, with pause, resume and exit | The step that *sent* the message a person replied to isn't shown (it is stored per message, just not displayed) |
| **No positive/negative reply tracking; no sentiment** | GetSales, HeyReach | Every reply gets an intent tag, visible and filterable in the inbox | No report breaks replies down by intent. Only an "interested" count exists |
| **Per-seat pricing hurts teams; can't reduce seats and keep being billed** | Dripify, HeyReach, Expandi, GetSales | Billing is per *active sender*, set nightly to the peak number of active senders, so pausing or removing a sender lowers the bill automatically. Owners cancel or change plans themselves in the Stripe portal | Built, but **not live**: Stripe isn't configured, so billing is currently off |
| **Weak personalization; only name variables** | Dripify, HeyReach | Custom fields with fallbacks, sender fields, live preview, AI-drafted copy with approval | No spintax, no image, GIF or video personalization |
| **AI connector (MCP) numbers don't match the dashboard** | HeyReach | The connector reads the same tables under the same permissions as the logged-in user | Connector reports are calculated separately from the dashboard, so the two could still disagree. Worth a test before we claim this |

---

## Part 3: Complaints that apply to us too (still open)

Ranked by how often they come up in the reviews and how much damage they cause.

| Gap | Competitors' users who raise it | Where we stand |
|---|---|---|
| **An email reply doesn't pause the LinkedIn steps** | Expandi | Reply-stop only covers the same lead on the same sender. A reply by email, or to sender A, doesn't stop that lead's steps on LinkedIn or on sender B, so they can still get follow-ups after replying |
| **No real A/B testing** | Dripify, HeyReach, GetSales | No split or variant step |
| **No email warm-up** | GetSales, Expandi, HeyReach | Mailboxes only get a slow cap ramp (20 to 150 a day). There is no warm-up network, and email steps don't rotate across mailboxes |
| **Weak or no native CRM integrations** | All four (Salesforce especially) | Webhooks and API-call steps only. No HubSpot, Salesforce or Pipedrive sync |
| **No public API** | Dripify | Nothing for customers to call except the Claude connector |
| **Funnel / ROI reporting** | All four | Per-step counts only. Full reports exist only through the connector, and there's no reports page |
| **No voice notes, video messages or meeting booking** | GetSales | Not built. Follow and call-task steps aren't built either |
| **No campaign-level blacklist** | Expandi | Suppression is workspace-wide only |
| **No white-label** | HeyReach (agency) | No branding or custom domain for client viewers |
| **Learning curve** | All four | Not measured. Helpful: sequence templates, AI pre-launch check, a completion-date estimate, and Claude can build a sequence from plain language |

**Not a product problem, so not listed as solved:** declining support, refund policy, surprise renewals and billing errors. These depend on how we run the business, not on the code. Self-serve cancellation in the Stripe portal helps with the last two once billing is live.

---

## The category-wide gaps from the review analysis

The review analysis ends with five gaps that no tool fills well. Here is where we stand on each:

| Gap no tool fills well | Us |
|---|---|
| Reply-sentiment and funnel reporting | ◐ Every reply is intent-tagged, but there's no intent or funnel report yet |
| Editing sequences safely while they run | ◐ Versions, restore and in-flight edits exist. Next: version pinning, and a UI for editing queued text and timing |
| Transparent, fair team pricing with self-serve seat downgrades | ◐ Built as billing per active sender that adjusts automatically, but billing isn't switched on yet |
| Reliable session handling (no silent disconnects) | ✅ Status events, automatic cookie reconnect, reconnect links, attention list |
| One LinkedIn + email inbox showing exactly which sender and step triggered each reply | ◐ Sender and channel yes; originating step not shown yet |

---

## Caveats before using this externally

- **Billing is off.** Stripe isn't configured, so the trial limit, per-sender billing and the self-serve portal are built but not running.
- **Disconnect emails are off.** Resend isn't configured, so reconnect links and notices are skipped by email. They still show in the app and fire webhooks, and reconnect links can be copied from the UI.
- **AI runs on Google Gemini** (`gemini-3-flash-preview` by default), not Claude as the PRD specifies.
- **Built but not switched on:** a weekly sender report function exists but nothing schedules it, and the `ai_auto_send` setting has no effect.
- Status is verified from code, not from live usage. "Solved" means the feature exists and is wired up. It does not mean we have measured results, such as fewer bans, against competitors.
