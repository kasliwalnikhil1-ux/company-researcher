# PRD: Web Chat (embeddable live chat + AI assistant, into the unified inbox)

**Product:** Outreach platform (LinkedIn multi-sender + email + WhatsApp/Instagram), Supabase + React
**Version:** 1.0 · 29 September 2026
**Builds on:** `linkedin-outreach-platform-PRD.md` (unified inbox, leads, AI classify/draft, webhooks, MCP), `native-email-PRD.md` (email transport for continuity)
**Code base to start from:** `chatbot-main` (own repo): `web/loader.js` (~8 KB) + `web/chat-widget.js` (~20 KB), Shadow DOM widget with 5 display modes, Supabase Edge Functions `chat`, `widget-config`, `feedback`, `track-order`, pgvector RAG, origin→tenant resolution, per-IP rate limits.
**Feature reference to replicate:** Chatwoot (MIT core, v4.15.x) — https://github.com/chatwoot/chatwoot. Widget app: `app/javascript/widget/`; SDK: `app/javascript/entrypoints/sdk.js`; widget channel model: `app/models/channel/web_widget.rb`; public widget API: `app/controllers/api/v1/widget/`; conversation reply emails: `app/mailers/conversation_reply_mailer.rb`. Paths as of v4.15 — verify. Do **not** copy anything under `enterprise/` (separate licence; includes the Captain AI agent).
**Settings reference:** LimeChat web widget (a Chatwoot-style helpdesk) — its Website inbox + Widget Settings pages are mirrored in §12.

---

## 1. What we're building

A visitor on a customer's website opens a chat widget, gets an instant AI answer from the site's content or talks to a person. Every conversation lands in the platform's **unified inbox** next to LinkedIn, email, WhatsApp and Instagram threads. The operator replies from the inbox with the same composer, canned responses and AI drafts they already use. If the visitor leaves, the operator's reply is emailed to them; the visitor's email reply comes back into the same conversation. The operator controls look, behaviour, availability, forms, AI and security per website.

**Why it belongs in an outreach platform:** a visitor who gives an email that matches a lead instantly shows their outreach history (sequences, LinkedIn status, last message) beside the chat, and chatting counts as a reply — so sequences stop on every channel, exactly like a LinkedIn or email reply.

---

## 2. Goals / non-goals

### Goals (v1 GA)
1. One script tag installs the widget; launcher paints < 100 ms after the loader executes; no layout shift on the host page.
2. Real-time two-way chat (p95 message delivery < 500 ms) with typing indicators, delivery/read state, attachments, emoji, markdown.
3. Conversations are first-class inbox threads: assignment, status, labels, notes, canned responses, CSAT, search.
4. Offline continuity by email in both directions, using the native email transport.
5. Optional AI assistant (the chatbot-main RAG) answers first and hands off to a human by rule.
6. Full customisation (appearance per desktop/mobile, launcher, popup, messages, pre-chat form, business hours, features, security) without the customer redeploying code.
7. JS SDK for identity (HMAC-verified), attributes, events and programmatic control.
8. Production grade: WCAG 2.2 AA, i18n + RTL, rate limiting, abuse controls, 99.9% availability for the public widget API.

### Non-goals (v1)
Mobile SDKs (iOS/Android/React Native), co-browsing, voice/video calls, help-centre portal, ticketing forms, WhatsApp-style broadcast from the widget, visitor live-list with real-time browsing (P5), Slack reply (P5).

---

## 3. How it fits the existing platform

| Concept | Existing | Web chat addition |
|---|---|---|
| Channel | linkedin, email, whatsapp, instagram | `webchat` |
| Inbox / account | sender (a connected account) | **website inbox** (`webchat_inboxes`) — one per website/domain; belongs to a workspace and optionally a client |
| Conversation | `chats` | `chats` row with `channel='webchat'`, `webchat_inbox_id`, `visitor_id` |
| Message | `messages` | same table; new `content_type` values (§10) |
| Person | `leads` | `webchat_visitors`; linked to a `lead` when email/phone/identifier matches or when the operator converts them |
| Reply stops sequences | reply on any channel exits enrollments | a visitor message from a visitor linked to a lead = reply |
| AI | `ai_classify`, `draft_reply` | same, plus the RAG assistant (§11) |
| Realtime | Supabase Realtime for the inbox | Realtime broadcast for widget ↔ server (§13) |
| Billing | `plan_entitlements` | website inboxes per plan + AI answers draw from AI actions (§16) |

Multi-tenancy: chatbot-main's `tenants` table maps to `webchat_inboxes` (one per site) under a `workspace`. Keep its rule that every SQL function takes an explicit `p_inbox_id` / `p_workspace_id` (pooler-safe; no session GUC for tenancy).

---

## 4. Installation

