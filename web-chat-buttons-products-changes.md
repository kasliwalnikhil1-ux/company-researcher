# Change PRD: Web chat — your own buttons, Ask AI buttons, product recommendations

**Applies to:** web chat as built from `web-chat-PRD.md`. That includes `docs/outreach/WEBCHAT.md` with the 1 Oct updates, migrations 048–053, 062 and 065, and the AI hub (063, Website assistant Review mode).
**Goal:**
1. The chat can stay completely hidden and open only from buttons the customer designs on their own site, with no JavaScript needed.
2. Add "Ask AI" buttons in useful places: the site header, next to page elements and on selected text.
3. The assistant recommends products from the site's catalogue as cards, like chatbot-main's carousel. The cards are built from real catalogue data, never from AI-written text.

**Migration:** `068_webchat_buttons_products.sql`. 066 and 067 are used by `ai-fields-json-changes.md`; if those aren't applied yet, use the next free number.

---

## 0. Summary

| # | Change |
|---|---|
| 1 | Launcher & popup tab: **How visitors open the chat**, either *Our launcher* or *My own buttons*. With *My own buttons* nothing shows or opens by itself |
| 2 | No-code attributes on any element: `data-growthxai="open"`, `data-growthxai-ask="…"`, `data-growthxai-prefill="…"`, `-mode`, `-context`, plus `data-growthxai-unread` for a badge |
| 3 | Links that open the chat: `?gx=open`, `?gx_q=…`, `#ask-ai` |
| 4 | New tab **Ask AI buttons**: a header button, buttons next to page elements, Ask AI on selected text, and ⌘K in any mode |
| 5 | **Product catalogue**, a new kind of knowledge source: Shopify, WooCommerce, product feed, CSV, or products found while crawling the website |
| 6 | The assistant recommends 1–6 products as **cards** with image, name, price, View, Ask about this, and Add to cart (Shopify) |
| 7 | **Product-aware:** on a product page, or from a button that names a product, it suggests similar or matching items |
| 8 | Agents see the cards in the inbox, can send products from compose, and can remove cards from a Review draft |
| 9 | Reports: recommendations shown, clicks, add-to-carts, top products, and questions with no matching product |

**Already built, unchanged:** the six shells (bubble, drawer, sidebar, modal, inline, embedded). The SDK's `open`, `close`, `toggle`, `setMode`, `send(text, {prefill})`, `toggleBubbleVisibility` and `setLabel`. `hideMessageBubble` and the "Hide the launcher" switch. URL targeting rules, the `cards` message type with its renderer, `outreach_webchat_events`, and page context on AI answers.

**No new AI cost:** a recommendation is part of the same single AI call that already writes the answer.

---

## 1. How visitors open the chat (setting)

At the top of AI Website Chatbots → {website} → **Launcher & popup**, the "Hide the launcher" switch is replaced by:

```
How visitors open the chat
( • ) Our launcher        The floating button (today)
(   ) My own buttons      No floating button. The chat opens only when a visitor
                          clicks a button or link on your site.
                          [ Show me the code ]
```

| With *My own buttons* | |
|---|---|
| Hidden | Launcher, video bubble, popup nudge, unread preview cards |
| Campaigns | Don't open the chat. A new switch, *"Let campaigns open the chat"*, is off by default |
| Agent replies while closed | They show on the visitor's own badge element (`data-growthxai-unread`, §2) and fire the `unread` SDK event. The chat never pops open |
| Stored as | `launcher.hide = true` (existing key) + `launcher.campaigns_open` (new, default `false`) |

*Show me the code* opens the Installation tab at the new **Use your own button** card (§2.4).

---

## 2. Your own buttons (no JavaScript)

### 2.1 Attributes

These go on any element: a `<button>`, a link, an image or a div.

| Attribute | What a click does |
|---|---|
| `data-growthxai="open"` | Opens the chat |
| `data-growthxai="close"` / `"toggle"` | Closes / toggles it |
| `data-growthxai-ask="Do you ship to Dubai?"` | Opens the chat and sends this question as the visitor |
| `data-growthxai-prefill="I'd like a quote for "` | Opens the chat with this text in the message box, not sent |
| `data-growthxai-mode="sidebar"` | Opens in this shell (`bubble`, `drawer`, `sidebar`, `modal`, `inline`). It lasts until the page reloads |
| `data-growthxai-context="product:{{ product.handle }}"` | Background for the AI on the question this click starts. The visitor doesn't see it. `product:<handle\|sku\|url>` names a catalogue product (§6.2). Any other text up to 500 chars is passed as-is |
| `data-growthxai-label="pricing-page"` | Adds a conversation label (the existing `setLabel`) |
| `data-growthxai-unread` | We keep this element's text set to the unread count. It also gets `data-count="3"` and is hidden (`hidden` attribute) at 0, so the customer can style a badge |

