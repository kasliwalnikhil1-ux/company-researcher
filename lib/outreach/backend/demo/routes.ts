/**
 * Route manifest of the product tour: every `app/outreach/**\/page.tsx`, with sample ids for dynamic segments.
 * scripts/outreach-demo-check.ts fails when a route file exists with no entry here (or an entry has no file), and
 * opens every entry under /product-tour in a headless browser.
 *
 * `demo: false` = the page is deliberately not part of the tour (it still needs an entry, so the choice is explicit).
 */
import { CLIENT, SAMPLE, SENDER, SEQ, WEBCHAT } from './seed/ids';

export interface RouteEntry {
  /** The route file's path under app/outreach, `[param]` segments as in the file system. */
  file: string;
  /** The URL to open (under /outreach; the check opens it under /product-tour). */
  url: string;
  demo?: false;
  /** Why the page is left out of the tour. */
  why?: string;
}

export const ROUTES: RouteEntry[] = [
  { file: 'page.tsx', url: '/outreach' },
  { file: 'inbox/page.tsx', url: '/outreach/inbox' },
  { file: 'inbox/[chatId]/page.tsx', url: '/outreach/inbox/__first_chat__' },
  { file: 'senders/page.tsx', url: '/outreach/senders' },
  { file: 'senders/new/page.tsx', url: '/outreach/senders/new' },
  { file: 'senders/[id]/page.tsx', url: `/outreach/senders/${SENDER.li_maya}` },
  { file: 'senders/profiles/page.tsx', url: '/outreach/senders/profiles' },
  { file: 'leads/page.tsx', url: '/outreach/leads' },
  { file: 'leads/[id]/page.tsx', url: `/outreach/leads/${SAMPLE.leadId}` },
  { file: 'leads/import/page.tsx', url: '/outreach/leads/import' },
  { file: 'sequences/page.tsx', url: '/outreach/sequences' },
  { file: 'sequences/new/page.tsx', url: '/outreach/sequences/new' },
  { file: 'sequences/[id]/page.tsx', url: `/outreach/sequences/${SEQ.saas}` },
  { file: 'sequences/[id]/versions/page.tsx', url: `/outreach/sequences/${SEQ.saas}/versions` },
  { file: 'sequences/[id]/enroll/page.tsx', url: `/outreach/sequences/${SEQ.saas}/enroll` },
  { file: 'tasks/page.tsx', url: '/outreach/tasks' },
  { file: 'ai/page.tsx', url: '/outreach/ai' },
  { file: 'ai/needs-you/page.tsx', url: '/outreach/ai/needs-you' },
  { file: 'ai/activity/page.tsx', url: '/outreach/ai/activity' },
  { file: 'ai/knowledge/page.tsx', url: '/outreach/ai/knowledge' },
  { file: 'ai/knowledge/catalogue/[id]/page.tsx', url: '/outreach/ai/knowledge/catalogue/__first_catalogue__' },
  { file: 'ai/setup/page.tsx', url: '/outreach/ai/setup' },
  { file: 'ai/setup/general/page.tsx', url: '/outreach/ai/setup/general' },
  { file: 'ai/setup/lines/page.tsx', url: '/outreach/ai/setup/lines' },
  { file: 'ai/setup/lines/[variableId]/page.tsx', url: '/outreach/ai/setup/lines/__first_variable__' },
  { file: 'ai/setup/replies/page.tsx', url: '/outreach/ai/setup/replies' },
  { file: 'ai/setup/website/page.tsx', url: '/outreach/ai/setup/website' },
  { file: 'ai-review/page.tsx', url: '/outreach/ai-review' },
  { file: 'websites/page.tsx', url: '/outreach/websites' },
  { file: 'websites/[id]/page.tsx', url: `/outreach/websites/${WEBCHAT.inbox}` },
  { file: 'reports/page.tsx', url: '/outreach/reports' },
  { file: 'clients/page.tsx', url: '/outreach/clients' },
  { file: 'c/page.tsx', url: '/outreach/c' },
  { file: 'c/[clientId]/page.tsx', url: `/outreach/c/${CLIENT.lumen}` },
  { file: 'billing/page.tsx', url: '/outreach/billing' },
  { file: 'billing/change/page.tsx', url: '/outreach/billing/change' },
  { file: 'settings/workspace/page.tsx', url: '/outreach/settings/workspace' },
  { file: 'settings/members/page.tsx', url: '/outreach/settings/members' },
  { file: 'settings/branding/page.tsx', url: '/outreach/settings/branding' },
  { file: 'settings/email/page.tsx', url: '/outreach/settings/email' },
  { file: 'settings/integrations/page.tsx', url: '/outreach/settings/integrations' },
  { file: 'settings/notifications/page.tsx', url: '/outreach/settings/notifications' },
  { file: 'settings/safety/page.tsx', url: '/outreach/settings/safety' },
  { file: 'settings/suppressions/page.tsx', url: '/outreach/settings/suppressions' },
  { file: 'settings/webhooks/page.tsx', url: '/outreach/settings/webhooks' },
  { file: 'settings/api/page.tsx', url: '/outreach/settings/api' },
  // moved pages: client redirects that stay inside the tour
  { file: 'settings/ai/page.tsx', url: '/outreach/settings/ai' },
  { file: 'settings/ai-replies/page.tsx', url: '/outreach/settings/ai-replies' },
  { file: 'settings/billing/page.tsx', url: '/outreach/settings/billing' },
  { file: 'settings/websites/page.tsx', url: '/outreach/settings/websites' },
  { file: 'settings/websites/[id]/page.tsx', url: `/outreach/settings/websites/${WEBCHAT.inbox}` },
  // not in the tour
  { file: 'settings/admin/page.tsx', url: '/outreach/settings/admin', demo: false, why: 'Platform admin: an internal tool, localhost only, hidden in the demo' },
  { file: 'invite/[token]/page.tsx', url: '/outreach/invite/demo-invite-token', demo: false, why: 'The entry page of a real invitation' },
];
