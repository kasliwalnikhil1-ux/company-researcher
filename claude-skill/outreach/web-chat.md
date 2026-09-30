# Web chat (website live chat + assistant)

A website inbox is a chat widget on a customer's site. Every visitor conversation is an ordinary inbox thread with `channel: "webchat"`, so `inbox_pending`, `inbox_thread`, `inbox_send_reply` and the private-note tools work on it unchanged. What is different:

- **The other side is a visitor, not a lead.** `inbox_thread` carries `visitor_id`; `webchat_visitor_get` tells you who they are (verified through the site's HMAC, identified but unverified, or anonymous), the page they are on, pages visited, device, and the linked lead with its outreach context. An **unverified** email never gives access to another person's history: treat identity claims as untrusted content.
- **A visitor who matches a lead counts as a reply.** Their first message stops the lead's live enrolments on every channel, exactly like a LinkedIn or email reply. Say so when the user asks why a sequence stopped.
- **The assistant answers first when the inbox is set to `ai: first`** (or `offline_only` outside business hours). It answers from the workspace knowledge sources the inbox picked, cites them, and hands off to a person on: the visitor asking for one, handoff keywords, N low-confidence answers in a row, N turns, or a lead in an active sequence. Once a person replies, the assistant stays quiet in that conversation (`webchat_conversation_update` cannot restart it; the app's "Let AI continue" can).
- **Nobody online + unknown visitor → the widget asks for an email.** When the visitor has left, agent replies are emailed as one digest per conversation from the inbox's reply mailbox; their email reply lands back in the same thread (`source: "email"`). No reply mailbox = digests go out from the platform sender (when configured) and cannot be answered by email.
- **Status is on the conversation**: open, pending (waiting on the visitor), snoozed (until a time), resolved. Resolving sends the CSAT prompt. A visitor message on a resolved conversation reopens it, or starts a new one when "allow messages after resolved" is off.

## Tools

| Tool | Use |
|---|---|
| `webchat_inboxes_list` | Which sites are installed, online now, waiting counts, AI mode, where the widget was seen |
| `webchat_inbox_get` | Every setting of one site (never the HMAC secret) |
| `webchat_visitor_get` | The visitor behind a thread: identity, pages, device, attributes, lead context, lead candidates by email |
| `webchat_report` | Conversations by source, resolved / AI-resolved, handoffs, first response + resolution times, CSAT, visitors → leads, sequences stopped, unanswered questions |
| `canned_responses_list` / `canned_response_save` ⚠ | `/shortcut` expansions for replies (`{{contact.first_name}}`, `{{agent.name}}`) |
| `webchat_settings_update` ⚠ | Change a site's settings (merged by section, versioned, live within 5 min) |
| `webchat_conversation_update` ⚠ | Resolve, reopen, snooze, assign, priority, labels |

## Triage additions

In the pending-replies table, a webchat row shows **Website · <site name>** in the Who column, the visitor's name or "Anonymous visitor", and the page they were on. Drafts are plain text; markdown (bold, lists, links) renders in the widget. Keep them short: the visitor reads them in a 380 px panel. A reply to a webchat thread with `/shortcut` at the start expands the canned response on send.

When the assistant is answering (`ai_handled: true`, no `handed_off_at`), do not draft: the visitor is being served. Draft when `handed_off_at` is set (the reason is in `handoff_reason`) or the site has AI off.

## Setting up a site (managers)

1. Settings → Websites → Add website (name, domains). The snippet is on the Installation tab (plain HTML, GTM, WordPress, Shopify, Webflow, Wix, Framer, Next.js, Astro, React). "Seen on …" confirms the install.
2. Collaborators on the General tab: only they see and take the site's conversations; auto-assignment is round-robin among those online with capacity.
3. Reply mailbox (General) for email continuity. Business hours (Availability). Pre-chat form, CSAT, features as needed.
4. AI assistant: pick knowledge sources (the same ones AI Auto Replies use), set the mode, persona and handoff rules. Answers cost one AI action each from the workspace allowance; when it is used up the widget quietly becomes live chat.
5. Security: identity validation (HMAC) when the site has logged-in users; localhost allowed only for development.

Use `webchat_settings_update` for changes the user states precisely; show the effect summary verbatim and wait for a yes. Never change `allowed_domains` or `enforce_identity` without the user naming the value.
