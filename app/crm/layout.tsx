'use client';

import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ProtectedRoute from '@/components/ProtectedRoute';
import MainLayout from '@/components/MainLayout';
import { CrmProvider, useCrm } from '@/contexts/CrmContext';
import CrmShell, { CrmSidebarNav } from '@/components/crm/Shell';
import { EmptyState, ErrorBox, PageLoader } from '@/components/crm/ui';

function Gate({ children }: { children: React.ReactNode }) {
  const { loading, error, isMember } = useCrm();
  if (loading) return <PageLoader className="min-h-[calc(100dvh-3.5rem)] md:min-h-screen" />;
  if (error) return <div className="p-6"><ErrorBox message={error} /></div>;
  if (!isMember) {
    return (
      <div className="p-6">
        <EmptyState title="You are not on the sales CRM team" description="The CRM is for the internal sales team. Ask a current member to add your email in CRM → Settings → Team (or via the Claude connector: add_team_member)." />
      </div>
    );
  }
  return <CrmShell>{children}</CrmShell>;
}

export default function CrmLayout({ children }: { children: React.ReactNode }) {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: true } } }));
  return (
    <ProtectedRoute>
      <QueryClientProvider client={qc}>
        {/* CrmProvider wraps MainLayout so the sidebar nav can show who is signed in. */}
        <CrmProvider>
          <MainLayout subnav={<CrmSidebarNav />}>
            <Gate>{children}</Gate>
          </MainLayout>
        </CrmProvider>
      </QueryClientProvider>
    </ProtectedRoute>
  );
}
