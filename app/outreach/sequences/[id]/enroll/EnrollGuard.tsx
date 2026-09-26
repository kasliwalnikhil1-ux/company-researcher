'use client';

// Shared by the enrol page and the leads "Enrol" modal: the enrol guard preview (RPC enroll_preview), the commit
// (RPC enroll_leads) and "generate first lines" (RPC ai_generate_request). Eligibility is never worked out here:
// every number on screen comes from the database.
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Sparkles, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { supabase } from '@/utils/supabase/client';
import { parseError, rpc } from '@/lib/outreach/api';
import { sequenceAiKeys } from '@/lib/outreach/graph';
import { SEQUENCE_ASSIGNMENTS, type AiGenerateResult, type AiVariable, type EnrollPreview, type EnrollResult, type Graph, type Sequence } from '@/lib/outreach/types';
import { Badge, ErrorBox, Spinner, StatusPill, fmtDate, timeAgo } from '@/components/outreach/ui';

const PREVIEW_CHUNK = 2000;
const COMMIT_CHUNK = 500;
const AI_CHUNK = 2000;   // ai_generate_request takes at most 2000 leads per batch

// ---------------------------------------------------------------------------
// Plain words for the database's reason codes
// ---------------------------------------------------------------------------
const KIND_WORDS: Record<string, string> = { company: 'company', domain: 'email domain', email: 'email address', public_identifier: 'LinkedIn profile' };
const SCOPE_WORDS: Record<string, string> = { workspace: 'the workspace blacklist', client: 'this client’s blacklist', sequence: 'this sequence’s blacklist' };

/** `suppressed:client_blacklist:company` → "Their company is on this client’s blacklist". */
export function excludedReasonText(reason: string): string {
  if (reason === 'not_in_workspace') return 'Not found in this workspace';
  if (reason === 'replied_recently') return 'Replied to someone on your team in the last 90 days';
  if (reason === 'already_enrolled') return 'Already live in a sequence with every sender in the pool';
  if (reason === 'no_fresh_sender') return 'Skipped: every sender has contacted them before';
  if (reason === 'no_identity') return 'No Instagram handle / WhatsApp number on file for the channel this sequence uses';
  if (reason === 'no_consent') return 'No recorded WhatsApp consent';
  if (reason.startsWith('suppressed:')) {
    const why = reason.slice('suppressed:'.length);
    if (why === 'do_not_contact') return 'Marked do not contact';
    if (why === 'unsubscribed') return 'Unsubscribed';
    const m = /^(workspace|client|sequence)_blacklist:(.+)$/.exec(why);
    if (m) return `Their ${KIND_WORDS[m[2]] ?? m[2]} is on ${SCOPE_WORDS[m[1]]}`;
    return `Suppressed (${why.replace(/[_:]/g, ' ')})`;
  }
  return reason.replace(/[_:]/g, ' ');
}

export function ruleEffectText(note: string, count: number): string {
  const n = count.toLocaleString();
  const s = count === 1 ? '' : 's';
  if (note === 'moved_to_fresh_sender') return `${n} moved to a sender that never contacted them`;
  if (note === 'kept_with_previous_sender') return `${n} kept with the sender who last spoke to them`;
  if (note === 'contacted_before_by_this_sender') return `${n} lead${s} assigned to a sender who contacted them before`;
  return `${n}: ${note.replace(/_/g, ' ')}`;
}

// ---------------------------------------------------------------------------
// RPC wrappers
// ---------------------------------------------------------------------------
function mergePreviews(parts: EnrollPreview[]): EnrollPreview {
  const out: EnrollPreview = { ...parts[0], eligible_ids: [...parts[0].eligible_ids], excluded: {}, replied_recently: [], assignment: [], rule_effects: {}, warnings: [] };
  out.requested = 0; out.eligible = 0; out.eligible_ids = [];
  const bySender = new Map<string, EnrollPreview['assignment'][number]>();
  for (const p of parts) {
    out.requested += p.requested; out.eligible += p.eligible; out.eligible_ids.push(...p.eligible_ids);
    for (const [reason, v] of Object.entries(p.excluded ?? {})) {
      const cur = out.excluded[reason] ?? (out.excluded[reason] = { count: 0, sample_ids: [] });
      cur.count += v.count; cur.sample_ids = [...cur.sample_ids, ...v.sample_ids].slice(0, 10);
    }
    out.replied_recently.push(...(p.replied_recently ?? []));
    for (const a of p.assignment ?? []) { const cur = bySender.get(a.sender_id); if (cur) cur.leads += a.leads; else bySender.set(a.sender_id, { ...a }); }
    for (const [note, c] of Object.entries(p.rule_effects ?? {})) out.rule_effects[note] = (out.rule_effects[note] ?? 0) + c;
    // per-chunk counts inside a warning sentence would mislead; the same fact is shown from rule_effects
    for (const w of p.warnings ?? []) if (!/were contacted before by the sender/.test(w) && !out.warnings.includes(w)) out.warnings.push(w);
  }
  out.assignment = [...bySender.values()];
  out.replied_recently = out.replied_recently.sort((a, b) => (a.last_replied_at < b.last_replied_at ? 1 : -1)).slice(0, 50);
  return out;
}

