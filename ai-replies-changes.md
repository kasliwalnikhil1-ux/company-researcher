# AI Replies — changes after v1.1

**Applies to:** `ai-auto-reply-PRD.md` v1.1 as built (migrations 0059–0064, functions F32–F37).
**Replaces:** `ai-replies-sequence-level-delta.md` and `ai-replies-v1.2-changes.md`. This file is the single source for everything decided since v1.1.
**Migrations:** `0065_ai_replies_v2` (everything in §1–§8) and `0066_ai_replies_assist` (§9). If you already ran the earlier `0065_ai_replies_sequence_scope` from the delta file, run §12.2 instead of §12.1.

---

## 0. Summary

| # | Change | Section |
|---|---|---|
| 1 | AI Replies is a **sequence setting**: each sequence has its own mode, master prompt and limits. Nothing is set at workspace, client or sender level except the per-sender daily cap | §1 |
| 2 | **Stop step**: every master prompt has a *Stop when* section. Once the prospect is interested and has the calendar link (or a time is agreed), the conversation is **handed off** and the AI never auto-replies in it again. Any message a person sends in the chat also hands it off | §2 |
| 3 | **Pausing a sequence pauses its AI replies**. Scheduled replies turn back into drafts; resuming doesn't answer the backlog | §3 |
| 4 | **Simpler setup**: one card in the sequence builder, consent once per sender (skipped for the operator's own accounts), a 20-reply warm-up instead of the graduation gate | §4 |
| 5 | **Draft with AI** button in the inbox, running exactly the Auto pipeline on demand | §5 |
| 6 | **Prospects who come back** after days or weeks get a new session (and a Re-engage stage after 30 days); handed-off owners are told | §6 |
| 7 | **Scenarios**: the Situations part of the prompt becomes on/off cards; every reply is labelled with the scenario that handled it | §9.1 |
| 8 | **Knowledge**: attach website, documents and Q&A to a sequence's prompt | §9.2 |
| 9 | **Unanswered questions**: questions the AI couldn't answer, grouped, with "Add answer" | §9.3 |
| 10 | **Lead notes**: key facts per lead (budget, timeline, objections…) picked up from conversations, shown in the inbox, used in every draft | §9.4 |
| 11 | **Improve my text** and **Translate** in the composer | §9.5 |
| 12 | **Gone quiet → task**: if a prospect stops replying mid-conversation for N days, a person gets a task (no AI nudges) | §9.6 |

Deferred: custom tools (a calendar check is the first one worth building), audience controls, natural-language conversation search.

---

## 1. AI Replies per sequence

### 1.1 Where settings live

| Level | Holds |
|---|---|
| **Sequence** (`sequence_reply_settings`) | Mode, master prompt (with scenarios, knowledge, Q&A), pitch-after, max AI replies per conversation, warm-up counter, handoff stage, reply delay, languages, disclosure line, blocked countries, returning/dormant thresholds, gone-quiet days |
| **Workspace** (`workspace_reply_settings`) | Per-sender daily AI send cap (counts across all sequences), default prompt for new sequences |
| **Sender** | Owner consent only (§4.2) |
| **Chat** | Stop AI in this chat / Resume AI (§2.4) |

There is no workspace-wide mode and no client- or sender-level override. v1.1's `reply_policies` becomes read-only legacy.

### 1.2 Modes (per sequence)

| Mode | Behaviour | Default |
|---|---|---|
| Off | Nothing beyond today's behaviour | — |
| Draft | Every eligible reply gets a draft in the composer; a person sends | **Every new sequence**, template prompt pre-filled |
| Auto | Sends by itself after the hold; hands off at the stop step or escalates when the prompt or safety floor says so | Opt-in; needs sender consent (§4.2) |

A new sequence copies the workspace's default prompt (or the built-in template). **Copy from sequence** copies another sequence's prompt, scenarios, knowledge links and Q&A as an independent copy. Duplicating a sequence does the same; the copy starts in Draft.

### 1.3 Which sequence a conversation belongs to

Resolved when a run starts and stored on `chats.reply_sequence_id`:
1. The sequence whose message the prospect answered (`answering`: sequence · step · variant).
2. Else the lead's most recent enrolment on this chat's sender.
3. Else none → AI Replies is off for this conversation (manual outreach, inbound-cold). **Draft with AI** still works (§5).

The chat keeps that sequence after the enrolment exits on reply. If the lead is later enrolled in another sequence on the same sender and replies to *that* sequence's message, the chat switches: stage resets to Engage, counters reset, and any handoff is cleared (it's a new conversation). Logged.

### 1.4 Changing settings on a live sequence

No publish-impact screen. A toast: *"Applies to the next reply in 14 open conversations."* A substantive prompt change (anything outside Style) redrafts replies currently scheduled on the old version.

---

## 2. Stop step and handoff

### 2.1 In the master prompt

Required last section of the prompt (template default):

```markdown
## Stop when
Stop replying after any of these. A person takes over from there.
- I've shared my calendar link, or we've agreed a meeting time.
- They say they're interested and want to talk, and I've told them how to book.
- They ask to speak to someone directly.
```

