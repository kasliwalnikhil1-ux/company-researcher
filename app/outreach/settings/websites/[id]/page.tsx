'use client';

// Settings → Websites → {inbox}: every §12 section of web-chat-PRD.md as a left-hand section list (?tab=).

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError } from '@/lib/outreach/api';
import { useDeleteInbox, useWebchatInbox } from '@/lib/outreach/webchat';
import { Badge, Button, ErrorBox, Spinner, useToast } from '@/components/outreach/ui';
import { ConfirmModal, SettingsFrame } from '@/components/outreach/settings/shared';
import { AiSection, AppearanceSection, AvailabilitySection, CannedSection, FeaturesSection, GeneralSection, HistorySection, InstallSection, LauncherSection, MessagesSection, PreChatSection, ReportsSection, SecuritySection, TargetingSection, type SectionProps } from '@/components/outreach/settings/websites/sections';

const TABS: Array<{ key: string; label: string; C: (p: SectionProps) => React.ReactNode }> = [
  { key: 'general', label: 'General', C: GeneralSection },
  { key: 'appearance', label: 'Appearance', C: AppearanceSection },
  { key: 'launcher', label: 'Launcher & popup', C: LauncherSection },
  { key: 'messages', label: 'Messages', C: MessagesSection },
  { key: 'prechat', label: 'Pre-chat form', C: PreChatSection },
  { key: 'availability', label: 'Availability', C: AvailabilitySection },
  { key: 'features', label: 'Features, CSAT & email', C: FeaturesSection },
  { key: 'ai', label: 'AI assistant', C: AiSection },
  { key: 'targeting', label: 'Targeting & campaigns', C: TargetingSection },
  { key: 'security', label: 'Security', C: SecuritySection },
  { key: 'canned', label: 'Canned responses', C: CannedSection },
  { key: 'install', label: 'Installation', C: InstallSection },
  { key: 'reports', label: 'Reports', C: ReportsSection },
  { key: 'history', label: 'History', C: HistorySection },
];

export default function WebsitePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const search = useSearchParams();
  const { workspace, isManager, isOwner } = useWorkspace();
  const ws = workspace?.id ?? '';
  const q = useWebchatInbox(params?.id);
  const del = useDeleteInbox(ws);
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const tabKey = search?.get('tab') ?? 'general';
  const tab = useMemo(() => TABS.find((t) => t.key === tabKey) ?? TABS[0], [tabKey]);
  const inbox = q.data;

  return (
    <SettingsFrame min="member">
      <div className="mb-4 flex items-center gap-3">
        <Link href="/outreach/settings/websites" className="text-sm text-gray-500 hover:text-gray-900 inline-flex items-center gap-1"><ArrowLeft className="w-4 h-4" />Websites</Link>
        {inbox && <><span className="text-gray-300">/</span><span className="text-sm font-semibold text-gray-900">{inbox.name}</span>{!inbox.is_active && <Badge tone="gray">Off</Badge>}<span className={cn('text-xs', inbox.availability.online ? 'text-emerald-700' : 'text-gray-500')}>● {inbox.availability.online ? 'online' : 'offline'}</span><span className="text-xs text-gray-400">v{inbox.config_version}</span></>}
        {inbox && isOwner && <Button size="sm" variant="ghost" className="ml-auto text-red-600" onClick={() => setConfirm(true)}><Trash2 className="w-3.5 h-3.5 mr-1" />Delete website</Button>}
      </div>
      {q.isLoading && <Spinner />}
      {q.error && <ErrorBox message={parseError(q.error).message} />}
      {inbox && (
        <div className="grid gap-5 md:grid-cols-[200px_1fr]">
          <nav className="md:sticky md:top-4 self-start" aria-label="Website settings sections">
            <ul className="flex md:flex-col gap-1 overflow-x-auto">
              {TABS.map((t) => <li key={t.key}><button type="button" onClick={() => router.replace(`/outreach/settings/websites/${inbox.id}?tab=${t.key}`)} className={cn('w-full text-left whitespace-nowrap text-sm px-3 py-1.5 rounded-md', t.key === tab.key ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-gray-600 hover:bg-gray-50')} aria-current={t.key === tab.key ? 'page' : undefined}>{t.label}</button></li>)}
            </ul>
          </nav>
          <div className="min-w-0"><tab.C key={`${tab.key}:${inbox.config_version}`} inbox={inbox} ws={ws} canEdit={isManager} toast={toast.show} /></div>
        </div>
      )}
      <ConfirmModal open={confirm} onClose={() => setConfirm(false)} loading={del.isPending} title="Delete this website?" confirmLabel="Delete" onConfirm={async () => { try { await del.mutateAsync(inbox!.id); router.replace('/outreach/settings/websites'); } catch (e) { toast.show(parseError(e).message, 'error'); } }}>
        <p>The widget stops answering on every page immediately. Conversations and visitors stay in the inbox for reference.</p>
      </ConfirmModal>
      {toast.node}
    </SettingsFrame>
  );
}
