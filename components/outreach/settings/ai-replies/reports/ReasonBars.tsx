'use client';

/** A ranked list of reasons with counts and a proportional bar. */
export default function ReasonBars({ items, label, empty }: { items: Array<{ reason: string; n: number }>; label: (key: string) => string; empty: string }) {
  if (!items.length) return <p className="text-sm text-gray-400">{empty}</p>;
  const sorted = [...items].sort((a, b) => b.n - a.n);
  const max = Math.max(1, ...sorted.map((i) => i.n));
  return (
    <ul className="space-y-2">
      {sorted.map((i) => (
        <li key={i.reason}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="text-gray-800 min-w-0">{label(i.reason)}</span>
            <span className="tabular-nums text-gray-600">{i.n.toLocaleString()}</span>
          </div>
          <div className="mt-1 h-1.5 rounded-full bg-gray-100 overflow-hidden" aria-hidden="true">
            <div className="h-full rounded-full bg-indigo-500" style={{ width: `${(i.n / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