UI stages: **Engage → Relate → Pitch → Meeting · AI stops here** (plus **Re-engage** as the entry point for dormant conversations, §6). The editor warns (doesn't block) when *Stop when* is missing: *"No Stop section — the AI will only stop after 6 replies."*

### 2.2 Triggers

| # | Trigger | Detected in | Final reply? |
|---|---|---|---|
| T1 | A person sends any message in the chat: inbox, MCP, or from their phone/LinkedIn (`external_device`) | `sendChatMessage()` / F2 | — (theirs) |
| T2 | Prospect confirms a meeting or says they've booked (F18 flag `meeting_confirmed`) | F18 → F32 | As the prompt says (e.g. one-line thanks), then stop |
| T3 | The AI reply about to be sent contains a scheduling link (`ops.scheduling_domains`) | F32, enforced at send | Yes, this reply, then stop |
| T4 | The model returns `stop_after_send: true` for a *Stop when* rule | F32 | Yes if `send`; if `no_reply`, stop now |
| T5 | `ai_replies_count` reaches `max_ai_replies_per_chat` (default 6) in the current session | F32 gate | Stop now |
| T6 | Lead's CRM stage at or past the sequence's `handoff_stage_id` (if set) | F32 gate | Stop now |
| T7 | Calendar booking webhook (once a calendar is connected, v2) | webhook | Stop now |
| T8 | **Stop AI in this chat** clicked | UI / MCP | Stop now |

Scheduling domains (seed, editable): `calendly.com`, `cal.com`, `savvycal.com`, `tidycal.com`, `zcal.co`, `meetings.hubspot.com`, `calendar.app.google`, `outlook.office.com/bookwithme`, `koalendar.com`, `youcanbook.me`. T3 is the deterministic backstop for T4: a calendar link can never go out without the conversation stopping.

### 2.3 What handoff does — `ai_handoff(chat_id, reason, run_id)`

1. Sets `chats.ai_handed_off_at`, `ai_handoff_reason` (`human_replied` · `meeting_confirmed` · `calendar_sent` · `stop_rule` · `max_replies` · `stage` · `booking` · `manual`), `ai_handoff_rule`, `ai_handoff_run_id`.
2. Cancels any active run on the chat (`handed_off`).
3. Task `ai_handoff` (source `system`) to the chat assignee, else the sequence owner: *"Meeting stage — Priya Nair (Razorpay) · calendar link sent · over to you"*, due today. Not created for T1 (a person is already in it).
4. Notification in-app + email + push (not for T1).
5. Tag `ai-handed-off` on the lead.
6. If `handoff_stage_id` is set and the lead is below it, move the lead there (forward only).

### 2.4 After handoff

- `enqueue_ai_reply` creates **no run** for a handed-off chat: no auto-send, no automatic draft.
- **Draft with AI** still works (a person asking).
- Header: *"AI handed off · calendar link sent · 2 Oct"*.
- **Resume AI** (chat menu) clears the handoff; audit-logged. Prospect text can never resume it.
- The inbox filter **Handed off by AI** is the "meetings to take over" list.

### 2.5 Model contract additions

```json
{ "decision": "send | escalate | no_reply",
  "stop_after_send": true,
  "stop_rule": "I've shared my calendar link, or we've agreed a meeting time.",
  "scenario_id": "uuid | null",
  "...": "v1.1 fields unchanged" }
```

Floor line: *"If a Stop when rule is met by this reply or by what they said, set `stop_after_send: true` and name the rule."* F18 adds flag `meeting_confirmed`.

---

## 3. Pause and archive

| Sequence | AI replies |
|---|---|
| Active | Normal |
| **Paused** | Nothing auto-sends. On pause, every scheduled AI reply for its conversations goes back to a draft (`draft_ready`, reason `sequence_paused`). New prospect replies still get a draft — drafts never send by themselves |
| **Resumed** | Auto restarts from the **next new message**. Replies received during the pause keep their drafts; the resume dialog says *"5 conversations got replies while paused — drafts are waiting in the inbox."* |
| Archived | Same as paused, permanently |

Effective mode = `min(sequence mode, draft)` whenever the sequence isn't active. F32 leaves runs whose newest inbound predates `sequences.resumed_at` in `draft_ready`.

---

## 4. Simpler setup

### 4.1 The sequence-builder card (the whole UI for settings)

```
AI replies                         [ Off | Draft | Auto ]

┌ Prompt ─────────────────────────────────────────────────┐
│ Who I am · How a conversation goes · Stop when · Facts · │
│ Style   (template, fully editable)                       │
└──────────────────────────────────────────────────────────┘
Copy from sequence ▾

Scenarios   Pricing question ● · Meeting time proposed ● · Not now ● · + Add     (§9.1)
Knowledge   kaptured.ai (42 pages) · Rate card.pdf · 12 Q&A · + Add               (§9.2)

Pitch after [2] replies · At most [6] AI replies per conversation

Engage → Relate → Pitch → Meeting · AI stops here

[ Test a conversation ]

▸ Advanced: reply delay · languages · AI disclosure line · move lead to stage on handoff ·
            returning after [3] / dormant after [30] days · task if quiet for [7] days
```

- Auto with a sender who hasn't consented: *"Naman's replies will be drafts until he approves AI replies (request sent)."*
- During warm-up: *"First 20 replies wait 30 min so you can check them (14 left)."*
- **Test a conversation** (F37): play the prospect; each AI turn shows stage, scenario, facts used, checks and the decision. Tests unsaved edits.

Removed from the UI: prompt library page, Guided/Raw toggle, per-chat mode menu, pause toggle, reply-settings publish impact, graduation panel.

### 4.2 Consent once per sender

- One grant per sender: *"AI may reply as me in the sequences my team turns on."* Weekly digest lists which sequences used it.
- **Not requested** when the sender owner is the operator (`owner_is_operator`).
- No re-consent on prompt edits. Revoking cancels scheduled sends within ≤ 60 s.
- v1.1 already stores one consent per sender; its `master_prompt_id` / `master_prompt_version` columns become nullable and unused.

### 4.3 Warm-up instead of graduation

- Auto works as soon as it's chosen (consent permitting). `graduation_status()` is no longer a gate; its stats stay in reporting.
- `warmup_remaining` starts at **20** per sequence. While > 0, each auto reply is scheduled **30–40 min** out (inside working hours) and the assignee is notified *"AI will reply to Priya in 30 min — Send now · Edit · Cancel"*. Each auto send decrements it; a substantive prompt edit resets it to at least 10.
- The v1.1 breakers stay (≥ 25% of the last 20 auto replies cancelled or edited → back to Draft, with notification).

---

## 5. Draft with AI (unified inbox)

### 5.1 One engine

1. Extract F32's steps into `/packages/ai-replies/engine.ts`: `buildContext → draft → validate → verify → decide`.
2. F32 runs `engine.run(run, {trigger:'auto'})`.
3. New **F38 `ai-reply-draft-now`** runs `engine.run(run, {trigger:'manual', guidance?})`.
4. `draft_reply` / `draft_replies_bulk` (app + MCP) are re-pointed at F38; the old draft prompt is deleted.

**Parity rule:** for the same chat, inbound messages and prompt version, the manual request is byte-identical to the auto one except the `trigger: manual` line and optional guidance. Tested.

### 5.2 Same and different

| | Auto | Draft with AI |
|---|---|---|
| Prompt, scenarios, knowledge, lead notes, context | Sequence's | Same. No sequence → workspace default prompt → template (panel says which) |
| Floor, validator, verifier | Block / escalate | Same checks, shown as **warnings**. A denial of being AI is never returned |
| Debounce, gates, working hours, caps | Apply | Skipped |
| Handed-off chats | No run | Works; *"AI handed off — this draft is for you to send"* |
| Stop, warm-up, reply count | Apply | Ignored (sending = human send = T1) |
| Escalate decision | No send | Draft returned with the reason as a warning; if no text, one retry: *"A person asked for a draft; write it and list your concerns"* |
| Sends | After the hold | Never |
| Cost | 1 AI action | 1 per click; 60 clicks/hour per user |

### 5.3 Endpoint

`POST /functions/v1/ai-reply-draft-now` (user JWT; can read chat + `members.can_reply`)

```json
// request
{ "chat_id": "uuid", "guidance": "shorter, ask about budget", "variants": 1 }
// response
{ "run_id": "uuid", "source": "existing_auto | new",
  "prompt": { "sequence": "Fintech CFOs", "version": 7, "fallback": null },
  "drafts": [{ "text": "…", "stage_before": "engage", "stage_after": "relate", "move": "relate",
               "scenario": "Pricing question", "facts_used": [ … ],
               "warnings": [{ "code": "verifier_unsupported", "text": "“40+ brands” isn't in the prompt" }],
               "would_stop": true, "stop_rule": "…" }] }
```

`variants` 1–3 (extra variants at temperature 0.7). `guidance` ≤ 300 chars, placed after the prompt and below the floor. Timeout 25 s, target p95 < 8 s, streamed via SSE when supported.

### 5.4 With an Auto run on the same chat

| Chat state | Click result |
|---|---|
| Auto `draft_ready` | Show it instantly (`existing_auto`); Regenerate makes a new one |
| Auto `scheduled` | Show the scheduled text + banner; **Edit** or **Regenerate** cancels the scheduled send (`taken_manual`) — no double send |
| Auto `debouncing` / `drafting` | Cancel it (`taken_manual`), draft now |
| None | New run, `trigger='manual'`, `draft_ready` |

New prospect message while a manual draft is open: *"New message from Priya — Regenerate?"*, never a silent replace.

### 5.5 Composer

```
┌──────────────────────────────────────────────────────────────┐
│ Great question — most of our jewellery films take two…      │
├──────────────────────────────────────────────────────────────┤
│ ✦ AI draft · Stage 2 · Relate · Pricing question · v7        │
│ ⚠ "40+ brands" isn't in your prompt                          │
│ Ends the AI conversation when sent (calendar link)           │
│ [Regenerate] [Shorter] [More formal] [Instruction…]          │
└──────────────────────────────────────────────────────────────┘
[ ✦ Draft with AI ] [ Improve my text ] [ Translate ▾ ]         [ Send ]
```

- ⌘/Ctrl + J = Draft with AI. Typed text present → *Replace / Insert below / Cancel*.
- In Draft mode the automatic draft is already in the box; the button reads **Regenerate**.
- Realtime subscription on `ai_reply_runs` for the open chat: a new automatic draft shows *"AI draft ready — View"*, never overwriting typed text.
- Sending stores `final_text`, `edit_distance`, `origin` (`ai_draft_sent` / `ai_edited`) on the run.

---

## 6. Prospects who come back after a gap

**Gap** = time between the prospect's new message and the previous message in the chat. Thresholds per sequence (Advanced): `returning_after_days` = **3**, `dormant_after_days` = **30**.

| Gap / state | Treatment |
|---|---|
| < 3 days | Normal |
| **3–30 days — Returning** | New session: reply count and exchanges reset, stage kept. Drafter told the gap. No pitch in the first reply unless they ask or the stage was already past Pitch |
| **> 30 days — Dormant** | New session, stage **Re-engage**: acknowledge, one-line recap, ask what's changed. Pitch after 1 exchange, or immediately if they ask |
| **Handed off** (any gap) | No AI run. Handoff owner notified, handoff task reopened: *"Priya Nair came back after 23 days (handed off 2 Oct · calendar link sent)"* |
| Sequence paused / archived | Draft only; assignee notified *"came back after 41 days — sequence is archived, draft waiting"* |
| Answering a newer sequence's message | That sequence's conversation (§1.3) |

Always: open follow-up tasks for this lead + chat created by the AI or system (`source in ('ai','system')`) are completed with *"They replied on 29 Sep"*; tasks a person created stay open with a *"They replied"* marker.

State block additions: `gap_days`, `last_exchange_on`, `session: normal|returning|dormant`, `previous_stage`, `lead_notes` (§9.4). Floor line: *"If session is returning or dormant, answer what they wrote now; don't answer old questions as if new; check before assuming anything discussed still holds."*

Template addition under *How a conversation goes*:

```markdown
Coming back after a gap
- A few days later: pick up naturally, no apology, answer what they wrote now.
- Over a month later (Re-engage): acknowledge it lightly, recap in one line what we discussed,
  ask what's changed on their side. Don't restart discovery or re-pitch unless they ask.
```

The "live back-and-forth" fast delay never applies to the first reply of a returning or dormant session.

---

## 7. Function changes (§1–§6)

| Fn | Change |
|---|---|
| `enqueue_ai_reply` | 1) handed off → no run (reopen handoff task + notify if gap ≥ returning). 2) Resolve `reply_sequence_id` (§1.3); none → no run. 3) Gap → session start / Re-engage (§6). 4) Complete AI/system follow-up tasks for the lead + chat |
| `sendChatMessage()` (F15, MCP sends) | Human origins → `ai_handoff(chat,'human_replied')` after sending. Replaces `paused_human` |
| F2 outbound `external_device` | `ai_handoff(chat,'human_replied')` |
| F18 | Flags `meeting_confirmed`; `questions[]` kept (feeds §9.3) |
| F32 | Runs on the shared engine. Loads `sequence_reply_settings` + prompt + scenarios + knowledge + lead notes in one query. Mode = min(sequence mode, sequence active ? mode : draft, consent). Skips backlog before `resumed_at`. T5/T6 → handoff. T3 domain check forces `stop_after_send`. Warm-up timing + notify. Session fields into the state block. Writes `scenario_id` on the run |
| F33 | After send: `stop_after_send` → `ai_handoff(chat, T3 ? 'calendar_sent' : 'stop_rule', run)`; decrement `warmup_remaining`. Recheck: not handed off, sequence active, consent valid |
| F34 consent | Per sender; skip for `owner_is_operator`; no re-consent on edits |
| F36 breakers | Scope = sequence; downgrade sets `sequence_reply_settings.mode = 'draft'` |
| F37 simulate | Takes `sequence_id` or unsaved prompt/scenarios; returns run details (stage, scenario, facts, checks, decision, would_stop) |
| F38 `ai-reply-draft-now` | New (§5) |
| `sequence_pause` / `sequence_archive` | `ai_reply_demote_scheduled(sequence_id, reason)` |
| `sequence_activate` (resume) | `sequences.resumed_at = now()`; returns drafts-waiting count |
| `sequence_create` / duplicate | Create `sequence_reply_settings` (Draft) + prompt copy |
| `master_prompt_update` | Substantive change → `warmup_remaining = greatest(warmup_remaining, 10)`; warn when *Stop when* missing |
| New SQL | `ai_handoff()`, `ai_resume_chat()`, `ai_reply_demote_scheduled()` |

