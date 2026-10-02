'use client';

// Product catalogues and product cards (web-chat-buttons-products-changes.md §5–§9; migration 068).
// A catalogue is a knowledge source of kind 'catalogue' (a Shopify or WooCommerce store, a product feed, a CSV), or a
// website source with "Also find products" on. Every hook maps to one `outreach_hub_*` RPC.

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { db } from '@/lib/outreach/backend';
import { parseError, rpc } from './api';

export type CatalogueProvider = 'shopify' | 'woocommerce' | 'feed' | 'csv' | 'crawl';
/** `catalogue` on a knowledge source, as outreach__ks_json returns it. */
export interface CatalogueState {
  provider: CatalogueProvider; url?: string | null; store?: string | null; currency?: string | null; currency_locked?: boolean;
  products?: number; synced_at?: string | null; complete?: boolean; warning?: string | null; last_error?: string | null; last_error_at?: string | null; syncing?: boolean;
}
/** The part of a knowledge source the catalogue screens read. */
export interface CatalogueSourceLike {
  id: string; kind: string; title: string; url: string | null; status: 'pending' | 'crawling' | 'ready' | 'error'; error: string | null;
  refresh_days: number | null; crawled_at: string | null; detect_products?: boolean; catalogue?: CatalogueState | null; products?: number | null; used_by?: number;
}
/** A card as it is stored on a message and drawn by the widget and the inbox: catalogue data, never AI-written text. */
export interface ProductCard { id: string; title: string; price?: number; compare_at?: number; currency?: string; url: string; image?: string; available: boolean; variant_id?: string }
/** A search result (the agent's Product button). */
export interface ProductHit extends ProductCard { product_type?: string | null; vendor?: string | null; tags?: string[]; description?: string; source_id: string; ai_hidden?: boolean }
/** A row of the catalogue's table. */
export interface CatalogueProductRow {
  id: string; title: string; url: string; image: string | null; price: number | null; compare_at: number | null; currency: string | null; available: boolean;
  product_type: string | null; vendor: string | null; sku: string | null; handle: string | null; variants: number; seen_at: string; ai_hidden: boolean; pinned_keywords: string[];
}
export interface CataloguePage { source: CatalogueSourceLike; total: number; hidden: number; products: CatalogueProductRow[] }

export const PROVIDER_LABEL: Record<CatalogueProvider, string> = { shopify: 'Shopify store', woocommerce: 'WooCommerce store', feed: 'Product feed', csv: 'CSV file', crawl: 'Found on the website' };
export const CATALOGUE_MAX_PRODUCTS = 10_000;
export const CATALOGUE_PAGE = 50;
export const MAX_CARDS = 6;

/** A source the Website assistant can recommend from: a catalogue, or a website that also finds products. */
export const isProductSource = (s: { kind: string; detect_products?: boolean }) => s.kind === 'catalogue' || !!s.detect_products;
export const catalogueHref = (id: string) => `/outreach/ai/knowledge/catalogue/${id}`;

