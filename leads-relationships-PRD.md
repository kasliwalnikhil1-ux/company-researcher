# PRD: Leads page — prospects vs inbox contacts, status, and who is connected through which account

**Document:** Change PRD — split leads you prospect from people who only messaged you, stop creating leads for automated senders and company pages, and show each lead's status and connections per account and channel
**Version:** 1.0 · 26 October 2026
**Applies to:** the app as built (`/outreach/leads`, `/outreach/leads/:id`), per `linkedin-outreach-platform-PRD.md` (`leads`, `lead_sender_state`, F2 `create_leads_from_inbound`), `instagram-whatsapp-channels-PRD.md` (`lead_identities`, `lead_consent`, per-identity state), native email, `sequence-stats-PRD.md` (definitions of Replied and Positive, `stages.is_meeting`), `sender-lifecycle-PRD.md` (removed senders).
**Migration:** `0NN_leads_relationships` (next free number). **New function:** F55. **Changed:** F2, enrichment queue, `enroll_leads`, MCP `leads_search` / `lead_get`.
**Names:** tables and columns follow the specs. The build prefixes tables with `outreach_`; adjust.

---

## 0. Summary

| # | What |
|---|---|
| 1 | Three tabs: **Prospects** (default) · **From inbox** · **All** |
| 2 | No lead is created for automated email (no-reply, newsletters, notifications) or LinkedIn company pages and sponsored messages. Their conversations stay in the inbox |
| 3 | New **Status** column: the furthest a lead has got on any channel, with the channel icon |
| 4 | New **Connected via** column: avatars of the accounts connected to the lead, pending invites hollow, with a per-account hover |
| 5 | New **Channels** column: which channels you can reach the lead on, and which you've used |
| 6 | A totals line and a **By account** panel that follow the filters: how many connected, pending and replied through each account |
| 7 | "Connected" counts only LinkedIn and Instagram, and says whether it came from your invite or already existed |
| 8 | Existing junk leads are classified and hidden, not deleted |

---

## 1. Today and the gap

From the current leads list (26 Oct):

| What the list shows | Why |
|---|---|
| Quora Digest, Epidemic Sound, ElevenLabs, Behance, Adobe, Floqer, Team Rep, flair.ai as leads | `create_leads_from_inbound` turns every inbound email into a lead, including no-reply and newsletter senders |
| "LinkedIn for Marketing", "J.P. Morgan Commercial and Investment Banking" as leads | The same setting on LinkedIn. These are company pages and sponsored messages |
| All of them marked **Replied** | "Replied" means "an inbound message exists", although we never contacted them |
| Identifier `in/acoaab…` | The LinkedIn internal id from the message. The profile was never fetched, so there's no slug or headline |
| "Enrichment waiting" on rows from 19 Oct | Enrich-on-reply is queued but not done after a week, most likely because daily profile views go to sequences first. Nothing says why |
| Most columns "—" | Leads created from a message have no imported data |
| No column for connections | `lead_sender_state` holds connected / invite pending per sender, but the list doesn't show it |

Note: **"LinkedIn Member"** is not a company page. LinkedIn shows that name for a real person whose profile is hidden from you. The row from 19 Oct is tagged Interested. It stays a lead (§3.2).

---

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| **D1** | **Prospects** = leads you imported, added, created by API or search, enrolled, or promoted. Someone who only wrote to you is in **From inbox** until you enrol or promote them | The leads page is for outreach. People who message you are conversations first |
| **D2** | Automated senders and company pages never become leads. Their messages stay in the inbox | A newsletter isn't a person to prospect, and counting it as a reply corrupts every number |
| **D3** | Existing junk leads are **hidden**, not deleted, with a bulk delete available | A rule can be wrong; hiding is reversible |
| **D4** | **Status** is the furthest point a lead has ever reached on any channel. **Connected via** is the current state as of the last check | Status answers "how far did we get". Connections answer "who can message them now" |
| **D5** | "Connected" exists only on LinkedIn (1st-degree) and Instagram (mutual follow). WhatsApp and email show reachability instead | Those channels have no connection step. A fake "connected" would mislead |
| **D6** | Every connection records where it came from: **our invite**, **their invite**, or **already connected** | An account that already knew half the list otherwise makes outreach look better than it was |
| **D7** | Replied, Interested and Meeting use the same definitions as `sequence-stats-PRD.md` (no OOO or auto-replies; interested or question; a stage with `is_meeting`) | The leads page and the sequence numbers must agree |
| **D8** | Replying to an inbox contact doesn't make them a prospect. Enrolling, adding to a list, setting a stage, or **Add to prospects** does | A support or vendor conversation shouldn't enter outreach numbers by accident |
| **D9** | Enrichment works through prospects first, inbox contacts after, automated never. The cell says why it's waiting | Profile views are capped (~100 per account per day) |