---

## 8. MCP (§1–§6)

| Before | After |
|---|---|
| `reply_policy_get/set(scope)` | `sequence_ai_replies_get/set(sequence_id, {mode, pitch_after_replies, max_ai_replies_per_chat, handoff_stage_id, delay, languages, disclosure, returning_after_days, dormant_after_days, inactivity_days})` ⚠; `warmup_remaining` read-only |
| `master_prompt_get/update(scope)` | `master_prompt_get/update(sequence_id)` ⚠ |
| — | `chat_ai_stop(chat_id)` ⚠, `chat_ai_resume(chat_id)` ⚠ |
| `draft_reply`, `draft_replies_bulk` | Now F38; return the §5.3 shape |
| `inbox_pending` | Rows add `ai: {state: replying|handed_off|off, handoff_reason?, handed_off_at?, session?, gap_days?}` |
| `sequence_get`, `sequences_list` | Include `ai_replies: {mode, open_by_stage, handed_off_7d}` |
| `sequence_create` | Accepts `ai_replies: {mode: off|draft, copy_prompt_from?}` |

Unattended tokens stay read-only for all of these.

---

## 9. Assist features (Chatwoot Captain–style)

### 9.1 Scenarios

The *Situations* part of the prompt becomes a list of cards per sequence prompt:

