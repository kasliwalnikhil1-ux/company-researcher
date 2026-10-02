// AI fields + Insert Variables (docs/outreach/AI-FIELDS.md): the builder-side rules that have no database behind them.
// No test framework on purpose: `npx tsx lib/outreach/aiFields.test.ts` from the repo root.
import { validateGraph, sequenceAiKeys } from './graph';
import { aiConditionFields, conditionFieldMeta, conditionOpsFor, TEMPLATE_VARIABLES, type AiConditionVariable } from './nodes';
import { editOf, editProblems, editToData, fieldKeyFromName, fieldListProblems, fieldOf, fieldsSummary, fieldToken, hasFieldProblems, newFieldDraft, sameEdit, type FieldDraft } from './aiFields';
import { renderTemplate, VARIABLE_ALIASES, type RenderContext } from './render';
import { exampleFor, matchesSearch, VARIABLE_CATALOG, VARIABLE_TABS, visibleRows, workspaceRows } from './variables';
import type { AiField, Graph } from './types';

let failed = 0;
const chk = (name: string, ok: boolean, detail?: unknown) => { if (!ok) { failed++; console.error(`FAIL ${name}${detail !== undefined ? `\n  ${JSON.stringify(detail)}` : ''}`); } };
const pos = { x: 0, y: 0 };

const FIELDS: AiField[] = [
  { key: 'icp_fit', name: 'ICP fit', type: 'choice', options: ['high', 'medium', 'low'], description: 'How well the company matches the ICP' },
  { key: 'pain', name: 'Pain', type: 'text', max_chars: 120 },
  { key: 'hiring_sales', name: 'Hiring sales', type: 'yes_no' },
  { key: 'team_size', name: 'Team size', type: 'number' },
];
const VARS: AiConditionVariable[] = [
  { key: 'research', name: 'Research', output: 'fields', fields: FIELDS },
  { key: 'opener', name: 'Opener', output: 'text', fields: [] },
  { key: 'contact_first_name', name: 'Contact first name', output: 'text', fields: [], builtin: true },
];

// ---------------------------------------------------------------- which variables a graph uses (mirror of the SQL)
const graphOf = (text: string, rules: unknown[] = []): Graph => ({ version: 1, start: 'start', nodes: {
  start: { id: 'start', type: 'start', position: pos, next: 'c' },
  c: { id: 'c', type: 'condition', position: pos, config: { match: 'all', rules }, branches: { true: 'm', false: 'end' } },
  m: { id: 'm', type: 'send_message', position: pos, config: { text, send_always: true }, next: 'end' },
  end: { id: 'end', type: 'end', position: pos, config: {} },
} } as unknown as Graph);

chk('ai keys: a Condition rule alone', JSON.stringify(sequenceAiKeys(graphOf('Hi', [{ field: 'ai.research.icp_fit', op: 'eq', value: 'high' }]))) === '["research"]');
chk('ai keys: {{#if ai.x.y}} and {{ai.x.y}}', JSON.stringify(sequenceAiKeys(graphOf('{{#if ai.research.hiring_sales}}x{{/if}} {{ai.opener|there}}'))) === '["opener","research"]');
chk('ai keys: tag conditionals and built-ins', JSON.stringify(sequenceAiKeys(graphOf('{% if ai.research.icp_fit == "high" %}x{% endif %} {{ ai_contact_first_name }} {% if ai_position_conversational %}y{% endif %}'))) === '["contact_first_name","position_conversational","research"]', sequenceAiKeys(graphOf('{% if ai.research.icp_fit == "high" %}x{% endif %} {{ ai_contact_first_name }} {% if ai_position_conversational %}y{% endif %}')));
chk('ai keys: a custom field that looks like a built-in is not one', sequenceAiKeys(graphOf('{{custom.ai_contact_first_name}} ai_contact_first_name {{ai_contact_first_names}}')).length === 0);
chk('ai keys: nothing', sequenceAiKeys(null).length === 0 && sequenceAiKeys(graphOf('Hi {{first_name}}')).length === 0);

