'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Mail, ShieldAlert, UserPlus } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError, rpc } from '@/lib/outreach/api';
import { DEFAULT_ACCENT, brandingForInvite, contrastOn, isHexColor, isHttpsUrl, productName, type Branding } from '@/lib/outreach/branding';
import { Badge, Button, Card, ErrorBox, PageLoader } from '@/components/outreach/ui';

type Preview = { workspace_name: string; email: string; role: string; expired: boolean; accepted: boolean };
const ROLE_LABEL: Record<string, string> = { owner: 'owner', manager: 'manager', member: 'member', client_viewer: 'client' };
const ROLE_HINT: Record<string, string> = {
  owner: 'Full control, including billing and members.', manager: 'Senders, sequences, leads and exports.', member: 'Leads, tasks and the inbox.',
  client_viewer: 'You can follow your campaign: the conversations, the numbers and the reports. Nothing is sent from your login.',
};

function BrandHeader({ branding }: { branding: Branding }) {
  const [logoFailed, setLogoFailed] = useState(false);
  const accent = isHexColor(branding.accent) ? branding.accent : DEFAULT_ACCENT;
  const name = productName(branding);
  return (
    <div className="flex items-center justify-center gap-2 mb-5">
      {isHttpsUrl(branding.logo_url) && !logoFailed
        ? <img src={branding.logo_url} alt={name} referrerPolicy="no-referrer" onError={() => setLogoFailed(true)} className="h-9 max-w-[180px] object-contain" />
        : <><span className="w-8 h-8 rounded-lg text-sm font-semibold flex items-center justify-center" style={{ background: accent, color: contrastOn(accent) }}>{name[0]?.toUpperCase()}</span><span className="text-base font-semibold text-gray-900">{name}</span></>}
    </div>
  );
}

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
  // Branding is a nicety: if it fails, the page still works with the neutral look.
  const brandingQuery = useQuery({ queryKey: ['outreach', 'invite', token ?? '', 'branding'], enabled: !!token, retry: 0, staleTime: 5 * 60_000, queryFn: () => brandingForInvite(token!) });
  const branding: Branding = brandingQuery.data ?? {};
  const branded = !!(branding.product_name || branding.logo_url || branding.accent || branding.hide_platform_name);
  const accent = isHexColor(branding.accent) ? branding.accent : null;
  const appName = branded ? productName(branding) : 'Outreach';

  useEffect(() => {
    if (!branded) return;
    const prev = document.title;
    document.title = `Invitation · ${productName(branding)}`;
    return () => { document.title = prev; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branded, branding.product_name, branding.workspace_name]);

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

  if (!token) return <ErrorBox message="This invitation link is incomplete. Open the link from your email again." />;
  if (preview.isLoading || brandingQuery.isLoading) return <PageLoader />;
  const inv = preview.data;
  const mismatch = !!inv && !!user?.email && inv.email.toLowerCase() !== user.email.toLowerCase();
  const primaryStyle = accent ? { background: accent, color: contrastOn(accent) } : undefined;

  return (
    <div className="max-w-lg mx-auto py-8">
      <Card>
        {branded && <BrandHeader branding={branding} />}
        {preview.isError || !inv ? (
          <div className="text-center py-6">
            <ShieldAlert className="w-10 h-10 text-red-400 mx-auto mb-3" />
            <h1 className="text-lg font-semibold text-gray-900">Invitation not found</h1>
            <p className="text-sm text-gray-500 mt-1">{preview.isError ? parseError(preview.error).message : 'This link is not valid any more. Ask the person who invited you to send a new one.'}</p>
            <Button variant="secondary" className="mt-5" onClick={() => router.push('/outreach')}>Go to {appName}</Button>
          </div>
        ) : (
          <div className="text-center">
            {!branded && <div className="w-12 h-12 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center mx-auto mb-3"><UserPlus className="w-6 h-6" /></div>}
            <h1 className="text-lg font-semibold text-gray-900">Join {inv.workspace_name}</h1>
            <p className="text-sm text-gray-500 mt-1">You are invited as <Badge tone="indigo">{ROLE_LABEL[inv.role] ?? inv.role.replace('_', ' ')}</Badge></p>
            {ROLE_HINT[inv.role] && <p className="text-sm text-gray-500 mt-2">{ROLE_HINT[inv.role]}</p>}
            <div className="mt-4 inline-flex items-center gap-2 text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2"><Mail className="w-4 h-4 text-gray-400" /> {inv.email}</div>

            {inv.accepted ? (
              <div className="mt-5 flex items-center justify-center gap-2 text-sm text-green-700"><CheckCircle2 className="w-4 h-4" /> This invitation has already been accepted.</div>
            ) : inv.expired ? (
              <ErrorBox className="mt-5 text-left" message="This invitation has expired. Links work for 7 days. Ask the person who invited you to send it again." />
            ) : mismatch ? (
              <div className="mt-5 text-left">
                <ErrorBox message={`This invitation was sent to ${inv.email}, but you are signed in as ${user?.email}. Sign out, then sign in with the invited address to accept.`} />
                <div className="flex justify-center gap-2 mt-4"><Button variant="secondary" onClick={() => signOut()}>Sign out</Button></div>
              </div>
            ) : (
              <div className="mt-6">
                {error && <ErrorBox message={error} className="mb-3 text-left" />}
                <Button onClick={accept} loading={accepting} disabled={done} className="w-full" style={primaryStyle}>{done ? 'Joined. Taking you in…' : 'Accept invitation'}</Button>
                <button type="button" onClick={() => router.push('/outreach')} className="mt-3 text-xs text-gray-500 hover:underline">Not now</button>
              </div>
            )}
            {inv.accepted && <Button variant="secondary" className="mt-4" onClick={() => router.push('/outreach')}>Open {appName}</Button>}
          </div>
        )}
        {branded && (branding.support_email || isHttpsUrl(branding.help_url)) && (
          <p className="text-xs text-gray-400 text-center mt-6 pt-4 border-t border-gray-100">
            Need help?{' '}
            {branding.support_email && <a href={`mailto:${branding.support_email}`} className="underline hover:text-gray-600">{branding.support_email}</a>}
            {branding.support_email && isHttpsUrl(branding.help_url) && ' · '}
            {isHttpsUrl(branding.help_url) && <a href={branding.help_url} target="_blank" rel="noopener noreferrer" className="underline hover:text-gray-600">Help centre</a>}
          </p>
        )}
      </Card>
    </div>
  );
}
