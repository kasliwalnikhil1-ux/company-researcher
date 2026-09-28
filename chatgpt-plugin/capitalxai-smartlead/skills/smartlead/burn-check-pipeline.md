# Burn check

Goal: catch mailbox burn before it costs a domain. Output is a **pause / reduce recommendation**, applied only on confirmation.

## 1. Evidence
1. `get_account_deliverability()` — per mailbox over the last 7 days (or `from`/`to`): sent, bounced, bounce rate, reply rate, sends today vs limit, warmup spam rate, the previous window for comparison, and a verdict:
   - **pull** — bounce rate over the threshold on ≥ 20 sends, or SMTP/IMAP failing → out of rotation today
   - **reduce** — approaching the threshold, moved up ≥ 1 point, or warmup reputation/spam slipping
   - **warming** — still building warmup history; must not be in a live rotation
   - **ok**
2. `list_email_accounts(problems_only: true)` — connection failures, warmup paused/blocked, daily limit hit.
3. `get_warmup_status(email_account_ids: [flagged…])` — the day-by-day warmup picture: is spam placement a blip or a trend?
4. `smart_delivery_test_results()` — if a recent placement test exists, open it (`spam_test_id`) for inbox/promotions/spam per provider and per sender. Never create a test (credits).
5. For each pull/reduce mailbox, find where it is used: `list_campaigns(status:"ACTIVE", include_mailboxes:true)` or `get_campaign_settings(campaign_id)` → `rotation`.

Thresholds come from `smartlead_whoami` → `thresholds` (team settings in Supabase; the agent does not change them).

## 2. Report

| Mailbox | Verdict | Evidence | Used in | Recommended action |
|---|---|---|---|---|
| sam@getcapx.co | pull | bounce 4.1% on 310 sends (was 1.2%) | Fintech CFOs Q3 | remove from rotation; let warmup run 2 weeks |
| ria@getcapx.io | reduce | warmup reputation 86% | SaaS Founders | keep, lower the campaign's daily cap |
| new1@capxmail.com | warming | 9 days of warmup | — | keep out of rotation |

Also call out patterns: several mailboxes on **one domain** going bad together is a domain problem (DNS/blacklist), not a mailbox problem — say so, and suggest a human checks SPF/DKIM/DMARC and the placement test. A campaign whose bounce rate is high across **all** its mailboxes has a list problem, not a mailbox problem → recommend `pause_campaign` and a list check.

## 3. Apply — only on a yes, one action at a time
- Remove from rotation: `update_campaign_settings(campaign_id, remove_email_account_ids:[…])`. Undo = `add_email_account_ids`.
- Slow a campaign: `update_campaign_schedule(max_new_leads_per_day: lower, min_time_btw_emails: higher)`. Show before → after.
- Stop a campaign: `pause_campaign(campaign_id, reason)`. Undo = `resume_campaign` (gated).

Never: raise caps to compensate for a pulled mailbox, add a warming mailbox to fill the gap, disconnect or delete a mailbox, buy domains/mailboxes. Less volume today is the fix.

## 4. Follow-up
Say when to look again (usually 3–5 days for a reduced mailbox, 2 weeks for a pulled one) and what number should have moved.
