'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { useCrm } from '@/contexts/CrmContext';
import { usePipeline } from '@/lib/crm/queries';
import { STAGE_LABELS, fmtMoney, fmtUsd, stageRank, type DealStage, type PipelineDeal } from '@/lib/crm/types';
import { Badge, Button, EmptyState, ErrorBox, Flags, PageHeader, Select, Spinner, fmtDate } from '@/components/crm/ui';
import { NextStepModal, StageModal, useWrite } from '@/components/crm/forms';
import { cn } from '@/lib/utils';

// Kanban by stage: drag to move. Card shows company, value, days in stage, next step. Stale cards are visibly marked.
// Forward moves save immediately; backwards / lost open the reason modal (the database requires the reason).

function DealCard({ d, stage, onNextStep, dragging }: { d: PipelineDeal; stage: DealStage; onNextStep: (d: PipelineDeal) => void; dragging?: boolean }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: d.deal_id, data: { deal: d, fromStage: stage } });
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined;
  return (
    <div ref={setNodeRef} style={style} {...listeners} {...attributes} className={cn('rounded-md border bg-white p-2 text-sm shadow-sm cursor-grab active:cursor-grabbing select-none', d.is_stale ? 'border-red-300 bg-red-50/40' : d.is_slipping ? 'border-pink-200' : d.is_stuck ? 'border-amber-200' : 'border-gray-200', (isDragging || dragging) && 'opacity-60 ring-2 ring-indigo-400')}>
      <div className="flex items-start justify-between gap-1">
        <Link href={`/crm/companies/${d.company_id}`} className="font-semibold text-gray-900 hover:text-indigo-700 leading-tight" onPointerDown={(e) => e.stopPropagation()}>{d.company}</Link>
        <span className="text-[11px] tabular-nums text-gray-500 whitespace-nowrap" title="Days in stage">{d.days_in_stage}d</span>
      </div>
      {d.title && <div className="text-xs text-gray-500">{d.title}</div>}
      <div className="mt-1 flex items-center justify-between gap-1">
        <span className="font-medium text-gray-800 tabular-nums">{fmtMoney(d.value_monthly, d.currency)}<span className="text-gray-400 text-[11px]">/mo</span></span>
        <span className="text-[11px] text-gray-500 truncate">{d.owner ?? '—'}</span>
      </div>
      <div className="mt-1 text-xs text-gray-600 flex items-start gap-1">
        {d.next_step ? <span className="truncate" title={d.next_step}>{d.next_step} <span className="text-gray-400">{fmtDate(d.next_step_date)}</span></span> : <button className="text-amber-700 underline" onPointerDown={(e) => e.stopPropagation()} onClick={() => onNextStep(d)}>set next step</button>}
      </div>
      <div className="mt-1 flex items-center justify-between"><Flags stale={d.is_stale} stuck={d.is_stuck} slipping={d.is_slipping} /><span className="text-[10px] text-gray-400 truncate">{d.icp_segment ?? ''}</span></div>
      {d.lost_reason && <div className="mt-1 text-[11px] text-red-700 truncate" title={d.lost_reason}>Lost: {d.lost_reason}</div>}
    </div>
  );
}

function Column({ stage, count, value, children }: { stage: DealStage; count: number; value: number; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });
  return (
    <div ref={setNodeRef} className={cn('flex flex-col rounded-lg border bg-gray-50 min-w-[210px] w-[210px] flex-shrink-0 max-h-full', isOver ? 'border-indigo-400 bg-indigo-50/40' : 'border-gray-200')}>
      <div className="px-2.5 py-2 border-b border-gray-200 flex items-center justify-between">
        <div><div className="text-xs font-semibold uppercase tracking-wide text-gray-700">{STAGE_LABELS[stage]}</div><div className="text-[11px] text-gray-500 tabular-nums">{count} · {fmtUsd(value)}/mo</div></div>
      </div>
      <div className="p-2 space-y-2 overflow-auto min-h-[80px] flex-1">{children}</div>
    </div>
  );
}

