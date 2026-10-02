// deno test --no-config --allow-env supabase/functions/_shared/outreach/catalogue_test.ts
// The catalogue readers against canned store answers: no network, no database (the worker's `io` is a stand-in here).
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  assertPublicUrl, CatalogueError, CSV_TEMPLATE, htmlToPlain, mapShopifyProduct, mapWooProduct, parseCsv, parsePrice, productsFromCsv, productsFromFeed, productsFromHtml,
  SHOPIFY_BLOCKED, syncCatalogue, type CatalogueProduct, type SyncCursor, type SyncIo,
} from "./catalogue.ts";

const cursor = (): SyncCursor => ({ started_at: "2026-10-01T00:00:00Z", page: 1, seen: 0, rejected: 0 });
/** A database stand-in: keeps what was upserted, rejects past `cap`, records the saved cursors and every request. */
function fakeIo(routes: Record<string, (url: URL) => Response | Promise<Response>>, opts: { cap?: number; clock?: () => number; file?: string } = {}) {
  const got: CatalogueProduct[] = [], requests: string[] = [], saved: SyncCursor[] = [], batches: number[] = []; let slept = 0;
  const io: SyncIo = {
    upsert: (batch) => { batches.push(batch.length); const room = Math.max(0, (opts.cap ?? 10_000) - got.length), take = batch.slice(0, room); got.push(...take); return Promise.resolve({ upserted: take.length, rejected: batch.length - take.length }); },
    progress: (c) => { saved.push({ ...c }); return Promise.resolve(); },
    readFile: () => Promise.resolve(opts.file ?? ""),
    fetch: ((input: string | URL | Request) => {
      const u = new URL(String(input)); requests.push(u.pathname + u.search);
      const key = Object.keys(routes).find((k) => u.pathname === k || (u.origin + u.pathname) === k);
      const res = key ? routes[key](u) : new Response("not found", { status: 404 });
      return Promise.resolve(res).then((r) => { if (!r.url) Object.defineProperty(r, "url", { value: u.toString() }); return r; });
    }) as typeof fetch,
    sleep: (ms) => { slept += ms; return Promise.resolve(); },
    now: opts.clock ?? (() => 0),
  };
  return { io, got, requests, saved, batches, slept: () => slept };
}
const json = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...headers } });
const shopifyProduct = (i: number) => ({
  id: 1000 + i, title: `Necklace ${i}`, handle: `necklace-${i}`, body_html: `<p>Uncut <b>diamond</b> piece ${i}</p>`, vendor: "Aurum", product_type: "Necklace", tags: ["bridal", "polki"],
  variants: [{ id: 5000 + i, title: "Gold", sku: `N-${i}-G`, available: i % 2 === 0, price: "45000.00", compare_at_price: "52000.00" }, { id: 7000 + i, title: "Rose", sku: `N-${i}-R`, available: true, price: "46000.00", compare_at_price: null }],
  images: [{ src: `https://cdn.shopify.com/s/n${i}.jpg` }], options: [{ name: "Finish", values: ["Gold", "Rose"] }],
});

Deno.test("parsePrice: codes, symbols, decimal comma, Indian grouping", () => {
  assertEquals(parsePrice("45000.00 INR"), { amount: 45000, currency: "INR" });
  assertEquals(parsePrice("INR 45,000"), { amount: 45000, currency: "INR" });
  assertEquals(parsePrice("₹1,00,000"), { amount: 100000, currency: "INR" });
  assertEquals(parsePrice("Rs. 2,499"), { amount: 2499, currency: "INR" });
  assertEquals(parsePrice("1.299,00 EUR"), { amount: 1299, currency: "EUR" });
  assertEquals(parsePrice("1 299,00 €"), { amount: 1299, currency: "EUR" });
  assertEquals(parsePrice("49,99"), { amount: 49.99, currency: null });
  assertEquals(parsePrice("$49.99"), { amount: 49.99, currency: null });   // "$" names no currency: the catalogue's own decides
  assertEquals(parsePrice("1.299.000"), { amount: 1299000, currency: null });
  assertEquals(parsePrice(18500), { amount: 18500, currency: null });
  assertEquals(parsePrice(""), { amount: null, currency: null });
  assertEquals(parsePrice("call us"), { amount: null, currency: null });
});

