/** Demo seed: import jobs and schedules, channel consent, a few LinkedIn conversations without a lead (for the conversations import). */
import { profileSearchText } from '../leads/util';
import { engineFor } from '../sim/engine';
import type { DemoStore, Row } from '../store';
import { CLIENT, DEMO_WS_ID, LIST, MEMBER, SENDER, leadId } from './ids';

const D = 86_400_000;
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

const job = (o: Row): Row => ({
  workspace_id: DEMO_WS_ID, client_id: null, sender_id: null, params: {}, status: 'done', total_expected: null, fetched: 0, created_leads: 0, updated_leads: 0,
  next_offset: 0, cursor: null, next_run_at: null, capped: false, error: null, list_id: null, tag_ids: [], created_by: MEMBER.maya, finished_at: null,
  mode: 'upsert', update_fields: [], enrich: false, schedule_id: null, ...o,
});

/** Links leads [from, to) to a job: their source is the job's kind, and they were created while it ran. */
function link(s: DemoStore, from: number, to: number, jobRow: Row, startMs: number, spanMs: number) {
  const n = to - from;
  for (let i = from; i < to; i++) {
    const l = s.get('outreach_leads', leadId(i));
    if (!l) continue;
    const at = iso(startMs + Math.floor(((i - from) / Math.max(1, n)) * spanMs) + 1000);
    l.import_job_id = jobRow.id;
    l.source = jobRow.kind;
    l.created_at = at;
    if (Date.parse(l.updated_at) < Date.parse(at)) l.updated_at = at;
  }
}

