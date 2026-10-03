'use client';

// Knowledge → Sources (AI hub §6): every website, document, pasted text and product catalogue of the workspace with the
// places that use it, plus the two fixed rows: the shared Q&A and the questions the AI could not answer.
// A product catalogue (migration 068) is what the Website agent recommends products from; a website source can
// also collect the products its pages describe ("Also find products").
import { Fragment, useState } from 'react';
import Link from '@/lib/outreach/nav';
import { ArrowRight, BookOpen, FileText, Globe, HelpCircle, Loader2, MessageCircleQuestion, Plus, ShoppingBag, Type } from 'lucide-react';
import { PROVIDER_LABEL, catalogueHref, useCatalogueUpdate } from '@/lib/outreach/catalogue';
import { KNOWLEDGE_STATUS_LABEL, useKnowledgeSourceDelete } from '@/lib/outreach/aiRepliesSequence';
import { hubHref, knowledgeTargetHref, knowledgeTargetText, useInvalidateKnowledge, type HubKnowledge, type HubKnowledgeSource } from '@/lib/outreach/aiHub';
import { Badge, Button, EmptyState, Table, Td, Th, fmtDate } from '@/components/outreach/ui';
import { ConfirmModal } from '@/components/outreach/settings/shared';
import { errText, plural } from '@/components/outreach/sequences/ai/shared';
import type { Notify } from './shared';

const KIND_ICON = { website: Globe, document: FileText, text: Type, catalogue: ShoppingBag } as const;
const KIND_LABEL: Record<HubKnowledgeSource['kind'], string> = { website: 'Website', document: 'Document', text: 'Text', catalogue: 'Product catalogue' };
const products = (n: number) => `${n.toLocaleString()} ${plural(n, 'product')}`;
const dash = <span className="text-gray-400">—</span>;

/** "2d": how long ago a website was last read. */
function shortAge(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return d < 60 ? `${d}d` : `${Math.round(d / 30)}mo`;
}

/** Places a member can see + the count of the ones they cannot (archived sequences, saved prompts, another client's). */
function usage(s: HubKnowledgeSource) {
  const used = s.used_in ?? [];
  const hidden = Math.max(0, Number(s.used_by ?? 0) - used.length);
  return { used, hidden, total: used.length + hidden };
}

/** A catalogue: how many products it holds and when it was last synced; a sync in progress; what went wrong. */
function CatalogueStatus({ s }: { s: HubKnowledgeSource }) {
  const n = Number(s.products ?? 0), c = s.catalogue;
  if (s.status === 'error') {
    return (
      <div>
        <Badge tone="red">{KNOWLEDGE_STATUS_LABEL.error}</Badge>
        <div className="text-xs text-red-700 mt-1 max-w-[18rem] break-words">{s.error ?? 'Could not be read'}</div>
        {n > 0 && <div className="text-xs text-gray-500 mt-0.5">{products(n)} from the last sync are still used.</div>}
      </div>
    );
  }
  if (s.status !== 'ready') {
    return <span className="inline-flex items-center gap-1.5 text-gray-600"><Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-500" aria-hidden="true" />Syncing…{n > 0 ? ` ${products(n)} so far` : ''}</span>;
  }
  const age = shortAge(c?.synced_at ?? s.crawled_at);
  const tip = c?.synced_at ? `Last synced ${fmtDate(c.synced_at)}${s.refresh_days ? `. Synced again every ${s.refresh_days} ${plural(s.refresh_days, 'day')}` : ''}` : undefined;
  return (
    <div>
      <span className={tip ? 'cursor-help' : undefined} title={tip}>{products(n)}{age ? ` · ${age}` : ''}</span>
      {c?.warning && <div className="text-xs text-amber-700 mt-0.5 max-w-[18rem]">{c.warning}</div>}
    </div>
  );
}

function SourceStatus({ s }: { s: HubKnowledgeSource }) {
  if (s.kind === 'catalogue') return <CatalogueStatus s={s} />;
  if (s.status === 'error') {
    return (
      <div>
        <Badge tone="red">{KNOWLEDGE_STATUS_LABEL.error}</Badge>
        <div className="text-xs text-red-700 mt-1 max-w-[18rem] break-words">{s.error ?? 'Could not be read'}</div>
      </div>
    );
  }
  if (s.status === 'ready') {
    const pages = Number(s.pages ?? 0);
    if (s.kind !== 'website' || pages <= 0) return <span>{KNOWLEDGE_STATUS_LABEL.ready}</span>;
    const age = shortAge(s.crawled_at);
    const tip = s.crawled_at ? `Last read ${fmtDate(s.crawled_at)}${s.refresh_days ? `. Read again every ${s.refresh_days} ${plural(s.refresh_days, 'day')}` : ''}` : undefined;
    return <span className={tip ? 'cursor-help' : undefined} title={tip}>{pages.toLocaleString()} {plural(pages, 'page')}{age ? ` · ${age}` : ''}{s.detect_products ? ` · ${products(Number(s.products ?? 0))}` : ''}</span>;
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-gray-600">
      <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-500" aria-hidden="true" />{KNOWLEDGE_STATUS_LABEL[s.status] ?? s.status}…
    </span>
  );
}

