'use client';

// AI → Knowledge → {catalogue} (web-chat-buttons-products-changes.md §5.2): the catalogue's products in a searchable
// table. No product editing: the store is the source of truth. Two things are the team's own and survive every sync:
// Hide from AI (never recommended) and Pin for… (a few keywords; a pinned product is boosted for questions with them).
import { useEffect, useRef, useState } from 'react';
import Link from '@/lib/outreach/nav';
import { ArrowLeft, EyeOff, Loader2, Pin, RefreshCw, Search, Upload } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { hubHref } from '@/lib/outreach/aiHub';
import {
  CATALOGUE_PAGE, PROVIDER_LABEL, uploadCatalogueCsv, useCatalogueProducts, useCatalogueUpdate, useProductSet, type CatalogueProductRow, type CatalogueSourceLike,
} from '@/lib/outreach/catalogue';
import { Badge, Button, EmptyState, ErrorBox, Input, Modal, Spinner, Table, Td, Th, fmtDate, timeAgo, useToast } from '@/components/outreach/ui';
import { Note } from '@/components/outreach/settings/shared';
import { errText, plural } from '@/components/outreach/sequences/ai/shared';
import { ProductImage, ProductPrice } from '@/components/outreach/products/ProductCards';
import { cn } from '@/lib/utils';

function PinModal({ product, ws, onClose, notify }: { product: CatalogueProductRow; ws: string; onClose: () => void; notify: (m: string, t?: 'success' | 'error') => void }) {
  const setProduct = useProductSet(ws);
  const [text, setText] = useState(product.pinned_keywords.join(', '));
  const [error, setError] = useState<string | null>(null);
  const words = [...new Set(text.split(/[,\n]/).map((w) => w.trim().toLowerCase()).filter(Boolean))];
  const bad = words.length > 10 ? 'Up to 10 keywords.' : words.some((w) => w.length > 40) ? 'A keyword is 40 characters at most.' : null;
  async function save() {
    if (bad) return;
    setError(null);
    try { await setProduct.mutateAsync({ id: product.id, pinned_keywords: words }); notify(words.length ? 'Pinned.' : 'Pin removed.'); onClose(); }
    catch (e) { setError(errText(e)); }
  }
  return (
    <Modal open onClose={onClose} title={`Pin “${product.title}” for…`} size="md"
      footer={<><Button variant="secondary" onClick={onClose} disabled={setProduct.isPending}>Cancel</Button><Button onClick={save} loading={setProduct.isPending} disabled={!!bad}>Save</Button></>}>
      <div className="space-y-3">
        <p className="text-sm text-gray-600">When a visitor&rsquo;s question contains one of these words, this product moves to the front of what the assistant may recommend. For example a bestseller for &ldquo;gift&rdquo;.</p>
        <Input label="Keywords" value={text} onChange={(e) => setText(e.target.value)} placeholder="gift, anniversary, bestseller" hint="Separate with commas. Leave empty to remove the pin." error={bad ?? undefined} autoFocus />
        {error && <ErrorBox message={error} />}
      </div>
    </Modal>
  );
}