export function seedLeads(s: DemoStore, now: number): void {
  // the profile search columns a trigger keeps (companies_text / skills_text), so the past-company and skill filters work
  for (const p of s.t('outreach_lead_profiles')) profileSearchText(p);

  // --- import jobs ----------------------------------------------------------
  const searchAt = now - 58 * D;
  const schedId = s.uid();
  const search = s.insert('outreach_import_jobs', job({
    kind: 'search_url', sender_id: SENDER.li_maya, list_id: LIST.founders, schedule_id: schedId, enrich: true,
    params: { url: 'https://www.linkedin.com/search/results/people/?keywords=founder%20saas&origin=GLOBAL_SEARCH_HEADER', api: 'classic', category: 'people', max_results: 160, repeat_run: 1 },
    total_expected: 160, fetched: 160, created_leads: 150, updated_leads: 10, next_offset: 160, created_at: iso(searchAt), finished_at: iso(searchAt + 30 * H),
  }))[0];
  link(s, 0, 150, search, searchAt + H, 28 * H);

  const csvAt = now - 47 * D;
  const csv = s.insert('outreach_import_jobs', job({
    kind: 'csv', list_id: LIST.agencies, params: { storage_path: `${DEMO_WS_ID}/${csvAt}-agency-owners-2026.csv`, mapping: { 'LinkedIn URL': 'linkedin_url', 'First name': 'first_name', 'Last name': 'last_name', Company: 'company', Title: 'title', 'Work email': 'email_work', Website: 'custom.website' }, _state: { merged_rows: 2, skipped_rows: 1 } },
    total_expected: 124, fetched: 124, created_leads: 120, updated_leads: 1, next_offset: 124, created_at: iso(csvAt), finished_at: iso(csvAt + 40_000),
  }))[0];
  link(s, 160, 280, csv, csvAt + 5000, 30_000);

  const snAt = now - 41 * D;
  const sn = s.insert('outreach_import_jobs', job({
    kind: 'sn_lead_list', sender_id: SENDER.li_sam, client_id: CLIENT.orchard, list_id: LIST.dental,
    params: { lead_list_id: '6904417703', api: 'sales_navigator', name: 'Dental practice owners · Midwest', max_results: 2500 },
    total_expected: 64, fetched: 64, created_leads: 60, updated_leads: 4, next_offset: 64, created_at: iso(snAt), finished_at: iso(snAt + 9 * H),
  }))[0];
  link(s, 280, 340, sn, snAt + H, 8 * H);

  const convAt = now - 62 * D;
  const conv = s.insert('outreach_import_jobs', job({
    kind: 'conversations', sender_id: SENDER.li_maya, list_id: LIST.founders, params: { only_replied: false, max_results: 2000 },
    total_expected: 10, fetched: 10, created_leads: 10, updated_leads: 0, created_at: iso(convAt), finished_at: iso(convAt + 2 * 60_000),
  }))[0];
  link(s, 150, 160, conv, convAt + 30_000, 60_000);

  // the latest weekly run of the repeating search: nobody new, the people it found were already leads
  const rerunAt = now - 2 * D - 5 * H;
  const rerun = s.insert('outreach_import_jobs', job({
    kind: 'search_url', sender_id: SENDER.li_maya, list_id: LIST.founders, schedule_id: schedId, enrich: true,
    params: { ...search.params, repeat_run: 9 }, total_expected: 160, fetched: 160, created_leads: 0, updated_leads: 160, next_offset: 160,
    created_at: iso(rerunAt), finished_at: iso(rerunAt + 26 * H),
  }))[0];

  s.insert('outreach_import_schedules', {
    id: schedId, workspace_id: DEMO_WS_ID, client_id: null, sender_id: SENDER.li_maya, name: 'SaaS founders search (weekly)', kind: 'search_url',
    params: { url: search.params.url, api: 'classic', category: 'people', max_results: 160 }, list_id: LIST.founders, tag_ids: [], enrich: true, cadence: 'weekly',
    active: true, next_run_at: iso(rerunAt + 7 * D), last_job_id: rerun.id, last_run_at: rerun.created_at, runs: 9, created_by: MEMBER.maya, created_at: iso(searchAt),
  });

  // --- WhatsApp consent for leads that have a WhatsApp number ------------------
  const waLeads = s.t('outreach_lead_identities').filter((i) => i.provider === 'WHATSAPP').map((i) => i.lead_id);
  const bases: Array<[string, Row, number]> = [
    ['inbound', { chat_id: null, note: 'Wrote to the Northwind WhatsApp number first' }, 34],
    ['form_optin', { url: 'https://example.com/forms/webinar-signup', note: 'Ticked "Message me on WhatsApp" on the sign-up form' }, 28],
    ['existing_customer', { note: 'Customer since the spring pilot (order 1042)' }, 90],
    ['linkedin_reply', { note: 'Shared the number in a LinkedIn reply to Maya' }, 12],
    ['explicit_share', { note: 'Gave the number on a call' }, 7],
    ['imported_attested', { imported_from: 'agency-owners-2026.csv', note: 'List collected at our booth with consent' }, 45],
  ];
  const picked = waLeads.filter((id) => id !== leadId(0)).slice(0, bases.length);
  picked.forEach((lid, k) => {
    const [basis, evidence, daysAgo] = bases[k];
    s.insert('outreach_lead_consent', {
      workspace_id: DEMO_WS_ID, lead_id: lid, channel: 'WHATSAPP', basis, evidence, attested_by: basis === 'inbound' ? null : MEMBER.maya,
      obtained_at: iso(now - daysAgo * D), expires_at: basis === 'form_optin' ? iso(now + 330 * D) : null, revoked_at: null, revoked_reason: null, created_at: iso(now - daysAgo * D),
    });
  });
  // one revoked basis, so the lead page shows a history
  const hist = waLeads.find((id) => !picked.includes(id) && id !== leadId(0));
  if (hist) s.insert('outreach_lead_consent', {
    workspace_id: DEMO_WS_ID, lead_id: hist, channel: 'WHATSAPP', basis: 'imported_attested', evidence: { imported_from: 'agency-owners-2026.csv' }, attested_by: MEMBER.sam,
    obtained_at: iso(now - 40 * D), expires_at: null, revoked_at: iso(now - 9 * D), revoked_reason: 'They asked not to be messaged on WhatsApp', created_at: iso(now - 40 * D),
  });

  // --- LinkedIn conversations that have no lead yet (Leads › Import › Conversations) --------------
  const engine = engineFor(s);
  const people: Array<[string, string, string, string[]]> = [
    [SENDER.li_maya, 'Rosalind Fenwick', 'demo-rosalind-fenwick-x1', ['in:Hi Maya, saw your post about outbound for agencies. Do you work with teams outside the US?', 'out:Hi Rosalind, we do, about a third of our clients are in Europe. Happy to share how it works.']],
    [SENDER.li_maya, 'Teodor Brask', 'demo-teodor-brask-x2', ['out:Thanks for connecting, Teodor. Great to meet you at the partner summit.', 'in:Likewise! Let us catch up after the holidays.']],
    [SENDER.li_sam, 'Imogen Sutherby', 'demo-imogen-sutherby-x3', ['in:Sam, a colleague recommended you. Are you taking on new clients this quarter?']],
    [SENDER.li_sam, 'Callum Ashgrove', 'demo-callum-ashgrove-x4', ['out:Hi Callum, thanks for accepting. How is the new role going?']],
    [SENDER.li_maya, 'Wren Halvorsen', 'demo-wren-halvorsen-x5', ['in:Hello! Is the webinar recording available somewhere?', 'out:Hi Wren, yes, I will send you the link this afternoon.', 'in:Perfect, thank you.']],
  ];
  people.forEach(([senderId, name, pub, msgs], k) => {
    const start = now - (20 - k * 3) * D;
    const chat = s.insert('outreach_chats', {
      workspace_id: DEMO_WS_ID, client_id: null, sender_id: senderId, lead_id: null, unipile_chat_id: `demo-chat-nolead-${k + 1}`, provider: 'LINKEDIN',
      attendee_provider_id: `demo-li-nolead-${k + 1}`, attendee_public_identifier: pub, attendee_name: name, attendee_picture_url: null, subject: null,
      last_message_at: null, last_message_preview: null, last_direction: null, unread: false, unread_count: 0, assigned_to: null, intent: 'unclassified', archived: false,
      is_request: false, last_note_at: null, status: 'open', labels: [], custom_attributes: {}, autopilot_state: 'active', conversation_stage: null, conversation_exchanges: 0,
      ai_replies_count: 0, ai_run_id: null, ai_run_status: null, ai_run_decision: null, reply_sequence_id: null, ai_handed_off_at: null, created_at: iso(start),
    })[0];
    msgs.forEach((m, j) => {
      const [dir, ...rest] = m.split(':');
      const out = dir === 'out';
      engine.appendMessage(chat, { direction: out ? 'out' : 'in', text: rest.join(':'), at: start + j * 5 * H, origin: out ? 'manual' : 'prospect', sent_by: out ? (senderId === SENDER.li_sam ? MEMBER.sam : MEMBER.maya) : null });
    });
    // older threads were read
    if (k < 3) s.update('outreach_chats', chat.id, { unread: false, unread_count: 0 }, { silent: true });
  });
}
