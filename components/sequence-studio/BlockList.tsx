'use client';

// Editable list of supporting blocks (guidance, examples, internal notes, unmapped content).

import { ArrowDown, ArrowUp, Copy, Plus, Trash2 } from 'lucide-react';
import type { Block } from '@/lib/sequence-studio/types';
import type { ResolveContext } from '@/lib/sequence-studio/variables';
import { move, uid } from '@/lib/sequence-studio/util';
import { blankBlock } from './mut';
import { TokenTextarea } from './TokenTextarea';
import { Badge, Btn, Empty, IconBtn, Input, Select } from './ui';

const KIND_HINT: Record<Block['kind'], string> = {
  guidance: 'Guidance — for you and your team, never sent.',
  example: 'Example — reference only, never sent.',
  note: 'Internal note — never appears in any preview or email.',
  unmapped: 'Kept verbatim from an import because it could not be mapped with confidence. Never sent.',
};

export default function BlockList({
  blocks,
  onEdit,
  ctx,
  mode,
  emptyText,
}: {
  blocks: Block[];
  onEdit: (fn: (blocks: Block[]) => void, key?: string) => void;
  ctx: ResolveContext;
  mode: 'raw' | 'personalized';
  emptyText: string;
}) {
  return (
    <div className="space-y-3">
      {!blocks.length && <Empty>{emptyText}</Empty>}
      {blocks.map((b, i) => (
        <div key={b.id} className={`rounded-xl border p-4 ${b.kind === 'note' ? 'border-amber-300 bg-amber-50/60' : b.kind === 'unmapped' ? 'border-red-200 bg-red-50/40' : 'border-gray-200 bg-white'}`}>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Input aria-label="Section title" value={b.title} onChange={(e) => onEdit((bs) => void (bs.find((x) => x.id === b.id)!.title = e.target.value), `blk-title-${b.id}`)} className="min-w-[160px] flex-1 font-medium" />
            <Select aria-label="Kind" value={b.kind} onChange={(e) => onEdit((bs) => void (bs.find((x) => x.id === b.id)!.kind = e.target.value as Block['kind']))} className="py-1 text-xs">
              <option value="guidance">Guidance</option>
              <option value="example">Example</option>
              <option value="note">Internal note</option>
              <option value="unmapped">Unmapped</option>
            </Select>
            <IconBtn label="Move up" disabled={i === 0} onClick={() => onEdit((bs) => move(bs, i, i - 1))}>
              <ArrowUp className="h-3.5 w-3.5" />
            </IconBtn>
            <IconBtn label="Move down" disabled={i === blocks.length - 1} onClick={() => onEdit((bs) => move(bs, i, i + 1))}>
              <ArrowDown className="h-3.5 w-3.5" />
            </IconBtn>
            <IconBtn label="Duplicate" onClick={() => onEdit((bs) => void bs.splice(i + 1, 0, { ...b, id: uid('blk'), title: `${b.title} (copy)` }))}>
              <Copy className="h-3.5 w-3.5" />
            </IconBtn>
            <IconBtn
              label="Delete"
              onClick={() => {
                if (window.confirm(`Delete "${b.title}"? You can undo this.`)) onEdit((bs) => void bs.splice(i, 1));
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </IconBtn>
          </div>
          <TokenTextarea label={`${b.title} body`} value={b.body} ctx={ctx} mode={mode} minRows={3} tone={b.kind === 'note' ? 'note' : 'default'} onChange={(v) => onEdit((bs) => void (bs.find((x) => x.id === b.id)!.body = v), `blk-body-${b.id}`)} />
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-gray-500">
            <Badge tone={b.kind === 'note' ? 'amber' : b.kind === 'unmapped' ? 'red' : b.kind === 'example' ? 'sky' : 'gray'}>{KIND_HINT[b.kind]}</Badge>
            {b.origin && <span>From: {b.origin}</span>}
          </div>
        </div>
      ))}
      <Btn size="sm" onClick={() => onEdit((bs) => void bs.push(blankBlock()))}>
        <Plus className="h-3.5 w-3.5" /> Add section
      </Btn>
    </div>
  );
}
