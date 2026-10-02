'use client';

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { Client, Lead, List, Stage, Tag } from '@/lib/outreach/types';
import { Avatar, Badge, Td, Th, fmtDate } from '@/components/outreach/ui';
import { MessageSquare, ShieldOff, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { profileOf, type LeadIntelFields, type LeadProfileSummary } from '@/lib/outreach/intel';
import { EMPTY_LAYOUT, MAX_COL_WIDTH, MIN_COL_WIDTH, mergeColumnOrder, moveColumn, type TableLayout } from '@/lib/outreach/tableLayout';
import { chipStyle, leadName } from './helpers';
import { SelectionMenu, type SelectionRequest } from './SelectionMenu';

export type LeadRow = Lead & LeadIntelFields & { outreach_lead_tags: { tag_id: string }[]; outreach_lead_profiles?: LeadProfileSummary | LeadProfileSummary[] | null };

const DASH = <span className="text-gray-300">—</span>;

function compact(n: number): string { return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n); }

export function TagChip({ tag, size = 'xs' }: { tag: Tag; size?: 'xs' | 'sm' }) {
  return <span title={tag.name} className={`inline-block max-w-full truncate whitespace-nowrap align-middle rounded-full font-medium border leading-4 ${size === 'xs' ? 'px-1.5 py-0.5 text-[11px]' : 'px-2 py-0.5 text-xs'}`} style={chipStyle(tag.color)}>{tag.name}</span>;
}
export function StageChip({ stage }: { stage: Stage }) {
  return <span title={stage.name} className="inline-block max-w-full truncate whitespace-nowrap align-middle px-2 py-0.5 rounded-full text-xs font-medium border leading-4" style={chipStyle(stage.color)}>{stage.name}</span>;
}

/** The lead's email addresses as text: work first, personal under it (or alone when there is no work email). */
export function LeadEmails({ lead }: { lead: Partial<Lead> }) {
  const work = lead.email_work; const personal = lead.email_personal;
  if (!work && !personal) return DASH;
  return (
    <span className="block min-w-0">
      {work && <a href={`mailto:${work}`} title={`Work: ${work}`} className="block truncate text-gray-900 hover:text-indigo-700">{work}</a>}
      {personal && <a href={`mailto:${personal}`} title={`Personal: ${personal}`} className={cn('block truncate hover:text-indigo-700', work ? 'text-xs text-gray-500' : 'text-gray-900')}>{personal}</a>}
    </span>
  );
}

function customText(v: unknown): string {
  return v == null ? '' : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
}
function CustomValue({ value }: { value: unknown }) {
  const s = customText(value).trim();
  if (!s) return DASH;
  if (/^https?:\/\/\S+$/i.test(s)) return <a href={s} target="_blank" rel="noopener noreferrer" title={s} className="block truncate text-indigo-600 hover:underline">{s.replace(/^https?:\/\/(www\.)?/i, '')}</a>;
  return <span className="block truncate text-gray-600" title={s}>{s}</span>;
}

interface Col { id: string; label: string; title?: string; width: number; cell: (l: LeadRow) => React.ReactNode }

const CHECK_COL_WIDTH = 48;
const clampWidth = (w: number) => Math.round(Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, w)));
/** Columns of custom fields get the id `custom:<field name>`. */
const customColId = (key: string) => `custom:${key}`;

/**
 * The leads table. Columns can be moved by dragging a header and resized by dragging a header's right edge (double-click the edge
 * for the default width); `layout` holds the result and `onLayoutChange` stores it. Custom fields are columns too: by default they
 * come last, after Created.
 */
