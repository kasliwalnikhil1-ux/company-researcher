'use client';

// AI → Setup → Website agents: every website with its mode, When (Auto) and how long a suggestion waits (Review).
import { useState } from 'react';
import Link from '@/lib/outreach/nav';
import { useQueryClient } from '@tanstack/react-query';
import { Globe } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError } from '@/lib/outreach/api';
import {
  MODE_LINE, WEBSITE_WHEN_LABEL, hk, hubHref, useHubSetup, useWebsiteSetMode, websiteHubMode,
  type HubMode, type HubSetup, type HubSetupWebsite, type WebsiteWhen,
} from '@/lib/outreach/aiHub';
import ModeSwitch from '@/components/outreach/ai/hub/ModeSwitch';
import { Badge, EmptyState, ErrorBox, Spinner, Table, Td, Th } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import { LinkButton, ModeLegend, NeedsYouLink, plural } from './parts';

type Notify = (m: string, t?: 'success' | 'error') => void;

const WHENS: WebsiteWhen[] = ['always', 'outside_hours'];
const WHEN_HINT = 'Outside business hours also covers times when nobody on the team is online.';
const WAIT_HINT = 'On Review, if nobody answers within this time, the visitor gets the offline message. The suggestion itself is never sent.';
const TIMEOUT_DEFAULT = 10;
const field = 'text-sm rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-gray-50 disabled:text-gray-500';

/** What outreach_hub_website_set_mode stores for a choice: Off keeps the stored mode, so switching back on keeps the When. */
function stored(w: HubSetupWebsite, mode: HubMode, when?: WebsiteWhen): Pick<HubSetupWebsite, 'ai_enabled' | 'mode'> {
  if (mode === 'off') return { ai_enabled: false, mode: w.mode };
  if (mode === 'review') return { ai_enabled: true, mode: 'review' };
  const at = when ?? (w.mode === 'offline_only' ? 'outside_hours' : 'always');
  return { ai_enabled: true, mode: at === 'outside_hours' ? 'offline_only' : 'first' };
}

