'use client';

// Lead page: private notes from every conversation of the lead (private-notes-PRD.md §7.2), marked 🔒, each linking to
// its conversation. Team-only notes never show to client viewers (the RPC applies the same rule as the inbox).
import Link from '@/lib/outreach/nav';
import { Lock, ExternalLink, Bot, Cog } from 'lucide-react';
import { Card, EmptyState, ErrorBox, Spinner, fmtDate } from '@/components/outreach/ui';
import { channelLabel } from '@/lib/outreach/channels';
import { ProviderLogo } from '@/components/outreach/senders/ProviderLogo';
import { noteLink, useLeadTeamNotes } from '@/lib/outreach/notes';
import { parseError } from '@/lib/outreach/api';
import NoteBody from '@/components/outreach/inbox/notes/NoteBody';
import { useSessionUser } from '@/lib/outreach/session';

export default function LeadTeamNotes({ leadId }: { leadId: string }) {
  const q = useLeadTeamNotes(leadId, 50);
  const { user } = useSessionUser();
  return (
    <Card title={<span className="inline-flex items-center gap-1.5"><Lock className="w-4 h-4 text-amber-600" /> Team notes</span>} className="[&>div:last-child]:p-0">
      {q.isLoading && <Spinner className="py-6" />}
      {q.error && <ErrorBox message={parseError(q.error).message} className="m-4" />}
      {q.data && q.data.length === 0 && <EmptyState title="No private notes yet" description="Notes your team leaves inside this lead's conversations appear here. The lead never sees them." />}
      {q.data && q.data.length > 0 && (
        <ul className="divide-y divide-gray-100">
          {q.data.map((n) => (
            <li key={n.id} className="px-5 py-3">
              <div className="flex items-center gap-2 text-[11px] text-gray-500">
                {n.author.type === 'ai' ? <Bot className="w-3 h-3" /> : n.author.type === 'system' ? <Cog className="w-3 h-3" /> : null}
                <span className="font-medium text-gray-700">{n.author.name}</span>
                <span>·</span>
                <time dateTime={n.created_at}>{fmtDate(n.created_at)}</time>
                {n.chat && (
                  <>
                    <span>·</span>
                    <span className="inline-flex items-center gap-1"><ProviderLogo provider={n.chat.provider} className="w-3 h-3 rounded-[2px]" /> {channelLabel(n.chat.provider)}{n.chat.sender_name ? ` via ${n.chat.sender_name}` : ''}</span>
                  </>
                )}
                {n.visibility === 'team_and_client' && <span className="px-1.5 py-0.5 rounded bg-amber-50 border border-amber-200 text-amber-900">Visible to client</span>}
                <span className="flex-1" />
                {n.chat && <Link href={noteLink(n.chat.id, n.id)} className="inline-flex items-center gap-1 text-indigo-600 hover:underline" title="Open in the conversation">Open <ExternalLink className="w-3 h-3" /></Link>}
              </div>
              {n.body && <NoteBody text={n.body} currentUserId={user?.id ?? null} className="mt-1" />}
              {n.attachments.length > 0 && <div className="mt-1 text-[11px] text-gray-500">📎 {n.attachments.map((a) => a.name).join(', ')}</div>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