| Field | Example |
|---|---|
| Title | Pricing question |
| When | They ask what it costs, rates, budget, or a quote |
| Do | Say projects start at ₹X for a 30-second film; offer a 15-min call for an exact quote |
| On/off | ● |

- Compiled into the prompt under `## Situations`, in card order, enabled cards only. Disabled cards are kept, not deleted.
- The model returns `scenario_id` (or null when a stage rule, not a scenario, drove the reply). It's shown on the hold banner, composer, message hover, simulator and activity log: *"Handled by: Pricing question"*.
- Adding, editing, toggling or reordering a card creates a new prompt version (substantive).
- Template ships with cards: Pricing question · Meeting time proposed · Not now · Not interested · Wrong person · Out of office · Just "thanks". Existing prompts keep their free-text Situations; the editor offers **Convert to cards** (parses `- When → Do` bullets, shows the result before saving).

### 9.2 Knowledge

- Per sequence prompt: attach **website** (crawl), **documents** (PDF, DOCX, TXT, MD) and **Q&A pairs**. Reuses the web-chat knowledge pipeline (sources, crawl schedule, chunking, hybrid retrieval, rerank) — a source can be shared by several sequences.
- Q&A pairs (`master_prompt_faqs`): if a prompt has ≤ 30, all go into the context; above that, retrieved with the chunks.
- Retrieval runs when F18 found a question or `asked_offer`/`pricing`; top 5 chunks + matching Q&A.
- Everything retrieved counts as an allowed fact for the validator/verifier (numbers, links, claims).
- The simulator shows which chunks/Q&A were used per turn.

