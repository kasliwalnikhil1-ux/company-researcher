'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { useSessionUser } from '@/lib/outreach/session';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError } from '@/lib/outreach/api';
import {
  NEEDS_YOU_RULE, NEEDS_YOU_TYPES, NEEDS_YOU_TYPE_LABEL, useHubSetup, useInvalidateHub, useNeedsYou, useNeedsYouCounts, useNeedsYouPictures, useQuestionAnswer,
  type NeedsYouCounts, type NeedsYouFilters, type NeedsYouRow, type NeedsYouType,
} from '@/lib/outreach/aiHub';
import { Button, EmptyState, ErrorBox, Spinner, useToast } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import FilterBar, { TAB_HINT } from './FilterBar';
import ReplyCard from './ReplyCard';
import LineCard from './LineCard';
import DraftCard from './DraftCard';
import WebsiteCard from './WebsiteCard';
import QuestionCard from './QuestionCard';
import ProfileCard from './ProfileCard';
import { NeedsYouPictures } from './NeedCard';
import UndoBar from './UndoBar';
import BulkBar from './BulkBar';
import { useCardActions } from './useCardActions';
import { cardKey, lineEditDirty, type CardApi, type LineEdit } from './types';

const NO_PICTURES: Record<string, string> = {};

/** The tab Needs you opens on: the first type with something waiting, in the order of the tabs. */
export function firstTab(counts: NeedsYouCounts | undefined): NeedsYouType {
  return NEEDS_YOU_TYPES.find((t) => (counts?.[t] ?? 0) > 0) ?? 'reply';
}

/**
 * Needs you: one queue for every AI output that waits for a person (PRD §4, contract §4).
 * The filters come from the page (they live in the URL). The server orders the cards: a live website suggestion first,
 * then oldest first, so nothing sits for ever. Each type is its own tab; a link without ?type= opens on the first tab
 * with something waiting (picked once, so the tab does not jump when its last card is handled).
 */
export default function NeedsYouView({ ws, filters, onFilters }: { ws: string; filters: NeedsYouFilters; onFilters: (f: NeedsYouFilters) => void }) {
  const countsQ = useNeedsYouCounts(ws, filters.mine);
  const [opened, setOpened] = useState<NeedsYouType | null>(null);
  if (!filters.type && !opened && countsQ.data) setOpened(firstTab(countsQ.data));
  const type = filters.type ?? opened;
  if (!type) return countsQ.isError ? <ErrorBox message={parseError(countsQ.error).message} /> : <Spinner />;
  return <TypeList ws={ws} filters={{ ...filters, type }} onFilters={onFilters} />;
}

