'use client';

import Link from 'next/link';
import { FileCheck2, Globe, MessageSquareReply, PenLine, Settings2, UserRound, type LucideIcon } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError } from '@/lib/outreach/api';
import {
  FEATURE_HELP, FEATURE_LABEL, HUB_MODE_LABEL, hubHref, replyToHubMode, useHubSetup, websiteHubMode, websiteModeText,
  type AiFeature, type HubMode, type HubSetup,
} from '@/lib/outreach/aiHub';
import { ErrorBox, Spinner } from '@/components/outreach/ui';
import { LinkButton, plural } from './parts';

const ORDER: HubMode[] = ['auto', 'review', 'off'];
const onMode = (m: HubMode) => (m === 'off' ? 'Off' : `on ${HUB_MODE_LABEL[m]}`);
const count = (modes: HubMode[]) => ORDER.map((m) => ({ m, n: modes.filter((x) => x === m).length })).filter((x) => x.n > 0);

/** "4 sequences on Auto · 2 on Review · 3 Off": the noun goes with the first count. */
function modeCounts(noun: string, modes: HubMode[]): string {
  return count(modes).map((x, i) => (i === 0 ? `${x.n} ${plural(x.n, noun)} ${onMode(x.m)}` : `${x.n} ${onMode(x.m)}`)).join(' · ');
}

function repliesSummary(d: HubSetup): string {
  const modes = (d.sequences ?? []).map((s) => replyToHubMode(s.mode));
  return modes.length ? modeCounts('sequence', modes) : 'No sequences yet';
}

/** "3 variables · 2 on Review · 1 Off"; one variable is named: "opener on Review". */
function linesSummary(d: HubSetup): string {
  const vars = d.variables ?? [];
  if (vars.length === 0) return 'No variables yet';
  if (vars.length === 1) return `${vars[0].key} ${onMode(vars[0].mode === 'off' ? 'off' : 'review')}`;
  const modes = vars.map((v): HubMode => (v.mode === 'off' ? 'off' : 'review'));
  return [`${vars.length} variables`, ...count(modes).map((x) => `${x.n} ${onMode(x.m)}`)].join(' · ');
}

const waitingSum = (rows: Array<{ waiting: number }> | undefined) => (rows ?? []).reduce((a, r) => a + (r.waiting ?? 0), 0);

