# PRD: Voice for the website assistant (ElevenLabs Agents)

**Builds on:** web chat as built: `web-chat-PRD.md`, `docs/outreach/WEBCHAT.md`, migrations 048–053 / 062 / 065 / 068, `web-chat-buttons-products-changes.md` and the AI hub (063).
**Goal:** website visitors can **talk** to the same assistant they can already type to. It uses the same knowledge, Q&A, products and handover to a person, and every call lands in the unified inbox. Customers set everything up inside our app and never open ElevenLabs.
**Migration:** `069_webchat_voice.sql`.
**Docs read:** ElevenLabs Agents docs, 1 Oct 2026. Items the docs don't state are marked **(confirm)** and listed in §17.

---

## 0. Summary

| # | What | How |
|---|---|---|
| 1 | Visitors can type **and** speak | A mic in our existing widget opens a call view. No second widget |
| 2 | Powered by ElevenLabs Agents | One ElevenLabs agent per website, created and updated by our backend through the API |
| 3 | Same knowledge | The voice agent calls **our** knowledge, Q&A and product search as tools. Nothing is copied to ElevenLabs, so edits apply at once |
| 4 | Customers customise it in our app | Voice, language(s), instructions, greeting, call length, privacy, and the call view's look and wording |
| 5 | Test in the app | A test panel talks to a separate **test agent** that holds the unpublished settings, and shows tool calls and timings |
| 6 | Handover | The existing handoff rules (keywords, "talk to a person", leads in a sequence, out of hours) apply to calls. The call **switches to our text chat** in the same conversation, and a teammate takes over there |
| 7 | Inbox | The live transcript appears in the conversation during the call. After the call, the signed ElevenLabs transcript, recording, summary and collected details replace the live copy |
| 8 | Products | Spoken recommendations post the same product cards into the chat while the agent talks |
| 9 | Billing | Voice minutes per plan, from our ElevenLabs account. A customer can connect their own ElevenLabs key to have no cap from us |