function UsedBy({ s }: { s: HubKnowledgeSource }) {
  const { used, hidden } = usage(s);
  if (used.length === 0 && hidden === 0) return <span className="text-gray-400">Not used yet</span>;
  return (
    <span className="text-gray-700">
      {used.map((t, i) => (
        <Fragment key={`${t.kind}:${t.id}`}>
          {i > 0 && <span className="text-gray-400"> · </span>}
          <Link href={knowledgeTargetHref(t)} className="hover:text-indigo-700 hover:underline">{knowledgeTargetText(t)}</Link>
        </Fragment>
      ))}
      {hidden > 0 && (
        <span className="text-gray-500 cursor-help" title="Archived sequences, saved prompts, or places you do not have access to">
          {used.length > 0 && <span className="text-gray-400"> · </span>}{hidden} more not shown
        </span>
      )}
    </span>
  );
}

export default function SourcesView({ ws, data, canEdit, canAnswer, onAdd, onUseIn, onOpenQa, notify }: {
  ws: string; data: HubKnowledge; canEdit: boolean;
  /** Question cards in Needs you are for owners and managers. */
  canAnswer: boolean;
  onAdd: (kind: 'website' | 'document' | 'catalogue') => void; onUseIn: (s: HubKnowledgeSource) => void; onOpenQa: () => void; notify: Notify;
}) {
  const del = useKnowledgeSourceDelete(ws);
  const update = useCatalogueUpdate(ws);
  // "Also find products" on a website: its pages are read again and the products they describe become a catalogue
  async function findProducts(s: HubKnowledgeSource, on: boolean) {
    try { await update.mutateAsync({ id: s.id, patch: { detect_products: on } }); invalidate(); notify(on ? 'The site is being read again. Products found on its pages appear here in a few minutes.' : 'Products from this website are no longer used.'); }
    catch (e) { notify(errText(e), 'error'); }
  }
  const invalidate = useInvalidateKnowledge(ws);
  const [toRemove, setToRemove] = useState<HubKnowledgeSource | null>(null);
  const sources = data.sources ?? [];
  const qaTotal = Number(data.qa_total ?? 0);
  const questions = Number(data.questions_open ?? 0);
  const cols = canEdit ? 5 : 4;
  const removing = toRemove ? usage(toRemove) : null;

  async function remove() {
    if (!toRemove) return;
    try { await del.mutateAsync(toRemove.id); invalidate(); notify('Source removed.'); }
    catch (e) { notify(errText(e), 'error'); }
    finally { setToRemove(null); }
  }

  return (
    <>
      <Table>
        <thead>
          <tr>
            <Th>Source</Th>
            <Th className="w-28">Type</Th>
            <Th className="w-52">Status</Th>
            <Th>Used by</Th>
            {canEdit && <Th className="w-px"><span className="sr-only">Actions</span></Th>}
          </tr>
        </thead>
        <tbody>
          {sources.length === 0 && (
            <tr>
              <td colSpan={cols} className="border-b border-gray-100">
                <EmptyState icon={<BookOpen className="w-6 h-6" />} title="No sources yet"
                  description="A source is a website, a document or a text the AI may take facts from, or a product catalogue the Website agent recommends from. Replies and the Website agent answer from the sources attached to them."
                  action={canEdit ? (
                    <div className="flex flex-wrap items-center justify-center gap-2">
                      <Button variant="secondary" onClick={() => onAdd('website')}><Plus className="w-4 h-4" aria-hidden="true" />Website</Button>
                      <Button variant="secondary" onClick={() => onAdd('document')}><Plus className="w-4 h-4" aria-hidden="true" />Document</Button>
                      <Button variant="secondary" onClick={() => onAdd('catalogue')}><Plus className="w-4 h-4" aria-hidden="true" />Product catalogue</Button>
                    </div>
                  ) : undefined} />
              </td>
            </tr>
          )}
          {sources.map((s) => {
            const Icon = KIND_ICON[s.kind] ?? FileText;
            return (
              <tr key={s.id} className="align-top">
                <Td className="align-top max-w-[22rem]">
                  <div className="flex items-start gap-2">
                    <Icon className="w-4 h-4 text-gray-400 mt-0.5 flex-shrink-0" aria-hidden="true" />
                    <div className="min-w-0">
                      <div className="font-medium text-gray-900 truncate" title={s.title}>
                        {s.kind === 'catalogue' ? <Link href={catalogueHref(s.id)} className="hover:text-indigo-700 hover:underline">{s.title}</Link> : s.title}
                      </div>
                      {s.kind === 'catalogue' && <div className="text-xs text-gray-500 truncate">{PROVIDER_LABEL[s.catalogue?.provider ?? 'feed']}{s.catalogue?.currency ? ` · ${s.catalogue.currency}` : ''}</div>}
                      {s.kind === 'website' && (canEdit || s.detect_products) && (
                        <label className="mt-1 flex items-center gap-1.5 text-xs text-gray-600" title="Pages that describe a product (most shop platforms do) become products the Website agent can recommend">
                          <input type="checkbox" className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" checked={!!s.detect_products} disabled={!canEdit || update.isPending} onChange={(e) => findProducts(s, e.target.checked)} />
                          Also find products
                          {s.detect_products && Number(s.products ?? 0) > 0 && <Link href={catalogueHref(s.id)} className="text-indigo-700 hover:underline">({products(Number(s.products))})</Link>}
                        </label>
                      )}
                      {s.kind === 'website' && s.url && (
                        /^https?:\/\//i.test(s.url)
                          ? <a href={s.url} target="_blank" rel="noopener noreferrer" className="block text-xs text-gray-500 truncate hover:text-indigo-700 hover:underline" title={s.url}>{s.url}</a>
                          : <div className="text-xs text-gray-500 truncate" title={s.url}>{s.url}</div>
                      )}
                    </div>
                  </div>
                </Td>
                <Td className="align-top whitespace-nowrap">{KIND_LABEL[s.kind] ?? s.kind}</Td>
                <Td className="align-top"><SourceStatus s={s} /></Td>
                <Td className="align-top min-w-[14rem]"><UsedBy s={s} /></Td>
                {canEdit && (
                  <Td className="align-top whitespace-nowrap">
                    <div className="flex items-center justify-end gap-1.5">
                      {s.kind === 'catalogue' && <Link href={catalogueHref(s.id)} className="inline-flex items-center rounded-lg border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50">Products</Link>}
                      <Button size="sm" variant="secondary" aria-label={`Use in… (${s.title})`} onClick={() => onUseIn(s)}>Use in…</Button>
                      <Button size="sm" variant="ghost" aria-label={`Remove ${s.title}`} className="hover:text-red-600 hover:bg-red-50" onClick={() => setToRemove(s)}>Remove</Button>
                    </div>
                  </Td>
                )}
              </tr>
            );
          })}
          <tr className="align-top">
            <Td>
              <button type="button" onClick={onOpenQa} className="inline-flex items-center gap-2 font-medium text-gray-900 hover:text-indigo-700 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
                <HelpCircle className="w-4 h-4 text-gray-400 flex-shrink-0" aria-hidden="true" />Q&amp;A ({qaTotal.toLocaleString()})
              </button>
            </Td>
            <Td className="whitespace-nowrap">Q&amp;A</Td>
            <Td>{dash}</Td>
            <Td>All unless limited</Td>
            {canEdit && <Td className="whitespace-nowrap"><div className="flex justify-end"><Button size="sm" variant="secondary" onClick={onOpenQa}>Open</Button></div></Td>}
          </tr>
          <tr className="align-top">
            <Td className="border-b-0">
              <span className="inline-flex items-center gap-2 font-medium text-gray-900">
                <MessageCircleQuestion className="w-4 h-4 text-gray-400 flex-shrink-0" aria-hidden="true" />Unanswered questions ({questions.toLocaleString()})
              </span>
            </Td>
            <Td className="border-b-0">{dash}</Td>
            <Td className="border-b-0">{dash}</Td>
            <Td className="border-b-0">
              {canAnswer ? (
                <Link href={hubHref.needsYou({ type: 'question', mine: false })} className="inline-flex items-center gap-1 text-indigo-600 hover:underline">
                  <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />shown in Needs you
                </Link>
              ) : <span className="text-gray-500">shown in Needs you, to owners and managers</span>}
            </Td>
            {canEdit && <Td className="border-b-0" />}
          </tr>
        </tbody>
      </Table>
      {!canEdit && <p className="text-xs text-gray-500 mt-2">Owners and managers add sources and choose where they are used.</p>}

      <ConfirmModal open={!!toRemove} onClose={() => setToRemove(null)} onConfirm={remove} loading={del.isPending} title="Remove this source?" confirmLabel={removing && removing.total > 0 ? 'Remove from all' : 'Remove'}>
        {removing && removing.total > 0 ? (
          <>
            <p>Used by {removing.total} {plural(removing.total, 'place')}. Remove from all?</p>
            {removing.used.length > 0 && (
              <ul className="list-disc pl-5 text-gray-600">
                {removing.used.slice(0, 8).map((t) => <li key={`${t.kind}:${t.id}`}>{knowledgeTargetText(t)}</li>)}
                {removing.total > Math.min(8, removing.used.length) && <li>{removing.total - Math.min(8, removing.used.length)} more</li>}
              </ul>
            )}
            <p>&ldquo;{toRemove?.title}&rdquo; is deleted and the AI stops answering from it there.</p>
          </>
        ) : (
          <p>&ldquo;{toRemove?.title}&rdquo; is deleted from Knowledge. Nothing uses it.</p>
        )}
      </ConfirmModal>
    </>
  );
}