---

## 3. Inbound leads

### 3.1 Classification

On every inbound message for a chat with no lead yet, F2 classifies the sender before creating anything:

| Kind | LinkedIn / Instagram / WhatsApp | Email |
|---|---|---|
| `automated` | Messages Unipile marks as system or sponsored | Any of: address local part matches `no-?reply`, `do-?not-?reply`, `notifications?`, `newsletter`, `digest`, `mailer-daemon`, `postmaster`, `bounce`, `updates`; header `List-Unsubscribe` or `List-Id`; `Precedence: bulk` or `list`; `Auto-Submitted` other than `no` |
| `company_page` | The attendee is an organisation (company page messaging), or the chat is a sponsored message / InMail from a page | — |
| `person` | Everyone else, including "LinkedIn Member" (hidden name) | Everyone else |

Classification is stored on the chat (`chats.counterpart_kind`) and the lead (`leads.kind`). The exact Unipile fields for organisation and sponsored chats are open question 1; until confirmed, use them where present and fall back to a list of known page names maintained in `ops.inbound_kind_rules`.

### 3.2 What gets created

Workspace setting **Create leads from inbound** (replaces the boolean `create_leads_from_inbound`):

| Value | Behaviour |
|---|---|
| `people_only` (default) | Lead created for `person` only, with `origin='inbound'` |
| `all` | Lead created for every kind; automated and company pages are created hidden |
| `none` | No leads from inbound; conversations only |

The conversation always lands in the inbox, whatever the setting. Automated email goes to the inbox's existing Other/updates view rather than Replies. Reply-stop is unaffected: it only ever applies to leads in sequences.

If the inbound sender matches an existing lead (by LinkedIn id or slug, Instagram handle, phone or email), the message attaches to that lead and nothing new is created. Its `origin` doesn't change.

### 3.3 Becoming a prospect

`leads.prospect_since` is set, and the lead moves from **From inbox** to **Prospects**, when any of these happens:
- enrolled in a sequence (`enroll_leads`);
- added to a list, or given a stage;
- **Add to prospects** on the lead or as a bulk action.

Tags, notes and inbox replies don't promote (D8).

---

## 4. Definitions

### 4.1 Status (D4, D7)

The furthest step reached on any channel, ever. Shown with the channel where it was reached (latest wins on a tie).

| Order | Status | Reached when |
|---|---|---|
| 0 | **Not contacted** | No sent touch from any sender |
| 1 | **Invited** | A LinkedIn invite or Instagram follow was sent, not yet accepted |
| 2 | **Connected** | Any LinkedIn connection or Instagram mutual follow with one of your accounts (any source) |
| 3 | **Messaged** | A message, InMail, DM, WhatsApp message or email was sent |
| 4 | **Replied** | A human reply after one of your touches. OOO and auto-replies don't count |
| 5 | **Interested** | A reply classified `interested` or `question` |
| 6 | **Meeting** | Reached a stage with `is_meeting` |

Overrides shown instead of the ladder, in this priority: **Do not contact** (suppressed / `do_not_contact`) · **Bounced** (email hard bounce or WhatsApp number invalid, and no other channel reached) · **Wrote to us** (inbox contacts with no touch from us).

"Messaged" ranks above "Connected" because a message is an action on our side after the connection; a lead who was messaged without ever connecting (InMail, email, WhatsApp) also shows Messaged.

### 4.2 Connected, per channel (D5, D6)

| Channel | Connected | Pending | Other states shown |
|---|---|---|---|
| LinkedIn | `relation='first'` with that account | invite from that account not answered | Not connected · They invited us (`pending_in`) |
| Instagram | we follow them **and** they follow us | we follow, they don't yet | They follow us · Not followed |
| WhatsApp | — | — | Chat exists · Consent: inbound / form / attested / none · Number invalid |
| Email | — | — | Emailed · Has address · Bounced |