// ---------------------------------------------------------------- builder checks
const issues = (text: string, rules: unknown[] = [], vars: AiConditionVariable[] | undefined = VARS) => {
  const r = validateGraph(graphOf(text, rules), { aiVariables: vars });
  return [...r.errors.map((e) => `E:${e.code}`), ...r.warnings.map((w) => `W:${w.code}`)].filter((c) => /AI_|FILTER/.test(c));
};
chk('bare {{ai.research}} of a Fields variable blocks publish', validateGraph(graphOf('x {{ai.research}}'), { aiVariables: VARS }).errors.some((e) => e.code === 'E_AI_FIELDS_BARE' && e.node_id === 'm' && /\{\{ai\.research\.icp_fit\}\}/.test(e.message)));
chk('bare with a fallback is still bare', issues('{{ ai.research | hello }}').includes('E:E_AI_FIELDS_BARE'));
chk('{{#if ai.research}} is allowed (has a value)', issues('{{#if ai.research}}x{{/if}}').length === 0);
chk('a field that does not exist warns', JSON.stringify(issues('{{ai.research.pains}}')) === '["W:W_AI_FIELD_UNKNOWN"]');
chk('a field of a one-line variable warns', JSON.stringify(issues('{{ai.opener.pain}}')) === '["W:W_AI_FIELD_UNKNOWN"]');
chk('an unknown variable warns', JSON.stringify(issues('{{ai.reserch.pain|x}}')) === '["W:W_AI_FIELD_UNKNOWN"]');
chk('a Yes/No field printed warns', JSON.stringify(issues('{{ai.research.hiring_sales}}')) === '["W:W_AI_FIELD_YESNO_PRINTED"]');
chk('a Yes/No field in a conditional is fine', issues('{{#if ai.research.hiring_sales}}a{{else}}b{{/if}} {% if ai.research.hiring_sales %}c{% endif %}').length === 0);
chk('valid tokens are quiet', issues('{{ai.research.pain|growing outbound}} {{ai.research.team_size}} {{ai.research.icp_fit}} {{ai.opener|hi}} {{ ai_contact_first_name }}').length === 0);
chk('a Condition on an unknown field warns on the condition step', validateGraph(graphOf('Hi', [{ field: 'ai.research.nope', op: 'eq', value: 'x' }]), { aiVariables: VARS }).warnings.some((w) => w.code === 'W_AI_FIELD_UNKNOWN' && w.node_id === 'c'));
chk('a Condition on a real field is quiet', issues('Hi', [{ field: 'ai.research.icp_fit', op: 'eq', value: 'high' }, { field: 'ai.opener', op: 'exists' }]).length === 0);
chk('without the variable list the AI checks are skipped', (() => { const r = validateGraph(graphOf('{{ai.research}} {{ai.nope.x}}')); return ![...r.errors, ...r.warnings].some((i) => /AI_/.test(i.code)); })());
chk('a filter one letter off warns', JSON.stringify(issues('{{ position | lowrcase }} {{ position | plurals }}')) === '["W:W_TEMPLATE_UNKNOWN_FILTER","W:W_TEMPLATE_UNKNOWN_FILTER"]', issues('{{ position | lowrcase }} {{ position | plurals }}'));
chk('real filters and ordinary fallbacks are quiet', issues('{{ position | lowercase | plural }} {{ first_name | there }} {{ company | your company }} {{ title|Lower Case }}').length === 0);
chk('variants are checked too', validateGraph({ version: 1, start: 's', nodes: { s: { id: 's', type: 'start', position: pos, next: 'm' }, m: { id: 'm', type: 'send_message', position: pos, config: { text: 'a', variants: [{ id: 'b', label: 'B', weight: 1, text: '{{ai.research}}' }] }, next: null } } } as unknown as Graph, { aiVariables: VARS }).errors.some((e) => e.code === 'E_AI_FIELDS_BARE'));

