'use client';

import { useMemo, useState } from 'react';
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmtDay, type InvitesVsCapPoint } from './insights';

// One measure (invitations per day) on one axis: bars = sent, neutral step line = the cap that applied that day.
const SENT = '#4f46e5';   // indigo-600, the app accent
const CAP = '#374151';    // gray-700: a reference line, deliberately not a series hue
const GRID = '#f3f4f6';
const AXIS = '#6b7280';

function ChartTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload?: InvitesVsCapPoint }> }) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  const reached = p.cap > 0 && p.sent >= p.cap;
  return (
    <div className="rounded-lg border border-gray-200 bg-white shadow-md px-3 py-2 text-xs">
      <div className="font-medium text-gray-900">{fmtDay(p.day)}</div>
      <div className="mt-1 flex items-center gap-2 text-gray-700"><span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: SENT }} aria-hidden />Sent <span className="ml-auto pl-4 tabular-nums font-medium text-gray-900">{p.sent}</span></div>
      <div className="flex items-center gap-2 text-gray-700"><span className="inline-block w-2.5 h-0.5" style={{ background: CAP }} aria-hidden />Cap <span className="ml-auto pl-4 tabular-nums font-medium text-gray-900">{p.cap}</span></div>
      {reached && <div className="mt-1 text-gray-500">Cap reached</div>}
      {p.cap === 0 && <div className="mt-1 text-gray-500">No invitation allowance that day</div>}
    </div>
  );
}

export default function InvitesVsCapChart({ data }: { data: InvitesVsCapPoint[] }) {
  const [asTable, setAsTable] = useState(false);
  const { totalSent, daysAtCap, maxY } = useMemo(() => ({
    totalSent: data.reduce((a, p) => a + p.sent, 0),
    daysAtCap: data.filter((p) => p.cap > 0 && p.sent >= p.cap).length,
    maxY: Math.max(4, ...data.map((p) => Math.max(p.sent, p.cap))),
  }), [data]);
  const hasAnything = data.some((p) => p.sent > 0 || p.cap > 0);
  const summary = `${totalSent.toLocaleString()} invitation${totalSent === 1 ? '' : 's'} sent in 30 days. The cap was reached on ${daysAtCap} day${daysAtCap === 1 ? '' : 's'}.`;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <ul className="flex items-center gap-4 text-xs text-gray-600" aria-label="Legend">
          <li className="flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: SENT }} aria-hidden /> Invitations sent</li>
          <li className="flex items-center gap-1.5"><span className="inline-block w-4 h-0.5" style={{ background: CAP }} aria-hidden /> Cap that applied that day</li>
        </ul>
        <button type="button" onClick={() => setAsTable((v) => !v)} aria-pressed={asTable} className="text-xs text-indigo-600 hover:underline">{asTable ? 'Show chart' : 'Show as table'}</button>
      </div>

      {!hasAnything ? (
        <div className="h-40 flex items-center justify-center text-sm text-gray-500 text-center px-4">No invitations and no invitation allowance in the last 30 days.</div>
      ) : asTable ? (
        <div className="max-h-64 overflow-y-auto border border-gray-200 rounded-lg">
          <table className="min-w-full text-xs">
            <caption className="sr-only">Invitations sent and the daily cap, last 30 days</caption>
            <thead className="sticky top-0 bg-gray-50"><tr><th scope="col" className="text-left font-semibold text-gray-500 px-3 py-2">Day</th><th scope="col" className="text-right font-semibold text-gray-500 px-3 py-2">Sent</th><th scope="col" className="text-right font-semibold text-gray-500 px-3 py-2">Cap</th></tr></thead>
            <tbody>{[...data].reverse().map((p) => (
              <tr key={p.day} className="border-t border-gray-100"><td className="px-3 py-1.5 text-gray-700">{fmtDay(p.day)}</td><td className="px-3 py-1.5 text-right tabular-nums text-gray-900">{p.sent}</td><td className="px-3 py-1.5 text-right tabular-nums text-gray-700">{p.cap}</td></tr>
            ))}</tbody>
          </table>
        </div>
      ) : (
        <div className="h-56" role="img" aria-label={`Bar chart of invitations sent per day against the daily cap. ${summary}`}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }} barCategoryGap="20%">
              <CartesianGrid vertical={false} stroke={GRID} />
              <XAxis dataKey="day" tickFormatter={(d: string) => fmtDay(d, false)} tick={{ fontSize: 11, fill: AXIS }} tickLine={false} axisLine={{ stroke: '#e5e7eb' }} interval="preserveStartEnd" minTickGap={28} />
              <YAxis allowDecimals={false} domain={[0, maxY]} tick={{ fontSize: 11, fill: AXIS }} tickLine={false} axisLine={false} width={44} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: '#f9fafb' }} />
              <Bar dataKey="sent" name="Invitations sent" fill={SENT} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
              <Line dataKey="cap" name="Cap" type="step" stroke={CAP} strokeWidth={2} dot={false} activeDot={false} isAnimationActive={false} strokeLinecap="round" strokeLinejoin="round" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
      <p className="text-xs text-gray-500 mt-2">{summary}</p>
    </div>
  );
}
