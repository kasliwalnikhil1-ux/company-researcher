'use client';

import React from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { cn } from '@/lib/utils';
import { FUNNEL_LABELS, INTENT_KEYS, INTENT_LABELS, fmtDay, fmtHours, fmtInt, fmtRate, type FunnelStage, type IntentCounts, type IntentKey, type SeriesPoint } from '@/lib/outreach/reports';
import { ACCENT, ACCENT_SOFT } from './primitives';

// Colours. Both sets were checked with the dataviz palette validator on a white surface
// (lightness band, chroma floor, colour-blind separation of neighbours). Identity never rests on colour
// alone: every chart has a legend, a tooltip and a table with the same numbers.
export type SeriesKey = 'invites' | 'messages' | 'accepted' | 'replies' | 'interested' | 'meetings' | 'emails';
export const SERIES: Array<{ key: SeriesKey; label: string; color: string }> = [
  { key: 'invites', label: 'Invites', color: '#2a78d6' },
  { key: 'messages', label: 'Messages', color: '#eb6834' },
  { key: 'accepted', label: 'Accepted', color: '#1baf7a' },
  { key: 'replies', label: 'Replies', color: '#eda100' },
  { key: 'interested', label: 'Interested', color: '#008300' },
  { key: 'meetings', label: 'Meetings', color: '#4a3aa7' },
  { key: 'emails', label: 'Emails', color: '#e87ba4' },
];

// Green and red are reserved for positive and negative intent. "Not classified" is the one neutral.
export const INTENT_COLORS: Record<IntentKey, string> = {
  interested: '#008300', question: '#2a78d6', not_now: '#eda100', not_interested: '#e34948',
  wrong_person: '#4a3aa7', ooo: '#e87ba4', unclear: '#1baf7a', unclassified: '#9ca3af',
};

const GRID = '#eef0f3';
const AXIS_TICK = { fontSize: 11, fill: '#6b7280' };

function TooltipCard({ title, rows, footer }: { title: string; rows: Array<{ color?: string; label: string; value: string }>; footer?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 shadow-lg text-xs min-w-[150px]">
      <div className="font-semibold text-gray-900 mb-1">{title}</div>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between gap-4 py-0.5">
          <span className="flex items-center gap-1.5 text-gray-600">{r.color && <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: r.color }} />}{r.label}</span>
          <span className="font-medium text-gray-900 tabular-nums">{r.value}</span>
        </div>
      ))}
      {footer && <div className="mt-1 pt-1 border-t border-gray-100 text-gray-500">{footer}</div>}
    </div>
  );
}

/** Legend that doubles as the series toggle. */
export function SeriesToggles({ series, hidden, onToggle }: { series: typeof SERIES; hidden: Set<string>; onToggle: (key: SeriesKey) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Series shown in the chart">
      {series.map((s) => {
        const off = hidden.has(s.key);
        return (
          <button key={s.key} type="button" aria-pressed={!off} onClick={() => onToggle(s.key)}
            className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors', off ? 'border-gray-200 text-gray-400 bg-white' : 'border-gray-300 text-gray-700 bg-gray-50')}>
            <span className="w-2.5 h-0.5 rounded-full" style={{ background: off ? '#d1d5db' : s.color }} />{s.label}
          </button>
        );
      })}
    </div>
  );
}

export function TimeSeriesChart({ data, series, hidden, height = 280 }: { data: SeriesPoint[]; series: typeof SERIES; hidden: Set<string>; height?: number }) {
  const shown = series.filter((s) => !hidden.has(s.key));
  return (
    <div style={{ height }} role="img" aria-label={`Daily ${shown.map((s) => s.label.toLowerCase()).join(', ')}`}>
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 600, height: 240 }}>
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="day" tickFormatter={(d: string) => fmtDay(d)} tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={28} />
          <YAxis allowDecimals={false} tick={AXIS_TICK} tickLine={false} axisLine={false} width={48} tickFormatter={(v: number) => fmtInt(v)}
            label={{ value: 'Per day', angle: -90, position: 'insideLeft', offset: 14, style: { fontSize: 11, fill: '#9ca3af', textAnchor: 'middle' } }} />
          <Tooltip cursor={{ stroke: '#d1d5db' }} isAnimationActive={false}
            content={(p: any) => (p?.active && p.payload?.length ? <TooltipCard title={fmtDay(p.label, true)} rows={shown.map((s) => ({ color: s.color, label: s.label, value: fmtInt(p.payload[0]?.payload?.[s.key]) }))} /> : null)} />
          {shown.map((s) => (
            <Line key={s.key} type="linear" dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: '#fff', strokeWidth: 2 }} isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function IntentLegend({ counts }: { counts?: IntentCounts }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
      {INTENT_KEYS.map((k) => (
        <span key={k} className="inline-flex items-center gap-1.5 text-xs text-gray-600">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: INTENT_COLORS[k] }} />{INTENT_LABELS[k]}
          {counts && <span className="tabular-nums text-gray-900 font-medium">{fmtInt(counts[k])}</span>}
        </span>
      ))}
    </div>
  );
}

