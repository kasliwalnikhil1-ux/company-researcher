'use client';

import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ProtectedRoute from '@/components/ProtectedRoute';
import MainLayout from '@/components/MainLayout';
import { OutreachWorkspaceProvider, useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import OutreachShell from '@/components/outreach/Shell';
import { OutreachSidebarNav } from '@/components/outreach/OutreachNav';
import { Spinner, ErrorBox } from '@/components/outreach/ui';

function Gate({ children }: { children: React.ReactNode }) {
  const { loading, error, workspace } = useWorkspace();
  if (loading) return <Spinner className="py-24" />;
  if (error) return <div className="p-6"><ErrorBox message={error} /></div>;
  if (!workspace) return <div className="p-6"><ErrorBox message="No workspace available." /></div>;
  return <OutreachShell>{children}</OutreachShell>;
}

export default function OutreachLayout({ children }: { children: React.ReactNode }) {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: false } } }));
  // Providers wrap MainLayout so its mobile sidebar can render the Outreach sub-nav + workspace switcher.
  return (
    <ProtectedRoute>
      <QueryClientProvider client={qc}>
        <OutreachWorkspaceProvider>
          <MainLayout subnav={<OutreachSidebarNav />}>
            <Gate>{children}</Gate>
          </MainLayout>
        </OutreachWorkspaceProvider>
      </QueryClientProvider>
    </ProtectedRoute>
  );
}
