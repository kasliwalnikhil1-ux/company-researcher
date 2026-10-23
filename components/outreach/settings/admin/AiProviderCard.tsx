'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Sparkles, XCircle } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { callFn, parseError } from '@/lib/outreach/api';
import { Badge, Button, Card, ErrorBox, Input, Spinner, useToast } from '@/components/outreach/ui';
import { LLM_PROVIDERS } from '@/components/outreach/settings/LlmKeyCard';
import type { LlmProvider } from '@/components/outreach/settings/types';

/** The AI part of the `unipile-setup` status (outreach-unipile-setup). */
export interface AiSetupStatus {
  ai: boolean;
  ai_provider: LlmProvider | null;
  ai_model: string | null;
  ai_source: 'flag' | 'env' | 'auto' | 'none';
  ai_wanted: LlmProvider | null;
  ai_fallback_reason: string | null;
  ai_providers: Record<LlmProvider, boolean>;
  ai_models: Record<LlmProvider, string>;
  ai_default_models: Record<LlmProvider, string>;
  /** the model that writes replies to prospects (tier "reply"), per provider, and the env defaults */
  ai_reply_model: string | null;
  ai_reply_models: Record<LlmProvider, string>;
  ai_default_reply_models: Record<LlmProvider, string>;
}
type SetupResp = { status: AiSetupStatus };

const SECRET: Record<LlmProvider, string> = { gemini: 'GEMINI_API_KEY', anthropic: 'ANTHROPIC_API_KEY (+ ANTHROPIC_WORKSPACE_ID for a key that is not scoped to a workspace)', openai: 'OPENAI_API_KEY' };
const MODEL_ID = /^[A-Za-z0-9._:\/-]{2,80}$/;
export const label = (p: LlmProvider | null | undefined) => LLM_PROVIDERS.find((x) => x.value === p)?.label ?? p ?? '';