/** One enroll_preview call for up to 2,000 leads; larger selections are previewed in slices and added up, with the projection asked for the total. */
export async function runEnrollPreview(sequenceId: string, leadIds: string[], senderId: string | null, includeReplied: boolean): Promise<EnrollPreview> {
  const args = (ids: string[]) => ({ p_sequence: sequenceId, p_lead_ids: ids, p_sender: senderId, p_include_replied: includeReplied });
  if (leadIds.length <= PREVIEW_CHUNK) return rpc<EnrollPreview>('enroll_preview', args(leadIds));
  const parts: EnrollPreview[] = [];
  for (let i = 0; i < leadIds.length; i += PREVIEW_CHUNK) parts.push(await rpc<EnrollPreview>('enroll_preview', args(leadIds.slice(i, i + PREVIEW_CHUNK))));
  const merged = mergePreviews(parts);
  merged.projection = undefined;
  if (merged.eligible > 0) {
    const rows = await rpc<Array<{ estimated_days: number; bottleneck: string | null }> | { estimated_days: number; bottleneck: string | null }>('project_sequence', { p_sequence: sequenceId, p_lead_count: merged.eligible });
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (row) merged.projection = { estimated_days: row.estimated_days, bottleneck: row.bottleneck };
  }
  return merged;
}

export const EMPTY_RESULT: EnrollResult = { enrolled: 0, skipped_active: 0, skipped_suppressed: 0, skipped_other: 0, skipped_replied: 0, waiting: 0 };

export interface CommitOptions { senderId: string | null; priority: number; includeReplied: boolean; waitEnrichment: boolean | null; onProgress?: (done: number, total: number) => void }

/** Commit with enroll_leads in slices of 500. On an error the totals so far travel with it (`partial`). */
export async function commitEnrollment(sequenceId: string, leadIds: string[], o: CommitOptions): Promise<EnrollResult> {
  const total: EnrollResult = { ...EMPTY_RESULT };
  o.onProgress?.(0, leadIds.length);
  for (let i = 0; i < leadIds.length; i += COMMIT_CHUNK) {
    try {
      const rows = await rpc<EnrollResult[] | EnrollResult>('enroll_leads', {
        p_sequence: sequenceId, p_lead_ids: leadIds.slice(i, i + COMMIT_CHUNK), p_sender: o.senderId, p_priority: o.priority,
        p_include_replied: o.includeReplied, p_rule: null, p_wait_enrichment: o.waitEnrichment,
      });
      const r = Array.isArray(rows) ? rows[0] : rows;
      if (r) for (const k of Object.keys(total) as Array<keyof EnrollResult>) total[k] += Number(r[k] ?? 0);
    } catch (e) {
      throw Object.assign(parseError(e), { partial: total });
    }
    o.onProgress?.(Math.min(i + COMMIT_CHUNK, leadIds.length), leadIds.length);
  }
  return total;
}

export interface AiBatchLink { variable: AiVariable; batch_id: string; to_generate: number; kept_existing: number }

