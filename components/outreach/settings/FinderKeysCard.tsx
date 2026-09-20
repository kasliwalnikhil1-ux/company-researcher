'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, MailSearch, Plus, Trash2 } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { callFn, parseError } from '@/lib/outreach/api';
import { Badge, Button, Card, ErrorBox, Input, Select, Spinner, useToast } from '@/components/outreach/ui';
import { Note } from './shared';
import { sk, useAiSettings } from './hooks';
import { maskHint } from './LlmKeyCard';
import type { FinderProvider, VerifierProvider } from './types';

const FINDERS: Array<{ value: FinderProvider; label: string }> = [{ value: 'hunter', label: 'Hunter' }, { value: 'prospeo', label: 'Prospeo' }, { value: 'findymail', label: 'Findymail' }];
const VERIFIERS: Array<{ value: VerifierProvider; label: string }> = [{ value: 'zerobounce', label: 'ZeroBounce' }, { value: 'reacher', label: 'Reacher' }];
const label = (list: Array<{ value: string; label: string }>, v: string) => list.find((x) => x.value === v)?.label ?? v;

/** `key` is only set for a provider that was added or re-keyed in this session. A stored key never comes back from the server. */
interface FinderDraft { provider: FinderProvider; hint: string | null; key: string }

const keyProblem = (k: string) => (k.trim().length < 8 ? 'That looks too short to be an API key' : /\s/.test(k.trim()) ? 'A key has no spaces' : undefined);

/**
 * Email finder keys (item 26). Request body sent to `outreach-workspace-secrets`:
 *   { workspace_id, finders: [{ provider, key? }, …] }   the array IS the order; an entry without `key` keeps the stored key; a provider left out is deleted
 *   { workspace_id, verifier: { provider, key } | null }
 */
