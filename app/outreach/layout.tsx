'use client';

import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ProtectedRoute from '@/components/ProtectedRoute';
import MainLayout from '@/components/MainLayout';
import { OutreachWorkspaceProvider, useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import OutreachShell from '@/components/outreach/Shell';
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
  return (
    <ProtectedRoute>
      <MainLayout>
        <QueryClientProvider client={qc}>
          <OutreachWorkspaceProvider>
            <Gate>{children}</Gate>
          </OutreachWorkspaceProvider>
        </QueryClientProvider>
      </MainLayout>
    </ProtectedRoute>
  );
}
