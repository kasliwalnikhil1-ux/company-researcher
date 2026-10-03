'use client';

import { useState, useSyncExternalStore } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ProtectedRoute from '@/components/ProtectedRoute';
import MainLayout from '@/components/MainLayout';
import { OutreachWorkspaceProvider, useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import OutreachShell from '@/components/outreach/Shell';
import { OutreachSidebarNav } from '@/components/outreach/OutreachNav';
import { EmptyState, ErrorBox, PageLoader } from '@/components/outreach/ui';
import { useOutreachAccess } from '@/lib/outreach/session';
import { IS_DEMO } from '@/lib/outreach/mode';
import WebchatPresence from '@/components/outreach/WebchatPresence';
import dynamic from 'next/dynamic';
import '@/components/outreach/demo/guard';

// The tour shell (and everything it loads) is downloaded only on /product-tour. The network guard above is tiny and
// installs itself before anything renders there.
const DemoProvider = dynamic(() => import('@/components/outreach/demo/DemoProvider'), { ssr: false, loading: () => <PageLoader className="min-h-[calc(100dvh_-_3.5rem_-_var(--demo-bar,0px))] md:min-h-[calc(100dvh_-_var(--demo-bar,0px))]" /> });

function Gate({ children }: { children: React.ReactNode }) {
  const { loading, error, workspace } = useWorkspace();
  const access = useOutreachAccess();
  if (!access.loading && !access.has('outreach', true)) {
    return (
      <div className="p-6">
        <EmptyState title="Outreach is not enabled for your account" description="An administrator has switched off the outreach product for this account. Contact support if you need it turned on." />
      </div>
    );
  }
  if (loading) return <PageLoader className="min-h-[calc(100dvh_-_3.5rem_-_var(--demo-bar,0px))] md:min-h-[calc(100dvh_-_var(--demo-bar,0px))]" />;
  if (error) return <div className="p-6"><ErrorBox message={error} /></div>;
  if (!workspace) return <div className="p-6"><ErrorBox message="No workspace available." /></div>;
  return <OutreachShell><WebchatPresence />{children}</OutreachShell>;
}

const noSubscribe = () => () => {};

/**
 * One layout, two modes (docs/outreach/PRODUCT-TOUR.md §3.3). `/outreach` is the product: sign-in required, real data.
 * `/product-tour` (the same files through the proxy rewrite) skips sign-in and runs on the in-browser demo backend,
 * under the demo bar. The mode comes from the URL (`IS_DEMO`); the first render is the same neutral loader in both, so
 * the server HTML and the browser agree.
 */
export default function OutreachLayout({ children }: { children: React.ReactNode }) {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: false } } }));
  const hydrated = useSyncExternalStore(noSubscribe, () => true, () => false);
  if (!hydrated) return <PageLoader className="min-h-[calc(100dvh_-_3.5rem_-_var(--demo-bar,0px))] md:min-h-[calc(100dvh_-_var(--demo-bar,0px))]" />;
  if (IS_DEMO) {
    return (
      <QueryClientProvider client={qc}>
        <DemoProvider>
          <OutreachWorkspaceProvider>
            <MainLayout subnav={<OutreachSidebarNav />} demo>
              <Gate>{children}</Gate>
            </MainLayout>
          </OutreachWorkspaceProvider>
        </DemoProvider>
      </QueryClientProvider>
    );
  }
  // Providers wrap MainLayout so its sidebar can render the Outreach sub-nav + workspace switcher.
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
