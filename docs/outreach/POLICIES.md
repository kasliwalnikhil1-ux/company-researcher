# Billing, refund and AI usage policy (DRAFT)

> **Status: draft for the business owner to approve. Not published. Not legal advice.**
> Written on 20 Sep 2026 from section 11 of `outreach-product-plan.md`.
>
> * **Prices are not set in this repository.** Plan names and prices live in Stripe and on the marketing site. Every amount below is a blank for the owner to fill in.
> * **Billing is built but not switched on.** Nothing in this policy is in force until Stripe is configured and tested ([SETUP.md](SETUP.md) §9.1). Do not publish before that.
> * Items marked **[OWNER DECISION]** need a choice. Items marked **[CHECK]** describe behaviour that must be confirmed in a test before it is promised to customers.
> * Have the final text reviewed for the countries you sell in (consumer law, VAT / GST, invoicing rules).

Why we publish a plain policy at all: billing complaints (refused refunds, surprise renewals, seats that cannot be reduced) fill the one-star reviews of three of the four tools we compare ourselves with. One of them states "Refunds are not provided." A short, fair policy is part of the product.

---

## The policy in five lines

1. Cancel any time, yourself, in the billing portal. No email, no call, no form.
2. Ask for a refund of the unused part of a paid period and you get it, prorated.
3. No silent annual renewals. We tell you before a long plan renews, and you can switch it off at any time.
4. You pay for the senders that are active, and the count goes down on its own when you pause or remove one.
5. Every plan includes LinkedIn and email. AI never blocks a lead: if AI is unavailable, your fallback text is used.

---

## 1. Plans and what you pay for

* Every plan includes **both channels**: LinkedIn and email (Gmail, Outlook, IMAP) in the same sequence and the same inbox. Email is not an add-on.
* You are billed **per active sender**. The number is updated automatically each night. Pausing, disabling or removing a sender lowers your next bill without any action from you. There are no seats to assign by hand.
* Extra mailboxes are billed as an add-on: ____ per mailbox per month. **[OWNER DECISION: keep the mailbox add-on, or include N mailboxes per sender]**
* Prices: ____ per active sender per month on the Team plan, ____ on the Agency plan, ____ on the Agency Plus plan. **[OWNER DECISION: prices and plan names; not defined in this repo]**
* Taxes are added where the law requires it, based on your real billing address.

## 2. Free trial

* 14 days, up to 3 senders, no card needed.
* When the trial ends without a subscription, sending pauses. Your leads, sequences, conversations and settings are kept. Subscribing resumes sending.
* **[CHECK]** The trial limits are enforced by the billing job only once Stripe is configured.

## 3. Renewal

