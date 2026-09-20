'use client';

// Portal landing page. A custom domain that is not tied to one client is rewritten here (proxy.ts), and a client viewer
// who opens /outreach/c lands here too. One visible client → go straight to its report; several → let them pick.
import React, { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Building2 } from 'lucide-react';
import { supabase } from '@/utils/supabase/client';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError } from '@/lib/outreach/api';
import { Card, EmptyState, ErrorBox, PageHeader, Spinner } from '@/components/outreach/ui';
import type { Client } from '@/lib/outreach/types';

export default function ClientPortalIndex() {
  const router = useRouter();
  const { workspace } = useWorkspace();
  const ws = workspace?.id;

  // RLS already limits this to the clients the member may see
  const clients = useQuery({
    queryKey: ['outreach', ws ?? '', 'portal-clients'] as const,
    enabled: !!ws,
    queryFn: async () => {
      const { data, error } = await supabase.from('outreach_clients').select('id, name, slug, timezone').eq('workspace_id', ws!).order('name');
      if (error) throw parseError(error);
      return (data ?? []) as Pick<Client, 'id' | 'name' | 'slug' | 'timezone'>[];
    },
  });

  const only = clients.data?.length === 1 ? clients.data[0] : null;
  useEffect(() => { if (only) router.replace(`/outreach/c/${only.id}`); }, [only, router]);

  if (!ws || clients.isLoading || only) return <div className="flex justify-center py-24"><Spinner /></div>;
  if (clients.isError) return <div className="p-6"><ErrorBox message={parseError(clients.error).message} /></div>;

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <PageHeader title="Reports" subtitle="Choose a client to open its report." />
      {clients.data?.length ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {clients.data.map((c) => (
            <Link key={c.id} href={`/outreach/c/${c.id}`} className="block rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
              <Card className="hover:border-gray-300 transition-colors">
                <div className="flex items-center gap-3">
                  <Building2 className="h-5 w-5 text-gray-400" aria-hidden />
                  <div>
                    <div className="font-medium text-gray-900">{c.name}</div>
                    {c.timezone && <div className="text-xs text-gray-500">{c.timezone}</div>}
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <EmptyState icon={<Building2 className="h-6 w-6" />} title="No reports yet" description="There is no client report you can open with this account. Ask the person who invited you to check your access." />
      )}
    </div>
  );
}
