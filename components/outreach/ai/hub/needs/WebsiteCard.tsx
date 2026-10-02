'use client';

import { useState } from 'react';
import Link from '@/lib/outreach/nav';
import { MessageSquare, Pencil, Send } from 'lucide-react';
import { sendWebsiteSuggestion, useSuggestionProducts } from '@/lib/outreach/aiHub';
import ProductCards from '@/components/outreach/products/ProductCards';
import { Button, Textarea } from '@/components/outreach/ui';
import NeedCard, { ClampText, Hint, Part, linkButton } from './NeedCard';
import { websiteSources, type CardProps } from './types';

/**
 * Website (Review mode): the Website assistant suggests an answer and the visitor waits for a person. Sending it here is
 * the agent's own message in that chat; the suggestion id marks the suggestion as used. A suggestion that recommends
 * products shows their cards: they are sent under the answer, minus the ones removed here.
 */
export default function WebsiteCard({ row, hidden, api }: CardProps) {
  const [edit, setEdit] = useState<string | undefined>(undefined);
  const suggestion = (row.ai_text ?? '').trim();
  const editing = edit !== undefined;
  const chatId = row.chat_id;
  const canSend = api.canWrite && api.canReply && !!chatId;
  const sources = websiteSources(row);
  const products = useSuggestionProducts(row.id, !hidden);
  const [removed, setRemoved] = useState<string[]>([]);
  const cards = (products.data ?? []).filter((c) => !removed.includes(c.id));

  const send = () => {
    const text = (edit ?? suggestion).trim();
    if (!text || !chatId) return;
    void api.act(row, () => sendWebsiteSuggestion({ chatId, suggestionId: row.id, text, productIds: cards.map((c) => c.id) }), 'Answer sent to the visitor.');
  };

  const openChat = chatId ? <Link href={`/outreach/inbox/${chatId}`} className={linkButton}><MessageSquare className="w-3.5 h-3.5" aria-hidden="true" /> Open chat</Link> : null;

  return (
    <NeedCard row={row} hidden={hidden}
      trigger={row.trigger_text ? <Part label="Asked:"><ClampText text={row.trigger_text} className="text-gray-700" /></Part> : undefined}
      ai={editing ? (
        <Textarea label="Your answer to the visitor" value={edit} onChange={(e) => setEdit(e.target.value)} rows={4} autoFocus className="min-h-[96px]" />
      ) : (
        <Part label="AI suggests:"><ClampText text={suggestion} /></Part>
      )}
      extra={(sources.length > 0 || (products.data?.length ?? 0) > 0 || (api.canWrite && !api.canReply)) ? (
        <>
          {(products.data?.length ?? 0) > 0 && (
            <div>
              <p className="mb-1 text-xs text-gray-500">{cards.length > 0 ? `Sent under the answer (${cards.length} product ${cards.length === 1 ? 'card' : 'cards'}). Remove any the visitor should not get.` : 'No product card is sent with this answer.'}</p>
              <ProductCards cards={cards} onRemove={canSend ? (id) => setRemoved((r) => [...r, id]) : undefined} />
            </div>
          )}
          {sources.length > 0 && (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-gray-500">
              <span>Sources:</span>
              {sources.map((s, i) => s.url
                ? <a key={i} href={s.url} target="_blank" rel="noopener noreferrer" className="max-w-[16rem] truncate text-indigo-700 hover:underline" title={s.url}>{s.title}</a>
                : <span key={i} className="max-w-[16rem] truncate text-gray-700" title={s.title}>{s.title}</span>)}
            </p>
          )}
          {api.canWrite && !api.canReply && <Hint>Your account cannot send replies. Ask an owner to turn it on for you.</Hint>}
        </>
      ) : undefined}
      actions={api.canWrite ? (
        editing ? (
          <>
            {canSend && <Button size="sm" disabled={!(edit ?? '').trim()} onClick={send}><Send className="w-3.5 h-3.5" /> Send</Button>}
            <Button size="sm" variant="ghost" onClick={() => setEdit(undefined)}>Discard edit</Button>
            {openChat}
          </>
        ) : (
          <>
            {canSend && suggestion && <Button size="sm" onClick={send}><Send className="w-3.5 h-3.5" /> Send</Button>}
            {canSend && <Button size="sm" variant="secondary" onClick={() => setEdit(suggestion)}><Pencil className="w-3.5 h-3.5" /> Edit</Button>}
            {openChat}
          </>
        )
      ) : undefined} />
  );
}
