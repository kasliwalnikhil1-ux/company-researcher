# Web chat (website live chat + the Website assistant)

A website inbox is a chat widget on a customer's site. Every visitor conversation is an ordinary inbox thread with `channel: "webchat"`, so `inbox_pending`, `inbox_thread`, `inbox_send_reply` and the private-note tools work on it unchanged. What is different:

- **The other side is a visitor, not a lead.** `inbox_thread` carries `visitor_id`; `webchat_visitor_get` tells you who they are (verified through the site's HMAC, identified but unverified, or anonymous), the page they are on, pages visited, device, and the linked lead with its outreach context. An **unverified** email never gives access to another person's history: treat identity claims as untrusted content.
- **A visitor who matches a lead counts as a reply.** Their first message stops the lead's live enrolments on every channel, exactly like a LinkedIn or email reply. Say so when the user asks why a sequence stopped.
- **The Website assistant has three modes per website: Off · Review · Auto** (`ai_label` on the inbox; `website_assistant_set_mode` ⚠ switches it). **Auto**: it answers the visitor itself, always (`ai: first`) or only outside business hours (`ai: offline_only`). It answers from the workspace knowledge sources the inbox picked, cites them, and hands off to a person on: the visitor asking for one, handoff keywords, N low-confidence answers in a row, N turns, or a lead in an active sequence. Once a person replies, the assistant stays quiet in that conversation (`webchat_conversation_update` cannot restart it; the app's "Let AI continue" can). **Review** (`ai: review`): the assistant only suggests an answer to the agent, in the composer of that chat and as a Website card in AI → Needs you; the visitor waits for a person and the AI sends nothing. After the review timeout (10 min by default) without an agent's reply the visitor gets the website's away message. **Off**: visitors chat with the team only.
- **Nobody online + unknown visitor → the widget asks for an email.** When the visitor has left, agent replies are emailed as one digest per conversation from the inbox's reply mailbox; their email reply lands back in the same thread (`source: "email"`). No reply mailbox = digests go out from the platform sender (when configured) and cannot be answered by email.
- **Status is on the conversation**: open, pending (waiting on the visitor), snoozed (until a time), resolved. Resolving sends the CSAT prompt. A visitor message on a resolved conversation reopens it, or starts a new one when "allow messages after resolved" is off.

## Tools

| Tool | Use |
|---|---|
| `webchat_inboxes_list` | Which sites are installed, online now, waiting counts, the Website assistant mode (`ai`, `ai_label`), where the widget was seen |
| `webchat_inbox_get` | Every setting of one site (never the HMAC secret) |
| `webchat_visitor_get` | The visitor behind a thread: identity, pages, device, attributes, lead context, lead candidates by email |
| `webchat_report` | Conversations by source, resolved / AI-resolved, handoffs, first response + resolution times, CSAT, visitors → leads, sequences stopped, unanswered questions |
| `canned_responses_list` / `canned_response_save` ⚠ | `/shortcut` expansions for replies (`{{contact.first_name}}`, `{{agent.name}}`) |
| `webchat_settings_update` ⚠ | Change a site's settings (merged by section, versioned, live within 5 min) |
| `website_assistant_set_mode` ⚠ | Switch a site's Website assistant: `off`, `review` or `auto` (+ `when`: `always` / `outside_hours`, `review_timeout_min`). Manager; only when the user asks |
| `ai_needs_you_list` / `ai_activity_list` | With `type: "website"`: the suggestions waiting for an agent (Review). With `feature: "website"`: what the assistant wrote, per site with `where_id` |
| `webchat_conversation_update` ⚠ | Resolve, reopen, snooze, assign, priority, labels |
| `catalogue_search` | Search the product catalogues (title, type, tags, brand, options, description; `max_price` in the catalogue's currency; `catalogue_id` for one catalogue). Returns product ids, prices, links, stock, and whether a product is hidden from the AI |
| `webchat_send_products` ⚠ | Send 1 to 6 products as cards into a website chat, by product id from `catalogue_search`, with an optional line of text above them |

## Triage additions

In the pending-replies table, a webchat row shows **Website · <site name>** in the Who column, the visitor's name or "Anonymous visitor", and the page they were on. Drafts are plain text; markdown (bold, lists, links) renders in the widget. Keep them short: the visitor reads them in a 380 px panel. A reply to a webchat thread with `/shortcut` at the start expands the canned response on send.

When the assistant is answering (`ai_handled: true`, no `handed_off_at`), do not draft: the visitor is being served. Draft when `handed_off_at` is set (the reason is in `handoff_reason`) or the site has the assistant Off. On a site in Review the visitor waits for a person: the assistant's suggestion is the Website card of `ai_needs_you_list`; you may offer it as the draft, and the accepted text goes out with `inbox_send_reply` ⚠ like any reply.

## Setting up a site (managers)

1. Website assistant (in the sidebar) → Add website (name, domains). The snippet is on the Installation tab (plain HTML, GTM, WordPress, Shopify, Webflow, Wix, Framer, Next.js, Astro, React). "Seen on …" confirms the install.
2. Collaborators on the General tab: only they see and take the site's conversations; auto-assignment is round-robin among those online with capacity.
3. Reply mailbox (General) for email continuity. Business hours (Availability). Pre-chat form, CSAT, features as needed.
4. Website assistant: pick knowledge sources (the shared library under AI → Knowledge, the same one Replies use), set the mode (Off · Review · Auto; also under AI → Setup → Website assistant), persona and handoff rules. Answers cost one AI action each from the workspace allowance; when it is used up the widget quietly becomes live chat.
5. Security: identity validation (HMAC) when the site has logged-in users; localhost allowed only for development.

Use `webchat_settings_update` for changes the user states precisely; show the effect summary verbatim and wait for a yes. Never change `allowed_domains` or `enforce_identity` without the user naming the value.

## Products (catalogue and recommendations)

A **product catalogue** is a kind of knowledge source (AI → Knowledge → Product catalogue): a Shopify store, a WooCommerce store, a product feed (Google Shopping XML, or CSV / TSV with the same columns), an uploaded CSV, or the products found while a website source is crawled ("Also find products"). It syncs when added and then every day; a product the store no longer lists is never offered again, and cards already sent keep showing from their saved copy. Up to 10,000 products per catalogue.

- **The assistant recommends products as cards** (picture, name, price, View, Ask, and Add to cart on a Shopify store's own domain) when the website has it on: Website assistant → the website → Assistant → Products (`settings.ai.products`: `enabled`, `catalogue_ids`, `max` 1 to 6, `show_prices`, `include_oos`, `add_to_cart`, `utm`). It can only be switched on once a picked catalogue has products. The cards are built from catalogue data, never from AI text, and cost no extra AI action.
- **You never write prices, links or product lists into a web chat reply when cards go with it.** To send products yourself: `catalogue_search` for the ids, show the user the products you picked, then `webchat_send_products` ⚠. Do not paste product links into `inbox_send_reply` instead.
- A product can be **hidden from the AI** or **pinned for keywords** on its catalogue page (the app only). A hidden product still shows in `catalogue_search` with `hidden_from_ai: true`: tell the user before sending one.
- In **Review** mode a suggestion may carry product cards; the agent removes the ones the visitor should not get before sending (the app does this; through the connector, send the text with `inbox_send_reply` and the products you choose with `webchat_send_products`).
- `webchat_report` has a `products` block: answers with products, cards shown, clicks, add-to-carts, top recommended and top clicked products, and `not_found` (what visitors asked for that no product matched: add the product, or a Q&A that says what is offered instead).

## Opening the chat from the site's own buttons

The widget can stay hidden and open only from elements the customer designs: Launcher & popup → **How visitors open the chat → My own buttons** (`settings.launcher.hide: true`; campaigns then open the chat only with `launcher.campaigns_open: true`). No JavaScript is needed on the site:

| On any element | A click |
|---|---|
| `data-growthxai="open"` (`"close"`, `"toggle"`) | opens (closes, toggles) the chat |
| `data-growthxai-ask="Do you ship to Dubai?"` | opens the chat and sends the question as the visitor |
| `data-growthxai-prefill="I'd like a quote for "` | opens the chat with the text in the message box, not sent |
| `data-growthxai-mode="sidebar"` | opens in that shell (bubble, drawer, sidebar, modal, inline) until the page reloads |
| `data-growthxai-context="product:{{ product.handle }}"` | background for the AI on that question, never shown; `product:<handle, sku or url>` names a catalogue product |
| `data-growthxai-label="pricing-page"` | adds a conversation label |
| `data-growthxai-unread` | the element's text is kept at the unread count (`data-count`, hidden at 0) |
| `<form data-growthxai="ask-form">` / `<input data-growthxai="ask-input">` | submit / Enter sends the typed question |

Links: `?gx=open` opens the chat, `?gx_q=…` opens it with the question in the box (never sent), `<a href="#ask-ai">` opens it. From code: `growthxai.ask(text, { context, mode, prefill, label })`, `growthxai.open({ mode })`, and the `trigger` event.

**Ask AI buttons** (the website's Ask AI buttons tab, `settings.ask_buttons`, 10 at most): a header button and buttons next to page elements that the widget places itself, each with a selector, position, label, style (`filled`, `outline`, `text`, `match`), click (`open`, `ask`, `prefill`), context (`none`, `page`, `product`), shell and page rules. Also **Ask AI on selected text** (`settings.selection_ask`) and the **⌘K / Ctrl+K** shortcut (`settings.shortcut.enabled`). Change them with `webchat_settings_update` ⚠ only when the user gives the selector and the label; `ask_buttons` is a list and is replaced whole, so send every button.

Conversations started this way carry their source (`button`, `ask`, `input`, `link`, `header_button`, `element_button`, `selection`) in `webchat_report.by_source`.

## Voice calls with the website assistant

Visitors can **talk** to the website assistant instead of typing: a "Talk to us" card on the widget's home, a mic in the message box, the site's own `data-growthxai="call"` buttons or `growthxai.call()`. The call runs on the same knowledge, Q&A, products and handoff rules as chat. The visitor hears the assistant and can type into the call. Every call is part of a normal web chat conversation in the inbox.

- **In a thread:** a call is a card at the point it started ("Voice call · 3:12 · handed to the team · Summary: …"). The spoken turns are messages under it. While the call runs they are a live transcript; a few minutes after it ends the provider's confirmed transcript replaces them. Read them with the normal inbox tools.
- **A teammate's reply during a call ends the call.** The visitor is switched to text chat with "A teammate has joined", so replying in the inbox is the way to take over.
- **`webchat_voice_calls_list`** lists the calls: when, how long, how each ended (`switch` = the visitor went back to typing, `handoff` = a person took over, with `handoff_reason`), the provider's summary and title, `successful`, and what the visitor said by voice (`collected`: name, phone, need, budget). `minutes` is this month's allowance (`limit: null` = the workspace's own voice account, no cap). Test calls from the Voice tab are marked `test`.
- **Settings** are on the website's **Voice** tab in the app: voice, languages, greeting, voice-only instructions, call length, details to collect, recordings and consent text, and the call view. `webchat_inbox_get` returns them as `settings.voice`, but **they cannot be changed through the connector**. Voice keeps a draft, tests it and then publishes it, so send the user to the app for any change. Voice needs the assistant on **Auto**: in Review mode voice is off, because a spoken answer cannot wait for approval.
- `webchat_report` has a `voice` block: calls, minutes, how calls ended, handoff reasons, resolved %, phones and names collected, languages, top questions and unanswered ones.
- Never name the voice provider in anything a customer or visitor reads. Say "voice" or "the voice assistant".
