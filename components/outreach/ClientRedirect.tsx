'use client';

import { Suspense, useEffect } from 'react';
import { useParams, useRouter, useSearchParams } from '@/lib/outreach/nav';
import { PageLoader } from '@/components/outreach/ui';

type Target = (search: URLSearchParams, params: Record<string, string | string[] | undefined>) => string;

function Go({ to }: { to: Target }) {
  const router = useRouter();
  const search = useSearchParams();
  const params = useParams() as Record<string, string | string[] | undefined>;
  useEffect(() => { router.replace(to(new URLSearchParams(search?.toString() ?? ''), params)); }, [router, search, params, to]);
  return <PageLoader />;
}

/**
 * A moved page that sends old links on. A client redirect (not `redirect()` in a server component) so it keeps the
 * visitor inside the product tour: the wrapped router maps `/outreach…` to `/product-tour…` there.
 */
export default function ClientRedirect({ to }: { to: Target }) {
  return <Suspense fallback={<PageLoader />}><Go to={to} /></Suspense>;
}