function Header({ s, ws, canEdit, hidden, notify }: { s: CatalogueSourceLike; ws: string; canEdit: boolean; hidden: number; notify: (m: string, t?: 'success' | 'error') => void }) {
  const update = useCatalogueUpdate(ws);
  const c = s.catalogue, isCat = s.kind === 'catalogue', syncing = isCat && (s.status === 'pending' || s.status === 'crawling' || !!c?.syncing);
  const [currency, setCurrency] = useState(c?.currency_locked ? c.currency ?? '' : '');
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const run = async (patch: Parameters<typeof update.mutateAsync>[0]['patch'], done: string) => { try { await update.mutateAsync({ id: s.id, patch }); notify(done); } catch (e) { notify(errText(e), 'error'); } };
  const cur = currency.trim().toUpperCase(), curChanged = cur !== (c?.currency_locked ? c.currency ?? '' : ''), curOk = cur === '' || /^[A-Z]{3}$/.test(cur);
  async function replaceFile(file: File | null) {
    if (!file) return;
    setUploading(true);
    try { const path = await uploadCatalogueCsv(ws, file); await update.mutateAsync({ id: s.id, patch: { storage_path: path } }); notify('File uploaded. The catalogue is being read again.'); }
    catch (e) { notify(errText(e), 'error'); }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = ''; }
  }
  const n = Number(s.products ?? 0);
  return (
    <div className="mb-4 rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-base font-semibold text-gray-900" title={s.title}>{s.title}</h2>
            <Badge tone="gray">{PROVIDER_LABEL[c?.provider ?? (isCat ? 'feed' : 'crawl')]}</Badge>
            {syncing ? <span className="inline-flex items-center gap-1 text-xs text-indigo-700"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Syncing…</span>
              : isCat && s.status === 'error' ? <Badge tone="red">Failed</Badge> : null}
          </div>
          <p className="mt-1 text-sm text-gray-600">
            {n.toLocaleString()} {plural(n, 'product')}{hidden > 0 ? `, ${hidden.toLocaleString()} hidden from the AI` : ''}
            {c?.synced_at && <> · last synced <span title={fmtDate(c.synced_at)}>{timeAgo(c.synced_at)}</span></>}
            {isCat && s.refresh_days ? ` · synced again every ${s.refresh_days === 1 ? 'day' : `${s.refresh_days} days`}` : ''}
            {c?.currency ? ` · ${c.currency}` : ''}
          </p>
          {(c?.store || s.url) && /^https?:\/\//i.test(c?.store ?? s.url ?? '') && <a href={(c?.store ?? s.url)!} target="_blank" rel="noopener noreferrer" className="text-xs text-gray-500 hover:text-indigo-700 hover:underline">{(c?.store ?? s.url)!.replace(/^https?:\/\//, '')}</a>}
        </div>
        {canEdit && isCat && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-32">
              <Input label="Currency" value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value)} placeholder={c?.currency ?? 'From the store'} error={curOk ? undefined : 'Like USD'} />
            </div>
            {curChanged && curOk && <Button size="sm" variant="secondary" loading={update.isPending} onClick={() => run({ currency: cur || null }, cur ? `Prices are shown in ${cur}.` : 'The store’s own currency is used again from the next sync.')}>Save</Button>}
            {c?.provider === 'csv' ? (
              <>
                <input ref={fileRef} type="file" accept=".csv,.tsv,text/csv,text/tab-separated-values" className="hidden" aria-label="New CSV file" onChange={(e) => replaceFile(e.target.files?.[0] ?? null)} />
                <Button size="sm" variant="secondary" loading={uploading} disabled={syncing} onClick={() => fileRef.current?.click()}><Upload className="mr-1 h-3.5 w-3.5" aria-hidden="true" />Upload a new file</Button>
              </>
            ) : (
              <Button size="sm" variant="secondary" loading={update.isPending && !curChanged} disabled={syncing} onClick={() => run({ sync: true }, 'Sync started. New and changed products appear here in a few minutes.')}><RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden="true" />Sync now</Button>
            )}
          </div>
        )}
      </div>
      {isCat && s.status === 'error' && <Note tone="amber" className="mt-3">{s.error ?? 'The catalogue could not be read.'}{n > 0 ? ' The products from the last sync are still used.' : ''}</Note>}
      {c?.warning && <Note tone="amber" className="mt-3">{c.warning}</Note>}
      {!isCat && <Note className="mt-3">These products were found on the pages of this website source (&ldquo;Also find products&rdquo;). They are read again whenever the website is.</Note>}
    </div>
  );
}