export default function PipelinePage() {
  const { activeMembers, lookups } = useCrm();
  const [filters, setFilters] = useState<{ owner?: string; icp_segment?: string; source_channel?: string; include_closed?: boolean }>({});
  const q = usePipeline(filters);
  const { write } = useWrite();
  const [active, setActive] = useState<{ deal: PipelineDeal; fromStage: DealStage } | null>(null);
  const [pendingMove, setPendingMove] = useState<{ deal: PipelineDeal; from: DealStage; to: DealStage } | null>(null);
  const [nextStep, setNextStep] = useState<PipelineDeal | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const onDragStart = (e: DragStartEvent) => { const d = e.active.data.current as { deal: PipelineDeal; fromStage: DealStage } | undefined; if (d) setActive(d); };
  const onDragEnd = async (e: DragEndEvent) => {
    const d = e.active.data.current as { deal: PipelineDeal; fromStage: DealStage } | undefined;
    setActive(null);
    if (!d || !e.over) return;
    const to = e.over.id as DealStage;
    if (to === d.fromStage) return;
    if (to === 'lost' || stageRank(to) < stageRank(d.fromStage)) { setPendingMove({ deal: d.deal, from: d.fromStage, to }); return; }
    await write('update_deal', { p_deal_id: d.deal.deal_id, p: { stage: to }, p_reason: null });
  };

  const t = q.data?.totals;
  const stages = useMemo(() => q.data?.stages ?? [], [q.data]);

  return (
    <div className="flex flex-col h-[calc(100vh-4.5rem)] min-h-[500px]">
      <PageHeader title="Pipeline" subtitle={t ? `${t.open_deals} open · ${fmtUsd(t.open_value_monthly_usd)}/mo · ${t.stale} stale · ${t.stuck} stuck · ${t.slipping} slipping` : undefined}
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            <Select value={filters.owner ?? ''} onChange={(e) => setFilters({ ...filters, owner: e.target.value || undefined })}><option value="">All owners</option>{activeMembers.map((m) => <option key={m.user_id} value={m.user_id}>{m.display_name}</option>)}</Select>
            <Select value={filters.icp_segment ?? ''} onChange={(e) => setFilters({ ...filters, icp_segment: e.target.value || undefined })}><option value="">All segments</option>{lookups('icp_segment', true).map((s) => <option key={s.id} value={s.id}>{s.label}{s.is_active ? '' : ' (inactive)'}</option>)}</Select>
            <Select value={filters.source_channel ?? ''} onChange={(e) => setFilters({ ...filters, source_channel: e.target.value || undefined })}><option value="">All channels</option>{lookups('source_channel', true).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</Select>
            <label className="flex items-center gap-1.5 text-sm text-gray-700"><input type="checkbox" checked={!!filters.include_closed} onChange={(e) => setFilters({ ...filters, include_closed: e.target.checked || undefined })} /> won / lost</label>
            <Badge tone="gray" title="Legend"><span className="text-red-700">stale</span> · <span className="text-amber-700">stuck</span> · <span className="text-pink-700">slipping</span></Badge>
          </div>
        } />
      {q.isLoading && <Spinner />}
      {q.isError && <ErrorBox message={(q.error as Error).message} />}
      {q.data && stages.every((s) => s.count === 0) && <EmptyState title="No deals match" description="Create a deal from a company page." action={<Link href="/crm/companies"><Button size="sm">Companies</Button></Link>} />}
      {q.data && (
        <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
          <div className="flex gap-2 overflow-x-auto flex-1 min-h-0 pb-2">
            {stages.map((s) => (
              <Column key={s.stage} stage={s.stage} count={s.count} value={s.value_monthly_usd}>
                {s.deals.map((d) => <DealCard key={d.deal_id} d={d} stage={s.stage} onNextStep={setNextStep} />)}
              </Column>
            ))}
          </div>
          <DragOverlay>{active ? <div className="w-[194px]"><DealCard d={active.deal} stage={active.fromStage} onNextStep={() => {}} dragging /></div> : null}</DragOverlay>
        </DndContext>
      )}
      <StageModal deal={pendingMove ? { id: pendingMove.deal.deal_id, company: pendingMove.deal.company, stage: pendingMove.from } : null} toStage={pendingMove?.to ?? null} open={!!pendingMove} onClose={() => setPendingMove(null)} />
      <NextStepModal deal={nextStep ? { id: nextStep.deal_id, company: nextStep.company, next_step: nextStep.next_step, next_step_date: nextStep.next_step_date } : null} open={!!nextStep} onClose={() => setNextStep(null)} />
    </div>
  );
}
