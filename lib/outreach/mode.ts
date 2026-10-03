/**
 * Real or demo: decided once per page load from the browser URL (docs/outreach/PRODUCT-TOUR.md).
 *
 * `/product-tour/*` (and its aliases `/tour/*`, `/demo/*`, `/product/*`) serves the same route files as `/outreach/*`
 * (proxy.ts rewrite). On those URLs the outreach UI runs on the demo backend (in-browser data, nothing reaches a
 * production service) and skips sign-in. Everywhere else it is the real product, unchanged. Crossing between the two
 * prefixes is always a full page load (`leaveDemo` / `enterDemo`), so this constant can never disagree with the data
 * provider in use. A visitor stays on the prefix they arrived on: links inside the tour keep it.
 */

export const REAL_PREFIX = '/outreach';

/** Every URL prefix that opens the tour. `/product-tour` is the canonical one. */
export const DEMO_PREFIXES = ['/product-tour', '/tour', '/demo', '/product'] as const;

const prefixOf = (path: string): string | undefined =>
  DEMO_PREFIXES.find((p) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`) || path.startsWith(`${p}#`));

/** Whether a path is inside the tour, under any of its prefixes. */
export const isDemoPath = (path: string): boolean => prefixOf(path) !== undefined;

const ARRIVED: string | undefined = typeof window !== 'undefined' ? prefixOf(window.location.pathname) : undefined;

export const IS_DEMO: boolean = ARRIVED !== undefined;

/** The tour prefix of this page load (the one in the URL), `/product-tour` outside the tour. */
export const DEMO_PREFIX: string = ARRIVED ?? DEMO_PREFIXES[0];

/** `/outreach/x` → `/product-tour/x` in demo mode; anything else (other products, external links) is left alone. */
export function modeHref(href: string): string {
  if (!IS_DEMO) return href;
  return toDemoPath(href);
}

export function toDemoPath(href: string): string {
  if (href === REAL_PREFIX) return DEMO_PREFIX;
  if (href.startsWith(`${REAL_PREFIX}/`) || href.startsWith(`${REAL_PREFIX}?`) || href.startsWith(`${REAL_PREFIX}#`)) return DEMO_PREFIX + href.slice(REAL_PREFIX.length);
  return href;
}

/** `/product-tour/x` → `/outreach/x`: the path the shared code compares against. */
export function toRealPath(path: string): string {
  const p = prefixOf(path);
  return p === undefined ? path : REAL_PREFIX + path.slice(p.length);
}

/** Full page load out of the demo (the CTA). */
export function leaveDemo(to = `${REAL_PREFIX}?from=product-tour`): void {
  window.location.assign(to);
}