/** The editable part: its initial values come from the server state, and the parent remounts it (key) when that state changes. */
function ProviderForm({ ws, s, queryKey }: { ws: string; s: AiSetupStatus; queryKey: unknown[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [provider, setProvider] = useState<LlmProvider | ''>(() => s.ai_source === 'flag' ? (s.ai_wanted ?? s.ai_provider ?? '') : '');
  // show only the overrides: a model equal to the env default is "not set"
  const [models, setModels] = useState<Record<LlmProvider, string>>(() => ({
    gemini: s.ai_models.gemini === s.ai_default_models.gemini ? '' : s.ai_models.gemini,
    anthropic: s.ai_models.anthropic === s.ai_default_models.anthropic ? '' : s.ai_models.anthropic,
    openai: s.ai_models.openai === s.ai_default_models.openai ? '' : s.ai_models.openai,
  }));
  const [replyModels, setReplyModels] = useState<Record<LlmProvider, string>>(() => ({
    gemini: s.ai_reply_models.gemini === s.ai_default_reply_models.gemini ? '' : s.ai_reply_models.gemini,
    anthropic: s.ai_reply_models.anthropic === s.ai_default_reply_models.anthropic ? '' : s.ai_reply_models.anthropic,
    openai: s.ai_reply_models.openai === s.ai_default_reply_models.openai ? '' : s.ai_reply_models.openai,
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const modelError = (p: LlmProvider) => models[p] && !MODEL_ID.test(models[p].trim()) ? 'Use the model id exactly as the provider writes it' : undefined;
  const replyError = (p: LlmProvider) => replyModels[p] && !MODEL_ID.test(replyModels[p].trim()) ? 'Use the model id exactly as the provider writes it' : undefined;
  const invalid = LLM_PROVIDERS.some((p) => modelError(p.value) || replyError(p.value));

  async function save() {
    if (invalid) return;
    setSaving(true); setError(null);
    try {
      const r = await callFn<{ ok: true; status: AiSetupStatus }>('unipile-setup', { workspace_id: ws, action: 'set_ai', ai: { provider: provider || null, models: { gemini: models.gemini.trim(), anthropic: models.anthropic.trim(), openai: models.openai.trim() }, reply_models: { gemini: replyModels.gemini.trim(), anthropic: replyModels.anthropic.trim(), openai: replyModels.openai.trim() } } });
      qc.setQueryData(queryKey, (old: SetupResp | undefined) => old ? { ...old, status: { ...old.status, ...r.status } } : old);
      await qc.invalidateQueries({ queryKey });
      toast.show(r.status.ai_provider ? `Saved. Workspaces without their own key now use ${label(r.status.ai_provider)} · ${r.status.ai_model}; replies to prospects use ${r.status.ai_reply_model}.` : 'Saved. No platform key is configured, so AI features stay off until one is set.');
    } catch (e) { setError(parseError(e).message); }
    finally { setSaving(false); }
  }

  const sourceText = s.ai_source === 'flag' ? 'set here' : s.ai_source === 'env' ? 'from OUTREACH_AI_PROVIDER' : s.ai_source === 'auto' ? 'the first provider with a key' : 'no platform key';

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        Every workspace without its own key uses the platform key of one provider for reply classification, AI replies, Personalized lines, step drafts and website agents.
        {' '}In use now: {s.ai_provider ? <><span className="font-medium text-gray-900">{label(s.ai_provider)}</span> · <span className="font-mono text-xs">{s.ai_model}</span> <span className="text-gray-400">({sourceText})</span>, and <span className="font-mono text-xs">{s.ai_reply_model}</span> for replies written to prospects</> : <span className="font-medium text-red-600">none</span>}.
      </p>
      {s.ai_fallback_reason && <ErrorBox message={s.ai_fallback_reason} />}
      <div className="divide-y divide-gray-100 rounded-lg border border-gray-200">
        {LLM_PROVIDERS.map((p) => {
          const has = s.ai_providers[p.value];
          return (
            <label key={p.value} className="flex flex-wrap items-center gap-3 px-4 py-3 cursor-pointer">
              <input type="radio" name="ai-platform-provider" className="accent-indigo-600" checked={provider === p.value} disabled={!has} onChange={() => setProvider(p.value)} aria-label={`Use ${p.label} by default`} />
              <div className="min-w-[180px]">
                <div className="text-sm font-medium text-gray-900">{p.label}</div>
                <div className="text-xs text-gray-400" title={SECRET[p.value]}>{has ? 'Platform key set' : `No platform key (${SECRET[p.value].split(' ')[0]})`}</div>
              </div>
              {has ? <Badge tone="green"><CheckCircle2 className="w-3 h-3 mr-1" /> key</Badge> : <Badge tone="gray"><XCircle className="w-3 h-3 mr-1" /> no key</Badge>}
              {s.ai_provider === p.value && <Badge tone="blue">in use</Badge>}
              <div className="ml-auto grid w-full grid-cols-1 gap-2 sm:w-[30rem] sm:grid-cols-2" onClick={(e) => e.preventDefault()}>
                <Input label="Everyday model" value={models[p.value]} onChange={(e) => setModels({ ...models, [p.value]: e.target.value })} placeholder={s.ai_default_models[p.value]} error={modelError(p.value)} spellCheck={false} aria-label={`${p.label} model`} />
                <Input label="Replies to prospects" value={replyModels[p.value]} onChange={(e) => setReplyModels({ ...replyModels, [p.value]: e.target.value })} placeholder={s.ai_default_reply_models[p.value]} error={replyError(p.value)} spellCheck={false} aria-label={`${p.label} reply model`} />
              </div>
            </label>
          );
        })}
        <label className="flex items-center gap-3 px-4 py-3 cursor-pointer">
          <input type="radio" name="ai-platform-provider" className="accent-indigo-600" checked={provider === ''} onChange={() => setProvider('')} aria-label="No preference" />
          <div><div className="text-sm font-medium text-gray-900">No preference</div><div className="text-xs text-gray-400">OUTREACH_AI_PROVIDER if set, else the first provider with a key: Gemini, then Anthropic, then OpenAI.</div></div>
        </label>
      </div>
      <p className="text-xs text-gray-500">Model fields are optional: empty means the default shown in grey. The everyday model classifies replies, writes Personalized lines, step drafts, sequence QA and website-agent answers; the reply model writes the replies sent to prospects (inbox reply drafts and AI auto replies). Changes reach every function within a minute. Audio transcription always uses Gemini. Workspaces with their own key are not affected.</p>
      {error && <ErrorBox message={error} />}
      <div className="flex justify-end"><Button onClick={save} loading={saving} disabled={invalid}>Save</Button></div>
      {toast.node}
    </div>
  );
}

/**
 * Settings → Admin → AI provider (localhost only). Which platform key answers for every workspace that has no key of its
 * own, and the model per provider. Saved to the flags `ai_platform_provider` / `ai_platform_models` through
 * `unipile-setup` (action `set_ai`); every function instance picks the change up within a minute.
 */
export default function AiProviderCard() {
  const { workspace, isOwner } = useWorkspace();
  const ws = workspace?.id;
  const queryKey = ['outreach', ws ?? '', 'platform-setup'];
  const setup = useQuery({ queryKey, enabled: !!ws && isOwner, staleTime: 60_000, retry: 0, queryFn: () => callFn<SetupResp>('unipile-setup', { workspace_id: ws, action: 'status' }) });
  const s = setup.data?.status;

  return (
    <Card className="mb-6" title={<span className="flex items-center gap-2"><Sparkles className="w-4 h-4" /> AI provider</span>}>
      {!isOwner || !ws ? <div className="text-sm text-gray-500">Switch to a workspace you own to change the platform AI provider.</div>
        : setup.isLoading ? <Spinner /> : setup.isError ? <ErrorBox message={parseError(setup.error).message} /> : s ? (
        <ProviderForm key={JSON.stringify([s.ai_provider, s.ai_source, s.ai_wanted, s.ai_models, s.ai_reply_models])} ws={ws} s={s} queryKey={queryKey} />
      ) : null}
    </Card>
  );
}