// ---------------------------------------------------------------- Condition editor: the AI fields group
const cf = aiConditionFields(VARS);
const meta = (f: string) => conditionFieldMeta(f, cf);
chk('one entry per field + one per one-line variable, built-ins left out', cf.length === 5 && cf.every((f) => f.group === 'AI fields') && !cf.some((f) => f.value.includes('contact_first_name')));
chk('choice → select with its options', meta('ai.research.icp_fit')?.kind === 'select' && meta('ai.research.icp_fit')?.options?.map((o) => o.value).join() === 'high,medium,low' && meta('ai.research.icp_fit')?.label === 'Research · ICP fit');
chk('yes/no → boolean', meta('ai.research.hiring_sales')?.kind === 'boolean' && meta('ai.research.hiring_sales')?.defaultOp === 'eq');
chk('number → number operators', meta('ai.research.team_size')?.kind === 'number' && conditionOpsFor('ai.research.team_size', cf).includes('gte') && !conditionOpsFor('ai.research.team_size', cf).includes('contains'));
chk('text → contains', meta('ai.research.pain')?.defaultOp === 'contains');
chk('one-line variable → has a line', meta('ai.opener')?.label === 'Opener · has a line' && conditionOpsFor('ai.opener', cf).join() === 'exists,not_exists');
chk('a field that is gone has no meta (the editor shows it as it is)', meta('ai.research.gone') === undefined && conditionFieldMeta('replied', cf)?.label === 'Replied');

// ---------------------------------------------------------------- the field model
chk('field key from a name', fieldKeyFromName('ICP fit') === 'icp_fit' && fieldKeyFromName('  Hiring sales? ') === 'hiring_sales' && fieldKeyFromName('3 words') === 'f3_words' && fieldKeyFromName('x'.repeat(50)).length === 30);
chk('tokens: a Yes/No field inserts the conditional', fieldToken('research', FIELDS[2]) === '{{#if ai.research.hiring_sales}}{{/if}}' && fieldToken('research', FIELDS[1]) === '{{ai.research.pain}}');
chk('summary matches the database line', fieldsSummary(FIELDS, { icp_fit: 'high', pain: 'scaling outbound', hiring_sales: true, team_size: 1200 }) === 'ICP fit: high · Pain: scaling outbound · Hiring sales: Yes · Team size: 1200' && fieldsSummary(FIELDS, { hiring_sales: false, team_size: 0, pain: null }) === 'Hiring sales: No · Team size: 0' && fieldsSummary(FIELDS, null) === '');
const d = (over: Partial<FieldDraft>): FieldDraft => ({ ...newFieldDraft(), ...over });
chk('field list: a valid list has no problems', !hasFieldProblems(fieldListProblems([d({ key: 'icp_fit', name: 'ICP fit', type: 'choice', options: 'high, medium , low' }), d({ key: 'pain', name: 'Pain', max_chars: '120' })])));
chk('field list: empty, nine, duplicate key, one option, bad key, bad limit', hasFieldProblems(fieldListProblems([])) && hasFieldProblems(fieldListProblems(Array.from({ length: 9 }, (_x, i) => d({ key: `f${i}`, name: `F${i}` }))))
  && !!fieldListProblems([d({ key: 'a1', name: 'A' }), d({ key: 'a1', name: 'B' })]).list[1].key && !!fieldListProblems([d({ key: 'fit', name: 'Fit', type: 'choice', options: 'only' })]).list[0].options
  && !!fieldListProblems([d({ key: 'Bad Key', name: 'Bad' })]).list[0].key && !!fieldListProblems([d({ key: 'x1', name: 'X', max_chars: '5' })]).list[0].max_chars
  && !!fieldListProblems([d({ key: 'fit', name: 'Fit', type: 'choice', options: 'a, A' })]).list[0].options);
