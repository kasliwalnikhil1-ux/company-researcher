/**
 * The website assistant's local "AI" (PRODUCT-TOUR PRD §4.5): answers from the seeded Q&A and knowledge chunks through
 * ai.ts websiteAnswer (keyword match), and product cards picked from the website's catalogues (outreach_products), in
 * the card shape of 068 outreach_product__card. No model is called.
 */
import { websiteAnswer } from '../ai';
import type { DemoStore, Row } from '../store';
import { productSources, settingsOf } from './core';

export interface Qa { id?: string; question: string; answer: string; url?: string | null; title?: string | null }

/** Library Q&A pairs that apply to this website (063 outreach_hub__qa_applies: no links = everywhere). */
export function faqsFor(store: DemoStore, inbox: Row): Qa[] {
  const links = store.t('outreach_knowledge_qa_links');
  return store.t('outreach_master_prompt_faqs')
    .filter((f) => !f.master_prompt_id && f.workspace_id === inbox.workspace_id && f.enabled !== false)
    .filter((f) => { const own = links.filter((k) => k.qa_id === f.id); return own.length === 0 || own.some((k) => k.target_kind === 'website' && k.target_id === inbox.id); })
    .map((f) => ({ id: f.id, question: String(f.question ?? ''), answer: String(f.answer ?? '') }));
}

const sentences = (t: string, n: number) => (t.replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]+/g) ?? [t]).slice(0, n).join(' ').trim();

/** Chunks of the knowledge sources the website answers from, as question / answer pairs for the keyword match. */
export function chunksFor(store: DemoStore, inbox: Row): Qa[] {
  const st = settingsOf(inbox);
  const ids = new Set<string>((st.ai?.knowledge_source_ids ?? []).map(String));
  if (!ids.size) return [];
  const titleOf = new Map(store.t('outreach_knowledge_sources').map((s) => [s.id, String(s.title ?? '')]));
  return store.t('outreach_knowledge_chunks').filter((c) => ids.has(String(c.source_id)) && c.text)
    .map((c) => ({ question: `${c.heading ?? ''} ${String(c.text).slice(0, 300)}`, answer: sentences(String(c.text), 3), url: c.url ?? null, title: c.heading || titleOf.get(c.source_id) || 'Knowledge' }));
}

// ---------------------------------------------------------------------------- products
const STOP = new Set('show me the a an any some do does did you your have has got sell selling i im am we us want wants need needs would like looking look for find search get buy buying purchase is are was there what which whats can could should please of in on at to with and or under below above over between than less more around about upto up within budget price priced prices cost costs range cheap cheaper cheapest expensive affordable similar something anything this that these those it its one ones my our best good nice great options option recommend recommended suggest suggestion suggestions tell give see also but not no yes ok okay hi hello hey thanks thank rs inr usd eur dollars dollar gift gifts'.split(' '));
const words = (s: string) => String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));
const SHOPPING = /\b(buy|recommend|suggest|gift|looking for|show me|options?|under|below|less than|cheap|cheapest|affordable|in stock|do you (have|sell|stock)|which (one|product)|products?|budget)\b/i;

export function productCard(store: DemoStore, p: Row): Row {
  const src = store.get('outreach_knowledge_sources', p.source_id);
  const provider = src?.catalogue?.provider;
  const variant = provider === 'shopify' && p.available !== false ? (Array.isArray(p.variants) ? p.variants : []).find((v: Row) => v?.id != null && v.available !== false)?.id : undefined;
  const card: Row = { id: p.id, title: p.title, price: p.price ?? null, currency: p.currency ?? null, url: p.url, image: p.image_url ?? null, available: p.available !== false };
  if (p.compare_at_price != null && p.price != null && p.compare_at_price > p.price) card.compare_at = p.compare_at_price;
  if (variant != null) card.variant_id = String(variant);
  for (const k of Object.keys(card)) if (card[k] == null) delete card[k];
  return card;
}

/** The products a website may recommend (its catalogues), visible to the AI. */
export function catalogueProducts(store: DemoStore, inbox: Row, includeOos = false): Row[] {
  const st = settingsOf(inbox);
  const src = new Set(productSources(store, inbox.workspace_id, st));
  return store.t('outreach_products').filter((p) => src.has(String(p.source_id)) && !p.deleted_at && !p.ai_hidden && (includeOos || p.available !== false));
}

/** "Which product is this": a URL, handle or SKU (068 outreach_product__resolve). */
export function resolveProduct(store: DemoStore, inbox: Row, ref: string | null | undefined): Row | null {
  const r = String(ref ?? '').trim().toLowerCase().replace(/^product:/, '');
  if (!r) return null;
  const key = (u: string) => u.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  return catalogueProducts(store, inbox, true).find((p) => (p.url && key(String(p.url)) === key(r)) || String(p.handle ?? '').toLowerCase() === r || String(p.sku ?? '').toLowerCase() === r
    || (p.url && key(r).endsWith(key(String(p.url)).split('/').pop() ?? '\u0000'))) ?? null;
}

const money = (p: Row) => (p.price == null ? '' : `${p.currency === 'USD' || !p.currency ? '$' : `${p.currency} `}${Number(p.price).toFixed(Number(p.price) % 1 ? 2 : 0)}`);

