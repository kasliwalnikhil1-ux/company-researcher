'use client';

// Website assistant → {website} → Assistant → Products (web-chat-buttons-products-changes.md §7). The assistant
// recommends 1 to 6 products of the picked catalogues as cards. Saved as settings.ai.products (validated in 068);
// "Recommend products" needs a catalogue that has products in it.
import Link from '@/lib/outreach/nav';
import { useQuery } from '@tanstack/react-query';
import { rpc } from '@/lib/outreach/api';
import { hubHref } from '@/lib/outreach/aiHub';
import { PROVIDER_LABEL, catalogueHref, isProductSource, type CatalogueSourceLike } from '@/lib/outreach/catalogue';
import { PRODUCTS_DEFAULTS, type ProductsSettings } from '@/lib/outreach/webchat';
import { Badge, Card, Spinner } from '@/components/outreach/ui';
import { Note, SettingRow, Switch } from '@/components/outreach/settings/shared';
import { Label, SaveBar, field, useDraft, useSaveSettings, type SectionProps } from './sections';

const hostOf = (u: string | null | undefined) => { try { return new URL(/^https?:\/\//i.test(u ?? '') ? u! : `https://${u}`).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
/** The same rule the server applies (outreach_webchat__origin_ok): an exact host, or *.example.com. */
function allowedHost(host: string, domains: string[]): boolean {
  if (!host) return false;
  return domains.some((raw) => {
    const d = raw.toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[:/].*$/, '').replace(/^www\./, '');
    return d === host || (d.startsWith('*.') && (host === d.slice(2) || host.endsWith(`.${d.slice(2)}`)));
  });
}

export default function ProductsCard(p: SectionProps) {
  const { draft, set, dirty, reset } = useDraft<ProductsSettings>({ ...PRODUCTS_DEFAULTS, ...(p.inbox.settings.ai.products ?? {}) });
  const { save, saving } = useSaveSettings(p);
  const sources = useQuery({ queryKey: ['outreach', p.ws, 'knowledge-sources'], queryFn: () => rpc<CatalogueSourceLike[]>('knowledge_sources_list', { p_ws: p.ws }) });
  const catalogues = (sources.data ?? []).filter(isProductSource);
  const picked = catalogues.filter((c) => draft.catalogue_ids.includes(c.id));
  const withProducts = picked.filter((c) => Number(c.products ?? 0) > 0);
  // Add to cart is Shopify's own cart call from the page: only for a Shopify store that is one of this website's domains
  const cartStore = picked.find((c) => c.catalogue?.provider === 'shopify' && allowedHost(hostOf(c.catalogue.store ?? c.catalogue.url ?? c.url), p.inbox.allowed_domains));
  const toggle = (id: string) => set((d) => {
    const ids = d.catalogue_ids.includes(id) ? d.catalogue_ids.filter((x) => x !== id) : [...d.catalogue_ids, id];
    const left = catalogues.filter((c) => ids.includes(c.id) && Number(c.products ?? 0) > 0).length;
    return { ...d, catalogue_ids: ids, enabled: d.enabled && left > 0 };
  });
  const canEnable = withProducts.length > 0;

  return (
    <Card title="Products">
      <p className="text-xs text-gray-500 mb-3">The assistant can answer with product cards from your catalogue: picture, name, price, a View button and an Ask button. The cards are built from the catalogue, never from text the AI wrote. No extra AI cost: the call that writes the answer also picks the products.</p>
      <div className="divide-y divide-gray-100">
        <SettingRow title="Recommend products" description={canEnable ? 'When a visitor is looking for something to buy, or asks for options.' : 'Pick a catalogue that has products in it first.'}
          control={<Switch checked={draft.enabled && canEnable} onChange={(v) => set({ enabled: v })} label="Recommend products" disabled={!p.canEdit || !canEnable} />} />
      </div>

      <div className="mt-3">
        <Label hint="from AI → Knowledge">Catalogues</Label>
        {sources.isLoading && <Spinner />}
        {sources.data && catalogues.length === 0 && (
          <p className="text-xs text-gray-500">No product catalogue yet. Add your Shopify or WooCommerce store, a product feed or a CSV in <Link href={hubHref.knowledge()} className="text-indigo-700 hover:underline">AI → Knowledge</Link>, then pick it here.</p>
        )}
        <ul className="space-y-1">
          {catalogues.map((c) => {
            const n = Number(c.products ?? 0), syncing = c.kind === 'catalogue' && (c.status === 'pending' || c.status === 'crawling' || c.catalogue?.syncing);
            return (
              <li key={c.id} className="flex items-center gap-2 text-sm">
                <label className="flex min-w-0 items-center gap-2">
                  <input type="checkbox" checked={draft.catalogue_ids.includes(c.id)} disabled={!p.canEdit} onChange={() => toggle(c.id)} />
                  <span className="truncate">{c.title}</span>
                </label>
                <span className="text-xs text-gray-400 whitespace-nowrap">{PROVIDER_LABEL[c.catalogue?.provider ?? (c.kind === 'catalogue' ? 'feed' : 'crawl')]} · {n.toLocaleString()} {n === 1 ? 'product' : 'products'}{c.catalogue?.currency ? ` · ${c.catalogue.currency}` : ''}</span>
                {syncing && <Badge tone="blue">Syncing</Badge>}
                {c.kind === 'catalogue' && c.status === 'error' && <Badge tone="red">Failed</Badge>}
                <Link href={catalogueHref(c.id)} className="text-xs text-indigo-700 hover:underline">Products</Link>
              </li>
            );
          })}
        </ul>
        {picked.length > 0 && withProducts.length === 0 && <Note tone="amber" className="mt-2">The picked catalogue has no products yet. A new catalogue is read within a few minutes; recommending can be switched on once its products are in.</Note>}
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div><Label hint="1–6">Cards per answer</Label><input aria-label="Cards per answer" type="number" min={1} max={6} className={field} value={draft.max} onChange={(e) => set({ max: Math.min(6, Math.max(1, Math.round(Number(e.target.value)) || 3)) })} disabled={!p.canEdit} /></div>
      </div>
      <div className="divide-y divide-gray-100 mt-2">
        <SettingRow title="Show prices" description="With the old price struck through when the product is reduced." control={<Switch checked={draft.show_prices} onChange={(v) => set({ show_prices: v })} label="Show prices" disabled={!p.canEdit} />} />
        <SettingRow title="Include out-of-stock items" description="They carry an “Out of stock” tag on the card." control={<Switch checked={draft.include_oos} onChange={(v) => set({ include_oos: v })} label="Include out-of-stock items" disabled={!p.canEdit} />} />
        <SettingRow title="“Add to cart” button"
          description={cartStore ? `Adds the product to the cart of ${hostOf(cartStore.catalogue?.store ?? cartStore.catalogue?.url ?? cartStore.url)} without leaving the chat.` : 'Only for a Shopify catalogue whose store domain is one of this website’s allowed domains (General tab).'}
          control={<Switch checked={draft.add_to_cart && !!cartStore} onChange={(v) => set({ add_to_cart: v })} label="Add to cart button" disabled={!p.canEdit || !cartStore} />} />
        <SettingRow title="Add tracking to product links" description={<>Adds <code>utm_source=growthxai&amp;utm_medium=chat&amp;utm_campaign={p.inbox.name}</code> to the View link.</>} control={<Switch checked={draft.utm} onChange={(v) => set({ utm: v })} label="Tracking on product links" disabled={!p.canEdit} />} />
      </div>
      <SaveBar dirty={dirty} saving={saving} canEdit={p.canEdit} onReset={reset}
        onSave={() => save({ settings: { ai: { products: { ...draft, enabled: draft.enabled && canEnable, add_to_cart: draft.add_to_cart && !!cartStore } } } })} />
    </Card>
  );
}