* Monthly plans renew each month until you cancel.
* **No silent annual renewals.** If you choose a 6- or 12-month plan, we email the workspace owners ____ days before it renews **[OWNER DECISION: we suggest 30 days and again at 7 days]**, with the renewal date, the amount, and a link to the billing portal where renewal can be switched off.
* You can turn off renewal on the day you buy. Your plan then runs to the end of the paid period and stops.
* **[OWNER DECISION]** Whether to sell prepaid 6- and 12-month plans at all. If yes, the reminder email has to be set up (Stripe's renewal reminder emails, or our own) before the first one is sold. **[CHECK]** No renewal reminder email exists in this repo today.

## 4. Cancellation

* Cancel any time in **Settings → Billing → Manage billing** (the Stripe customer portal). Workspace owners can do this without contacting us.
* Cancelling stops the next renewal. You keep full access until the end of the period you paid for.
* After that, the workspace becomes read-only: nothing sends, and you can still see and export your leads, messages, actions and audit log.
* We do not delete your data because you cancelled. Ask us if you want it deleted. **[OWNER DECISION: retention period after cancellation, for example 90 days, then deletion]**

## 5. Refunds

* **Prorated refund on request.** Write to ____ **[OWNER DECISION: billing email address]** from an owner's email address. We refund the unused part of the current paid period: monthly plans by the day, longer plans by the unused whole months. **[OWNER DECISION: confirm the proration rule]**
* We do not ask for a reason, and we do not make you argue for it.
* Refunds go back to the original payment method within ____ business days. **[OWNER DECISION: we suggest 5–10, matching Stripe's timing]**
* If we billed you by mistake (a duplicate charge, a charge after cancellation, a wrong sender count), we refund the full amount of the error, whenever you notice it.
* What is not refunded: periods that have already ended, and third-party costs you pay directly (your own AI provider key, your own email-finder provider, LinkedIn Premium or Sales Navigator).
* **[OWNER DECISION]** Whether to add a no-questions full refund window for first-time customers, for example the first 14 days after the first payment.

## 6. Failed payments

* If a payment fails, nothing stops immediately. The billing page shows a warning, you get an email, and you have 7 days to fix the payment method. **[CHECK]** The warning on the billing page exists. The email is Stripe's own failed-payment email, which has to be enabled in the Stripe dashboard; this repo does not send one.
* After 7 days, sending pauses. **Nothing is deleted and no sender is disconnected.**
* When the payment goes through, **senders resume on their own.** You do not have to restart each sender or each sequence by hand.
* **[CHECK]** Automatic resume is implemented (`outreach_resume_after_billing`, and the Stripe webhook's own un-suspend step). It must be tested with a real recovered payment before this sentence is published. The test is in [SETUP.md](SETUP.md) §9.1.

## 7. AI usage

* AI is part of every plan: reply classification, reply and message drafts, the pre-launch sequence check, AI first lines and AI routing.
* **Nothing AI-written is sent without a person approving it.** Approval can be in bulk. It is never skipped.
* **AI never fails a lead.** Every AI variable has a fallback text that you write. If AI is unavailable, slow, over a usage limit, or has nothing truthful to say about a profile, the fallback is used and the lead continues. A sequence does not stop because AI did.
* If a plan includes a monthly AI allowance **[OWNER DECISION: is AI metered at all? If yes: ____ generated lines per sender per month]**, reaching it has exactly one effect: new AI lines are not generated, and fallbacks are used, until the next month. We tell the workspace owners when 80% and 100% are reached. No step fails and no lead is lost. **[CHECK]** No AI usage meter or allowance is enforced in the code today. Until one exists, do not publish numbers here. Publish only the fallback promise.
* **Bring your own key is the unlimited option.** A workspace can connect its own Gemini, Anthropic or OpenAI key in **Settings → AI**. AI then runs on your account with that provider, at that provider's prices, with no allowance from us. The key is stored encrypted and is never shown again after saving. **[CHECK]** Requires the AI settings page and the key storage function to be deployed.
* AI may only use facts that are on the lead's profile or in your own fields. When there is nothing usable, the line is left blank and your fallback is sent.

## 8. Account safety limits

* Daily and weekly sending limits protect your LinkedIn accounts. They cannot be switched off or raised above the platform ceiling on any plan, by anyone. We do not sell higher limits.
* We cannot guarantee that LinkedIn will never restrict an account. No tool can. This service is not affiliated with LinkedIn, and the account holder carries that risk. A LinkedIn restriction is not, by itself, grounds for a refund beyond section 5, which already gives you a prorated refund on request.

## 9. Changes to prices and to this policy

* We give at least ____ days' notice by email before a price increase **[OWNER DECISION: we suggest 30]**. It applies from your next renewal, never in the middle of a paid period.
* Changes to this policy are dated at the top of the page. A change never removes a refund right for a period you have already paid for.

---

## Owner checklist before publishing

| # | Item | Done |
|---|---|---|
| 1 | Fill in every blank and resolve every **[OWNER DECISION]** | ☐ |
| 2 | Stripe configured; trial cap, nightly sender count and the customer portal tested ([SETUP.md](SETUP.md) §9.1) | ☐ |
| 3 | Recovered-payment test passed: senders resumed with no manual step | ☐ |
| 4 | Resend configured, so payment and renewal emails can be delivered ([SETUP.md](SETUP.md) §9.2) | ☐ |
| 5 | If prepaid plans are sold: renewal reminder emails set up and tested | ☐ |
| 6 | If AI is metered: meter built, fallback behaviour at the limit tested. Otherwise remove the allowance bullet in section 7 | ☐ |
| 7 | A named person owns the billing mailbox and answers refund requests within ____ business days | ☐ |
| 8 | Legal review for the countries sold in | ☐ |
| 9 | Remove every **[CHECK]**, **[OWNER DECISION]** and this checklist from the published version | ☐ |