### 9.3 Unanswered questions

A section on each sequence's AI page: questions prospects asked that the AI couldn't answer from the prompt or knowledge.

- **Collected from:** runs escalated with `not_covered` / `verifier_unsupported`; runs where the verifier said `answers_their_questions = false`; manual drafts with an unsupported-claim warning. The question text comes from F18 `questions[]`.
- **Grouped:** embedding similarity ≥ 0.85 within the sequence (F42, nightly, plus inline add). Each group shows the canonical question, count, last seen, 3 example messages with links.
- **Actions:** **Add answer** → creates a Q&A pair (`source = 'unanswered'`) on the sequence's prompt and marks the group answered; **Dismiss** (with reason). Answered groups that recur reopen.
- Sorted by count in the last 30 days. Badge on the sequence card when ≥ 3 open.

### 9.4 Lead notes

Short facts per lead, picked up from conversations and used in every draft.

- **Keys:** `budget`, `timeline`, `current_solution`, `pain`, `objection`, `decision_maker`, `interest`, `other`. Each item: text, source message, updated at, edited by.
- **Extraction (F39):** after each processed inbound burst, a Haiku-class call reads the new messages + existing notes and returns add/update/remove operations. Only things the **prospect** said; no sensitive personal details (health, family, finances beyond business budget). Items a person edited are locked — the AI can add but not change them.
- **Summary:** ≤ 400 characters, regenerated with the notes.
- **Shared across** senders and sequences for the same lead (a lead is one person).
- **Inbox:** side panel *"Lead notes"* with inline edit, delete, *"from Priya's message, 12 Sep"* links.
- **Drafts:** summary + items go into the state block for auto and manual drafts.
- Cost: included in the run (not a separate AI action).

### 9.5 Improve my text and Translate

F40 `ai-compose-assist` (user JWT, `can_reply`), 1 AI action per call:

