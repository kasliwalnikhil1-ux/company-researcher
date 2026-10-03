'use client';

import ClientRedirect from '@/components/outreach/ClientRedirect';

const to = (sp: URLSearchParams, p: Record<string, string | string[] | undefined>) => {
  const id = String(Array.isArray(p.id) ? p.id[0] : p.id ?? '');
  const t = sp.get('tab');
  return `/outreach/websites/${encodeURIComponent(id)}${t ? `?tab=${encodeURIComponent(t)}` : ''}`;
};

// Websites moved out of Settings to its own sidebar item (Website agents). Old links keep working, ?tab= included.
export default function WebsiteMovedPage() {
  return <ClientRedirect to={to} />;
}
