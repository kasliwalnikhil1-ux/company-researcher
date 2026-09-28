import { redirect } from 'next/navigation';

/** Billing moved to /outreach/billing. Kept so old links and Stripe return URLs (with ?checkout=) still land. */
export default async function OldBillingRedirect({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const qs = new URLSearchParams(Object.entries(sp).flatMap(([k, v]) => (Array.isArray(v) ? v : v == null ? [] : [v]).map((x) => [k, x] as [string, string]))).toString();
  redirect(`/outreach/billing${qs ? `?${qs}` : ''}`);
}