### 4.1 Snippet (shown in Settings → Websites → Installation, copy button)
```html
<script>
  window.kapturedSettings = { position: "right", locale: "en" }; // optional
  (function(d,t){var g=d.createElement(t),s=d.getElementsByTagName(t)[0];
   g.src="https://cdn.<product-domain>/widget/v1/loader.js"; g.async=true;
   g.dataset.websiteToken="<WEBSITE_TOKEN>"; s.parentNode.insertBefore(g,s);})(document,"script");
</script>
```
- `websiteToken` = public, non-secret inbox identifier (Chatwoot's `website_token` equivalent). Server resolves inbox by token **and** checks `Origin` against the inbox's allowed domains (chatbot-main's origin→tenant logic generalised).
- Also accepted: `data-*` attributes from chatbot-main (`data-mode`, `data-theme`, `data-accent`, `data-position`, `data-quick-prompts`, …). Precedence: SDK call > `window.kapturedSettings` > `data-*` > server config > defaults.
- Install guides generated per inbox: plain HTML, Google Tag Manager, WordPress, Shopify (theme.liquid), Webflow, Wix, Framer, Next.js (`next/script strategy="afterInteractive"`), Astro (`is:inline`), React SPA.
- **Verify install** button: server records the first `widget-config` hit per origin; UI shows "Seen on example.com 2 min ago".
- Namespace `window.kaptured` is a placeholder — rename to the product brand before GA; keep a stable alias.

### 4.2 Loading behaviour
- Loader (≤ 10 KB gzip): guard double-init (`window.__kapturedLoaded`), read config from `localStorage` cache for instant paint, fetch `widget-config` in background (2 s timeout), render launcher, prefetch panel bundle on idle / on launcher hover, load on first open.
- Panel bundle (≤ 45 KB gzip), versioned path `/widget/v1.x.y/`, immutable caching; loader is short-cache (5 min) so UI updates ship without customer redeploys.
- SPA support: `kaptured.onRouteChange()` auto via `history.pushState/replaceState` + `popstate` hooks to refresh page targeting, page-view tracking and campaigns.
- CSP: document required `script-src`, `connect-src` (API + Realtime wss), `img-src` (Storage CDN), `frame-src` none (no iframes; Shadow DOM). Widget must work with `style-src` nonce-less because styles live inside the Shadow root.
- Never blocks host page: all work deferred; host element `pointer-events:none` except interactive surfaces (from chatbot-main).

---

## 5. Widget — visitor experience

### 5.1 Shells (from chatbot-main; all share one message engine)
| Mode | Behaviour |
|---|---|
| `bubble` (default) | Launcher + popup panel 384×600; full screen on mobile |
| `drawer` | Full-height slide-in, left or right, 320–720 px |
| `sidebar` | Docked panel pushing page content, resizable, width remembered |
| `modal` | Centred dialog, ⌘K/Ctrl-K, hands off to sidebar on first send |
| `inline` | Sticky bottom pill that opens the panel |
| `embedded` (new) | Renders inside a customer container (`data-mount-selector`), e.g. a Contact page |
| `standalone` (new) | Hosted full-page chat at `chat.<product-domain>/<website_token>` for link-in-bio / email signatures |

### 5.2 Launcher (LimeChat-style, configured separately for desktop and mobile)
- Type: **Icon** (round) or **Button** (pill with text); size Small / Medium / Large; position Left / Right; bottom and side margins (defaults: desktop 48 px, mobile 36 px); button message ≤ 20 chars; z-index (default `2147483000`).
- Unread badge (count capped at 9+) and **unread message preview** cards above the launcher when closed (toggle "Show unread messages").
- Online indicator dot when an agent is available.
- Hide launcher entirely (open only via SDK / custom button) — `hideMessageBubble`.

### 5.3 Popup message (proactive nudge)
Text ≤ 60 chars, optional 50×50 image, delay (default 3 s; 2–5 s recommended), position (top of launcher / left side), dismissible, shown once per session, suppressed after the visitor has chatted.

### 5.4 Panel
- Header: logo (50×50), bot/brand name (≤ 20 chars), welcome heading (≤ 50), welcome tagline (≤ 50), team avatars (up to 3 online agents), **reply-time text** ("Typically replies in a few minutes / a few hours / a day / hidden"), online/offline status (toggle "Show agent offline status"), menu (new conversation, previous conversations, transcript by email, sound on/off, pop out, close).
- Home/empty state: greeting, quick-reply chips (conversation starters, from chatbot-main `quickPrompts`), "Continue conversation" card for an open thread, optional AI search box.
- Message list: grouped by sender within 60 s, timestamps on last of a run, agent name + avatar per message, bot messages marked "AI", system events (assigned, resolved) as subtle lines, date separators, infinite scroll up for history.
- Composer: auto-grow textarea, Enter to send (Shift+Enter newline, IME-aware), **file picker**, **emoji picker**, paste images, drag-and-drop files, character limit 5,000, disabled with reason when blocked (e.g. "Chat is closed — start a new conversation").
- Toggles (per inbox): file picker, emoji picker, **restart conversation** button, **end conversation** button (visitor-side resolve), "allow messages after resolved" (reopens vs starts new), "lock to single conversation" (no conversation list).
- Message states: sending (spinner) → sent (✓) → read by agent (✓✓, toggle "Show read receipts"); failed with Retry.
- Typing indicator both ways (agent typing shown to visitor; visitor typing preview shown to agent — throttled 1/2 s).
- Rich content: markdown (safe subset), links with `safeUrl`, images inline with lightbox, file cards, **cards/carousel** (product recommendations from chatbot-main), **quick-reply buttons** sent by agent/bot, **forms in chat** (email ask, pre-chat, CSAT), **order tracking** app (chatbot-main Shopify integration, optional per inbox).
- AI answer UI (from chatbot-main): streaming tokens, citations/sources accordion, copy, 👍/👎 feedback, "Talk to a person" button always visible when AI mode is on.
- Sounds: new message chime (default on when tab hidden), respects mute.
- Theme: light / dark / auto (`prefers-color-scheme`), fonts (Inter default; LimeChat-style font picker), colours (§12.2), custom CSS field (advanced, sanitised, scoped to Shadow root).

### 5.5 Pre-chat form (per inbox)
- Enable/disable; message above form (≤ 200 chars).
- Standard fields: name, email, phone (E.164 with country picker); each toggle visible/required.
- Custom fields from contact/conversation attribute definitions: text, number, email, phone, list (dropdown), checkbox, date, URL; label, placeholder, required, regex validation.
- Consent checkbox (GDPR/marketing) with custom label + link; stored with timestamp and text version.
- Skip form when visitor is already identified via SDK.
- Show form: before first message (default) or only when no agent is online (offline form).

### 5.6 Email capture (when nobody is online)
If no agent online and visitor unknown: after the first visitor message, bot message "We'll reply here and by email — what's your email?" with inline email input (Chatwoot "email collect box"). Toggle per inbox.

### 5.7 Availability
- Business hours per inbox: weekly schedule, multiple intervals per day, timezone, holidays list.
- Outside hours: **unavailable message** shown in panel + reply-time text switches to "We're away — back at 9:00 IST"; widget can hide entirely outside hours (toggle).
- Agent availability states: online / busy / offline (auto-offline after 10 min inactivity in the app). "Online" for the widget = at least one inbox member online and within business hours.

### 5.8 CSAT
On resolve (agent or visitor "end conversation"): CSAT message in widget — 5-point emoji scale or thumbs (setting), optional comment, one response per conversation, editable for 24 h. Also sent by email if the visitor has left (continuity). Stored on the conversation; reported per agent/inbox.

### 5.9 Persistence and continuity across pages/devices
- Anonymous visitor gets a signed **visitor token** (JWT, 365-day expiry, claims `visitor_id`, `inbox_id`) stored in `localStorage` with cookie fallback (`SameSite=Lax`, first-party to host site not possible → localStorage primary). Conversation survives navigation, reloads, and new tabs (cross-tab sync via `BroadcastChannel`).
- Identified visitors (SDK `setUser` with HMAC) resume the same history on any device.
- "Previous conversations" list unless locked to single conversation.
- Transcript: visitor can request "Email me this conversation".

### 5.10 Targeting
- Show/hide on URL rules (contains / equals / starts with / regex), include + exclude lists.
- Hide on mobile / desktop.
- Show only to identified users (e.g. inside a customer's app).
- Country include/exclude (from IP, server-side).

### 5.11 Proactive campaigns (P4)
Rules: URL match + time on page (s) + (optional) first visit / returning visitor / identified only + business hours only. Content: message from a chosen agent or the bot, optional quick replies. Frequency: once per visitor / per session / every visit. Opens the panel or shows as popup. Reports: shown, clicked, conversations started.

### 5.12 Localisation & accessibility
- Locales at launch: en, hi, es, fr, de, pt, ar (RTL), with `useBrowserLanguage`; all widget strings from a locale bundle; operator-authored texts can be set per locale.
- WCAG 2.2 AA: keyboard reachable launcher, focus trap in modal/drawer, focus restore on close, `role="dialog"`/`aria-modal`, `aria-live="polite"` for new messages, labelled buttons, 4.5:1 contrast checked on the chosen colours (warn in settings), reduced-motion honoured, 200% zoom, touch targets ≥ 44 px (from chatbot-main's approach).

---

## 6. JavaScript SDK

Global `window.kaptured` (rename to brand), ready event `kaptured:ready`. Methods mirror Chatwoot's `$chatwoot` plus chatbot-main's API.

| Method | Purpose |
|---|---|
| `open()`, `close()`, `toggle(state?)` | Panel control |
| `toggleBubbleVisibility('show'\|'hide')` | Launcher visibility |
| `popoutChatWindow()` | Open standalone page in a new window |
| `setMode(mode)` | bubble / drawer / sidebar / modal / inline / embedded |
| `send(text)` | Send a visitor message (or pre-fill with `{prefill:true}`) |
| `setUser(identifier, {email, name, phone, avatarUrl, company, identifierHash, ...})` | Identify; `identifierHash` required when identity validation is enforced |
| `setCustomAttributes(obj)` / `deleteCustomAttribute(key)` | Contact attributes |
| `setConversationCustomAttributes(obj)` / `deleteConversationCustomAttribute(key)` | Current conversation attributes |
| `setLabel(label)` / `removeLabel(label)` | Conversation labels from the site (e.g. `pricing-page`) |
| `setLocale(locale)` | Language |
| `setColorScheme('light'\|'dark'\|'auto')` | Theme |
| `trackEvent(name, props?)` | Custom event on the visitor timeline (P4) |
| `reset()` | Logout: clear visitor token + history on this device |
| `destroy()` | Full teardown (SPA) |
| `on(event, cb)` / `off(event, cb)` | Events below |
| `getUnreadCount()`, `isOpen`, `mode` | State |

Settings (`window.kapturedSettings`, all optional): `locale`, `useBrowserLanguage`, `position`, `type` (`standard`|`expanded_bubble`), `launcherTitle`, `hideMessageBubble`, `showPopoutButton`, `showUnreadMessagesDialog`, `darkMode`, `mode`, `baseDomain` (share the visitor token across subdomains via cookie), `welcomeTitle`, `welcomeDescription`, `availableMessage`, `unavailableMessage`, `enableFileUpload`, `enableEmojiPicker`, `enableEndConversation`.

Events: `ready`, `opened`, `closed`, `message` (incoming, payload without internal notes), `message:sent`, `conversation:started`, `conversation:resolved`, `unread`, `csat:submitted`, `error`. Also dispatched as `window` CustomEvents `kaptured:<event>`.

---

## 7. Identity and security

- **Identity validation (HMAC):** per inbox secret `hmac_token`. The customer's server computes `identifierHash = HMAC_SHA256(key = hmac_token, message = identifier)` hex. Server verifies on `setUser`. Inbox toggle **Enforce identity validation**: when on, `setUser` without a valid hash is rejected (`E_IDENTITY_INVALID`) and the visitor stays anonymous. Show code samples (Node, Python, PHP, Ruby, Go) in settings. Regenerating the token invalidates old hashes.
- **Anonymous → identified merge:** on valid `setUser`, merge the anonymous visitor's conversations into the identified contact; if the identifier already exists, merge into it (never the reverse). Unverified email typed in pre-chat form **does not** merge into an existing contact's history (prevents reading someone else's history by typing their email) — creates a new visitor flagged "unverified email", linked to the lead for the operator's context only.
- **Origin check:** every public endpoint checks `Origin` ∈ inbox allowed domains (exact host + optional wildcard subdomain). Unknown origin → 403, no body. `localhost`/preview domains opt-in per inbox.
- **Visitor token:** JWT signed server-side (HS256, key per environment), sent as `Authorization: Bearer` on widget calls and used for Realtime channel authorisation. Rotatable.
- **Rate limits** (from chatbot-main, per inbox overridable): per visitor 10 messages/10 s and 200/hour; per IP 20/min and 300/hour; per inbox 2,000/min. AI answers additionally capped per visitor (30/hour) to protect AI credits. 429 → widget shows friendly retry.
- **Abuse controls:** block visitor / IP / country from the inbox (block list); honeypot field on forms; message length cap 5,000; link-spam heuristic (> 5 links) → flagged; profanity filter optional; attachments scanned by MIME sniffing (allow list: images, PDF, office docs, txt, csv, zip off by default; max 10 MB; executables always blocked); optional Cloudflare Turnstile on first message (off by default, auto-on when inbox is under attack).
- **Output safety:** all visitor/agent text escaped; markdown rendered with a whitelist; `safeUrl` allows http/https/mailto/tel only; images via Storage signed URLs; no `innerHTML` of untrusted content (from chatbot-main).
- **Privacy:** IPs stored as `sha256(ip + inbox salt)` plus coarse geo (country/city) only; visitor data export + deletion (per visitor, per inbox); retention follows workspace lifecycle (trial +7 days, cancelled +30 days); cookie-less by default (localStorage), with an optional "wait for consent" mode (`kaptured.consent(true)` before anything is stored).

---

## 8. Agent side (unified inbox)

- **Conversation list:** webchat badge + website name; filters by inbox/website, status, assignee, team, label, channel; sort by last activity / waiting time; unread counts; "Mine / Unassigned / All" tabs.
- **Statuses:** open, pending (waiting on visitor), snoozed (until time / until visitor replies), resolved. Visitor message on resolved → reopens (or new conversation if "allow messages after resolved" is off).
- **Assignment:** inbox collaborators (members allowed to see the inbox); auto-assignment round-robin among online collaborators with **max open conversations per agent** (capacity); manual assign/reassign; teams; unassign on agent offline after X min (setting).
- **Composer:** reply, **private note** (with @mentions + notification), canned responses via `/shortcut` (shared + personal, with variables `{{contact.name}}`, `{{agent.name}}`), attachments, emoji, AI draft ("Draft reply" from existing `draft_reply`, plus "Improve / shorten / translate"), send quick-reply buttons, send a form (email ask, CSAT), send article/link card.
- **Visitor typing preview** ("sneak peek") shown to the agent.
- **Contact panel:** name, email, phone, avatar, identified/verified badge, location + local time, browser/OS/device, current page (live), pages visited this session (last 20 with timestamps), referrer, UTM params (from chatbot-main `data-send-utm`), first seen / last seen, conversation count, custom attributes (editable), labels, **linked lead** with outreach timeline (sequences, LinkedIn relation, last touch per channel), "Convert to lead" / "Link to lead" actions, block visitor.
- **Conversation actions:** resolve, snooze, assign, label, priority (urgent/high/medium/low), mute, email transcript, export, merge duplicates, mark unread.
- **Notifications:** in-app + sound, browser push (Web Push, VAPID), email notification when assigned/mentioned/new unassigned (digest settings), mobile PWA. Slack (P5).
- **Keyboard shortcuts:** next/prev conversation, resolve (⌘E), assign to me, open canned responses, focus composer.
- **Search:** full-text over messages and contacts (Postgres `tsvector` + trigram), filters.
- **SLA (P4):** first response and resolution targets per inbox with breach indicators.

---

## 9. Email continuity (uses the native email transport)

### 9.1 Visitor side
1. Visitor has an email (pre-chat, email capture, or SDK) and is **not active** in the widget (no heartbeat for 3 min, or tab closed).
2. Agent/bot messages sent while inactive are batched: first email after **5 min** of inactivity, containing all unseen messages since the last email (digest per conversation, not per message; max 1 email per 15 min per conversation).
3. Sent through the inbox's **reply mailbox** (a connected mailbox from the native email PRD; setting "Send continuity emails from"). Fallback when none connected: platform sending domain (`no-reply` not allowed — use `reply+{token}@reply.<product-domain>` with an inbound provider, P2).
4. Email content: brand header, the new messages (agent name + avatar), "Reply to this email or continue the chat" link (deep link opening the conversation on the customer's site or the standalone page with a one-time token), unsubscribe-from-this-conversation link.
5. Threading: every continuity email for a conversation shares a root `Message-ID` stored on the chat; `In-Reply-To`/`References` set, subject stays `Re: Your conversation with {brand}`.
6. **Visitor replies by email** → mail worker matches via `In-Reply-To`/`References` (native email §7.2 rule 1) or plus-address token (rule 4) → quote-stripped `reply_text` appended to the web chat conversation as a visitor message with `source='email'` → shown in the widget on next visit and in the inbox immediately. Auto-replies/bounces follow native email rules (never become visitor messages; hard bounce stops continuity emails for that address).
7. Visitor returns to the site while an email thread exists → widget shows the full history including email replies.

### 9.2 Agent side (P5)
Agents can reply to "new message" notification emails; the reply posts into the conversation (matched by per-agent plus-address token + sender verification by DKIM-aligned From = agent's platform email). Off by default.

### 9.3 Settings
Enable continuity (default on), inactivity delay (3–30 min), digest window, reply mailbox, include transcript on resolve (toggle), CSAT by email (toggle).

---

## 10. Data model

```sql
create table webchat_inboxes (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references workspaces(id) on delete cascade,
  client_id        uuid references clients(id) on delete set null,
  name             text not null,                       -- "Website Name"
  website_token    text unique not null,                -- public
  hmac_token       text not null,                       -- secret; Vault in prod
  enforce_identity boolean not null default false,
  allowed_domains  text[] not null default '{}',
  settings         jsonb not null default '{}',         -- every §12 setting, validated by JSON schema
  ai_enabled       boolean not null default false,
  reply_mailbox_id uuid references mailboxes(id),
  business_hours   jsonb not null default '{}',         -- {tz, weekly:[{day,from,to}], holidays:[...]}
  is_active        boolean not null default true,       -- "widget on/off without deleting"
  created_at       timestamptz not null default now()
);

create table webchat_inbox_members (
  inbox_id uuid references webchat_inboxes(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  auto_assign boolean not null default true,
  primary key (inbox_id, user_id)
);

create table webchat_visitors (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references workspaces(id) on delete cascade,
  inbox_id         uuid not null references webchat_inboxes(id) on delete cascade,
  identifier       text,                                -- from setUser (verified or not)
  identity_verified boolean not null default false,
  name text, email citext, email_verified boolean not null default false, phone text, avatar_url text,
  lead_id          uuid references leads(id) on delete set null,
  custom_attributes jsonb not null default '{}',
  consent          jsonb,                               -- {marketing:true, text_version, at}
  ip_hash text, country text, city text, timezone text,
  browser text, os text, device text, locale text,
  first_seen_at timestamptz default now(), last_seen_at timestamptz,
  blocked_at timestamptz,
  unique (inbox_id, identifier)
);

create table webchat_page_views (
  id bigserial primary key, visitor_id uuid references webchat_visitors(id) on delete cascade,
  url text, title text, referrer text, utm jsonb, at timestamptz default now()
);

-- chats (existing) gains:
alter table chats
  add webchat_inbox_id uuid references webchat_inboxes(id),
  add visitor_id uuid references webchat_visitors(id),
  add status text not null default 'open',           -- open|pending|snoozed|resolved
  add snoozed_until timestamptz,
  add priority text, add assignee_id uuid, add team_id uuid,
  add labels text[] not null default '{}',
  add custom_attributes jsonb not null default '{}',
  add csat jsonb,                                     -- {rating, comment, at}
  add ai_handled boolean not null default false, add handed_off_at timestamptz,
  add first_response_at timestamptz, add resolved_at timestamptz,
  add email_root_message_id text;                      -- continuity thread root

-- messages (existing) gains:
alter table messages
  add content_type text not null default 'text',       -- text|attachment|cards|quick_replies|form|form_response|csat|event|note
  add content_attributes jsonb not null default '{}',  -- cards, buttons, form schema, citations
  add is_private boolean not null default false,       -- internal note
  add sender_type text,                                -- visitor|agent|bot|system
  add read_by_visitor_at timestamptz, add read_by_agent_at timestamptz,
  add echo_id text;                                    -- client-generated id for optimistic UI + dedupe

create table canned_responses (
  id uuid primary key default gen_random_uuid(), workspace_id uuid, owner_id uuid null,
  short_code text not null, content text not null, unique (workspace_id, short_code)
);

create table webchat_campaigns (
  id uuid primary key default gen_random_uuid(), inbox_id uuid references webchat_inboxes(id) on delete cascade,
  title text, message text, sender_kind text, sender_id uuid,
  rules jsonb not null,   -- {url_rules, time_on_page_s, visitor:'all|new|returning|identified', business_hours_only}
  frequency text, enabled boolean default true
);

create table webchat_blocks (
  inbox_id uuid, kind text check (kind in ('visitor','ip_hash','country')), value text,
  created_by uuid, created_at timestamptz default now(), primary key (inbox_id, kind, value)
);

-- AI knowledge (from chatbot-main, re-keyed from tenant_id to inbox_id):
-- kb_sources(inbox_id, kind url|sitemap|file|faq, status, last_crawled_at), chunks(inbox_id, content, metadata, embedding vector(1536))
```
RLS: agent-side tables readable by workspace members with inbox membership; public widget endpoints use service role through SQL functions that take explicit `p_inbox_id` + `p_visitor_id` (never trust a client-sent inbox id without origin + token check).

---

## 11. AI assistant (from chatbot-main)

- **Modes per inbox:** Off · AI first (default when enabled) · AI only outside business hours.
- **Knowledge:** website crawl (sitemap or start URL, depth, include/exclude patterns), uploaded files (PDF, DOCX, TXT, MD), FAQ Q&A pairs, Shopify catalogue (existing polki scraper path). Re-crawl schedule (weekly default), per-source status and chunk counts, "test the assistant" playground in settings.
- **Pipeline (existing):** query rewrite (HyDE + history) → hybrid retrieval (dense + BM25, RRF, rerank) → page-context gating → tiered grounding prompt → streamed answer → citation verification. Keep chatbot-main's guardrails: answer only from sources for brand facts; clarify on low confidence; refuse off-topic politely.
- **Handoff to a human** (creates/marks conversation `open`, assigns per rules, notifies):
  - visitor clicks "Talk to a person" or says so (intent detection);
  - low-confidence / tier-3 refusal twice in a row;
  - configured keywords/intents (e.g. pricing quote, meeting, complaint);
  - N AI turns without resolution (default 6);
  - visitor is a linked lead in an active sequence (setting "hand leads straight to a human", default on).
  Outside business hours, handoff collects email and promises a reply time.
- **Agent takeover:** as soon as an agent sends a message, AI stops answering in that conversation; "Let AI continue" toggle to hand back.
- **Metrics:** AI-resolved conversations (resolved without human message), handoff rate, 👍/👎, top unanswered questions (for new FAQ entries).
- **Cost control:** each AI answer consumes 1 AI action from the workspace pool (pricing plan); per-visitor hourly cap; when the pool is exhausted, AI switches off and the widget behaves as live chat (never errors to the visitor).

---

## 12. Settings catalogue (Settings → Websites → {inbox})

### 12.1 General
Website name · domain(s) / allowed domains · inbox collaborators · auto-assignment (on/off, capacity per agent) · widget on/off · reply mailbox for continuity · client (agency workspaces).

### 12.2 Appearance (separate tabs for **Desktop** and **Mobile**, live preview beside)
Widget background colour · chat background colour · accent colour (validated hex; derived shades as in chatbot-main) · font · bot/brand name (≤ 20) · widget image/logo (50×50) · bot avatar (50×50) · welcome heading (≤ 50) · welcome tagline (≤ 50) · theme light/dark/auto · display mode · z-index (default 2147483000) · custom CSS (advanced).

### 12.3 Launcher & popup
Type icon/button · size S/M/L · position left/right · margins bottom/side · button message (≤ 20) · show unread count · show unread previews · popup: enable, text (≤ 60), image (50×50), delay (s), position.

### 12.4 Messages
Greeting message (sent as first bot message on open, toggle) · reply-time text (few minutes / hours / a day / none) · available message · unavailable message · email-capture prompt · end-of-chat message · quick-reply chips (conversation starters).

### 12.5 Pre-chat form
§5.5.

### 12.6 Availability
Business hours, timezone, holidays, hide widget outside hours, show agent offline status.

### 12.7 Features
File picker · emoji picker · restart conversation · end conversation · allow messages after resolved · lock to single conversation · sounds · read receipts · show agent names/avatars · transcript by email.

### 12.8 CSAT
Enable, scale (emoji 5-point / thumbs), ask for comment, send by email when visitor has left.

### 12.9 Email continuity
§9.3.

### 12.10 AI assistant
Mode, knowledge sources, handoff rules, persona/brand prompt (chatbot-main `system_prompt`), allowed topics, test playground.

### 12.11 Targeting & campaigns
URL rules, device rules, country rules, identified-only, campaigns list.

### 12.12 Security
Allowed domains, enforce identity validation + HMAC token (reveal/regenerate), rate limits (advanced), block list, Turnstile on/off, consent mode.

### 12.13 Installation
Snippet, platform guides, verify install, SDK reference link.

All settings changes are versioned (`settings_history`) and take effect on next `widget-config` fetch (≤ 5 min cache); "Publish now" busts cache via a config version bump.

---

## 13. APIs and realtime

### 13.1 Public widget endpoints (Edge Functions, `verify_jwt=false`, origin + website token checks, CORS per inbox)
| Endpoint | Purpose |
|---|---|
| `GET /widget-config?token=` | Settings, locale strings, availability now, config version (from chatbot-main `widget-config`) |
| `POST /visitor` | Create/restore visitor → visitor JWT |
| `POST /visitor/identify` | `setUser` with HMAC verification + merge |
| `PATCH /visitor/attributes` | custom attributes, labels |
| `POST /page-view` | page tracking (batched, beacon on unload) |
| `GET /conversations` / `POST /conversations` | list / start (with pre-chat form payload) |
| `GET /conversations/:id/messages?before=` | paginated history |
| `POST /conversations/:id/messages` | visitor message (`echo_id` for dedupe) |
| `POST /conversations/:id/typing` | typing on/off |
| `POST /conversations/:id/read` | read receipt |
| `POST /conversations/:id/resolve` | visitor ends conversation |
| `POST /conversations/:id/csat` | CSAT |
| `POST /uploads` | signed Storage upload URL (size/type checked) |
| `POST /chat` (existing) | AI streaming answer via SSE |
| `POST /feedback` (existing) | 👍/👎 on AI answers |
| `POST /transcript` | email transcript |

### 13.2 Realtime
- Supabase Realtime **broadcast** channel per conversation `webchat:{conversation_id}` with private-channel authorisation (RLS on `realtime.messages` checking the visitor JWT claim or workspace membership). Events: `message.created`, `message.updated` (read state), `typing`, `conversation.status`, `agent.presence`.
- Presence channel per inbox for agent online state; visitor heartbeat every 30 s while panel open (drives continuity "inactive" logic).
- Fallback: long-poll `GET /messages?after=` every 5 s if WebSocket fails (corporate proxies).

### 13.3 Outbound webhooks (existing mechanism)
`webchat.conversation.created`, `webchat.message.created`, `webchat.conversation.resolved`, `webchat.csat.submitted`, `webchat.visitor.identified`, `webchat.handoff`.

### 13.4 MCP
Existing inbox tools work for webchat threads (`inbox_pending`, `inbox_thread`, `inbox_send_reply`). New read tools: `webchat_inboxes_list`, `webchat_visitor_get`; write (confirmation-gated): `webchat_settings_update`, `canned_response_save`.

---

## 14. Non-functional requirements

| Area | Target |
|---|---|
| Loader size | ≤ 10 KB gzip; panel ≤ 45 KB gzip; zero third-party runtime deps |
| Launcher paint | < 100 ms after loader executes (cached config) |
| Message delivery | p95 < 500 ms visitor↔agent |
| AI first token | p95 < 1.5 s |
| Availability | 99.9% monthly for public widget API; widget degrades to "leave a message" form if API is down |
| Browsers | Last 2 versions of Chrome, Safari (incl. iOS), Firefox, Edge; Samsung Internet |
| Isolation | Shadow DOM; no global CSS; no globals except `window.kaptured` + settings |
| Scale | 10k concurrent open widgets per workspace; 1M messages/month platform-wide at launch |
| Observability | Sentry in widget (sampled, PII-scrubbed), function logs, per-inbox error rate dashboard |

---

## 15. Edge cases checklist (must be handled)

- Same visitor, two tabs → one conversation, messages sync via BroadcastChannel + Realtime.
- Visitor sends while offline (network) → queued locally with `echo_id`, sent on reconnect, no duplicates.
- Agent and AI reply at the same time → agent message wins, AI answer cancelled if not yet streamed.
- Visitor clears storage → new anonymous visitor; if they re-enter the same email, link to lead but do not expose old history (unverified).
- `setUser` called with a different identifier while a conversation is open → `reset` semantics, new session.
- HMAC token regenerated → existing identified sessions keep working until token expiry, new `setUser` calls must use new hash.
- Inbox domain changed → old origins rejected immediately; warn in settings.
- Widget installed on two sites with one token → second origin rejected unless in allowed domains.
- Business hours cross midnight / DST change → computed in inbox timezone with a tz library.
- Conversation resolved while visitor typing → message reopens (or new conversation per setting).
- Attachment upload fails midway → retry, no orphan message.
- Continuity email to an address that hard-bounces → stop continuity for that visitor, mark email invalid, show in contact panel.
- Visitor replies by email after the conversation is resolved → reopens.
- Visitor is also a lead in an active sequence → first visitor message stops sequences; agent sees outreach context.
- Blocked visitor → widget shows no error, messages silently dropped server-side (logged).
- Host page with `transform` on `body` or aggressive CSS resets → Shadow DOM + fixed positioning tested; sidebar push mode disabled when host layout incompatible.
- Host page CSP blocks WebSocket → long-poll fallback.
- RTL languages → mirrored layout, launcher position respected.
- Very long messages, emoji-only messages, pasted HTML → sanitised plain text.
- AI credits exhausted mid-conversation → silent switch to human mode with email capture.

---

## 16. Plans and pricing tie-in

| | Core | Pro | Agency |
|---|---|---|---|
| Website inboxes | 1 | 3 | Unlimited (one per client workspace) |
| Live chat, email continuity, CSAT, canned responses | Yes | Yes | Yes |
| AI assistant | Uses AI actions pool | Yes | Yes |
| Identity validation, SDK, webhooks | SDK basic (open/close/setUser without enforcement) | Full | Full |
| Proactive campaigns | — | Yes | Yes |
| Remove "Powered by" | — | Yes | Yes (white-label domain for standalone page) |

Web chat adds no Unipile cost; AI answers are the only variable cost and draw from the existing AI actions allowance and packs.

---

## 17. Rollout

| Phase | Scope |
|---|---|
| P0 | Port chatbot-main loader + panel into the platform repo; `webchat_inboxes`, visitors, token + origin checks; live chat into unified inbox with Realtime; basic settings (name, colours, welcome, position); install snippet + verify |
| P1 | Full appearance (desktop/mobile), launcher types, popup, pre-chat form, business hours, reply time, offline email capture, file/emoji, read receipts, typing, canned responses, assignment + capacity, notes, labels, snooze |
| P2 | Email continuity both ways (native email transport), transcript, CSAT, notifications (push + email), search, contact panel with lead linking + outreach timeline |
| P3 | AI assistant integration (RAG from chatbot-main re-keyed to inbox), knowledge sources UI, handoff rules, AI metrics, credit accounting |
| P4 | SDK complete (identity enforcement, attributes, events, trackEvent), targeting rules, proactive campaigns, webhooks, reports (volume, first response time, resolution time, CSAT, AI resolution), SLA |
| P5 | Live visitors list, Slack integration, agent reply-by-email, standalone white-label domain, more locales |

---

## 18. Metrics

Conversations started (by source: launcher, popup, campaign, SDK), visitor→lead conversion, first response time (median/p90), resolution time, CSAT average + response rate, AI-resolved %, handoff %, continuity emails sent / replied, conversations that stopped an active sequence, widget load errors.

---

## 19. Test plan highlights

- Install on: plain HTML, WordPress, Shopify, Webflow, Next.js (app router), Astro, a strict-CSP page.
- Visual regression of all modes × light/dark × LTR/RTL × desktop/mobile.
- Accessibility audit (axe + manual screen reader: VoiceOver iOS/macOS, NVDA).
- Load test: 10k concurrent widgets, 500 messages/s.
- Security: HMAC bypass attempts, origin spoofing (server-side checks only), XSS payloads in every text field, attachment polyglots, rate-limit evasion by rotating visitors.
- Continuity: offline → email → email reply → widget history on return, across Gmail/Outlook clients.

---

## 20. Open questions

1. Product namespace for the SDK global (replace `kaptured`).
2. Do we need the platform inbound domain (`reply.<domain>`) at launch, or require a connected reply mailbox for continuity? (Current: mailbox required in P2; inbound domain later.)
3. Should AI answers count 1 AI action each, or have a separate web-chat AI allowance per plan?
4. Keep chatbot-main's 5 modes all at launch, or ship bubble + drawer + embedded first?