function Waiting({ n, href, text }: { n: number; href: string; text: (n: number) => string }) {
  if (n <= 0) return null;
  return <Link href={href} className="font-medium text-indigo-700 hover:underline whitespace-nowrap">{text(n)}</Link>;
}
const needYou = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'needs' : 'need'} you`;

function Row({ icon: Icon, name, help, summary, extra, written, feature, action }: {
  icon: LucideIcon; name: string; help: string; summary: React.ReactNode; extra?: React.ReactNode; written?: number; feature?: AiFeature; action: React.ReactNode;
}) {
  return (
    <li className="grid grid-cols-1 gap-x-6 gap-y-2 px-5 py-4 md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)_10rem_8.5rem] md:items-center">
      <div className="flex items-start gap-3 min-w-0">
        <span className="w-8 h-8 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center flex-shrink-0"><Icon className="w-4 h-4" aria-hidden="true" /></span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-gray-900">{name}</h3>
          <p className="text-xs text-gray-500 mt-0.5">{help}</p>
        </div>
      </div>
      <div className="min-w-0 text-sm text-gray-700">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">{summary}</div>
        {extra && <p className="text-xs text-gray-500 mt-0.5">{extra}</p>}
      </div>
      <div className="text-sm text-gray-500 md:text-right">
        {written != null && feature && (
          <Link href={hubHref.activity({ feature })} title="What the AI wrote in the last 7 days. Opens Activity." className="hover:text-indigo-700 hover:underline">
            {written.toLocaleString()} written this week
          </Link>
        )}
      </div>
      <div className="md:text-right">{action}</div>
    </li>
  );
}

/** AI → Setup: one row per feature (its modes, what it wrote in the last 7 days, where it is managed) plus General. */
export default function FeatureCards() {
  const { workspace, isManager } = useWorkspace();
  const q = useHubSetup(workspace?.id);
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox message={parseError(q.error).message} />;
  const d = q.data;
  if (!d) return null;

  const written = (f: AiFeature) => d.written_7d?.[f] ?? 0;
  const websites = d.websites ?? [];
  const draftsOpen = d.drafts?.open ?? 0;
  const profileOpen = d.profile?.open ?? 0;
  const sep = <span className="text-gray-300" aria-hidden="true">·</span>;

  return (
    <div className="space-y-3">
      <ul className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
        <Row icon={MessageSquareReply} name={FEATURE_LABEL.reply} help={FEATURE_HELP.reply} feature="reply" written={written('reply')}
          summary={<><span>{repliesSummary(d)}</span>{waitingSum(d.sequences) > 0 && sep}<Waiting n={waitingSum(d.sequences)} href={hubHref.needsYou({ type: 'reply', mine: false })} text={needYou} /></>}
          action={<LinkButton href={hubHref.setupReplies()} ariaLabel={`Manage ${FEATURE_LABEL.reply}`}>Manage</LinkButton>} />

        <Row icon={PenLine} name={FEATURE_LABEL.line} help={FEATURE_HELP.line} feature="line" written={written('line')}
          summary={<><span>{linesSummary(d)}</span>{waitingSum(d.variables) > 0 && sep}<Waiting n={waitingSum(d.variables)} href={hubHref.needsYou({ type: 'line', mine: false })} text={needYou} /></>}
          action={<LinkButton href={hubHref.setupLines()} ariaLabel={`Manage ${FEATURE_LABEL.line}`}>Manage</LinkButton>} />

        <Row icon={FileCheck2} name={FEATURE_LABEL.draft} help={FEATURE_HELP.draft} feature="draft" written={written('draft')}
          summary={<><span>Review only</span>{sep}{draftsOpen > 0
            ? <Waiting n={draftsOpen} href={hubHref.needsYou({ type: 'draft', mine: false })} text={(n) => `${n.toLocaleString()} waiting for you`} />
            : <span className="text-gray-500">Nothing waiting</span>}</>}
          extra="It is the “AI draft + approval” step of a sequence. You switch it on per step in the sequence builder."
          action={<LinkButton href="/outreach/sequences">Open sequences</LinkButton>} />

        <Row icon={Globe} name={FEATURE_LABEL.website} help={FEATURE_HELP.website} feature="website" written={written('website')}
          summary={websites.length === 0
            ? <><span>No website yet</span>{sep}<Link href="/outreach/websites" className="font-medium text-indigo-700 hover:underline">Add a website</Link></>
            : <>
                <span className="min-w-0 break-words">{websites.length === 1 ? `${websites[0].name} · ${websiteModeText(websites[0])}` : modeCounts('website', websites.map((w) => websiteHubMode(w).mode))}</span>
                {waitingSum(websites) > 0 && sep}<Waiting n={waitingSum(websites)} href={hubHref.needsYou({ type: 'website', mine: false })} text={needYou} />
              </>}
          action={<LinkButton href={hubHref.setupWebsite()} ariaLabel={`Manage the ${FEATURE_LABEL.website}`}>Manage</LinkButton>} />

        <Row icon={UserRound} name={FEATURE_LABEL.profile} help={FEATURE_HELP.profile} feature="profile" written={written('profile')}
          summary={<><span>Review only</span>{sep}{profileOpen > 0
            ? <Waiting n={profileOpen} href={hubHref.needsYou({ type: 'profile', mine: false })} text={(n) => `${n.toLocaleString()} not applied yet`} />
            : <span className="text-gray-500">Nothing waiting</span>}</>}
          action={<LinkButton href="/outreach/senders/profiles" ariaLabel={`Manage ${FEATURE_LABEL.profile} in Profile Studio`}>Manage</LinkButton>} />

        <Row icon={Settings2} name="General" help="What every AI feature of this workspace shares."
          summary={<span>AI provider and key · usage · defaults</span>}
          action={isManager ? <LinkButton href={hubHref.setupGeneral()} ariaLabel="Open General">Open</LinkButton> : <span className="text-xs text-gray-500">Owners and managers</span>} />
      </ul>
      <p className="text-xs text-gray-500">“Written this week” counts what the AI wrote in the last 7 days. Click a number to read it in Activity.</p>
    </div>
  );
}
