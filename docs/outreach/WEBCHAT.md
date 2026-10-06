# Web chat — build notes and runbook

Implements `web-chat-PRD.md` (29 Sep 2026). Everything is namespaced `outreach_webchat_*` / `outreach-webchat*`; the widget is the loader + panel under `public/widget/v1/`.

## What ships (PRD phase → state)

| Phase | Scope | State |
|---|---|---|
| P0 | loader + panel, website inboxes, visitors, token + origin checks, live chat into the unified inbox with Realtime, basic settings, install snippet + verify | done |
| P1 | appearance desktop/mobile, launcher types, popup, pre-chat form, business hours, reply time, offline email capture, file/emoji, read receipts, typing both ways, canned responses, assignment + capacity, labels, snooze, priority | done (notes = existing private notes) |
| P2 | email continuity both ways, transcript, CSAT, contact panel with lead linking + outreach timeline | done (continuity sends through a connected mailbox; see below) |
| P3 | AI assistant on the workspace knowledge sources, handoff rules, AI metrics, AI-action accounting | done |
| P4 | SDK complete (identity enforcement, attributes, events, trackEvent), targeting rules, proactive campaigns, webhooks, reports | done; SLA targets not built |
| P5 | live visitors list, Slack, agent reply-by-email, white-label standalone domain, more locales | not built (standalone page is `<app>/chat/<token>`) |

Deviations from the PRD, all deliberate:

- **Data model.** No new `chats`/`messages` tables: a website inbox is a synthetic `outreach_senders` row (provider `WEBCHAT`, no connector account) and every conversation is an `outreach_chats` row on it. RLS, notes, tasks, reports, MCP and the inbox UI work unchanged. Private notes use migration 046's `outreach_chat_notes` rather than an `is_private` flag on messages.
- **Realtime for the widget** is a public broadcast channel per conversation, `webchat:<chat_id>:<stream_key>`, sent from triggers with `realtime.send()`. The 128-bit stream key is a capability handed only to the visitor who owns the chat. Private channels would need visitor JWTs signed with the project JWT secret, which the functions do not have; the widget also long-polls every 5 s when the socket is down.
- **Visitor tokens** are HS256 JWTs signed by the function itself (`OUTREACH_WEBCHAT_TOKEN_KEY`, or a key derived from the service role key when unset). They are never sent to Supabase; every public call goes through `outreach-webchat`.
- **AI answers** use the existing knowledge pipeline (`outreach_knowledge_sources` / `_chunks`, full-text + trigram, crawled by `outreach-ai-reply-worker`) and the platform Gemini key streamed over SSE (a workspace on its own Anthropic/OpenAI key gets a one-shot answer). No pgvector / OpenAI embeddings. Each answer inserts an `outreach_ai_calls` row with purpose `webchat_answer`; `outreach__ai_pool()` now counts those together with reply drafts.
- **Email continuity** goes out through the inbox's reply mailbox (a connected GMAIL/OUTLOOK/IMAP sender) via the connector; the `mail_sent` webhook links the thread and `handleMail` routes visitor replies back into the chat (`webchatMailHook`). Without a reply mailbox, digests use Resend when `RESEND_API_KEY` is set and cannot be replied to. No platform inbound domain (`reply.<domain>`).
- **Agent teams / SLA** are not modelled (no teams table). Slack, agent reply-by-email, mobile push: not built.
- **Country targeting** blocks server-side (block list + `countries_exclude` are applied to messages); the widget does not hide by country because the config response is cached per origin.

## Files

- SQL: `migrations/outreach/048_webchat_enums.sql` (own call), `049_webchat_schema.sql`, `051_webchat_functions.sql`, `052_webchat_cron.sql` (after the worker is deployed), `053_webchat_video_bubble.sql`, `062_webchat_video_questions.sql`, `065_webchat_video_languages.sql`, `068_webchat_buttons_products.sql`; tests `tests/smoke_12_webchat.sql` (30 assertions), `tests/smoke_13_webchat_video.sql` (10), `tests/smoke_18_webchat_buttons_products.sql` (24).
- Functions: `outreach-webchat` (public API, see the route list in its header), `outreach-webchat-worker` (continuity every minute, maintenance every 5 min), shared `_shared/outreach/webchat.ts` and `_shared/outreach/catalogue.ts` (product catalogues, synced by `outreach-ai-reply-worker` mode `knowledge`); hooks in `reply.ts` (`sendReply` routes WEBCHAT to the RPC) and `inbound.ts` (`handleMail` → `webchatMailHook`).
- Widget: `public/widget/v1/loader.js` (12.2 KB gzip), `chat.js` (40.3 KB gzip), `video.js` (9.5 KB gzip, fetched only when the inbox has a launcher clip), `ask.js` (4.4 KB gzip, fetched only when the website places Ask AI buttons or has the selection chip on); sizes are checked by `scripts/outreach-widget-size.mjs`; `presets/` (built-in clips + `presets.json`), `demo.html`. Standalone page `app/chat/[token]/page.tsx`.
- App: `lib/outreach/webchat.ts`, `app/outreach/websites/**` (sidebar item "AI Website Chatbots"; the old `app/outreach/settings/websites/**` routes only redirect), `components/outreach/settings/websites/*`, `components/outreach/inbox/webchat/*` (thread bar, visitor panel, Review suggestion, Product picker), `lib/outreach/catalogue.ts` + `components/outreach/products/ProductCards.tsx` + `components/outreach/ai/hub/knowledge/{AddCatalogueModal,CatalogueView}.tsx` (product catalogues), `components/outreach/WebchatPresence.tsx`, small hooks in Thread / Compose / InboxView / ChatList.
- MCP: `outreach-mcp/tools_webchat.ts`; skill `claude-skill/outreach/web-chat.md`.
- Voice (see "Voice" below): `069_webchat_voice.sql` + `070_webchat_voice_cron.sql`, functions `outreach-voice-tools`, `outreach-elevenlabs-webhook`, `outreach-voice-admin`, shared `_shared/outreach/voice.ts` + `elevenlabs.ts`, widget `voice.js` (built from `widget-src/voice.js`), app `lib/outreach/voice.ts` + `VoiceSection.tsx` + `VoiceCallCard.tsx` + `VoiceKeyCard.tsx`.

## Rollout order (live)

1. `bash scripts/outreach-sql.sh migrations/outreach/048_webchat_enums.sql` (alone), then 049, then 051, then 053, then 062, then 065.
2. `bash scripts/outreach-smoke.sh migrations/outreach/tests/smoke_12_webchat.sql` (rolls back; needs three active app users).
3. Deploy: `bash scripts/outreach-deploy-functions.sh webchat webchat-worker send-reply process-inbound mcp` (`OUTREACH_DEPLOY_EXTRA_ARGS="--use-api"` when Docker is off). `outreach-webchat` must stay `--no-verify-jwt` (the script does that).
4. `bash scripts/outreach-sql.sh migrations/outreach/052_webchat_cron.sql`.
5. Deploy the Next.js app (widget files are static under `/widget/v1/`).
6. Optional secrets (all match `scripts/outreach-set-secrets.sh`'s allowlist, `OUTREACH_` prefix): `OUTREACH_WEBCHAT_TOKEN_KEY` (32+ random bytes; rotating it logs every visitor out — set 2026-09-30), `OUTREACH_TURNSTILE_SECRET` + `OUTREACH_TURNSTILE_SITE_KEY` (one Cloudflare Turnstile widget for the platform, both set 2026-09-30; the widget's hostname list must contain every customer domain that turns the toggle on — the free plan caps it, so a customer with many domains sets their own site key in Security).

