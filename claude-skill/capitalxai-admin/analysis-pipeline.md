# CapitalxAI investor fit analysis pipeline

Replicates the app's **"Analyze with AI"** button: decide whether a company is a fit for an investor and save personalized outreach lines to that account. You (Claude) are the analysis AI — no external AI APIs are involved. The result is stored per-account (`investor_personalization.ai_metadata`); the shared investor record is never modified.

Trigger phrases: "Analyze <domains/names> for my company", "Analyze ... for <email>" (admin), "Find fit investors for ...".

## 1. Resolve the target account

- Default: the connected user's own account.
- **Admin only**: if the user names another account's email ("...for nkjaipur21@gmail.com"), pass `user_email` to both `get_analysis_context` and `save_investor_analysis`. The analysis then reads that user's company data and saves to their account.

## 2. Get the context — once per batch

`get_analysis_context` (with `user_email` if targeting another account). It returns:

- `company_name` and the raw `onboarding` data
- `plan` (needed for the Twitter step)
- `templates` — the **exact** system prompt, user message, and Twitter prompt to use. These may be the account's custom templates; never substitute your own framing.

Build the `COMPANY_CONTEXT` strictly from the onboarding data — no invention, no embellishment:
- Fundraising accounts: product description, what makes them unique, who they're raising from, stage + target round size, business model, customer description, and any traction fields present.
- B2B accounts: company name, product/service, core features, pain points solved, buying triggers, CTA, founder bio.

## 3. Skip already-analyzed investors

Call `list_analyzed_investors` (with `user_email` if targeting another account) and **drop candidates that already have a saved analysis** — that's the default. Re-analyze an already-analyzed investor only when the user explicitly asks ("re-analyze", "refresh the analysis", "run it again for accel.com"); saving overwrites the stored result. When you skip, say so in the report ("already analyzed on June 3 — fit").

## 4. Build the candidate set

Investors are classified as **firm** or **person**, and each record is analyzed separately. Resolve which one the user means:

- **Unambiguous identifiers**: a domain is a firm (`accel.com`), a LinkedIn URL is that specific record (`in/...` = person, `company/...` = firm). `get_investor` for each — no need to ask.
- **Names are ambiguous** ("Analyze Accel", "Analyze Naval"): `find_investors` by name first. If the matches include both a firm and people (or multiple records), **stop and ask which to analyze** — show the matches with their type ("Accel the firm, or one of its partners: ...?"). Never pick silently, and never analyze the whole set on a one-name request without confirmation.
- **"Find fit investors for..."** (open-ended): unless the user said firms/people, **ask whether to analyze firms, people, or both** before running, then pass `type` to `find_investors` accordingly. Derive the other filters from the company context — `stages` from the raise stage, `industries` from the sector (slugs from [extraction-schema.md](extraction-schema.md)), `geographies` from the market — plus `has_deep_research: true` (analysis is impossible without research data). Start with `limit` ~15–25 and confirm scope.

## 5. Check research data

Analysis runs on the investor's `deep_research` text (from `get_investor`). If an investor has none:
- Admin: offer to run the research pipeline ([research-pipeline.md](research-pipeline.md)) first, or skip and report.
- Non-admin context: skip it and report "no research data yet" — never analyze from thin structured fields alone; that's not what the app does.

## 6. Analyze — you are the AI

For each investor, apply the templates from step 2 **exactly**:

1. Take `templates.system_prompt`, replace `<<COMPANY_NAME>>>` with `company_name`. Follow it as your operating rules (no hype, no assumptions beyond provided data, professional and human tone).
2. Take `templates.user_message`, replace `<<<COMPANY_CONTEXT>>>` with your step-2 summary, `<<<COMPANY_NAME>>>` with the company name, `<<<DEEP_RESEARCH>>>` with the investor's `deep_research` text.
3. Produce exactly the JSON the template demands:
   - `investor_fit`: `true` / `false` / `null` (null = genuinely undeterminable)
   - `reason`: precise, short, specific to THIS investor's criteria
   - Two outreach lines following the exact sentence structures: line 1 `"I saw you ... , which is why I'm reaching out to you about <company>."` and line 2 `"I believe ... could greatly benefit us at <company>."` — each insertion under 12 words, no placeholders left in the text
   - `mutual_interests`: up to 2, only precise non-generic ones; empty list if none

Judge honestly: a mismatch on stage, industry, geography, or check size is a `false` with the mismatch named in the reason. Do not soften misfits — the whole feature's value is filtering.

## 7. Twitter icebreaker (optional)

Only when ALL of: `investor_fit === true`, the account's `plan` is not `basic`, the investor has a `twitter_url`, and you have browser/web access. Read their recent posts (last ~7 days; a pinned post may be older) and pick one substantial, non-promotional post (skip hiring/sales posts and anything under ~30 chars). Then apply `templates.twitter_icebreaker`: one friendly line, **under 120 characters, no hashtags, no questions, no slashes or dashes**, starting like "I just read your tweet...". If nothing qualifies, skip — never fabricate a tweet.

## 8. Save — per investor, as you go

`save_investor_analysis` immediately after each investor's analysis (with `user_email` if targeting another account): `investor_fit`, `reason`, `line1`, `line2`, `mutual_interests`, and `twitter_line` when produced. Interleave analyze→save; don't batch all saves at the end.

## 9. Report

A compact table: investor → fit (✓/✗/?) → one-line reason. State which account the results were saved to, and list any investors skipped for missing research data (with the offer to research them). The saved lines appear in the app's investor personalization exactly as if "Analyze with AI" had been clicked.
