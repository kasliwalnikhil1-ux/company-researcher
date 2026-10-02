'use client';

import { useState } from 'react';
import { KeyRound, Mic, Trash2 } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError } from '@/lib/outreach/api';
import { usePlanFeature } from '@/lib/outreach/billing';
import { useSaveVoiceKey } from '@/lib/outreach/voice';
import { Badge, Button, Card, ErrorBox, Input, Spinner, useToast } from '@/components/outreach/ui';
import { ConfirmModal, Note } from './shared';
import { useAiSettings } from './hooks';
import { maskHint } from './LlmKeyCard';

/**
 * The workspace's own ElevenLabs account for the website assistant's voice (web-chat-voice-elevenlabs-PRD.md §12).
 * The key goes straight to `outreach-workspace-secrets`, which checks it can work with voices and agents, encrypts it
 * and stores it; only the last four characters come back. With it: no minute cap from us (the calls are billed to
 * that account), the account's own cloned voices in the voice picker, and the websites' voice agents move there at
 * the next sync. Removing it brings voice back to our account.
 */
export default function VoiceKeyCard() {
  const { workspace, canWrite } = useWorkspace();
  const ws = workspace?.id;
  const toast = useToast();
  const settings = useAiSettings(ws);
  const plan = usePlanFeature(ws, 'voice_own_key');
  const saveKey = useSaveVoiceKey(ws);
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const hint = settings.data?.elevenlabs_key_hint ?? null;
  const allowed = settings.data?.voice_own_key_allowed ?? plan.enabled;
  const keyError = key && key.trim().length < 16 ? 'That looks too short to be an API key' : key && /\s/.test(key.trim()) ? 'A key has no spaces' : undefined;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!key.trim() || keyError) return;
    setError(null);
    try {
      await saveKey.mutateAsync(key.trim());
      setKey(''); setEditing(false);   // the key leaves memory as soon as it is stored
      toast.show('Saved. Your websites move their voice to this account within a few minutes.');
    } catch (er) { setError(parseError(er).message); }
  }
  async function remove() {
    try { await saveKey.mutateAsync(null); setConfirmRemove(false); toast.show('Removed. Voice is back on our account, with your plan’s minutes.'); }
    catch (er) { toast.show(parseError(er).message, 'error'); }
  }

  return (
    <Card title={<span className="flex items-center gap-2"><Mic className="w-4 h-4" /> Voice account</span>}>
      {settings.isLoading ? <Spinner /> : (
        <div className="space-y-4">
          <p className="text-xs text-gray-500">The website assistant&rsquo;s voice calls run on our ElevenLabs account, with the minutes your plan includes. With your own ElevenLabs key there is no cap from us: the calls are billed to your account, and your own cloned voices can be picked on a website&rsquo;s Voice tab.</p>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 px-4 py-3">
            {hint ? (
              <div><div className="flex items-center gap-2 text-sm font-medium text-gray-900"><KeyRound className="w-4 h-4 text-gray-400" /> Your own ElevenLabs account <Badge tone="green">in use</Badge></div><div className="text-xs text-gray-500 mt-0.5">key <span className="font-mono">{maskHint(hint)}</span></div></div>
            ) : (
              <div><div className="text-sm font-medium text-gray-900">Our account</div><div className="text-xs text-gray-500 mt-0.5">Nothing to set up. Minutes come with your plan.</div></div>
            )}
            {canWrite && !editing && allowed && (
              <div className="flex items-center gap-2">
                <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>{hint ? 'Replace key' : 'Use your own key'}</Button>
                {hint && <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(true)} aria-label="Remove your voice key"><Trash2 className="w-4 h-4 text-red-500" /> Remove</Button>}
              </div>
            )}
            {!allowed && <span className="text-xs text-gray-500">Available on {plan.minPlanLabel || 'a higher plan'}. <a href={plan.upgradeHref} className="text-indigo-700 hover:underline">Upgrade</a></span>}
          </div>
          {editing && (
            <form onSubmit={save} className="space-y-3" noValidate autoComplete="off">
              <Input label="ElevenLabs API key" type="password" value={key} onChange={(e) => { setKey(e.target.value); setError(null); }} placeholder="sk_…" autoComplete="new-password" spellCheck={false} error={keyError}
                hint="ElevenLabs → Developers → API keys. It needs access to Voices and to ElevenLabs Agents (write). We test it, encrypt it and never show it again." />
              {error && <ErrorBox message={error} />}
              <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => { setEditing(false); setKey(''); setError(null); }} disabled={saveKey.isPending}>Cancel</Button><Button type="submit" loading={saveKey.isPending} disabled={!key.trim() || !!keyError}>Test and save</Button></div>
            </form>
          )}
          {hint && <Note>Switching accounts moves the websites&rsquo; voice agents at the next sync. Earlier calls keep their transcripts; their recordings stay in the account they were made on and expire there.</Note>}
        </div>
      )}
      <ConfirmModal open={confirmRemove} onClose={() => setConfirmRemove(false)} onConfirm={remove} loading={saveKey.isPending} title="Remove your voice key?" confirmLabel="Remove key">
        <p>The key is deleted and voice goes back to our account, with the minutes your plan includes. What we set up in your ElevenLabs account is removed while the key still works.</p>
      </ConfirmModal>
      {toast.node}
    </Card>
  );
}
