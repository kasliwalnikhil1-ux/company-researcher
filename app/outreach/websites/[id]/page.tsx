'use client';

// Website agents → {inbox}: every §12 section of web-chat-PRD.md, grouped into eight horizontal tabs (?tab=). A tab
// stacks its sections as cards; each keeps its own Save. Old one-section tab keys land on their group, at that card.

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from '@/lib/outreach/nav';
import { Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError } from '@/lib/outreach/api';
import { useClients } from '@/lib/outreach/queries';
import { useDeleteInbox, useWebchatInbox } from '@/lib/outreach/webchat';
import { Avatar, BackLink, Badge, Button, ErrorBox, Spinner, useToast } from '@/components/outreach/ui';
import { ConfirmModal } from '@/components/outreach/settings/shared';
import WebsitesFrame, { WEBSITES_PATH } from '@/components/outreach/settings/websites/WebsitesFrame';
import VideoBubbleSection from '@/components/outreach/settings/websites/VideoBubbleSection';
import AskButtonsSection from '@/components/outreach/settings/websites/AskButtonsSection';
import ProductsCard from '@/components/outreach/settings/websites/ProductsSection';
import VoiceSection from '@/components/outreach/settings/websites/VoiceSection';
import { AiSection, AppearanceSection, AvailabilitySection, CannedSection, DraftScope, FeaturesSection, GeneralSection, HistorySection, InstallSection, LauncherSection, MessagesSection, PreChatSection, ReportsSection, SecuritySection, TargetingSection, type SectionProps } from '@/components/outreach/settings/websites/sections';

/** Assistant: the assistant's own settings, then what it may recommend (products), then what it wrote. */
function AssistantSection(p: SectionProps) { return <AiSection {...p} between={<ProductsCard {...p} />} />; }

type Section = { key: string; C: (p: SectionProps) => React.ReactNode };
const TABS: Array<{ key: string; label: string; sections: Section[] }> = [
  { key: 'general', label: 'General', sections: [{ key: 'general', C: GeneralSection }] },
  { key: 'design', label: 'Design', sections: [{ key: 'appearance', C: AppearanceSection }, { key: 'launcher', C: LauncherSection }, { key: 'video', C: VideoBubbleSection }, { key: 'ask', C: AskButtonsSection }] },
  { key: 'conversation', label: 'Conversation', sections: [{ key: 'messages', C: MessagesSection }, { key: 'prechat', C: PreChatSection }, { key: 'features', C: FeaturesSection }, { key: 'canned', C: CannedSection }] },
  { key: 'ai', label: 'AI agent', sections: [{ key: 'ai', C: AssistantSection }] },
  { key: 'voice', label: 'Voice', sections: [{ key: 'voice', C: VoiceSection }] },
  { key: 'targeting', label: 'Targeting & hours', sections: [{ key: 'targeting', C: TargetingSection }, { key: 'availability', C: AvailabilitySection }] },
  { key: 'install', label: 'Install & security', sections: [{ key: 'install', C: InstallSection }, { key: 'security', C: SecuritySection }] },
  { key: 'reports', label: 'Reports', sections: [{ key: 'reports', C: ReportsSection }, { key: 'history', C: HistorySection }] },
];

/** Tab for a ?tab= value: a group key, or an old one-section key (then also the card to scroll to). */
function resolveTab(key: string) {
  const byGroup = TABS.find((t) => t.key === key);
  if (byGroup) return { tab: byGroup, section: null };
  const owner = TABS.find((t) => t.sections.some((s) => s.key === key));
  return owner ? { tab: owner, section: key } : { tab: TABS[0], section: null };
}

/** One card group. Remounts on a new config_version unless it holds unsaved edits that were not just saved. */
function SectionSlot({ C, p, id }: { C: Section['C']; p: SectionProps; id: string }) {
  const [version, setVersion] = useState(p.inbox.config_version);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const scope = useMemo(() => ({ dirty: setDirty, saved: () => setSaved(true) }), []);
  if (p.inbox.config_version !== version && (!dirty || saved)) { setSaved(false); setDirty(false); setVersion(p.inbox.config_version); }
  return <section id={id} className="scroll-mt-4"><DraftScope.Provider value={scope}><C key={version} {...p} /></DraftScope.Provider></section>;
}