**Not in v1:** phone numbers / telephony; a person joining the call by voice (teammates reply in text after the switch); voice cloning inside our app (a voice cloned in the customer's own ElevenLabs account works with their key, §12); video avatars.

---

## 1. Key decisions

| Decision | Choice | Why |
|---|---|---|
| Widget | **Our widget**, with ElevenLabs' JS SDK (`@elevenlabs/client`) loaded only when a call starts. ElevenLabs' own `<elevenlabs-convai>` widget is not used | One conversation, one inbox, our branding, handover, product cards and own-button triggers all keep working. The ElevenLabs widget would be a second, separate chat |
| Typed messages | Answered by **our existing text assistant**, as today. **During a call**, typed text goes into the call (`sendUserMessage`) and the agent answers it out loud | Text stays on the pipeline that already has Review mode, citations and products, and costs no voice minutes |
| Knowledge | **Webhook tools** that call our search. ElevenLabs' knowledge base is not used | One source of truth with nothing to sync. It avoids ElevenLabs' RAG storage caps (1 MB on Free up to 1 GB on Business, shared by all customers on our account), and Q&A edits and product prices are live |
| Fast answers | The website's Q&A pairs (up to 30, 8,000 chars) are written into the agent's prompt at each sync. Everything else goes through the tool | Common questions get answered with no tool call at all |
| Auth | `platform_settings.auth.enable_auth = true`. Our backend mints a **conversation token** (`GET /v1/convai/conversation/token`) per call, after our own website-token and Origin checks | ElevenLabs' allowlist allows only 10 hostnames per agent, and the docs say not to combine it with signed URLs. Our checks are already per website |
| Transport | WebRTC (the SDK default for voice) | It gives the best audio and echo handling |
| Overrides | Only `agent.language` can be overridden by the client. Every other override stays **off** | With overrides on, a visitor could change the prompt from the browser console |
| Draft vs live | Two agents per website: **live** (published settings) and **test** (draft settings) | Testing never changes what visitors hear, and it needs no branch or merge logic |
| Accounts | Our **platform ElevenLabs account** by default. A workspace can **bring its own key** | This matches how LLM keys already work (`outreach_workspace_secrets`) |

---

## 2. Visitor experience

### 2.1 Starting a call

| Where | Element |
|---|---|
| Home view | A second card under "Send us a message": **🎙 Talk to us**, with an optional line such as *"Speak with our AI assistant"* |
| Composer | A mic button next to send. While the box is empty the send button **is** the mic, WhatsApp-style. Typing turns it back into send |
| Own buttons (from `web-chat-buttons-products-changes.md`) | `data-growthxai="call"` and `growthxai.call()` start a call directly |
| Launcher | Optional "Voice first" launcher text, e.g. *"Talk to us"*. Clicking it opens the panel straight into the call view |

**First call on a device:** a consent sheet appears once per visitor, stored as `gxwc:<token>:voice_ok`.

> *You'll be speaking with an AI assistant. The call may be recorded and transcribed to help us reply.* [Privacy policy] **[Start call]** · Not now

The wording is set per website. "May be recorded" is dropped automatically when recording is off.

Then:
1. The browser asks for the microphone (the click counts as the user gesture iOS needs).
2. The widget calls `POST /conversations/:id/voice/start` and loads `voice.js`.
3. `Conversation.startSession({ conversationToken, connectionType: 'webrtc', dynamicVariables, overrides: { agent: { language } }, clientTools, useWakeLock: true })` runs.
4. The agent says the greeting.

### 2.2 Call view (inside the panel)

```
┌─────────────────────────────────────┐
│ ←  Polki Stories            ⋯   ✕   │
│                                     │
│              ◉ ◉ ◉                  │  orb in the accent colour, moves with the voice
│             Listening…              │  Listening · Thinking · Speaking · Muted
│                                     │
│  You: do you ship to Dubai?         │  live captions (toggle), last 3 turns
│  AI: Yes — we ship to the UAE in    │
│      5–7 days. Want the charges?    │
│  ┌────────┐ ┌────────┐              │  product cards / forms posted during the call
│  │ card   │ │ card   │              │
│  └────────┘ └────────┘              │
│  [ type instead…            ]  ➤   │  typed text goes into the call
│                                     │
│   🔇 Mute     ⌨ Switch to chat    ⏹ End │
└─────────────────────────────────────┘
```

- **Captions** come from the SDK's `onMessage` (`role: user | agent`). Agent captions stream when `agent_chat_response_part` is enabled (§5.3). They're on by default, can be toggled, and use `aria-live="polite"`.
- **Interruptions:** the visitor can talk over the agent. ElevenLabs handles barge-in.
- **Typing while in a call:** keystrokes call `sendUserActivity()` so the agent waits, and Enter calls `sendUserMessage(text)`.
- **Switch to chat:** this ends the voice session and keeps the conversation. The thread shows the whole call as messages, with the composer focused. A **🎙 Continue by voice** chip at the bottom starts a new call with the recent chat passed in (§5.4).
- **End:** ends the session and shows *"Call ended · 3:12"* in the thread, with "Continue by voice" and the normal composer.
- **Mobile:** full-screen call view and screen wake lock. The call ends if the tab is hidden for 60 s, with a toast when the visitor comes back.
- **Errors:** each one ends with the visitor in text chat, and voice never blocks chat.

  | Error | What the visitor sees |
  |---|---|
  | Mic denied | *"Microphone is blocked. Allow it in your browser's site settings, or keep typing."* The thread opens |
  | No minutes left / voice off / busy | *"Voice isn't available right now. You can keep chatting here."* and a switch to chat |
  | Connection lost mid-call | One automatic retry with a new token. Then a switch to chat with the transcript kept |

### 2.3 What a call can do

The agent can do everything the text assistant does, by voice:
- Answer from the website's knowledge and Q&A.
- Recommend products: the cards appear in the thread while it talks.
- Take the visitor's details: phone or name by voice, email through the existing email form.
- Hand over to a person (§6).
- End the call when the visitor is done (`end_call`).

---

## 3. Settings: AI Website Chatbots → {website} → **Voice** (new tab)

```
Voice                                                        [● On ]
Let visitors talk to your assistant. Uses the same knowledge, Q&A and products as chat.

VOICE           [ Sarah · warm, conversational  ▶ ]   [ Change ]
                Speed  0.7 ━━━━●━━━ 1.2      Steadier ●━━━━━━━ More expressive
LANGUAGES       English (main)  + Hindi  + Arabic   [ + Add ]     ☑ Switch when the visitor speaks another language
                ☐ Reply in Hinglish when speaking Hindi
GREETING        "Hi! I'm the Polki Stories assistant — what are you looking for today?"   (per language ▾)
INSTRUCTIONS    Uses the assistant's persona and topics from AI assistant ›
                Voice only:  [ Keep answers to 2 sentences. Offer to text links instead of reading them. ]
CALL LENGTH     Up to [5] minutes · End after [20] s of silence
ANSWERS         Model: ( • ) Fast   (   ) Smartest     Thinking sound while searching: [typing ▾]
DETAILS TO COLLECT  ☑ Name  ☑ Phone  ☑ What they need  ☐ Budget      (saved on the visitor and lead)
PRIVACY         ☑ Keep call recordings · keep for [30] days · Consent text [ edit ]
CALL VIEW       Start button "Talk to us" · Orb colours [accent] [#c7a3ff] · Avatar [logo ▾]
                Labels: Listening… / Speaking… / End call · Captions on by default ☑
                Show "Talk to us" on: ☑ Home  ☑ Composer mic  ☐ Launcher text

[ Test voice ]  Draft saved · Live agent updated 2 min ago ✓          Minutes this month: 212 / 500
```

| Setting | Stored as `settings.voice.*` | ElevenLabs field it sets (§5.1) | Default / limits |
|---|---|---|---|
| On/off | `enabled` | (creates / archives the agent) | Off |
| Voice | `voice_id`, `voice_name` | `tts.voice_id` | A warm premade voice, chosen per main language |
| Speed | `speed` | `tts.speed` | 1.0 (0.7–1.2) |
| Steadier ↔ expressive | `stability` | `tts.stability` (one slider; `similarity_boost` is fixed at 0.8) | 0.5 (0–1) |
| Main language | `language` | `agent.language` | The website's default locale |
| More languages | `languages[]` | `language_presets{code: {overrides, first_message_translation}}` | Max 10 |
| Switch on detection | `auto_language` | `built_in_tools.language_detection` | On when there are 2+ languages |
| Hinglish | `hinglish` | `agent.hinglish_mode` | Off. Shown only when Hindi is the main language |
| Greeting | `greeting{lang: text}` | `agent.first_message` + `first_message_translation` | Up to 300 chars. The default is built from the brand name |
| Voice instructions | `instructions` | Appended to `agent.prompt.prompt` (§5.2) | Up to 2,000 chars |
| Call length | `max_minutes` | `conversation.max_duration_seconds` | 5 (1–30), capped by plan |
| Silence | `silence_end_s` | `turn.silence_end_call_timeout` | 20 s (10–120) |
| Model | `model: fast \| smart` | `agent.prompt.llm`, through a server-side map in `outreach_flags.voice_llm_models` so model names can change without a migration | Fast |
| Thinking sound | `tool_sound` | `tool_call_sound` on our tools | `typing`, or none |
| Details to collect | `collect[]` | `platform_settings.data_collection` (§7.3) | name, phone, need |
| Recording | `record` | `privacy.record_voice` | On |
| Retention | `retention_days` | `privacy.retention_days` | 30 (1–365) |
| Consent text | `consent_text` | — (our widget) | See §2.1 |
| Call view | `ui{start_text, orb_1, orb_2, avatar, labels{}, captions, show_on{}}` | — (our widget) | Accent colour, brand logo |

**Shared with the text assistant**, not repeated on this tab: brand name, persona, allowed topics, knowledge sources, Q&A, the products setup and handoff rules. All of these live on the existing AI assistant tab, and editing them updates both.

**Voice picker** (Change):
- **Tabs:** Recommended (a list we curate per language), Library and My voices. My voices only appears when the workspace has its own key.
- **Filters:** language, gender, accent and use case (conversational).
- **Each row:** ▶ preview (the voice's `preview_url`), name and description.
- **Data:** read from `GET /v2/voices` (account voices) and `GET /v1/shared-voices` (library), cached for 24 h in `outreach_flags`. Picking a library voice adds it to the account first (`POST /v1/voices/add/{public_user_id}/{voice_id}`) **(confirm whether this is needed)**.
- **Hidden:** voices with live moderation, which agents can't use.

**Publishing** works like the rest of the website settings. Saving the draft updates the **test** agent within a few seconds. **Publish** updates the **live** agent. The tab shows `Live agent updated … ✓` or the sync error with a Retry.

**Requires:**
- AI assistant mode is **AI first** or **AI outside business hours**. If the website is in **Review** mode (AI hub), voice is off with this note: *"Spoken answers can't wait for approval. Switch the assistant to Auto to use voice."*
- At least one knowledge source or 5 Q&A pairs. Otherwise there's a warning, but voice is still allowed.

---

## 4. Test inside the app

**Test voice** opens a side panel over the settings:

```
Test voice (draft settings)                         [ Reset ]   ✕
┌─────────────────────────────────────────────────────────────┐
│  ◉ Speaking…                         00:42      🔇  ⏹        │
│                                                             │
│  You       do you ship to dubai                    0.0s     │
│  🔧 search_knowledge("shipping to Dubai") → 3 results  320ms │
│  AI        Yes, we ship to the UAE in 5–7 days…    1.1s     │
│  🔧 find_products(max_price 100000) → 4 cards       410ms │
│  You       can I talk to someone                            │
│  🔧 switch_to_chat(handoff) → handed to team (offline: email form) │
└─────────────────────────────────────────────────────────────┘
[ type a message… ]                         Page context: [ /products/polki-choker ▾ ]
```

- **What it runs:** the **test agent** (draft settings), using the same widget code (`voice.js`) as visitors, so what you hear is what visitors will hear.
- **Context:** you can pick the page the visitor is "on" (for product context) and a visitor name.
- **Shown in the log:** every tool call with its input, result and our server time, the response time per turn, and handoff and form events. Tool calls come from SDK events `agent_tool_request` / `agent_tool_response`, enabled on the test agent only.
- **Not stored as a real conversation:** test calls don't create inbox conversations. They're stored in `outreach_webchat_voice_calls` with `test = true` and count toward minutes, labelled "Test" in usage.
- **Quick checks** (the P2 button **Run checks**) run 5 scripted scenarios through ElevenLabs agent tests (`POST /v1/convai/agent-testing/create` type `simulation` + `POST /v1/convai/agents/{id}/run-tests`). The scenarios are built from the website's Q&A: "asks about shipping", "asks for a product under a budget", "wants a human", "off-topic", "speaks Hindi". They show pass/fail with the agent's replies. The older simulate-conversation endpoint is not used; ElevenLabs is removing it on 31 Oct 2026.

---

## 5. The ElevenLabs agent we create

### 5.1 Create and update (`POST /v1/convai/agents/create`, `PATCH /v1/convai/agents/{agent_id}`)

`name`: `"{website name} · {workspace name}"`. `tags`: `["growthxai", "ws:<workspace_id>", "inbox:<inbox_id>", "live" | "test"]`.

```jsonc
{
  "conversation_config": {
    "agent": {
      "first_message": "<greeting in the main language>",
      "language": "<main language>",
      "hinglish_mode": false,
      "prompt": {
        "prompt": "<built, §5.2>",
        "llm": "<from voice_llm_models[model]>",
        "temperature": 0.3,
        "tool_ids": ["<search_knowledge>", "<find_products>", "<save_contact>", "<show_email_form>", "<switch_to_chat>"],
        "built_in_tools": { "end_call": {…}, "language_detection": {…} },   // language_detection only with 2+ languages
        "knowledge_base": []                                              // we don't use ElevenLabs' knowledge base
      },
      "dynamic_variables": { "dynamic_variable_placeholders": { "brand": "", "page_title": "", "page_url": "", "visitor_name": "", "recent_chat": "", "today": "" } }
    },
    "tts": { "model_id": "eleven_flash_v2 | eleven_flash_v2_5", "voice_id": "…", "speed": 1.0, "stability": 0.5, "similarity_boost": 0.8 },
    "turn": { "turn_eagerness": "normal", "silence_end_call_timeout": 20 },
    "conversation": {
      "max_duration_seconds": 300,
      "client_events": ["conversation_initiation_metadata", "user_transcript", "agent_response", "agent_response_correction",
                        "agent_chat_response_part", "interruption", "client_tool_call", "ping"]   // + agent_tool_request/response on test agents
    },
    "language_presets": { "hi": { "overrides": { "agent": { "first_message": "…" } }, "first_message_translation": {…} } }
  },
  "platform_settings": {
    "auth": { "enable_auth": true },
    "overrides": { "conversation_config_override": { "agent": { "language": true } } },
    "call_limits": { "agent_concurrency_limit": <plan>, "daily_limit": <plan>, "bursting_enabled": false },
    "queueing_config": { "enabled": false },
    "privacy": { "record_voice": true, "retention_days": 30 },
    "data_collection": { … §7.3 … },
    "evaluation": { "criteria": [ { "id": "resolved", "name": "Resolved", "type": "prompt",
                    "conversation_goal_prompt": "The visitor's question was answered or they were handed to the team." } ] },
    "guardrails": { "version": "1", "focus": { "is_enabled": true }, "prompt_injection": { "is_enabled": true } }
  }
}
```

**TTS model:**
- English only → `eleven_flash_v2`.
- Any other language → `eleven_flash_v2_5` (32 languages).
- The language list offered in settings is limited to Flash v2.5's languages.

**Sync rules:**
- We own every field listed above and always send each managed object **whole**, because PATCH merge behaviour isn't documented **(confirm)**.
- `config_hash` (sha256 of the body) is stored, so an unchanged config isn't sent again.
- **Retries:** a failed sync retries 3× with backoff from `outreach-webchat-worker`, then shows the error on the tab. The live agent keeps its last good config.
- **Voice off:** the live and test agents get `platform_settings.archived = true`, and tokens stop being minted.
- **Website deleted:** both agents are deleted (`DELETE /v1/convai/agents/{id}`), along with their tools and secrets (§5.3).
- **Concurrency and daily limits** follow the plan (§10). With `bursting_enabled: false` we never pay ElevenLabs' double burst rate. With `queueing_config.enabled: false`, a busy agent fails fast and the visitor goes to text chat instead of waiting.

### 5.2 The prompt we build

```
You are the voice assistant for {brand} on its website. You are speaking out loud, so:
- Keep answers to 1–3 short sentences. No lists, markdown, URLs or emojis. Say numbers naturally.
- If something is long (a link, steps, an address), say you'll put it in the chat and call switch_to_chat with handoff=false… (only when needed).
{persona}                                   ← AI assistant tab
Only talk about: {allowed_topics}           ← AI assistant tab
{voice instructions}                        ← Voice tab

What you know:
- For any question about {brand}'s products, services, prices, policies, shipping, hours or anything factual, call search_knowledge first
  unless the answer is in QUICK ANSWERS. Never invent facts, prices or policies. If search finds nothing, say you're not sure and offer the team.
- To suggest products, call find_products. Then mention at most 3 by name in one sentence; the cards are on the visitor's screen. Don't read prices unless asked.
QUICK ANSWERS (written by the team):
{up to 30 Q&A pairs, 8,000 chars}

Handing over (switch_to_chat with handoff=true) when the visitor: asks for a person; wants a quote, demo, meeting, refund, or has a complaint,
billing or account issue; is upset; or repeats a question you could not answer.{ + keywords from the handoff rules}
To take an email address, call show_email_form and ask them to type it — don't take emails by voice. Phone numbers and names you may take by voice; read them back.
The visitor is on: {{page_title}} ({{page_url}}). Their name: {{visitor_name}}. Earlier in this chat: {{recent_chat}}. Today is {{today}}.
When the visitor is done, say goodbye and call end_call.
```

This is built by `buildVoicePrompt()` in `_shared/outreach/voice.ts`, which reuses the text assistant's rule wording so the two behave the same.

### 5.3 Tools (created per agent with `POST /v1/convai/tools`, attached by `tool_ids`)

| Tool | Type | Parameters (LLM fills) | What happens |
|---|---|---|---|
| `search_knowledge` | webhook, `POST {tools}/knowledge` | `query` (string) | Our `outreach_knowledge_search` over the website's knowledge sources + Q&A. Returns up to 5 short passages (≤ 1,500 chars total) and `found: n`. The empty-result streak counts toward the handoff rule `low_confidence_streak` |
| `find_products` | webhook, `POST {tools}/products` | `query`, `max_price?`, `min_price?` | The same search as text chat (`outreach_product_search` + `extractPriceFilter`). **Posts a `cards` bot message into the conversation**, which reaches the widget through the existing realtime channel. Returns `P1 Polki Choker Set — ₹45,000; …` (≤ 6) for the agent to speak |
| `save_contact` | webhook, `POST {tools}/contact` | `name?`, `phone?` | Sets the visitor's name/phone (the existing identify path → lead link) |
| `show_email_form` | webhook, `POST {tools}/email-form` | `reason?` | Posts the existing email `form` message into the chat. Returns "The form is on screen" |
| `switch_to_chat` | **client** (`expects_response: false`) | `handoff` (boolean), `reason` (string) | Handled by our widget, §6 |
| `end_call` | system | — | ElevenLabs ends the session. The widget shows "Call ended" |
| `language_detection` | system | — | Only with 2+ languages |

**Webhook tool settings:**
- `response_timeout_secs: 8`, `pre_tool_speech: "auto"`, `tool_call_sound`: the setting (§3), `tool_error_handling_mode: "summarized"`, `execution_mode: "immediate"`.
- **URL:** `https://<project>.supabase.co/functions/v1/outreach-voice-tools/<path>` (new function, `--no-verify-jwt`).

**How tool calls are trusted:**
1. **Per-agent secret:** each agent gets its own ElevenLabs workspace secret (`POST /v1/convai/secrets`, a random 32-byte value). Its tools send `Authorization: Bearer <secret>` (`request_headers` → `{secret_id}`). We store only the hash and the `secret_id`. If a secret leaks, it opens only that one website's tools.
2. **Per-call session:** the session variable `secret__session` holds a 10-minute HMAC token we mint at `/voice/start`. It carries `{chat_id, visitor_id, inbox_id, el_conversation_id, exp}`. Tools send it as the header `X-GX-Session: {{secret__session}}`. Because of the `secret__` prefix, ElevenLabs never shows it to the LLM and redacts it in transcripts and webhooks. A visitor who edits it in the browser breaks the signature.
3. **Checks on every call:** our endpoint verifies both, rejects an expired session (it re-validates while the call is live, up to `max_minutes + 2` min), and rate-limits to 30 tool calls per call.

### 5.4 Starting a session

`POST /conversations/:id/voice/start` (`outreach-webchat`, with the usual website-token + Origin + visitor-token checks):

1. **Checks:** voice is on and synced; the AI mode allows AI right now; the voice pool has minutes (§10); the visitor is under the per-visitor cap (3 calls an hour by default) and has given consent; the chat isn't handed off and has no agent replying; Turnstile has passed if the website uses it; and the visitor isn't a lead in an active sequence while "hand leads straight to a human" is on. On failure it returns `{ ok: false, reason }`, and the widget stays in chat.
2. **Token:** `GET /v1/convai/conversation/token?agent_id=<live>&participant_name=<visitor short id>` returns `{ token, conversation_id }`. We store `el_conversation_id` on a new `outreach_webchat_voice_calls` row (`status = 'starting'`), which links the ElevenLabs conversation to our chat **before** the call starts.
3. **Response:** `{ conversation_token, el_conversation_id, dynamic_variables: { brand, page_title, page_url, visitor_name, recent_chat, today, secret__session }, language }`.
   - `recent_chat` holds the last 8 messages of this conversation (≤ 1,500 chars). This is how "Continue by voice" keeps context.
   - `language` is the visitor's widget locale when it's one of the agent's languages. Otherwise it's omitted.

`voice.js` (lazy, ~15–25 KB gzip + the SDK **(confirm size)**) starts the session with those values and registers `switch_to_chat` as a client tool.

---

## 6. Handover: from voice to our chat, and to a person

Every path ends the same way: **the voice session ends and the panel shows the same conversation in text chat**, with the call's transcript above.

| Trigger | Detected by | Result |
|---|---|---|
| Visitor taps **Switch to chat** | Widget | Text chat. No handoff, so the AI keeps answering by text |
| Agent decides (asks for a person, quote, complaint, upset, repeated failure) | Agent → `switch_to_chat(handoff: true, reason)` | Widget calls `POST /conversations/:id/voice/switch {handoff: true, reason}`. That runs the **existing** `outreach_webchat_v_handoff(chat, reason)`, which assigns, notifies, and posts the online / offline-email-form message. The agent first says *"I'm passing you to the team — I'll switch you to chat so they can reply."* The widget waits for that sentence to finish (`onModeChange` → `listening`, max 6 s), then ends the session |
| Agent needs to show something long (a link, an address, steps) | Agent → `switch_to_chat(handoff: false)` | Text chat. The AI's next text answer carries it |
| **Handoff keywords** from the website's rules ("pricing quote", "refund", …) | Server: each finished visitor turn is mirrored to `/voice/turns` (§7.1), and that runs the same keyword check as typed messages (`outreach_webchat_v_message` rules) | The response carries `handoff: true` → the widget runs the agent path above, with *"Let me get the team for that."* sent via `sendContextualUpdate` + `sendUserMessage`, or it ends straight away when the agent is mid-answer |
| **Low-confidence streak** (e.g. 2 searches in a row found nothing) | Server: `search_knowledge` counts empty results per call | The tool result tells the agent to offer the team. If the visitor accepts → `switch_to_chat(handoff: true, 'low_confidence')` |
| **Max AI turns** (setting `handoff.max_turns`) | Server counts mirrored agent turns | Same as keywords |
| **A teammate replies in the inbox during the call** | The widget gets the agent's message over realtime (existing) | The call ends with *"A teammate has joined — switching to chat."* The AI has stopped (existing takeover rule). Turning **"Let AI continue"** back on in the inbox makes voice available again |
| **Out of hours** | Existing availability | Handoff posts the existing offline email form in the chat, so the visitor leaves an email and gets the continuity emails as today |
| **No minutes / ElevenLabs down / busy** | `/voice/start` or an SDK error | Text chat with a notice. Never a dead end |

**Back to voice:** the visitor can tap **🎙 Continue by voice**, with the recent chat passed in. This is hidden while the chat is handed off to a person (`handed_off_at` set and not handed back), so a teammate's conversation isn't interrupted by the AI.

---

## 7. Conversations, inbox and data

### 7.1 Live transcript (during the call)

- **Buffering:** the widget sends each **final** turn from `onMessage` to `POST /conversations/:id/voice/turns` with `[{ role, text, event_id, at }]`, buffered up to 1 s, and retries until acked.
- **Storage:** turns become `outreach_messages` in the same chat:
  - Visitor turns: `direction in`, `sender_type visitor`.
  - Agent turns: `direction out`, `sender_type bot`.
  - Both: `content_attributes.voice = { call_id, event_id, live: true }`, and `source 'voice'`.
- **Mirroring** lets teammates watch the call live in the inbox, lets the existing keyword / max-turn handoff rules run, and lets "Switch to chat" show the full thread.
- **Trust:** live rows come from the browser, so they are shown as *live transcript* until the post-call webhook confirms them (§7.2). The sender's own messages can't be trusted more than typed ones anyway.
- **Dedupe:** turns are deduped on `(call_id, event_id)`.

### 7.2 After the call: post-call webhook

- **Setup:** one workspace webhook on **our** ElevenLabs account, created once at deploy (`POST /v1/workspace/webhooks`, `auth_type: hmac`). It's bound with `PATCH /v1/convai/settings` (`webhooks.post_call_webhook_id`, events `transcript`) and has retries **on**.
- **Receiver:** the new function `outreach-elevenlabs-webhook`. It verifies `ElevenLabs-Signature` with the SDK's `constructEvent` and dedupes on `conversation_id + event_timestamp`.
- **Matching:** `data.conversation_id` → `outreach_webchat_voice_calls.el_conversation_id`. Unknown ids are logged and dropped, and so are test calls (stored only on the call row).
- **Steps:**
  1. **Replace** the call's live rows with the authoritative `data.transcript[]`. Each turn becomes a message (`live: false`, `time_in_call_secs`). Tool turns aren't shown as messages, and product cards and form messages stay. One transaction, so the inbox never shows both versions.
  2. **Update the call row:** `status = 'done'`, `duration_s` (`metadata.call_duration_secs`), `cost_credits` (`metadata.cost`), `cost_usd` (`metadata.cost_fiat`), `termination_reason`, `main_language`, `summary` (`analysis.transcript_summary`), `title` (`analysis.call_summary_title`), `successful` (`analysis.call_successful`), `collected` (`analysis.data_collection_results`), and `has_audio`.
  3. **Collected details** (name, phone, need, budget) are written onto the visitor, and the lead when it's linked, following the rules for visitor attributes (they never overwrite a value the visitor typed).
  4. **Minutes** are added to the pool (§10).
  5. **Event:** `webchat.voice_call.ended` goes through the existing outbound-webhook mechanism.
- **Missed webhook:** a worker job (`outreach-webchat-worker`, every 5 min) fetches `GET /v1/convai/conversations/{id}` for calls still `in_progress` / `ended_unconfirmed` 10 min after they ended, and runs the same steps.

### 7.3 Data collection (ElevenLabs `platform_settings.data_collection`)

These items are built from the "Details to collect" setting (§3).

| id | type | description given to ElevenLabs |
|---|---|---|
| `visitor_name` | string | "The visitor's name if they said it" |
| `visitor_phone` | string | "The visitor's phone number in international format if they gave it" |
| `need` | string | "In one sentence, what the visitor wanted" |
| `budget` | string | "The budget the visitor mentioned, with currency" |

### 7.4 Inbox

- **Call card:** a call shows as a card in the thread at the point it started:
  `🎙 Voice call · 3:12 · ended by visitor · ▶ recording · Summary: Asked about shipping to Dubai and polki chokers under ₹1L; left phone.`
  The turns sit under it with a small 🎙 mark.
- **Recording:** played through our proxy `GET outreach-api /voice-calls/:id/audio`, which streams `GET /v1/convai/conversations/{el_id}/audio` after a workspace and client visibility check. Audio isn't stored by us. It's gone when ElevenLabs' retention removes it, and the player then says *"Recording expired."*
- **Conversation list:** a 🎙 icon on conversations that had a call. The `source` filter gets `voice`.
- **Teammates reply in text.** The widget has already switched to chat (§6).
- **AI hub:**
  - **Activity** lists each agent turn of a call under the feature *Website assistant* with where = website, marked 🎙.
  - **Needs you:** voice never appears (it's Auto only).
  - **Knowledge → Unanswered questions:** `search_knowledge` calls that found nothing are added with origin `website`.
- **MCP:**
  - `webchat_get_conversation` includes voice turns and the call card fields.
  - `webchat_voice_calls_list(inbox_id?, from?, to?)` is a new read tool.
  - The voice settings can be read; changing them goes through the app only (v1).

---

## 8. Widget code

| File | Change |
|---|---|
| `loader.js` | `growthxai.call()`; `data-growthxai="call"`; the "Voice first" launcher text; preloads `voice.js` on hover of a call button |
| `chat.js` | Home card + composer mic; consent sheet; call view (orb, status, captions, mute, switch, end, type-in-call); the `/voice/start`, `/voice/turns`, `/voice/switch`, `/voice/end` calls; handoff and takeover switching; error states; `voice:*` events |
| `voice.js` (new, lazy) | Bundles `@elevenlabs/client`; `startSession` with token, dynamic variables, language and the `switch_to_chat` client tool; maps SDK callbacks (`onConnect`, `onDisconnect`, `onMessage`, `onModeChange`, `onStatusChange`, `onError`, `onAgentChatResponsePart`) to the panel; `getOutputByteFrequencyData()` drives the orb |
| SDK events (new) | `voice:started {call_id}`, `voice:ended {call_id, duration_s, reason}`, `voice:switched {handoff}`, `voice:error {code}`. Also sent as `growthxai:voice:*` window events |
| CSP | The Installation tab lists what a strict CSP needs once voice is on: `connect-src` for `api.elevenlabs.io` and the WebRTC/LiveKit hosts, `media-src blob:`, and `worker-src blob:` / `workletPaths` for the SDK's audio worklets **(confirm exact hosts)** |

**Accessibility:**
- Every control is a labelled button, and the call view traps focus like the panel does.
- Captions are on by default for screen-reader users, and the status ("Listening", "Speaking") is announced.
- `Esc` ends the call only after a confirm.

---

## 9. Backend

| Piece | Kind | What |
|---|---|---|
| `_shared/outreach/elevenlabs.ts` | shared | API client (`xi-api-key`, regional host, retries on 429/5xx): agents create/patch/delete/archive, tools create/update/delete, secrets create/delete, conversation token, conversations get/audio, voices (`/v2/voices`, `/v1/shared-voices`, add voice), agent tests. Resolves the key: platform `OUTREACH_ELEVENLABS_API_KEY` or the workspace's own (§12) |
| `_shared/outreach/voice.ts` | shared | `buildAgentConfig(settings, published)`, `buildVoicePrompt`, `syncVoiceAgent(inboxId, which: 'live' \| 'test')`, `mintSession`, `verifyToolRequest` |
| `outreach-webchat` | existing, public | New routes: `POST /conversations/:id/voice/start`, `POST …/voice/turns`, `POST …/voice/switch`, `POST …/voice/end`. Config response gains `voice: { enabled, ui, languages, consent_text, record }` (no ids) |
| `outreach-voice-tools` | **new**, public (`--no-verify-jwt`) | `POST /knowledge`, `/products`, `/contact`, `/email-form`. Each checks the per-agent secret + session token and replies in < 1 s typical |
| `outreach-elevenlabs-webhook` | **new**, public | Post-call webhook (§7.2) |
| `outreach-voice-admin` | **new**, user JWT | For the app: `GET /voices`, `GET /voices/library?…`, `POST /voices/add`, `POST /inboxes/:id/voice/sync`, `POST /inboxes/:id/voice/test-session` (token for the **test** agent; manager), `POST /inboxes/:id/voice/run-checks`, `GET /voice-calls/:id/audio` |
| `outreach-webchat-worker` | existing | Sync retries; missed-webhook fetch; usage roll-up |
| Publish hook | existing settings publish | Syncs the live agent after the website's settings publish; a draft save syncs the test agent (debounced 3 s) |

---

## 10. Minutes, plans and cost

**What a call costs us** on the platform account (ElevenLabs pricing, Oct 2026):
- ~$0.08 per minute after the plan's included minutes, plus the LLM tokens, billed on top per model.
- Silence over 10 s is billed at 5% of the minute rate.
- Burst minutes are double, which is why we turn bursting off.
- Each webhook gives the real cost (`metadata.cost_fiat`), so we know the margin per call.

| | Core | Pro | Agency |
|---|---|---|---|
| Voice | Add-on only | 100 min / month | 300 min / month |
| Extra | Voice packs: 100 / 500 / 2,000 min | same | same |
| Max call length | 5 min | 10 min | 30 min |
| Calls at the same time (per workspace) | 2 | 5 | 10 |
| Own ElevenLabs key | — | Yes (no minute cap from us; their bill) | Yes |

The numbers are placeholders to tune against margin. They live in the billing plan features (`voice_minutes`, `voice_max_minutes`, `voice_concurrency`), not in code.

**The pool:** `outreach__voice_pool(ws)` mirrors `outreach__ai_pool`. It returns `{used, limit, own_key, ok}` from the month's `outreach_webchat_voice_calls.duration_s` (rounded up per call, test calls included).
- **Before each call:** `/voice/start` refuses when it isn't `ok`. A call that starts with less than `max_minutes` left gets `max_duration_seconds` lowered for that session **(only if the duration override is allowed; otherwise the call keeps its limit and the pool may run slightly over — accepted)**.
- **When minutes run out:** the mic and Talk-to-us card hide on the next config refresh and the chat continues by text. Owners get the same notices as for the AI actions pool (80% and 100%).

**Concurrency across all customers:** every customer on the platform account shares one ElevenLabs concurrency limit (e.g. Business: 40 voice calls).
- Per-agent `agent_concurrency_limit` = the plan's value.
- A platform-wide guard in `/voice/start` counts live calls (`status in ('starting','in_progress')`, ≤ 15 min old) and refuses above `outreach_flags.voice_platform_concurrency`.
- The visitor gets *"Voice is busy — keep chatting here."* Ops are alerted at 80% of the platform limit.

---

## 11. Privacy and consent

- **Consent:** the consent sheet (§2.1) appears before the first call, and is also stored on the visitor (`voice_consent_at`).
- **Recordings:** "Keep call recordings" maps to `record_voice`, and retention maps to `retention_days`. With recording off, the inbox shows the transcript and summary, with no player.
- **Transcripts:** they stay in our database under the workspace's normal data rules. Deleting a conversation in our app also deletes it at ElevenLabs (`DELETE /v1/convai/conversations/{id}`).
- **Visitor erasure:** `outreach_webchat` visitor deletion and GDPR erase delete their ElevenLabs conversations the same way.
- **Data residency** (EU/India) needs ElevenLabs Enterprise residency workspaces, which are separate accounts and API hosts. It's not in v1. The API client takes a host per account so it can be added (§17).
- **Sub-processor:** ElevenLabs is added to the workspace's sub-processor list and the privacy page template.

---

## 12. Bring your own ElevenLabs key (Pro / Agency)

Settings → AI → Keys gets a field: *ElevenLabs API key*. We verify the key with `GET /v2/voices?page_size=1` and an agents list call, and check that it can create agents.

With a workspace key:
- **Where things live:** that workspace's agents, tools, secrets and voices live in the customer's ElevenLabs account.
- **My voices:** includes their cloned voices.
- **No minute cap:** the pool isn't used, though the plan's concurrency still applies.
- **Webhook:**
  1. We try to create our post-call webhook in their account (`POST /v1/workspace/webhooks` + `PATCH /v1/convai/settings`). This needs an admin key.
  2. If that fails, we set it per agent with `platform_settings.workspace_overrides.webhooks` **(confirm the field shape)**.
  3. If that also fails, the worker fetches each call after it ends (§7.2). That works, just later.
- **Switching keys:** switching platform → own key, or back, recreates both agents in the new account on the next publish, then deletes the old ones. Past calls keep their transcripts, but their recordings stay in the old account and expire there.
- **Storage:** the key is stored encrypted in `outreach_workspace_secrets` (`elevenlabs_key_enc`, `elevenlabs_key_hint`) through `outreach-workspace-secrets`, as with LLM keys.

---

## 13. Data (`069_webchat_voice.sql`)

```sql
alter table outreach_workspace_secrets
  add column if not exists elevenlabs_key_enc  text,
  add column if not exists elevenlabs_key_hint text;

create table if not exists outreach_webchat_voice_agents (
  inbox_id       uuid not null references outreach_webchat_inboxes(id) on delete cascade,
  which          text not null check (which in ('live','test')),
  workspace_id   uuid not null references outreach_workspaces(id) on delete cascade,
  account        text not null default 'platform' check (account in ('platform','own')),
  el_agent_id    text,
  el_tool_ids    jsonb not null default '{}',      -- {search_knowledge: "...", find_products: "...", ...}
  el_secret_id   text,                             -- ElevenLabs workspace secret used in tool headers
  tool_secret_hash text,                           -- sha256 of that secret; we verify against this
  config_hash    text,
  synced_at      timestamptz,
  sync_error     text,
  sync_attempts  int not null default 0,
  archived       boolean not null default false,
  primary key (inbox_id, which)
);

create table if not exists outreach_webchat_voice_calls (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references outreach_workspaces(id) on delete cascade,
  inbox_id           uuid not null references outreach_webchat_inboxes(id) on delete cascade,
  chat_id            uuid references outreach_chats(id) on delete set null,      -- null for test calls
  visitor_id         uuid references outreach_webchat_visitors(id) on delete set null,
  el_conversation_id text not null unique,
  el_agent_id        text not null,
  test               boolean not null default false,
  status             text not null default 'starting'
                     check (status in ('starting','in_progress','ended_unconfirmed','done','failed')),
  started_at         timestamptz not null default now(),
  ended_at           timestamptz,
  ended_reason       text,              -- visitor | agent_end_call | switch | handoff | takeover | silence | max_duration | error
  duration_s         int,
  cost_credits       int,
  cost_usd           numeric(10,4),
  language           text,
  summary            text,
  title              text,
  successful         text,              -- success | failure | unknown
  collected          jsonb not null default '{}',
  tool_calls         int not null default 0,
  empty_searches     int not null default 0,   -- the low-confidence streak counter
  has_audio          boolean not null default false,
  handoff_reason     text
);
create index if not exists outreach_webchat_voice_calls_ws_idx    on outreach_webchat_voice_calls(workspace_id, started_at desc);
create index if not exists outreach_webchat_voice_calls_chat_idx  on outreach_webchat_voice_calls(chat_id, started_at);
create index if not exists outreach_webchat_voice_calls_live_idx  on outreach_webchat_voice_calls(status) where status in ('starting','in_progress','ended_unconfirmed');
alter table outreach_webchat_voice_agents enable row level security;   -- managers read their workspace's rows
alter table outreach_webchat_voice_calls  enable row level security;   -- members read, with client visibility like chats

alter table outreach_webchat_visitors add column if not exists voice_consent_at timestamptz;
```

**Functions:**
- `outreach_webchat__settings_check`: validates `voice.*` (§3 limits, ISO language codes from a list, hex colours, text lengths).
- `outreach_webchat_public_config`: adds the public `voice` subset.
- `outreach_webchat_v_voice_start(p_visitor, p_chat)` / `_v_voice_turns(p_call, p_turns jsonb)` / `_v_voice_switch(p_call, p_handoff, p_reason)` / `_v_voice_end(p_call, p_reason)`: service-only, with the same ownership re-checks as the other `_v_` functions. `_v_voice_turns` returns `{handoff, reason}` from the shared keyword / max-turn logic.
- `outreach_webchat_v_voice_finalize(p_el_conversation, p_payload jsonb)`: the webhook / poll steps in §7.2, in one transaction.
- `outreach__voice_pool(p_ws)`.
- `outreach_hub_voice_calls(p_ws, p_inbox, p_from, p_to, p_limit, p_offset)`: the reports and calls list. Uses an `outreach_hub_*` name because of the grant-loop gotcha.

**Settings defaults:** add a `voice` block to the website settings defaults (051/053 pattern), with every key from §3 and `enabled: false`.

---

## 14. Reports

Website chatbot report → **Voice**:
- Calls, minutes, average length, calls per 100 visitors.
- % switched to chat, % handed to a person (by reason), % ended by the agent / visitor / silence / limit.
- Resolved % (ElevenLabs evaluation), details collected (name / phone), and leads created from calls.
- Top questions asked by voice, and unanswered ones.
- Languages used.
- Cost: minutes used of the plan. Owners also see USD cost from `cost_usd` on own-key workspaces.

---

## 15. Rollout

| Phase | Scope |
|---|---|
| V0 (internal) | Platform account set up: webhook created and bound, retries on, the `voice_llm_models` flag, concurrency guard. Agent sync, tools, call view, live mirror, webhook finalize, handover paths. Tried on our own site |
| V1 (beta) | Voice tab, voice picker, test panel, minutes, inbox call card + recording proxy, reports. Pro / Agency, opt-in |
| V2 | Run checks (agent tests), own ElevenLabs key, voice packs, MCP voice tools, launcher "voice first", languages beyond 3 |
| Later | Data residency (EU/India), phone numbers, a person joining a call by voice |

**Deploy order:**
1. Apply `069`.
2. Set the secrets `OUTREACH_ELEVENLABS_API_KEY` and `OUTREACH_ELEVENLABS_WEBHOOK_SECRET`.
3. Deploy the functions `outreach-voice-tools`, `outreach-elevenlabs-webhook`, `outreach-voice-admin`, `outreach-webchat`, `outreach-webchat-worker` and `outreach-mcp`. The three new public ones use `--no-verify-jwt`.
4. Run `scripts/outreach-elevenlabs-setup.mjs`, which creates and binds the workspace webhook once, the same way `bootstrap-webhooks` does for Unipile.
5. Deploy the app, which carries `voice.js`.
6. Update `docs/outreach/WEBCHAT.md` with a "Voice" section, and add voice to the `web-chat.md` skill.

---

## 16. Tests

**Agent sync**
- Enable → live and test agents are created with tags, tools, the secret, `enable_auth`, only the language override, the client events, no bursting and no queueing.
- Draft save → only the test agent changes. Publish → the live agent changes. Same config → no PATCH (hash).
- Off → both archived. Website deleted → both deleted, along with tools and secrets.
- ElevenLabs 5xx → retries, then the error shows on the tab, and the live agent keeps its old config.

**Start**
- Allowed → a token is minted, the call row stores `el_conversation_id`, and the session variable can't be read by the LLM.
- Blocked when:
  - Review mode, pool empty or voice off
  - the chat is handed off or the visitor is in a sequence
  - more than 3 calls an hour
  - the platform concurrency guard is full

  In every blocked case the widget stays in chat.

**Tools**
- `search_knowledge` returns website sources + Q&A only, with nothing from another website or workspace.
- `find_products` posts a cards message that shows in the widget during the call, and its spoken summary has ≤ 6 items.
- A wrong secret → 401. A changed session token → 401. An expired session → 401. More than 30 calls → 429.
- Two empty searches → the tool result offers the team.

**Handover**
- The agent calls `switch_to_chat(handoff:true)` → the existing handoff message and assignment, the call ends after the agent's sentence, and the panel shows the chat.
- A keyword turn ("I want a refund") → handoff.
- A teammate replies during the call → the call ends with the notice.
- Out of hours → the email form shows in the chat.
- "Continue by voice" is hidden while a teammate holds the chat.

**Transcript**
- Live turns show in the inbox during the call, are deduped on retry, and are replaced by the webhook transcript in one transaction.
- Summary, duration, cost and collected phone are saved, and the phone lands on the visitor/lead.
- A missed webhook → the worker fetches it after 10 min.
- The webhook signature is verified, and a bad signature gets 401.
- A duplicate webhook → a no-op.

**Widget**
- Mic denied, connection lost (one retry), and switching mid-sentence.
- Typing in a call → `sendUserMessage`, and the agent answers aloud.
- Mobile full screen + wake lock.
- Keyboard-only use, with captions announced.
- Strict-CSP page with the listed hosts.
- iOS Safari, Android Chrome, desktop Chrome/Safari/Firefox/Edge.

**Test panel**
- It uses the test agent, its calls don't appear in the inbox, they count as test minutes, and tool calls are shown with timings.

**Minutes**
- The pool counts rounded minutes including tests, the mic hides at 0, and notices go out at 80% / 100%.
- A workspace on its own key has no cap.

---

## 17. Not stated in the ElevenLabs docs — check during the build

| Item | Plan if it differs |
|---|---|
| Conversation token lifetime | Mint just before `startSession`, which we do anyway |
| PATCH merge vs replace for nested objects/arrays | We send managed objects whole |
| Whether a library voice must be added to the account before an agent can use it | Always call add-voice when one is picked |
| WebRTC / LiveKit hosts for the CSP list | Read them from a real session and put them on the Installation tab |
| `@elevenlabs/client` bundle size in `voice.js` | Lazy load means it never affects page load |
| Per-agent webhook override shape (`workspace_overrides.webhooks`) for own-key accounts | Polling fallback (§12) |
| Whether `max_duration_seconds` can be lowered per session without turning on its override | Keep the agent limit; the pool may run slightly over |
| Default LLM per agent / exact model ids | We always set `llm` from our flag map |

**Sources (ElevenLabs docs, read 1 Oct 2026):**
- Agents API: [create](https://elevenlabs.io/docs/api-reference/agents/create), update and get
- [Authentication](https://elevenlabs.io/docs/eleven-agents/customization/authentication) and the conversation token
- [JavaScript SDK](https://elevenlabs.io/docs/eleven-agents/libraries/java-script)
- [Chat mode](https://elevenlabs.io/docs/agents-platform/guides/chat-mode)
- [Widget](https://github.com/elevenlabs/skills/blob/main/agents/references/widget-embedding.md)
- [Overrides](https://elevenlabs.io/docs/eleven-agents/customization/personalization/overrides)
- Customisation: dynamic variables, tools (webhook / client / system), knowledge base & RAG, voice & language, LLM
- Workflows: post-call webhooks, conversations API, privacy & retention, agent testing & versioning
- Pricing: elevenlabs.io/pricing/agents
