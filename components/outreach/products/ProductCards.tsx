'use client';

// Product cards as the team sees them (web-chat-buttons-products-changes.md §9): on an answer in the inbox thread, on a
// Review suggestion (each card removable before sending), in the Product picker and in the website report. The same
// snapshot the widget draws: picture, name, price, a link to the product. Built from catalogue data only.
import { useState } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fmtMoney, type ProductCard } from '@/lib/outreach/catalogue';

const httpUrl = (u: string | null | undefined) => (u && /^https?:\/\//i.test(u) ? u : null);

/** A product picture; a broken or missing one becomes the product's first letter on a soft background. */
export function ProductImage({ src, title, className }: { src?: string | null; title: string; className?: string }) {
  const [broken, setBroken] = useState(false);
  const url = httpUrl(src);
  if (!url || broken) {
    return <div aria-hidden="true" className={cn('flex items-center justify-center bg-gradient-to-br from-indigo-100 to-indigo-200 text-indigo-700 font-semibold select-none', className)}>{title.trim().charAt(0).toUpperCase() || '•'}</div>;
  }
  // eslint-disable-next-line @next/next/no-img-element -- pictures come from any store's own host
  return <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} className={cn('object-cover bg-gray-100', className)} />;
}

export function ProductPrice({ p, className }: { p: Pick<ProductCard, 'price' | 'compare_at' | 'currency'>; className?: string }) {
  if (typeof p.price !== 'number') return <span className={cn('text-gray-400', className)}>No price</span>;
  return (
    <span className={cn('tabular-nums', className)}>
      <span className="font-medium">{fmtMoney(p.price, p.currency)}</span>
      {typeof p.compare_at === 'number' && p.compare_at > p.price && <s className="ml-1.5 text-gray-400 font-normal">{fmtMoney(p.compare_at, p.currency)}</s>}
    </span>
  );
}

/** A row of cards. `onRemove` puts a ✕ on each (a Review suggestion: the agent removes cards before sending). */
export default function ProductCards({ cards, onRemove, className }: { cards: ProductCard[]; onRemove?: (id: string) => void; className?: string }) {
  if (!cards.length) return null;
  return (
    <ul className={cn('flex gap-2 overflow-x-auto pb-1 [scrollbar-width:thin]', className)} aria-label="Products">
      {cards.map((p) => {
        const link = httpUrl(p.url);
        return (
          <li key={p.id} className="relative w-36 flex-shrink-0 overflow-hidden rounded-lg border border-gray-200 bg-white text-left text-gray-900 whitespace-normal">
            <ProductImage src={p.image} title={p.title} className="h-24 w-full text-2xl" />
            <div className="p-2">
              <div className="text-xs font-medium leading-snug line-clamp-2 min-h-[2rem]" title={p.title}>
                {link ? <a href={link} target="_blank" rel="noopener noreferrer" className="hover:text-indigo-700 hover:underline">{p.title}</a> : p.title}
              </div>
              <ProductPrice p={p} className="mt-1 block text-xs" />
              {p.available === false && <div className="mt-0.5 text-[11px] text-amber-700">Out of stock</div>}
            </div>
            {onRemove && (
              <button type="button" onClick={() => onRemove(p.id)} aria-label={`Remove ${p.title}`} title="Do not send this product"
                className="absolute right-1 top-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-white/95 text-gray-600 shadow ring-1 ring-gray-200 hover:text-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The cards saved on a message (`content_attributes.products`), read defensively: only what looks like a card. */
export function cardsOf(attrs: Record<string, unknown> | null | undefined): ProductCard[] {
  const list = attrs?.products;
  if (!Array.isArray(list)) return [];
  return list.filter((p): p is ProductCard => !!p && typeof p === 'object' && typeof (p as ProductCard).id === 'string' && typeof (p as ProductCard).title === 'string').slice(0, 6);
}
