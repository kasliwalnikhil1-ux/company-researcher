/** Loads the demo runtime (store, seed data, handlers) on first use, so the real app never downloads it. */
import type * as Runtime from './runtime';

let pending: Promise<typeof Runtime> | null = null;

export function loadDemo(): Promise<typeof Runtime> {
  if (!pending) pending = import('./runtime');
  return pending;
}
