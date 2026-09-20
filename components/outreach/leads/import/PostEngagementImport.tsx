'use client';

import { useState } from 'react';
import { Info } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useSenders } from '@/lib/outreach/queries';
import { parseError } from '@/lib/outreach/api';
import { Button, ErrorBox, Input } from '@/components/outreach/ui';
import { SenderPicker, importableSenders } from './SenderPicker';
import { EMPTY_COMMON, ImportOptions, importStartedMessage, useImportCreator, type ImportCommon } from './ImportOptions';
import type { ToastFn } from '../helpers';

const PARTS = [
  { id: 'reactions', label: 'Reactions', hint: 'People who liked or reacted', available: true },
  { id: 'comments', label: 'Comments', hint: 'People who commented', available: true },
  // outreach-imports-create: LinkedIn does not share who reposted a post, so there is nothing to import.
  { id: 'reposts', label: 'Reposts', hint: 'Not available. LinkedIn does not share who reposted a post.', available: false },
] as const;
type Part = typeof PARTS[number]['id'];

const POST_URL = /^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/(posts\/|feed\/update\/)/i;

export function PostEngagementImport({ toast, onCreated }: { toast: ToastFn; onCreated: () => void }) {
  const { workspace } = useWorkspace();
  const senders = useSenders(workspace?.id);
  const ready = importableSenders(senders.data);
  const create = useImportCreator();
  const [url, setUrl] = useState('');
  const [include, setInclude] = useState<Part[]>(['reactions', 'comments']);
  const [senderId, setSenderId] = useState('');
  const [common, setCommon] = useState<ImportCommon>(EMPTY_COMMON);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const urlOk = POST_URL.test(url.trim());
  const toggle = (p: Part) => setInclude((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));

  const submit = async () => {
    if (!urlOk || !senderId || include.length === 0) return;
    setBusy(true); setError(null);
    try {
      const r = await create({ kind: 'post_engagement', sender_id: senderId, fields: { post_url: url.trim(), include }, name: `Post engagement (${include.join(', ')})` }, common);
      const m = importStartedMessage('Import started. People who engaged with the post arrive page by page.', r);
      toast(m.message, m.type);
      setUrl(''); setCommon((c) => ({ ...c, cadence: '' }));
      onCreated();
    } catch (e) { setError(parseError(e).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-600 flex items-start gap-1.5 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2"><Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
        <span><span className="font-medium text-gray-800">Cost and speed:</span> no profile views and no invites. One page of up to 100 people every 20 to 90 minutes, from the sender&apos;s daily search allowance, inside working hours. A few hundred reactions take a few hours. A viral post takes days and stops at 2,000 people.</span>
      </p>
      <Input label="LinkedIn post URL" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.linkedin.com/posts/…"
        error={url.trim() && !urlOk ? 'Paste the full link of a LinkedIn post (open the post, use “Copy link to post”).' : undefined}
        hint="Works for your own posts, a client’s posts and competitors’ posts. The sender must be able to see the post." />
      <fieldset>
        <legend className="block text-xs font-medium text-gray-600 mb-1">Who to import</legend>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {PARTS.map((p) => (
            <label key={p.id} className={`flex items-start gap-2 rounded-lg border px-3 py-2 ${!p.available ? 'border-gray-200 bg-gray-50 opacity-70 cursor-not-allowed' : include.includes(p.id) ? 'border-indigo-400 bg-indigo-50/60 cursor-pointer' : 'border-gray-200 bg-white hover:bg-gray-50 cursor-pointer'}`}>
              <input type="checkbox" disabled={!p.available} checked={p.available && include.includes(p.id)} onChange={() => toggle(p.id)} className="mt-0.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" />
              <span className="text-sm text-gray-900">{p.label}<span className="block text-xs text-gray-500">{p.hint}</span></span>
            </label>
          ))}
        </div>
        {include.length === 0 && <p className="text-xs text-red-600 mt-1">Pick at least one.</p>}
      </fieldset>
      <SenderPicker senders={ready} allSenders={senders.data ?? []} value={senderId} onChange={setSenderId} hint="The post is read from this account." />
      <ImportOptions kind="post_engagement" value={common} onChange={setCommon} />
      {error && <ErrorBox message={error} />}
      <Button onClick={submit} loading={busy} disabled={!urlOk || !senderId || include.length === 0}>Start import</Button>
    </div>
  );
}