**Forms and inputs** (an "Ask AI anything" box in their own design):

| Markup | What happens |
|---|---|
| `<form data-growthxai="ask-form"> <input name="q"> <button>Ask</button> </form>` | On submit, the first text input's value is sent as the question. The page doesn't submit and the input is cleared |
| `<input data-growthxai="ask-input">` | Enter sends the value. Shift+Enter does nothing special |

**State the customer can style:**
- While the chat is open, `<html>` has the class `growthxai-open`.
- Every `data-growthxai="open|toggle"` element gets `aria-expanded="true|false"` and `aria-haspopup="dialog"`.

### 2.2 Behaviour

- **One listener:** a delegated `click` + `submit` listener on `document`, in `loader.js`. Elements added later (single-page apps, popups, carts) work without any extra call.
- **Lazy loading:** a click before `chat.js` has loaded goes through the existing call queue, and `chat.js` loads right away. A click before `/config` has answered is queued. It's dropped silently if the site turns out not to be allowed, with one `console.warn` naming the reason.
- **Customer handlers win:** if the page's own handler called `preventDefault()`, we do nothing. We call `preventDefault()` ourselves only on links and submit buttons we handle, so the page doesn't navigate or submit.
- **Sources:** conversations started this way get `source = 'button'`. Others are `'ask'`, `'input'`, `'link'`, `'header_button'`, `'element_button'` and `'selection'` (§3–§4). The `source` column already exists and has no check constraint.
- **Video bubble:** with *Our launcher*, these attributes also work alongside the launcher. Customers can do both.

### 2.3 SDK additions

| Method / event | |
|---|---|
| `growthxai.open({ mode })` | `open()` takes an optional mode |
| `growthxai.ask(text, { context, mode, prefill, label })` | The same as `data-growthxai-ask` from code. `prefill: true` = prefill instead of send |
| Event `trigger` | `{ kind: 'button' \| 'ask' \| 'input' \| 'link' \| 'header_button' \| 'element_button' \| 'selection' \| 'shortcut', text? }`, fired before the chat opens |

### 2.4 Installation tab: "Use your own button" card

The card has copy buttons for these snippets:

```html
<!-- any element -->
<button data-growthxai="open">Chat with us</button>

<!-- ask a question -->
<a href="#" data-growthxai-ask="What's your return policy?">Returns question?</a>

<!-- badge on your button -->
<button data-growthxai="open">Help <span data-growthxai-unread></span></button>

<!-- search-style box -->
<form data-growthxai="ask-form"><input name="q" placeholder="Ask AI anything"><button>Ask</button></form>
```

```liquid
{%- comment -%} Shopify product page {%- endcomment -%}
<button data-growthxai-ask="Is this good for a wedding?"
        data-growthxai-context="product:{{ product.handle }}">Ask about this piece</button>
```

```jsx
// React / Next.js
<button onClick={() => window.growthxai?.ask('Do you ship to Dubai?')}>Shipping?</button>
```

There's also a Webflow / Framer note: add the attribute under the element's Custom attributes.

---

## 3. Links that open the chat

For emails, ads, QR codes and other pages:

| Link | What happens |
|---|---|
| `https://site.com/any-page?gx=open` | Opens the chat after load |
| `…?gx_q=Do%20you%20do%20custom%20sizes%3F` | Opens with the question **pre-filled, never auto-sent**, so a link can't send messages on a visitor's behalf. Max 300 chars |
| `<a href="#ask-ai">` on their own page | Opens the chat (the same as `data-growthxai="open"`) |

The loader removes `gx` and `gx_q` from the address bar with `history.replaceState`, so a refresh or a shared link doesn't reopen the chat. These links work in both launcher modes. The source is `'link'`.

---

## 4. Ask AI buttons we place for you

There's a new tab, AI Website Chatbots → {website} → **Ask AI buttons**. Everything here is configured in the app and needs no code on the site.

