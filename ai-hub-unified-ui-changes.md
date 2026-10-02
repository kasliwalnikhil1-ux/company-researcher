In current app,
AI Auto Reply
AI Personalization
AI website chatbot answers
AI variables
Some go for approval as tasks then there is AI Personalization only in the sidebar
The app has these, then reviewing options too in some and seeing what Ai generated in past (needed in all, like Recent answers in the AI website chatbot)
I want this into an integrated better cohesive UI.

As per the current app handle what is there so that the below PRD can be implemented.

# Change PRD: One home for AI ("AI" hub)

**Applies to:** the app as built, including `ai-replies-changes.md`, `ai-review-auto-approve-PRD.md`, `web-chat-PRD.md` §11 and, if built, `linkedin-profile-management-PRD.md` §8.5.
**Goal:** every AI feature is set up, reviewed and looked back on in the same place, with the same words. The features themselves don't change.
**Migration:** `00xx_ai_hub` (next free number).

---

## 0. Summary

| # | Change |
|---|---|
| 1 | One sidebar item **AI**, with a badge for items waiting on a person. Pages: **Needs you · Activity · Knowledge · Setup** |
| 2 | One name per feature: **Replies**, **Personalized lines**, **Website assistant** |
| 3 | The same three modes everywhere: **Off · Review · Auto** |
| 4 | **Needs you**: one queue for every AI output that needs a person. AI review items leave Tasks |
| 5 | **Activity**: one list of what the AI generated, across all features. Replaces the website's "Recent answers" and the replies activity log |
| 6 | **Knowledge**: one library (websites, documents, Q&A, unanswered questions) shared by Replies and the Website assistant |
| 7 | **Setup**: one card per feature plus **General**. Replaces Settings → AI and the "AI Personalization" sidebar item |

**Removed:** the "Why did it say that?" link and anything that stores a prompt per output. Activity shows only what the AI generated.

---

## 1. Navigation

```
Inbox
Sequences
Leads
Tasks
AI                     14     ← badge = items in Needs you (for this user)
  Needs you
  Activity
  Knowledge
  Setup
Reports
Settings
```

| Route | Page |
|---|---|
| `/outreach/ai` | Redirects to Needs you |
| `/outreach/ai/needs-you` | §4 |
| `/outreach/ai/activity` | §5 |
| `/outreach/ai/knowledge` | §6 |
| `/outreach/ai/setup` | §7 |
| `/outreach/ai/setup/lines/:variableId` | Variable editor (moved from Settings → AI) |
| `/outreach/ai/setup/general` | §7.2 |

Redirects (keep for one release):

| Old | New |
|---|---|
| `/outreach/ai-review` (AI Personalization) | `/outreach/ai/needs-you?type=line` |
| `/outreach/settings/ai` | `/outreach/ai/setup/general` |
| Settings → AI variables | `/outreach/ai/setup` (Personalized lines card) |
| Website settings → Recent answers | `/outreach/ai/activity?feature=website&where=<website id>` |
| Settings → AI Replies → Activity log | `/outreach/ai/activity?feature=reply` |

The "AI Personalization" sidebar item and the Settings → AI page are removed.

---

## 2. Names

| Today | New name | Notes |
|---|---|---|
| AI Auto Reply / AI Replies | **Replies** | Answers prospects who reply to a sequence |
| AI Personalization / AI variables | **Personalized lines** | Variables are this feature's settings, not a separate feature. The token stays `{{ai.<key>\|fallback}}` |
| AI website chatbot | **Website assistant** | |

These names are used everywhere: sidebar filters, cards, badges, notifications, emails and the MCP.

---

## 3. Modes: Off · Review · Auto

