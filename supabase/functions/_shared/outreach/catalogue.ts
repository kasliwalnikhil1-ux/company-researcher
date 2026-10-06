// Product catalogues (web-chat-buttons-products-changes.md §5): read a store's products and hand them to the database
// in batches. Called from the knowledge worker (ai_reply.ts → runKnowledge), where websites are crawled.
//
//   Shopify       public /products.json?limit=250&page=n (no app install); currency from /meta.json or /cart.js
//   WooCommerce   public Store API /wp-json/wc/store/v1/products?per_page=100&page=n
//   feed          Google Merchant XML (RSS / Atom with g: fields), or a CSV / TSV feed with the same column names
//   csv           an uploaded file: id, title, description, link, image_link, price, sale_price, currency, availability,
//                 brand, product_type, tags
//   crawl         productsFromHtml(): JSON-LD Product, or og:type=product with a price, on pages the website crawl reads
//
// This file talks to no database: the worker passes `io` (upsert / progress), so the readers run in tests as they are.
// One request per second per store. A sync that does not fit one worker run returns `done: false` with its cursor.

export interface CatalogueVariant { id: string; title?: string | null; price?: number | null; available?: boolean; sku?: string | null }
export interface CatalogueProduct {
  external_id: string; handle?: string | null; sku?: string | null; url: string; title: string; description?: string | null;
  vendor?: string | null; product_type?: string | null; tags?: string[]; options?: Record<string, string[]>;
  price?: number | null; compare_at_price?: number | null; currency?: string | null; available?: boolean;
  image_url?: string | null; images?: string[]; variants?: CatalogueVariant[];
}
/**
 * Where a sync is. `started_at` comes from the database (outreach_catalogue_begin). `via: "db"` = the store turned the
 * edge runtime away, so every request of this sync goes through the database (`fetchViaDb`). `note` = why it is retrying.
 */
export interface SyncCursor { started_at: string; page: number; seen: number; rejected: number; errors?: number; note?: string | null; via?: "db" | null; store?: string | null; currency?: string | null }
export interface SyncIo {
  upsert(batch: CatalogueProduct[]): Promise<{ upserted: number; rejected: number }>;
  progress(cursor: SyncCursor): Promise<void>;
  /** The uploaded file of a CSV catalogue. */
  readFile?(path: string): Promise<string>;
  fetch?: typeof fetch;
  /**
   * The same GET from the database server (pg_net, migration 080). Stores such as Shopify answer 429 to the edge
   * runtime's shared addresses and 200 to the database's, so a page the store turns away is asked for again this way.
   * Shopify and WooCommerce product lists only: the database follows redirects itself, so it never reads a feed link.
   */
  fetchViaDb?(url: string, accept: string): Promise<Response>;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}
export interface SyncResult { done: boolean; complete: boolean; cursor: SyncCursor; currency: string | null; store: string | null; pages: number; warning: string | null }
export interface CatalogueSource { provider: string; url?: string | null; storage_path?: string | null }

