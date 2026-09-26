# Profile Studio — operator notes

Built 25 Sep 2026 from `linkedin-profile-management-PRD.md`. Lets a workspace edit the LinkedIn profiles of its own senders
(headline, About, photo + settings, cover, location, experience, education, skills, custom link), with the account owner's
field-level permission, per-group frequency ceilings, a snapshot ledger with honest rollback fidelity, templates + paced bulk
apply, sender-level experiments with a proper readout, a QA score, and MCP tools. Nothing here is auto-applied by AI.

## Where things live

| Layer | Files |
|---|---|
| SQL | `migrations/outreach/021_profile_enums.sql` (own call), `022_profile_studio.sql` (tables, ceilings, RLS, storage bucket), `023_profile_functions.sql` (RPCs, cron, grants). Smoke: `tests/smoke_05_profile_studio.sql` (54 assertions). |
| Serialiser | `supabase/functions/_shared/outreach/profile_serialiser.ts` — the ONLY module that builds the multipart body for `PATCH /users/me/edit`. Strict unknown-key rejection; `notify_network` hardcoded false; `open_to_work` / names refused. Golden tests: `profile_serialiser_test.ts` + `profile_serialiser.golden.json` (45 cases). |
| Runtime | `_shared/outreach/profile.ts` — snapshot normalisation, budgeted own-profile reads, apply (pre-snapshot → PATCH), post-verify diff, owner email with revert link, drift, weekly QA. Tests: `profile_test.ts`. |
| Functions | `outreach-profile` (user actions + the owner's public token pages), `outreach-worker-profile` (cron: tick every 5 min, weekly Monday 03:35 UTC). `worker-tick` dispatches `profile_edit` actions (execute.ts). `worker-health` blocks level-up on a critical QA failure. |
| MCP | `outreach-mcp/tools_profile.ts` — reads + confirmation-gated writes; safety policy resource updated. |
| Web | Sender page → **Profile** tab (`components/outreach/profile/ProfileStudio.tsx` + Preview / PhotoEditor / QaCard / AuthorityCard / HistoryList). Senders → **Profiles** sub-view (`app/outreach/senders/profiles`): Changes, Templates (+ bulk apply, sequence link), Experiments, Insights. Public pages (no login): `/profile-authority/[token]`, `/profile-approve/[token]`, `/profile-revert/[token]`. |

Deploy: `bash scripts/outreach-apply-migrations.sh` (021 is a separate call by design) → `OUTREACH_DEPLOY_EXTRA_ARGS="--use-api" bash scripts/outreach-deploy-functions.sh profile worker-profile worker-tick worker-health sender-manage mcp` → `bash scripts/outreach-smoke.sh`. Deno tests: `cd supabase/functions && deno test --allow-read --allow-env --allow-net --node-modules-dir=none _shared/outreach/profile_serialiser_test.ts _shared/outreach/profile_test.ts`.

## Owner-permission toggle (added the same day, user request)

`outreach_workspaces.settings.profile_owner_permission`, **off by default** (Settings → Workspace → Behaviour). Off: no authority is
needed, every change is direct, the Owner permission card is replaced by a note, and no owner emails go out (`notifyOwnerOfChange`
marks the change notified with no recipients). On: the PRD's model applies in full. Ceilings, warm-up, quiet period, identity check,
pacing and experiments are unaffected by the toggle. `outreach_profile_permission_required(ws)` is the single source of truth.

## Pipeline

`draft → validate → [awaiting_owner if any touched group is propose_only] → approved → queued (profile_edit action, paced) → pre-snapshot (selective sections, one profile_view) → PATCH → applied (provisional) → post-verify ≥90 s later (worker) → applied | partially_applied → owner email + 30-day revert token`.

- **Validation** (`outreach_profile_validate`, re-run at execution by `outreach_profile_change_for_action`): sender ok + not paused, LinkedIn, identity verified (hosted login / browser sign-in / OAuth; cookie-connected accounts and the manager flag `profile_identity_unverified` block), warm-up ≥ 1, 72 h quiet period after connect/reconnect, health ≥ 50, authority per group, per-group ceilings (`outreach_profile_ceilings`), 4/week combined, experiment lock, prohibited edits (open_to_work, notify_network, names; creating a position in bulk), field lengths.
- **One per sender per day** is the scheduler's job (`outreach_profile_schedule`): next working-hours slot, ≥1 h from any other queued profile edit in the workspace, ≤8 per workspace-day. The `profile_edit` action type has a platform ceiling of 1/day (warm-up level 0 → 0), so the ledger enforces it too.
- **Errors** (profile.ts): 429/5xx → one retry 2–6 h later, then failed + owner email. 422 → `E_PROFILE_IMAGE_REJECTED` / `E_PROFILE_ID_UNRESOLVED` / `E_PROFILE_REJECTED:<code>`, never retried. 401 → the change is parked as a draft (`outreach_profile_park_change`); it is never re-applied on reconnect without a human re-submitting.
- **Partial application**: post-verify compares each field with a selective read; a field not visible becomes `failed_fields[key]`; nothing is retried automatically.
- **Owner notification** is unconditional: `notifyPendingChanges` emails `owner_email` (+ the owner user's auth email) after verification or failure. Without Resend, the email is logged and `profile.owner_notified` is still audited with an empty recipient list; the revert link then exists only in the audit trail. Approval / permission links are shown to the operator ONLY when email is not configured or the sender has no owner email, and that exposure is audited (`profile.approval_link_exposed`, `profile.authority_link_exposed`) — same rule as reconnect links.

## Rollback fidelity (what the UI shows)

| Field | Fidelity | Source |
|---|---|---|
| headline, About, experience/education entry (by id), skills | Full | pre-change snapshot |
| photo / cover | Full if uploaded through the platform (asset kept in `outreach-profile-assets`), else Partial (URL from the snapshot; crop state lost) |
| picture / cover settings, custom link, skills_follow, **location** | Last written | previous applied change's payload. LinkedIn reports location as text, not the id the edit needs, so it is written-only here (PRD said full). |
| a position/education entry that was **added** | Not restorable | the connector cannot delete entries |

## Deviations from the PRD, deliberate

- Providers: LinkedIn only. The platform has no WhatsApp/Instagram senders (`outreach_provider_t`), so the reduced field set for those channels is not implemented.
- "Unattended tokens get read-only access": the MCP has no unattended tokens (every session is a member's OAuth grant). Writes are confirmation-gated; the note in `tools_profile.ts` says what to do if unattended tokens are ever added.
- Campaign-matched profiles (§8.3): a sequence can be linked to a template (`outreach_profile_link_sequence`, settings.profile_template_id) and `outreach_profile_sequence_match` reports which pool senders match. It is advisory and surfaced from Senders → Profiles → Templates; the sequence activation flow was not changed.
- Experience ids: `normaliseProfile` reads `id ?? position_id ?? experience_id` from the rich profile. If Unipile returns none (PRD open question 4), the editor says so and only "add a position" is offered.
- Image limits (open question 2): the editor enforces JPG/PNG/WebP ≤ 8 MB, photo ≥ 400×400, cover ≥ 1128 px wide, ≤ 7680 px. Tune `IMAGE_RULES` in `lib/outreach/profile.ts` once LinkedIn's real rejections are seen.
- Drift detection runs weekly only for senders the studio is used on (any active grant or applied change), max 60 reads per run, random order.

## Error codes

`E_NO_PROFILE_AUTHORITY`, `E_PROFILE_CEILING`, `E_PROFILE_WARMUP`, `E_PROFILE_QUIET_PERIOD`, `E_EXPERIMENT_LOCK`, `E_PROFILE_SENDER_NOT_OK`, `E_PROFILE_IDENTITY_UNVERIFIED`, `E_PROFILE_HEALTH`, `E_PROFILE_PROHIBITED`, `E_PROFILE_STATE`, `E_PROFILE_UNRECOVERABLE`, `E_PROFILE_LINK_USED`, `E_PROFILE_LINK_EXPIRED`, `E_PROFILE_APPROVAL_EXPIRED`, `E_EXPERIMENT_NO_WINNER`, `E_EXPERIMENT_NOT_READY`, `E_PREVIEW_EXPIRED`, `E_PROFILE_ID_UNRESOLVED`, `E_PROFILE_IMAGE_REJECTED`, `E_BUDGET_PROFILE_VIEW`. Human text in `lib/outreach/api.ts` (humanize) and `lib/outreach/reasons.ts`.
