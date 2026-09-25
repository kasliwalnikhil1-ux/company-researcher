'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Users, Linkedin, Briefcase, Settings, History } from 'lucide-react';
import ProtectedRoute from '@/components/ProtectedRoute';
import MainLayout from '@/components/MainLayout';
import { useAccess } from '@/contexts/AccessContext';
import { cn } from '@/lib/utils';
import { EmptyState, PageLoader } from '@/components/outreach/ui';
import { AdminToastProvider } from '@/components/admin/shared';
import UsersTab from '@/components/admin/UsersTab';
import UserDrawer from '@/components/admin/UserDrawer';
import OutreachTab from '@/components/admin/OutreachTab';
import CrmTab from '@/components/admin/CrmTab';
import SettingsTab from '@/components/admin/SettingsTab';
import AuditTab from '@/components/admin/AuditTab';

type Tab = 'users' | 'outreach' | 'crm' | 'settings' | 'audit';
const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: 'users', label: 'Accounts', icon: Users },
  { id: 'outreach', label: 'Outreach workspaces', icon: Linkedin },
  { id: 'crm', label: 'CRM team', icon: Briefcase },
  { id: 'settings', label: 'Settings', icon: Settings },
  { id: 'audit', label: 'Audit log', icon: History },
];

function AdminConsole() {
  const access = useAccess();
  const router = useRouter();
  const params = useSearchParams();
  const [tab, setTab] = useState<Tab>(() => (TABS.some((t) => t.id === params.get('tab')) ? (params.get('tab') as Tab) : 'users'));
  const [userId, setUserId] = useState<string | null>(params.get('user'));

  // keep the URL shareable (tab + open account)
  useEffect(() => {
    const q = new URLSearchParams();
    if (tab !== 'users') q.set('tab', tab);
    if (userId) q.set('user', userId);
    const s = q.toString();
    router.replace(s ? `/admin?${s}` : '/admin');
  }, [tab, userId, router]);

  if (access.loading) return <PageLoader className="min-h-[60vh]" />;
  if (!access.isAdmin) {
    return <EmptyState title="Admin only" description="This page is for platform administrators." />;
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-gray-900">Admin</h1>
        <p className="text-sm text-gray-500 mt-1">Every account that signs up, what it may use, its credits and plan, its outreach workspaces and the sales CRM team.</p>
      </div>

      <div className="flex items-center gap-1 border-b border-gray-200 mb-6 overflow-x-auto">
        {TABS.map((t) => (
          <button key={t.id} type="button" onClick={() => setTab(t.id)}
            className={cn('inline-flex items-center gap-2 px-3 py-2.5 text-sm font-medium border-b-2 -mb-px whitespace-nowrap', tab === t.id ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-gray-500 hover:text-gray-800')}>
            <t.icon className="w-4 h-4" />{t.label}
          </button>
        ))}
      </div>

      {tab === 'users' && <UsersTab onOpenUser={setUserId} />}
      {tab === 'outreach' && <OutreachTab onOpenUser={setUserId} />}
      {tab === 'crm' && <CrmTab onOpenUser={setUserId} />}
      {tab === 'settings' && <SettingsTab onOpenUser={setUserId} />}
      {tab === 'audit' && <AuditTab onOpenUser={setUserId} />}

      <UserDrawer userId={userId} onClose={() => setUserId(null)} />
    </div>
  );
}

export default function AdminPage() {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, retry: 1, refetchOnWindowFocus: false } } }));
  return (
    <ProtectedRoute>
      <MainLayout>
        <QueryClientProvider client={qc}>
          <AdminToastProvider>
            {/* useSearchParams needs a Suspense boundary for prerendering */}
            <Suspense fallback={<PageLoader className="min-h-[60vh]" />}>
              <AdminConsole />
            </Suspense>
          </AdminToastProvider>
        </QueryClientProvider>
      </MainLayout>
    </ProtectedRoute>
  );
}
