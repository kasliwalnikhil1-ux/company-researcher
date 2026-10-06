'use client';

// ▸ Advanced: reply delay, debounce, stale limit, languages, disclosure, blocked countries, hand-off stage, gap thresholds, quiet task.
import { useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { Stage } from '@/lib/outreach/types';
import { useSetSequenceAiReplies, type SequenceAiPatch, type SequenceAiSettings } from '@/lib/outreach/aiRepliesSequence';
import { Button, Input, Select, Textarea } from '@/components/outreach/ui';
import BlockedCountriesField from './BlockedCountriesField';
import { errText } from './shared';

interface Form {
  delay_min: string; delay_max: string; quiet: string; max: string; stale: string; languages: string; disclosure: string; countries: string[];
  handoff_stage_id: string; returning: string; dormant: string; inactivity: string;
}

function fromSettings(s: SequenceAiSettings): Form {
  return {
    delay_min: String(Math.round(s.delay_min_s / 60)), delay_max: String(Math.round(s.delay_max_s / 60)), quiet: String(s.debounce_quiet_s), max: String(s.debounce_max_s),
    stale: String(s.stale_after_h), languages: (s.languages ?? []).join(', '), disclosure: s.disclosure ?? '', countries: s.blocked_countries ?? [],
    handoff_stage_id: s.handoff_stage_id ?? '', returning: String(s.returning_after_days), dormant: String(s.dormant_after_days), inactivity: s.inactivity_days == null ? '' : String(s.inactivity_days),
  };
}

const NUM_CLS = 'px-2 py-1 text-sm rounded-lg border border-gray-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-gray-50 tabular-nums';
const Num = ({ value, min, max, label, width = 'w-20', onChange }: { value: string; min: number; max: number; label: string; width?: string; onChange: (v: string) => void }) => (
  <input type="number" inputMode="numeric" min={min} max={max} step={1} value={value} aria-label={label} onChange={(e) => onChange(e.target.value)} className={`${NUM_CLS} ${width}`} />
);

const list = (v: string, upper: boolean) => v.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean).map((x) => (upper ? x.toUpperCase() : x.toLowerCase()));
const int = (v: string) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : NaN; };

/** The patch for what differs from the saved settings, and the problems that block saving. */
function toPatch(f: Form, s: SequenceAiSettings): { patch: SequenceAiPatch; errors: string[] } {
  const patch: SequenceAiPatch = {};
  const errors: string[] = [];
  const dmin = int(f.delay_min) * 60, dmax = int(f.delay_max) * 60;
  if (!(dmin >= 60 && dmax <= 3600 && dmax > dmin)) errors.push('Reply delay: 1 to 60 minutes, with the longest above the shortest.');
  if (dmin !== s.delay_min_s) patch.delay_min_s = dmin;
  if (dmax !== s.delay_max_s) patch.delay_max_s = dmax;
  const q = int(f.quiet), m = int(f.max);
  if (!(q >= 30 && q <= 600)) errors.push('Wait for them to finish typing: 30 to 600 seconds.');
  if (!(m >= 60 && m <= 1800)) errors.push('Longest wait: 60 to 1800 seconds.');
  if (q !== s.debounce_quiet_s) patch.debounce_quiet_s = q;
  if (m !== s.debounce_max_s) patch.debounce_max_s = m;
  const st = int(f.stale);
  if (!(st >= 1 && st <= 72)) errors.push('Skip messages older than: 1 to 72 hours.');
  if (st !== s.stale_after_h) patch.stale_after_h = st;
  const langs = list(f.languages, false);
  if (!langs.length || langs.some((l) => !/^[a-z]{2,3}$/.test(l))) errors.push('Languages: codes like en or hi, separated by commas.');
  if (langs.join(',') !== (s.languages ?? []).join(',')) patch.languages = langs;
  const disc = f.disclosure.trim();
  if (disc.length > 200) errors.push('The disclosure line is up to 200 characters.');
  if (disc !== (s.disclosure ?? '')) patch.disclosure = disc || null;
  const sorted = (l: string[]) => [...l].sort().join(',');
  if (sorted(f.countries) !== sorted(s.blocked_countries ?? [])) patch.blocked_countries = f.countries;
  if ((f.handoff_stage_id || null) !== (s.handoff_stage_id ?? null)) patch.handoff_stage_id = f.handoff_stage_id || null;
  const r = int(f.returning), d = int(f.dormant);
  if (!(r >= 1 && r <= 30)) errors.push('Returning after: 1 to 30 days.');
  if (!(d >= 7 && d <= 365 && d > r)) errors.push('Dormant after: 7 to 365 days, above the returning threshold.');
  if (r !== s.returning_after_days) patch.returning_after_days = r;
  if (d !== s.dormant_after_days) patch.dormant_after_days = d;
  const inact = f.inactivity.trim() ? int(f.inactivity) : null;
  if (inact !== null && !(inact >= 1 && inact <= 60)) errors.push('Task if quiet for: 1 to 60 days, or empty for off.');
  if (inact !== (s.inactivity_days ?? null)) patch.inactivity_days = inact;
  return { patch, errors };
}

