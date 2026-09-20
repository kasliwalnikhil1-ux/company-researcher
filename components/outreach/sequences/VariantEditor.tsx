'use client';

// Item 11: message variants inside a step. With no variants it is the step's normal copy field(s);
// "A/B test this step" turns the copy into up to five weighted variants, each with its own counter and preview.
import { useState } from 'react';
import { FlaskConical, Plus, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MAX_VARIANTS, type GraphNode, type MessageVariant } from '@/lib/outreach/types';
import { Button } from '@/components/outreach/ui';
import TemplateField from './TemplateField';
import VariantResults from './VariantResults';
import { Note } from './FormsShared';

type TextKey = 'note' | 'text' | 'html';

interface Props {
  node: GraphNode;
  cfg: Record<string, any>;
  /** Merge several config keys in one change. */
  patch: (values: Record<string, unknown>) => void;
  textKey: TextKey;
  label: string;
  max?: number;
  rows?: number;
  placeholder?: string;
  hint?: string;
  channel?: 'linkedin' | 'email';
  /** Steps with a subject line (InMail, email). */
  subject?: { label: string; max?: number };
}

const IDS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

function weightOf(v: MessageVariant): number { const w = Number(v.weight ?? 1); return Number.isFinite(w) && w > 0 ? w : 0; }

/** Weights as whole percentages that add up to 100 (largest remainder), for display only. */
export function normalisedPercents(weights: number[]): number[] {
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (w / total) * 100);
  const out = exact.map(Math.floor);
  let left = 100 - out.reduce((s, x) => s + x, 0);
  const order = exact.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r);
  for (const o of order) { if (left <= 0) break; if (weights[o.i] > 0) { out[o.i] += 1; left -= 1; } }
  return out;
}

function evenWeights(n: number): number[] {
  const base = Math.floor(100 / n);
  return Array.from({ length: n }, (_, i) => base + (i < 100 - base * n ? 1 : 0));
}

