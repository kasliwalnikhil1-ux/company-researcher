'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useLead } from '@/lib/outreach/queries';
import { parseError } from '@/lib/outreach/api';
import { Button, EmptyState, ErrorBox, Spinner, useToast } from '@/components/outreach/ui';
import { ArrowLeft, UserX } from 'lucide-react';
import { EnrollModal } from '@/components/outreach/leads/EnrollModal';
import { LeadHeader } from '@/components/outreach/leads/detail/LeadHeader';
import { LeadEditForm } from '@/components/outreach/leads/detail/LeadEditForm';
import { LeadTagsEditor } from '@/components/outreach/leads/detail/LeadTagsEditor';
import { LeadCustomFields } from '@/components/outreach/leads/detail/LeadCustomFields';
import { LeadRelations } from '@/components/outreach/leads/detail/LeadRelations';
import { LeadEnrollments } from '@/components/outreach/leads/detail/LeadEnrollments';
import { LeadChats, LeadRecentActions, LeadTasks, LeadTimeline } from '@/components/outreach/leads/detail/LeadActivity';

export default function LeadDetailPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === 'string' ? params.id : '';
  const { workspace } = useWorkspace();
  const toast = useToast();
  const lead = useLead(id);
  const [enrollOpen, setEnrollOpen] = useState(false);

  const back = <Link href="/outreach/leads" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-indigo-700 mb-3"><ArrowLeft className="w-4 h-4" /> Leads</Link>;

  if (lead.isLoading) return <div>{back}<Spinner /></div>;
  if (lead.error) {
    const err = parseError(lead.error);
    return <div>{back}{/PGRST116|not found|0 rows/i.test(err.message) || err.code === 'E_NOT_FOUND'
      ? <div className="bg-white border border-gray-200 rounded-xl"><EmptyState icon={<UserX className="w-6 h-6" />} title="Lead not found" description="It may have been deleted or belongs to another workspace." action={<Link href="/outreach/leads"><Button variant="secondary">Back to leads</Button></Link>} /></div>
      : <ErrorBox message={err.message} />}</div>;
  }
  if (!lead.data) return <div>{back}<ErrorBox message="Lead not found." /></div>;
  const { lead: l, tagIds, states, enrollments, chats, actions, tasks } = lead.data;
  if (workspace && l.workspace_id !== workspace.id) {
    return <div>{back}<div className="bg-white border border-gray-200 rounded-xl"><EmptyState icon={<UserX className="w-6 h-6" />} title="Lead belongs to another workspace" description="Switch workspace from the top bar to view it." action={<Link href="/outreach/leads"><Button variant="secondary">Back to leads</Button></Link>} /></div></div>;
  }

  return (
    <div className="space-y-4">
      {back}
      <LeadHeader lead={l} onEnroll={() => setEnrollOpen(true)} toast={toast.show} />
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,3fr),minmax(0,2fr)] gap-4">
        <div className="space-y-4 min-w-0">
          <LeadRelations states={states} />
          <LeadEnrollments leadId={l.id} enrollments={enrollments} onEnroll={() => setEnrollOpen(true)} toast={toast.show} />
          <LeadChats chats={chats} />
          <LeadTimeline leadId={l.id} />
          <LeadRecentActions actions={actions} />
        </div>
        <div className="space-y-4 min-w-0">
          <LeadEditForm lead={l} toast={toast.show} />
          <LeadTagsEditor leadId={l.id} tagIds={tagIds} toast={toast.show} />
          <LeadCustomFields leadId={l.id} custom={l.custom ?? {}} toast={toast.show} />
          <LeadTasks tasks={tasks} />
        </div>
      </div>
      <EnrollModal open={enrollOpen} onClose={() => setEnrollOpen(false)} leadIds={[l.id]} toast={toast.show} />
      {toast.node}
    </div>
  );
}