chk('a saved field keeps only what its type uses', JSON.stringify(fieldOf(d({ key: 'fit', name: ' Fit ', type: 'choice', options: 'a, b', max_chars: '300', description: ' d ' }))) === '{"key":"fit","name":"Fit","type":"choice","description":"d","options":["a","b"]}');
const edit = editOf(FIELDS, { icp_fit: 'high', pain: 'x', hiring_sales: false, team_size: 12 });
chk('edit: the inputs of a stored value', JSON.stringify(edit) === '{"icp_fit":"high","pain":"x","hiring_sales":"false","team_size":"12"}' && sameEdit(FIELDS, edit, { icp_fit: 'high', pain: 'x', hiring_sales: false, team_size: 12 }));
chk('edit: typed values go back typed, empty as null', JSON.stringify(editToData(FIELDS, { icp_fit: 'low', pain: '  ', hiring_sales: 'true', team_size: '1,200' })) === '{"icp_fit":"low","pain":null,"hiring_sales":true,"team_size":1200}');
chk('edit: problems', editProblems(FIELDS, { team_size: 'about 40' }).team_size === 'Enter a number' && !!editProblems(FIELDS, { pain: 'x'.repeat(241) }).pain && !!editProblems(FIELDS, { pain: 'see {{x}}' }).pain && !!editProblems(FIELDS, {})._ && Object.keys(editProblems(FIELDS, { icp_fit: 'High', pain: 'ok' })).length === 0);