/** Product recommendation for a question: keyword score over title / type / tags / description, with a budget filter. */
export function recommend(store: DemoStore, inbox: Row, query: string, opts: { context?: string | null; product?: string | null } = {}): { cards: Row[]; picked: Row[]; shopping: boolean; search: Row; current: Row | null } | null {
  const st = settingsOf(inbox);
  const pr = st.ai?.products ?? {};
  if (pr.enabled !== true) return null;
  const all = catalogueProducts(store, inbox, pr.include_oos === true);
  if (!all.length) return null;
  const max = Math.min(6, Math.max(1, Number(pr.max) || 3));
  const ctxRef = opts.context && /^product:/i.test(opts.context) ? opts.context : null;
  const current = resolveProduct(store, inbox, ctxRef ?? opts.product ?? null);
  const q = String(query ?? '');
  const budget = /(?:under|below|less than|max(?:imum)?|up ?to|within|cheaper than)\s*(?:[$€£₹]|usd|rs\.?|inr)?\s*(\d+(?:\.\d+)?)/i.exec(q);
  const maxPrice = budget ? Number(budget[1]) : null;
  const qw = words(q);
  const shopping = SHOPPING.test(q) || maxPrice != null;
  const scored = all.map((p) => {
    const title = words(p.title), rest = words(`${p.product_type ?? ''} ${p.vendor ?? ''} ${(p.tags ?? []).join(' ')} ${(p.pinned_keywords ?? []).join(' ')} ${String(p.description ?? '').slice(0, 400)}`);
    let score = 0;
    for (const w of qw) { if (title.includes(w)) score += 3; else if (rest.includes(w)) score += 1; if ((p.pinned_keywords ?? []).map((k: string) => k.toLowerCase()).includes(w)) score += 4; }
    return { p, score };
  }).filter((x) => maxPrice == null || (x.p.price != null && Number(x.p.price) <= maxPrice));
  let picked = scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score || Number(a.p.price ?? 0) - Number(b.p.price ?? 0)).map((x) => x.p);
  if (!picked.length && shopping) picked = scored.sort((a, b) => Number(a.p.price ?? 0) - Number(b.p.price ?? 0)).map((x) => x.p);
  if (current && !picked.includes(current) && /\b(this|it|that)\b/i.test(q)) picked.unshift(current);
  picked = picked.slice(0, max);
  return { cards: picked.map((p) => productCard(store, p)), picked, shopping, current, search: { q: q.slice(0, 200), ...(maxPrice != null ? { max_price: maxPrice } : {}), found: picked.length } };
}

export interface Answer { answer: string; confidence: 'high' | 'low'; sources: Array<{ url: string | null; title: string }>; cards: Row[]; product_id: string | null; product_search: Row | null; handoff: boolean }

/** The assistant's answer to one visitor question on a website. */
export function answerFor(store: DemoStore, inbox: Row, query: string, opts: { context?: string | null; product?: string | null } = {}): Answer {
  const st = settingsOf(inbox);
  const brand = String(st.appearance?.brand_name || inbox.name || 'our team');
  const faqs = faqsFor(store, inbox), chunks = chunksFor(store, inbox);
  const rec = recommend(store, inbox, query, opts);
  const hit = websiteAnswer(store, query, [...faqs, ...chunks]);
  const fromChunk = hit.matched ? chunks.find((c) => c.answer === hit.answer) : undefined;
  const sources = st.ai?.show_sources !== false && fromChunk ? [{ url: fromChunk.url ?? null, title: String(fromChunk.title ?? 'Knowledge') }] : [];
  const cards = rec && (rec.shopping || !hit.matched || rec.current) ? rec.cards : [];
  let answer = hit.answer;
  let confidence: 'high' | 'low' = hit.matched ? 'high' : 'low';
  if (rec?.current && (/\b(this|it|that)\b/i.test(query) || (opts.context ?? '').startsWith('product:'))) {
    const p = rec.current;
    answer = `${p.title}${p.price != null ? ` is ${money(p)}` : ''}${p.available === false ? ' and is out of stock right now' : ''}. ${sentences(String(p.description ?? ''), 2) || 'It is one of our most popular picks.'} I have added the card below so you can take a look.`;
    confidence = 'high';
  } else if (cards.length && !hit.matched) {
    answer = cards.length === 1 ? `Here is one that should fit: ${rec!.picked[0].title}${rec!.picked[0].price != null ? ` (${money(rec!.picked[0])})` : ''}.` : `Here are a few options that could work for you: ${rec!.picked.map((p) => p.title).join(', ')}.`;
    confidence = 'high';
  } else if (rec && rec.shopping && !cards.length && rec.search.max_price != null) {
    answer = `I could not find anything under ${rec.search.max_price} in the ${brand} catalogue right now. Would you like to see our most affordable options instead?`;
    confidence = 'low';
  }
  return { answer, confidence, sources, cards, product_id: rec?.current?.id ?? null, product_search: rec ? { ...rec.search, shopping: rec.shopping || cards.length > 0 } : null, handoff: false };
}

/** 069 outreach_webchat__handoff_match: the website's keywords, or asking for a person. */
export function handoffMatch(st: Row, text: string): boolean {
  const t = String(text ?? '');
  if (!t) return false;
  const kws: string[] = Array.isArray(st.ai?.handoff?.keywords) ? st.ai.handoff.keywords : [];
  if (kws.some((k) => k && t.toLowerCase().includes(String(k).toLowerCase()))) return true;
  return /\b(talk|speak|chat) (to|with) (a |an |someone|the )?(person|human|agent|rep|team|someone)\b/i.test(t) || /\b(real|live) (person|human|agent)\b/i.test(t);
}
