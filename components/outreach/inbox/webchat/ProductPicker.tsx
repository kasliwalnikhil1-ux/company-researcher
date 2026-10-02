'use client';

// Website chats: the agent's Product button (web-chat-buttons-products-changes.md §9). Search the website's catalogues,
// pick 1 to 6 products, send them as cards. The cards are built on the server from the catalogue, never from text.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Check, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { parseError } from '@/lib/outreach/api';
import { MAX_CARDS, sendProducts, useProductSearch, type ProductHit } from '@/lib/outreach/catalogue';
import { hubHref } from '@/lib/outreach/aiHub';
import { Button, ErrorBox, Modal, Spinner } from '@/components/outreach/ui';
import { ProductImage, ProductPrice } from '@/components/outreach/products/ProductCards';

export default function ProductPicker({ ws, chatId, inboxId, text, onClose, onSent }: {
  ws: string; chatId: string; inboxId: string | null;
  /** What is in the reply box: sent as a line above the cards. */
  text: string; onClose: () => void;
  /** `usedText`: the reply box's text went out with the cards. */
  onSent: (usedText: boolean) => void;
}) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [picked, setPicked] = useState<ProductHit[]>([]);
  const [withText, setWithText] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { const t = setTimeout(() => setDebounced(query), 250); return () => clearTimeout(t); }, [query]);
  const q = useProductSearch(ws, inboxId, debounced);
  const hits = q.data ?? [];
  const line = text.trim();
  const full = picked.length >= MAX_CARDS;

  const toggle = (p: ProductHit) => setPicked((cur) => (cur.some((x) => x.id === p.id) ? cur.filter((x) => x.id !== p.id) : cur.length >= MAX_CARDS ? cur : [...cur, p]));

  async function send() {
    if (!picked.length || busy) return;
    setBusy(true); setError(null);
    try {
      const usedText = withText && !!line;
      await sendProducts({ chatId, productIds: picked.map((p) => p.id), text: usedText ? line : null });
      onSent(usedText);
    } catch (e) { setError(parseError(e).message); setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title="Send products" size="lg"
      footer={(
        <>
          <span className="mr-auto text-xs text-gray-500">{picked.length} of {MAX_CARDS} picked{picked.length ? ', sent in this order' : ''}</span>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={send} loading={busy} disabled={!picked.length}>Send {picked.length || ''} {picked.length === 1 ? 'card' : 'cards'}</Button>
        </>
      )}>
      <div className="space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" aria-hidden="true" />
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search products by name, type, tag or brand" aria-label="Search products"
            className="w-full rounded-lg border border-gray-300 py-2 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
        </div>
        {q.isLoading ? <Spinner className="py-8" /> : q.error ? <ErrorBox message={parseError(q.error).message} /> : hits.length === 0 ? (
          <p className="py-6 text-center text-sm text-gray-500">
            {debounced.trim() ? 'No product matches that.' : <>No product catalogue yet. Add one in <Link href={hubHref.knowledge()} className="text-indigo-700 hover:underline">AI → Knowledge</Link>.</>}
          </p>
        ) : (
          <ul className={cn('grid max-h-[22rem] grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3', q.isFetching && 'opacity-70')} aria-label="Products">
            {hits.map((p) => {
              const at = picked.findIndex((x) => x.id === p.id), on = at >= 0;
              return (
                <li key={p.id}>
                  <button type="button" onClick={() => toggle(p)} disabled={!on && full} aria-pressed={on} title={!on && full ? `Up to ${MAX_CARDS} products in one message` : p.title}
                    className={cn('relative flex w-full gap-2 rounded-lg border p-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500',
                      on ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 bg-white hover:border-gray-300', !on && full && 'opacity-50')}>
                    <ProductImage src={p.image} title={p.title} className="h-14 w-14 flex-shrink-0 rounded-md text-lg" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-medium leading-snug text-gray-900 line-clamp-2">{p.title}</span>
                      <ProductPrice p={p} className="mt-0.5 block text-xs text-gray-700" />
                      <span className="block text-[11px] text-gray-500">{[p.product_type, p.available === false ? 'Out of stock' : null, p.ai_hidden ? 'Hidden from AI' : null].filter(Boolean).join(' · ')}</span>
                    </span>
                    {on && <span className="absolute right-1.5 top-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full bg-indigo-600 text-[10px] font-semibold text-white" aria-hidden="true">{picked.length > 1 ? at + 1 : <Check className="h-3 w-3" />}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {line && (
          <label className="flex items-start gap-2 text-sm text-gray-700">
            <input type="checkbox" className="mt-0.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" checked={withText} onChange={(e) => setWithText(e.target.checked)} />
            <span className="min-w-0">Send the text in the reply box above the cards: <span className="text-gray-500">&ldquo;{line.length > 120 ? `${line.slice(0, 119)}…` : line}&rdquo;</span></span>
          </label>
        )}
        {error && <ErrorBox message={error} />}
      </div>
    </Modal>
  );
}