`relation_source` for each connection:

| Value | Set when |
|---|---|
| `our_invite` | We sent the invite (or follow) and the acceptance came after it |
| `their_invite` | They invited us and we accepted (`pending_in` → `first`) |
| `pre_existing` | The first time we checked (profile fetch network distance, relations import, or connection sync), they were already connected, before any invite from that account |
| `unknown` | Connected before this change shipped and the history can't tell (backfill only) |

Connections can disappear (the prospect removes one). `Connected via` shows the state from the last observation, with `relation_checked_at` in the hover. Status keeps "Connected" as reached.

### 4.3 Channels

For each of in · ig · wa · ✉ the lead has one of three states:
- **none**: no identity on that channel (icon hidden);
- **reachable**: an identity exists (light icon);
- **used**: a touch was sent on it (dark icon). A reply on it adds a dot.

---

## 5. Leads list

### 5.1 Tabs

| Tab | Shows | Default sort |
|---|---|---|
| **Prospects** | `prospect_since is not null` and not hidden | Last activity |
| **From inbox** | `origin='inbound'` and `prospect_since is null` and not hidden | Last message |
| **All** | Everything not hidden | Last activity |

A **Hidden** filter (any tab) shows automated and company-page leads, and anything hidden by hand, with **Unhide** and **Delete** bulk actions.

### 5.2 Columns

Existing columns stay (name, company, title, lists, stage, tags, added). The current status column ("Replied") is replaced, and two columns are added after it:

| Column | Content |
|---|---|
| Name | Name, then the LinkedIn slug when known; otherwise **LinkedIn ↗** (link built from the profile URL Unipile gave) instead of the internal id. "LinkedIn Member" rows show "LinkedIn Member (name hidden)" |
| **Status** | §4.1 label with channel icon, e.g. `in` Connected, `✉` Replied, `wa` Interested |
| **Connected via** | Up to 3 avatars of connected accounts (solid), pending invites (hollow), "+N" beyond. Empty when none. A small mark on avatars from `pre_existing` connections |
| **Channels** | §4.3 icons |
| Enrichment | When waiting, the reason: "Waiting · daily profile views used (Naman, resets 09:00)" or "Waiting · queued behind 240 prospects" |

### 5.3 Hover on Connected via

One line per account with any relationship to the lead, grouped by channel:

> **LinkedIn**
> Naman Kasliwal · Connected 12 Oct · accepted our invite · checked 25 Oct
> Avi Shah · Invite pending since 20 Oct
> Mohamad Abid · Connected · already connected before outreach
> **Instagram**
> Kaptured Insta · Followed back 18 Oct
> **WhatsApp**
> Aarushi (WA) · Chat since 22 Oct · consent: inbound

Removed accounts (sender-lifecycle PRD) show "(removed)" and are listed only when **Include removed accounts** is on.

### 5.4 Totals line

Above the table, for the current tab and filters, counted in people:

> **1,240 prospects · 410 contacted · 132 connected (98 via our invites) · 41 replied · 12 interested · 3 meetings**

- Contacted = status ≥ Invited.
- Connected = at least one current LinkedIn or Instagram connection. The bracket counts `our_invite`.
- Replied / Interested / Meetings = status reached.

Each number is a link that applies the matching filter.

### 5.5 By account

A **By account** button opens a side panel, or **Group by → Account** groups the table. For the leads in the current view, one row per account:

| Account | Channel | Connected | via our invite | Pending | Contacted | Replied |
|---|---|---|---|---|---|---|
| Naman Kasliwal | in | 58 | 41 | 22 | 120 | 14 |
| Avi Shah | in | 33 | 30 | 18 | 76 | 6 |
| Kaptured Insta | ig | 9 | 9 | 4 | 23 | 2 |
| Aarushi (WA) | wa | — | — | — | 6 | 3 |
| hello@kaptured.ai | ✉ | — | — | — | 40 | 2 |

A lead connected to two accounts counts once in each account's row and once in the totals line. The panel footer says so. Clicking a cell filters the table.

Contacted and Replied per account use the account that sent the touch or received the reply.

### 5.6 Filters