/** One tab of Needs you: the cards of one type, oldest first, with Load more. */
function TypeList({ ws, filters, onFilters }: { ws: string; filters: NeedsYouFilters & { type: NeedsYouType }; onFilters: (f: NeedsYouFilters) => void }) {
  const { user } = useSessionUser();
  const { canWrite, canReply, isManager } = useWorkspace();
  const toast = useToast();
  const listQ = useNeedsYou(ws, filters, user?.id);
  const countsQ = useNeedsYouCounts(ws, filters.mine);
  const setupQ = useHubSetup(ws);
  const refresh = useInvalidateHub(ws);
  const answer = useQuestionAnswer(ws);
  const { act, defer, undo, pending, isGone, waiting } = useCardActions(ws, toast.show, listQ.dataUpdatedAt);

  // Lines only: the selection for the bulk bar, and the inline edits (kept here so a bulk approve can leave them out).
  // An edit is the text of a one-line variable, or the typed inputs of a Fields variable.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [edits, setEdits] = useState<Record<string, LineEdit>>({});

  // A card can come twice when the queue shifts between two page fetches: keep the first.
  const rows = useMemo(() => {
    const seen = new Set<string>();
    const out: NeedsYouRow[] = [];
    for (const page of listQ.data?.pages ?? []) for (const r of page) { const k = cardKey(r); if (!seen.has(k)) { seen.add(k); out.push(r); } }
    return out;
  }, [listQ.data]);
  const shown = useMemo(() => rows.filter((r) => !isGone(cardKey(r))), [rows, isGone]);
  const pictures = useNeedsYouPictures(ws, rows).data;
  const shownLines = useMemo(() => shown.filter((r) => r.type === 'line'), [shown]);
  const dirty = useMemo(() => new Set(shownLines.filter((r) => lineEditDirty(r, edits[r.id])).map((r) => r.id)), [shownLines, edits]);

  // The header counts come from the server; a card removed here is taken off until its call has gone through.
  const counts = useMemo<NeedsYouCounts | undefined>(() => {
    if (!countsQ.data) return undefined;
    const c = { ...countsQ.data };
    for (const t of NEEDS_YOU_TYPES) { const n = Math.min(c[t], waiting[t] ?? 0); c[t] -= n; c.total = Math.max(0, c.total - n); }
    return c;
  }, [countsQ.data, waiting]);
  const selectedLines = useMemo(() => shownLines.filter((r) => selected.has(r.id)), [shownLines, selected]);
  const allSelected = shownLines.length > 0 && selectedLines.length === shownLines.length;

  // A step draft that is still being written arrives within a minute: look again sooner than the 60 s of the list.
  const drafting = shown.some((r) => r.type === 'draft' && r.state === 'drafting');
  const refetch = listQ.refetch;
  useEffect(() => {
    if (!drafting) return;
    const t = setInterval(() => { void refetch(); }, 8000);
    return () => clearInterval(t);
  }, [drafting, refetch]);

  const answerQuestion = answer.mutateAsync;
  const api = useMemo<CardApi>(() => ({
    canWrite, canReply, isManager, act, defer, notify: toast.show, refresh,
    answerQuestion: (groupId, text) => answerQuestion({ groupId, answer: text }),
  }), [canWrite, canReply, isManager, act, defer, toast.show, refresh, answerQuestion]);

  const changeFilters = useCallback((f: NeedsYouFilters) => { setSelected(new Set()); onFilters(f); }, [onFilters]);
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const setEdit = (id: string, edit: LineEdit | undefined) => setEdits((e) => { const n = { ...e }; if (edit === undefined) delete n[id]; else n[id] = edit; return n; });

  const card = (row: NeedsYouRow) => {
    const key = cardKey(row);
    const props = { row, hidden: isGone(key), api };
    switch (row.type) {
      case 'reply': return <ReplyCard key={key} {...props} />;
      case 'line': return <LineCard key={key} {...props} checked={selected.has(row.id)} onCheck={() => toggle(row.id)} edit={edits[row.id]} onEdit={(t) => setEdit(row.id, t)} />;
      case 'draft': return <DraftCard key={key} {...props} />;
      case 'website': return <WebsiteCard key={key} {...props} />;
      case 'question': return <QuestionCard key={key} {...props} />;
      case 'profile': return <ProfileCard key={key} {...props} />;
      default: return null;   // a type added to the view later: nothing to draw until it has a card
    }
  };

  const whereName = filters.where ? rows.find((r) => r.where_id === filters.where)?.where_name ?? null : null;
  const fetching = listQ.isFetching && !listQ.isFetchingNextPage;
  return (
    <div>
      <FilterBar filters={filters} onFilters={changeFilters} counts={counts} setup={setupQ.data} whereName={whereName} />

      {listQ.isPending ? <Spinner /> : listQ.isError && !listQ.data ? (
        <div className="space-y-3">
          <ErrorBox message={parseError(listQ.error).message} />
          <Button variant="secondary" size="sm" loading={listQ.isFetching} onClick={() => void refetch()}>Try again</Button>
        </div>
      ) : (
        <>
          {/* Removed cards stay mounted (hidden) until the server confirms, so an edit is still there if the call fails. */}
          <div className="mb-3 flex min-h-[1.75rem] flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1">
            <p className="text-sm text-gray-500">{TAB_HINT[filters.type]}</p>
            {canWrite && shownLines.length > 0 && (
              <label className="inline-flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
                <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(shownLines.map((r) => r.id)))} className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" />
                Select all ({shownLines.length.toLocaleString()})
              </label>
            )}
          </div>
          <NeedsYouPictures.Provider value={pictures ?? NO_PICTURES}>
            <ul hidden={shown.length === 0} aria-label={NEEDS_YOU_TYPE_LABEL[filters.type]} className={cn('flex flex-col gap-2 transition-opacity', fetching && 'opacity-90')}>
              {rows.map(card)}
            </ul>
          </NeedsYouPictures.Provider>
          {shown.length === 0 && !listQ.hasNextPage && (
            <div className="rounded-xl border border-gray-200 bg-white">
              <EmptyState icon={<CheckCircle2 className="w-6 h-6" />} title={`No ${NEEDS_YOU_TYPE_LABEL[filters.type].toLowerCase()} waiting${filters.where ? ' here' : filters.mine ? ' for you' : ''}`} description={NEEDS_YOU_RULE}
                action={filters.where ? <Button variant="secondary" size="sm" onClick={() => changeFilters({ ...filters, where: null })}>Show every place</Button> : undefined} />
            </div>
          )}
          {listQ.hasNextPage && (
            <div className="mt-3 flex justify-center">
              <Button variant="secondary" size="sm" loading={listQ.isFetchingNextPage} onClick={() => void listQ.fetchNextPage()}>Load more</Button>
            </div>
          )}
        </>
      )}

      <div className="sticky bottom-4 z-30 mt-4 flex flex-col items-center gap-2 pointer-events-none [&>*]:pointer-events-auto">
        <UndoBar pending={pending} onUndo={undo} />
        {canWrite && <BulkBar rows={selectedLines} dirty={dirty} api={api} onClear={() => setSelected(new Set())} />}
      </div>
      {toast.node}
    </div>
  );
}