```
Ask AI buttons                                               [ + Add button ]
┌──────────────────────────────────────────────────────────────────────────┐
│ Header button        "Ask AI"   header nav · end      all pages       ⋮ │
│ Next to an element   "Ask about this product"  .product-form · after     │
│                       /products/*                                     ⋮ │
└──────────────────────────────────────────────────────────────────────────┘
Ask AI on selected text        [on]   Area: main, article    Label: Ask AI
Keyboard shortcut ⌘K / Ctrl+K  [on]
[ Test on my site ]
```

### 4.1 Button settings

Each website can have up to 10 buttons.

| Field | Header button | Next to an element |
|---|---|---|
| Where | CSS selector, default `header nav, header` | CSS selector (required) |
| Position | Start / End of that element | Before / After / Inside (end) |
| Label | Up to 30 chars, default "Ask AI" | Up to 30 chars, default "Ask AI" |
| Style | Filled (accent colour) · Outline · Text · **Match my site** | same |
| Icon | On/off (sparkle) | same |
| Click | Open | Open · Ask *question* · Prefill *text* |
| Context | — | None · This page · This product (auto-detected, §6.2) |
| Opens in | Shell, default **Sidebar** on desktop (Mintlify-style). On mobile it's always full screen, like today | same, default = the website's shell |
| Pages | URL rules, the same editor and rule shape as Targeting | same |

**How it's injected (`loader.js`):**
- **Filled / Outline / Text:** a `<span>` host with a closed shadow root holding our button, styled with constructable stylesheets like the launcher. The customer's CSS can't break it.
- **Match my site:** a plain light-DOM `<button class="growthxai-ask">` with only the label and icon, so their own button CSS applies. The class is documented on the card.
- **Single-page apps:** a `MutationObserver` (debounced 500 ms) re-places a button when its target re-renders. An element already carrying `data-growthxai-placed="<button id>"` is never given a second button. `onRouteChange()` (existing) re-checks the URL rules.
- A selector that matches nothing places nothing, with no error.
- A selector that matches more than 20 elements places buttons on the first 20, with one `console.warn`.

### 4.2 Ask AI on selected text

- When it's **on**, selecting 3 or more words inside the area (default `main, article`) shows a small "Ask AI" chip just above the selection. The chip lives in a shadow root and is positioned from `getSelection().getRangeAt(0).getBoundingClientRect()`.
- **Click:** the chat opens with *Explain this: "…"* pre-filled (first 200 chars). The full selection, up to 600 chars, goes along as context.
- **Hidden** inside inputs and textareas, on our own widget, and on a selection of fewer than 3 words. The chip disappears on scroll, on Escape, or when the selection collapses.
- **Default:** off.

### 4.3 Keyboard shortcut

- ⌘K / Ctrl+K toggles the chat in **any** shell. Today this works only in `modal`.
- **Default:** on for `modal`, off otherwise.
- It isn't bound while focus is in an input, textarea or contenteditable that the page itself uses for ⌘K, i.e. when the page called `preventDefault` first.

### 4.4 Test on my site

The button opens the site's URL with `?gx_debug=1`, which outlines every matched target and logs which buttons were placed and which selectors matched nothing. The flag lasts for the tab session only.

---

## 5. Product catalogue

AI → **Knowledge** gets a fourth kind, **Product catalogue**, next to Websites, Documents and Q&A. Each website's AI settings pick the catalogues it uses, the same way they pick knowledge sources today.

### 5.1 Sources

| Source | What the user gives | How we read it |
|---|---|---|
| **Shopify store** | Store URL | Public `/products.json?limit=250&page=n`. No app install. We get title, description, images, variants (id, price, compare-at, available, SKU, options), product type, tags and vendor |
| **WooCommerce** | Store URL | Public Store API `/wp-json/wc/store/v1/products?per_page=100&page=n` |
| **Product feed** | Feed URL | Google Merchant XML (RSS/Atom with `g:` fields) or a CSV/TSV feed with Google Merchant column names |
| **CSV upload** | A file (template downloadable) | Columns: `id, title, description, link, image_link, price, sale_price, currency, availability, brand, product_type, tags` |
| **From my website crawl** | A switch on an existing *Website* source: "Also find products" | Pages with JSON-LD `@type: Product`, or `og:type=product` + `og:price:amount`, become products. This covers most other platforms |