export default function FinderKeysCard() {
  const { workspace, canWrite } = useWorkspace();
  const ws = workspace?.id;
  const qc = useQueryClient();
  const toast = useToast();
  const settings = useAiSettings(ws);

  const [list, setList] = useState<FinderDraft[]>([]);
  const [addProvider, setAddProvider] = useState<FinderProvider | ''>('');
  const [addKey, setAddKey] = useState('');
  const [vProvider, setVProvider] = useState<VerifierProvider>('zerobounce');
  const [vKey, setVKey] = useState('');
  const [vEditing, setVEditing] = useState(false);
  const [busy, setBusy] = useState<'finders' | 'verifier' | 'verifier-remove' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stored = settings.data?.finders ?? [];
  const storedKey = stored.map((f) => f.provider).join(',');
  const storedPrint = stored.map((f) => `${f.provider}:${f.hint ?? ''}`).join(',');
  // Reset the draft only when what is stored really changed, so an unrelated refetch does not wipe an unsaved key.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setList(stored.map((f) => ({ provider: f.provider, hint: f.hint, key: '' }))); }, [storedPrint]);
  useEffect(() => { if (settings.data?.verifier) setVProvider(settings.data.verifier.provider); }, [settings.data?.verifier]);

  const free = useMemo(() => FINDERS.filter((f) => !list.some((l) => l.provider === f.value)), [list]);
  useEffect(() => { if (!free.some((f) => f.value === addProvider)) setAddProvider(free[0]?.value ?? ''); }, [free, addProvider]);
  const dirty = list.map((l) => l.provider).join(',') !== storedKey || list.some((l) => l.key);

  function move(i: number, d: -1 | 1) { const j = i + d; if (j < 0 || j >= list.length) return; const next = [...list]; [next[i], next[j]] = [next[j], next[i]]; setList(next); }
  function add() {
    if (!addProvider || keyProblem(addKey)) return;
    setList([...list, { provider: addProvider, hint: null, key: addKey.trim() }]); setAddKey(''); setError(null);
  }

  async function saveFinders() {
    if (!ws) return;
    setBusy('finders'); setError(null);
    try {
      await callFn('workspace-secrets', { workspace_id: ws, finders: list.map((l) => (l.key ? { provider: l.provider, key: l.key } : { provider: l.provider })) });
      setList((cur) => cur.map((l) => ({ ...l, key: '' })));
      await qc.invalidateQueries({ queryKey: sk.aiSettings(ws) });
      toast.show(list.length ? 'Finder keys saved.' : 'Finder keys removed.');
    } catch (e) { setError(parseError(e).message); }
    finally { setBusy(null); }
  }

  async function saveVerifier(remove = false) {
    if (!ws || (!remove && keyProblem(vKey))) return;
    setBusy(remove ? 'verifier-remove' : 'verifier'); setError(null);
    try {
      await callFn('workspace-secrets', { workspace_id: ws, verifier: remove ? null : { provider: vProvider, key: vKey.trim() } });
      setVKey(''); setVEditing(false);
      await qc.invalidateQueries({ queryKey: sk.aiSettings(ws) });
      toast.show(remove ? 'Verifier removed.' : 'Verifier saved.');
    } catch (e) { setError(parseError(e).message); }
    finally { setBusy(null); }
  }

  const verifier = settings.data?.verifier ?? null;

  return (
    <Card title={<span className="flex items-center gap-2"><MailSearch className="w-4 h-4" /> Email finder keys</span>}>
      {settings.isLoading ? <Spinner /> : settings.isError ? <ErrorBox message={parseError(settings.error).message} /> : (
        <div className="space-y-5">
          <Note><strong>We do not resell data: the workspace brings its own keys.</strong> Tried in order, stops at the first hit. The &ldquo;Find email&rdquo; step skips leads with no company domain and leads whose email is already verified.</Note>

          <div>
            <div className="text-xs font-medium text-gray-600 mb-2">Providers, in the order they are tried</div>
            {list.length === 0 ? <div className="text-sm text-gray-500 border border-dashed border-gray-300 rounded-lg px-4 py-5 text-center">No finder yet. Add one below and the &ldquo;Find email&rdquo; step can run.</div> : (
              <ol className="divide-y divide-gray-100 border border-gray-200 rounded-lg">
                {list.map((f, i) => (
                  <li key={f.provider} className="flex items-center gap-3 px-3 py-2.5">
                    <span className="w-5 h-5 rounded-full bg-gray-100 text-gray-600 text-xs flex items-center justify-center flex-shrink-0">{i + 1}</span>
                    <div className="flex-1 min-w-0"><div className="text-sm font-medium text-gray-900">{label(FINDERS, f.provider)}</div><div className="text-xs text-gray-500">{f.key ? 'New key, not saved yet' : <>key <span className="font-mono">{maskHint(f.hint)}</span></>}</div></div>
                    {f.key && <Badge tone="amber">unsaved</Badge>}
                    {canWrite && (
                      <div className="flex items-center gap-0.5">
                        <Button size="sm" variant="ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Try ${label(FINDERS, f.provider)} earlier`}><ArrowUp className="w-4 h-4" /></Button>
                        <Button size="sm" variant="ghost" onClick={() => move(i, 1)} disabled={i === list.length - 1} aria-label={`Try ${label(FINDERS, f.provider)} later`}><ArrowDown className="w-4 h-4" /></Button>
                        <Button size="sm" variant="ghost" onClick={() => setList(list.filter((x) => x.provider !== f.provider))} aria-label={`Remove ${label(FINDERS, f.provider)}`}><Trash2 className="w-4 h-4 text-red-500" /></Button>
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </div>

          {canWrite && free.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-[160px_1fr_auto] gap-2 sm:items-end">
              <Select label="Add a provider" value={addProvider} onChange={(e) => setAddProvider(e.target.value as FinderProvider)}>{free.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</Select>
              <Input label="API key" type="password" autoComplete="new-password" spellCheck={false} value={addKey} onChange={(e) => setAddKey(e.target.value)} error={addKey ? keyProblem(addKey) : undefined} placeholder="Paste the key" />
              <Button type="button" variant="secondary" onClick={add} disabled={!addProvider || !addKey.trim() || !!keyProblem(addKey)}><Plus className="w-4 h-4" /> Add</Button>
            </div>
          )}
          {canWrite && dirty && (
            <div className="flex items-center justify-between gap-3 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
              <span className="text-xs text-amber-900">You have unsaved changes to the finder list.</span>
              <div className="flex gap-2"><Button size="sm" variant="secondary" onClick={() => setList(stored.map((f) => ({ provider: f.provider, hint: f.hint, key: '' })))} disabled={busy === 'finders'}>Undo</Button><Button size="sm" onClick={saveFinders} loading={busy === 'finders'}>Save finders</Button></div>
            </div>
          )}

          <div className="border-t border-gray-100 pt-4">
            <div className="text-xs font-medium text-gray-600 mb-1">Verifier (optional)</div>
            <p className="text-xs text-gray-500 mb-3">Checks a found address before it is saved. Without a verifier, found emails are marked unverified.</p>
            {verifier && !vEditing ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 px-3 py-2.5">
                <div><div className="text-sm font-medium text-gray-900">{label(VERIFIERS, verifier.provider)}</div><div className="text-xs text-gray-500">key <span className="font-mono">{maskHint(verifier.hint)}</span></div></div>
                {canWrite && <div className="flex gap-2"><Button size="sm" variant="secondary" onClick={() => setVEditing(true)}>Replace</Button><Button size="sm" variant="ghost" onClick={() => saveVerifier(true)} loading={busy === 'verifier-remove'}><Trash2 className="w-4 h-4 text-red-500" /> Remove</Button></div>}
              </div>
            ) : canWrite ? (
              <form onSubmit={(e) => { e.preventDefault(); saveVerifier(); }} className="grid grid-cols-1 sm:grid-cols-[160px_1fr_auto] gap-2 sm:items-end" autoComplete="off">
                <Select label="Verifier" value={vProvider} onChange={(e) => setVProvider(e.target.value as VerifierProvider)}>{VERIFIERS.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}</Select>
                <Input label="API key" type="password" autoComplete="new-password" spellCheck={false} value={vKey} onChange={(e) => setVKey(e.target.value)} error={vKey ? keyProblem(vKey) : undefined} placeholder="Paste the key" />
                <div className="flex gap-2">{vEditing && <Button type="button" variant="secondary" onClick={() => { setVEditing(false); setVKey(''); }}>Cancel</Button>}<Button type="submit" loading={busy === 'verifier'} disabled={!vKey.trim() || !!keyProblem(vKey)}>Save</Button></div>
              </form>
            ) : <div className="text-sm text-gray-500">No verifier set.</div>}
          </div>
          {error && <ErrorBox message={error} />}
        </div>
      )}
      {toast.node}
    </Card>
  );
}