/** "Generate first lines for these leads": one request per AI variable the sequence uses (in slices of 2,000 leads). */
export async function requestAiLines(ws: string, sequenceId: string, variables: AiVariable[], leadIds: string[]): Promise<AiBatchLink[]> {
  const out: AiBatchLink[] = [];
  for (const variable of variables) {
    for (let i = 0; i < leadIds.length; i += AI_CHUNK) {
      const r = await rpc<AiGenerateResult>('ai_generate_request', { p_ws: ws, p_variable: variable.id, p_lead_ids: leadIds.slice(i, i + AI_CHUNK), p_sequence: sequenceId, p_regenerate: false });
      out.push({ variable, batch_id: r.batch_id, to_generate: r.to_generate, kept_existing: r.kept_existing });
    }
  }
  return out;
}

/** The AI variables a sequence's copy uses, matched to the workspace's saved variables. */
export function useSequenceAiVariables(ws: string | null | undefined, graph: Graph | null | undefined) {
  const keys = useMemo(() => sequenceAiKeys(graph), [graph]);
  const q = useQuery({
    queryKey: ['outreach', ws ?? '', 'ai_variables'], enabled: !!ws && keys.length > 0, staleTime: 60000,
    queryFn: async () => {
      const { data, error } = await supabase.from('outreach_ai_variables').select('*').eq('workspace_id', ws!).order('name');
      if (error) throw parseError(error);
      return (data ?? []) as AiVariable[];
    },
  });
  const used = useMemo(() => (q.data ?? []).filter((v) => keys.includes(v.key)), [q.data, keys]);
  const missing = useMemo(() => (q.data ? keys.filter((k) => !q.data!.some((v) => v.key === k)) : []), [q.data, keys]);
  return { keys, used, missing, isLoading: q.isLoading, error: q.error };
}

/** Runs the preview whenever its inputs change (debounced), and drops answers that arrive out of order. */
export function useEnrollPreview(sequenceId: string | null, leadIds: string[], senderId: string | null, includeReplied: boolean, enabled: boolean) {
  const [state, setState] = useState<{ preview: EnrollPreview | null; loading: boolean; error: string | null }>({ preview: null, loading: false, error: null });
  const run = useRef(0);
  const idsKey = useMemo(() => `${leadIds.length}:${leadIds[0] ?? ''}:${leadIds[leadIds.length - 1] ?? ''}`, [leadIds]);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!enabled || !sequenceId || leadIds.length === 0) { run.current++; setState({ preview: null, loading: false, error: null }); return; }
    const mine = ++run.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    const t = setTimeout(() => {
      runEnrollPreview(sequenceId, leadIds, senderId, includeReplied)
        .then((preview) => { if (run.current === mine) setState({ preview, loading: false, error: null }); })
        .catch((e) => { if (run.current === mine) setState({ preview: null, loading: false, error: parseError(e).message }); });
    }, 150);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, sequenceId, idsKey, senderId, includeReplied, nonce]);
  return { ...state, refresh: () => setNonce((n) => n + 1) };
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
function Tile({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'green' | 'amber' }) {
  return (
    <div className="rounded-lg border border-gray-200 px-3 py-2">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={cn('text-lg font-semibold tabular-nums', tone === 'green' ? 'text-green-700' : tone === 'amber' ? 'text-amber-700' : 'text-gray-900')}>{value}</div>
    </div>
  );
}

function days(n: number): string {
  if (n >= 9999) return 'no capacity: nothing can be scheduled';
  if (n < 1) return 'less than a day';
  return `about ${n.toLocaleString()} day${n === 1 ? '' : 's'}`;
}

interface PanelProps {
  preview: EnrollPreview | null;
  loading: boolean;
  error: string | null;
  includeReplied: boolean;
  onIncludeReplied: (v: boolean) => void;
  /** Hide the projection line (the page shows the full projection table instead). */
  hideProjection?: boolean;
  compact?: boolean;
}

