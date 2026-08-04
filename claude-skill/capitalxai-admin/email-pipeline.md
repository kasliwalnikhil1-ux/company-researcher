# CapitalxAI verified-email pipeline (Gmail Compose method)

Find work emails the Name2Email way: type "First Last domain" into Gmail's Compose **To** field and read the autocomplete. Runs in the **user's browser** (they must be logged into Gmail) and records every outcome in the app via the connector, so verified emails land on the person's record and nobody is ever searched twice.

Trigger phrases: "find emails for ...", "fill missing emails", a pasted list/CSV of name + domain rows.

## Setup — once per run

1. Ask the user to select/authorize the browser (same rule as LinkedIn access in [research-pipeline.md](research-pipeline.md)) and confirm they're logged into Gmail in it.
2. This method is powered by the **Name2Email extension** — it must be installed and active in that browser profile. Its marker is a **magnifying-glass icon at the right end of the To field** (next to Cc/Bcc) when composing. No icon = wrong profile; ask the user for one where the extension is enabled.
3. Open https://mail.google.com in that browser. Keep using the same tab for the whole run.

## Safety rules — absolute

- **NEVER click Send.** Only type into the To field, read the autocomplete, then discard/close the compose box. Nothing is ever sent at any point.
- **Never invent or guess an address.** Record only what Gmail actually shows. A pattern like first@domain that Gmail did not show is a guess — not a result.
- **Every searched person gets exactly one recorded outcome** (found / not_found / unknown) via `save_email_result`. No row skipped, no search left unrecorded — unrecorded searches cause endless re-searching.

## The procedure — per person

1. **Clean the inputs.** Name: strip titles (Dr., Mr., Ms., Prof.) and middle names — keep exactly first + last ("Dr. Naman Kasliwal" → "Naman Kasliwal"; "John D Snow" → "John Snow"). Domain: strip protocol, `www.`, trailing slash/period → bare domain (`www.sensesindia.in` → `sensesindia.in`).
2. **Compose.** Click Compose to open a new message window.
3. **Type into the To field**: first name, space, last name, space, domain — e.g. `Naman Kasliwal kaptured.ai` — then wait 2–3 seconds for autocomplete.
4. **Read the result.**
   - One or more suggestions shown → record every address that **contains this row's domain**.
   - **No dropdown at all** → click the **magnifying-glass icon** at the right of the To field (the Name2Email trigger) and wait another 2–3 seconds; suggestions often only appear after this click.
   - Explicit "Emails were not found" → result is **not_found** (blank email).
   - Gmail doesn't load, compose fails, or the result is unclear → result is **unknown**.

   **Dead-silence check**: if a search shows *nothing at all* even after clicking the magnifying glass, run one **control search** with a pair known to resolve (e.g. the user's own name + their domain). Control also silent → the extension isn't active in this profile: **stop the run, record nothing** (do not mass-mark people unknown for an environment failure), and ask the user to enable/sign into Name2Email in that profile or pick another browser.
5. **Close without sending.** Discard the compose box before the next person.
6. **Record immediately** with `save_email_result`:
   - `status: "found"` + `emails: [...]` → merged into the person's `email` field and `email_verified` set true, with provenance stamped.
   - `status: "not_found"` → stamped so they're never searched again.
   - `status: "unknown"` → stamped; retryable later via `get_email_candidates` with `include_unknown: true`.

## Mode A — user-provided list/CSV

Rows of person name + domain. Work **top to bottom, one at a time; every input row produces exactly one output row** — no skips, no reordering.

Per row, after the Gmail steps: locate the person in the database — `find_investors` by name (narrow with the domain via `at_firm_domain` if needed). Found → `save_email_result`. Not in the database → put the result in the output table only and flag "not in DB" (offer to add them via the research pipeline; don't auto-add).

End with the full output table: name | domain | email(s) or blank | status | saved-to-DB?

## Mode B — "fill missing emails" from the database

1. `get_email_candidates` (default 1 person; raise `limit` if the user asks for a batch, `firm_domain` to focus on one firm). It returns only **active** investors (`active = true`), never-searched, with a firm domain to search with — found/not_found/unknown people are excluded automatically. If it comes back empty, `include_unknown_active: true` widens to people whose active status isn't set yet (common for unresearched records); inactive investors are never returned.
2. Run the procedure for each candidate and `save_email_result` immediately per person (never batch the saves).
3. If the user wants to retry past failures: same flow with `include_unknown: true`. `not_found` results are final unless the user explicitly says to redo someone.
4. Report: per person — searched string, outcome, and what was saved. If no candidates remain, say so; the remaining gap is people without firm affiliations (fix via roster runs).