export function IntentStackChart({ rows, height = 260 }: { rows: Array<{ key: string; replies: number; intents: IntentCounts }>; height?: number }) {
  const data = rows.map((r) => ({ day: r.key, replies: r.replies, ...r.intents }));
  return (
    <div style={{ height }} role="img" aria-label="Replies per day, split by intent">
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 600, height: 240 }}>
        <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} barCategoryGap="20%">
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="day" tickFormatter={(d: string) => fmtDay(d)} tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={28} />
          <YAxis allowDecimals={false} tick={AXIS_TICK} tickLine={false} axisLine={false} width={48} tickFormatter={(v: number) => fmtInt(v)}
            label={{ value: 'Replies per day', angle: -90, position: 'insideLeft', offset: 14, style: { fontSize: 11, fill: '#9ca3af', textAnchor: 'middle' } }} />
          <Tooltip cursor={{ fill: '#f3f4f6' }} isAnimationActive={false}
            content={(p: any) => {
              if (!p?.active || !p.payload?.length) return null;
              const d = p.payload[0].payload as Record<string, number>;
              return <TooltipCard title={fmtDay(p.label, true)} rows={INTENT_KEYS.filter((k) => d[k] > 0).map((k) => ({ color: INTENT_COLORS[k], label: INTENT_LABELS[k], value: fmtInt(d[k]) }))} footer={`${fmtInt(d.replies)} ${d.replies === 1 ? 'reply' : 'replies'}`} />;
            }} />
          {INTENT_KEYS.map((k) => <Bar key={k} dataKey={k} name={INTENT_LABELS[k]} stackId="intent" fill={INTENT_COLORS[k]} stroke="#ffffff" strokeWidth={1} maxBarSize={24} isAnimationActive={false} />)}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** One horizontal 100% bar of intents (table rows, headline). */
export function IntentBar({ intents, total, className }: { intents: IntentCounts; total: number; className?: string }) {
  if (!total) return <div className={cn('h-2 rounded-full bg-gray-100', className)} />;
  const label = INTENT_KEYS.filter((k) => intents[k] > 0).map((k) => `${INTENT_LABELS[k]} ${fmtInt(intents[k])}`).join(', ');
  return (
    <div className={cn('flex h-2 gap-[2px] rounded-full overflow-hidden', className)} role="img" aria-label={label} title={label}>
      {INTENT_KEYS.map((k) => (intents[k] > 0 ? <div key={k} style={{ width: `${(intents[k] / total) * 100}%`, background: INTENT_COLORS[k] }} /> : null))}
    </div>
  );
}

/** Small line with a hover tooltip: the per-sender trend. */
export function Sparkline({ data, dataKey, label, color = '#4f46e5', height = 44 }: { data: Array<Record<string, any>>; dataKey: string; label: string; color?: string; height?: number }) {
  if (data.length < 2) return <div className="text-xs text-gray-400" style={{ height, lineHeight: `${height}px` }}>Not enough days to draw a trend</div>;
  return (
    <div style={{ height }} role="img" aria-label={`${label} per day`}>
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 600, height: 240 }}>
        <LineChart data={data} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
          <Tooltip isAnimationActive={false} cursor={{ stroke: '#d1d5db' }}
            content={(p: any) => (p?.active && p.payload?.length ? <TooltipCard title={fmtDay(p.payload[0].payload.day, true)} rows={[{ color, label, value: fmtInt(p.payload[0].payload[dataKey]) }]} /> : null)} />
          <Line type="linear" dataKey={dataKey} stroke={color} strokeWidth={2} dot={false} activeDot={{ r: 3, stroke: '#fff', strokeWidth: 2 }} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Horizontal funnel: one bar per stage, scaled to the enrolled cohort, with the median time between stages. */
export function FunnelBars({ stages }: { stages: FunnelStage[] }) {
  const top = stages[0]?.count ?? 0;
  return (
    <ol className="space-y-0">
      {stages.map((s, i) => {
        const width = top > 0 ? Math.max((s.count / top) * 100, s.count > 0 ? 0.75 : 0) : 0;
        return (
          <li key={s.stage}>
            {i > 0 && (
              <div className="grid grid-cols-[150px_1fr] gap-4 items-center h-7">
                <span />
                <span className="flex items-center gap-2 text-xs text-gray-500 pl-1">
                  <span className="w-px h-4 bg-gray-200" aria-hidden />
                  {s.median_hours_from_previous !== null ? <>Median {fmtHours(s.median_hours_from_previous)} after {FUNNEL_LABELS[stages[i - 1].stage].toLowerCase()}</> : <span className="text-gray-300">No timing yet</span>}
                </span>
              </div>
            )}
            <div className="grid grid-cols-[150px_1fr] gap-4 items-center">
              <div className="text-sm font-medium text-gray-900">{FUNNEL_LABELS[s.stage]}</div>
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex-1 h-6 rounded-r bg-gray-50 min-w-0">
                  <div className="h-6 rounded-r" style={{ width: `${width}%`, background: i === 0 ? ACCENT_SOFT : ACCENT, border: i === 0 ? `1px solid ${ACCENT}` : undefined }} />
                </div>
                <div className="w-[230px] flex-shrink-0 grid grid-cols-[70px_80px_80px] text-right items-baseline">
                  <span className="text-sm font-semibold text-gray-900 tabular-nums">{fmtInt(s.count)}</span>
                  <span className="text-xs text-gray-600 tabular-nums">{i === 0 ? '' : fmtRate(s.pct_of_enrolled)}</span>
                  <span className="text-xs text-gray-600 tabular-nums">{i === 0 ? '' : fmtRate(s.pct_of_previous)}</span>
                </div>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** A labelled bar relative to a maximum (step drop-off, mini funnels). */
export function MiniBar({ value, max, className }: { value: number; max: number; className?: string }) {
  const w = max > 0 ? Math.max((value / max) * 100, value > 0 ? 1 : 0) : 0;
  return <div className={cn('h-2 rounded-r bg-gray-100', className)}><div className="h-2 rounded-r" style={{ width: `${w}%`, background: ACCENT }} /></div>;
}