New filters, combinable with the existing ones:
- **Status** (multi-select, §4.1)
- **Connected via** (accounts) · **Pending with** (accounts) · **Not connected to any account**
- **Connection source**: via our invite / their invite / already connected
- **Channel**: reachable on · used on · replied on
- **Origin**: imported / added / API / search / inbound
- **Kind** (Hidden filter only): person / company page / automated

---

## 6. Lead page

The per-sender section becomes **Relationships**, grouped by channel, one row per account:

| Account | State | Since | Source | Last touch | Last reply | Checked |
|---|---|---|---|---|---|---|

Plus, at the top of the lead page: Status (§4.1), origin ("Wrote to us on LinkedIn, 19 Oct"), and **Add to prospects** when the lead is an inbox contact.

---

## 7. Data model

```sql
-- 0NN_leads_relationships

alter table leads
  add column origin text not null default 'import'
      check (origin in ('import','manual','api','search','inbound')),
  add column kind text not null default 'person'
      check (kind in ('person','company_page','automated')),
  add column prospect_since timestamptz,
  add column hidden_at timestamptz,
  add column hidden_reason text check (hidden_reason in ('automated','company_page','manual'));

create index on leads(workspace_id, prospect_since) where hidden_at is null;
create index on leads(workspace_id, origin) where hidden_at is null;

alter table chats
  add column counterpart_kind text not null default 'person'
      check (counterpart_kind in ('person','company_page','automated'));

alter table lead_sender_state
  add column relation_source text check (relation_source in ('our_invite','their_invite','pre_existing','unknown')),
  add column connected_at timestamptz,
  add column relation_checked_at timestamptz,
  add column we_follow boolean,          -- Instagram
  add column follows_us boolean;         -- Instagram

-- Denormalised per-lead summary for the list (one row per lead).
create table lead_summary (
  lead_id              uuid primary key references leads(id) on delete cascade,
  workspace_id         uuid not null references workspaces(id) on delete cascade,
  status               text not null default 'not_contacted'
      check (status in ('not_contacted','invited','connected','messaged','replied','interested','meeting',
                        'do_not_contact','bounced','wrote_to_us')),
  status_rank          smallint not null default 0,
  status_channel       provider_t,
  status_at            timestamptz,
  connected_sender_ids uuid[] not null default '{}',     -- current LinkedIn first / Instagram mutual
  connected_via_our_invite_ids uuid[] not null default '{}',
  pending_sender_ids   uuid[] not null default '{}',
  connected_count      smallint not null default 0,
  pending_count        smallint not null default 0,
  identity_channels    provider_t[] not null default '{}',
  used_channels        provider_t[] not null default '{}',
  replied_channels     provider_t[] not null default '{}',
  contacted_sender_ids uuid[] not null default '{}',
  replied_sender_ids   uuid[] not null default '{}',
  first_contacted_at   timestamptz,
  last_activity_at     timestamptz,
  wrote_first_at       timestamptz,
  updated_at           timestamptz not null default now()
);
create index on lead_summary(workspace_id, status_rank);
create index on lead_summary(workspace_id, last_activity_at desc);
create index on lead_summary using gin (connected_sender_ids);
create index on lead_summary using gin (pending_sender_ids);
create index on lead_summary using gin (contacted_sender_ids);

-- Rules for classifying inbound senders (editable by platform admins).
create table ops.inbound_kind_rules (
  id serial primary key,
  channel provider_t not null,
  match_type text not null check (match_type in ('email_local_part_regex','email_domain','header','display_name','provider_id')),
  pattern text not null,
  kind text not null check (kind in ('company_page','automated')),
  active boolean not null default true
);

select pgmq.create('lead_summary_refresh');
```

`create_leads_from_inbound` in `workspaces.settings` changes from boolean to `'people_only' | 'all' | 'none'` (`true` → `people_only`, `false` → `none`).

---

## 8. Functions

### 8.1 Keeping the summary current

`lead_summary_refresh(lead_id)` recomputes one row from `lead_sender_state`, `lead_identities`, `lead_consent`, `actions` (sent touches), `messages` (human inbound, intent), `leads.stage_id` (`is_meeting`) and suppressions. It's called from a queue, never inline:

