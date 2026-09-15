'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Mail, ShieldAlert, UserPlus } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError, rpc } from '@/lib/outreach/api';
import { Badge, Button, Card, ErrorBox, Spinner } from '@/components/outreach/ui';

type Preview = { workspace_name: string; email: string; role: string; expired: boolean; accepted: boolean };
const ROLE_HINT: Record<string, string> = { owner: 'full control including billing and members', manager: 'senders, sequences, leads and exports', member: 'leads, tasks and the inbox', client_viewer: 'read-only inbox and stats for your client' };

export default function InvitePage() {
  const params = useParams<{ token: string }>();
  const token = params?.token;
  const router = useRouter();
  const { user, signOut } = useAuth();
  const { refresh, switchWorkspace } = useWorkspace();
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const preview = useQuery({ queryKey: ['outreach', 'invite', token ?? ''], enabled: !!token, retry: 0, queryFn: async () => { const rows = await rpc<Preview[]>('invitation_preview', { p_token: token }); return rows?.[0] ?? null; } });

  async function accept() {
    setAccepting(true); setError(null);
    try {
      const wsId = await rpc<string>('accept_invitation', { p_token: token });
      setDone(true);
      await refresh();
      if (wsId) switchWorkspace(wsId);
      router.push('/outreach');
    } catch (e) { setError(parseError(e).message); setAccepting(false); }
  }

  if (!token) return <ErrorBox message="Missing invitation token." />;
  if (preview.isLoading) return <Spinner />;
  const inv = preview.data;
  const mismatch = !!inv && !!user?.email && inv.email.toLowerCase() !== user.email.toLowerCase();

  return (
    <div className="max-w-lg mx-auto py-8">
      <Card>
        {preview.isError || !inv ? (
          <div className="text-center py-6">
            <ShieldAlert className="w-10 h-10 text-red-400 mx-auto mb-3" />
            <h1 className="text-lg font-semibold text-gray-900">Invitation not found</h1>
            <p className="text-sm text-gray-500 mt-1">{preview.isError ? parseError(preview.error).message : 'This link is invalid or has been deleted. Ask the workspace owner to send a new one.'}</p>
            <Button variant="secondary" className="mt-5" onClick={() => router.push('/outreach')}>Go to Outreach</Button>
          </div>
        ) : (
          <div className="text-center">
            <div className="w-12 h-12 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center mx-auto mb-3"><UserPlus className="w-6 h-6" /></div>
            <h1 className="text-lg font-semibold text-gray-900">Join {inv.workspace_name}</h1>
            <p className="text-sm text-gray-500 mt-1">You have been invited as <Badge tone="indigo">{inv.role.replace('_', ' ')}</Badge>{ROLE_HINT[inv.role] ? <span> — {ROLE_HINT[inv.role]}</span> : null}.</p>
            <div className="mt-4 inline-flex items-center gap-2 text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2"><Mail className="w-4 h-4 text-gray-400" /> {inv.email}</div>

            {inv.accepted ? (
              <div className="mt-5 flex items-center justify-center gap-2 text-sm text-green-700"><CheckCircle2 className="w-4 h-4" /> This invitation has already been accepted.</div>
            ) : inv.expired ? (
              <ErrorBox className="mt-5 text-left" message="This invitation has expired (links are valid for 7 days). Ask the workspace owner to resend it." />
            ) : mismatch ? (
              <div className="mt-5 text-left">
                <ErrorBox message={`This invitation was sent to ${inv.email}, but you are signed in as ${user?.email}. Sign out and sign in with the invited address to accept.`} />
                <div className="flex justify-center gap-2 mt-4"><Button variant="secondary" onClick={() => signOut()}>Sign out</Button></div>
              </div>
            ) : (
              <div className="mt-6">
                {error && <ErrorBox message={error} className="mb-3 text-left" />}
                <Button onClick={accept} loading={accepting} disabled={done} className="w-full">{done ? 'Joined — redirecting…' : 'Accept invitation'}</Button>
                <button type="button" onClick={() => router.push('/outreach')} className="mt-3 text-xs text-gray-500 hover:underline">Not now</button>
              </div>
            )}
            {(inv.accepted) && <Button variant="secondary" className="mt-4" onClick={() => router.push('/outreach')}>Open Outreach</Button>}
          </div>
        )}
      </Card>
    </div>
  );
}