/** "₹45,000", "$49.90": the product's own currency; a bare number when the catalogue has none. */
export function fmtMoney(amount: number | null | undefined, currency: string | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return '';
  const digits = Number.isInteger(amount) ? 0 : 2;
  try { if (currency) return new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount); } catch { /* not a currency code */ }
  return `${currency ? `${currency} ` : ''}${amount.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export const ck = {
  products: (source: string, q: string, page: number) => ['outreach', 'catalogue', source, 'products', q, page] as const,
  source: (source: string) => ['outreach', 'catalogue', source] as const,
  search: (ws: string, inbox: string | null, q: string) => ['outreach', ws, 'product-search', inbox, q] as const,
};

/** The catalogue's table, one page at a time. Polls while a sync is running, so the count grows on screen. */
export function useCatalogueProducts(sourceId: string | null | undefined, query: string, page: number) {
  return useQuery({
    queryKey: ck.products(sourceId ?? '', query, page), enabled: !!sourceId, placeholderData: keepPreviousData,
    queryFn: () => rpc<CataloguePage>('hub_catalogue_products', { p_source: sourceId, p_query: query.trim() || null, p_limit: CATALOGUE_PAGE, p_offset: page * CATALOGUE_PAGE }),
    refetchInterval: (q) => { const s = q.state.data?.source; return s && (s.status === 'pending' || s.status === 'crawling' || s.catalogue?.syncing) ? 5000 : false; },
  });
}

function useAfterCatalogueWrite(ws: string | null | undefined) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['outreach', 'catalogue'] });
    if (ws) {
      qc.invalidateQueries({ queryKey: ['outreach', ws, 'ai-hub', 'knowledge'] });
      qc.invalidateQueries({ queryKey: ['outreach', ws, 'knowledge-sources'] });
      qc.invalidateQueries({ queryKey: ['outreach', ws, 'ai-knowledge'] });
    }
  };
}

export interface CatalogueAddInput { provider: Exclude<CatalogueProvider, 'crawl'>; title?: string; url?: string; storage_path?: string; currency?: string }
export function useCatalogueAdd(ws: string | null | undefined) {
  const after = useAfterCatalogueWrite(ws);
  return useMutation({
    mutationFn: (a: CatalogueAddInput) => rpc<CatalogueSourceLike>('hub_catalogue_add', { p_ws: ws, p_provider: a.provider, p_title: a.title?.trim() || null, p_url: a.url?.trim() || null, p_storage_path: a.storage_path ?? null, p_currency: a.currency?.trim() || null }),
    onSuccess: after,
  });
}
/** {sync: true} = Sync now · {currency: 'USD' | null} · {title} · {refresh_days} · {storage_path} (a new CSV) · {detect_products} on a website source. */
export type CataloguePatch = Partial<{ sync: boolean; currency: string | null; title: string; refresh_days: number | null; storage_path: string; detect_products: boolean }>;
export function useCatalogueUpdate(ws: string | null | undefined) {
  const after = useAfterCatalogueWrite(ws);
  return useMutation({ mutationFn: (a: { id: string; patch: CataloguePatch }) => rpc<CatalogueSourceLike>('hub_catalogue_update', { p_source: a.id, p_patch: a.patch }), onSuccess: after });
}
/** Hide a product from the AI, or pin it for a few keywords. */
export function useProductSet(ws: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { id: string; ai_hidden?: boolean; pinned_keywords?: string[] }) => rpc<{ id: string; ai_hidden: boolean; pinned_keywords: string[] }>('hub_product_set', { p_id: a.id, p_ai_hidden: a.ai_hidden ?? null, p_pinned_keywords: a.pinned_keywords ?? null }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['outreach', 'catalogue'] }); if (ws) qc.invalidateQueries({ queryKey: ['outreach', ws, 'product-search'] }); },
  });
}

/** The agent's Product button: the website's catalogues, by text (an empty text lists them). */
export function useProductSearch(ws: string | null | undefined, inboxId: string | null | undefined, query: string, enabled = true) {
  return useQuery({
    queryKey: ck.search(ws ?? '', inboxId ?? null, query), enabled: !!ws && enabled, placeholderData: keepPreviousData, staleTime: 30_000,
    queryFn: () => rpc<ProductHit[]>('hub_product_search', { p_ws: ws, p_query: query.trim() || null, p_max_price: null, p_source: null, p_inbox: inboxId ?? null, p_limit: 24 }),
  });
}
/**
 * Send product cards into a website chat as the agent. With `suggestionId`: the Review suggestion's text with the cards
 * the agent kept (ids out of the suggestion's own snapshot); without: products picked from the catalogue.
 */
export const sendProducts = (a: { chatId: string; productIds: string[]; text?: string | null; suggestionId?: string | null }) =>
  rpc<Record<string, unknown>>('hub_webchat_send_products', { p_chat: a.chatId, p_product_ids: a.productIds, p_text: a.text?.trim() || null, p_suggestion: a.suggestionId ?? null });

// ---------------------------------------------------------------------------
// CSV upload
// ---------------------------------------------------------------------------
export const CATALOGUE_CSV_COLUMNS = ['id', 'title', 'description', 'link', 'image_link', 'price', 'sale_price', 'currency', 'availability', 'brand', 'product_type', 'tags'] as const;
export const CATALOGUE_CSV_TEMPLATE = `${CATALOGUE_CSV_COLUMNS.join(',')}\n` +
  'SKU-1,Polki Choker Set,Uncut diamond choker with matching earrings,https://your-store.com/products/polki-choker-set,https://your-store.com/images/polki.jpg,52000,45000,INR,in stock,Aurum,Necklace,"bridal, polki"\n';
export const CATALOGUE_CSV_MAX_MB = 20;
/** Upload a catalogue CSV / TSV to the private knowledge bucket under `<ws>/catalogue/<ts>-<name>` and return its path. */
export async function uploadCatalogueCsv(ws: string, file: File): Promise<string> {
  if (!/\.(csv|tsv|txt)$/i.test(file.name)) throw new Error('Use a .csv or .tsv file.');
  if (file.size > CATALOGUE_CSV_MAX_MB * 1048576) throw new Error(`That file is ${(file.size / 1048576).toFixed(1)} MB. The limit is ${CATALOGUE_CSV_MAX_MB} MB.`);
  const path = `${ws}/catalogue/${Date.now()}-${file.name.replace(/[^\w.-]+/g, '_').slice(-80)}`;
  const { error } = await db.storage.from('outreach-knowledge').upload(path, file, { contentType: /\.tsv$/i.test(file.name) ? 'text/tab-separated-values' : 'text/csv', upsert: false });
  if (error) throw new Error(`Could not upload ${file.name}: ${parseError(error).message}`);
  return path;
}
export function downloadCsvTemplate(): void {
  const url = URL.createObjectURL(new Blob([CATALOGUE_CSV_TEMPLATE], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = 'product-catalogue-template.csv'; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** The hosts a catalogue's pictures come from: the Installation tab lists them for a site's Content-Security-Policy. */
export function imageHosts(urls: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const u of urls) { try { if (u) out.add(new URL(u).origin); } catch { /* not a link */ } }
  return [...out].sort();
}
