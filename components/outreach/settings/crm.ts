// CRM integration constants (item 22). The sync worker owns the real defaults; these mirror them for display.
// Contract with `_shared/outreach/crm`:
//   field_mapping  { <our lead field>: <CRM property> }   `{}` = use the defaults below; a non-empty object is used as it is
//   stage_mapping  { <our stage kind>: <CRM stage / lifecycle value> }   a kind that is missing is not pushed
import type { CrmProvider, SyncRule } from './types';

export const CRM_PROVIDERS: Array<{ value: CrmProvider; label: string; blurb: string; color: string; stageNoun: string; segmentNoun: string }> = [
  { value: 'hubspot', label: 'HubSpot', blurb: 'Contacts, companies, timeline notes, lifecycle stages and deals.', color: '#ff7a59', stageNoun: 'lifecycle stage', segmentNoun: 'list' },
  { value: 'pipedrive', label: 'Pipedrive', blurb: 'People, organisations, notes and deals.', color: '#1a7f4b', stageNoun: 'deal stage id', segmentNoun: 'filter' },
  { value: 'salesforce', label: 'Salesforce', blurb: 'Leads or contacts, accounts, tasks and opportunities.', color: '#00a1e0', stageNoun: 'lead status', segmentNoun: 'list view' },
];
export const crmLabel = (p: string) => CRM_PROVIDERS.find((x) => x.value === p)?.label ?? p;

export const LEAD_FIELDS: Array<{ value: string; label: string }> = [
  { value: 'first_name', label: 'First name' }, { value: 'last_name', label: 'Last name' }, { value: 'full_name', label: 'Full name' },
  { value: 'email_work', label: 'Work email' }, { value: 'email_personal', label: 'Personal email' }, { value: 'phone', label: 'Phone' },
  { value: 'title', label: 'Job title' }, { value: 'headline', label: 'LinkedIn headline' }, { value: 'company', label: 'Company' },
  { value: 'location', label: 'Location' }, { value: 'linkedin_url', label: 'LinkedIn URL' }, { value: 'stage', label: 'Pipeline stage' },
  { value: 'last_intent', label: 'Last reply intent' }, { value: 'sequence_name', label: 'Sequence name' }, { value: 'sender_name', label: 'Sender name' },
];

export const DEFAULT_FIELD_MAPPING: Record<CrmProvider, Record<string, string>> = {
  hubspot: { first_name: 'firstname', last_name: 'lastname', email_work: 'email', phone: 'phone', title: 'jobtitle', company: 'company', location: 'city', linkedin_url: 'hs_linkedin_url' },
  pipedrive: { full_name: 'name', email_work: 'email', phone: 'phone', title: 'job_title', company: 'org_name', linkedin_url: 'custom:LinkedIn URL' },
  salesforce: { first_name: 'FirstName', last_name: 'LastName', email_work: 'Email', phone: 'Phone', title: 'Title', company: 'Company', location: 'City' },
};

export const DEFAULT_STAGE_MAPPING: Record<CrmProvider, Record<string, string>> = {
  hubspot: { replied: 'lead', interested: 'marketingqualifiedlead', meeting: 'salesqualifiedlead', won: 'customer' },
  pipedrive: {},      // deal stage ids differ per account
  salesforce: {},     // lead status values differ per org
};

export const SYNC_RULES: Array<{ value: SyncRule; label: string; hint: string }> = [
  { value: 'replied', label: 'Only leads who replied', hint: 'Recommended. Your CRM stays a list of real conversations, not thousands of cold contacts nobody has spoken to.' },
  { value: 'interested', label: 'Only interested leads', hint: 'A lead is pushed once a reply is classified interested, a meeting is booked or the deal is won.' },
  { value: 'enrolled', label: 'Everyone enrolled', hint: 'Every lead is pushed when it enters a sequence. This fills the CRM quickly and can use up contact limits on your CRM plan.' },
];

const OPS: Record<string, string> = {
  'contact.upsert': 'Contact created or updated', 'company.upsert': 'Company created or updated', 'note.create': 'Message logged on the timeline',
  'deal.create': 'Deal created', 'stage.update': 'Stage updated', 'list.import': 'List imported', 'suppress.refresh': 'Customer blacklist refreshed',
};
export const opLabel = (op: string) => OPS[op] ?? op.replace(/[._]/g, ' ');

/** Turn a raw CRM / OAuth error into a sentence that says what to do. The raw text stays available as a tooltip. */
export function plainCrmError(raw: string | null | undefined, provider: string): string | null {
  if (!raw) return null;
  const t = raw.toLowerCase();
  const name = crmLabel(provider);
  if (/invalid_grant|unauthori[sz]ed|\b401\b|token (is )?(expired|revoked|invalid)|refresh token/.test(t)) return `${name} no longer accepts our access. Connect again to carry on syncing. Nothing is lost: waiting changes are sent after you reconnect.`;
  if (/\b403\b|forbidden|scope|permission|insufficient/.test(t)) return `The ${name} user who connected does not have permission for this. Connect again with an admin user, or give that user access to contacts and deals.`;
  if (/\b429\b|rate.?limit|too many/.test(t)) return `${name} asked us to slow down. We retry on our own; nothing to do.`;
  if (/timeout|timed out|\b50[0-9]\b|econn|network|fetch failed/.test(t)) return `${name} did not answer. We retry on our own; if it keeps happening, check ${name}'s status page.`;
  if (/property|field|does not exist|invalid.*(value|option)|required/.test(t)) return `${name} rejected a field. Check the field mapping below: a mapped property may not exist or may not accept the value.`;
  if (/duplicate|already exists|conflict|\b409\b/.test(t)) return `${name} already has a matching record, so this one was not created again.`;
  return raw.length > 220 ? `${raw.slice(0, 220)}…` : raw;
}

/** `?error=` values the OAuth callback can send back. */
export function oauthErrorText(code: string, provider?: string | null): string {
  const name = provider ? crmLabel(provider) : 'the CRM';
  const c = code.toLowerCase();
  if (c.includes('not_configured')) return 'This CRM is not enabled on this platform yet.';
  if (c.includes('access_denied') || c.includes('denied') || c.includes('cancel')) return `You cancelled the ${name} sign-in, so nothing was connected.`;
  if (c.includes('state') || c.includes('expired')) return 'The sign-in took too long or was opened in another browser. Start again from the Connect button.';
  if (c.includes('forbidden')) return 'Only owners and managers can connect a CRM.';
  return `${name} could not be connected: ${code.replace(/_/g, ' ')}.`;
}
