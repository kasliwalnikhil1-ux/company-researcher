# Morning digest

Goal: in one message — what came in since yesterday, positive first, and any mailbox whose bounce or spam rate moved. A mailbox going bad should be caught here, not by a reply-rate drop two weeks later.

## 1. Counts (cheap, no mail in context)
`count_replies(since: "<yesterday 00:00 in the team timezone, ISO>")` → total, `by_category`, `by_campaign`, `look_automated`. If `capped` is set, narrow by `campaign_id` rather than paging further.

## 2. The replies, one page
`list_replies(since, limit: 20)`. The result already puts positive categories first. Present:

```
POSITIVE (3)
1. Priya Nair · Razorpay · Fintech CFOs Q3 — "Sure, happy to chat next week…"            → needs a reply
2. …
QUESTIONS / UNCATEGORISED (4)
…
AUTOMATED (5): 3 out-of-office, 1 bounce, 1 unsubscribe                                   → categorise
NOT INTERESTED (2)
```

One line per thread, their words quoted briefly. If there are more than 20, say how many remain and offer the next page (`next_offset`) — do not fetch it unasked.

## 3. Mailboxes that moved
`get_account_deliverability(only_flagged: true)` — default window is the last 7 days compared with the 7 before. Report every `pull` / `reduce` with its evidence ("bounce 1.2% → 4.1% on 310 sends"). If nothing is flagged, one line: "All N mailboxes inside the threshold."
Add `list_email_accounts(problems_only:true)` only when a connection failure is suspected (IMAP down = replies are not being captured, which also makes the digest look quiet).

## 4. Close with actions, apply none
- Replies waiting for an answer, most valuable first → go straight into [reply triage](reply-pipeline.md) step 2–3: `get_reply` each and show the numbered table (who · their exact words · contact they shared · category · draft · next action) in the same message. Don't ask whether to draft; sending still needs a yes per thread.
- Automated / unsubscribe threads → offer to categorise them (`update_lead_category`; Do Not Contact gets `pause_lead:true` and no reply).
- Mailbox actions to confirm → offer the [burn check](burn-check-pipeline.md).

Nothing is applied from a digest without an explicit yes.
