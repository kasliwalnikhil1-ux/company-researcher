/**
 * The bridge between demo handlers (lib/outreach/backend/demo) and the demo shell (components/outreach/demo): toasts
 * and the fake external steps (connect an account, checkout, a consent screen). No imports, so both sides can use it.
 */

export type DemoDialog =
  | { kind: 'connect'; provider: string; method?: string }
  | { kind: 'checkout'; title: string; amount?: string; lines?: string[] }
  | { kind: 'consent'; app: string; scopes?: string[] };

interface DemoUiImpl {
  toast(text: string, tone?: 'info' | 'success' | 'error'): void;
  dialog(d: DemoDialog): Promise<boolean>;
}

let impl: DemoUiImpl | null = null;

export function setDemoUi(next: DemoUiImpl | null): void { impl = next; }

export const demoUi = {
  toast(text: string, tone: 'info' | 'success' | 'error' = 'info') { impl?.toast(text, tone); },
  /** The small "nothing left the browser" note next to an action that would reach the outside world. */
  simulated(text = 'Simulated. Nothing was sent.') { impl?.toast(text, 'info'); },
  /** Shows a fake external step; resolves true when the visitor completes it. Without a shell it completes at once. */
  dialog(d: DemoDialog): Promise<boolean> { return impl ? impl.dialog(d) : Promise.resolve(true); },
};