function WebsiteRow({ ws, w, canEdit, notify }: { ws: string; w: HubSetupWebsite; canEdit: boolean; notify: Notify }) {
  const set = useWebsiteSetMode(ws);
  const qc = useQueryClient();
  const cur = websiteHubMode(w);
  const timeout = w.review_timeout_min ?? TIMEOUT_DEFAULT;
  const [mins, setMins] = useState(String(timeout));
  const [seen, setSeen] = useState(timeout);
  if (timeout !== seen) { setSeen(timeout); setMins(String(timeout)); }

  const save = (a: { mode: HubMode; when?: WebsiteWhen; reviewTimeoutMin?: number }, done: string) => set.mutate({ inboxId: w.id, ...a }, {
    onSuccess: () => {
      // show the choice at once; the refetch started by the hook confirms it
      qc.setQueryData<HubSetup>(hk.setup(ws), (old) => (old ? {
        ...old, websites: (old.websites ?? []).map((x) => (x.id !== w.id ? x : { ...x, ...stored(x, a.mode, a.when), review_timeout_min: a.reviewTimeoutMin ?? x.review_timeout_min })),
      } : old));
      notify(done);
    },
    onError: (e) => { setMins(String(timeout)); notify(parseError(e).message, 'error'); },
  });

  const setMode = (m: HubMode) => save({ mode: m },
    m === 'off' ? `The Website agent is off on ${w.name}.`
      : m === 'review' ? `${w.name} is on Review. The AI suggests an answer and a person sends it.`
      : `${w.name} is on Auto · ${WEBSITE_WHEN_LABEL[stored(w, 'auto').mode === 'offline_only' ? 'outside_hours' : 'always'].toLowerCase()}.`);

  const commitMins = () => {
    const n = Number(mins);
    if (mins.trim() === '' || !Number.isInteger(n) || n < 1 || n > 240) { setMins(String(timeout)); notify('Use a whole number from 1 to 240 minutes.', 'error'); return; }
    if (n === timeout) { setMins(String(n)); return; }
    save({ mode: 'review', reviewTimeoutMin: n }, `${w.name}: a suggestion now waits ${n} ${plural(n, 'minute')}.`);
  };

  const locked = !canEdit || set.isPending;
  return (
    <tr>
      <Td className="max-w-[260px]">
        <div className="flex items-center gap-2 min-w-0">
          <Link href={`/outreach/websites/${w.id}?tab=ai`} title="Open this website's assistant settings" className="truncate font-medium text-gray-900 hover:text-indigo-700 hover:underline">{w.name}</Link>
          {w.is_active === false && <Badge tone="gray" className="flex-shrink-0">Chat is off</Badge>}
        </div>
      </Td>
      <Td>
        <ModeSwitch compact value={cur.mode} onChange={setMode} lines={MODE_LINE.website} disabled={!canEdit} busy={set.isPending} label={`Website agent mode for ${w.name}`} />
      </Td>
      <Td>
        {cur.mode === 'auto' ? (
          <select aria-label={`When the Website agent answers on ${w.name}`} title={WHEN_HINT} value={cur.when} disabled={locked} className={field}
            onChange={(e) => { const at = e.target.value as WebsiteWhen; save({ mode: 'auto', when: at }, `${w.name} is on Auto · ${WEBSITE_WHEN_LABEL[at].toLowerCase()}.`); }}>
            {WHENS.map((k) => <option key={k} value={k}>{WEBSITE_WHEN_LABEL[k]}</option>)}
          </select>
        ) : <span className="text-xs text-gray-400">Only on Auto</span>}
      </Td>
      <Td>
        {cur.mode === 'review' ? (
          <label className="inline-flex items-center gap-1.5" title={WAIT_HINT}>
            <span className="sr-only">Minutes a suggestion waits on {w.name}</span>
            <input type="number" inputMode="numeric" min={1} max={240} step={1} value={mins} disabled={locked} className={cn(field, 'w-20 tabular-nums')}
              onChange={(e) => setMins(e.target.value)} onBlur={commitMins} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
            <span className="text-xs text-gray-500">min</span>
          </label>
        ) : <span className="text-xs text-gray-400">Only on Review</span>}
      </Td>
      <Td><NeedsYouLink n={w.waiting} href={hubHref.needsYou({ type: 'website', where: w.id, mine: false })} /></Td>
    </tr>
  );
}

export default function WebsiteModes({ ws, notify }: { ws: string; notify: Notify }) {
  const { isManager, canWrite } = useWorkspace();
  const q = useHubSetup(ws);
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox message={parseError(q.error).message} />;

  const rows = q.data?.websites ?? [];
  if (rows.length === 0) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl">
        <EmptyState icon={<Globe className="w-6 h-6" />} title="No website yet"
          description="Add a website to put the chat on it. Then choose here whether the AI answers visitors, suggests answers to your team, or stays off."
          action={<LinkButton href="/outreach/websites">Open websites</LinkButton>} />
      </div>
    );
  }

  const canEdit = isManager && canWrite;
  return (
    <div className="space-y-3">
      <Table>
        <thead><tr><Th>Website</Th><Th>Mode</Th><Th title={WHEN_HINT}>When</Th><Th title={WAIT_HINT}>Suggestion waits</Th><Th>Needs you</Th></tr></thead>
        <tbody>{rows.map((w) => <WebsiteRow key={w.id} ws={ws} w={w} canEdit={canEdit} notify={notify} />)}</tbody>
      </Table>
      <ModeLegend lines={MODE_LINE.website} />
      <dl className="text-xs text-gray-500 space-y-0.5">
        <div><dt className="inline font-medium text-gray-700">When: </dt><dd className="inline">{WHEN_HINT}</dd></div>
        <div><dt className="inline font-medium text-gray-700">Suggestion waits: </dt><dd className="inline">{WAIT_HINT}</dd></div>
      </dl>
      {!canEdit && <p className="text-xs text-gray-500">{isManager ? 'This workspace is read-only, so the modes cannot be changed right now.' : 'You can read these settings. Owners and managers can change them.'}</p>}
    </div>
  );
}