Deno.test("htmlToPlain and parseCsv", () => {
  assertEquals(htmlToPlain("<p>Hand&nbsp;made &amp; <b>gold</b></p><script>x()</script><ul><li>One</li><li>Two</li></ul>"), "Hand made & gold\nOne\nTwo");
  assertEquals(parseCsv("a,b\r\n\"x, y\",\"he said \"\"hi\"\"\"\n\n1,\"two\nlines\"\n"), [["a", "b"], ["x, y", "he said \"hi\""], ["1", "two\nlines"]]);
  assertEquals(parseCsv("﻿a\tb\n1\t2", "\t"), [["a", "b"], ["1", "2"]]);
});

Deno.test("Shopify: 600 products are read in 3 pages, one request a second, with variants and the store's currency", async () => {
  const all = Array.from({ length: 600 }, (_, i) => shopifyProduct(i));
  const f = fakeIo({
    "/products.json": (u) => { const page = Number(u.searchParams.get("page")), limit = Number(u.searchParams.get("limit")); return json({ products: all.slice((page - 1) * limit, page * limit) }); },
    "/meta.json": () => json({ currency: "INR", name: "Aurum" }),
  });
  const r = await syncCatalogue({ provider: "shopify", url: "https://aurum.shop" }, cursor(), f.io, 60_000);
  assertEquals([r.done, r.complete, r.pages, r.currency, r.store, r.warning], [true, true, 3, "INR", "https://aurum.shop", null]);
  assertEquals(f.requests.filter((x) => x.startsWith("/products.json")), ["/products.json?limit=250&page=1", "/products.json?limit=250&page=2", "/products.json?limit=250&page=3"]);
  assertEquals(f.got.length, 600);
  assertEquals(f.slept(), 2000);                    // between the pages, never before the first
  assert(f.batches.every((n) => n <= 200));         // upserts in batches of 200
  const p = f.got[1];
  assertEquals([p.external_id, p.handle, p.url, p.title, p.vendor, p.product_type], ["1001", "necklace-1", "https://aurum.shop/products/necklace-1", "Necklace 1", "Aurum", "Necklace"]);
  assertEquals([p.price, p.compare_at_price, p.available, p.sku], [46000, null, true, "N-1-R"]);   // the Gold variant is sold out: the cheapest buyable one is Rose
  assertEquals(p.variants, [{ id: "5001", title: "Gold", price: 45000, available: false, sku: "N-1-G" }, { id: "7001", title: "Rose", price: 46000, available: true, sku: "N-1-R" }]);
  assertEquals([p.description, p.tags, p.options, p.image_url], ["Uncut diamond piece 1", ["bridal", "polki"], { Finish: ["Gold", "Rose"] }, "https://cdn.shopify.com/s/n1.jpg"]);
  assertEquals([f.got[0].price, f.got[0].compare_at_price], [45000, 52000]);
});

Deno.test("Shopify: a store that blocks /products.json gets the friendly error; a busy store may be tried again", async () => {
  for (const res of [() => new Response("", { status: 404 }), () => new Response("<html>Enter store password</html>", { headers: { "content-type": "text/html" } }), () => json({ errors: "nope" })]) {
    const f = fakeIo({ "/products.json": res });
    const e = await assertRejects(() => syncCatalogue({ provider: "shopify", url: "https://locked.shop" }, cursor(), f.io, 60_000), CatalogueError);
    assertEquals([e.message, e.final], [SHOPIFY_BLOCKED, true]);
  }
  const busy = fakeIo({ "/products.json": () => new Response("", { status: 503 }) });
  const e = await assertRejects(() => syncCatalogue({ provider: "shopify", url: "https://busy.shop" }, cursor(), busy.io, 60_000), CatalogueError);
  assertEquals(e.final, false);
  assertEquals(busy.requests.length, 3);   // two retries, then the worker tries again on its next run
});

Deno.test("Shopify: out of time → the cursor is saved and the next run continues from that page; a *.myshopify.com address becomes the main domain", async () => {
  const all = Array.from({ length: 600 }, (_, i) => shopifyProduct(i));
  const routes = {
    "/products.json": (u: URL) => { const page = Number(u.searchParams.get("page")); const r = json({ products: all.slice((page - 1) * 250, page * 250) }); Object.defineProperty(r, "url", { value: `https://aurum.shop/products.json?limit=250&page=${page}` }); return r; },
    "/meta.json": () => new Response("", { status: 404 }), "/cart.js": () => json({ currency: "inr" }),
  };
  let t = 0;
  const a = fakeIo(routes, { clock: () => (t += 30_000) });
  const r1 = await syncCatalogue({ provider: "shopify", url: "https://aurum-jewels.myshopify.com" }, cursor(), a.io, 20_000);
  assertEquals([r1.done, r1.cursor.page, r1.cursor.seen, r1.cursor.store, r1.cursor.currency], [false, 2, 250, "https://aurum.shop", "INR"]);
  assertEquals(a.saved.length >= 1, true);
  assertEquals(a.got[0].url, "https://aurum.shop/products/necklace-0");
  const b = fakeIo(routes);
  const r2 = await syncCatalogue({ provider: "shopify", url: "https://aurum-jewels.myshopify.com" }, r1.cursor, b.io, 60_000);
  assertEquals([r2.done, r2.complete, r2.cursor.seen], [true, true, 600]);
  assertEquals(b.requests, ["/products.json?limit=250&page=2", "/products.json?limit=250&page=3"]);   // page 1 and the currency are not read again
});