export default function WebsitePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const search = useSearchParams();
  const { workspace, isManager, isOwner } = useWorkspace();
  const ws = workspace?.id ?? '';
  const q = useWebchatInbox(params?.id);
  const clients = useClients(ws);
  const del = useDeleteInbox(ws);
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const { tab, section } = useMemo(() => resolveTab(search?.get('tab') ?? 'general'), [search]);
  const inbox = q.data;

  // an old link (?tab=voice, ?tab=launcher, ...) or a #card hash: scroll to that card once it has rendered
  const target = section ?? (typeof window !== 'undefined' ? window.location.hash.slice(1) : '');
  useEffect(() => {
    if (!inbox || !target) return;
    const t = setTimeout(() => document.getElementById(target)?.scrollIntoView({ block: 'start' }), 50);
    return () => clearTimeout(t);
  }, [inbox, target, tab.key]);

  const selectTab = (key: string) => router.replace(`${WEBSITES_PATH}/${inbox!.id}${key !== 'general' ? `?tab=${key}` : ''}`);
  const client = inbox?.client_id ? clients.data?.find((c) => c.id === inbox.client_id) : null;
  const props: SectionProps | null = inbox ? { inbox, ws, canEdit: isManager, toast: toast.show } : null;

  return (
    <WebsitesFrame bare>
      <BackLink href={WEBSITES_PATH}>Back to websites</BackLink>
      {q.isLoading && <Spinner />}
      {q.error && <ErrorBox message={parseError(q.error).message} />}
      {inbox && props && (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
            <div className="flex items-center gap-3 min-w-0">
              <Avatar src={inbox.settings.appearance.logo_url} name={inbox.settings.appearance.brand_name || inbox.name} size={10} />
              <div className="min-w-0">
                <h1 className="text-xl font-bold text-gray-900 truncate">{inbox.name}</h1>
                <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500 mt-0.5">
                  <span>Website agents</span>
                  {inbox.allowed_domains.length > 0 && <span>· {inbox.allowed_domains.slice(0, 2).join(', ')}{inbox.allowed_domains.length > 2 && ` +${inbox.allowed_domains.length - 2}`}</span>}
                  {client && <span>· {client.name}</span>}
                  <span>· v{inbox.config_version}</span>
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {inbox.is_active
                ? <Badge tone={inbox.availability.online ? 'green' : 'gray'}>{inbox.availability.online ? 'Online' : 'Offline'}</Badge>
                : <Badge tone="gray">Widget off</Badge>}
              <Badge tone={inbox.ai_enabled ? 'indigo' : 'gray'}>{inbox.ai_enabled ? 'AI agent on' : 'AI agent off'}</Badge>
              {isOwner && <Button size="sm" variant="ghost" className="text-red-600" onClick={() => setConfirm(true)}><Trash2 className="w-3.5 h-3.5 mr-1" />Delete website</Button>}
            </div>
          </div>

          <div className="border-b border-gray-200 mb-6">
            <nav className="flex flex-wrap gap-1 -mb-px" role="tablist" aria-label="Website settings">
              {TABS.map((t) => (
                <button key={t.key} type="button" role="tab" aria-selected={tab.key === t.key} onClick={() => selectTab(t.key)} className={cn('px-3 py-2 text-sm font-medium border-b-2 whitespace-nowrap', tab.key === t.key ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-gray-500 hover:text-gray-800')}>{t.label}</button>
              ))}
            </nav>
          </div>

          <div className="space-y-6">
            {tab.sections.map((s) => <SectionSlot key={`${tab.key}:${s.key}`} id={s.key} C={s.C} p={props} />)}
          </div>
        </>
      )}
      <ConfirmModal open={confirm} onClose={() => setConfirm(false)} loading={del.isPending} title="Delete this website?" confirmLabel="Delete" onConfirm={async () => { try { await del.mutateAsync(inbox!.id); router.replace(WEBSITES_PATH); } catch (e) { toast.show(parseError(e).message, 'error'); } }}>
        <p>The widget stops answering on every page immediately. Conversations and visitors stay in the inbox for reference.</p>
      </ConfirmModal>
      {toast.node}
    </WebsitesFrame>
  );
}