export default function CatalogueView({ sourceId }: { sourceId: string }) {
  const { workspace, isManager, canWrite } = useWorkspace();
  const ws = workspace?.id ?? '';
  const canEdit = isManager && canWrite;
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(0);
  const [pin, setPin] = useState<CatalogueProductRow | null>(null);
  useEffect(() => { const t = setTimeout(() => { setDebounced(query); setPage(0); }, 250); return () => clearTimeout(t); }, [query]);
  const q = useCatalogueProducts(sourceId, debounced, page);
  const setProduct = useProductSet(ws);
  const d = q.data;
  const pages = d ? Math.max(1, Math.ceil(d.total / CATALOGUE_PAGE)) : 1;

  async function toggleHidden(p: CatalogueProductRow) {
    try { await setProduct.mutateAsync({ id: p.id, ai_hidden: !p.ai_hidden }); toast.show(p.ai_hidden ? 'The assistant may recommend it again.' : 'Hidden from the AI. It is never recommended.'); }
    catch (e) { toast.show(errText(e), 'error'); }
  }

  return (
    <div>
      <Link href={hubHref.knowledge()} className="mb-3 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900"><ArrowLeft className="h-4 w-4" aria-hidden="true" />Knowledge</Link>
      {q.isLoading ? <Spinner /> : q.error ? <ErrorBox message={errText(q.error)} /> : d ? (
        <>
          <Header s={d.source} ws={ws} canEdit={canEdit} hidden={d.hidden} notify={toast.show} />
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <div className="relative w-full max-w-sm">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" aria-hidden="true" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name, type, brand or SKU" aria-label="Search products"
                className="w-full rounded-lg border border-gray-300 py-2 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
            <span className="text-xs text-gray-500">{d.total.toLocaleString()} {plural(d.total, 'product')}{debounced.trim() ? ' found' : ''}</span>
            {q.isFetching && <Loader2 className="h-4 w-4 animate-spin text-gray-400" aria-hidden="true" />}
          </div>
          <Table>
            <thead>
              <tr>
                <Th>Product</Th><Th className="w-36">Price</Th><Th className="w-28">In stock</Th><Th className="w-40">Type</Th><Th className="w-32">Last seen</Th>
                {canEdit && <Th className="w-px"><span className="sr-only">Actions</span></Th>}
              </tr>
            </thead>
            <tbody>
              {d.products.length === 0 && (
                <tr><td colSpan={canEdit ? 6 : 5} className="border-b border-gray-100">
                  <EmptyState title={debounced.trim() ? 'No product matches that' : 'No products yet'}
                    description={debounced.trim() ? 'Try a shorter search.' : d.source.status === 'error' ? 'The catalogue could not be read. See the message above.' : 'A new catalogue is read within a few minutes. This page updates by itself.'} />
                </td></tr>
              )}
              {d.products.map((p) => (
                <tr key={p.id} className={cn('align-middle', p.ai_hidden && 'bg-gray-50/60')}>
                  <Td>
                    <div className="flex items-center gap-3">
                      <ProductImage src={p.image} title={p.title} className="h-10 w-10 flex-shrink-0 rounded-md text-sm" />
                      <div className="min-w-0">
                        <a href={p.url} target="_blank" rel="noopener noreferrer" className={cn('block max-w-[26rem] truncate font-medium hover:text-indigo-700 hover:underline', p.ai_hidden ? 'text-gray-500' : 'text-gray-900')} title={p.title}>{p.title}</a>
                        <div className="flex flex-wrap items-center gap-1.5 text-xs text-gray-500">
                          {p.vendor && <span>{p.vendor}</span>}
                          {p.variants > 1 && <span>{p.variants} variants</span>}
                          {p.ai_hidden && <Badge tone="gray">Hidden from AI</Badge>}
                          {p.pinned_keywords.length > 0 && <Badge tone="indigo">Pinned for {p.pinned_keywords.join(', ')}</Badge>}
                        </div>
                      </div>
                    </div>
                  </Td>
                  <Td className="whitespace-nowrap"><ProductPrice p={{ price: p.price ?? undefined, compare_at: p.compare_at ?? undefined, currency: p.currency ?? undefined }} /></Td>
                  <Td>{p.available ? 'Yes' : <span className="text-amber-700">Out of stock</span>}</Td>
                  <Td className="max-w-[10rem] truncate" title={p.product_type ?? undefined}>{p.product_type ?? <span className="text-gray-400">—</span>}</Td>
                  <Td className="whitespace-nowrap text-gray-500" title={fmtDate(p.seen_at)}>{timeAgo(p.seen_at)}</Td>
                  {canEdit && (
                    <Td className="whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1.5">
                        <Button size="sm" variant="ghost" onClick={() => toggleHidden(p)} disabled={setProduct.isPending} aria-pressed={p.ai_hidden}><EyeOff className="mr-1 h-3.5 w-3.5" aria-hidden="true" />{p.ai_hidden ? 'Show to AI' : 'Hide from AI'}</Button>
                        <Button size="sm" variant="ghost" onClick={() => setPin(p)}><Pin className="mr-1 h-3.5 w-3.5" aria-hidden="true" />Pin for…</Button>
                      </div>
                    </Td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
          {pages > 1 && (
            <div className="mt-3 flex items-center justify-end gap-2 text-sm text-gray-600">
              <Button size="sm" variant="secondary" disabled={page === 0} onClick={() => setPage((x) => Math.max(0, x - 1))}>Previous</Button>
              <span>Page {page + 1} of {pages}</span>
              <Button size="sm" variant="secondary" disabled={page + 1 >= pages} onClick={() => setPage((x) => x + 1)}>Next</Button>
            </div>
          )}
          {!canEdit && <p className="mt-2 text-xs text-gray-500">Owners and managers hide and pin products.</p>}
        </>
      ) : null}
      {pin && <PinModal product={pin} ws={ws} onClose={() => setPin(null)} notify={toast.show} />}
      {toast.node}
    </div>
  );
}