- **Sync timing:** a catalogue syncs when added, then every `refresh_days` (default **1** for catalogues), plus a **Sync now** button.
- **Removed products:** a product missing from a complete sync is marked `deleted_at`. It is never offered again, but old chat cards still render from their saved copy (§6.4).
- **Limits:** up to 10,000 products per catalogue, with 50 variants and 10 images kept per product. Requests are polite: 1 request per second per store.
- **Shopify stores that block `/products.json`:** the source shows *"This store doesn't share its product list publicly. Use its Google Shopping feed or a CSV instead."*
- **Status:** shown on the source card like other knowledge sources (`pending / crawling / ready / error`), plus the product count and last sync time.
- **Currency:** taken from the source (Shopify `/meta.json` or `/cart.js` currency, feed price suffix, CSV `currency`). The user can override it on the card.

### 5.2 Product page in the app

Clicking a catalogue shows a simple searchable table: image, title, price, in stock, type, last seen. Each row has two actions:
- **Hide from AI**, which sets `ai_hidden`.
- **Pin for…**, a few keywords. A pinned product is boosted for questions that contain those words, e.g. a bestseller for "gift".

There's no product editing; the store is the source of truth.

---

## 6. How the assistant recommends

### 6.1 Flow inside `POST /chat` (`outreach-webchat`)

This runs only when the website has at least one catalogue and **Recommend products** is on (§7).

1. **Filters from the question, in code (no AI):**
   - Max and min price: "under 1 lakh", "below $50", "between 20k and 40k", "₹", "k", "lakh/lac", "cr", "under 5000". Amounts are read in the catalogue's currency.
   - Out-of-stock products are excluded unless the website includes them.
2. **Product search:** `outreach_product_search(ws, catalogue_ids, query, filters, current_product_id, limit 12)`.
   - Full-text over title, type, tags, vendor, options and description, plus trigram on title. This is the same approach as `outreach_knowledge_search`, with no embeddings.
   - Pinned keywords get a boost. The current product's type and tags get a boost, and the current product itself is excluded.
   - With no matches on the text, it falls back to the current product's type, if there is one.
3. **Prompt** (`buildAnswerPrompt`): add a `PRODUCTS` block (one line each) and a `CURRENT PRODUCT` block when there is one.
   ```
   P1 | Polki Choker Set | ₹45,000 (was ₹52,000) | in stock | Necklace · bridal, polki | Uncut diamond choker with …(160 chars)
   ```
   New rules:
   - *Recommend only products from PRODUCTS, by id, at most {max}, best match first, and only when the visitor is looking for something to buy or asks for options.*
   - *Do not write prices, links or product lists in the answer: cards show them. Refer to products by name.*
   - *If none fits, say so and ask one question to narrow it down (budget, occasion, size).*
   - *Never mention discounts or stock that the block does not show.*
4. **JSON reply:** the reply gains `"products": ["P3","P1"]`. Ids not in the block are dropped. If the answer's confidence is `refused`, no products are shown.
5. **SSE:** a new event, `products`, carries `{ items: [card…] }` after the tokens and before `done`. The answer still streams exactly as today.

There is no extra AI call. The prompt grows by about 1–1.5k tokens when a catalogue is attached.

### 6.2 Knowing the current product

The first of these that matches wins:
1. `context = "product:<handle|sku|url>"` from a button (§2.1, §4.1) or `growthxai.ask(…, { context })`.
2. The page URL equals a product URL. The match ignores the query string, a trailing slash and `www.`, and Shopify's `/collections/<c>/products/<h>` is read as `/products/<h>`.
3. JSON-LD Product on the page. `pageContext()` in `chat.js` adds `product: { name, sku, url }` when it finds one, which is about 15 lines of code.

`POST /chat` takes `context` (≤ 500 chars) and `product` (≤ 300 chars). Both are saved on the turn.

### 6.3 Questions this handles

| Visitor | Result |
|---|---|
| "Show me polki necklaces under 1 lakh" | Up to {max} necklaces at or under ₹1,00,000, with a one-line intro |
| On a product page: "anything similar but cheaper?" | Same type and tags, price below the current one |
| "What goes with this?" (from an Ask button with product context) | Matching items: different type, overlapping tags or collection |
| "Do you have a red one?" | Matches on variant options / title / tags. If none: "Not in red. Closest is…" plus one question |
| "What's your return policy?" | Answer only, no cards |

### 6.4 What's saved