## Widget update, 1 Oct 2026 (composer, footer strip, timestamps, video bubble)

Migration `053_webchat_video_bubble.sql` + `tests/smoke_13_webchat_video.sql` (8 assertions). Rollout: apply 053, deploy the Next.js app (the widget files are static). No edge function changed.

- **Composer.** One box: the text on top, attach and emoji inside it at the bottom left, a round send button at the bottom right. Default placeholder is "Ask a question…"; 053 drops stored copies of the old default, and an untouched default follows the visitor's language.
- **Footer.** `.ft` under the composer, in every view: a "Powered by [logo] GrowthxAI" strip and "By chatting with us, you agree to our Privacy Policy". It renders in its own closed shadow root with literal colours (one light set, one dark set), so accent, backgrounds and custom CSS do not reach it. `features.powered_by` still switches the strip off. The privacy line is consent for the first message: it shows only until the visitor sends one (localStorage `gxwc:<token>:sent`) and never for a visitor who already has a conversation; `reset()` brings it back. Link = `messages.privacy_url` (Messages tab), else `https://growthxai.com/legal/privacy/`.
- **Timestamps.** Only the last message shows its time (and the read tick). Unsent and failed messages always show their state. (The hover line from this update was removed in update 2 below.)
- **Header.** The agent initials next to the menu are gone. The brand logo on the left is unchanged.
- **Video bubble** (`settings.launcher.video`, AI Website Chatbots → {website} → Video bubble). A GIF / video replaces the launcher icon: muted, looping, circle / rounded / square, 64–240 px, cover or contain with a focus point and zoom (never stretched), an X at the top right. A click expands it (width 280–720, the clip's own proportions or a fixed ratio) with up to six suggested questions over or below the clip and a "Chat with us" button; videos get replay, progress and mute. A question calls `growthxai.send(text)`, the button calls `growthxai.open()`. X on the expanded view collapses it; X on the bubble hides it for the browser session (`sessionStorage gxwc:<token>:vbx`) and the normal launcher shows. No clip, a clip that fails to load, or `enabled: false` = the normal launcher. Events: `video:opened`, `video:closed`, `video:question`, `video:dismissed`.
  - It lives under `launcher`, which `outreach_webchat_public_config` already returns whole: the public projection did not change.
  - Clips: uploads go to the public bucket `outreach-webchat-media` (`<workspace>/<inbox>/<ts>-<name>`, 20 MB, MP4 / WebM / GIF / WebP; owners and managers write). The settings screen removes an inbox's older uploads except the published one. Any other `https://` link works too. Built-in clips are `preset:<file>`, served from `public/widget/v1/presets/`; fill that folder with `node scripts/outreach-webchat-presets.mjs <folder>` and deploy the app.
  - Validation is `outreach_webchat__settings_check()` (URLs, enums, hex colours, six questions of 120 characters); sizes are clamped by the widget.
  - Customer CSP: `media-src` and `img-src` need the project's storage host (and the app origin for built-in clips); the Installation tab lists them once a clip is set.
- Local test harness (session scratchpad): `stub.js` (token = scenario) + `test.js` (40 checks, Chrome via playwright-core, shadow roots forced open).

## Widget update 2, 1 Oct 2026 ("Fix 1 - chat" doc, fixes 6–12)

No migration. Rollout: deploy `outreach-webchat` (done 1 Oct 2026), then the Next.js app (the widget files are static).

- **Download transcript** (menu, inside a conversation). `GET /conversations/:id/transcript` returns every message in the `/messages` shape (pages of 200 through `outreach_webchat_v_messages`, 6 calls a minute per conversation, off with `features.transcript`). The widget writes a `.txt`: brand and site, then per day `[time] who: text`, attachments as `[file name]`, system lines between dashes, source markers and markdown marks removed. The download link is clicked inside the shadow root, so the host page's link handlers never see it.
- **Menu.** "Email me this conversation", "Download transcript" and "End conversation" show only while a conversation is on screen (not on the home or list views), and the two transcript items only once it has a message.
- **AI answers.** The Copy and "Talk to a person" buttons are gone; thumbs and Sources stay. The assistant decides the handoff: prompt rule 4 in `buildAnswerPrompt` (asks for a person or accepts the offer, quote / demo / meeting, account, billing, refund, complaint, bug, upset, repeats after an answer that did not help). The SQL keyword rules, the low-confidence streak and `max_turns` are unchanged.
- **Who and when.** No name or AI tag above a bubble. One line under the newest message only: `Chat Bot • AI Agent • Just now` for the assistant, `Name • time` for a person (or "Team" when agent names are off), `time ✓` for the visitor. "Just now" turns into the clock time after a minute. A bubble that is still streaming or typing carries the line without a time. Nothing appears on hover. Unsent and failed messages keep their state line.
- **Scrollbar.** 10 px, no track, no arrows, thumb = a 16–20% tint against the chat background (`--sb`). Chromium and Safari use the `::-webkit-scrollbar` rules; the standard `scrollbar-*` properties are set for Firefox only, because setting them makes Chromium ignore the `::-webkit` rules.
- **Video bubble.** The menu has "Watch video" whenever the inbox has a clip and the launcher is allowed on the page: it clears the session's closed flag (`gxwc:<token>:vbx`), closes the panel and opens the bubble expanded (`loader.js` `_loader.video`, `video.js` `open()`). A visitor who closed the bubble on an earlier page gets `video.js` loaded at that moment.
- **No browser dialogs.** `window.prompt` is gone. A question the widget has to ask is a field on top of the message box (`askInline` / `mountAsk` in `chat.js`): label, input, cancel, confirm, error under it; Enter confirms, Escape cancels. Used for the transcript email. `POST /conversations/:id/transcript` now takes `{ email }`, saves it on the visitor when they have none (and links the lead) without posting a message, so a resolved conversation does not reopen.
- Local test harness (session scratchpad): `stub.js` + `test.js`, 29 checks; run Chrome with `ignoreDefaultArgs: ["--hide-scrollbars"]` to see the scrollbar in screenshots.

## Widget update 3, 1 Oct 2026 ("Fix 1 - tab1" doc: logo proportions, question clips)

Migration `062_webchat_video_questions.sql` (applied live 1 Oct 2026; `smoke_13` now 9 assertions, `smoke_12` 30, both green on live). No edge function changed. Rollout left: deploy the Next.js app (widget files + settings screen ship together).

- **Logo proportions.** A logo is fitted whole (`object-fit: contain`) into the round launcher and the 40 px header circle, so it is never cropped or squeezed. The squeeze came from the browser's default button padding: the image box inside the 56 px launcher was 44×54, an oval. `.btn.icon` now has `padding:0`. A text launcher (`type: button`) shows the logo 28 px high, width following the logo, 84 px at most. The settings preview draws the same.
- **Question clips and page links.** An entry of `launcher.video.questions` is a text or `{ text, video_url, video_kind, link_url, link_text }`. A question with neither is stored as a plain text, so settings saved before 062 need no rewrite.
  - With a clip: a click plays it in the expanded frame, over the main clip (`.vba`), with the same replay / progress / sound controls and the sound state the visitor had. The question's button is dimmed (`.sel`, 50%, `aria-pressed`) while its clip plays and turns bright again when the clip ends; the other buttons turn solid. Clicking another question swaps the clip; clicking the dimmed one restarts it. Collapsing the view drops the answer clip, so the bubble always shows the main one. A clip that fails to load falls back to the main clip.
  - With a page link: a link button (`.vbl a`, label `link_text` or "Learn more", localised) shows above the questions while that question is up; it opens in a new tab (`target=_blank`, `rel=noopener noreferrer`) and pauses the clip. A question with a link and no clip opens the page directly.
  - With neither: as before, the chat opens and the question is sent.
  - Every button stays on screen: with the questions over the clip, the frame grows to the height of the controls plus the buttons (`--mh`, kept current by a ResizeObserver), whatever the clip's proportions. With "Same as the clip" proportions the frame follows the answer clip while it is up.
  - A GIF as the main clip gets the video controls only while a video answer plays (`.nov` hides them otherwise).
  - Events: `video:question` now carries `action: "video" | "link" | "chat"`; new `video:link { url, index }`.
  - Validation (062): text 1–120 characters, `video_url` https or `preset:`, `video_kind` video | image, `link_url` https, `link_text` 40 characters, no other fields.
  - Settings: each question row has "Answer video" (upload or paste a link) and "Page link" + link text. `uploadWebchatMedia` now keeps every clip the published settings or the draft point at when it tidies the inbox's folder (it used to keep one). The preview's expanded view plays an answer clip when its question is clicked.
- Sizes: `loader.js` 8.9 KB gzip, `video.js` 7.5 KB gzip.
- Local test harness (session scratchpad): `stub.js` (token = scenario: vq, three, gifq, badq, old, junk, logo-wide / -tall / -square, logo-wide-pill) + `test.js`, 39 checks; `ui.js` opens the settings tab on the dev server with writes blocked.

## Widget update 4, 1 Oct 2026 (video bubble: the clips in several languages, flag strip)

Migration `065_webchat_video_languages.sql` (applied live 1 Oct 2026; `smoke_13` now 10 assertions, `smoke_12` 30, both green on live). No edge function changed. Rollout left: deploy the Next.js app (widget files, the `flags/` folder and the settings screen ship together).

- **Data.** `launcher.video.languages` = `[{ code, label, flag }]` (8 at most, the first is the default), `launcher.video.variants` = the main clip per language `[{ lang, url, kind }]`, `questions[n].video_variants` = the same for an answer clip. `url` / `video_url` stay the default-language clip (the settings screen writes them as the first language's clip), so settings without languages and an older widget work unchanged. The lists are arrays because `outreach_webchat__merge` replaces an array whole and merges objects key by key: a map could never lose a language.
- **Strip.** While the view is expanded and the clip that is up (the main one, or the answer of the question that is up) exists in more than one language, a dark pill of round flags sits beside the frame on the page side (`.vbs`), the playing language large with a white ring, the others small and dimmed. A clip in one language shows no strip. Where there is no room beside the frame (phones) the strip lies above it, left-aligned, clear of the close button.
- **Switching.** A flag sets the language for every clip: the bubble is rebuilt for it (`relang()` in `video.js`; the key of `render()` carries the language, because the main clip can be a video in one language and a GIF in another), stays expanded with no entry animation, keeps the visitor's sound choice and the question that was up. A step that lacks the chosen language plays its default-language clip and the strip marks that one. Event `video:language { code }`.
- **Which language first.** The visitor's pick (`localStorage gxwc:<token>:vlang`), else the browser's language (exact code, then the same base language, so `en-AU` gets Australian English and `en-US` the first English in the list), else the first language.
- **Flags.** `public/widget/v1/flags/<flag>.svg`: 43 round flags from circle-flags 2.8.3 (MIT, licence file in the folder), the ones `VIDEO_LANGUAGES` in `lib/outreach/webchat.ts` uses. A new language needs its flag file there. A missing file leaves the language's two letters. Customer CSP: the flags come from the app origin, already in the `img-src` line the Installation tab shows once a clip is set.
- **Settings** (Video bubble tab): "Languages" (add from the list, rename, reorder, remove) above the clip box. With a language set, the main clip and every question's answer video become one slot per language (upload or paste a link). Adding the first language turns the existing clips into that language's; removing the last one leaves one clip per step. The preview's expanded view shows the strip and switches like the widget. `packVideoBubble()` builds what is saved and what the preview draws.
- **Fix found on the way.** `play()` rejected with `AbortError` when a pause followed it at once (a language switch while an answer is up), and the handler took every rejection for "sound refused": it muted the clip and played it again under the answer. The handlers now retry muted only on `NotAllowedError`.
- Validation (065): language code `xx` / `xx-YY`, label 40 characters, flag `xx` or `xx-yyy`, no code twice; a clip list is 8 entries of `{ lang, url, kind }` with the same URL rules as the main clip (`outreach_webchat__variants_check`, service-only).
- Sizes: `loader.js` 9.0 KB gzip, `video.js` 9.7 KB gzip.
- Local test harness (session scratchpad): `stub.js` scenarios lang3, lang1, langmix, langflag + `test_lang.js` (23 checks; browser language through the Playwright context's `locale`); `ui_lang.js` walks the Languages settings on the dev server with writes blocked and prints the Save payload. The stub has to serve `.svg` as `image/svg+xml` or every flag falls back to letters.

## Widget update 6, 3 Oct 2026 ("Fix 1 - chatbot changes" doc)

Migration `072_webchat_question_langs_voice_turns.sql` + `tests/smoke_19_webchat_fix1.sql` (4 assertions). **Live 3 Oct 2026:** 072 applied (dry run first: 072 + smoke in one rolled-back batch), smoke 19 / 13 / 12 green on live, `outreach-webchat`, `-webchat-worker`, `-voice-admin`, `-voice-tools` deployed (with `OUTREACH_DEPLOY_EXTRA_ARGS=--use-api`: Docker was off). Rollout left: deploy the Next.js app (widget files and screens ship together).

- **Video bubble control bar** (`video.js`, rewritten): the flag strip beside the clip is gone. A bar runs along the bottom of the expanded clip, like a video player: progress line, then play / pause, replay, sound and the time on the left, and on the right the language menu (the flag of the language playing; opens a list above it; only with 2+ languages), **Voice chat** (when `/config` has voice on and the page's Permissions-Policy allows the microphone: `L.voice()` in the loader, same rule as the panel) and a smaller **Chat with us** (the website's button text and colours). A narrow clip drops the time (≤ 480 px), then replay (≤ 390 px), then the pill labels (≤ 330 px), through container queries on the frame. Events `video:chat`, `video:voice` added.
- **Phone layout + short labels (3 Oct 2026, no migration):** on a phone (≤ 640 px, decided at build and rebuilt when the width crosses it) the expanded player spans the screen (10 px from each edge, whatever `expanded_width` says) and is otherwise laid out as on a large screen: questions over (or below) the clip as set, **Voice** and **Text** in the control bar. (A first cut put the questions and two big buttons under the clip in a white card; reverted 4 Oct on feedback: they belong inside the player.) Suggested questions are small chips (End-button size, smaller on phones) in a two-column grid everywhere (2 = one row, 4 = 2 × 2; one question takes the row). Voice keeps the player's translucent look (like play / sound); Text uses the chat button's colours. The language menu opens centred above the flag, kept inside the clip. Default words: video bubble **Voice** / **Text**, panel home **Chat** (was "Start a new chat") / **Voice** (was "Talk to us"), translated in every widget language. A stored `cta_text` of "Chat with us" or `voice.ui.start_text` of "Talk to us" counts as the default (the old seeds wrote them), so existing websites switch too. The panel menu no longer offers "Open in a new window" (only with `growthxaiSettings.showPopoutButton = true`; `growthxai.popoutChatWindow()` still works). Settings → Website agents → Design → Video bubble preview has a desktop / phone switch; phone draws the full-width player.
- **Answer clips:** while a question's clip plays, the other questions fade to 12 % opacity so the clip can be seen. Pointing at the questions (after the pointer has left once: the click leaves it there), keyboard focus, a pause or the end of the clip brings them back. The question that is playing stays at 55 %.
- **Question wording per language:** `questions[n].text_variants = [{ lang, text }]` (8, 120 characters each; `outreach_webchat__text_variants_check`). `text` mirrors the default language's wording; a language with no wording shows the default one. `packVideoQuestions()` keeps the list only when a non-default language has its own wording. Settings: with 2+ languages each question row has one input per language; changing the languages pins each wording to its language first.
- **A question plays a video or opens a page, not both:** a "When clicked" switch per question (Play a video · Open a page · Send to chat); switching drops what the other choice held. Questions saved with both show an amber note, and Save refuses them. The widget still handles both for old data.
- **Settings:** "MP4, WebM, GIF or WebP, up to 20 MB" under every clip upload button; "(or at once on the next page load)" removed from the save bar; the Appearance preview's desktop panel is centred so a narrow column never crops it; the Video bubble preview draws the new bar, menu and fade.
- **Home and Messages** (`chat.js`): the large cards are gone. Earlier conversations are chat rows (avatar, name = assignee or brand, latest message with "You:" for the visitor's own, time, unread count); home shows the 3 latest with "See all (n)", the list shows all. "Start a new chat" and "Talk to us" are two small buttons under the rows.
- **Pre-chat form once per visitor:** after the form is sent (stored as `gxwc:<token>:pc` with name / email / phone) or once the visitor has any conversation, only a *required* field that is still missing brings the form back. A visitor whose token was lost comes back as a new one: `createConversation` sends the saved details as the form, so they are not asked again. `growthxai.reset()` clears it.
- **Stuck screen fixed:** `renderMessages()` only draws while the view is `messages`. A late message fetch (or a live message) after the visitor went back to home used to paint the thread under a header with no back arrow and an empty composer.
- **No zoom on phones:** while the full-screen panel is open, `lockZoom()` in `chat.js` sets the page's viewport tag to `maximum-scale=1, user-scalable=no` and puts the page's own tag back on close / destroy; fields are 16 px on phones (iOS zooms into smaller ones) and the panel has `touch-action: manipulation`. The hosted `/chat/<token>` page gets the same viewport from `app/chat/[token]/layout.tsx`.
- **Voice transcript follows the conversation:** the call view shows the last 8 caption lines and keeps the newest in view while it is spoken, unless the visitor scrolled up (`follow()` in `widget-src/voice.js`; voice.js rebuilt).
- **Voice no longer hands off on the turn count:** every spoken reply counted as an assistant turn (the greeting and "are you still there?" too) and the count covered the whole conversation, so a second call was handed to the team after its first question (`handoff_reason: max_turns`, seen live on 3 Oct). 072 removes the max-turns rule from `outreach_webchat_v_voice_turns` (handoff words and the agent's `switch_to_chat` still hand off; the call's minute limit ends it) and typed messages now count typed turns only (`voice_call_id is null`).
- **Answers sound sure:** the text prompt (rule 5, not in review mode) and the voice prompt now say to answer directly from the knowledge, never announce a search or say "one moment", and avoid "it looks like" / "it seems". Voice agents pick it up on the worker's next hash sweep.
- Sizes: `chat.js` 47.4 KB gzip (budget raised to 49,000 B), `video.js` 11.0 KB (budget 11,600 B).
- Local test harness (session scratchpad 1c5ba437…): `stub.js` (scenarios basic, convs, novideo, narrow; `/__reset`, `/__newvisitor`) + `site.html` + `test.js` (42 Chrome checks via playwright-core from scratchpad 59f2f8cb…).

## Widget update 5, 1 Oct 2026 (your own buttons, Ask AI buttons, product recommendations)

Implements `web-chat-buttons-products-changes.md` (that file calls itself "Widget update 3"; update 3 was the question clips and 4 the video language strip, so this is 5). Migration `068_webchat_buttons_products.sql` + `tests/smoke_18_webchat_buttons_products.sql` (24 assertions). Built and tested on the local stack; **not applied to live, no function deployed**.

Rollout: apply 068 → deploy `outreach-webchat`, `outreach-webchat-worker`, `outreach-ai-reply-worker`, `outreach-mcp` (`bash scripts/outreach-deploy-functions.sh webchat webchat-worker ai-reply-worker mcp`) → deploy the Next.js app (widget files and screens together). No backfill: existing websites keep "Our launcher" and have Recommend products off. Deploying the functions before 068 breaks nothing (no website has a catalogue, `products` stays empty), but the two new connector tools fail until 068 is in. The app needs 068: the Knowledge and Assistant screens call the new RPCs.

### Your own buttons (no JavaScript)

- **How visitors open the chat** (Launcher & popup tab) replaces the "Hide the launcher" switch: *Our launcher* or *My own buttons*. Stored as `launcher.hide` (the existing key) + `launcher.campaigns_open` (new, default false). With *My own buttons* the loader shows no launcher, video bubble, popup or unread previews, and `chat.js` skips campaigns unless `campaigns_open` is on (then a campaign opens the panel, whatever its display setting: there is no launcher for a preview to sit on).
- **Attributes** (one delegated `click` + `submit` + `keydown` listener on `document`, in `loader.js`, so elements added later work): `data-growthxai="open|close|toggle"`, `data-growthxai-ask`, `-prefill`, `-mode`, `-context`, `-label`, `data-growthxai-unread` (text = unread count, `data-count`, `hidden` at 0), `<form data-growthxai="ask-form">`, `<input data-growthxai="ask-input">`. A page handler that called `preventDefault()` wins; we call it ourselves only on links and submit buttons we handle; a link or control of the page *inside* a `data-growthxai` element keeps its own job. While the chat is open `<html>` has the class `growthxai-open`, and `open` / `toggle` elements get `aria-expanded` + `aria-haspopup="dialog"`.
- **Links**: `?gx=open`, `?gx_q=…` (300 characters, put in the message box, never sent), `#ask-ai` (a click on `<a href="#ask-ai">`, or an address ending in it). The parameters are removed with `history.replaceState`.
- **Queue and refusal.** A click before `/config` answered is queued (and `chat.js` starts loading). A 403 / 404 / "inactive" answer sets `denied`: what the cache painted is hidden, the queue is dropped, and one `console.warn` says why; later clicks do nothing. When `/config` does not answer in 2 s, nothing is cached and a click is waiting, the loader asks once more with a 10 s limit.
- **SDK**: `growthxai.ask(text, { context, mode, prefill, label })`, `open({ mode })`, event `trigger { kind, text? }` (before the chat opens; kinds `button | ask | input | link | header_button | element_button | selection | shortcut`). `send(text, { prefill })` is now `ask` underneath. `unread` fires whenever the count changes (it used to fire only with a preview card).
- **A question that is not sent yet has no conversation.** `prefill` (an attribute, a `?gx_q=` link, the selection chip) opens the visitor's open conversation, or a message box without one (`draftView()`); the conversation is created with the first message, so an unsent question leaves nothing in the inbox. Labels set before a conversation exists (`setLabel`, `data-growthxai-label`) are applied when it is created (they used to be lost).
- **Sources.** `outreach_chats.source` gains `button`, `ask`, `input`, `link`, `header_button`, `element_button`, `selection` (the function's whitelist; the shortcut counts as `launcher`).
- **Context.** `-context`, a selection or `product:<ref>` travels with the visitor's message (`POST …/messages` body `context` ≤ 700, `product` ≤ 300 = the page's JSON-LD product) and is stored in `content_attributes.internal` (never returned to the widget; 068 makes `outreach_webchat_v_message` merge the spam flags into `internal` instead of replacing it). `outreach_webchat_v_ai_context` hands it to the assistant, so it works in Auto and in Review. **The function now keeps only form answers (`form`, `values`, `message_id`) from a visitor's `content_attributes`**: `products`, `items`, `ai` or `internal` sent by a browser are dropped.

### Ask AI buttons the widget places (Ask AI buttons tab)

- `settings.ask_buttons[]` (10 at most: `id, kind header|element, selector, position, label, style filled|outline|text|match, icon, click open|ask|prefill, text, context none|page|product, mode, url_rules, enabled`), `settings.selection_ask { enabled, area, label }`, `settings.shortcut { enabled: true | false | null }` (null = on for the modal shell only). Validated by `outreach_webchat__buttons_check()` (called first thing by `outreach_webchat__settings_check`); the public config returns the enabled buttons.
- **Code split (deviation).** The PRD puts all of this in `loader.js`. Placed buttons and the selection chip are `public/widget/v1/ask.js` (4.4 KB gzip), fetched only when the settings have a button or the chip on, the way `video.js` is; the attributes, links, unread badge and shortcut stay in the loader. The loader is 12.2 KB gzip (it was 9.0; the PRD expected about 11).
- Filled / Outline / Text buttons are a `<span data-growthxai-btn>` with a closed shadow root; the host is reset with `all: initial !important`, so page CSS cannot reach it (the font family is inherited on purpose). *Match my site* is a plain `<button class="growthxai-ask">`. A header button uses the first selector of its list that matches anything ("header nav, header" → the nav, not the header around it). A target carries `data-growthxai-placed="<ids>"`; a `MutationObserver` (one run per 500 ms) re-places a button whose target was re-rendered and never doubles one; a route change re-checks the page rules; more than 20 matches → 20 + one `console.warn`.
- **This product** context: `data-product-url` / `data-product-handle` on an ancestor, else (when the selector matched several elements, i.e. a list) the link inside the element, else the page address.
- **Selection chip**: 3 or more words inside the area, positioned from the range's rectangle (the position is in the chip's `:host` rule, because the button sheet resets the host), hidden on scroll, Escape, a collapsed selection, and inside inputs. A click prefills `Explain this: "…"` (200 characters) with the selection (600) as context.
- **Shortcut**: bound in the loader for every shell; `chat.js` binds it only for a loader from before this update (`_loader.keys`). The page's own ⌘K wins (`defaultPrevented`).
- **Test on my site**: `?gx_debug=1` (kept in `sessionStorage`) outlines matched targets and logs what each selector matched.

### Product catalogue

- A catalogue is a knowledge source of kind `catalogue` (`catalogue` jsonb: `provider shopify|woocommerce|feed|csv|crawl, url, store, currency, currency_locked, products, synced_at, complete, warning`, and `sync` while one runs). A website source can also collect products (`detect_products`). Rows live in `outreach_products` (RLS on, no policies; the app reads through `outreach_hub_*`).
- **Sync** runs in `outreach-ai-reply-worker` mode `knowledge` (`_shared/outreach/catalogue.ts`, no database in that file: the worker passes the upsert / progress calls). Shopify `products.json` (250 a page, one request a second, currency from `/meta.json` or `/cart.js`, product links on the store's main domain when a `*.myshopify.com` address redirects), WooCommerce Store API, Google Merchant XML or CSV / TSV feed (rows of one `item_group_id` fold into one product with variants), uploaded CSV, JSON-LD / Open Graph products on crawled pages. Batches of 200 through `outreach_catalogue_upsert`; a sync that does not fit one run keeps its cursor and is claimed again 45 s later (`outreach_knowledge_claim`); a busy store is retried on five ticks; `outreach_catalogue_finish` marks unseen products deleted after a **complete** read. An empty complete read keeps the products and reports an error. 10,000 products a catalogue: the rest is rejected with a warning on the source.
- The spec's `search` column cannot be generated as written (`array_to_string` is not immutable): it is generated through `outreach_product__tsv()`, which also indexes option values. The spec's `(workspace_id, lower(url))` index is on `outreach_product__url_key(url)` (no scheme, `www.`, query, trailing slash; `/collections/<c>/products/<h>` read as `/products/<h>`).
- Addresses come from users: `catalogue.ts` refuses localhost and private ranges (`OUTREACH_CATALOGUE_ALLOW_PRIVATE=1` for local tests only).
- **Database route (migration 080, 2026-10-06).** Shopify answers 429 to the edge runtime's shared outbound addresses (polkistories.com failed every run) while the database server gets 200 in ~0.5 s. When a store page answers 429 / 403 on the edge (or the edge cannot reach it), `catalogue.ts` asks for it through `outreach_catalogue_fetch` (the `http` extension, synchronous, 7 s cap) and sets `cursor.via = "db"` for the rest of the sync; 429s on that route get the same backoff. Shopify / WooCommerce product-list endpoints only (`/products.json`, `/meta.json`, `/cart.js`, `…/wp-json/wc/store/v1/products`), named public hosts only; never feed links, because both `http` and pg_net follow redirects and neither can be told not to. pg_net was tried first and dropped: answers took 30–47 s and `net._http_response` (no index on id, 666 MB heap) needs a seq scan past PostgREST's 8 s timeout. A retry now keeps the latest saved cursor (it used to rewind to page 1) and stores `note`; `outreach__ks_json` exposes `catalogue.retry {tries, note}` and the catalogue header says "trying again (n of 5)".
- App: AI → Knowledge → **+ Product catalogue**, the catalogue's page `/outreach/ai/knowledge/catalogue/<id>` (search, Hide from AI, Pin for…, Sync now, currency override, a new CSV), "Also find products" on a website row, "Use in…" lists websites only.

### Recommendations

- `POST /chat`: knowledge retrieval and `recommendProducts()` run together; the one model call gets a `PRODUCTS` block (`P1 | name | price | stock | type · tags | description`, 12 rows at most) and a `CURRENT PRODUCT` block, and returns `"products": ["P3","P1"]` + `"shopping": boolean`. `pickCards()` maps the picks to catalogue rows (unknown ids dropped, the website's `max`, none on a refusal); `stripCardLinks()` takes links to a recommended product out of the answer. SSE gains `products { items }` between the tokens and `done`.
- Budget in code, no AI: `extractPriceFilter()` ("under 1 lakh", "between 20k and 40k", "around 5000", "₹", "k", "lakh / lac", "cr"; numbers followed by days, kg, inches… are not money). "cheaper" / "pricier" against the current product become `lt_price` / `gt_price`; "what goes with this" becomes `complement` (another type that shares tags or the brand). A short follow-up ("a red one?") is read with the last product search of the conversation (`last_product_search`, 30 minutes) and keeps its budget.
- `outreach_product_search`: prefix full-text over title / type / vendor / tags / options / description + trigram on the title + pin boost + same type / shared tags of the current product; hidden, deleted and (unless included) out-of-stock products never; falls back to the current product's type; a budget alone lists what fits.
- The current product: the button's `product:<handle | sku | url | id>`, else the page address, else the page's JSON-LD product (`pageContext()` in `chat.js`; a page that describes several products names none).
- Saved: card snapshots on the answer (`content_attributes.products`), ids + context + current product + the search on the turn (`products`, `context`, `product_id`, `product_search`: the spec lists the first two columns, the other two feed "on a product page" and "asked for, not found"), snapshots on a Review suggestion (`outreach_webchat_ai_suggestions.products`).
- Settings `settings.ai.products { enabled, catalogue_ids, max, show_prices, include_oos, add_to_cart, utm }`; the widget gets `{ enabled, show_prices, add_to_cart, utm }` only. "Recommend products" needs a picked catalogue that has products (`outreach_webchat__products_fix` refuses the switch otherwise and drops ids that are not catalogues of the workspace). **Add to cart** is offered only when a picked catalogue is a Shopify store that is one of the website's allowed domains, and the widget shows the button only for a card of the site it runs on.
- Widget cards (`chat.js`): square lazy picture with `referrerpolicy=no-referrer` (a broken one becomes a letter on a gradient), two-line name, `Intl.NumberFormat` price with the old price struck through, View (tracked link; same tab on this site), Ask (`Tell me more about {title}` with `product:<id>`), Add to cart (`POST /cart/add.js`; "Added ✓ · View cart", or the product page when the shop refuses). Events `product:shown { ids }`, `product:clicked { id, action }`, `product:added_to_cart { id, variant_id }` (SDK, window events, `outreach_webchat_events`); cards read from history do not count as shown.
- Agents: the inbox thread draws the cards; the composer's **Product** button (`ProductPicker`) and the connector's `webchat_send_products` go through `outreach_hub_webchat_send_products` (a `cards` message built on the server from the catalogue, with the plain `items` shape for an older widget); a Review suggestion's cards can be removed before sending (composer and AI → Needs you). Connector: `catalogue_search`, `webchat_send_products` (confirmation).
- Report: `outreach_webchat_report` gains `products` (answers with products, cards shown, clicks, add-to-carts, top recommended / clicked, asked for not found) and the new sources appear in `by_source`.
- Customer CSP: `img-src` needs the catalogue's image hosts (the Installation tab lists them); Add to cart is a same-origin call from the page.
- Not built: product cards in the continuity and transcript emails (they carry the answer's text; a cards-only message from an agent is left out, as every `cards` message was before), product editing in the app (the store is the source of truth), embeddings.

### Tests

- SQL: `smoke_18` 24 assertions; `smoke_12` 30, `smoke_13` 10 and `smoke_15` 28 still green on the local stack with 068 applied (twice).
- Deno: `catalogue_test.ts` (11) and `webchat_test.ts` (7): `deno test --no-config --allow-env --allow-net --allow-read supabase/functions/_shared/outreach/catalogue_test.ts supabase/functions/_shared/outreach/webchat_test.ts`.
- Widget in Chrome against a stub API (session scratchpad `stub.js` + `site.html` + `test.js`): 99 checks (own buttons, links, placed buttons, selection, shortcut, cards, add to cart, history, mobile).
- End to end on the local stack with the real model (`store.js` = a pretend Shopify store, `e2e.js` 20 checks, `e2e_browser.js` 7, `ui.js` 22 on the app screens).
- `node scripts/outreach-widget-size.mjs` (part of `npm run lint`) checks every widget file's gzip size against its budget.

## Voice (the website assistant on a call), 2 Oct 2026

Implements `web-chat-voice-elevenlabs-PRD.md`. Visitors can talk to the same assistant they type to, in our own widget. Calls run on ElevenLabs Agents: one agent per website and kind (`live` = published settings, `test` = the Voice tab's draft), created and updated by our backend. Customers never open ElevenLabs, and no customer-facing text names it.

**State:** built and tested locally (see Tests). **Nothing is applied to live, deployed or committed.** No real ElevenLabs key was used: every provider call was checked against a pretend provider that speaks the shapes in their docs, so the first real call is still a check (see Verify with a real key).

### Rollout

1. Apply `migrations/outreach/069_webchat_voice.sql`. It needs 068, which is not live yet either: `068` → `069`. The app's Voice tab and the widget's voice need 069. Nothing breaks without it, because voice stays off: `/config` has no `voice` block, so the widget shows no mic.
2. Secrets (`OUTREACH_` prefix, so `scripts/outreach-set-secrets.sh` pushes them):
   - `OUTREACH_ELEVENLABS_API_KEY`: the platform account. It needs Agents write, Voices read and workspace webhooks.
   - `OUTREACH_ELEVENLABS_WEBHOOK_SECRET`: printed by step 4.
   - Optional: `OUTREACH_ELEVENLABS_API_BASE`, for a residency host.
3. Deploy the functions: `bash scripts/outreach-deploy-functions.sh voice-tools elevenlabs-webhook voice-admin webchat webchat-worker workspace-secrets mcp`. All of them are `--no-verify-jwt` (the script does that); the three new ones are in its catalogue.
4. `node scripts/outreach-elevenlabs-setup.mjs`. It creates our post-call webhook in the platform account and binds it, then prints the signing secret once (step 2). After that, switch "retry failed webhooks" on in their dashboard; the API does not expose it.
5. `bash scripts/outreach-sql.sh migrations/outreach/070_webchat_voice_cron.sql`: the worker's `voice` mode, every minute.
6. Deploy the app. The widget files (`chat.js`, `loader.js`, `voice.js`) and the screens ship together.
7. Turn it on for one website: Voice tab → Voice on → Test voice → Save & publish.

### How it fits together

- **Widget.**
  - `loader.js` adds `growthxai.call()`, `data-growthxai="call"` (with `voice.js` prefetched on hover) and "Voice first" (the launcher says the start text and opens straight into a call).
  - `chat.js` adds the home card, the composer mic (the send button is the mic while the box is empty), the consent sheet (once per visitor: `gxwc:<token>:voice_ok`, plus `voice_consent_at` on the visitor), "Continue by voice", the call's line in the thread, and every failure path back to the text chat.
  - `voice.js` is lazy, built from `widget-src/voice.js` by `scripts/outreach-widget-build.mjs` with `@elevenlabs/client` 1.26.0 pinned. It holds the call view: orb, status, captions (the last eight lines, streamed agent text, the newest kept in view), mute, type-into-the-call, switch to chat, end with a confirm, and the 60 s hidden-tab end. It also mirrors the live transcript and handles every handover.
  - The microphone is asked for inside the click (iOS).
- **Public API** (`outreach-webchat`):
  - `POST /conversations/:id/voice/start`: every check in SQL (`outreach_webchat_v_voice_start`), then a conversation token from the provider. The call row stores the provider's conversation id before the call begins.
  - `…/voice/turns`: the live transcript, deduped on `(call, event id)`. It returns `handoff` from the same keyword and max-turn rules as typed messages (`outreach_webchat__handoff_match`, now shared by both), and `takeover` when a teammate replied.
  - `…/voice/switch` (with or without the existing handoff) and `…/voice/end`.
- **Knowledge stays ours.** The agent's tools are webhooks into `outreach-voice-tools`:
  - `/knowledge`: our knowledge search plus the matching Q&A. Up to 5 passages and 1,500 characters; passages that share no word with the question are dropped, because the trigram search always returns its nearest text.
  - `/products`: the same search as text chat. It posts the `cards` message into the conversation.
  - `/contact`: a name or phone, never over a value the visitor typed.
  - `/email-form`: the existing email form, once.
  - Tool calls are trusted through the agent's own provider secret (we keep its sha256) plus a session token we sign at start. The token travels as the `secret__session` variable, which the provider hides from the model. Each call must still be live; at most 30 tool calls per call.
  - Only the Q&A (30 pairs, 8,000 characters) is written into the prompt.
- **After the call.** `outreach-elevenlabs-webhook` checks `ElevenLabs-Signature` (`t=…,v0=…`, HMAC-SHA256 of `t.body`, 30 min tolerance) against the platform secret, or against the secret of the webhook we created in a workspace's own account. `outreach_webchat_v_voice_finalize` then works in one transaction:
  - The confirmed transcript replaces the live rows. The unread count is unchanged.
  - The call row gets its duration, cost, summary, title, outcome, collected details and recording flag.
  - The collected details go onto the visitor and the lead, never over typed values.
  - It sends `webchat.voice_call.ended`, and the 80 % / 100 % minute notices by email (`notifyWorkspace` kind `voice_minutes`).
  - A webhook that never arrives: the worker fetches the conversation 10 minutes after the call ended, with growing gaps, 12 tries.
- **Agent sync** (`syncVoiceAgent` in `_shared/outreach/voice.ts`). We own every field and send each managed object whole. A sha256 of the body means an unchanged website costs no provider call.
  - A save in the app syncs at once. The worker sweeps every 5th minute (this is how Q&A, plan and assistant changes reach the agent). Three failures for one configuration wait for a change or Retry, with backoff.
  - Voice off archives the agent. A deleted website, an erased visitor or chat, and an account switch go through `outreach_webchat_voice_cleanup`, and the worker deletes them at the provider.
- **Minutes** (`outreach__voice_pool`): whole minutes per call, rounded up, test calls included, calls on a workspace's own account excluded.
  - Plan features `voice_minutes` / `voice_max_minutes` / `voice_concurrency` / `voice_own_key` live in `pricing/v1.json` (so 058 is regenerated) and are repeated in 069. While `billing_enforced` is off, the flag `voice_default_limits` applies: 100 minutes, 10-minute calls, 5 at once.
  - Voice packs: `select outreach_voice_grant(ws, minutes, note)` (service). There is no purchase flow yet.
  - The platform-wide guard is `outreach_flags.voice_platform_concurrency` (30). Model ids come from `voice_llm_models` (`fast` / `smart`), the default voice per language from `voice_default_voice`, and Recommended voices from `voice_recommended`.
- **App.**
  - Website → **Voice** tab (`VoiceSection.tsx`): every setting from the PRD §3, the voice picker (Recommended / Library / My voices, with previews; moderated voices hidden; a library voice is added to the account when picked), the draft and test agent, Save & publish (the live agent syncs at once), the sync state and Retry, and minutes.
  - **Test voice** panel: a call with the test agent using the same `voice.js`, with a tool log showing timings. **Run checks** runs 4 or 5 provider simulations built from the website's Q&A, products and languages, then deletes them.
  - Inbox: the call card (`VoiceCallCard.tsx`, recording played through `outreach-voice-admin /voice-calls/:id/audio` and never stored), "Spoken · live transcript" under the turns, and a 🎙 in the conversation list.
  - Reports → Voice block. AI → Setup → **Voice account** (own key).
  - Installation: `data-growthxai="call"`, `growthxai.call()`, the voice events, and the CSP lines once voice is on.
- **Connector.** `webchat_voice_calls_list` (read). Voice settings can be read in `webchat_inbox_get`; `webchat_settings_update` refuses `settings.voice` and points to the app. The `web-chat.md` skill has a Voice section, and `skills.gen.ts` is regenerated (zips not rebuilt).

### Deviations from the PRD

- **Two agents per website from the first use of the Voice tab, not from "enable".** The test agent is created when the Voice tab first saves a draft; the live one when voice is on and the assistant is on Auto.
- **The minute cap per session (§10) is enforced on our side.** Tools and the live mirror stop at the remaining minutes. The provider's own limit is the agent's call length, because overriding the duration per session needs the duration override on, which the PRD forbids. A call that starts with less time left may run slightly over, as the PRD accepts.
- **Library voices are always added to the account when picked** (§17: this is unconfirmed, so it is the safe choice).
- **Own key, webhook.** We create our webhook in their account and bind it per agent (`workspace_overrides.webhooks`), never as their account default. If the key may not create webhooks, the worker fetches calls instead (§12).
- **Removing or replacing an own key** deletes our agents, tools and secrets from that account first, while the key still works.
- **A conversation can start with a call** (source `voice`). The pre-chat form, when on, comes first.
- **Typed text during a call goes into the call**, including a product card's "Ask".
- **Voice packs** are granted by SQL only; there is no in-app purchase yet.
- **EU / India residency, phone numbers, and a person joining by voice** are not built (as the PRD says).

### Verify with a real key

**Checked with the real platform key on 2 Oct 2026** (a throwaway agent, tools and secret, all deleted afterwards):

- The voices list (`/v2/voices`) and the library (`/v1/shared-voices`, with `public_owner_id`) answer in the shape we read.
- The secret and all five tools are accepted, and a tool can be updated.
- The agent body we build is accepted (English on the fast model, and English + Hindi on the smart model): the model, tools, voice, `call_limits` without bursting, privacy, the dynamic variables and the language override all stick. The same body patches cleanly, which is the sync path, and archiving works.
- A conversation token comes back with its `conversation_id`.
- The webhook is created and bound as the post-call webhook (`scripts/outreach-elevenlabs-setup.mjs`).

Two fixes came out of this:

- **The speech model follows each language.** The provider refuses an English agent on the multilingual model ("English Agents must use turbo or flash v2"). The main language now picks its own model (`eleven_flash_v2` for English, `eleven_flash_v2_5` otherwise), and every language preset sets its own.
- **A deleted agent's tools need a forced delete.** After the agent is deleted, its branch keeps naming the tools ("Unknown / Main"), so a plain delete answers 409 for good, and the secret cannot go while a tool names it. `el.tools.remove` now reads `/dependent-agents` and forces the delete only when no live agent uses the tool and every branch belongs to an agent that is gone. The pretend provider now behaves the same way.

Still to check, on the first real call:

1. One real call from a phone and a desktop. Confirm:
   - token → WebRTC, and the `secret__session` header reaches `outreach-voice-tools`;
   - captions stream (`agent_chat_response_part`);
   - the `switch_to_chat` client tool fires;
   - `end_call` works;
   - the webhook arrives with `cost_fiat` and `data_collection_results` as normalised in `normalizeConversation`.
3. Read the LiveKit hosts from a real session and correct the CSP lines (`CSP_NOTES`) if they differ.
4. Run checks: confirm the run response field (`id`) and the invocation shape (`test_runs[].status`, `condition_result`, `agent_responses`) that `outreach-voice-admin` reads.
5. Library voice add: `POST /v1/voices/add/{public_user_id}/{voice_id}`, and whether the returned id is the one to use.

### Tests

- **SQL:** 069 applied twice to the local stack (it is idempotent). `smoke_12`, `smoke_13`, `smoke_15` and `smoke_18` still pass with 069.
- **Deno:** `voice_test.ts`, 10 tests: prompt, agent body, tools, session token, webhook signature, normalised conversation, greetings.
- **End to end:** `scripts/outreach-voice-e2e.ts` runs the real functions against the local stack and `scripts/outreach-fake-elevenlabs.ts`, with 74 checks. They cover sync, draft vs live, failure and Retry, every start refusal, the tools and their auth, live transcript, keyword handoff, takeover, the webhook (signature, replace, duplicate, unknown), missed-webhook polling, minutes, the test panel, the recording proxy, voices, own key (switch, cleanup, its own webhook secret, removal), run checks, voice off, erasure, and website deletion.
- **Widget:** 55 Chrome checks with a stand-in SDK (build with `node scripts/outreach-widget-build.mjs --sdk=<fake> --out=<file>`). They cover entry points, consent, session options, captions, typing, mute, cards in the call view, switch, end, every handover, mic denied, refusals, retry after a dropped connection, the hidden tab, own buttons, Voice first, pre-chat, custom wording, Hindi, and phone layout.
- **App:** 10 checks on the screens against the local stack: Voice tab, picker, draft → test agent, Run checks, publish → live agent, Review note, report block, own-key card.
- **Sizes:** `scripts/outreach-widget-size.mjs` gives `voice.js` its own budget (168 KB gzip: the SDK with WebRTC, fetched only when a call starts). `loader.js` is 12.9 KB and `chat.js` 45.7 KB gzip, both budgets raised.

## Load cost on customer sites (3 Oct 2026)

The widget runs on every page view of every customer site, so it must cost almost nothing when nobody chats.

- **Caching** (`next.config.mjs` `headers()`): `loader.js` and anything under `/widget/v1/` asked for without a version: `max-age=300, stale-while-revalidate=86400` (it was `max-age=0, must-revalidate`, so every page view re-checked every file). `chat.js`, `video.js`, `ask.js`, `voice.js` with `?v=`: one year, `immutable`. Built-in clips, bot avatars and flags: 7 days + 30 days stale-while-revalidate (fixed names: a replaced preset reaches visitors within a week). Uploads in `outreach-webchat-media` already had a one-year cache and unique names.
- **Version stamps:** the loader fetches `chat.js?v=<hash>` etc. from `var VER = {...};   // widget-version`, written by `scripts/outreach-widget-version.mjs` (`--check` to verify). It runs as `prebuild` (so every Vercel build stamps the right hashes even if nobody ran it) and after `outreach-widget-build.mjs` rebuilds `voice.js`. Hashes ignore CRLF vs LF.
- **chat.js before the first click** only when it has work to do while closed: an open conversation (`gxwc:<token>:live` = 1, kept by chat.js; missing = a visitor from before the key, then the old "has a visitor token" rule), proactive campaigns (this also makes campaigns fire for first-time visitors, which never loaded chat.js before), or the embedded shell. Before, every returning visitor got chat.js, a visitor call and a realtime socket on every page.
- **Video bubble:** `video.js` and the clip wait for the page's `load` event (3 s at most); the launcher shows with them. The looping bubble pauses in a hidden tab and does not autoplay on Data Saver or with reduced motion (first frame, plays on click). Flag images are `loading="lazy"` (fetched when the language menu opens).
- **Loader:** the document-wide `MutationObserver` runs only when the page has Ask AI buttons or the site's own `data-growthxai` elements (the widget's own `launcher` / `panel` / `vp` / `selection` / `turnstile` don't count); the launcher's markup and stylesheet are rewritten only when they change. Loader budget raised to 14,200 B gzip for this.
- Tests: session scratchpad e53985d1… `stub.js` (port 4711, scenarios basic / novideo / camp / own / resolved / convs, `/slow?ms=`) + `perf_test.js` (26 Chrome checks); the update-6 harness (1c5ba437…, 42 checks) still passes.

## Turnstile (bot check before the first message)

- Off by default per inbox (Security → "Cloudflare Turnstile on the first message"). `/config` reports `security.turnstile_enabled` as **true only when the server can verify** (secret set + a site key), so a half-configured platform never challenges visitors it cannot check; `turnstile_site_key` falls back to the platform key.
- Widget (`chat.js` → `turnstileToken()`): loads `challenges.cloudflare.com/turnstile/v0/api.js?render=explicit` on demand, renders into a light-DOM host (`data-growthxai="turnstile"`; Turnstile does not render inside the closed shadow root) with `appearance: "interaction-only"`, `action: "webchat_start"`. Nothing is visible unless Cloudflare needs a click; then the box appears over the composer (`before/after-interactive-callback`). A token is fetched per conversation start (`POST /conversations` body `turnstile_token`) — tokens are single-use and expire after 5 minutes — and one fresh retry follows an `E_TURNSTILE` reply.
- Server (`outreach-webchat` → `verifyTurnstile`): siteverify with `remoteip`, 8 s timeout, `action` must be `webchat_start`; failures are logged with Cloudflare's `error-codes`. Customer CSP additions: `script-src` + `frame-src https://challenges.cloudflare.com` (Installation card shows them once the toggle is on).

## Testing locally

- SQL: the throwaway stack recipe from `ai-replies` memory (`%TEMP%\aistack`, `replay3.sh` runs 001–051 twice + the smoke tests).
- Widget: allow localhost on the inbox (Security tab), open `http://localhost:3000/widget/v1/demo.html?token=<website_token>&api=<SUPABASE_URL>/functions/v1/outreach-webchat`. The page logs every SDK event.
- Origin checks: a `curl` without an `Origin` header is rejected (403, no body) except from the app's own origin (standalone page).

## Operational notes

- Blocked visitors get a 200 with their echo id: nothing tells them they are blocked (PRD §15).
- Rate limits: per visitor in SQL (10/10 s, 200/h), per IP + per inbox in the function; AI answers 30/h per visitor. All overridable per inbox under Security.
- Settings are versioned in `outreach_webchat_settings_history`; the Installation tab's "Seen on" comes from `installed_origins`, written at most once a minute per origin.
- Presence: the app pings `outreach_webchat_presence` every minute from any outreach page; "online" for the widget = a collaborator pinged within 10 minutes and inside business hours.
- Video bubble uploads are compressed in the browser before they upload (`lib/videoCompression.ts`, mediabunny, ported from outfit-maker-lab and loaded with a dynamic import by `uploadWebchatMedia`). Every main, language and answer clip gets the same treatment: the short side is capped at 720 px, H.264 at about 1.5 Mbps (scaled to the output's pixel count, never above the source's rate), and Fast Start (`moov` before `mdat`). AAC sound is copied as it is; other sound is transcoded to AAC at 96 or 128 kbps (Chrome's Windows AAC encoder rejects rates in between and drops the track). A picked video may be up to 300 MB, and the compressed result must fit the 20 MB bucket limit. The original is uploaded instead when the browser has no WebCodecs, the re-encode fails or would drop the sound, or the saving is under 10%. GIF / WebP images are not touched.
