# Editing a running sequence (drafts, publish impact, pinning, queued text, pool, A/B)

Managers only. The rule: **saving is not publishing.** A draft never reaches a lead. Publishing shows who it touches first. Messages already sent never change.

## 1. Which tool

| You want to | Tool | On a live sequence |
|---|---|---|
| Change the wording of a step (or of one A/B variant) | `sequence_edit_copy(sequence_id, edits:[{node_id, variant_id?, text, subject?}])` | impact → confirm. `update_queued` defaults to **true** |
| Change a delay or a step's `wait` | `sequence_edit_timing(sequence_id, edits:[{node_id, wait}])` | impact → confirm. `reschedule_delays` defaults to **true** |
| Add, remove or reorder steps; change settings, name, brief, assignment | `sequence_update(sequence_id, steps \| graph, settings?, …)` | impact → confirm. Settings / name / brief alone write no new version |
| Prepare changes without going live | `sequence_draft_save` → `sequence_validate(sequence_id, draft:true)` → `sequence_publish_impact` → `sequence_publish` | the web builder auto-saves to the same draft |
| Throw a draft away | `sequence_draft_discard` | ask first: a teammate may be editing it |
| Just look at the impact | `sequence_publish_impact(sequence_id, steps?)` | read-only |

A sequence that was never activated (status `draft`) saves directly, with no confirmation.

## 2. Read the impact out loud

The first call returns the impact as the `effect_summary`. Say it in plain words, for example:

> 214 leads are in flight. 37 are on or after a step you changed, 172 have not reached it yet, 5 are already pinned to an older version. 12 messages with the old text are already queued. 40 leads are waiting in the delay you changed.

Then ask the one question that matters:

- **`mode: "all"`** (default): every lead that has not reached a changed step follows the new version from its next step.
  - `update_queued: true` → the 12 queued messages render again from the new text when they are sent. Texts a person hand-edited or approved are kept.
  - `reschedule_delays: true` → leads waiting in a changed delay get their wait recomputed from when they entered it. Some may become due now; allowances and working hours still meter the sends.
  - `removed_mode: "skip" | "exit"` → leads sitting on a step you removed move to the next step of the old version, or exit.
- **`mode: "new_only"`**: leads in flight are **pinned** to the version they are on and finish on it. Only leads enrolled from now on get the new version. Use it when the user does not want anyone mid-conversation to see a different story.

Optional `note` is shown in `sequence_versions`. Repeat the call with identical arguments + `confirmation_token`.

`E_DRAFT_STALE`: someone else published while this draft was open. Call again without a token to get the fresh impact, show it, and pass `force: true` only if the user agrees to overwrite.

## 3. After a `new_only` publish

`sequence_versions` lists each version with `publish_mode` and `live_leads` (how many leads still run on it). `sequence_move_to_latest(sequence_id, version)` ⚠ brings pinned leads forward; a lead whose current step does not exist in the latest version stays where it is (`kept_on_old_version`). `sequence_restore` ⚠ re-publishes an old version as the new head.

## 4. Queued messages of one step

- `sequence_queued_actions(sequence_id, node_id)`: what is queued, for whom, with which text. `renders_at_send: true` means the text is produced when it is sent.
- `sequence_queued_edit(sequence_id, node_id, action_id, text)`: set the exact text of **one** queued message. Show it to the user first: this text is sent as written. Returns `updated: false` when the message was already picked up.
- `sequence_queued_edit(…, refresh:true)`: "update them too" for a whole step. `reschedule_delay:true` on a delay step recomputes the waits.

## 5. Adding or removing a sender

Never edit the pool of a live sequence with `sequence_update`. Use:

1. `sequence_pool_preview(sequence_id, pool)` → `untouched_total` (leads with nothing sent and no invitation pending: the only ones that may move), `would_move`, per sender `untouched / contacted / after`, `contacted_on_removed`.
2. `sequence_pool_set(sequence_id, pool, rebalance?, contacted: "keep"|"exit")` ⚠. Untouched leads of a removed sender always move. `rebalance: true` also evens out untouched leads across the pool. Leads a sender already contacted never change sender, so nothing is sent twice and no lead sees two senders. `contacted: "exit"` ends the leads a removed sender already contacted; `keep` lets them finish with it.

## 6. A/B tests

- Add `variants` to an invite / message / inmail / email step (2 to 5, optional `weight`). Assignment is sticky per lead, so retries and previews show the same variant.
- `sequence_ab_results(sequence_id, node_id)`: per variant sent, accepted, replies, **interested** and rates; `judged_on` (acceptance for invitations, otherwise interested replies); `confidence_vs_leader` and `verdict_vs_leader`. **No winner under 100 sends per variant** (`enough_data: false`). Quote the verdicts. Do not run your own statistics, and do not call a winner the platform did not call.
- `sequence_promote_variant(sequence_id, node_id, variant_id)` ⚠: the variant goes to 100%, the others to 0, published as a new version. When `can_promote` is false the confirmation says so; promoting anyway is the user's judgement call, never yours.
- `report_sequence` lists every test of a sequence under `ab_tests`. Whole-path tests (`ab_split` steps) are read the same way but cannot be promoted: edit the branch weights.