Deno.test("limit: the product past the catalogue's size is rejected and the source gets a warning", async () => {
  const f = fakeIo({ "/products.json": () => json({ products: Array.from({ length: 5 }, (_, i) => shopifyProduct(i)) }), "/meta.json": () => json({ currency: "USD" }) }, { cap: 4 });
  const r = await syncCatalogue({ provider: "shopify", url: "https://aurum.shop" }, cursor(), f.io, 60_000);
  assertEquals([r.done, r.complete, r.cursor.seen, r.cursor.rejected], [true, true, 4, 1]);
  assertEquals(r.warning, "1 product was left out: a catalogue holds 10,000 products at most.");
});

Deno.test("WooCommerce: Store API pages, prices in minor units, categories and attributes", async () => {
  const item = (i: number) => ({
    id: 200 + i, name: `Silk Saree &amp; Blouse ${i}`, slug: `silk-saree-${i}`, permalink: `https://weaves.in/product/silk-saree-${i}/`, sku: `SS-${i}`, short_description: "<p>Pure silk.</p>",
    prices: { price: "1250000", regular_price: "1500000", sale_price: "1250000", currency_code: "INR", currency_minor_unit: 2 }, is_in_stock: i !== 3,
    images: [{ src: `https://weaves.in/wp-content/s${i}.jpg` }], categories: [{ name: "Sarees" }, { name: "Wedding" }], tags: [{ name: "silk" }], attributes: [{ name: "Colour", terms: [{ name: "Red" }, { name: "Blue" }] }], variations: [{ id: 900 + i, attributes: [{ name: "Colour", value: "Red" }] }],
  });
  const all = Array.from({ length: 150 }, (_, i) => item(i));
  const f = fakeIo({
    "https://weaves.in/shop/wp-json/wc/store/v1/products": () => new Response("", { status: 404 }),
    "https://weaves.in/wp-json/wc/store/v1/products": (u) => { const page = Number(u.searchParams.get("page")); return json(all.slice((page - 1) * 100, page * 100), { "x-wp-totalpages": "2" }); },
  });
  const r = await syncCatalogue({ provider: "woocommerce", url: "https://weaves.in/shop" }, cursor(), f.io, 60_000);
  assertEquals([r.done, r.complete, r.pages, r.currency, f.got.length], [true, true, 2, "INR", 150]);
  const p = f.got[3];
  assertEquals([p.external_id, p.title, p.url, p.price, p.compare_at_price, p.currency, p.available], ["203", "Silk Saree & Blouse 3", "https://weaves.in/product/silk-saree-3/", 12500, 15000, "INR", false]);
  assertEquals([p.product_type, p.tags, p.options, p.description, p.variants], ["Sarees", ["Wedding", "silk"], { Colour: ["Red", "Blue"] }, "Pure silk.", [{ id: "903", title: "Red", price: 12500, available: false }]]);
  assertEquals(mapWooProduct({ id: 1, name: "x" }), null);   // no link
});

const FEED = `<?xml version="1.0"?>
<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0"><channel><title>Aurum</title><link>https://aurum.shop</link>
<item><g:id>A1-S</g:id><g:item_group_id>A1</g:item_group_id><title><![CDATA[Kundan Bangle & Ring]]></title><description>Hand set &lt;b&gt;kundan&lt;/b&gt;</description><link>https://aurum.shop/p/kundan-bangle?size=s</link>
  <g:image_link>https://cdn.aurum.shop/kb.jpg</g:image_link><g:additional_image_link>https://cdn.aurum.shop/kb2.jpg</g:additional_image_link><g:price>12000.00 INR</g:price><g:sale_price>9999.00 INR</g:sale_price>
  <g:availability>out of stock</g:availability><g:brand>Aurum</g:brand><g:product_type>Jewellery &gt; Bangles</g:product_type><g:size>S</g:size></item>
<item><g:id>A1-M</g:id><g:item_group_id>A1</g:item_group_id><title>Kundan Bangle &amp; Ring</title><link>https://aurum.shop/p/kundan-bangle?size=m</link><g:price>12000.00 INR</g:price><g:availability>in_stock</g:availability><g:size>M</g:size></item>
<item><g:id>B2</g:id><g:title>Silver Anklet</g:title><g:link>https://aurum.shop/p/silver-anklet</g:link><g:price>1,800 INR</g:price><g:availability>in stock</g:availability></item>
<item><g:id>C3</g:id><g:title>No link</g:title></item>
</channel></rss>`;