- **The answer:** the AI answer message's `content_attributes.products` holds a snapshot of each card: `{ id, title, price, compare_at, currency, url, image, available, variant_id }`. The inbox shows the same cards, and history re-renders correctly even after the store changes.
- **The turn:** `outreach_webchat_ai_turns.products` (new jsonb) holds the ids shown, for reports.
- **Review mode** (AI hub, `outreach_webchat_ai_suggestions`): the suggestion stores the same snapshot. The agent sees the cards in the suggestion and can remove one (✕) before sending.

---

## 7. Settings: Recommend products

These live under AI Website Chatbots → {website} → AI assistant, in a new **Products** section.

| Setting | Default |
|---|---|
| Recommend products | Off. It can only be switched on once a catalogue is ready |
| Catalogues | Picker (workspace catalogues) |
| Cards per answer | 3 (1–6) |
| Show prices | On |
| Include out-of-stock items | Off |
| "Add to cart" button | Off. Only offered for a Shopify catalogue whose store domain is one of this website's allowed domains |
| Add tracking to product links | On: `utm_source=growthxai&utm_medium=chat&utm_campaign=<website name>` |

These are stored as `settings.ai.products = { enabled, catalogue_ids, max, show_prices, include_oos, add_to_cart, utm }`. The public config returns only `{ enabled, show_prices, add_to_cart, utm }`, never the ids.

---

## 8. Cards in the widget

This reuses the existing `.cards` / `.cardi` renderer: a horizontal scroll-snap row, with arrows on desktop when there are 2+ cards.

```
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│   [image]    │ │   [image]    │ │   [image]    │   ‹ ›
│ Polki Choker │ │ Jadau Earring│ │ Kundan Set   │
│ ₹45,000 ₹52k │ │ ₹18,500      │ │ ₹96,000      │
│ [View] [Ask] │ │ [View] [Ask] │ │ [View] [Ask] │
│ [Add to cart]│ │ …            │ │ …            │
└──────────────┘ └──────────────┘ └──────────────┘
```

**What a card shows:**
- **Image:** 1:1, cover, lazy-loaded, `referrerpolicy=no-referrer`. A broken image shows a soft gradient with the first letter instead.
- **Title:** 2 lines max.
- **Price:** formatted with `Intl.NumberFormat(locale, { style: 'currency', currency })`, with the compare-at price struck through. There's an "Out of stock" tag only when such items are included.

**Buttons:**
- **View:** opens the product URL with UTM tags. It opens in the same tab when the product is on the current site, otherwise in a new tab.
- **Ask:** sends *"Tell me more about {title}"* with `context = product:<id>`.
- **Add to cart:** Shopify only. The widget must be running on that store's domain, and the product needs one available variant (the first available one is used).
  - The click calls `fetch('/cart/add.js', { method: 'POST', body: JSON.stringify({ items: [{ id: variant_id, quantity: 1 }] }) })`, same-origin from the page.
  - **Success:** the button shows *"Added ✓"* with a *"View cart"* link (`/cart`).
  - **Failure:** the product page opens.

**Events** (SDK + `window` CustomEvents + stored in `outreach_webchat_events`): `product:shown { ids }`, `product:clicked { id, action: 'view' | 'ask' }`, `product:added_to_cart { id, variant_id }`.

**CSP:** the Installation tab lists `img-src` for the catalogue's image hosts (e.g. `cdn.shopify.com`) once a catalogue is attached.

---

## 9. Agent side

| Where | Change |
|---|---|
| Inbox thread | AI messages with `content_attributes.products` show the cards, using the same component as `cards` messages |
| Compose (website chats only) | A **Product** button searches the website's catalogues. Picking 1–6 sends a `cards` message (existing type) built from the catalogue snapshot |
| Review mode draft | Cards are shown, each removable before sending |
| MCP | `catalogue_search(query, max_price?, catalogue_id?)` (read). `webchat_send_products(chat_id, product_ids)` (write, confirmation-gated like other sends) |

---

## 10. Reports

The existing Website chatbot report gets a **Products** block:

| Metric | Source |
|---|---|
| Answers with products / % of AI answers | `ai_turns.products` |
| Cards shown, clicks, click rate | `product:shown` / `product:clicked` events |
| Add-to-carts | `product:added_to_cart` events |
| Top recommended / top clicked products | Events joined with `outreach_products` |
| Asked for, not found | Turns where the price filter or the question found 0 products. The list shows the question with a link to the chat. Example: *"silver anklets under 2k"* → add the product or a Q&A |
| Conversations by source | Adds the new sources from §2–§4 |