export const CATALOGUE_MAX_PRODUCTS = 10_000;
export const BATCH = 200;
const MAX_VARIANTS = 50, MAX_IMAGES = 10, MAX_DESCRIPTION = 2000, MAX_FEED_BYTES = 40 * 1024 * 1024;
const UA = "Mozilla/5.0 (compatible; GrowthxAI-catalogue/1.0)";
export const SHOPIFY_BLOCKED = "This store doesn't share its product list publicly. Use its Google Shopping feed or a CSV instead.";
const LIMIT_WARNING = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "product was" : "products were"} left out: a catalogue holds ${CATALOGUE_MAX_PRODUCTS.toLocaleString("en-US")} products at most.`;

/** An error the next worker run cannot fix (wrong address, a store that blocks the list, an unreadable file). */
export class CatalogueError extends Error {
  final: boolean;
  constructor(message: string, final = true) { super(message); this.final = final; }
}

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", hellip: "…", trade: "™", reg: "®", copy: "©", euro: "€", pound: "£", yen: "¥" };
export function decodeEntities(s: string): string {
  return String(s ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : m; } catch { return m; } }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
/** HTML (a product description) → plain text, one space between blocks. */
export function htmlToPlain(html: unknown, max = MAX_DESCRIPTION): string {
  const t = String(html ?? "").replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, "\n").replace(/<[^>]+>/g, " ");
  return decodeEntities(t).replace(/[ \t\u00a0]+/g, " ").replace(/\s*\n\s*/g, "\n").trim().slice(0, max);
}
const clean = (s: unknown, max = 300): string => decodeEntities(String(s ?? "")).replace(/\s+/g, " ").trim().slice(0, max);
const httpUrl = (u: unknown): string | null => { const s = String(u ?? "").trim(); return /^https?:\/\/\S+$/i.test(s) ? s : null; };
function absolute(u: unknown, base: string): string | null {
  const s = String(u ?? "").trim(); if (!s) return null;
  try { const x = new URL(s.startsWith("//") ? "https:" + s : s, base); return /^https?:$/.test(x.protocol) ? x.toString() : null; } catch { return null; }
}
const uniq = (a: Array<string | null | undefined>, max: number): string[] => { const out: string[] = []; for (const x of a) { const v = String(x ?? "").trim(); if (v && !out.includes(v)) out.push(v); if (out.length >= max) break; } return out; };

const SYMBOLS: Array<[RegExp, string]> = [[/₹|(?:^|[^a-z])rs\.?(?![a-z])/i, "INR"], [/€/, "EUR"], [/£/, "GBP"], [/¥/, "JPY"], [/₩/, "KRW"], [/₽/, "RUB"], [/₺/, "TRY"], [/₫/, "VND"], [/₦/, "NGN"], [/₱/, "PHP"], [/₪/, "ILS"], [/د\.إ/, "AED"]];
/**
 * "45000.00 INR", "INR 45,000", "₹1,00,000", "1.299,00 EUR", "$49.99" → the amount and, when the text says it, the
 * currency. "$" alone names no currency (the catalogue's own currency decides).
 */
export function parsePrice(raw: unknown): { amount: number | null; currency: string | null } {
  if (typeof raw === "number") return { amount: Number.isFinite(raw) && raw >= 0 ? raw : null, currency: null };
  const s = String(raw ?? "").trim();
  if (!s) return { amount: null, currency: null };
  let currency: string | null = (s.match(/(?:^|[^A-Za-z])([A-Z]{3})(?![A-Za-z])/) ?? [])[1] ?? null;
  if (!currency) for (const [re, code] of SYMBOLS) if (re.test(s)) { currency = code; break; }
  let n = (s.match(/\d[\d.,\s\u00a0']*\d|\d/) ?? [""])[0].replace(/[\s\u00a0']/g, "");
  if (!n) return { amount: null, currency };
  const comma = n.lastIndexOf(","), dot = n.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) n = comma > dot ? n.replace(/\./g, "").replace(",", ".") : n.replace(/,/g, "");
  else if (comma >= 0) n = /^\d+,\d{1,2}$/.test(n) ? n.replace(",", ".") : n.replace(/,/g, "");          // "49,99" is a decimal comma; "45,000" and "1,00,000" group thousands
  else if (dot >= 0 && (n.match(/\./g) ?? []).length > 1) n = n.replace(/\./g, "");                       // "1.299.000"
  const amount = Number(n);
  return { amount: Number.isFinite(amount) && amount >= 0 ? amount : null, currency };
}
function inStock(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (!s) return true;
  if (/^\d+$/.test(s)) return Number(s) > 0;
  if (/(outofstock|soldout|discontinued|unavailable|^false$|^no$|^0$)/.test(s)) return false;
  return true;   // in stock, preorder, backorder, available, yes, true, schema.org/InStock …
}

// ---------------------------------------------------------------------------
// CSV / TSV
// ---------------------------------------------------------------------------
/** RFC 4180 reader: quoted cells, doubled quotes, line breaks inside quotes, CRLF. */
export function parseCsv(text: string, delimiter = ","): string[][] {
  const rows: string[][] = []; let row: string[] = [], cur = "", q = false; const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === "\"") { if (s[i + 1] === "\"") { cur += "\""; i++; } else q = false; } else cur += c; continue; }
    if (c === "\"" && cur === "") q = true;
    else if (c === delimiter) { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && s[i + 1] === "\n") i++; row.push(cur); cur = ""; if (row.length > 1 || row[0] !== "") rows.push(row); row = []; }
    else cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); if (row.length > 1 || row[0] !== "") rows.push(row); }
  return rows;
}
function delimiterOf(text: string): string {
  const head = text.slice(0, 4000).split(/\r?\n/)[0] ?? "";
  const n = (ch: string) => head.split(ch).length - 1;
  return n("\t") >= Math.max(n(","), n(";")) && n("\t") > 0 ? "\t" : n(";") > n(",") ? ";" : ",";
}
const ALIAS: Record<string, string> = {
  name: "title", product_name: "title", product_title: "title", url: "link", product_url: "link", product_link: "link", image: "image_link", image_url: "image_link", img: "image_link",
  additional_image_links: "additional_image_link", images: "additional_image_link", category: "product_type", type: "product_type", vendor: "brand", manufacturer: "brand",
  stock: "availability", in_stock: "availability", available: "availability", regular_price: "price", offer_price: "sale_price", discounted_price: "sale_price", compare_at: "compare_at_price", mrp: "compare_at_price",
  slug: "handle", group_id: "item_group_id", parent_id: "item_group_id", colour: "color",
};
const headerKey = (h: string): string => { const k = h.trim().toLowerCase().replace(/^g:/, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""); return ALIAS[k] ?? k; };

type Fields = Record<string, string | string[] | undefined>;
const one = (f: Fields, k: string): string => { const v = f[k]; return Array.isArray(v) ? (v[0] ?? "") : (v ?? ""); };
const many = (f: Fields, k: string): string[] => { const v = f[k]; return Array.isArray(v) ? v : v ? [v] : []; };

/** One feed / CSV row (Google Merchant field names) → a product, or null when it has no id, title or link. */
function fromFields(f: Fields, base: string | null): (CatalogueProduct & { group?: string }) | null {
  const title = clean(one(f, "title")), link = base ? absolute(one(f, "link"), base) : httpUrl(one(f, "link"));
  const id = clean(one(f, "id"), 300) || clean(one(f, "sku"), 300) || clean(one(f, "mpn"), 300) || link || "";
  if (!title || !link || !id) return null;
  // Google's columns: `price` is the regular price and `sale_price` the reduced one. A shop export may instead give the
  // current price in `price` and the old one in `compare_at_price`.
  const reg = parsePrice(one(f, "price")), sale = parsePrice(one(f, "sale_price")), was = parsePrice(one(f, "compare_at_price"));
  const onSale = sale.amount != null && (reg.amount == null || sale.amount < reg.amount);
  const cur = clean(one(f, "currency"), 3).toUpperCase();
  const type = clean(one(f, "product_type")).split(/\s*>\s*/).filter(Boolean);
  const tags = uniq([...many(f, "tags").flatMap((t) => String(t).split(/[,|;]/)), ...type.slice(0, -1), ...["custom_label_0", "custom_label_1", "custom_label_2", "custom_label_3", "custom_label_4"].map((k) => clean(one(f, k), 80))].map((t) => clean(t, 80)), 50);
  const options: Record<string, string[]> = {};
  for (const [k, label] of [["color", "Color"], ["size", "Size"], ["material", "Material"], ["pattern", "Pattern"]] as const) { const v = clean(one(f, k), 80); if (v) options[label] = [v]; }
  const images = uniq([base ? absolute(one(f, "image_link"), base) : httpUrl(one(f, "image_link")), ...many(f, "additional_image_link").flatMap((x) => String(x).split(/[,|]/)).map((x) => (base ? absolute(x, base) : httpUrl(x)))], MAX_IMAGES);
  const available = inStock(one(f, "availability"));
  const price = onSale ? sale.amount : reg.amount;
  return {
    external_id: id, handle: clean(one(f, "handle")) || null, sku: clean(one(f, "sku"), 120) || clean(one(f, "mpn"), 120) || null, url: link, title,
    description: htmlToPlain(one(f, "description")) || null, vendor: clean(one(f, "brand"), 200) || null, product_type: type[type.length - 1] ?? null, tags, options,
    price, compare_at_price: onSale ? reg.amount : was.amount != null && price != null && was.amount > price ? was.amount : null, currency: /^[A-Z]{3}$/.test(cur) ? cur : (sale.currency ?? reg.currency), available,
    image_url: images[0] ?? null, images, variants: [{ id, title: Object.values(options).map((v) => v[0]).join(" / ") || null, price, available, sku: clean(one(f, "sku"), 120) || clean(one(f, "mpn"), 120) || null }],
    group: clean(one(f, "item_group_id"), 300) || undefined,
  };
}
/** Feed rows that are sizes / colours of one product (same item_group_id) become one product with variants. */
function groupVariants(rows: Array<CatalogueProduct & { group?: string }>): CatalogueProduct[] {
  const out: CatalogueProduct[] = [], byGroup = new Map<string, CatalogueProduct>();
  for (const { group, ...p } of rows) {
    const head = group ? byGroup.get(group) : undefined;
    if (!group) { out.push(p); continue; }
    if (!head) { const first = { ...p, external_id: group }; byGroup.set(group, first); out.push(first); continue; }
    if ((head.variants ?? []).length < MAX_VARIANTS && p.variants?.[0]) head.variants!.push(p.variants[0]);
    for (const [k, v] of Object.entries(p.options ?? {})) head.options![k] = uniq([...(head.options![k] ?? []), ...v], 30);
    if (p.available && (!head.available || (p.price != null && (head.price == null || p.price < head.price)))) { head.price = p.price; head.compare_at_price = p.compare_at_price; }
    head.available = !!(head.available || p.available);
    head.images = uniq([...(head.images ?? []), ...(p.images ?? [])], MAX_IMAGES);
  }
  return out;
}

/** A CSV / TSV file with the template's (or Google Merchant's) column names. Relative links need `base`. */
export function productsFromCsv(text: string, base: string | null = null): CatalogueProduct[] {
  const rows = parseCsv(text, delimiterOf(text));
  if (rows.length < 2) return [];
  const keys = rows[0].map(headerKey);
  if (!keys.includes("title") || !keys.includes("link")) throw new CatalogueError("The file needs at least the columns title and link (and id, price, image_link). Download the template to see every column.");
  const out: Array<CatalogueProduct & { group?: string }> = [];
  for (let r = 1; r < rows.length; r++) {
    const f: Fields = {};
    rows[r].forEach((cell, i) => { const k = keys[i]; if (!k || cell === "") return; const prev = f[k]; f[k] = prev === undefined ? cell : [...(Array.isArray(prev) ? prev : [prev]), cell]; });
    const p = fromFields(f, base); if (p) out.push(p);
  }
  return groupVariants(out);
}

// ---------------------------------------------------------------------------
// Google Merchant XML (RSS 2.0 <item> or Atom <entry>, g: fields)
// ---------------------------------------------------------------------------
const cdata = (s: string): string => { const m = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s); return m ? m[1] : decodeEntities(s); };
export function productsFromFeedXml(xml: string, base: string | null = null): CatalogueProduct[] {
  const out: Array<CatalogueProduct & { group?: string }> = [];
  const itemRe = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (let m = itemRe.exec(xml); m; m = itemRe.exec(xml)) {
    const body = m[2], f: Fields = {};
    const tagRe = /<((?:g:)?[a-z_0-9]+)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/gi;
    for (let t = tagRe.exec(body); t; t = tagRe.exec(body)) {
      const k = headerKey(t[1]);
      let v = t[3] != null ? cdata(t[3]).trim() : "";
      if (!v && k === "link") v = decodeEntities((/\bhref=["']([^"']+)["']/i.exec(t[2]) ?? [])[1] ?? "");   // Atom: <link href="…"/>
      if (!v) continue;
      const prev = f[k]; f[k] = prev === undefined ? v : [...(Array.isArray(prev) ? prev : [prev]), v];
    }
    const p = fromFields(f, base); if (p) out.push(p);
    if (out.length > CATALOGUE_MAX_PRODUCTS * 3) break;   // variants fold into fewer products; a feed far past the limit is cut here
  }
  return groupVariants(out);
}
/** A feed's text: XML when it starts with a tag, else CSV / TSV. */
export function productsFromFeed(text: string, base: string | null = null): CatalogueProduct[] {
  return /^\uFEFF?\s*</.test(text) ? productsFromFeedXml(text, base) : productsFromCsv(text, base);
}

// ---------------------------------------------------------------------------
// Shopify + WooCommerce rows
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
type Json = any;
export function mapShopifyProduct(p: Json, store: string): CatalogueProduct | null {
  if (!p || p.id == null || !p.title || !p.handle) return null;
  const vs: Json[] = Array.isArray(p.variants) ? p.variants : [];
  const variants: CatalogueVariant[] = vs.slice(0, MAX_VARIANTS).map((v) => ({ id: String(v.id), title: v.title && v.title !== "Default Title" ? clean(v.title, 200) : null, price: parsePrice(v.price).amount, available: v.available !== false, sku: clean(v.sku, 120) || null }));
  const buyable = vs.filter((v) => v.available !== false), pool = buyable.length ? buyable : vs;
  const cheapest = pool.reduce<Json | null>((a, v) => { const n = parsePrice(v.price).amount; return n != null && (a == null || n < (parsePrice(a.price).amount ?? Infinity)) ? v : a; }, null);
  const options: Record<string, string[]> = {};
  for (const o of Array.isArray(p.options) ? p.options : []) { const vals = uniq((o?.values ?? []).map((x: unknown) => clean(x, 80)), 30); if (o?.name && !(o.name === "Title" && vals.join() === "Default Title") && vals.length) options[clean(o.name, 60)] = vals; }
  const images = uniq((Array.isArray(p.images) ? p.images : []).map((i: Json) => absolute(i?.src, store)), MAX_IMAGES);
  const tags = Array.isArray(p.tags) ? p.tags : String(p.tags ?? "").split(",");
  return {
    external_id: String(p.id), handle: String(p.handle), sku: clean(cheapest?.sku ?? vs[0]?.sku, 120) || null, url: `${store}/products/${p.handle}`, title: clean(p.title),
    description: htmlToPlain(p.body_html) || null, vendor: clean(p.vendor, 200) || null, product_type: clean(p.product_type, 200) || null, tags: uniq(tags.map((t: unknown) => clean(t, 80)), 50), options,
    price: cheapest ? parsePrice(cheapest.price).amount : null, compare_at_price: cheapest ? parsePrice(cheapest.compare_at_price).amount : null,
    available: vs.length ? buyable.length > 0 : true, image_url: images[0] ?? null, images, variants,
  };
}
export function mapWooProduct(p: Json): CatalogueProduct | null {
  const url = httpUrl(p?.permalink);
  if (!p || p.id == null || !p.name || !url) return null;
  const pr = p.prices ?? {}, minor = Number.isInteger(pr.currency_minor_unit) ? pr.currency_minor_unit : 2, unit = (v: unknown) => { const n = Number(v); return v == null || v === "" || !Number.isFinite(n) ? null : n / 10 ** minor; };
  const price = unit(pr.price), regular = unit(pr.regular_price);
  const cats = uniq((p.categories ?? []).map((c: Json) => clean(c?.name, 80)), 20);
  const options: Record<string, string[]> = {};
  for (const a of Array.isArray(p.attributes) ? p.attributes : []) { const vals = uniq((a?.terms ?? []).map((t: Json) => clean(t?.name, 80)), 30); if (a?.name && vals.length) options[clean(a.name, 60)] = vals; }
  const images = uniq((p.images ?? []).map((i: Json) => httpUrl(i?.src)), MAX_IMAGES);
  return {
    external_id: String(p.id), handle: clean(p.slug) || null, sku: clean(p.sku, 120) || null, url, title: clean(p.name), description: htmlToPlain(p.short_description || p.description) || null,
    vendor: clean((p.brands ?? [])[0]?.name, 200) || null, product_type: cats[0] ?? null, tags: uniq([...cats.slice(1), ...(p.tags ?? []).map((t: Json) => clean(t?.name, 80))], 50), options,
    price, compare_at_price: regular != null && price != null && regular > price ? regular : null, currency: /^[A-Z]{3}$/.test(String(pr.currency_code ?? "")) ? pr.currency_code : null,
    available: p.is_in_stock !== false, image_url: images[0] ?? null, images,
    variants: (Array.isArray(p.variations) ? p.variations : []).slice(0, MAX_VARIANTS).map((v: Json) => ({ id: String(v.id), title: (v.attributes ?? []).map((a: Json) => clean(a?.value, 60)).filter(Boolean).join(" / ") || null, price, available: p.is_in_stock !== false })),
  };
}

// ---------------------------------------------------------------------------
// Products on a crawled page: JSON-LD Product, or og:type=product with a price
// ---------------------------------------------------------------------------
const pageKey = (u: string): string => { try { const x = new URL(u); x.hash = ""; x.search = ""; return x.toString().replace(/\/+$/, ""); } catch { return u; } };
const typeIs = (node: Json, name: string): boolean => { const t = node?.["@type"]; return Array.isArray(t) ? t.includes(name) : t === name; };
const str = (v: Json): string => (typeof v === "string" || typeof v === "number" ? String(v) : typeof v?.name === "string" ? v.name : typeof v?.["@id"] === "string" ? v["@id"] : "");
function ldProduct(node: Json, pageUrl: string, urlTaken: Set<string>): CatalogueProduct | null {
  const title = clean(node.name);
  if (!title) return null;
  let url = absolute(node.url ?? node.offers?.url ?? (Array.isArray(node.offers) ? node.offers[0]?.url : null), pageUrl);
  if (!url) { url = pageUrl; }
  const key = pageKey(url);
  if (urlTaken.has(key)) return null;   // one product per address
  urlTaken.add(key);
  const offers: Json[] = (Array.isArray(node.offers) ? node.offers : node.offers ? [node.offers] : []).flatMap((o: Json) => (typeIs(o, "AggregateOffer") && Array.isArray(o.offers) && o.offers.length ? [o, ...o.offers] : [o]));
  let price: number | null = null, currency: string | null = null, available = offers.length === 0;
  for (const o of offers) {
    const n = parsePrice(o.price ?? o.lowPrice ?? o.priceSpecification?.price).amount;
    if (n != null && (price == null || n < price)) { price = n; currency = String(o.priceCurrency ?? o.priceSpecification?.priceCurrency ?? currency ?? "").toUpperCase() || null; }
    const group = typeIs(o, "AggregateOffer") && Array.isArray(o.offers) && o.offers.length > 0;   // its own offers say what is in stock
    if (!group && (o.availability == null || inStock(String(o.availability).replace(/^https?:\/\/schema\.org\//i, "")))) available = true;
  }
  const img = node.image, images = uniq((Array.isArray(img) ? img : img ? [img] : []).map((i: Json) => absolute(typeof i === "string" ? i : i?.url ?? i?.contentUrl, pageUrl)), MAX_IMAGES);
  const cat = clean(str(node.category)).split(/\s*[>/]\s*/).filter(Boolean);
  return {
    external_id: key, sku: clean(str(node.sku) || str(node.mpn), 120) || null, url, title, description: htmlToPlain(node.description) || null, vendor: clean(str(node.brand), 200) || null,
    product_type: cat[cat.length - 1] ?? null, tags: uniq(cat.slice(0, -1), 20), price, currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null, available,
    image_url: images[0] ?? null, images,
  };
}
function walkLd(node: Json, out: Json[], depth = 0): void {
  if (!node || depth > 6) return;
  if (Array.isArray(node)) { for (const n of node) walkLd(n, out, depth + 1); return; }
  if (typeof node !== "object") return;
  if (typeIs(node, "Product") || typeIs(node, "ProductGroup")) out.push(node);
  if (node["@graph"]) walkLd(node["@graph"], out, depth + 1);
  if (typeIs(node, "ItemList") && Array.isArray(node.itemListElement)) for (const el of node.itemListElement) walkLd(el?.item ?? el, out, depth + 1);
  if (node.mainEntity) walkLd(node.mainEntity, out, depth + 1);
}
const meta = (html: string, prop: string): string => {
  const re = new RegExp(`<meta\\b[^>]*(?:property|name)=["']${prop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>`, "i"), tag = re.exec(html)?.[0] ?? "";
  return decodeEntities((/\bcontent=["']([^"']*)["']/i.exec(tag) ?? [])[1] ?? "").trim();
};
export function productsFromHtml(html: string, url: string): CatalogueProduct[] {
  const out: CatalogueProduct[] = [], taken = new Set<string>(), nodes: Json[] = [];
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    try { walkLd(JSON.parse(m[1].replace(/^\s*<!--|-->\s*$/g, "").trim()), nodes); } catch { /* a broken block is skipped */ }
  }
  for (const n of nodes.slice(0, 60)) { const p = ldProduct(n, url, taken); if (p) out.push(p); }
  if (!out.length && /^(og:)?product(\.item)?$/i.test(meta(html, "og:type"))) {
    const amount = parsePrice(meta(html, "product:price:amount") || meta(html, "og:price:amount")).amount, title = clean(meta(html, "og:title"));
    if (amount != null && title) {
      const link = absolute(meta(html, "og:url"), url) ?? url, cur = (meta(html, "product:price:currency") || meta(html, "og:price:currency")).toUpperCase(), image = absolute(meta(html, "og:image"), url);
      out.push({ external_id: pageKey(link), url: link, title, description: htmlToPlain(meta(html, "og:description")) || null, vendor: clean(meta(html, "product:brand"), 200) || null,
        sku: clean(meta(html, "product:retailer_item_id"), 120) || null, price: amount, currency: /^[A-Z]{3}$/.test(cur) ? cur : null,
        available: inStock(meta(html, "product:availability") || meta(html, "og:availability")), image_url: image, images: image ? [image] : [] });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------
/** Catalogue addresses come from users: never follow one into this network. */
export function assertPublicUrl(u: string): URL {
  let x: URL;
  try { x = new URL(u); } catch { throw new CatalogueError("That address is not a link."); }
  const h = x.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const local = h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h === "::1" || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h);
  if (!/^https?:$/.test(x.protocol) || (local && Deno.env.get("OUTREACH_CATALOGUE_ALLOW_PRIVATE") !== "1")) throw new CatalogueError("That address cannot be read from here.");
  return x;
}
/** Let go of an answer that will not be read. A body whose request already timed out rejects here; that is fine. */
const drop = async (res: Response | null | undefined): Promise<void> => { try { await res?.body?.cancel(); } catch { /* already closed or aborted */ } };
/** 429 = rate-limited, 403 = a bot wall: answers given to the edge runtime's address, which the database's may not get. */
const turnedAway = (status: number): boolean => status === 429 || status === 403;
/** One GET through the database (pg_net does not follow redirects, so they are followed here, each checked again). */
async function viaDb(io: SyncIo, url: string, accept: string): Promise<Response> {
  let at = url;
  for (let hop = 0; hop < 5; hop++) {
    assertPublicUrl(at);
    let res: Response;
    try { res = await io.fetchViaDb!(at, accept); }
    catch (e) { throw new CatalogueError(`The source did not answer (${String((e as Error)?.message ?? e).slice(0, 120)}).`, false); }
    const next = res.status >= 300 && res.status < 400 ? absolute(res.headers.get("location"), at) : null;
    if (!next) { if (!res.url) Object.defineProperty(res, "url", { value: at }); return res; }
    await drop(res);
    at = next;
  }
  throw new CatalogueError("The source redirected too many times.");
}
/**
 * A GET with two retries on 429 / 5xx. When the store turns the edge runtime away (or cannot be reached from it) the
 * page is asked for through the database, and `cur.via` keeps the sync on that route.
 */
async function get(io: SyncIo, url: string, accept: string, cur?: SyncCursor, db = true): Promise<Response> {
  assertPublicUrl(url);
  const f = io.fetch ?? fetch, dbOk = db && !!io.fetchViaDb;
  const tryDb = async (): Promise<Response | null> => {
    if (!dbOk) return null;
    const alt = await viaDb(io, url, accept).catch(() => null);
    if (alt && !turnedAway(alt.status) && alt.status < 500) { if (cur) cur.via = "db"; return alt; }
    await drop(alt);
    return null;
  };
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    if (cur?.via === "db" && dbOk) res = await viaDb(io, url, accept);
    else {
      try { res = await f(url, { headers: { "user-agent": UA, accept }, redirect: "follow", signal: AbortSignal.timeout(20_000) }); }
      catch (e) {
        const alt = await tryDb(); if (alt) return alt;
        throw new CatalogueError(`The source did not answer (${String((e as Error)?.message ?? e).slice(0, 120)}).`, false);
      }
      if (attempt === 0 && turnedAway(res.status) && dbOk) {
        const status = res.status, retryAfter = res.headers.get("retry-after");
        await drop(res);   // before the database route runs: the edge request's 20 s timer would error a body left open
        const alt = await tryDb(); if (alt) return alt;
        res = new Response(null, { status, headers: retryAfter ? { "retry-after": retryAfter } : {} });
      }
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await drop(res);
      await (io.sleep ?? sleep)(Math.min(10_000, Math.max(1000, Number(res.headers.get("retry-after")) * 1000 || 2000 * (attempt + 1))));
      continue;
    }
    return res;
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function textCapped(res: Response, max: number): Promise<string> {
  const len = Number(res.headers.get("content-length"));
  if (len > max) { await drop(res); throw new CatalogueError(`The file is larger than ${Math.round(max / 1048576)} MB.`); }
  let t: string;
  try { t = await res.text(); }
  catch (e) { throw new CatalogueError(`The source stopped answering (${String((e as Error)?.message ?? e).slice(0, 120)}).`, false); }   // a slow store: try again later
  if (t.length > max) throw new CatalogueError(`The file is larger than ${Math.round(max / 1048576)} MB.`);
  return t;
}

/** Send products in batches of 200 and keep the counts: what the database took, and what it rejected because the catalogue is full. */
async function push(io: SyncIo, cur: SyncCursor, products: CatalogueProduct[]): Promise<void> {
  for (let i = 0; i < products.length; i += BATCH) {
    const r = await io.upsert(products.slice(i, i + BATCH));
    cur.seen += r.upserted; cur.rejected += r.rejected;
  }
}
const result = (cur: SyncCursor, done: boolean, complete: boolean, pages: number): SyncResult =>
  ({ done, complete, cursor: cur, currency: cur.currency ?? null, store: cur.store ?? null, pages, warning: cur.rejected > 0 ? LIMIT_WARNING(cur.rejected) : null });

// ---------------------------------------------------------------------------
// Shopify
// ---------------------------------------------------------------------------
export async function syncShopify(storeUrl: string, cur: SyncCursor, io: SyncIo, deadline: number): Promise<SyncResult> {
  const now = io.now ?? Date.now, wait = io.sleep ?? sleep;
  let store = cur.store || assertPublicUrl(storeUrl).origin;
  for (let first = true; ; first = false) {
    if (!first) { if (now() > deadline) { await io.progress(cur); return result(cur, false, false, cur.page - 1); } await wait(1000); }
    const res = await get(io, `${store}/products.json?limit=250&page=${cur.page}`, "application/json", cur);
    if (!res.ok) { await drop(res); throw new CatalogueError(res.status === 429 || res.status >= 500 ? `The store answered ${res.status}.` : SHOPIFY_BLOCKED, !(res.status === 429 || res.status >= 500)); }
    let body: Json;
    try { body = JSON.parse(await textCapped(res, MAX_FEED_BYTES)); } catch (e) { if (e instanceof CatalogueError) throw e; throw new CatalogueError(SHOPIFY_BLOCKED); }   // a password page, a theme 404
    if (!Array.isArray(body?.products)) throw new CatalogueError(SHOPIFY_BLOCKED);
    if (cur.page === 1) {
      // the store's main domain (a *.myshopify.com address redirects to it): product links and Add to cart use it
      try { const o = new URL(res.url).origin; if (o && o !== "null") store = o; } catch { /* keep the given one */ }
      cur.store = store;
      cur.currency = cur.currency ?? await shopifyCurrency(io, store, cur);
    }
    const rows = (body.products as Json[]).map((p) => mapShopifyProduct(p, store)).filter((p): p is CatalogueProduct => !!p);
    await push(io, cur, rows);
    const last = body.products.length < 250 || cur.rejected > 0;
    cur.page += 1; cur.errors = 0;
    if (last) return result(cur, true, true, cur.page - 1);
    await io.progress(cur);
  }
}
async function shopifyCurrency(io: SyncIo, store: string, cur: SyncCursor): Promise<string | null> {
  for (const path of ["/meta.json", "/cart.js"]) {
    try {
      const res = await get(io, store + path, "application/json", cur);
      if (!res.ok) { await drop(res); continue; }
      const c = String((await res.json())?.currency ?? "").toUpperCase();
      if (/^[A-Z]{3}$/.test(c)) return c;
    } catch { /* the next one */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// WooCommerce
// ---------------------------------------------------------------------------
export async function syncWoo(storeUrl: string, cur: SyncCursor, io: SyncIo, deadline: number): Promise<SyncResult> {
  const now = io.now ?? Date.now, wait = io.sleep ?? sleep, given = assertPublicUrl(storeUrl);
  const bases = uniq([cur.store, (given.origin + given.pathname).replace(/\/+$/, ""), given.origin], 3);
  for (let first = true; ; first = false) {
    if (!first) { if (now() > deadline) { await io.progress(cur); return result(cur, false, false, cur.page - 1); } await wait(1000); }
    let res: Response | null = null;
    for (const b of cur.store ? [cur.store] : bases) {
      res = await get(io, `${b}/wp-json/wc/store/v1/products?per_page=100&page=${cur.page}`, "application/json", cur);
      if (res.ok) { cur.store = b; break; }
      if (res.status === 429 || res.status >= 500) { await drop(res); throw new CatalogueError(`The store answered ${res.status}.`, false); }
      await drop(res);
    }
    if (!res?.ok) throw new CatalogueError("This store's product list could not be read (the WooCommerce Store API did not answer). Use its product feed or a CSV instead.");
    let body: Json;
    try { body = JSON.parse(await textCapped(res, MAX_FEED_BYTES)); } catch (e) { if (e instanceof CatalogueError) throw e; throw new CatalogueError("This store's product list could not be read. Use its product feed or a CSV instead."); }
    if (!Array.isArray(body)) throw new CatalogueError("This store's product list could not be read. Use its product feed or a CSV instead.");
    const rows = (body as Json[]).map(mapWooProduct).filter((p): p is CatalogueProduct => !!p);
    cur.currency = cur.currency ?? rows.find((r) => r.currency)?.currency ?? null;
    await push(io, cur, rows);
    const pages = Number(res.headers.get("x-wp-totalpages"));
    const last = body.length < 100 || (pages > 0 && cur.page >= pages) || cur.rejected > 0;
    cur.page += 1; cur.errors = 0;
    if (last) return result(cur, true, true, cur.page - 1);
    await io.progress(cur);
  }
}

// ---------------------------------------------------------------------------
// Feed (a link) and CSV (an uploaded file): read whole, sent in batches; `page` counts the batches already in
// ---------------------------------------------------------------------------
async function syncRows(rows: CatalogueProduct[], cur: SyncCursor, io: SyncIo, deadline: number): Promise<SyncResult> {
  const now = io.now ?? Date.now;
  if (!rows.length) throw new CatalogueError("No products were found in it. Each product needs a title and a link.");
  const over = Math.max(0, rows.length - CATALOGUE_MAX_PRODUCTS), list = over ? rows.slice(0, CATALOGUE_MAX_PRODUCTS) : rows;
  cur.currency = cur.currency ?? list.find((r) => r.currency)?.currency ?? null;
  for (let i = (cur.page - 1) * BATCH; i < list.length; i += BATCH) {
    if (now() > deadline) { await io.progress(cur); return result(cur, false, false, 1); }
    await push(io, cur, list.slice(i, i + BATCH));
    cur.page += 1;
  }
  cur.rejected += over;
  return result(cur, true, true, 1);
}
export async function syncFeed(feedUrl: string, cur: SyncCursor, io: SyncIo, deadline: number): Promise<SyncResult> {
  const res = await get(io, feedUrl, "application/xml, text/xml, text/csv, text/tab-separated-values, text/plain, */*", cur, false);   // the database reads store product lists only (migration 080)
  if (!res.ok) { await drop(res); throw new CatalogueError(`The feed answered ${res.status}. Check the link.`, res.status !== 429 && res.status < 500); }
  const text = await textCapped(res, MAX_FEED_BYTES);
  return syncRows(productsFromFeed(text, res.url || feedUrl), cur, io, deadline);
}
export async function syncCsv(path: string, cur: SyncCursor, io: SyncIo, deadline: number): Promise<SyncResult> {
  if (!io.readFile) throw new CatalogueError("The file could not be read.");
  return syncRows(productsFromCsv(await io.readFile(path)), cur, io, deadline);
}

/** One catalogue, one worker run. Throws CatalogueError; `final: false` means the next run may succeed. */
export function syncCatalogue(src: CatalogueSource, cur: SyncCursor, io: SyncIo, deadline: number): Promise<SyncResult> {
  const c: SyncCursor = { ...cur, page: Math.max(1, Number(cur.page) || 1), seen: Number(cur.seen) || 0, rejected: Number(cur.rejected) || 0 };
  if (src.provider === "shopify") return syncShopify(String(src.url ?? ""), c, io, deadline);
  if (src.provider === "woocommerce") return syncWoo(String(src.url ?? ""), c, io, deadline);
  if (src.provider === "feed") return syncFeed(String(src.url ?? ""), c, io, deadline);
  if (src.provider === "csv") return syncCsv(String(src.storage_path ?? ""), c, io, deadline);
  return Promise.reject(new CatalogueError("Unknown catalogue type."));
}

/** The template a user downloads before uploading a CSV catalogue. */
export const CSV_TEMPLATE = "id,title,description,link,image_link,price,sale_price,currency,availability,brand,product_type,tags\n" +
  "SKU-1,Polki Choker Set,Uncut diamond choker with matching earrings,https://your-store.com/products/polki-choker-set,https://your-store.com/images/polki.jpg,52000,45000,INR,in stock,Aurum,Necklace,\"bridal, polki\"\n";
