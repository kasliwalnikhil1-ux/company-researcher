'use client';

import type { SparkPoint } from '@/lib/outreach/health';

const COLOR: Record<string, string> = { ok: '#10b981', watch: '#f59e0b', act: '#ef4444', unknown: '#d1d5db' };

/** The 7-day line of a check (§3.3): one bar per bucket, coloured by the worst status seen in it. */
export default function Sparkline({ points, width = 112, height = 24, title = '7 days' }: { points: SparkPoint[]; width?: number; height?: number; title?: string }) {
  if (!points?.length) return <div className="text-[11px] text-gray-400" title="No history yet">no history</div>;
  const vals = points.map((p) => (p.v == null ? 0 : p.v));
  const max = Math.max(1, ...vals);
  const w = width / points.length;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title} className="shrink-0">
      <title>{title}</title>
      {points.map((p, i) => {
        const h = p.v == null ? 2 : Math.max(2, ((p.v) / max) * (height - 2));
        return <rect key={i} x={i * w + 0.5} y={height - h} width={Math.max(1, w - 1)} height={h} rx={1} fill={COLOR[p.s] ?? COLOR.unknown} opacity={p.v == null ? 0.5 : 0.9} />;
      })}
    </svg>
  );
}