export default function AdvancedSection({ sequenceId, s, stages, canEdit, notify, alwaysOpen }: {
  sequenceId: string; s: SequenceAiSettings; stages: Stage[]; canEdit: boolean; notify: (m: string, t?: 'success' | 'error') => void;
  /** A plain card with a heading instead of the collapsed "Advanced" row (the Rules sub-tab). */
  alwaysOpen?: boolean;
}) {
  const set = useSetSequenceAiReplies(sequenceId);
  const [expanded, setOpen] = useState(false);
  const open = alwaysOpen || expanded;
  const [form, setForm] = useState<Form | null>(null);
  const f = form ?? fromSettings(s);
  const upd = (p: Partial<Form>) => setForm({ ...f, ...p });
  const { patch, errors } = useMemo(() => toPatch(f, s), [f, s]);
  const dirty = Object.keys(patch).length > 0;
  const disabled = !canEdit || set.isPending;

  const saveAll = () => set.mutate({ patch }, {
    onSuccess: (r) => { setForm(null); notify(`Saved. Applies to the next reply in ${r.settings?.applies_to ?? s.open_conversations} open conversations.`); },
    onError: (e) => notify(errText(e), 'error'),
  });

  return (
    <div className="bg-white border border-gray-200 rounded-xl">
      {alwaysOpen ? (
        <div className="px-4 pt-4 pb-3">
          <h3 className="text-sm font-semibold text-gray-900">Timing, language and hand-off</h3>
          <p className="text-xs text-gray-500 mt-0.5">When a reply goes out, which messages get one, and what happens when a person takes over.</p>
        </div>
      ) : (
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="w-full flex items-center gap-2 px-4 py-3 text-left">
          <ChevronRight className={`w-4 h-4 text-gray-500 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
          <span className="text-sm font-semibold text-gray-900">Advanced</span>
          <span className="text-xs text-gray-500 hidden sm:inline">reply delay · languages · AI disclosure line · hand-off stage · returning / dormant · task if quiet</span>
        </button>
      )}
      {open && (
        <fieldset disabled={disabled} className="px-4 pb-4 space-y-5">
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-1">
              <span className="block text-xs font-medium text-gray-600">Reply delay (minutes)</span>
              <div className="flex items-center gap-2 text-sm text-gray-700">
                <Num min={1} max={60} value={f.delay_min} onChange={(v) => upd({ delay_min: v })} label="Shortest delay" /> to
                <Num min={1} max={60} value={f.delay_max} onChange={(v) => upd({ delay_max: v })} label="Longest delay" />
              </div>
              <span className="block text-xs text-gray-500">How long an Auto reply waits before it goes out. A person can send it earlier, edit it or cancel it.</span>
            </div>
            <div className="space-y-1">
              <span className="block text-xs font-medium text-gray-600">Wait for them to finish typing (seconds)</span>
              <div className="flex items-center gap-2 text-sm text-gray-700">
                <Num min={30} max={600} value={f.quiet} onChange={(v) => upd({ quiet: v })} label="Quiet time" width="w-24" /> quiet, at most
                <Num min={60} max={1800} value={f.max} onChange={(v) => upd({ max: v })} label="Longest wait" width="w-24" />
              </div>
              <span className="block text-xs text-gray-500">Several messages in a row are answered together.</span>
            </div>
            <Input type="number" min={1} max={72} label="Skip messages older than (hours)" value={f.stale} onChange={(e) => upd({ stale: e.target.value })} hint="An old unanswered message gets no automatic reply." />
            <Input label="Languages" value={f.languages} onChange={(e) => upd({ languages: e.target.value })} placeholder="en, hi" hint="Codes separated by commas. A message in another language goes to a person." />
            <Textarea label="AI disclosure line" rows={2} maxLength={200} value={f.disclosure} onChange={(e) => upd({ disclosure: e.target.value })} placeholder="e.g. (replies on this account are AI-assisted)" hint="Added to the end of every Auto reply. Optional." className="min-h-0" />
            <BlockedCountriesField value={f.countries} onChange={(countries) => upd({ countries })} />
            <Select label="Move lead to stage on hand-off" value={f.handoff_stage_id} onChange={(e) => upd({ handoff_stage_id: e.target.value })}>
              <option value="">Do not move the lead</option>
              {stages.map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}
            </Select>
            <div className="space-y-1">
              <span className="block text-xs font-medium text-gray-600">Prospects who come back</span>
              <div className="flex flex-wrap items-center gap-2 text-sm text-gray-700">
                returning after <Num min={1} max={30} value={f.returning} onChange={(v) => upd({ returning: v })} label="Returning after days" /> days,
                dormant after <Num min={7} max={365} value={f.dormant} onChange={(v) => upd({ dormant: v })} label="Dormant after days" /> days
              </div>
              <span className="block text-xs text-gray-500">Returning: counters reset, stage kept. Dormant: starts again at Re-engage.</span>
            </div>
            <Input type="number" min={1} max={60} label="Task if quiet for (days)" value={f.inactivity} onChange={(e) => upd({ inactivity: e.target.value })} placeholder="off" hint="A person gets a task when the prospect stops replying mid-conversation. Empty = off. The AI never nudges." />
          </div>
          {errors.length > 0 && dirty && <ul className="text-xs text-red-700 list-disc pl-5 space-y-0.5">{errors.map((e) => <li key={e}>{e}</li>)}</ul>}
          {canEdit && (
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={saveAll} disabled={!dirty || errors.length > 0} loading={set.isPending}>Save advanced settings</Button>
              {dirty && <Button size="sm" variant="ghost" onClick={() => setForm(null)}>Discard</Button>}
            </div>
          )}
        </fieldset>
      )}
    </div>
  );
}
