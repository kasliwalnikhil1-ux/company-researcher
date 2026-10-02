// deno test --no-config --allow-env --allow-net --allow-read supabase/functions/_shared/outreach/webchat_test.ts
// The code side of product recommendations: the budget read from a question, the prompt blocks, the model's picks turned
// into cards. webchat.ts builds a database client at load, so the two settings it reads get a stand-in.
import { assert, assertEquals } from "jsr:@std/assert@1";
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test");
const { buildAnswerPrompt, extractPriceFilter, fmtMoney, parseAnswer, pickCards, stripCardLinks } = await import("./webchat.ts");
type AiContext = import("./webchat.ts").AiContext;
type Recommendation = import("./webchat.ts").Recommendation;

const pf = (q: string) => { const r = extractPriceFilter(q, "INR"); return [r.min ?? null, r.max ?? null, r.rest]; };

Deno.test("extractPriceFilter: under / below / between / around, lakh, k, cr, symbols", () => {
  assertEquals(pf("Show me polki necklaces under 1 lakh"), [null, 100000, "Show me polki necklaces"]);
  assertEquals(pf("anything below $50?"), [null, 50, "anything ?"]);
  assertEquals(pf("rings between 20k and 40k"), [20000, 40000, "rings"]);
  assertEquals(pf("between 20 and 40k please"), [20000, 40000, "please"]);
  assertEquals(pf("earrings from ₹5,000 to ₹12,500"), [5000, 12500, "earrings"]);
  assertEquals(pf("bangles 10k-25k range"), [10000, 25000, "bangles range"]);
  assertEquals(pf("under 5000"), [null, 5000, ""]);
  assertEquals(pf("necklace above Rs. 2 lakhs"), [200000, null, "necklace"]);
  assertEquals(pf("sets over 1.5 cr"), [15000000, null, "sets"]);
  assertEquals(pf("a gift around 10,000"), [8000, 12000, "a gift"]);
  assertEquals(pf("my budget is 75k, what do you suggest"), [null, 75000, "my , what do you suggest"]);
  assertEquals(pf("upto 2L for a bridal set"), [null, 200000, "for a bridal set"]);
  assertEquals(pf("at least 3 lac"), [300000, null, ""]);
  assertEquals(pf("less than ₹999 anklets"), [null, 999, "anklets"]);
  assertEquals(pf("a 50k budget for earrings"), [null, 50000, "a for earrings"]);
});

Deno.test("extractPriceFilter: numbers that are not money are left alone", () => {
  assertEquals(pf("can you deliver in under 5 days?"), [null, null, "can you deliver in under 5 days?"]);
  assertEquals(pf("a chain of more than 20 inches"), [null, null, "a chain of more than 20 inches"]);
  assertEquals(pf("is it over 22 carats"), [null, null, "is it over 22 carats"]);
  assertEquals(pf("what is your return policy"), [null, null, "what is your return policy"]);
  assertEquals(pf("order 10452 is late"), [null, null, "order 10452 is late"]);
  assertEquals(pf(""), [null, null, ""]);
});

const ctx = (o: Partial<AiContext> = {}): AiContext => ({
  ok: true, workspace_id: "w", inbox_id: "i", visitor_id: "v", brand: "Aurum", persona: null, allowed_topics: null, show_sources: true, knowledge_source_ids: [], low_confidence_streak: 2,
  recent_low: 0, query: "show me polki necklaces under 1 lakh", page_url: null, history: [], pool: { ok: true }, online: false, visitor_email: null,
  products: { sources: ["s"], max: 2, include_oos: false, show_prices: true, add_to_cart: false, currency: "INR" }, ...o,
});
const rec = (): Recommendation => ({
  current: { id: "c0", title: "Kundan Necklace Set", price: 96000, currency: "INR", url: "https://aurum.shop/products/kundan", available: true, product_type: "Necklace", tags: ["kundan"], description: "Hand set kundan." },
  found: [
    { id: "a1", title: "Polki Choker Set", price: 45000, compare_at: 52000, currency: "INR", url: "https://aurum.shop/products/polki-choker-set", image: "https://cdn/a.jpg", available: true, variant_id: "9002", product_type: "Necklace", tags: ["bridal", "polki"], description: "Uncut diamond choker with matching earrings. ".repeat(10), score: 1.2 },
    { id: "b2", title: "Jadau | Earrings", price: 18500, currency: "INR", url: "https://aurum.shop/products/jadau-earrings", available: false, product_type: "Earrings", tags: [] },
    { id: "c3", title: "Plain Band", url: "https://aurum.shop/products/band", available: true },
  ],
  search: { q: "show me polki necklaces", max_price: 100000, found: 3 },
});

