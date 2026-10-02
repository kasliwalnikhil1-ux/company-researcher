// Run: npx tsx components/outreach/leads/helpers.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CSV_MAX_ROWS, LEAD_FIELDS, csvKeyStats, dedupeKey, guessField, linkedInProfileUrl, normalizePublicIdentifier } from './helpers';

// the upload screen and the import worker must agree on the largest file
const worker = readFileSync('supabase/functions/_shared/outreach/workers.ts', 'utf8');
assert.equal(Number(/export const CSV_MAX_ROWS = ([\d_]+);/.exec(worker)?.[1].replace(/_/g, '')), CSV_MAX_ROWS);

// The header row that collapsed 709 rows into 9 leads: the account owner's profile came first and was guessed as the lead's LinkedIn URL.
const HEADERS = ['prospect_name', 'company', 'title', 'account', 'account_linkedin_url', 'prospect_linkedin_url', 'emails', 'phones', 'domain', 'stage', 'status', 'notes', 'created_at'];

function guessAll(headers: string[]): Record<string, string> {
  const out: Record<string, string> = {}; const used = new Set<string>();
  for (const h of headers) { let g = guessField(h); if (g && used.has(g)) g = ''; if (g) used.add(g); out[h] = g; }
  return out;
}

const g = guessAll(HEADERS);
assert.equal(g.prospect_linkedin_url, 'linkedin_url');
assert.equal(g.account_linkedin_url, '');
assert.equal(g.prospect_name, 'full_name');
assert.equal(g.company, 'company');
assert.equal(g.account, '');
assert.equal(g.title, 'title');
assert.equal(g.emails, 'email_work');
assert.equal(g.phones, 'phone');
assert.equal(g.domain, 'company_domain');
for (const h of ['stage', 'status', 'notes', 'created_at']) assert.equal(g[h], '', h);

// a column about somebody else is never a matching key
for (const h of ['Owner Email', 'sender_linkedin', 'Company LinkedIn URL', 'Assigned Rep Email', 'account_owner_email']) assert.equal(guessField(h), '', h);
// the usual headers still resolve
const usual: Record<string, string> = {
  'LinkedIn URL': 'linkedin_url', linkedin: 'linkedin_url', 'Profile URL': 'linkedin_url', 'Lead LinkedIn': 'linkedin_url', 'Person Linkedin Url': 'linkedin_url',
  'First Name': 'first_name', last_name: 'last_name', Name: 'full_name', 'Full Name': 'full_name', 'Contact Name': 'full_name',
  Email: 'email_work', 'Work Email': 'email_work', 'Email Address': 'email_work', 'Personal Email': 'email_personal', 'Lead Email': 'email_work',
  'Company Name': 'company', Account: 'company', 'Job Title': 'title', Phone: 'phone', 'Mobile Number': 'phone', Website: 'company_domain', City: 'location',
};
for (const [h, f] of Object.entries(usual)) assert.equal(guessField(h), f, h);

// One LinkedIn field. Every way one person's profile gets written resolves to the same identifier and the same URL
// (the same values as csvPublicIdentifier in supabase/functions/_shared/outreach/csv_test.ts).
assert.deepEqual(LEAD_FIELDS.filter((f) => /linkedin|identifier/i.test(f.label)).map((f) => f.value), ['linkedin_url']);
for (const h of ['public_identifier', 'Public ID', 'LinkedIn slug', 'vanity name', 'linkedin_identifier']) assert.equal(guessField(h), 'linkedin_url', h);
const profiles: Array<[string, string | null]> = [
  ['https://www.linkedin.com/in/namankas/?isSelfProfile=true', 'namankas'], ['https://www.linkedin.com/in/namankas', 'namankas'], ['https://www.linkedin.com/in/namankas/', 'namankas'],
  ['in/namankas/?isSelfProfile=true', 'namankas'], ['in/namankas', 'namankas'], ['namankas', 'namankas'],
  ['/in/namankas/', 'namankas'], ['@namankas', 'namankas'], ['  NamanKas  ', 'namankas'], ['www.linkedin.com/in/namankas#about', 'namankas'], ['https://www.linkedin.com/mwlite/in/namankas', 'namankas'],
  ['https://uk.linkedin.com/in/shirley-paris', 'shirley-paris'], ['http://www.linkedin.com/in/Emily-Sutter-4ab43b95?trk=x', 'emily-sutter-4ab43b95'],
  ['https://www.linkedin.com/in/florian-r%c3%b6der-518a65190/', 'florian-röder-518a65190'], ['100%-real', '100%-real'],
  // not a profile: another LinkedIn page, a name, an email, a website
  ['https://www.linkedin.com/company/zalora', null], ['linkedin.com/company/zalora', null], ['https://www.linkedin.com/sales/lead/ACwAAA,NAME', null],
  ['https://example.com/x', null], ['Naman Kas', null], ['naman@example.com', null], ['example.com/naman', null], ['', null],
];
for (const [v, want] of profiles) assert.equal(normalizePublicIdentifier(v), want, v);
assert.equal(linkedInProfileUrl('namankas'), 'https://www.linkedin.com/in/namankas');
// a file that writes the same person six ways is one person
const sixWays = profiles.slice(0, 6).map(([v]) => ({ li: v }));
assert.deepEqual(csvKeyStats(sixWays, { li: 'linkedin_url' }), { keyed: 6, unkeyed: 0, people: 1, repeated: 5, collapsing: false });
assert.deepEqual(dedupeKey({ li: 'in/namankas/?isSelfProfile=true' }, { li: 'linkedin_url' }), { kind: 'public_identifier', value: 'namankas' });

// key stats over the whole file
const owner = { account_linkedin_url: 'linkedin_url' };
const lead = { prospect_linkedin_url: 'linkedin_url', emails: 'email_work' };
const rows = Array.from({ length: 40 }, (_, i) => ({
  account_linkedin_url: i < 36 ? 'https://www.linkedin.com/in/toass' : `https://www.linkedin.com/in/owner-${i}/`,
  prospect_linkedin_url: i < 2 ? '' : `https://uk.linkedin.com/in/Lead-${i}/?x=1`,
  emails: i === 0 ? 'a@b.co' : '',
}));
assert.deepEqual(csvKeyStats(rows, owner), { keyed: 40, unkeyed: 0, people: 5, repeated: 35, collapsing: true });
assert.deepEqual(csvKeyStats(rows, lead), { keyed: 39, unkeyed: 1, people: 39, repeated: 0, collapsing: false });
// a small file with a couple of repeats is not flagged
assert.equal(csvKeyStats(rows.slice(34, 40), owner).collapsing, false);

console.log('helpers.test.ts ok');
