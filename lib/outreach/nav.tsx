'use client';

/**
 * Link, router and pathname for the outreach UI. Use these instead of `next/link` / `next/navigation` (lint rule).
 *
 * Real mode: exactly the Next.js ones. Demo mode (`/product-tour`): every `/outreach…` href is sent to `/product-tour…`,
 * and `usePathname()` reports the path as `/outreach/…`, so the existing "is this nav item active" checks keep working.
 */
import NextLink from 'next/link';
import {
  useRouter as useNextRouter,
  usePathname as useNextPathname,
  useParams, useSearchParams, useSelectedLayoutSegment, useSelectedLayoutSegments,
} from 'next/navigation';
import { forwardRef, useMemo, type ComponentProps } from 'react';
import { IS_DEMO, modeHref, toRealPath } from './mode';

export { useParams, useSearchParams, useSelectedLayoutSegment, useSelectedLayoutSegments };

type Href = ComponentProps<typeof NextLink>['href'];

function translate(href: Href): Href {
  if (!IS_DEMO) return href;
  if (typeof href === 'string') return modeHref(href);
  if (href && typeof href === 'object' && typeof href.pathname === 'string') return { ...href, pathname: modeHref(href.pathname) };
  return href;
}

const Link = forwardRef<HTMLAnchorElement, ComponentProps<typeof NextLink>>(function OutreachLink({ href, as, ...rest }, ref) {
  return <NextLink ref={ref} href={translate(href)} as={as == null ? as : translate(as)} {...rest} />;
});

export default Link;
export { Link };

export function useRouter(): ReturnType<typeof useNextRouter> {
  const router = useNextRouter();
  return useMemo(() => {
    if (!IS_DEMO) return router;
    return {
      ...router,
      push: (href: string, o?: Parameters<typeof router.push>[1]) => router.push(modeHref(href), o),
      replace: (href: string, o?: Parameters<typeof router.replace>[1]) => router.replace(modeHref(href), o),
      prefetch: (href: string, o?: Parameters<typeof router.prefetch>[1]) => router.prefetch(modeHref(href), o),
    };
  }, [router]);
}

export function usePathname(): string {
  const p = useNextPathname();
  return IS_DEMO && p ? toRealPath(p) : p;
}

/** For the few places that build a URL by hand (`window.location.href = …`, copy-link buttons). */
export { modeHref };