export function EnrollPreviewPanel({ preview, loading, error, includeReplied, onIncludeReplied, hideProjection, compact }: PanelProps) {
  const [showReplied, setShowReplied] = useState(false);
  if (error) return <ErrorBox message={error} />;
  if (!preview) return loading ? <div className="flex items-center gap-2 text-sm text-gray-500"><Spinner className="!py-2" /> Checking who can be enrolled…</div> : null;

  const excluded = Object.entries(preview.excluded ?? {}).sort((a, b) => b[1].count - a[1].count);
  const excludedTotal = preview.requested - preview.eligible;
  const replied = preview.replied_recently ?? [];
  const repliedCount = preview.excluded?.replied_recently?.count ?? 0;
  const effects = Object.entries(preview.rule_effects ?? {});
  const rule = SEQUENCE_ASSIGNMENTS.find((a) => a.value === preview.assignment_rule);
  const noFresh = preview.excluded?.no_fresh_sender?.count ?? 0;

  return (
    <div className={cn('space-y-4 transition-opacity', loading && 'opacity-60')} aria-busy={loading}>
      <div className={cn('grid gap-3', compact ? 'grid-cols-3' : 'sm:grid-cols-3')}>
        <Tile label="Selected" value={preview.requested.toLocaleString()} />
        <Tile label="Will be enrolled" value={preview.eligible.toLocaleString()} tone="green" />
        <Tile label="Left out" value={excludedTotal.toLocaleString()} tone={excludedTotal > 0 ? 'amber' : undefined} />
      </div>

      {preview.eligible === 0 && <div className="flex items-start gap-2 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2"><AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden /><span>None of the selected leads can be enrolled. The reasons are below.</span></div>}

      {excluded.length > 0 && (
        <section aria-label="Leads left out">
          <h4 className="text-xs font-semibold text-gray-700 mb-1">Left out, and why</h4>
          <ul className="rounded-lg border border-gray-200 divide-y divide-gray-100 text-sm">
            {excluded.map(([reason, v]) => (
              <li key={reason} className="flex items-center justify-between gap-3 px-3 py-1.5">
                <span className="text-gray-700">{excludedReasonText(reason)}</span>
                <span className="tabular-nums font-medium text-gray-900">{v.count.toLocaleString()}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-gray-500 mt-1">Nothing is deleted. Left-out leads stay in your lists with their history.</p>
        </section>
      )}

      {(repliedCount > 0 || includeReplied) && (
        <section aria-label="Leads who replied recently" className="rounded-lg border border-purple-200 bg-purple-50/40 p-3 space-y-2">
          <label className="flex items-start gap-2 text-sm text-gray-800 cursor-pointer">
            <input type="checkbox" checked={includeReplied} onChange={(e) => onIncludeReplied(e.target.checked)} className="mt-0.5 rounded border-gray-300 text-indigo-600" />
            <span>
              <span className="font-medium">Include them anyway</span>
              <span className="block text-xs text-gray-600">{includeReplied ? 'Leads who replied in the last 90 days are included. Make sure a new sequence is what they expect.' : `${repliedCount.toLocaleString()} lead${repliedCount === 1 ? '' : 's'} replied to someone on your team in the last 90 days. They are left out so nobody gets a cold message in the middle of a conversation.`}</span>
            </span>
          </label>
          {replied.length > 0 && (
            <>
              <button type="button" onClick={() => setShowReplied((v) => !v)} aria-expanded={showReplied} className="inline-flex items-center gap-1 text-xs text-purple-800 hover:underline">
                {showReplied ? <ChevronDown className="w-3 h-3" aria-hidden /> : <ChevronRight className="w-3 h-3" aria-hidden />} {showReplied ? 'Hide' : 'Show'} who replied{repliedCount > replied.length ? ` (first ${replied.length})` : ''}
              </button>
              {showReplied && (
                <ul className="bg-white rounded-md border border-purple-100 divide-y divide-gray-100 max-h-48 overflow-y-auto text-xs">
                  {replied.map((l) => (
                    <li key={l.id} className="flex items-center justify-between gap-2 px-2 py-1.5">
                      <Link href={`/outreach/leads/${l.id}`} target="_blank" className="truncate text-gray-800 hover:underline">{l.name || 'Unnamed lead'}{l.company ? <span className="text-gray-400"> · {l.company}</span> : null}</Link>
                      <span className="text-gray-500 whitespace-nowrap" title={fmtDate(l.last_replied_at)}>{l.channel === 'email' ? 'Email' : 'LinkedIn'} · {timeAgo(l.last_replied_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      )}

      {preview.assignment.length > 0 && (
        <section aria-label="Sender assignment">
          <h4 className="text-xs font-semibold text-gray-700 mb-1 flex items-center gap-1"><Users className="w-3.5 h-3.5" aria-hidden /> Who sends to whom</h4>
          <ul className="rounded-lg border border-gray-200 divide-y divide-gray-100 text-sm">
            {preview.assignment.slice().sort((a, b) => b.leads - a.leads).map((a) => (
              <li key={a.sender_id} className="flex items-center justify-between gap-3 px-3 py-1.5">
                <span className="flex items-center gap-2 min-w-0"><span className="truncate text-gray-800">{a.name || 'Sender'}</span><StatusPill status={a.status} /></span>
                <span className="tabular-nums font-medium text-gray-900">{a.leads.toLocaleString()}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-gray-500 mt-1">Assignment rule: <span className="font-medium text-gray-700">{rule?.label ?? preview.assignment_rule}</span>. {rule?.description}</p>
          {(effects.length > 0 || noFresh > 0) && (
            <ul className="mt-1 text-xs text-gray-700 list-disc pl-4 space-y-0.5">
              {effects.map(([note, c]) => <li key={note}>{ruleEffectText(note, c)}</li>)}
              {noFresh > 0 && <li>{noFresh.toLocaleString()} skipped: every sender has contacted them</li>}
            </ul>
          )}
        </section>
      )}

      {(preview.warnings ?? []).length > 0 && (
        <ul className="space-y-1" aria-label="Warnings">
          {preview.warnings.map((w, i) => <li key={i} className="flex items-start gap-2 text-xs text-amber-800 bg-amber-50 rounded-md px-2.5 py-1.5"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" aria-hidden />{w}</li>)}
        </ul>
      )}

      {!hideProjection && preview.projection && preview.eligible > 0 && (
        <p className="text-sm text-indigo-900 bg-indigo-50 rounded-lg px-3 py-2">
          <span className="font-semibold">{preview.eligible.toLocaleString()} lead{preview.eligible === 1 ? '' : 's'}</span> will take {days(preview.projection.estimated_days)} to work through at today&apos;s limits
          {preview.projection.bottleneck ? <>. The slowest part is <span className="font-semibold">{String(preview.projection.bottleneck).replace(/_/g, ' ')}</span></> : null}.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
export interface EnrollOptionsValue { waitEnrichment: boolean; generateAi: boolean }

interface OptionsProps {
  sequence: Pick<Sequence, 'id' | 'settings'>;
  value: EnrollOptionsValue;
  onChange: (v: EnrollOptionsValue) => void;
  ai: ReturnType<typeof useSequenceAiVariables>;
  disabled?: boolean;
}

export function EnrollOptions({ sequence, value, onChange, ai, disabled }: OptionsProps) {
  const holds = !!sequence.settings?.hold_for_ai_review;
  return (
    <fieldset disabled={disabled} className="space-y-3">
      <legend className="text-xs font-semibold text-gray-700 mb-1">Options</legend>
      <label className="flex items-start gap-2 text-sm text-gray-800 cursor-pointer">
        <input type="checkbox" checked={value.waitEnrichment} onChange={(e) => onChange({ ...value, waitEnrichment: e.target.checked })} className="mt-0.5 rounded border-gray-300 text-indigo-600" />
        <span>
          <span className="font-medium">Wait for profile enrichment before the first step</span>
          <span className="block text-xs text-gray-600">A lead starts once its LinkedIn profile has been read and stored, so profile variables and conditions have data from the first message. Leads read in the last 90 days start right away. If a profile cannot be read within 3 days, the lead starts anyway.</span>
        </span>
      </label>

      {ai.keys.length > 0 && (
        <div className="rounded-lg border border-fuchsia-200 bg-fuchsia-50/40 p-3 space-y-2">
          <label className="flex items-start gap-2 text-sm text-gray-800 cursor-pointer">
            <input type="checkbox" checked={value.generateAi && ai.used.length > 0} disabled={ai.used.length === 0} onChange={(e) => onChange({ ...value, generateAi: e.target.checked })} className="mt-0.5 rounded border-gray-300 text-indigo-600" />
            <span>
              <span className="font-medium flex items-center gap-1"><Sparkles className="w-3.5 h-3.5 text-fuchsia-600" aria-hidden /> Generate first lines for these leads</span>
              <span className="block text-xs text-gray-600">
                This sequence uses {ai.keys.map((k) => `{{ai.${k}}}`).join(', ')}. Lines are written ahead of time and go to the review table. Only approved lines are used. Anything not approved falls back.
              </span>
            </span>
          </label>
          <p className="text-xs text-gray-600 pl-6">
            {holds
              ? 'This sequence holds for AI review: leads wait at “waiting for review” until their lines are approved, skipped or come back blank. They do not start on their own, so review the lines soon.'
              : 'This sequence does not hold for AI review: leads start right away, and a message that goes out before its line is approved uses the fallback. Turn on “Hold for AI review” in the sequence settings to make leads wait.'}
          </p>
          {ai.isLoading && <p className="text-xs text-gray-400 pl-6">Loading AI variables…</p>}
          {ai.error != null && <p className="text-xs text-red-600 pl-6">{parseError(ai.error).message}</p>}
          {ai.missing.length > 0 && <p className="text-xs text-amber-700 pl-6">No saved AI variable for {ai.missing.map((k) => `{{ai.${k}}}`).join(', ')}. Those always use the fallback. Create them under <Link href="/outreach/settings/ai" className="underline">Settings → AI &amp; data</Link>.</p>}
        </div>
      )}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
const RESULT_ROWS: Array<{ key: keyof EnrollResult; label: string; help?: string }> = [
  { key: 'waiting', label: 'Of those, waiting before the first step', help: 'Waiting for profile enrichment or for AI lines to be reviewed.' },
  { key: 'skipped_active', label: 'Skipped: already live with every sender' },
  { key: 'skipped_suppressed', label: 'Skipped: blacklisted, unsubscribed or do not contact' },
  { key: 'skipped_replied', label: 'Skipped: replied in the last 90 days' },
  { key: 'skipped_other', label: 'Skipped: other', help: 'Not in this workspace, or no fresh sender left.' },
];

export function EnrollResultPanel({ result, aiBatches, aiError, partialError }: { result: EnrollResult; aiBatches?: AiBatchLink[]; aiError?: string | null; partialError?: string | null }) {
  return (
    <div className="space-y-3">
      <div className={cn('flex items-center gap-2 rounded-lg px-4 py-3 text-sm', partialError ? 'text-amber-900 bg-amber-50' : 'text-green-800 bg-green-50')} role="status">
        {partialError ? <AlertTriangle className="w-5 h-5 flex-shrink-0" aria-hidden /> : <CheckCircle2 className="w-5 h-5 flex-shrink-0" aria-hidden />}
        <span><span className="font-semibold">{result.enrolled.toLocaleString()}</span> lead{result.enrolled === 1 ? '' : 's'} enrolled.{partialError ? ` Then it stopped: ${partialError} Run the enrolment again for the rest. Leads already enrolled are skipped.` : ''}</span>
      </div>
      <dl className="rounded-lg border border-gray-200 divide-y divide-gray-100 text-sm">
        {RESULT_ROWS.map((r) => (
          <div key={r.key} className="flex items-center justify-between gap-3 px-3 py-1.5">
            <dt className="text-gray-600">{r.label}{r.help && result[r.key] > 0 ? <span className="block text-xs text-gray-400">{r.help}</span> : null}</dt>
            <dd className="tabular-nums font-medium text-gray-900">{result[r.key].toLocaleString()}</dd>
          </div>
        ))}
      </dl>
      {aiError && <ErrorBox message={`The leads are enrolled, but the AI lines could not be requested: ${aiError}`} />}
      {aiBatches && aiBatches.length > 0 && (
        <div className="rounded-lg border border-fuchsia-200 bg-fuchsia-50/40 p-3 space-y-1.5 text-sm">
          <div className="font-medium text-gray-900 flex items-center gap-1"><Sparkles className="w-4 h-4 text-fuchsia-600" aria-hidden /> First lines are being written</div>
          <ul className="space-y-1">
            {aiBatches.map((b) => (
              <li key={b.batch_id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-gray-700">{b.variable.name} <Badge tone="purple">{`{{ai.${b.variable.key}}}`}</Badge> <span className="text-xs text-gray-500">{b.to_generate.toLocaleString()} to write{b.kept_existing > 0 ? `, ${b.kept_existing.toLocaleString()} already had one` : ''}</span></span>
                {b.to_generate > 0 && <Link href={`/outreach/ai-review?batch=${b.batch_id}`} className="text-indigo-600 hover:underline text-sm font-medium">Review lines</Link>}
              </li>
            ))}
          </ul>
          <p className="text-xs text-gray-600">Approve, edit or skip each line in the review table. Only approved lines are used. Anything not approved falls back.</p>
        </div>
      )}
    </div>
  );
}