// ---------------------------------------------------------------- the Insert Variables catalogue
const CTX: RenderContext = {
  lead: { id: 'l1', first_name: 'Priya', last_name: 'Sharma', full_name: 'Priya Sharma', title: 'Head of Growth', headline: 'Growth @ Acme', company: 'Acme Pvt Ltd', company_id: '9001', company_domain: 'acme-lead.com',
    location: 'Bengaluru, Karnataka, India', email_work: 'priya@acme.com', email_personal: 'p@gmail.com', phone: '+91 1', public_identifier: 'priya', provider_id: 'ACo1', tags: 'vip', work_email_domain: 'acme.com',
    custom: { work_phone: '+91 2', company_deal_size: '50k', segment: 'saas' } },
  sender: { first_name: 'Naman', last_name: 'Jain', full_name: 'Naman Jain', email: 'naman@growthx.ai', label: 'Naman from GrowthX', booking_link: 'https://cal.example/n', signature: 'Naman' },
  enrich: { about: 'About', sn_id: 'SN1', last_enrich_at: 'Oct 01, 2026', twitter_url: 'https://x.com/p', facebook_url: 'https://facebook.com/p', location_city: 'Bengaluru', location_region: 'Karnataka', location_country: 'India',
    location_timezone: 'Asia/Kolkata', language: 'en', connections_count: 500, follower_count: 1200, skills: 'Growth, SEO', top_skill: 'Growth', current_company: 'Acme', current_title: 'VP Growth', current_started_on: 'Mar 2022',
    current_duration: '2 yrs 3 mos', previous_company: 'Swiggy', previous_title: 'Growth Manager', experience_summary: 'VP Growth at Acme (2022–present)', school: 'IIM', degree: 'MBA', education_field: 'Marketing',
    education_summary: 'MBA, Marketing — IIM', recent_post: 'A post', recent_post_date: 'Sep 20', last_3_posts: 'A post', years_in_role: 2, months_in_role: 27, phone: '+91 3' },
  ai: { contact_first_name: 'Priya', company_conversation: 'Acme', position_conversational: 'VP of Growth', opener: 'Loved your post.', research: { icp_fit: 'high', pain: 'scaling', hiring_sales: true, team_size: 40 } },
  account: { id: 'c1', name: 'Acme Technologies', domain: 'acme.com', website: 'https://acme.com', linkedin_url: 'https://www.linkedin.com/company/acme', linkedin_id: '1441', phone: '+91 80', industry: 'Software', size: '51-200',
    founded_year: 2015, tagline: 'Tag', about: 'About co', specialties: ['Outbound'], hashtags: ['#x'], followers: 100, employees_on_linkedin: 140, hq: { city: 'Bengaluru', region: 'Karnataka', country: 'India', address: '12 MG Road' } },
  now: { day: '1', month: 'October', weekday: 'Thursday', year: '2026', time_of_day: 'morning' },
  unsubscribe_link: 'https://example.com/u', booking_link: 'https://cal.example/n', seed: null,
};
const rows = [...VARIABLE_CATALOG, ...workspaceRows([{ key: 'research', name: 'Research', output: 'fields', fields: FIELDS }, { key: 'opener', name: 'Opener', output: 'text', fallback: 'Hello' }, { key: 'contact_first_name', name: 'x', builtin: true }], ['segment'])];
const empties = rows.filter((v) => v.insert !== 'if').filter((v) => exampleFor(v, CTX) === '');
chk('every listed variable renders a value for a full context', empties.length === 0, empties.map((v) => v.token));
chk('conditionals describe themselves instead of rendering', rows.filter((v) => v.insert === 'if').every((v) => exampleFor(v, CTX) === null && !!v.describe && !!v.open && v.token.startsWith(v.open)));
chk('every plain name in the catalogue is an alias or a path the renderer knows', VARIABLE_CATALOG.filter((v) => v.insert === 'token').every((v) => {
  const name = /^\{\{\s*([a-zA-Z0-9_.]+)/.exec(v.token)?.[1] ?? '';
  return name in VARIABLE_ALIASES || TEMPLATE_VARIABLES.includes(name) || /^(enrich|custom)\./.test(name) || ['full_name', 'first_name', 'last_name', 'headline', 'tags', 'work_email_domain', 'unsubscribe_link'].includes(name);
}));
chk('every alias is offered by the popup', Object.keys(VARIABLE_ALIASES).every((a) => VARIABLE_CATALOG.some((v) => new RegExp(`\\{\\{\\s*${a}\\s*[|}]`).test(v.token))), Object.keys(VARIABLE_ALIASES).filter((a) => !VARIABLE_CATALOG.some((v) => new RegExp(`\\{\\{\\s*${a}\\s*[|}]`).test(v.token))));
chk('five tabs, each with rows', VARIABLE_TABS.length === 5 && VARIABLE_TABS.every((t) => rows.some((v) => v.tab === t.id)));
chk('workspace rows: a field per row, Yes/No as a conditional, the fallback in a one-line token, built-ins not repeated',
  rows.some((v) => v.token === '{{ ai.research.pain }}') && rows.some((v) => v.token === '{{#if ai.research.hiring_sales}}{{/if}}' && v.insert === 'if')
  && rows.some((v) => v.token === '{{ ai.opener | Hello }}') && rows.filter((v) => v.token.includes('contact_first_name')).length === 1 && rows.some((v) => v.token === '{{ custom.segment }}' && v.section === 'Custom fields'));
chk('the example of a token with a fallback is the value, not the fallback', exampleFor(rows.find((v) => v.token === '{{ ai.opener | Hello }}')!, CTX) === 'Loved your post.' && exampleFor(rows.find((v) => v.token === '{{ ai.opener | Hello }}')!, { ...CTX, ai: {} }) === '');
chk('search matches the name across tabs', rows.filter((v) => matchesSearch(v, 'EMAIL')).map((v) => v.tab).filter((t, i, a) => a.indexOf(t) === i).sort().join() === 'contact,sender' && rows.filter((v) => matchesSearch(v, 'zzz')).length === 0);
chk('email-only rows are hidden on other channels; conditionals and spintax in plain fields', !visibleRows(rows, { channel: 'linkedin', plain: false }).some((v) => v.emailOnly) && visibleRows(rows, { channel: 'email', plain: false }).some((v) => v.token === '{{ unsubscribe_link }}')
  && !visibleRows(rows, { channel: 'email', plain: true }).some((v) => v.insert === 'if' || v.insert === 'spintax'));
chk('a conditional row renders as written', renderTemplate('{% if first_name %}Hi {{ first_name }}{% else %}Hi{% endif %}', CTX) === 'Hi Priya' && renderTemplate('{{ position | capitalize_each_word | plural }}', CTX) === 'Heads Of Growth');

if (failed) { console.error(`${failed} check(s) failed (lib/outreach/aiFields.test.ts)`); process.exit(1); }
console.log('ok: AI fields and Insert Variables checks pass (lib/outreach/aiFields.test.ts)');