| Event | Enqueues the lead |
|---|---|
| `lead_sender_state` insert/update | trigger |
| Sent touch (`complete_action`) | already calls `stats_record` (sequence stats PRD); add the enqueue there |
| Human inbound, intent classified | F2, F18 |
| Stage change, suppression, `do_not_contact` | triggers |
| `lead_identities` / `lead_consent` change | triggers |
| Sender removed | sender-lifecycle `sender_remove_finish` enqueues its leads |

### 8.2 Writing `relation_source` and `connected_at`

| Where | Rule |
|---|---|
| F2 `new_relation` and the note-chat acceptance path | `first` after an invite from that sender → `our_invite`, `connected_at = detected time` |
| Accepting an incoming invite (`handle_invitation`) | `their_invite` |
| Profile fetch (any `profile_view`) showing network distance 1 with no invite on record for that sender | `pre_existing`; `relation_checked_at` updated on every fetch |
| Relations import / connection sync | rows that are `first` with no invite on record → `pre_existing` |
| Instagram followers poll | sets `follows_us`; mutual with `we_follow` → connected, source `our_invite` if our follow came first, otherwise `pre_existing` |
| Distance > 1 seen for a previously connected lead | `relation='none'`, `connected_at` kept for history |

### 8.3 Changed

**F2 `process-inbound`** — before creating a lead for a new chat: classify (§3.1), apply the setting (§3.2), set `chats.counterpart_kind`, `leads.origin='inbound'`, `kind`; `wrote_first_at` when the first message in the chat is theirs and we never touched them. Automated email chats are routed to the inbox's Other view.

**`enroll_leads`, list add, stage set, Add to prospects** — set `prospect_since` if null.

**Enrichment queue** — order: prospects in active sequences, other prospects, inbox persons; automated and company pages never. Each waiting row stores `wait_reason` (`budget` with the sender and reset time, or `queue` with position), shown in the list.

### 8.4 New

| Fn | Trigger | Purpose |
|---|---|---|
| F55 `worker-lead-summary` | cron every 30 s (queue) + nightly 03:30 UTC (reconcile) | Consume `lead_summary_refresh`, recompute rows. Nightly: recompute summaries for leads with activity in 7 days and fix drift, logging counts |

```sql
select cron.schedule('lead-summary',           '30 seconds', $$select ops.invoke('worker-lead-summary')$$);
select cron.schedule('lead-summary-reconcile', '30 3 * * *', $$select ops.invoke('worker-lead-summary?mode=reconcile')$$);
```

### 8.5 Read functions

| Function | Returns | Used by |
|---|---|---|
| `leads_list(tab, filters, sort, cursor)` | Rows with `lead_summary` fields and sender avatars | Leads page, MCP `leads_search`, API |
| `leads_totals(tab, filters)` | §5.4 numbers | Totals line, MCP, API |
| `leads_by_account(tab, filters, include_removed)` | §5.5 rows | By account panel, MCP, API |
| `lead_relationships(lead_id)` | §6 rows | Lead page, hover, MCP `lead_get` |

---

## 9. Backfill

In the migration, batched by workspace:
1. **Classify existing leads.** Leads with `source` or creation path from inbound get `origin='inbound'`. Run §3.1 on their first chat. `automated` and `company_page` leads with no enrolment and no sent touch get `hidden_at=now()`, `hidden_reason=kind`.
2. **Prospect flag.** `prospect_since = least(created_at for imported/added/API/search leads, first enrolment, first list add, first stage set)`.
3. **Relation source.** Connections with an invite from the same sender before `invite_accepted_at` → `our_invite`; accepted incoming invites → `their_invite`; everything else currently `first` → `unknown` (shown in the hover as "source unknown, from before 26 Oct").
4. **Summaries.** Enqueue every lead; F55 fills `lead_summary`.
5. **Check:** the number of leads per workspace with status Replied after the backfill is at most the old "Replied" count, and every difference is a hidden automated/company lead, an OOO/auto-reply, or a lead that wrote first.

---

## 10. MCP and API

- `leads_search` gains `tab` (`prospects` default, `inbox`, `all`), `status`, `connected_via`, `pending_with`, `connection_source`, `channel_reachable` / `channel_used`, `origin`, `include_hidden`. Each row returns `status`, `status_channel`, `connected_via[]` (name, channel, source), `pending_with[]`, `channels{}`.
- `lead_get` returns `relationships[]` (§6) and `origin`, `kind`, `prospect_since`.
- New read tools: `leads_totals`, `leads_by_account`.
- New gated write tool (members+): `lead_promote(lead_ids[])` (Add to prospects). `lead_hide` / `lead_unhide` gated, managers+.
- `inbox_pending` (outreach skill) skips automated and company-page chats unless asked.