| Action | Input | Output |
|---|---|---|
| `improve` | The composer text | Rewritten with the sequence prompt's Style and the thread context; meaning kept; validator warnings shown (e.g. a new number not in the facts) |
| `translate_out` | Composer text + target language (default: prospect's detected language) | Translation in the composer; original kept for undo |
| `translate_in` | A received message | Translation shown under the message, cached in `messages.translation` |

Improve never adds facts; if the person's text has a claim not in the prompt/knowledge, that's a warning, not a silent removal.

### 9.6 Gone quiet → task

- Per sequence `inactivity_days` (default **7**, empty = off).
- F41 daily: for chats where AI replies are active (not handed off), our message (AI or sequence) was last, and no prospect reply for `inactivity_days` → task `follow_up` (source `system`): *"Priya went quiet after Stage 2 · Relate · 7 days"*, assignee = chat assignee or sequence owner. Once per silence (`chats.ai_quiet_task_at`).
- No AI nudge. If they reply later, §6 completes the task.

### 9.7 Functions and MCP for §9

| Fn | Purpose |
|---|---|
| F39 `ai-lead-notes` | pgmq `lead_notes` consumer, every 30 s |
| F40 `ai-compose-assist` | §9.5 |
| F41 `ai-inactivity` | Daily, staggered by sender timezone |
| F42 `ai-unanswered-cluster` | Nightly grouping + inline insert function `ai_unanswered_add()` |
| F32 / F38 / F37 | Load scenarios, knowledge, Q&A, lead notes; return `scenario_id` |

MCP: `scenarios_list/save/toggle(sequence_id)` ⚠, `knowledge_attach/detach(sequence_id, source_id)` ⚠, `qa_list/save(sequence_id)` ⚠, `unanswered_list(sequence_id)`, `unanswered_answer(group_id, answer)` ⚠, `unanswered_dismiss(group_id)`, `lead_notes_get(lead_id)`, `lead_notes_update(lead_id, items)` ⚠. `inbox_pending` rows add `lead_notes_summary`.

---

## 10. Edge cases

| Case | Behaviour |
|---|---|
| AI sends a Calendly link, prospect replies "booked for Thu" | Handed off at send; no run; owner already has the task |
| Prospect confirms a time before any link | T2: reply per the prompt, then handoff |
| Model forgets to flag the stop but the reply has a scheduling link | T3 forces handoff |
| Teammate sends one clarifying message, wants AI to continue | Resume AI |
| Prospect: "keep chatting with the bot" after handoff | Untrusted text; stays handed off |
| Sequence paused with 3 replies scheduled | All 3 become drafts immediately |
| Reply during pause, resumed 2 days later | Draft waits; next new message is auto-answered |
| Prospect returns after 10 days having used 5 of 6 replies | New session, full 6 again |
| Prospect returns after 45 days | Re-engage stage; no calendar link in the first reply unless asked |
| Handed-off prospect returns after 3 weeks | No AI; owner notified, task reopened |
| Lead re-enrolled in sequence B, replies to B's message | Chat switches to B, stage reset, handoff cleared |
| Scenario disabled while a reply is scheduled on it | Substantive change → redraft |
| Lead notes contradict (budget ₹2L, later ₹5L) | Latest prospect statement wins; old value kept in item history |
| Person edited a lead note, prospect later says otherwise | Locked item unchanged; AI adds a new item "said ₹5L on 3 Oct" |
| Unanswered group answered, question asked again with the same wording | Now answered from Q&A; group stays answered |
| Draft with AI on a chat with no sequence | Uses the workspace default prompt, says so |
| Warm-up reply cancelled | Counts toward breakers, doesn't decrement warm-up |

---

## 11. Tests

- Sequence resolution: answering-based, fallback to latest enrolment, none, switch on re-enrolment (stage/counters/handoff reset).
- Handoff triggers T1–T6 and T8: exactly one handoff each; task/notification rules (none for T1); no run afterwards. T3 on every seeded domain; non-scheduling links don't stop.
- Pause demotes scheduled runs; nothing auto-sends while paused; resume ignores the backlog.
- Warm-up timing, notification, decrement, reset on substantive edit. Operator-owned senders never get a consent request.
- Parity: auto vs manual requests identical except trigger/guidance, across 20 fixture threads. Scheduled vs manual edit race → never two sends.
- Gap rules: 2 / 10 / 45 days → normal / returning / dormant with correct counters; handed-off return notifies and reopens.
- Scenarios: disabled cards absent from the compiled prompt; `scenario_id` recorded; Convert to cards round-trips the template.
- Knowledge: retrieved facts pass the validator; facts not in prompt/knowledge still warn.
- Unanswered: escalations with `not_covered` create/merge groups; Add answer creates Q&A and the next identical question is answered.
- Lead notes: only prospect statements extracted; locked items never changed by AI; notes appear in the state block.
- Compose assist: improve keeps meaning and flags new numbers; translations cached.
- Inactivity: one task per silence; completed when they reply.

---

## 12. Migrations

### 12.1 `0065_ai_replies_v2` — from v1.1 as built

```sql
-- ============ 1. Sequence-level settings ============
create table sequence_reply_settings (
  sequence_id        uuid primary key references sequences(id) on delete cascade,
  workspace_id       uuid not null references workspaces(id) on delete cascade,
  mode               reply_mode_t not null default 'draft',        -- 'off' | 'draft' | 'autopilot'
  master_prompt_id   uuid not null references master_prompts(id),
  pitch_after_replies     smallint not null default 2  check (pitch_after_replies between 0 and 5),
  max_ai_replies_per_chat smallint not null default 6  check (max_ai_replies_per_chat between 1 and 10),
  warmup_remaining        smallint not null default 20 check (warmup_remaining >= 0),
  handoff_stage_id   uuid references stages(id) on delete set null,
  delay_min_s        int not null default 240  check (delay_min_s >= 60),
  delay_max_s        int not null default 1200 check (delay_max_s <= 3600 and delay_max_s > delay_min_s),
  debounce_quiet_s   int not null default 120  check (debounce_quiet_s between 30 and 600),
  debounce_max_s     int not null default 600  check (debounce_max_s between 60 and 1800),
  stale_after_h      int not null default 12,
  languages          text[] not null default '{en}',
  disclosure         text,
  blocked_countries  text[] not null default '{}',
  returning_after_days smallint not null default 3  check (returning_after_days between 1 and 30),
  dormant_after_days   smallint not null default 30 check (dormant_after_days between 7 and 365),
  inactivity_days      smallint default 7 check (inactivity_days is null or inactivity_days between 1 and 60),
  updated_by         uuid references auth.users(id),
  updated_at         timestamptz not null default now(),
  constraint reply_gap_order check (dormant_after_days > returning_after_days)
);
create index on sequence_reply_settings(workspace_id, mode);

create table workspace_reply_settings (
  workspace_id                uuid primary key references workspaces(id) on delete cascade,
  max_ai_sends_per_sender_day int not null default 25 check (max_ai_sends_per_sender_day between 1 and 40),
  default_prompt_id           uuid references master_prompts(id)
);

alter table sequences add column resumed_at timestamptz;

-- ============ 2. Master prompts: per sequence, or library (workspace defaults) ============
alter table master_prompts drop constraint master_prompts_scope_check;
alter table master_prompts
  add column sequence_id uuid references sequences(id) on delete cascade,
  add column name text,
  add column copied_from_prompt_id uuid references master_prompts(id),
  add column copied_from_version int;
update master_prompts set scope = 'library',
       name = coalesce(name, case scope when 'workspace' then 'Workspace default' else 'Client prompt' end)
 where scope in ('workspace','client');
update master_prompts set sequence_id = scope_id where scope = 'sequence';
update master_prompts set scope_id = null where scope = 'library';
-- v1.1's unique index (workspace_id, scope, coalesce(scope_id,…)) must go: several library rows would collide.
-- Default name below; confirm with \di master_prompts*
drop index if exists master_prompts_workspace_id_scope_coalesce_idx;
alter table master_prompts add constraint master_prompts_scope_check
  check ((scope = 'sequence' and sequence_id is not null) or (scope = 'library' and sequence_id is null));
create unique index master_prompts_one_per_sequence on master_prompts(sequence_id) where scope = 'sequence';
alter table master_prompt_versions add column scenarios jsonb, add column faqs jsonb;   -- snapshots per version

-- ============ 3. Consent: per sender (already), no longer tied to a prompt ============
alter table ai_reply_consent
  alter column master_prompt_id drop not null,
  alter column master_prompt_version drop not null;

-- ============ 4. Chats ============
alter table chats
  add column reply_sequence_id     uuid references sequences(id) on delete set null,
  add column ai_handed_off_at      timestamptz,
  add column ai_handoff_reason     text check (ai_handoff_reason in
    ('human_replied','meeting_confirmed','calendar_sent','stop_rule','max_replies','stage','booking','manual')),
  add column ai_handoff_rule       text,
  add column ai_handoff_run_id     uuid references ai_reply_runs(id),
  add column ai_session_started_at timestamptz,
  add column ai_session_kind       text check (ai_session_kind in ('normal','returning','dormant')),
  add column ai_session_count      int not null default 1,
  add column ai_quiet_task_at      timestamptz;
create index on chats(reply_sequence_id) where ai_handed_off_at is null;
create index on chats(ai_handed_off_at desc) where ai_handed_off_at is not null;
-- people who already took over in v1.1 → handed off
update chats set ai_handed_off_at = coalesce(autopilot_paused_until - interval '72 hours', now()),
                 ai_handoff_reason = 'human_replied'
 where autopilot_state = 'paused_human';
alter table chats drop column reply_mode_override;      -- replaced by Stop AI / Resume AI

-- ============ 5. Runs ============
alter table ai_reply_runs
  add column sequence_id     uuid references sequences(id) on delete set null,
  add column trigger         text not null default 'auto' check (trigger in ('auto','manual')),
  add column requested_by    uuid references auth.users(id),
  add column requested_via   text check (requested_via in ('inbox','mcp')),
  add column guidance        text check (char_length(guidance) <= 300),
  add column variants        jsonb,
  add column stop_after_send boolean not null default false,
  add column stop_rule       text,
  add column scenario_id     uuid,                                   -- FK added in 0066
  add column gap_days        numeric(6,1),
  add column session_kind    text;
create index on ai_reply_runs(sequence_id, created_at desc);
create index on ai_reply_runs(requested_by, created_at desc) where trigger = 'manual';

-- ============ 6. Tasks, domains ============
alter type task_kind_t add value 'ai_handoff';
alter table tasks add column source text not null default 'user' check (source in ('user','ai','system'));

create table ops.scheduling_domains (host text primary key, path_prefix text);
insert into ops.scheduling_domains(host, path_prefix) values
  ('calendly.com',null),('cal.com',null),('savvycal.com',null),('tidycal.com',null),('zcal.co',null),
  ('meetings.hubspot.com',null),('calendar.app.google',null),('outlook.office.com','/bookwithme'),
  ('koalendar.com',null),('youcanbook.me',null);

-- ============ 7. Backfill ============
select migrate_ai_replies_v2();   -- §12.3

-- ============ 8. Legacy ============
alter table reply_policies rename to reply_policies_legacy;
revoke insert, update, delete on reply_policies_legacy from authenticated;
```

### 12.2 If the earlier `0065_ai_replies_sequence_scope` was already applied

Name this `0066_ai_replies_v2_reconcile` and run it instead of §12.1; then §12.4 becomes `0067`.

```sql
-- settings table exists: drop the removed toggle, add the new columns
alter table sequence_reply_settings drop column pause_ai_replies_with_sequence,
  add column pitch_after_replies     smallint not null default 2  check (pitch_after_replies between 0 and 5),
  add column max_ai_replies_per_chat smallint not null default 6  check (max_ai_replies_per_chat between 1 and 10),
  add column warmup_remaining        smallint not null default 20 check (warmup_remaining >= 0),
  add column handoff_stage_id        uuid references stages(id) on delete set null,
  add column languages               text[] not null default '{en}',
  add column returning_after_days    smallint not null default 3  check (returning_after_days between 1 and 30),
  add column dormant_after_days      smallint not null default 30 check (dormant_after_days between 7 and 365),
  add column inactivity_days         smallint default 7 check (inactivity_days is null or inactivity_days between 1 and 60),
  add constraint reply_gap_order check (dormant_after_days > returning_after_days);
alter table workspace_reply_settings rename column default_library_prompt_id to default_prompt_id;
alter table sequences add column resumed_at timestamptz;
alter table master_prompt_versions add column scenarios jsonb, add column faqs jsonb;

-- consent back to one per sender
drop index if exists ai_reply_consent_sender_id_sequence_id_idx;   -- confirm name with \di
alter table ai_reply_consent alter column sequence_id drop not null,
  alter column master_prompt_id drop not null, alter column master_prompt_version drop not null;
with ranked as (select id, row_number() over (partition by sender_id order by granted_at desc) rn
                from ai_reply_consent where revoked_at is null)
update ai_reply_consent c set
  sequence_id    = case when r.rn = 1 then null else c.sequence_id end,
  revoked_at     = case when r.rn = 1 then null else now() end,
  revoked_reason = case when r.rn = 1 then null else 'merged_to_sender_consent' end
from ranked r where r.id = c.id;
create unique index ai_reply_consent_one_per_sender on ai_reply_consent(sender_id) where revoked_at is null;

-- chats: the override constraint from the delta goes with the column
alter table chats drop constraint if exists chats_override_not_autopilot;
-- then run sections 4 (without reply_sequence_id, which exists), 5 (without sequence_id), 6 and 7 of §12.1
```

### 12.3 `migrate_ai_replies_v2()` (runs once)

For each workspace:
1. `workspace_reply_settings`: cap = workspace-scope v1.1 policy value (else 25); `default_prompt_id` = the ex-workspace prompt.
2. For each sequence (not deleted): settings from the old resolution (sequence → client → workspace policy; sender rows ignored); prompt = its own sequence prompt, else a copy of the client/workspace prompt (`copied_from_*` set). `pitch_after_replies`, `max_ai_replies_per_chat`, `handoff_stage_id`, `languages` from the prompt's v1.1 `settings` jsonb. `warmup_remaining = 0` for sequences already on autopilot, else 20.
3. Sender-scope v1.1 policies that differed from the sequence's resulting mode → one manager notification per sequence ("sender-level AI settings were removed").
4. Prompts without a `## Stop when` section: append the default section as a **style** version (doesn't reset warm-up), and the *Coming back after a gap* block under *How a conversation goes*.
5. Chats with a run in the last 30 days: set `reply_sequence_id` (§1.3), `ai_session_started_at = first run`, `ai_session_kind = 'normal'`.

### 12.4 `0066_ai_replies_assist` — §9

```sql
-- Scenarios
create table master_prompt_scenarios (
  id               uuid primary key default gen_random_uuid(),
  master_prompt_id uuid not null references master_prompts(id) on delete cascade,
  position         int not null,
  title            text not null check (char_length(title) <= 80),
  when_text        text not null check (char_length(when_text) <= 500),
  do_text          text not null check (char_length(do_text) <= 1500),
  enabled          boolean not null default true,
  updated_by       uuid references auth.users(id),
  updated_at       timestamptz not null default now()
);
create index on master_prompt_scenarios(master_prompt_id, position);
alter table ai_reply_runs add constraint ai_reply_runs_scenario_fk
  foreign key (scenario_id) references master_prompt_scenarios(id) on delete set null;

-- Knowledge + Q&A
alter table master_prompts add column knowledge_source_ids uuid[] not null default '{}';   -- web-chat knowledge sources
create table master_prompt_faqs (
  id               uuid primary key default gen_random_uuid(),
  master_prompt_id uuid not null references master_prompts(id) on delete cascade,
  question         text not null check (char_length(question) <= 500),
  answer           text not null check (char_length(answer) <= 2000),
  source           text not null default 'manual' check (source in ('manual','unanswered','import')),
  enabled          boolean not null default true,
  embedding        vector(1024),
  created_by       uuid references auth.users(id),
  created_at       timestamptz not null default now()
);
create index on master_prompt_faqs(master_prompt_id) where enabled;

-- Unanswered questions
create table ai_unanswered_questions (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references workspaces(id) on delete cascade,
  sequence_id      uuid not null references sequences(id) on delete cascade,
  master_prompt_id uuid not null references master_prompts(id) on delete cascade,
  canonical        text not null,
  embedding        vector(1024) not null,
  examples         jsonb not null default '[]',      -- [{run_id, chat_id, message_id, text, at}] (max 10)
  count_total      int not null default 1,
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  status           text not null default 'open' check (status in ('open','answered','dismissed')),
  answered_faq_id  uuid references master_prompt_faqs(id) on delete set null,
  dismissed_reason text
);
create index on ai_unanswered_questions(sequence_id, status, last_seen_at desc);

-- Lead notes
create table lead_ai_notes (
  lead_id      uuid primary key references leads(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  summary      text check (char_length(summary) <= 400),
  items        jsonb not null default '[]',
  -- [{id, key: budget|timeline|current_solution|pain|objection|decision_maker|interest|other,
  --   text, source_message_id, updated_at, edited_by, locked, history:[{text, at}]}]
  updated_at   timestamptz not null default now()
);
select pgmq.create('lead_notes');

-- Translation cache
alter table messages add column translation jsonb;   -- {lang, text, at}
```

RLS as the platform pattern: all readable by workspace members; `master_prompt_*` writable by managers; `lead_ai_notes` items editable by members with `can_reply`; `ai_unanswered_questions` actions by managers.

---

## 13. Build order

| Step | Contents | Risk |
|---|---|---|
| 1 | §12.1 migration + backfill; sequence resolution; sequence AI card (mode, prompt, two numbers, Advanced) | Low — Draft default |
| 2 | Shared engine + **Draft with AI** + composer | None — never sends |
| 3 | Stop step + handoff + Handed-off filter; pause/resume behaviour; human-send handoff | Low |
| 4 | Consent once per sender, warm-up, Auto on your own senders | Sends — own accounts first |
| 5 | Returning/dormant sessions | Low |
| 6 | §12.4 migration; Scenarios; Knowledge + Q&A | Low |
| 7 | Lead notes; Unanswered questions; Improve/Translate; gone-quiet tasks | Low |
| 8 | MCP updates for all of the above | — |
