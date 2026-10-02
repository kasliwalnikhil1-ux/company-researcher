'use client';

// Knowledge → + Product catalogue (web-chat-buttons-products-changes.md §5.1): a Shopify store, a WooCommerce store, a
// product feed, or a CSV file. The catalogue is read in the background (the status shows when its products are in) and
// synced again every day; the caller opens "Use in…" for it next. Products a website's own pages describe are a switch
// on that website source ("Also find products"), not a catalogue of their own.
import { useRef, useState } from 'react';
import { CATALOGUE_CSV_COLUMNS, CATALOGUE_CSV_MAX_MB, CATALOGUE_MAX_PRODUCTS, downloadCsvTemplate, uploadCatalogueCsv, useCatalogueAdd, type CatalogueAddInput } from '@/lib/outreach/catalogue';
import { useInvalidateKnowledge } from '@/lib/outreach/aiHub';
import { Button, ErrorBox, Input, Modal } from '@/components/outreach/ui';
import { Note } from '@/components/outreach/settings/shared';
import { errText } from '@/components/outreach/sequences/ai/shared';
import { cn } from '@/lib/utils';
import type { AddedSource } from './AddSourceModals';
import type { Notify } from './shared';

type Provider = CatalogueAddInput['provider'];
const PROVIDERS: Array<{ key: Provider; label: string; field: string; placeholder: string; hint: string }> = [
  { key: 'shopify', label: 'Shopify store', field: 'Store address', placeholder: 'https://your-store.com', hint: 'Your store’s public address. No app to install: the store’s own product list is read.' },
  { key: 'woocommerce', label: 'WooCommerce store', field: 'Store address', placeholder: 'https://your-store.com', hint: 'Your store’s public address. Products are read through WooCommerce’s public store list.' },
  { key: 'feed', label: 'Product feed', field: 'Feed link', placeholder: 'https://your-store.com/feeds/google.xml', hint: 'A Google Shopping (Merchant) feed in XML, or a CSV / TSV feed with the same column names.' },
  { key: 'csv', label: 'CSV file', field: '', placeholder: '', hint: '' },
];

export default function AddCatalogueModal({ ws, onClose, onAdded, notify }: { ws: string; onClose: () => void; onAdded: (s: AddedSource) => void; notify: Notify }) {
  const add = useCatalogueAdd(ws);
  const invalidate = useInvalidateKnowledge(ws);
  const [provider, setProvider] = useState<Provider>('shopify');
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [currency, setCurrency] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cfg = PROVIDERS.find((x) => x.key === provider)!;

  const cur = currency.trim().toUpperCase();
  const curOk = cur === '' || /^[A-Z]{3}$/.test(cur);
  const urlOk = /^(https?:\/\/)?[^\s/]+\.[a-z]{2,}(\/\S*)?$/i.test(url.trim());
  const canSubmit = curOk && (provider === 'csv' ? !!file : urlOk);

  async function submit() {
    if (!canSubmit || busy) return;
    setBusy(true); setError(null);
    try {
      const storage_path = provider === 'csv' ? await uploadCatalogueCsv(ws, file!) : undefined;
      const s = await add.mutateAsync({ provider, title: title.trim() || (provider === 'csv' ? file!.name.replace(/\.[a-z]+$/i, '') : undefined), url: provider === 'csv' ? undefined : url.trim(), storage_path, currency: cur || undefined });
      invalidate();
      notify('Catalogue added. Its products are read in the background; the status shows when they are in.');
      if (s?.id) onAdded({ id: s.id, title: s.title }); else onClose();
    } catch (e) { setError(errText(e)); setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title="Add a product catalogue" size="md"
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={submit} loading={busy} disabled={!canSubmit}>Add</Button></>}>
      <div className="space-y-4">
        <p className="text-sm text-gray-600">The Website assistant recommends products from a catalogue as cards: picture, name, price and a link, taken from your store as it is.</p>
        <div role="tablist" aria-label="Where the products come from" className="flex flex-wrap gap-1 rounded-lg border border-gray-300 bg-gray-50 p-0.5">
          {PROVIDERS.map((x) => (
            <button key={x.key} type="button" role="tab" aria-selected={provider === x.key} disabled={busy} onClick={() => { setProvider(x.key); setError(null); }}
              className={cn('flex-1 whitespace-nowrap rounded-md px-3 py-1 text-sm', provider === x.key ? 'bg-white font-medium text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900')}>{x.label}</button>
          ))}
        </div>

        {provider === 'csv' ? (
          <div className="space-y-3">
            <input ref={fileRef} type="file" accept=".csv,.tsv,text/csv,text/tab-separated-values" className="hidden" aria-label="CSV file to upload" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()} disabled={busy}>Choose a file</Button>
              <span className="min-w-0 truncate text-sm text-gray-700">{file ? `${file.name} (${Math.max(1, Math.round(file.size / 1024))} KB)` : 'No file chosen'}</span>
              <button type="button" onClick={downloadCsvTemplate} className="ml-auto text-xs font-medium text-indigo-700 hover:underline">Download the template</button>
            </div>
            <Note>Columns: <code className="break-words">{CATALOGUE_CSV_COLUMNS.join(', ')}</code>. <b>title</b> and <b>link</b> are needed on every row; <b>price</b> is the regular price and <b>sale_price</b> the reduced one. Up to {CATALOGUE_CSV_MAX_MB} MB. To change the catalogue later, upload a new file on its page.</Note>
          </div>
        ) : (
          <Input label={cfg.field} value={url} onChange={(e) => setUrl(e.target.value)} placeholder={cfg.placeholder} hint={cfg.hint} autoFocus />
        )}
        <Input label="Name (optional)" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder={provider === 'csv' ? 'Defaults to the file name' : 'Defaults to the site name'} />
        <Input label="Currency (optional)" value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value)} placeholder="Taken from the store"
          hint="A three-letter code, like USD or INR. Leave empty to use the currency the store or the feed states." error={curOk ? undefined : 'Three letters, like USD or INR.'} />
        <p className="text-xs text-gray-500">Up to {CATALOGUE_MAX_PRODUCTS.toLocaleString()} products per catalogue. A store or a feed is read again every day; products it no longer lists are not offered any more.</p>
        {error && <ErrorBox message={error} />}
      </div>
    </Modal>
  );
}
