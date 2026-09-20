'use client';

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, Sparkles, Trash2 } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { callFn, parseError } from '@/lib/outreach/api';
import { Badge, Button, Card, ErrorBox, Input, Select, Spinner, useToast } from '@/components/outreach/ui';
import { ConfirmModal, Note } from './shared';
import { sk, useAiSettings } from './hooks';
import type { LlmProvider } from './types';

export const LLM_PROVIDERS: Array<{ value: LlmProvider; label: string; modelPlaceholder: string; keyPlaceholder: string; keyHelp: string }> = [
  { value: 'gemini', label: 'Google Gemini', modelPlaceholder: 'gemini-3-flash-preview', keyPlaceholder: 'AIza…', keyHelp: 'Create one in Google AI Studio.' },
  { value: 'anthropic', label: 'Anthropic Claude', modelPlaceholder: 'claude-sonnet-5', keyPlaceholder: 'sk-ant-…', keyHelp: 'Create one in the Anthropic console.' },
  { value: 'openai', label: 'OpenAI', modelPlaceholder: 'gpt-5-mini', keyPlaceholder: 'sk-…', keyHelp: 'Create one on the OpenAI platform page.' },
];
const providerLabel = (p: string | null | undefined) => LLM_PROVIDERS.find((x) => x.value === p)?.label ?? p ?? '';
export const maskHint = (hint: string | null | undefined) => `••••${hint ?? ''}`;

/**
 * Bring your own LLM key (item 14). The key goes straight to the `outreach-workspace-secrets` edge function, which checks it
 * against the provider, encrypts it and stores it. It is never read back: only the last four characters come back as a hint.
 */
export default function LlmKeyCard() {
  const { workspace, canWrite } = useWorkspace();
  const ws = workspace?.id;
  const qc = useQueryClient();
  const toast = useToast();
  const settings = useAiSettings(ws);
  const [editing, setEditing] = useState(false);
  const [provider, setProvider] = useState<LlmProvider>('gemini');
  const [model, setModel] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  const [error, setError] = useState<{ field: 'key' | 'form'; message: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const own = !!settings.data?.uses_own_key;
  useEffect(() => {
    if (!settings.data) return;
    if (settings.data.llm_provider !== 'platform') setProvider(settings.data.llm_provider);
    setModel(settings.data.llm_model ?? '');
  }, [settings.data]);

  const meta = LLM_PROVIDERS.find((p) => p.value === provider)!;
  const keyError = key && key.trim().length < 16 ? 'That looks too short to be an API key' : key && /\s/.test(key.trim()) ? 'A key has no spaces' : undefined;
  const modelError = model && !/^[A-Za-z0-9._:\/-]{2,80}$/.test(model.trim()) ? 'Use the model id exactly as the provider writes it' : undefined;

  function close() { setEditing(false); setKey(''); setError(null); }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!ws || !key.trim() || keyError || modelError) return;
    setBusy('save'); setError(null);
    try {
      await callFn('workspace-secrets', { workspace_id: ws, llm: { provider, model: model.trim() || null, key: key.trim() } });
      setKey('');           // the key leaves memory as soon as it is stored
      setEditing(false);
      await qc.invalidateQueries({ queryKey: sk.aiSettings(ws) });
      toast.show(`Saved. AI features in this workspace now use your ${meta.label} key.`);
    } catch (er) {
      const pe = parseError(er);
      setError(pe.code === 'E_AI_KEY_INVALID'
        ? { field: 'key', message: pe.message && pe.message !== 'E_AI_KEY_INVALID' ? pe.message : `${meta.label} rejected this key. Check that it is complete, active and allowed to use the model.` }
        : { field: 'form', message: pe.message });
    } finally { setBusy(null); }
  }

  async function remove() {
    if (!ws) return;
    setBusy('remove');
    try {
      await callFn('workspace-secrets', { workspace_id: ws, llm: null });
      await qc.invalidateQueries({ queryKey: sk.aiSettings(ws) });
      setConfirmRemove(false); close();
      toast.show('Key removed. The workspace is back on the platform default.');
    } catch (er) { toast.show(parseError(er).message, 'error'); }
    finally { setBusy(null); }
  }

  return (
    <Card title={<span className="flex items-center gap-2"><Sparkles className="w-4 h-4" /> AI provider</span>}>
      {settings.isLoading ? <Spinner /> : settings.isError ? <ErrorBox message={parseError(settings.error).message} /> : (
        <div className="space-y-4">
          <p className="text-xs text-gray-500">The AI provider writes reply drafts, classifies replies, fills AI variables and decides AI routing steps. With your own key the usage is billed to your account and your data goes to the provider you choose.</p>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 px-4 py-3">
            {own ? (
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium text-gray-900"><KeyRound className="w-4 h-4 text-gray-400" /> Your own key <Badge tone="green">in use</Badge></div>
                <div className="text-xs text-gray-500 mt-0.5">{providerLabel(settings.data?.llm_provider)} · {settings.data?.llm_model || 'default model'} · key <span className="font-mono">{maskHint(settings.data?.llm_key_hint)}</span></div>
              </div>
            ) : (
              <div><div className="text-sm font-medium text-gray-900">Platform default (Gemini)</div><div className="text-xs text-gray-500 mt-0.5">Included in your plan. Nothing to set up.</div></div>
            )}
            {canWrite && !editing && (
              <div className="flex items-center gap-2">
                <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>{own ? 'Replace key' : 'Use your own key'}</Button>
                {own && <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(true)} aria-label="Remove your key"><Trash2 className="w-4 h-4 text-red-500" /> Remove</Button>}
              </div>
            )}
          </div>

          {editing && (
            <form onSubmit={save} className="space-y-3" noValidate autoComplete="off">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Select label="Provider" value={provider} onChange={(e) => { setProvider(e.target.value as LlmProvider); setModel(''); setError(null); }}>{LLM_PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</Select>
                <Input label="Model (optional)" value={model} onChange={(e) => setModel(e.target.value)} placeholder={meta.modelPlaceholder} error={modelError} hint="Leave empty for our recommended model." spellCheck={false} />
              </div>
              <Input label="API key" type="password" value={key} onChange={(e) => { setKey(e.target.value); setError(null); }} placeholder={meta.keyPlaceholder} autoComplete="new-password" spellCheck={false}
                error={error?.field === 'key' ? error.message : keyError} hint={`${meta.keyHelp} We test the key, encrypt it and never show it again.`} />
              {error?.field === 'form' && <ErrorBox message={error.message} />}
              <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={close} disabled={busy === 'save'}>Cancel</Button><Button type="submit" loading={busy === 'save'} disabled={!key.trim() || !!keyError || !!modelError}>Test and save</Button></div>
            </form>
          )}
          {!canWrite && <Note>This workspace is read-only, so the AI provider cannot be changed right now.</Note>}
        </div>
      )}
      <ConfirmModal open={confirmRemove} onClose={() => setConfirmRemove(false)} onConfirm={remove} loading={busy === 'remove'} title="Remove your AI key?" confirmLabel="Remove key">
        <p>The stored key is deleted and the workspace goes back to the platform default (Gemini). Nothing else changes: approved AI lines and drafts stay as they are.</p>
      </ConfirmModal>
      {toast.node}
    </Card>
  );
}