---

## 11. Data (`068_webchat_buttons_products.sql`)

```sql
-- catalogues are knowledge sources
alter table outreach_knowledge_sources drop constraint if exists outreach_knowledge_sources_kind_check;
alter table outreach_knowledge_sources add constraint outreach_knowledge_sources_kind_check
  check (kind in ('website','document','text','catalogue'));
alter table outreach_knowledge_sources
  add column if not exists catalogue      jsonb,     -- {provider: shopify|woocommerce|feed|csv, url, currency, products, synced_at, complete}
  add column if not exists detect_products boolean not null default false;   -- website sources: "Also find products"

create table if not exists outreach_products (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references outreach_workspaces(id) on delete cascade,
  source_id        uuid not null references outreach_knowledge_sources(id) on delete cascade,
  external_id      text not null,                 -- Shopify product id / Woo id / feed id / page URL
  handle           text, sku text,
  url              text not null,
  title            text not null,
  description      text,                          -- plain text, ≤ 2,000 chars
  vendor text, product_type text, tags text[] not null default '{}',
  options          jsonb not null default '{}',   -- {Color:[…], Size:[…]}
  price            numeric, compare_at_price numeric, currency text,
  available        boolean not null default true,
  image_url        text, images text[] not null default '{}',
  variants         jsonb not null default '[]',   -- ≤ 50: {id, title, price, available, sku}
  pinned_keywords  text[] not null default '{}',
  ai_hidden        boolean not null default false,
  search           tsvector generated always as (
                     setweight(to_tsvector('simple', coalesce(title,'')), 'A') ||
                     setweight(to_tsvector('simple', coalesce(product_type,'') || ' ' || coalesce(vendor,'') || ' ' || array_to_string(tags,' ')), 'B') ||
                     setweight(to_tsvector('simple', coalesce(description,'')), 'C')) stored,
  seen_at          timestamptz not null default now(),
  deleted_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (source_id, external_id)
);
create index if not exists outreach_products_search_idx on outreach_products using gin (search);
create index if not exists outreach_products_title_trgm on outreach_products using gin (title gin_trgm_ops);
create index if not exists outreach_products_url_idx on outreach_products (workspace_id, lower(url));
create index if not exists outreach_products_handle_idx on outreach_products (workspace_id, handle, sku);
alter table outreach_products enable row level security;   -- same policies as outreach_knowledge_chunks

alter table outreach_webchat_ai_turns add column if not exists products jsonb not null default '[]';
alter table outreach_webchat_ai_turns add column if not exists context  text;
```

**Functions**

| Function | Notes |
|---|---|
| `outreach_product_search(p_ws, p_sources uuid[], p_query text, p_filters jsonb, p_current uuid, p_limit int)` | `security definer`, service only. Excludes `ai_hidden`, `deleted_at` and (unless `include_oos`) `available = false`. Rank = `ts_rank` + trigram similarity + pin boost + same-type/tag boost |
| `outreach_product_resolve(p_ws, p_sources, p_ref text)` | `product:<handle\|sku\|url>` or a page URL → product id, using the URL normalisation in §6.2 |
| `outreach_hub_catalogue_products(p_source, p_query, p_limit, p_offset)` | The app's table (§5.2), member-checked. Uses an `outreach_hub_*` name because of the grant-loop gotcha |
| `outreach_hub_product_set(p_id, p_ai_hidden, p_pinned_keywords)` | Manager |
| `outreach_webchat__settings_check` | Validates `launcher.campaigns_open`, `ask_buttons[]` (≤ 10; selector ≤ 200; label ≤ 30; enums; URL rules like targeting), `selection_ask`, `shortcut`, and `ai.products`. Patch it in place |
| `outreach_webchat_public_config` | Returns `ask_buttons`, `selection_ask`, `shortcut`, `launcher.campaigns_open` and the public part of `ai.products`. Patch it in place |

**Sync worker:** catalogues sync inside `outreach-ai-reply-worker`'s existing source loop, where websites are crawled. New `_shared/outreach/catalogue.ts`:
- `syncShopify`, `syncWoo`, `syncFeed` (XML + CSV), `parseCsv`, and `productsFromHtml(html, url)` (JSON-LD / OG, called from `crawlWebsite` when `detect_products` is on).
- Upserts go in batches of 200. At the end of a **complete** sync, rows with `seen_at` older than the sync start get `deleted_at`.