| Feature | Off | Review | Auto |
|---|---|---|---|
| **Replies** (per sequence) | No AI | AI drafts every reply; a person sends it (today's **Draft**) | AI sends after the hold; anything it shouldn't answer comes to Needs you |
| **Personalized lines** (per variable) | Lines aren't generated | A person approves each line | Lines that pass the checks are approved; the rest come to Needs you |
| **Website assistant** (per website) | No AI | AI suggests an answer to the agent; the visitor waits for a person (**new**) | AI answers the visitor. Sub-setting **When: Always / Outside business hours** |

- **Replies:** label change only. The database value `draft` stays; the UI shows **Review**.
- **Website assistant:** today's "AI first" → Auto · Always; "AI only outside business hours" → Auto · Outside business hours. **Review** is new (§4.3).
- The mode control looks the same in all three places: a three-way switch with one line underneath explaining the selected mode.

---

## 4. Needs you

### 4.1 What appears here

Only things where the AI produced something and a person has to act.

| Type | Comes from | Appears when | Actions |
|---|---|---|---|
| **Reply** | `ai_reply_runs` | Sequence on Review and a draft is ready · escalated (the AI shouldn't answer) · Auto warm-up reply waiting to send | Send · Edit · Open conversation (escalated: + Skip). Warm-up: Send now · Edit · Cancel |
| **Line** | `ai_variable_values` | Needs review · picked for spot check | Approve · Edit (Ctrl+Enter = save and approve) · Regenerate · Skip. Spot check: Looks good · Edit · Revoke |
| **Website** | `webchat_ai_suggestions` (§4.3) | Website on Review and a suggestion is waiting | Send · Edit · Open chat |
| **Question** | `ai_unanswered_questions` | A question the AI couldn't answer, from Replies or the Website assistant | Add answer (saved to Knowledge) · Dismiss |
| **Profile** (if Profile Studio is built) | `profile_changes` where `source = 'ai_draft'` and `status = 'draft'` | AI drafted a headline/About | Edit and apply · Discard |

Moved **out of Tasks** (open ones migrated, §8.4): `review_ai_draft`, `ai_escalation`.
**Staying in Tasks** (things a person does): `ai_handoff` ("over to you"), `follow_up`, `manual_node`, `call`, `reconnect`, `reply_hold`.

The rule shown in the empty state of both pages: *"Needs you = approve something the AI wrote. Tasks = something you do yourself."*

### 4.2 Page

```
Needs you (14)                    All 14 · Replies 5 · Lines 7 · Website 1 · Questions 1
                                  [Mine | All]   Where: [All sequences, variables, websites ▾]

┌ Reply · Fintech CFOs · Priya Nair (Razorpay) ··························· 12 min ago ┐
│ They wrote:  "What would 3 films cost?"                                             │
│ AI draft:    "Most projects start at …"                                             │
│ ⚠ Pricing question — your prompt hands these to a person                            │
│ [Send] [Edit] [Open conversation]                                                   │
├ Line · opener · Rahul Mehta (Loomcraft) ············································┤
│ "Congrats on the amazing journey building Loomcraft to 200 stores!"                 │
│ ⚠ "amazing journey" is blocked · "200" isn't in the profile                         │
│ [Approve anyway] [Edit] [Regenerate] [Skip]                                         │
├ Website · kaptured.ai · Visitor (Mumbai) ···········································┤
│ Asked:  "Do you shoot on location?"                                                 │
│ AI suggests: "Yes, we shoot on location across India …"                             │
│ [Send] [Edit] [Open chat]                                                           │
├ Question · asked 4 times · Replies + Website ·······································┤
│ "Do you offer revisions after delivery?"                                            │
│ [Add answer] [Dismiss]                                                              │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

- **One card layout for every type:** header (type · where · who · time) → what triggered it → what the AI wrote → one line saying why it's waiting → actions.
- Sorted oldest first within the selected filter, so nothing sits forever; a live website suggestion always sorts to the top.
- **Mine / All:** Mine = replies and website chats assigned to me + everything else I'm allowed to act on that isn't assigned to anyone.
- **Bulk** (lines only): select → Approve / Skip / Regenerate. Approve shows the selected lines before confirming, as today.
- Acting on a card removes it immediately (optimistic), with a 5-second Undo for Skip/Dismiss.
- Sending a reply here is the same send as from the inbox (`sendChatMessage`, origin `ai_draft_sent` / `ai_edited`), so handoff and every other rule behave the same.

**Badge** on the sidebar = the count of this page with "Mine" applied. Refetched every 60 s and on window focus; Realtime is not required.

### 4.3 Website assistant Review mode (new)

When a website is on Review:
1. A visitor message arrives; the assistant's existing answer pipeline runs but does **not** send.
2. The answer is stored in `webchat_ai_suggestions` and shown in two places: pre-filled in the agent's composer for that chat, and as a Website card in Needs you.
3. The visitor sees the normal "a person will reply shortly" state.
4. When an agent sends (as is or edited), the suggestion is marked used. If an agent replies without using it, or the visitor writes again, it's marked stale and disappears from Needs you.
5. After `review_timeout_min` (default 10, per website) with no agent reply, the assistant behaves per the website's existing away settings (collect email, promise a reply time). It never auto-sends in Review.

### 4.4 Where the queue also shows up
- **Inbox:** reply and website cards are the same drafts already shown in the composer; nothing new there.
- **Sequence → AI tab:** a line "5 replies need you" linking to Needs you filtered to that sequence.
- **Sequence steps using `{{ai.<key>}}`:** "opener — 312 ready · 14 waiting for you" linking to Needs you filtered to that variable.

---

## 5. Activity

A list of what the AI generated. Nothing else.

```
Activity                Feature: [All ▾]   Where: [All ▾]   Date: [Last 7 days ▾]   [Search text…]

Time          Feature       Where              Who                       What the AI wrote
10:42         Reply         Fintech CFOs       Priya Nair (Razorpay)     "Great question — most of our films take two …"
10:40         Line          opener             Rahul Mehta (Loomcraft)   "Your post on KYC delays in merchant onboarding…"
10:31         Website       kaptured.ai        Visitor (Mumbai)          "Yes, we shoot on location across India …"
```

- **Columns:** time · feature · where (sequence / variable / website) · who (lead or visitor, linked) · the text (one line, click to expand).
- **Filters:** feature, where, date range (today / 7 / 30 / 90 days / custom), free-text search in the text.
- Clicking **Who** opens the lead (or the web chat). Nothing else is clickable.
- **Not shown and not stored for this page:** outcome, who approved it, the prompt, checks, reasons. Those still exist where they already live (e.g. line approval badges in Needs you), but Activity doesn't read them.
- **The same table, pre-filtered, appears on:** a sequence's AI tab (its replies), a variable's page (its lines), a website's settings (its answers, replacing "Recent answers").
- Export CSV (managers): the visible columns only.

---

## 6. Knowledge

One library per workspace.

```
Knowledge                                                      [+ Website] [+ Document] [+ Q&A]

Source                         Type       Status          Used by
kaptured.ai                    Website    42 pages · 2d   Website assistant (kaptured.ai) · Fintech CFOs · Jewellery D2C
Rate card.pdf                  Document   Ready           Fintech CFOs
Q&A (18)                       Q&A        —               All
Unanswered questions (3)       —          —               → shown in Needs you
```

- **Sources** (website crawl, documents, Q&A) are created here once and **attached** to a sequence (in its AI tab) or a website (in its settings) with a picker of library sources. The same pipeline as today (crawl, chunking, retrieval); only the ownership moves from "per website" / "per sequence" to "workspace, linked to many".
- **Q&A pairs:** one list. Each pair can be limited to specific sequences/websites; default = all.
- **Unanswered questions** from Replies and the Website assistant go into one grouped list (Question cards in Needs you). **Add answer** creates a Q&A pair, so both features can answer it next time.
- Removing a source asks: "Used by 3 places — remove from all?"

---

## 7. Setup

### 7.1 Feature cards

```
Replies             4 sequences on Auto · 2 on Review · 3 Off       212 written this week    [Manage]
Personalized lines  3 variables · opener on Auto                    1,840 written            [Manage]
Website assistant   kaptured.ai · Auto · outside business hours     96 written               [Manage]
Profile drafts      Review only                                     4 written                [Manage]   (if built)
General             AI provider and key · usage · defaults                                   [Open]
```

| Card | **Manage** opens |
|---|---|
| Replies | A table of sequences with their AI mode (switchable inline) and a link to each sequence's AI tab, where the prompt and limits are edited |
| Personalized lines | The variable list and editor (moved here from Settings → AI): prompt, fallback, max length, mode, blocked phrases, Try it on 10 leads |
| Website assistant | A table of websites with their mode and When; link to each website's assistant settings |
| Profile drafts | Profile Studio |

"Written this week" = count from the Activity view.

### 7.2 General
Everything workspace-wide that was in Settings → AI:
- AI provider and own key (bring your own key)
- AI usage this month and the plan's allowance
- Per-sender daily cap for AI replies
- Default reply prompt for new sequences
- Default blocked phrases for new variables

---

## 8. Data

### 8.1 `ai_outputs` view (Activity)

```sql
create view ai_outputs with (security_invoker = true) as
  -- Replies: text the AI wrote (sent or not)
  select r.id, r.workspace_id, 'reply'::text as feature, r.created_at,
         'sequence'::text as where_kind, r.sequence_id as where_id, s.name as where_name,
         'lead'::text as who_kind, r.lead_id as who_id, l.full_name as who_name,
         coalesce(r.final_text, r.draft_text) as text
    from ai_reply_runs r
    left join sequences s on s.id = r.sequence_id
    left join leads l on l.id = r.lead_id
   where coalesce(r.final_text, r.draft_text) is not null
union all
  -- Personalized lines
  select v.id, v.workspace_id, 'line', v.created_at,
         'variable', v.variable_id, av.key,
         'lead', v.lead_id, l.full_name,
         v.value
    from ai_variable_values v
    join ai_variables av on av.id = v.variable_id
    left join leads l on l.id = v.lead_id
   where v.value is not null and v.value <> ''
union all
  -- Website assistant answers sent to visitors
  select m.id, m.workspace_id, 'website', m.created_at,
         'website', c.webchat_inbox_id, w.name,
         'visitor', c.visitor_id, coalesce(vi.name, 'Visitor'),
         m.text
    from messages m
    join chats c on c.id = m.chat_id
    join webchat_inboxes w on w.id = c.webchat_inbox_id
    left join webchat_visitors vi on vi.id = c.visitor_id
   where m.sender_type = 'bot'
union all
  -- Website assistant suggestions (Review mode)
  select g.id, g.workspace_id, 'website', g.created_at,
         'website', c.webchat_inbox_id, w.name,
         'visitor', c.visitor_id, coalesce(vi.name, 'Visitor'),
         g.text
    from webchat_ai_suggestions g
    join chats c on c.id = g.chat_id
    join webchat_inboxes w on w.id = c.webchat_inbox_id
    left join webchat_visitors vi on vi.id = c.visitor_id;
-- + profile drafts (profile_changes where source = 'ai_draft') if Profile Studio is built
```

Column and table names follow the specs; adjust to the build (e.g. the line text column may be `value` or `line`). `security_invoker = true` makes each user see only rows the underlying tables' RLS already allows.

Indexes needed on the underlying tables for the date filter: `(workspace_id, created_at desc)` on each, where missing. Text search uses `ilike` on the visible page (bounded by date range); no new search index.

### 8.2 `ai_needs_you` view (Needs you + badge)

Same `security_invoker` pattern, one row per card:

```
id, workspace_id, type ('reply'|'line'|'website'|'question'|'profile'),
where_kind, where_id, where_name, who_kind, who_id, who_name,
trigger_text,      -- their message / visitor question / null for lines
ai_text,           -- the draft, line or suggestion
reason,            -- one line: escalation reason, failed checks, "Warm-up", "Spot check", "Review mode"
assignee_id,       -- chat assignee for reply/website; null otherwise
created_at
```

Built from:
- `ai_reply_runs` where status in (`draft_ready`, `escalated`) and the chat isn't handed off, plus `scheduled` runs during warm-up;
- `ai_variable_values` where status = `generated`, or `spot_check and spot_checked_at is null`;
- `webchat_ai_suggestions` where status = `waiting`;
- `ai_unanswered_questions` where status = `open`;
- `profile_changes` AI drafts (if built).

Badge: `select count(*) from ai_needs_you where assignee_id = auth.uid() or assignee_id is null`.

### 8.3 New and changed tables

```sql
-- Website assistant Review mode
create table webchat_ai_suggestions (
  id          uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  chat_id     uuid not null references chats(id) on delete cascade,
  message_id  uuid not null references messages(id) on delete cascade,   -- the visitor message answered
  text        text not null,
  status      text not null default 'waiting' check (status in ('waiting','used','stale','expired')),
  created_at  timestamptz not null default now(),
  resolved_at timestamptz
);
create index on webchat_ai_suggestions(workspace_id, status, created_at);
-- website mode lives in webchat_inboxes.settings: {ai_mode: 'off'|'review'|'auto', ai_when: 'always'|'outside_hours', review_timeout_min: 10}

-- Knowledge: one library, linked to many places
alter table kb_sources add column workspace_id uuid references workspaces(id) on delete cascade;
update kb_sources k set workspace_id = w.workspace_id from webchat_inboxes w where w.id = k.inbox_id;
alter table kb_sources alter column workspace_id set not null, alter column inbox_id drop not null;

create table knowledge_links (
  source_id   uuid not null references kb_sources(id) on delete cascade,
  target_kind text not null check (target_kind in ('website','sequence')),
  target_id   uuid not null,
  primary key (source_id, target_kind, target_id)
);
-- backfill: website-owned sources → link to their website; master_prompts.knowledge_source_ids → links to the prompt's sequence
-- then retrieval reads knowledge_links instead of kb_sources.inbox_id / master_prompts.knowledge_source_ids

-- Unanswered questions from both features in one table
alter table ai_unanswered_questions
  alter column sequence_id drop not null,
  alter column master_prompt_id drop not null,
  add column origins text[] not null default '{reply}';   -- 'reply' | 'website'
-- website "top unanswered questions" feed into it with origins = '{website}' and sequence_id null

-- Q&A: website FAQ entries move into master_prompt_faqs' successor
alter table master_prompt_faqs rename to knowledge_qa;
alter table knowledge_qa
  add column workspace_id uuid references workspaces(id) on delete cascade,
  alter column master_prompt_id drop not null;
create table knowledge_qa_links (
  qa_id uuid references knowledge_qa(id) on delete cascade,
  target_kind text check (target_kind in ('website','sequence')),
  target_id uuid,
  primary key (qa_id, target_kind, target_id)
);   -- no rows = available everywhere
```

### 8.4 Tasks migration
- Open `review_ai_draft` and `ai_escalation` tasks: completed with note *"Moved to AI → Needs you"* (the underlying run or draft already shows there).
- Code stops creating those two task kinds. The enum values stay (no enum removal).

### 8.5 What is *not* stored
No prompt snapshot, prompt version or check result is added for Activity. Existing columns that store them are left as they are; nothing new reads or writes them for this feature. The "Why did it say that?" link in the AI Replies spec is dropped.

---

## 9. MCP

| Tool | Change |
|---|---|
| `ai_needs_you_list(type?, where_id?, mine?)` | New, read-only. Same rows as the page |
| `ai_activity_list(feature?, where_id?, from?, to?, q?)` | New, read-only. Same columns as the page |
| Existing `ai_review_list`, `inbox_pending`, `draft_reply`, etc. | Unchanged |
| `sequence_ai_replies_set`, `ai_variable_set_mode` | Accept `review` as well as `draft` for Replies (same value) |
| `website_assistant_set_mode(website_id, mode, when?)` | New ⚠ confirmation-gated, attended tokens only |

The `/outreach` skill's wording changes to the new names (Replies, Personalized lines, Website assistant; Off/Review/Auto). It doesn't need anything else.

---

## 10. Rollout

| Step | Contents |
|---|---|
| 1 | Views `ai_outputs` and `ai_needs_you`; AI sidebar item; Activity page; Needs you with Reply and Line cards; redirects; Tasks migration |
| 2 | Setup page (cards + General), variable editor moved; Settings → AI and the AI Personalization item removed; new names and Off/Review/Auto labels everywhere |
| 3 | Knowledge library with links; Q&A and unanswered questions merged; Question cards |
| 4 | Website assistant Review mode (`webchat_ai_suggestions`), Website cards; "Recent answers" replaced by filtered Activity |
| 5 | MCP tools and skill wording |

---

## 11. Tests

- Every item type appears in Needs you exactly when its condition holds and disappears after the action (and on Undo, comes back).
- Sending a reply from Needs you and from the inbox produce the same result (handoff, origin, counts).
- The badge equals the Mine count; a user never sees cards for chats or leads outside their access (RLS through `security_invoker`).
- Activity shows each AI output once, with the right feature, where and who; filters and search work; no outcome or prompt data is queried.
- Website Review mode never sends to the visitor; suggestion goes stale when the visitor writes again or an agent replies without it; timeout falls back to away settings.
- Knowledge: a source attached to a website and two sequences is retrieved by all three; removing it removes all links after confirmation.
- Old routes redirect to the right filtered views.
- No open `review_ai_draft` / `ai_escalation` tasks remain after migration, and no new ones are created.