Deno.test("buildAnswerPrompt: PRODUCTS and CURRENT PRODUCT blocks, the product rules, the wider JSON reply", () => {
  const p = buildAnswerPrompt(ctx(), [], { url: "https://aurum.shop/products/kundan", title: "Kundan", text: "page text" }, rec(), "Selected text on the page: \"22k gold\"");
  assert(p.system.includes("P1 | Polki Choker Set | ₹45,000 (was ₹52,000) | in stock | Necklace · bridal, polki | Uncut diamond choker"));
  assert(p.system.includes("P2 | Jadau Earrings | ₹18,500 | out of stock | Earrings | "));   // a "|" in a name cannot break the row
  assert(p.system.includes("P3 | Plain Band | price on request | in stock | - | "));
  assert(p.system.includes("CURRENT PRODUCT") && p.system.includes("Kundan Necklace Set | ₹96,000 | in stock | Necklace · kundan | Hand set kundan."));
  assert(p.system.includes("at most 2, best match first") && p.system.includes("Do not write prices, links or product lists in the answer") && p.system.includes("ask one question to narrow it down") && p.system.includes("Never mention discounts or stock"));
  assert(p.system.includes(`"products": [ids], "shopping": boolean`) && p.system.includes("the APPROVED ANSWERS, the PRODUCTS and the PAGE CONTEXT"));
  assert(p.user.includes("Where the question was asked") && p.user.includes("22k gold") && p.user.endsWith("Visitor: show me polki necklaces under 1 lakh"));
  // the description is cut to 160 characters: twelve rows stay small
  const twelve = buildAnswerPrompt(ctx(), [], null, { ...rec(), found: Array.from({ length: 12 }, () => rec().found[0]) });
  assert(twelve.system.length < 6500, String(twelve.system.length));
  // a button that names a product is the CURRENT PRODUCT block, not a quoted context
  assert(!buildAnswerPrompt(ctx({ context: "product:polki-choker-set" }), [], null, rec()).user.includes("Where the question was asked"));
});

Deno.test("buildAnswerPrompt: a website without recommendations gets the prompt it always had", () => {
  const p = buildAnswerPrompt(ctx({ products: null }), [], null);
  assert(!p.system.includes("PRODUCTS") && !p.system.includes("shopping") && p.system.includes(`"used_sources": [numbers]}`));
  assert(p.system.includes("Answer only from the SOURCES, the APPROVED ANSWERS and the PAGE CONTEXT"));
  assertEquals(p.user, "Visitor: show me polki necklaces under 1 lakh");
});

Deno.test("parseAnswer + pickCards: unknown ids are dropped, the limit holds, a refusal shows nothing", () => {
  const a = parseAnswer(`{"answer":"The Polki Choker Set fits.","confidence":"high","handoff":false,"used_sources":[],"products":["P2","p1","P9","P1","x","P3"],"shopping":true}`);
  assertEquals([a.products, a.shopping], [["P2", "P1", "P9", "P3"], true]);
  const cards = pickCards(a.products, rec(), 2, a.confidence);
  assertEquals(cards.map((c) => c.id), ["b2", "a1"]);
  assertEquals(cards[1], { id: "a1", title: "Polki Choker Set", price: 45000, compare_at: 52000, currency: "INR", url: "https://aurum.shop/products/polki-choker-set", image: "https://cdn/a.jpg", available: true, variant_id: "9002" });
  assertEquals(Object.keys(cards[0]).sort(), ["available", "currency", "id", "price", "title", "url"]);   // catalogue data only: no score, no description
  assertEquals(pickCards(["P1"], rec(), 3, "refused"), []);
  assertEquals(pickCards(["P1"], null, 3, "high"), []);
  assertEquals(pickCards(["P7", "P0", "PX"], rec(), 3, "high"), []);
  assertEquals(pickCards(["P1", "P2", "P3"], rec(), 9, "high").length, 3);
  // the model answered in broken JSON: the picks are still read
  const b = parseAnswer(`{"answer": "Here you go", "confidence": "high", "handoff": false, "products": ["P1", "P3"], "shopping": true, "used_sources": [1,`);
  assertEquals([b.answer, b.products, b.shopping], ["Here you go", ["P1", "P3"], true]);
  const c = parseAnswer(`{"answer":"We offer 30 days returns.","confidence":"high","handoff":false,"used_sources":[1]}`);
  assertEquals([c.products, c.shopping], [[], false]);
});

Deno.test("stripCardLinks: links to a recommended product leave the answer, other links stay", () => {
  const cards = pickCards(["P1"], rec(), 3, "high");
  assertEquals(stripCardLinks("See the [Polki Choker Set](https://www.aurum.shop/products/polki-choker-set?utm=x) or our [returns](https://aurum.shop/returns).", cards),
    "See the Polki Choker Set or our [returns](https://aurum.shop/returns).");
  assertEquals(stripCardLinks("It is here: https://aurum.shop/products/polki-choker-set/. More: https://aurum.shop/faq", cards), "It is here: More: https://aurum.shop/faq");
  assertEquals(stripCardLinks("No cards, https://aurum.shop/products/polki-choker-set stays", []), "No cards, https://aurum.shop/products/polki-choker-set stays");
});

Deno.test("fmtMoney", () => {
  assertEquals([fmtMoney(100000, "INR"), fmtMoney(49.9, "USD"), fmtMoney(1200, null), fmtMoney(5, "XXY").replace(/ /g, " "), fmtMoney(null, "INR")], ["₹1,00,000", "$49.90", "1,200", "XXY 5", ""]);
});
