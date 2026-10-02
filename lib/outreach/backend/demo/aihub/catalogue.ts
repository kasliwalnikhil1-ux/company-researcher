/**
 * Fictional product catalogues for the demo: the seeded "Fernhill Studio" store (40 products of home-office gear) and
 * what a newly added catalogue "finds" when it syncs. Pictures are small generated SVG tiles (no photos), links use
 * example.com.
 */
import type { DemoStore, Row } from '../store';

export type DemoProduct = { handle: string; title: string; type: string; price: number; compare?: number; tags: string[]; description: string; options?: Row; available?: boolean };

const COLORS = ['#c7d2fe', '#fde68a', '#bbf7d0', '#fecaca', '#bae6fd', '#ddd6fe', '#fed7aa', '#e5e7eb'];

/** A small SVG tile with the product's initials: a stand-in picture that ships with the demo. */
export function tile(title: string, i: number): string {
  const initials = title.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><rect width='24' height='24' fill='${COLORS[i % COLORS.length]}'/><text x='12' y='15' font-size='7' text-anchor='middle' fill='#334155'>${initials}</text></svg>`;
  return `data:image/svg+xml,${svg.replace(/#/g, '%23')}`;
}

export const FERNHILL: DemoProduct[] = [
  { handle: 'oak-standing-desk', title: 'Oak Standing Desk', type: 'Desk', price: 649, compare: 749, tags: ['desk', 'standing', 'oak', 'bestseller'], description: 'Electric sit-stand desk with a solid oak top, two motors and four height presets.', options: { Size: ['120 cm', '140 cm', '160 cm'] } },
  { handle: 'walnut-standing-desk', title: 'Walnut Standing Desk', type: 'Desk', price: 729, tags: ['desk', 'standing', 'walnut'], description: 'Sit-stand desk with a walnut veneer top and a quiet dual-motor frame.', options: { Size: ['140 cm', '160 cm'] } },
  { handle: 'compact-writing-desk', title: 'Compact Writing Desk', type: 'Desk', price: 289, tags: ['desk', 'small space'], description: 'A 100 cm desk with one drawer, made for small rooms and corners.' },
  { handle: 'corner-desk-l', title: 'L-Shaped Corner Desk', type: 'Desk', price: 459, tags: ['desk', 'corner', 'large'], description: 'Two-part corner desk with room for two monitors and a laptop.' },
  { handle: 'ergo-task-chair', title: 'Ergo Task Chair', type: 'Chair', price: 389, compare: 449, tags: ['chair', 'ergonomic', 'bestseller'], description: 'Mesh back, adjustable lumbar support, 4D armrests and a seat slider.', options: { Color: ['Graphite', 'Sand'] } },
  { handle: 'linen-lounge-chair', title: 'Linen Lounge Chair', type: 'Chair', price: 529, tags: ['chair', 'lounge', 'reading'], description: 'A low reading chair in washed linen with a solid ash frame.' },
  { handle: 'drafting-stool', title: 'Drafting Stool', type: 'Chair', price: 219, tags: ['chair', 'stool', 'standing desk'], description: 'Tall stool with a foot ring, for standing desks and counters.' },
  { handle: 'kneeling-chair', title: 'Kneeling Chair', type: 'Chair', price: 179, tags: ['chair', 'ergonomic', 'posture'], description: 'Rocking kneeling chair in birch plywood with a wool cushion.' },
  { handle: 'arc-desk-lamp', title: 'Arc Desk Lamp', type: 'Lighting', price: 129, tags: ['lamp', 'lighting', 'desk'], description: 'Dimmable LED desk lamp with a long arm and three colour temperatures.', options: { Color: ['Black', 'Brass', 'White'] } },
  { handle: 'clamp-task-light', title: 'Clamp Task Light', type: 'Lighting', price: 89, tags: ['lamp', 'lighting', 'clamp'], description: 'A clamp-on task light that frees up the whole desk top.' },
  { handle: 'paper-floor-lamp', title: 'Paper Floor Lamp', type: 'Lighting', price: 159, tags: ['lamp', 'lighting', 'floor'], description: 'Soft paper shade on an oak stand: warm light for the corner of a room.' },
  { handle: 'monitor-light-bar', title: 'Monitor Light Bar', type: 'Lighting', price: 69, tags: ['lighting', 'monitor', 'desk'], description: 'Sits on top of a screen and lights the desk without glare.' },
  { handle: 'oak-monitor-stand', title: 'Oak Monitor Stand', type: 'Desk accessory', price: 99, tags: ['monitor', 'stand', 'oak', 'desk'], description: 'Raises a screen by 12 cm with room for a keyboard underneath.' },
  { handle: 'dual-monitor-arm', title: 'Dual Monitor Arm', type: 'Desk accessory', price: 179, tags: ['monitor', 'arm', 'desk'], description: 'Gas-spring arm for two screens up to 32 inches.' },
  { handle: 'laptop-riser', title: 'Aluminium Laptop Riser', type: 'Desk accessory', price: 59, tags: ['laptop', 'stand', 'desk'], description: 'Foldable riser that lifts a laptop to eye level.' },
  { handle: 'felt-desk-mat', title: 'Wool Felt Desk Mat', type: 'Desk accessory', price: 49, tags: ['desk mat', 'felt', 'desk'], description: 'Thick wool felt mat, 90 × 40 cm, in four colours.', options: { Color: ['Charcoal', 'Moss', 'Oat', 'Rust'] } },
  { handle: 'leather-desk-pad', title: 'Leather Desk Pad', type: 'Desk accessory', price: 89, tags: ['desk mat', 'leather', 'desk'], description: 'Vegetable-tanned leather pad that ages with use.' },
  { handle: 'cable-tray', title: 'Under-Desk Cable Tray', type: 'Cable management', price: 39, tags: ['cables', 'tidy', 'desk'], description: 'Steel tray that holds power strips and cables under the desk.' },
  { handle: 'cable-sleeve', title: 'Cable Sleeve Kit', type: 'Cable management', price: 19, tags: ['cables', 'tidy'], description: 'Zip sleeves and clips to bundle the cables of a standing desk.' },
  { handle: 'desk-power-hub', title: 'Desk Power Hub', type: 'Cable management', price: 79, tags: ['power', 'usb-c', 'desk'], description: 'Clamp-on hub with two sockets, two USB-C and one USB-A port.' },
  { handle: 'oak-pen-tray', title: 'Oak Pen Tray', type: 'Organiser', price: 29, tags: ['organiser', 'oak', 'desk'], description: 'A turned oak tray for pens, clips and keys.' },
  { handle: 'stacking-letter-trays', title: 'Stacking Letter Trays', type: 'Organiser', price: 45, tags: ['organiser', 'paper', 'desk'], description: 'Three powder-coated steel trays that stack in any order.' },
  { handle: 'wall-shelf-system', title: 'Wall Shelf System', type: 'Storage', price: 249, tags: ['shelf', 'storage', 'wall'], description: 'Rail-mounted shelves and a fold-down desk for small rooms.' },
  { handle: 'rolling-pedestal', title: 'Rolling Pedestal', type: 'Storage', price: 199, tags: ['storage', 'drawers', 'desk'], description: 'Three-drawer pedestal on castors that slides under most desks.' },
  { handle: 'oak-bookcase', title: 'Oak Bookcase', type: 'Storage', price: 389, tags: ['shelf', 'storage', 'oak'], description: 'Five-shelf solid oak bookcase, 180 cm tall.' },
  { handle: 'acoustic-panel-set', title: 'Acoustic Panel Set', type: 'Acoustics', price: 149, tags: ['acoustic', 'calls', 'quiet'], description: 'Six felt panels that cut echo on video calls.', options: { Color: ['Grey', 'Sage', 'Navy'] } },
  { handle: 'desk-divider', title: 'Desk Divider Screen', type: 'Acoustics', price: 119, tags: ['acoustic', 'privacy', 'desk'], description: 'Clamp-on felt screen for shared desks.' },
  { handle: 'webcam-light-kit', title: 'Video Call Light Kit', type: 'Lighting', price: 99, tags: ['lighting', 'calls', 'video'], description: 'Two small panels that light your face evenly on calls.' },
  { handle: 'wool-footrest', title: 'Wool Footrest', type: 'Comfort', price: 59, tags: ['footrest', 'ergonomic', 'comfort'], description: 'Firm wool-covered footrest that tilts with your feet.' },
  { handle: 'anti-fatigue-mat', title: 'Anti-Fatigue Standing Mat', type: 'Comfort', price: 79, compare: 95, tags: ['standing desk', 'mat', 'comfort'], description: 'Contoured mat for long stretches at a standing desk.' },
  { handle: 'lumbar-cushion', title: 'Lumbar Cushion', type: 'Comfort', price: 39, tags: ['cushion', 'ergonomic', 'chair'], description: 'Memory foam cushion that adds lower-back support to any chair.' },
  { handle: 'ceramic-mug', title: 'Stoneware Desk Mug', type: 'Desk accessory', price: 24, tags: ['mug', 'gift'], description: 'A heavy stoneware mug with a matching coaster.' },
  { handle: 'desk-plant-pot', title: 'Self-Watering Plant Pot', type: 'Decor', price: 34, tags: ['plant', 'decor', 'desk'], description: 'Small pot with a water reservoir that lasts two weeks.' },
  { handle: 'wall-clock', title: 'Minimal Wall Clock', type: 'Decor', price: 69, tags: ['clock', 'decor', 'wall'], description: 'Silent sweep movement in an ash frame.' },
  { handle: 'linen-notebook', title: 'Linen Notebook Set', type: 'Stationery', price: 32, tags: ['notebook', 'stationery', 'gift'], description: 'Three A5 notebooks with linen covers and dot-grid pages.' },
  { handle: 'brass-pen', title: 'Brass Ballpoint Pen', type: 'Stationery', price: 45, tags: ['pen', 'stationery', 'gift'], description: 'Solid brass pen that takes standard refills.' },
  { handle: 'desk-organiser-set', title: 'Desk Organiser Gift Set', type: 'Organiser', price: 99, compare: 119, tags: ['organiser', 'gift', 'bundle'], description: 'Pen tray, letter tray and felt mat in one box.' },
  { handle: 'home-office-bundle', title: 'Home Office Starter Bundle', type: 'Bundle', price: 999, compare: 1149, tags: ['bundle', 'desk', 'chair', 'lamp'], description: 'Oak standing desk, ergo task chair and arc desk lamp together.' },
  { handle: 'kids-study-desk', title: 'Kids Study Desk', type: 'Desk', price: 239, tags: ['desk', 'kids', 'adjustable'], description: 'Height-adjustable desk that grows with a child, ages 6 to 14.', available: false },
  { handle: 'outdoor-laptop-table', title: 'Balcony Laptop Table', type: 'Desk', price: 149, tags: ['desk', 'outdoor', 'small space'], description: 'Folding teak table for working on a balcony or terrace.', available: false },
];

const EXTRA: DemoProduct[] = [
  { handle: 'canvas-tote', title: 'Waxed Canvas Tote', type: 'Bag', price: 85, tags: ['bag', 'gift'], description: 'A waxed canvas tote with a laptop sleeve.' },
  { handle: 'travel-mug', title: 'Insulated Travel Mug', type: 'Drinkware', price: 32, tags: ['mug', 'travel'], description: 'Keeps coffee hot for six hours.' },
  { handle: 'wool-throw', title: 'Merino Wool Throw', type: 'Textile', price: 120, tags: ['throw', 'home'], description: 'A soft merino throw for the sofa or the reading chair.' },
  { handle: 'scented-candle', title: 'Cedar Scented Candle', type: 'Decor', price: 28, tags: ['candle', 'gift'], description: 'Soy wax candle with cedar and bergamot, 40 hours.' },
  { handle: 'oak-tray', title: 'Oak Serving Tray', type: 'Kitchen', price: 55, tags: ['tray', 'oak'], description: 'Solid oak tray with brass handles.' },
  { handle: 'linen-napkins', title: 'Linen Napkin Set', type: 'Textile', price: 36, tags: ['linen', 'table'], description: 'Four stonewashed linen napkins.' },
  { handle: 'glass-carafe', title: 'Glass Carafe', type: 'Drinkware', price: 42, tags: ['glass', 'table'], description: 'Hand-blown carafe with a matching cup lid.' },
  { handle: 'ceramic-vase', title: 'Ceramic Bud Vase', type: 'Decor', price: 26, tags: ['vase', 'decor'], description: 'Small matte vase for a single stem.' },
  { handle: 'cotton-rug', title: 'Flatweave Cotton Rug', type: 'Textile', price: 180, tags: ['rug', 'home'], description: 'A washable flatweave rug, 160 × 230 cm.' },
  { handle: 'walnut-board', title: 'Walnut Cutting Board', type: 'Kitchen', price: 65, tags: ['kitchen', 'walnut'], description: 'End-grain walnut board that is kind to knives.' },
  { handle: 'brass-hooks', title: 'Brass Wall Hooks', type: 'Decor', price: 22, tags: ['hooks', 'wall'], description: 'Set of three solid brass hooks.' },
  { handle: 'reading-light', title: 'Clip Reading Light', type: 'Lighting', price: 38, tags: ['lamp', 'reading'], description: 'Rechargeable clip-on light for books.' },
];

/** What a catalogue holds: the seeded store, or a smaller set for one the visitor adds (picked from the source's title). */
export function catalogueProducts(store: DemoStore, s: Row): DemoProduct[] {
  if (s.catalogue?.seeded) return FERNHILL;
  if (s.kind !== 'catalogue') return EXTRA.slice(0, 6);
  void store;
  const h = [...String(s.title ?? '')].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 11);
  const k = h % EXTRA.length;
  return [...EXTRA.slice(k), ...EXTRA.slice(0, k)].slice(0, 9);
}

export function productRow(s: Row, p: DemoProduct, i = 0): Row {
  const host = s.url ? String(s.url).replace(/^https?:\/\//, '').replace(/\/.*$/, '') : 'shop.example.com';
  const idx = FERNHILL.indexOf(p) >= 0 ? FERNHILL.indexOf(p) : EXTRA.indexOf(p) + 40 + i;
  return {
    workspace_id: s.workspace_id, source_id: s.id, external_id: `demo-${p.handle}`, handle: p.handle, sku: `FH-${String(1000 + idx)}`,
    url: `https://${/example\.com$/.test(host) ? host : 'shop.example.com'}/products/${p.handle}`, title: p.title, description: p.description,
    vendor: s.catalogue?.seeded ? 'Fernhill Studio' : s.title ?? null, product_type: p.type, tags: p.tags, options: p.options ?? {},
    price: p.price, compare_at_price: p.compare ?? null, currency: s.catalogue?.currency ?? 'USD', available: p.available !== false,
    image_url: tile(p.title, idx), images: [], variants: [{ id: `v-${p.handle}`, title: 'Default', price: p.price, available: p.available !== false, sku: `FH-${String(1000 + idx)}` }],
    pinned_keywords: [], ai_hidden: false,
  };
}

/** The card stored on a message (`outreach_product__card`). */
export function productCard(p: Row, provider: string | null | undefined): Row {
  const card: Row = { id: p.id, title: p.title, url: p.url, available: !!p.available };
  if (p.price != null) card.price = Number(p.price);
  if (p.compare_at_price != null && p.price != null && p.compare_at_price > p.price) card.compare_at = Number(p.compare_at_price);
  if (p.currency) card.currency = p.currency;
  if (p.image_url) card.image = p.image_url;
  if (provider === 'shopify' && p.available && p.variants?.[0]?.id) card.variant_id = String(p.variants[0].id);
  return card;
}

const STOP = new Set(['show', 'me', 'the', 'a', 'an', 'any', 'some', 'do', 'you', 'have', 'sell', 'i', 'want', 'need', 'looking', 'for', 'find', 'buy', 'is', 'are', 'there', 'what', 'which', 'can', 'please', 'of', 'in', 'on', 'to', 'with', 'and', 'or', 'under', 'below', 'price', 'cheap', 'something', 'good', 'best', 'my', 'our']);
const fold = (w: string) => w.replace(/(ies)$/, 'y').replace(/(es|s)$/, '');

/** `outreach_product__search` in the light form the agent's picker uses: word match on title / type / tags / vendor, pinned keywords first. */
export function searchProducts(store: DemoStore, sources: string[], query: string | null, opts: { maxPrice?: number | null; limit?: number; includeHidden?: boolean } = {}): Row[] {
  const words = String(query ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w)).map(fold);
  const srcs = new Map(store.t('outreach_knowledge_sources').map((s) => [s.id, s]));
  const scored: Array<{ p: Row; score: number }> = [];
  for (const p of store.t('outreach_products')) {
    if (!sources.includes(p.source_id) || p.deleted_at) continue;
    if (!opts.includeHidden && p.ai_hidden) continue;
    if (opts.maxPrice != null && p.price != null && Number(p.price) > opts.maxPrice) continue;
    let score = 0;
    if (words.length) {
      const hay = [p.title, p.product_type, p.vendor, ...(p.tags ?? [])].join(' ').toLowerCase().split(/[^a-z0-9]+/).map(fold);
      for (const w of words) { if (hay.includes(w)) score += String(p.title).toLowerCase().includes(w) ? 3 : 1; }
      for (const k of p.pinned_keywords ?? []) if (words.includes(fold(k))) score += 10;
      if (!score) continue;
    }
    scored.push({ p, score });
  }
  scored.sort((a, b) => b.score - a.score || Number(b.p.available) - Number(a.p.available) || String(a.p.title).localeCompare(String(b.p.title)));
  return scored.slice(0, opts.limit ?? 12).map(({ p }) => ({
    ...productCard(p, srcs.get(p.source_id)?.catalogue?.provider), product_type: p.product_type ?? null, vendor: p.vendor ?? null, tags: (p.tags ?? []).slice(0, 8),
    description: String(p.description ?? '').slice(0, 400), source_id: p.source_id, ai_hidden: !!p.ai_hidden,
  }));
}