---

## 11. Edge cases

| Case | Behaviour |
|---|---|
| Inbound person who is already an imported lead | Message attaches to the existing lead; stays a prospect; origin unchanged |
| Inbox contact you reply to | Stays in From inbox (D8) |
| Inbox contact enrolled later | Moves to Prospects; status starts from what already happened ("Wrote to us" → Messaged once we touch them) |
| "LinkedIn Member" (hidden name) | Person; kept; enrichment can't resolve the name, shown "LinkedIn Member (name hidden)" |
| Company page that sends a real conversation | Hidden by default; Unhide makes it a normal inbox lead |
| Personal email from a newsletter domain (e.g. a founder at a domain that also sends bulk mail) | Only bulk headers or the local-part list mark it automated; a person's own address isn't caught by domain alone |
| Lead connected to 2 accounts | Both avatars; counted once in totals, once in each account's row |
| Connection removed by the prospect | Disappears from Connected via after the next check; status keeps Connected |
| Already connected before outreach, then messaged | Status Messaged; avatar marked "already connected"; excluded from "via our invites" |
| They invited us and we accepted | Connected, source `their_invite` |
| Account removed (sender-lifecycle) | Avatar "(removed)", hidden unless Include removed accounts is on; totals follow the toggle |
| Lead on WhatsApp only | Status from WhatsApp touches; Connected via empty; hover shows chat and consent |
| Email bounced but LinkedIn connected | Status Connected (or further); Bounced only shows when no other channel got anywhere |
| Suppressed lead | Status Do not contact, regardless of history; history still in the hover |
| Enrichment stuck on budget | Cell shows which account's views ran out and when they reset |

---

## 12. Rollout

| Phase | Contents |
|---|---|
| **1** | Migration, classification in F2 and the new setting (stops new junk leads immediately), backfill of origin, kind, hidden, prospect flag |
| **2** | Tabs, Hidden filter, Add to prospects, identifier display, enrichment wait reasons |
| **3** | `relation_source` writes, `lead_summary` + F55, Status / Connected via / Channels columns and hover, filters |
| **4** | Totals line, By account panel, lead page Relationships, MCP and API |

Phase 1 alone removes Quora, Adobe, Behance, the LinkedIn pages and the rest from the default view.

---

## 13. Tests

- **Classification:** fixtures for each automated rule (local part, `List-Unsubscribe`, `Precedence: bulk`, `Auto-Submitted`), a company page, a sponsored message, "LinkedIn Member", and a founder writing from a bulk-sending domain without bulk headers (stays a person).
- **Tabs:** an imported lead, an inbox person, an inbox person after enrolment, a hidden newsletter each land in the right tab.
- **Status:** one lead per row of §4.1 and per override; furthest-reached wins; OOO doesn't make Replied.
- **Connections:** our invite accepted, their invite accepted, pre-existing via profile fetch, Instagram mutual follow, removed connection, removed account.
- **Totals vs By account:** a lead connected to two accounts counts once in totals and once per account row.
- **Agreement:** Replied / Interested / Meeting counts for a sequence's leads equal `sequence-stats-PRD.md` numbers for the same leads.
- **Performance:** Prospects tab with 50k leads and two filters under 400 ms; By account panel under 600 ms.

---

## 14. Open questions

1. **Unipile fields for company pages and sponsored messages.** Which attendee or chat field marks an organisation sender or a sponsored InMail on LinkedIn? Until confirmed, the rule list in `ops.inbound_kind_rules` backs it up.
2. **Pre-existing detection.** Profile fetch gives network distance, but a full connection sync costs relation polls (a few a day, random times). Is detecting `pre_existing` on profile fetch enough, or should a one-off relations import run when an account connects?
3. **Should replying promote?** D8 says no. If teams treat every reply as a prospect, add a workspace setting.
4. **Hidden after 90 days.** Should hidden automated leads with no conversation activity for 90 days be deleted automatically, or kept until someone deletes them?
