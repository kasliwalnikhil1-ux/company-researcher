'use client';

// Website assistant, Review mode (docs/outreach/AI-HUB.md §6): the assistant's suggested answer for the visitor's last
// message pre-fills the reply box. A person sends it, as it is or edited; the AI never does. The same suggestion is a
// Website card in AI → Needs you. When the suggestion recommends products, their cards are sent with the reply; the
// agent can remove any of them first (web-chat-buttons-products-changes.md §9).
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Sparkles } from 'lucide-react';
import type { Chat } from '@/lib/outreach/types';
import { useWebchatSuggestion, type WebchatSuggestion } from '@/lib/outreach/aiHub';
import type { ProductCard } from '@/lib/outreach/catalogue';
import ProductCards, { cardsOf } from '@/components/outreach/products/ProductCards';

export interface ComposerSuggestion {
  suggestion: WebchatSuggestion | null;
  /** The reply box holds this suggestion (maybe edited). */
  inBox: boolean;
  /** Put the suggestion into the reply box (asks before replacing typed text). */
  use: () => void;
  /** Take the suggestion out of the reply box. */
  discard: () => void;
  /** The suggestion the text about to be sent started from, or null. Sent as content_attributes.internal.suggestion_id. */
  idForSend: () => string | null;
  /** After a send. */
  dropTag: () => void;
  /** The product cards that go out with the suggestion in the box: the suggestion's own, minus the ones the agent removed. */
  cards: ProductCard[];
  removeCard: (id: string) => void;
  /** Their ids, read at send time. */
  cardIdsForSend: () => string[];
}

export function useComposerSuggestion(chat: Chat, text: string, setText: (t: string) => void): ComposerSuggestion {
  const on = chat.provider === 'WEBCHAT' && chat.ai_mode === 'review' && !chat.handed_off_at;
  const q = useWebchatSuggestion(chat.id, on);
  const s = on ? q.data ?? null : null;
  const [tag, setTag] = useState<{ id: string; original: string } | null>(null);
  // cards the agent took off, per suggestion: a new suggestion starts with all of its cards
  const [removed, setRemoved] = useState<{ id: string; ids: string[] }>({ id: '', ids: [] });
  const inBox = !!tag && !!s && tag.id === s.id;
  const cards = inBox ? cardsOf({ products: s.products }).filter((c) => !(removed.id === s.id && removed.ids.includes(c.id))) : [];
  // the latest box text, tag and cards for the effects and callbacks below (declared first, so it runs before them)
  const live = useRef({ text, tag, cards });
  useEffect(() => { live.current = { text, tag, cards }; });
  const seen = useRef<string | null>(null);

  // the agent emptied the box: what they type next is their own reply
  if (tag && !text.trim()) setTag(null);

  // pre-fill once per suggestion, and never over what the agent typed (the bar offers "Use it" instead)
  const ready = s && s.status === 'waiting' && s.text ? s : null;
  useEffect(() => {
    if (!ready || seen.current === ready.id) return;
    seen.current = ready.id;
    const { text: cur, tag: t } = live.current;
    // typed text stays; a box that already holds this very suggestion (a reload restores the saved draft) is adopted
    if (cur.trim() && cur !== ready.text && !(t && cur === t.original)) return;
    setText(ready.text);
    setTag({ id: ready.id, original: ready.text });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready?.id]);

  // the suggestion in the box is no longer the current one (the visitor wrote again, someone answered): an untouched
  // copy is cleared, an edited one stays as the agent's own text
  useEffect(() => {
    const { text: cur, tag: t } = live.current;
    if (!t || q.isLoading || s?.id === t.id) return;
    if (cur === t.original) setText('');
    setTag(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s?.id, q.isLoading]);

  return {
    suggestion: s,
    inBox,
    use: () => {
      if (!ready) return;
      const cur = live.current.text;
      if (cur.trim() && cur !== ready.text && !window.confirm('Replace what you typed with the AI suggestion?')) return;
      setText(ready.text);
      setTag({ id: ready.id, original: ready.text });
    },
    discard: () => { if (live.current.tag) { setText(''); setTag(null); } },
    idForSend: () => (live.current.tag && live.current.text.trim() ? live.current.tag.id : null),
    dropTag: () => setTag(null),
    cards,
    removeCard: (id) => { if (s) setRemoved((r) => ({ id: s.id, ids: r.id === s.id ? [...r.ids, id] : [id] })); },
    cardIdsForSend: () => (live.current.tag && live.current.text.trim() ? live.current.cards.map((c) => c.id) : []),
  };
}

/** One line above the reply box of a web chat in Review mode; under it, the product cards that go out with the suggestion. */
export function WebchatSuggestionBar({ sug, text }: { sug: ComposerSuggestion; text: string }) {
  const s = sug.suggestion;
  if (!s) return null;
  if (s.status === 'pending') {
    return <div className="flex items-center gap-1.5 text-xs text-gray-500"><Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> The assistant is writing a suggestion…</div>;
  }
  if (sug.inBox) {
    const edited = text.trim() !== s.text.trim();
    const total = cardsOf({ products: s.products }).length;
    return (
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="inline-flex items-center gap-1 font-medium text-indigo-700"><Sparkles className="w-3.5 h-3.5" aria-hidden="true" />AI suggestion{edited ? ', edited' : ''}</span>
          <span className="text-gray-500">Send it as it is or change it first. The visitor only sees what you send.</span>
          {s.confidence === 'low' && <span className="inline-flex items-center gap-1 text-amber-700"><AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />The AI is not sure: your knowledge does not cover this</span>}
          <button type="button" onClick={sug.discard} className="text-gray-500 hover:text-gray-800 hover:underline">Discard</button>
        </div>
        {total > 0 && (
          <div>
            <p className="mb-1 text-xs text-gray-500">
              {sug.cards.length > 0
                ? `${sug.cards.length === 1 ? 'This product card is' : `These ${sug.cards.length} product cards are`} sent under your reply. Remove any the visitor should not get.`
                : 'No product card is sent with this reply.'}
            </p>
            <ProductCards cards={sug.cards} onRemove={sug.removeCard} />
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs">
      <span className="inline-flex items-center gap-1 font-medium text-indigo-900"><Sparkles className="w-3.5 h-3.5" aria-hidden="true" />AI suggestion ready</span>
      <span className="min-w-0 flex-1 truncate text-indigo-900/80" title={s.text}>{s.text}</span>
      <button type="button" onClick={sug.use} className="font-medium text-indigo-700 hover:underline">Use it</button>
    </div>
  );
}