export default function VariantEditor({ node, cfg, patch, textKey, label, max, rows = 6, placeholder, hint, channel = 'linkedin', subject }: Props) {
  const variants: MessageVariant[] = Array.isArray(cfg.variants) ? cfg.variants : [];
  const [active, setActive] = useState(0);
  const [confirmStop, setConfirmStop] = useState(false);
  const current = Math.min(active, Math.max(0, variants.length - 1));

  // The base copy mirrors the first variant, so the canvas summary and older readers always show real text.
  const commit = (next: MessageVariant[]) => {
    const first = next[0];
    patch({ variants: next, [textKey]: first?.[textKey] ?? '', ...(subject ? { subject: first?.subject ?? '' } : {}) });
  };

  if (variants.length === 0) {
    const start = () => {
      const base: MessageVariant = { id: 'a', label: 'A', weight: 50, [textKey]: cfg[textKey] ?? '', ...(subject ? { subject: cfg.subject ?? '' } : {}) };
      const second: MessageVariant = { id: 'b', label: 'B', weight: 50, [textKey]: '', ...(subject ? { subject: cfg.subject ?? '' } : {}) };
      commit([base, second]);
      setActive(1);
    };
    return (
      <div className="space-y-3">
        {subject && <TemplateField label={subject.label} value={cfg.subject ?? ''} onChange={(v) => patch({ subject: v })} max={subject.max} multiline={false} channel={channel} />}
        <TemplateField label={label} value={cfg[textKey] ?? ''} onChange={(v) => patch({ [textKey]: v })} max={max} rows={rows} placeholder={placeholder} hint={hint} channel={channel} />
        <Button type="button" variant="secondary" size="sm" onClick={start}><FlaskConical className="w-3.5 h-3.5" aria-hidden /> A/B test this step</Button>
      </div>
    );
  }

  const percents = normalisedPercents(variants.map(weightOf));
  const v = variants[current];
  const setVariant = (i: number, p: Partial<MessageVariant>) => commit(variants.map((x, idx) => (idx === i ? { ...x, ...p } : x)));
  const add = () => {
    if (variants.length >= MAX_VARIANTS) return;
    const id = IDS.find((x) => !variants.some((y) => y.id === x)) ?? `v${Date.now().toString(36)}`;
    const copy: MessageVariant = { id, label: id.toUpperCase(), weight: Math.max(1, Math.round(variants.reduce((s, x) => s + weightOf(x), 0) / variants.length)), [textKey]: v?.[textKey] ?? '', ...(subject ? { subject: v?.subject ?? '' } : {}) };
    commit([...variants, copy]);
    setActive(variants.length);
  };
  const remove = (i: number) => {
    if (variants.length <= 2) { setConfirmStop(true); return; }
    commit(variants.filter((_, idx) => idx !== i));
    setActive(Math.max(0, i - 1));
  };
  const stop = (keep: number) => {
    const k = variants[keep];
    patch({ variants: undefined, [textKey]: k?.[textKey] ?? '', ...(subject ? { subject: k?.subject ?? '' } : {}) });
    setConfirmStop(false); setActive(0);
  };
  const splitEvenly = () => { const w = evenWeights(variants.length); commit(variants.map((x, i) => ({ ...x, weight: w[i] }))); };
  const onPromoted = (variantId: string) => commit(variants.map((x) => ({ ...x, weight: x.id === variantId ? 100 : 0 })));

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-indigo-100 bg-indigo-50/30 p-2.5 space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-gray-800 flex items-center gap-1"><FlaskConical className="w-3.5 h-3.5 text-indigo-600" aria-hidden /> A/B test</span>
          <button type="button" onClick={() => setConfirmStop(true)} className="text-[11px] text-gray-500 hover:text-gray-800 underline">Stop the test</button>
        </div>
        <div role="tablist" aria-label="Variants" className="flex flex-wrap items-center gap-1">
          {variants.map((x, i) => (
            <button key={x.id || i} role="tab" type="button" aria-selected={i === current} onClick={() => setActive(i)}
              className={cn('px-2 py-1 rounded-md text-xs border', i === current ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50', weightOf(x) === 0 && i !== current && 'opacity-60')}>
              {x.label || x.id} <span className={cn('tabular-nums', i === current ? 'text-indigo-100' : 'text-gray-400')}>{percents[i]}%</span>
            </button>
          ))}
          {variants.length < MAX_VARIANTS && <button type="button" onClick={add} className="px-2 py-1 rounded-md text-xs border border-dashed border-gray-300 text-gray-600 hover:bg-white inline-flex items-center gap-1" title="Add a variant (copies the one you are on)"><Plus className="w-3 h-3" aria-hidden /> Add</button>}
        </div>

        {v && (
          <div role="tabpanel" aria-label={`Variant ${v.label || v.id}`} className="space-y-2.5">
            <div className="grid grid-cols-[1fr_96px_auto] gap-2 items-end">
              <label className="block min-w-0">
                <span className="block text-[11px] text-gray-500 mb-0.5">Name</span>
                <input value={v.label ?? ''} onChange={(e) => setVariant(current, { label: e.target.value })} maxLength={40} className="w-full px-2 py-1 text-xs rounded border border-gray-300 bg-white" />
              </label>
              <label className="block">
                <span className="block text-[11px] text-gray-500 mb-0.5">Weight</span>
                <input type="number" min={0} max={100} value={v.weight ?? 1} onChange={(e) => setVariant(current, { weight: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })} className="w-full px-2 py-1 text-xs rounded border border-gray-300 bg-white tabular-nums" aria-describedby={`${node.id}-weight-help`} />
              </label>
              <button type="button" onClick={() => remove(current)} className="p-1.5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50" aria-label={`Remove variant ${v.label || v.id}`}><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
            <p id={`${node.id}-weight-help`} className="text-[11px] text-gray-500 leading-4">
              Gets {percents[current]}% of leads. Weights are shares, so they do not have to add up to 100. 0 turns a variant off.{' '}
              <button type="button" onClick={splitEvenly} className="underline hover:text-gray-800">Split evenly</button>
            </p>
            {subject && <TemplateField key={`${v.id}-subject`} label={`${subject.label} · ${v.label || v.id}`} value={v.subject ?? ''} onChange={(t) => setVariant(current, { subject: t })} max={subject.max} multiline={false} channel={channel} />}
            <TemplateField key={`${v.id}-body`} label={`${label} · ${v.label || v.id}`} value={v[textKey] ?? ''} onChange={(t) => setVariant(current, { [textKey]: t })} max={max} rows={rows} placeholder={placeholder} hint={hint} channel={channel} />
          </div>
        )}
        {percents.every((p) => p === 0) && <p className="text-xs text-red-600" role="alert">Every variant has weight 0. Give at least one variant a weight.</p>}
        <Note>Each lead always gets the same variant. No winner is declared under 100 sends per variant.</Note>
      </div>

      <VariantResults nodeId={node.id} onPromoted={onPromoted} />

      {confirmStop && (
        <div role="alertdialog" aria-label="Stop the A/B test" className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 space-y-2">
          <p className="text-xs text-amber-900">Stop the test and keep one text for everyone. Which one? Results collected so far stay in the reports.</p>
          <div className="flex flex-wrap gap-1.5">
            {variants.map((x, i) => <Button key={x.id || i} type="button" size="sm" variant="secondary" onClick={() => stop(i)}>Keep {x.label || x.id}</Button>)}
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmStop(false)}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}