export function LeadsTable({ rows, total, selected, onToggle, onSelect, selecting, clients, lists, stages, tags, selectable, customKeys, layout = EMPTY_LAYOUT, onLayoutChange }: {
  rows: LeadRow[]; selected: Set<string>; onToggle: (id: string) => void;
  /** Leads under the current filters, over every page: the number "Select all" shows. `selecting` is true while its ids are collected. */
  total: number; onSelect: (req: SelectionRequest) => void; selecting?: boolean;
  clients?: Client[]; lists?: List[]; stages?: Stage[]; tags?: Tag[]; selectable: boolean;
  /** Custom-field names of the workspace. Names found on the rows of this page are added to them. */
  customKeys?: string[]; layout?: TableLayout; onLayoutChange?: (next: TableLayout) => void;
}) {
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const someOnPage = rows.some((r) => selected.has(r.id));
  const tagMap = new Map((tags ?? []).map((t) => [t.id, t]));
  const stageMap = new Map((stages ?? []).map((s) => [s.id, s]));
  const listMap = new Map((lists ?? []).map((l) => [l.id, l]));
  const clientMap = new Map((clients ?? []).map((c) => [c.id, c]));

  const keys = useMemo(() => {
    const known = customKeys ?? []; const seen = new Set(known); const extra = new Set<string>();
    for (const r of rows) {
      if (!r.custom || typeof r.custom !== 'object' || Array.isArray(r.custom)) continue;
      for (const k of Object.keys(r.custom)) if (!seen.has(k)) extra.add(k);
    }
    return [...known, ...[...extra].sort()];
  }, [customKeys, rows]);

  const cols: Col[] = [
    { id: 'lead', label: 'Lead', width: 230, cell: (l) => (
      <Link href={`/outreach/leads/${l.id}`} className="flex items-center gap-2.5 min-w-0 group">
        <Avatar src={l.picture_url} name={leadName(l)} size={8} />
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-gray-900 group-hover:text-indigo-700 truncate">{leadName(l)}</span>
          {l.public_identifier && <span className="block text-xs text-gray-400 truncate">in/{l.public_identifier}</span>}
        </span>
      </Link>
    ) },
    { id: 'headline', label: 'Headline', width: 220, cell: (l) => <span className="block truncate text-gray-600" title={l.headline ?? undefined}>{l.headline ?? '—'}</span> },
    { id: 'company', label: 'Company / title', width: 180, cell: (l) => (
      <>
        <span className="block truncate text-gray-900" title={l.company ?? undefined}>{l.company ?? '—'}</span>
        {l.title && <span className="block truncate text-xs text-gray-500" title={l.title}>{l.title}</span>}
      </>
    ) },
    { id: 'location', label: 'Location', width: 140, cell: (l) => <span className="block truncate text-gray-600" title={l.location ?? undefined}>{l.location ?? '—'}</span> },
    { id: 'emails', label: 'Email', width: 210, cell: (l) => <LeadEmails lead={l} /> },
    { id: 'tags', label: 'Tags', width: 170, cell: (l) => {
      const leadTags = (l.outreach_lead_tags ?? []).map((t) => tagMap.get(t.tag_id)).filter((t): t is Tag => !!t);
      return (
        <span className="flex flex-wrap items-center gap-1 min-w-0">
          {leadTags.slice(0, 3).map((t) => <TagChip key={t.id} tag={t} />)}
          {leadTags.length > 3 && <span className="text-[11px] text-gray-500 whitespace-nowrap" title={leadTags.slice(3).map((t) => t.name).join(', ')}>+{leadTags.length - 3}</span>}
          {leadTags.length === 0 && DASH}
        </span>
      );
    } },
    { id: 'signals', label: 'Signals', width: 170, cell: (l) => {
      const prof = profileOf(l);
      return (
        <span className="flex flex-wrap items-center gap-1 min-w-0">
          {l.last_replied_at && <Badge tone="purple"><span title={`Last replied ${fmtDate(l.last_replied_at)}${l.last_replied_channel ? ` on ${l.last_replied_channel}` : ''}`} className="inline-flex items-center"><MessageSquare className="w-3 h-3 mr-1" />Replied</span></Badge>}
          {l.enrich_status === 'done' || l.enriched_at ? <Badge tone="green"><span title={l.enriched_at ? `Enriched ${fmtDate(l.enriched_at)}` : 'Enriched'} className="inline-flex items-center"><Sparkles className="w-3 h-3 mr-1" />Enriched</span></Badge>
            : l.enrich_status === 'waiting' ? <Badge tone="blue">Enrichment waiting</Badge> : l.enrich_status === 'failed' ? <Badge tone="red">Enrichment failed</Badge> : null}
          {prof?.follower_count != null && <span className="text-[11px] text-gray-500 tabular-nums" title={`${prof.follower_count.toLocaleString()} followers`}>{compact(prof.follower_count)} followers</span>}
          {!l.last_replied_at && !l.enriched_at && (!l.enrich_status || l.enrich_status === 'none') && DASH}
        </span>
      );
    } },
    { id: 'stage', label: 'Stage', width: 130, cell: (l) => { const stage = l.stage_id ? stageMap.get(l.stage_id) : undefined; return stage ? <StageChip stage={stage} /> : DASH; } },
    { id: 'list', label: 'List', width: 140, cell: (l) => { const name = l.list_id ? listMap.get(l.list_id)?.name : undefined; return <span className="block truncate text-gray-600" title={name}>{name ?? '—'}</span>; } },
    ...(clients && clients.length > 0 ? [{ id: 'client', label: 'Client', width: 140, cell: (l: LeadRow) => { const name = l.client_id ? clientMap.get(l.client_id)?.name : undefined; return <span className="block truncate text-gray-600" title={name}>{name ?? '—'}</span>; } }] : []),
    { id: 'dnc', label: 'DNC', title: 'Do not contact — flagged leads are excluded from every sequence', width: 110, cell: (l) => (
      l.do_not_contact ? <span title="Do not contact — this lead is excluded from every sequence" className="cursor-help"><Badge tone="red"><ShieldOff className="w-3 h-3 mr-1" /> DNC</Badge></span>
        : l.unsubscribed ? <span title="Unsubscribed — this lead opted out of emails" className="cursor-help"><Badge tone="amber">unsubscribed</Badge></span> : DASH
    ) },
    { id: 'created', label: 'Created', width: 110, cell: (l) => <span className="whitespace-nowrap text-gray-500 text-xs">{fmtDate(l.created_at, false)}</span> },
    ...keys.map((k): Col => ({ id: customColId(k), label: k.replace(/_/g, ' '), title: `Custom field: ${k}`, width: 150, cell: (l) => <CustomValue value={(l.custom as Record<string, unknown> | null)?.[k]} /> })),
  ];

  // Saved order first; columns it does not mention (a new custom field) take their default place.
  const byId = new Map(cols.map((c) => [c.id, c]));
  const order = mergeColumnOrder(layout.order, cols.map((c) => c.id));
  const shown = order.map((id) => byId.get(id)).filter((c): c is Col => !!c);

  const arrangeable = !!onLayoutChange;
  // Resizing: the width follows the pointer and is stored once, on release.
  const [live, setLive] = useState<{ id: string; width: number } | null>(null);
  const resizing = useRef<{ id: string; startX: number; startW: number } | null>(null);
  const widthOf = (c: Col) => (live?.id === c.id ? live.width : layout.widths[c.id] ?? c.width);
  const tableWidth = (selectable ? CHECK_COL_WIDTH : 0) + shown.reduce((n, c) => n + widthOf(c), 0);

  const resizeStart = (e: React.PointerEvent<HTMLSpanElement>, c: Col) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    resizing.current = { id: c.id, startX: e.clientX, startW: widthOf(c) };
    setLive({ id: c.id, width: widthOf(c) });
  };
  const resizeMove = (e: React.PointerEvent<HTMLSpanElement>) => {
    const r = resizing.current;
    if (r) setLive({ id: r.id, width: clampWidth(r.startW + e.clientX - r.startX) });
  };
  const resizeEnd = (e: React.PointerEvent<HTMLSpanElement>, commit: boolean) => {
    const r = resizing.current;
    if (!r) return;
    resizing.current = null;
    setLive(null);
    const w = clampWidth(r.startW + e.clientX - r.startX);
    if (commit && w !== r.startW) onLayoutChange?.({ order: layout.order, widths: { ...layout.widths, [r.id]: w } });
  };
  const resetWidth = (c: Col) => {
    if (layout.widths[c.id] == null) return;
    const widths = { ...layout.widths }; delete widths[c.id];
    onLayoutChange?.({ order: layout.order, widths });
  };

  // Moving: drag a header onto another one; it lands on the side of that header the pointer is on.
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null);
  const dragOver = (e: React.DragEvent<HTMLTableCellElement>, c: Col) => {
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const box = e.currentTarget.getBoundingClientRect();
    const after = e.clientX > box.left + box.width / 2;
    if (over?.id !== c.id || over.after !== after) setOver({ id: c.id, after });
  };
  const drop = (e: React.DragEvent<HTMLTableCellElement>) => {
    e.preventDefault();
    if (dragId && over) {
      const next = moveColumn(order, dragId, over.id, over.after);
      if (next.join('\n') !== order.join('\n')) onLayoutChange?.({ order: next, widths: layout.widths });
    }
    setDragId(null); setOver(null);
  };

  return (
    <div className="overflow-x-auto border border-gray-200 rounded-xl bg-white">
      <table className="w-full table-fixed text-sm" style={{ minWidth: tableWidth }}>
        <colgroup>
          {selectable && <col style={{ width: CHECK_COL_WIDTH }} />}
          {shown.map((c) => <col key={c.id} style={{ width: widthOf(c) }} />)}
          {/* Takes whatever room is left when the columns are narrower than the page. */}
          <col />
        </colgroup>
        <thead>
          <tr>
            {selectable && (
              <Th className="pr-0">
                <SelectionMenu pageRows={rows.length} total={total} selectedCount={selected.size} allOnPage={allOnPage} someOnPage={someOnPage} busy={selecting} onSelect={onSelect} />
              </Th>
            )}
            {shown.map((c) => {
              const target = over?.id === c.id && dragId !== c.id;
              return (
                <th key={c.id} scope="col" onDragOver={(e) => dragOver(e, c)} onDrop={drop}
                  className="relative p-0 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide bg-gray-50 border-b border-gray-200 select-none"
                  style={target ? { boxShadow: over?.after ? 'inset -2px 0 0 #4f46e5' : 'inset 2px 0 0 #4f46e5' } : undefined}>
                  <div draggable={arrangeable} title={arrangeable ? `${c.title ? `${c.title}. ` : ''}Drag to move this column` : c.title}
                    onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', c.id); setDragId(c.id); }}
                    onDragEnd={() => { setDragId(null); setOver(null); }}
                    className={cn('px-4 py-2.5 truncate', arrangeable && 'cursor-grab active:cursor-grabbing', dragId === c.id && 'opacity-40')}>
                    {c.label}
                  </div>
                  {arrangeable && (
                    <span role="separator" aria-orientation="vertical" aria-label={`Resize the ${c.label} column`} title="Drag to resize. Double-click for the default width."
                      onPointerDown={(e) => resizeStart(e, c)} onPointerMove={resizeMove} onPointerUp={(e) => resizeEnd(e, true)} onPointerCancel={(e) => resizeEnd(e, false)}
                      onDoubleClick={() => resetWidth(c)}
                      className={cn('absolute top-0 right-0 z-10 h-full w-2 cursor-col-resize touch-none border-r border-gray-200 hover:border-indigo-500 hover:bg-indigo-100', live?.id === c.id && 'border-indigo-500 bg-indigo-100')} />
                  )}
                </th>
              );
            })}
            <th aria-hidden className="p-0 bg-gray-50 border-b border-gray-200" />
          </tr>
        </thead>
        <tbody>
          {rows.map((l) => {
            const isSel = selected.has(l.id);
            return (
              <tr key={l.id} className={isSel ? 'bg-indigo-50/40' : 'hover:bg-gray-50'}>
                {selectable && (
                  <Td><input type="checkbox" aria-label={`Select ${leadName(l)}`} checked={isSel} onChange={() => onToggle(l.id)} className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" /></Td>
                )}
                {shown.map((c) => <Td key={c.id} className="overflow-hidden">{c.cell(l)}</Td>)}
                <td aria-hidden className="p-0 border-b border-gray-100" />
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
