'use client';

import ClientRedirect from '@/components/outreach/ClientRedirect';

const to = (sp: URLSearchParams) => { const qs = sp.toString(); return `/outreach/billing${qs ? `?${qs}` : ''}`; };

/** Billing moved to /outreach/billing. Kept so old links and Stripe return URLs (with ?checkout=) still land. */
export default function OldBillingRedirect() {
  return <ClientRedirect to={to} />;
}
