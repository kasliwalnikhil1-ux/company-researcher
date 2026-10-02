/**
 * Real or demo: decided once per page load from the browser URL (docs/outreach/PRODUCT-TOUR.md).
 *
 * `/product-tour/*` serves the same route files as `/outreach/*` (proxy.ts rewrite). On those URLs the outreach UI runs
 * on the demo backend (in-browser data, nothing reaches a production service) and skips sign-in. Everywhere else it is
 * the real product, unchanged. Crossing between the two prefixes is always a full page load (`leaveDemo` /
 * `enterDemo`), so this constant can never disagree with the data provider in use.
 */

export const REAL_PREFIX = '/outreach';
export const DEMO_PREFIX = '/product-tour';

const DEMO_PATH = /^\/product-tour(\/|$|\?|#)/;

export const IS_DEMO: boolean = typeof window !== 'undefined' && DEMO_PATH.test(window.location.pathname);

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
  if (path === DEMO_PREFIX) return REAL_PREFIX;
  if (DEMO_PATH.test(path)) return REAL_PREFIX + path.slice(DEMO_PREFIX.length);
  return path;
}

/** Full page load out of the demo (the CTA and "Exit demo"). */
export function leaveDemo(to = `${REAL_PREFIX}?from=product-tour`): void {
  window.location.assign(to);
}