---

## 12. Widget code changes

| File | Change |
|---|---|
| `loader.js` | §1 suppression rules. §2 delegated listener, unread badge elements and `html.growthxai-open`. §3 link params. §4 placed buttons, selection chip, shortcut, `gx_debug`. Expected to stay under ~11 KB gzip |
| `chat.js` | `ask()`, `open({mode})`, the `trigger` event, `context`/`product` on `/chat`, the `products` SSE event, cards on AI messages with View / Ask / Add to cart, product events, and JSON-LD product in `pageContext()` |
| `outreach-webchat` `/chat` | Product search, prompt blocks, `products` in the parsed answer, and the SSE event. Also saves to `ai_turns.products/context` and the message `content_attributes.products` |
| `_shared/outreach/webchat.ts` | `buildAnswerPrompt` (PRODUCTS / CURRENT PRODUCT blocks + rules), `parseAnswer` (`products`), `extractPriceFilter(query, currency)` |
| App | Launcher & popup radio (§1), Installation card (§2.4), Ask AI buttons tab (§4), Knowledge → Product catalogue (§5), AI assistant → Products (§7), inbox cards + compose Product picker (§9), report block (§10) |

---

## 13. Rollout

1. Apply `068_webchat_buttons_products.sql`.
2. Deploy the functions: `outreach-webchat`, `outreach-ai-reply-worker`, `outreach-mcp`.
3. Deploy the Next.js app. The widget files are static, so customers get the new widget on their next page load with no snippet change.
4. Update `docs/outreach/WEBCHAT.md` with a "Widget update 3" section, and the `web-chat.md` skill (attributes, `ask()`, catalogue tools).

There is no backfill. Existing websites keep *Our launcher* and have Recommend products off.

---

## 14. Tests

**Own buttons**
- With *My own buttons*: no launcher, popup, video bubble or unread previews appear. A campaign doesn't open the chat until `campaigns_open` is on.
- `data-growthxai="open"` on an element added 5 s after load opens the chat.
- `-ask` sends the question. `-prefill` doesn't send.
- `-mode="sidebar"` opens docked.
- `-context` reaches `ai_turns.context` and never shows as a message.
- An ask-form submit doesn't navigate, sends the input and clears it.
- `data-growthxai-unread` shows the count when an agent replies while the chat is closed, and is hidden at 0.
- A page handler that calls `preventDefault()` first wins.
- A click before `/config` answers is queued and runs.
- On a non-allowed domain the click does nothing, with one warn.

**Links**
- `?gx=open` opens. `?gx_q=` pre-fills and doesn't send.
- Both parameters are removed from the URL. `#ask-ai` opens.

**Ask AI buttons**
- The header button lands at the end of `header nav`, and its shadow styles survive the page's CSS. *Match my site* gets the page's CSS.
- The element button appears only on URLs matching the rule. It's re-placed after a single-page-app re-render and never doubled. More than 20 matches → 20.
- The selection chip shows for 3+ words in `main`. It doesn't show in inputs, and it pre-fills with context.
- ⌘K works in bubble when on, and the page's own ⌘K wins.

**Catalogue**
- Shopify `products.json`: 600 products → 3 pages, variants and currency stored. A store with it blocked → the friendly error.
- Woo, an XML feed and a CSV all import. Crawl with JSON-LD finds products.
- A product removed from the store is gone after the next complete sync, and an old chat still shows its card.
- Hide from AI and pins work.

**Recommendations**
- "polki necklace under 1 lakh" → cards all ≤ 100000 in the catalogue currency.
- The model returns an unknown id → dropped.
- The answer text contains no price or link while cards are shown.
- "return policy" → no cards.
- On a product page, "similar but cheaper" → same type, lower price, excluding the current product.
- `product:<handle>` context resolves.
- Review mode: the agent removes one card and the visitor gets two.
- Add to cart on the Shopify domain → `/cart/add.js` 200 → "Added ✓". Off-domain, the button isn't shown.
- Events land in `outreach_webchat_events`, and the report counts match.

**Limits**
- 10,001st product rejected with a warning on the source.
- The prompt with 12 products stays under the token budget.
- The widget's gzip size is checked in CI.