Deno.test("feed: Google Merchant XML, sale price, variants of one group folded into one product", () => {
  const rows = productsFromFeed(FEED);
  assertEquals(rows.length, 2);
  const [a, b] = rows;
  assertEquals([a.external_id, a.title, a.url, a.vendor, a.product_type, a.tags, a.description], ["A1", "Kundan Bangle & Ring", "https://aurum.shop/p/kundan-bangle?size=s", "Aurum", "Bangles", ["Jewellery"], "Hand set kundan"]);
  assertEquals([a.price, a.compare_at_price, a.currency, a.available, a.options, a.images], [12000, null, "INR", true, { Size: ["S", "M"] }, ["https://cdn.aurum.shop/kb.jpg", "https://cdn.aurum.shop/kb2.jpg"]]);   // S is sold out: the price is M's
  assertEquals(a.variants, [{ id: "A1-S", title: "S", price: 9999, available: false, sku: null }, { id: "A1-M", title: "M", price: 12000, available: true, sku: null }]);
  assertEquals([b.external_id, b.title, b.price, b.currency, b.available], ["B2", "Silver Anklet", 1800, "INR", true]);
});

Deno.test("feed and CSV through the sync: batches of 200, an Atom feed, a tab-separated feed, the upload template", async () => {
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:g="http://base.google.com/ns/1.0">${Array.from({ length: 450 }, (_, i) => `<entry><g:id>${i}</g:id><title>Item ${i}</title><link href="/p/${i}"/><g:price>${10 + i} USD</g:price></entry>`).join("")}</feed>`;
  const f = fakeIo({ "/feed.xml": () => new Response(atom, { headers: { "content-type": "application/atom+xml" } }) });
  const r = await syncCatalogue({ provider: "feed", url: "https://x.shop/feed.xml" }, cursor(), f.io, 60_000);
  assertEquals([r.done, r.complete, r.currency, f.got.length, f.batches], [true, true, "USD", 450, [200, 200, 50]]);
  assertEquals(f.got[7].url, "https://x.shop/p/7");   // a relative link is read against the feed's address

  const tsv = "id\ttitle\tlink\tprice\tavailability\n1\tBlue Kurta\thttps://x.shop/p/1\t999 INR\tin stock\n2\tRed Kurta\thttps://x.shop/p/2\t1,299 INR\tout of stock\n";
  const g = fakeIo({ "/feed.tsv": () => new Response(tsv) });
  await syncCatalogue({ provider: "feed", url: "https://x.shop/feed.tsv" }, cursor(), g.io, 60_000);
  assertEquals(g.got.map((p) => [p.title, p.price, p.available]), [["Blue Kurta", 999, true], ["Red Kurta", 1299, false]]);

  const csv = fakeIo({}, { file: CSV_TEMPLATE });
  const c = await syncCatalogue({ provider: "csv", storage_path: "ws/catalogue.csv" }, cursor(), csv.io, 60_000);
  assertEquals([c.done, c.currency, csv.got.length], [true, "INR", 1]);
  const p = csv.got[0];
  assertEquals([p.external_id, p.title, p.price, p.compare_at_price, p.currency, p.available, p.vendor, p.product_type, p.tags], ["SKU-1", "Polki Choker Set", 45000, 52000, "INR", true, "Aurum", "Necklace", ["bridal", "polki"]]);

  // a shop export: the current price in `price`, the old one in `compare_at_price`; `name` and `url` as column names
  const exp = productsFromCsv("Name;URL;Price;Compare at price;In stock\nGold Hoop;https://x.shop/p/hoop;4.500,00;5.000,00;0\n");
  assertEquals([exp[0].title, exp[0].url, exp[0].price, exp[0].compare_at_price, exp[0].available, exp[0].external_id], ["Gold Hoop", "https://x.shop/p/hoop", 4500, 5000, false, "https://x.shop/p/hoop"]);
  await assertRejects(() => syncCatalogue({ provider: "csv", storage_path: "x" }, cursor(), fakeIo({}, { file: "sku,cost\n1,2\n" }).io, 60_000), CatalogueError, "columns title and link");
  await assertRejects(() => syncCatalogue({ provider: "csv", storage_path: "x" }, cursor(), fakeIo({}, { file: "title,link\n" }).io, 60_000), CatalogueError, "No products");
});

Deno.test("crawl: products from JSON-LD (graph, offers, aggregate offers) and from Open Graph", () => {
  const ld = productsFromHtml(`<html><head><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite","name":"Aurum"},
    {"@type":"Product","name":"Jadau Earrings","sku":"JE-1","description":"<p>Bridal jadau</p>","brand":{"@type":"Brand","name":"Aurum"},"image":["/img/je.jpg","https://cdn.aurum.shop/je2.jpg"],"category":"Jewellery > Earrings",
     "offers":{"@type":"Offer","price":"18500.00","priceCurrency":"INR","availability":"https://schema.org/InStock","url":"https://aurum.shop/products/jadau-earrings?variant=1"}}]}</script>
    <script type="application/ld+json">{ broken json </script></head></html>`, "https://aurum.shop/products/jadau-earrings");
  assertEquals(ld.length, 1);
  assertEquals([ld[0].external_id, ld[0].title, ld[0].sku, ld[0].price, ld[0].currency, ld[0].available, ld[0].vendor, ld[0].product_type, ld[0].tags], ["https://aurum.shop/products/jadau-earrings", "Jadau Earrings", "JE-1", 18500, "INR", true, "Aurum", "Earrings", ["Jewellery"]]);
  assertEquals([ld[0].description, ld[0].images], ["Bridal jadau", ["https://aurum.shop/img/je.jpg", "https://cdn.aurum.shop/je2.jpg"]]);

  const agg = productsFromHtml(`<script type='application/ld+json'>[{"@type":["Product","Thing"],"name":"Temple Set","url":"/p/temple-set","offers":{"@type":"AggregateOffer","lowPrice":7200,"highPrice":9900,"priceCurrency":"inr","offers":[{"@type":"Offer","price":7200,"availability":"OutOfStock"},{"@type":"Offer","price":9900,"availability":"OutOfStock"}]}}]</script>`, "https://aurum.shop/collections/temple");
  assertEquals([agg[0].url, agg[0].price, agg[0].currency, agg[0].available], ["https://aurum.shop/p/temple-set", 7200, "INR", false]);

  const list = productsFromHtml(`<script type="application/ld+json">{"@type":"ItemList","itemListElement":[{"@type":"ListItem","item":{"@type":"Product","name":"A","url":"https://s.co/a","offers":{"price":1,"priceCurrency":"USD"}}},{"@type":"ListItem","item":{"@type":"Product","name":"B","url":"https://s.co/b"}},{"@type":"ListItem","item":{"@type":"Product","name":"A again","url":"https://s.co/a/"}}]}</script>`, "https://s.co/list");
  assertEquals(list.map((p) => p.title), ["A", "B"]);   // one product per address

  const og = productsFromHtml(`<meta property="og:type" content="product"><meta property="og:title" content="Linen Shirt &amp; Tie"><meta content="https://s.co/img.jpg" property="og:image">
    <meta property="product:price:amount" content="49.90"><meta property="product:price:currency" content="eur"><meta property="product:availability" content="oos"><meta property="og:url" content="https://s.co/p/linen-shirt?ref=x">`, "https://s.co/p/linen-shirt");
  assertEquals([og[0].title, og[0].price, og[0].currency, og[0].image_url, og[0].external_id], ["Linen Shirt & Tie", 49.9, "EUR", "https://s.co/img.jpg", "https://s.co/p/linen-shirt"]);
  assertEquals(productsFromHtml(`<meta property="og:type" content="article"><meta property="og:title" content="Blog">`, "https://s.co/blog"), []);
  assertEquals(productsFromHtml(`<meta property="og:type" content="product"><meta property="og:title" content="No price">`, "https://s.co/p"), []);
});

Deno.test("addresses that point into this network are refused", () => {
  for (const u of ["http://localhost/products.json", "http://127.0.0.1:8080/feed", "https://10.0.0.5/x", "http://192.168.1.10/", "http://169.254.169.254/latest/meta-data", "http://[::1]/", "ftp://x.shop/feed", "not a link"]) {
    let refused = false; try { assertPublicUrl(u); } catch (e) { refused = e instanceof CatalogueError; }
    assert(refused, u);
  }
  assertEquals(assertPublicUrl("https://aurum.shop/products.json").hostname, "aurum.shop");
  assertEquals(mapShopifyProduct({ id: 1, title: "x" }, "https://a.shop"), null);   // no handle
});
