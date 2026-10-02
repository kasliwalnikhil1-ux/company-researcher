/**
 * outreach-imports-create in the demo. Validates the body like the edge function, creates the import job, then does the
 * import worker's job at once in the browser:
 *   csv            the uploaded file is read from demo storage and parsed with papaparse; the mapping the UI sent is applied
 *                  exactly like runCsvImport (one LinkedIn field, identities, merged / skipped rows, update-only mode)
 *   conversations  LinkedIn conversations without a lead become leads and are linked to them
 *   LinkedIn kinds fictional people (seed/names.ts) arrive from the chosen sender's "search"
 * The job is stored `done` with real counts, so the jobs table, the leads table and the filters agree.
 */
import { capFor } from '../sim/caps';
import { engineFor } from '../sim/engine';
import { COMPANIES, FIRST_NAMES, LAST_NAMES, LOCATIONS, TITLES, slug } from '../seed/names';
import { readStored } from '../storage';
import type { Ctx } from '../ctx';
import { demoError } from '../ctx';
import type { DemoStore, Row } from '../store';
import { requestEnrichment } from './enrich';
import { cleanDomain, upsertLead } from './upsert';
import { normEmail, normalizePublicIdentifier, rowsOf } from './util';

// papaparse ships without type definitions in this repo; keep a minimal local contract (same as CsvImport.tsx).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Papa = require('papaparse') as { parse: (text: string, opts: { header: false; skipEmptyLines: boolean | 'greedy' }) => { data: string[][]; errors: Array<{ message: string; row?: number }> } };

type Kind = 'search_url' | 'csv' | 'relations' | 'post_engagement' | 'conversations' | 'sn_saved_search' | 'sn_lead_list' | 'company_people';
const KINDS: Kind[] = ['search_url', 'csv', 'relations', 'post_engagement', 'conversations', 'sn_saved_search', 'sn_lead_list', 'company_people'];
const LINKEDIN_KINDS: Kind[] = ['search_url', 'relations', 'post_engagement', 'sn_saved_search', 'sn_lead_list', 'company_people'];
const UPDATABLE = ['first_name', 'last_name', 'full_name', 'headline', 'company', 'title', 'location', 'email_work', 'email_personal', 'phone'];
const CSV_LINKEDIN_FIELDS = ['linkedin_url', 'public_identifier'];
const KEY_FIELDS = ['public_identifier', 'linkedin_url', 'email_work', 'email_personal', 'email'];
export const CSV_MAX_ROWS = 25_000;

/** Fictional saved searches and lead lists of a Sales Navigator seat (GET ?action=sn_options). */
const SN_SAVED = [{ id: '7012345601', title: 'Heads of Growth · Series A SaaS · North America', count: 840 }, { id: '7012345602', title: 'Agency founders · 10–50 staff', count: 1260 }, { id: '7012345603', title: 'RevOps leaders · Europe', count: 515 }];
const SN_LISTS = [{ id: '6904417701', title: 'Q4 target accounts · decision makers', count: 212 }, { id: '6904417702', title: 'Event attendees to follow up', count: 96 }];

function loadSender(store: DemoStore, ws: string, id: unknown): Row {
  const s = store.get('outreach_senders', String(id ?? ''));
  if (!s || s.deleted_at || s.workspace_id !== ws) demoError('E_NOT_FOUND', 'sender');
  if (s.provider !== 'LINKEDIN') demoError('E_PAYLOAD_INVALID', 'Imports need a LinkedIn sender.');
  return s;
}

export function snOptions(ctx: Ctx, query: URLSearchParams): Row {
  const s = loadSender(ctx.store, ctx.ws, query.get('sender_id'));
  if (!s.has_sales_nav) demoError('E_NO_SALES_NAV', `${s.display_name ?? 'This sender'} has no Sales Navigator seat. Pick a sender that has one, or use a normal search URL.`);
  if (s.status !== 'ok') demoError('E_SENDER_NOT_OK', 'Reconnect this sender first.');
  return { ok: true, cached: query.get('refresh') !== '1', fetched_at: new Date().toISOString(), saved_searches: SN_SAVED, lead_lists: SN_LISTS };
}

/** parseSearchUrl in _shared/outreach/workers.ts */
function searchMeta(url: string): { api: 'classic' | 'sales_navigator' | 'recruiter'; category: 'people' | 'companies'; cap: number } {
  const u = url.toLowerCase();
  const api = u.includes('/sales/') ? 'sales_navigator' : u.includes('/talent/') || u.includes('recruiter') ? 'recruiter' : 'classic';
  const category = u.includes('/company') || u.includes('companies') || u.includes('/search/results/companies') ? 'companies' : 'people';
  return { api, category, cap: api === 'classic' ? 1000 : category === 'companies' ? 1000 : 2500 };
}

/** postIdFromUrl in _shared/outreach/unipile_sources.ts */
function postIdFromUrl(input: string): string | null {
  let s = String(input ?? '').trim();
  if (!s) return null;
  try { s = decodeURIComponent(s); } catch { /* keep as is */ }
  const urn = /urn:li:(activity|ugcPost|share):(\d{6,})/i.exec(s);
  if (urn) return urn[2];
  const sl = /[-_](activity|ugcpost|share)[-_:](\d{6,})/i.exec(s);
  if (sl) return sl[2];
  return /^\d{6,}$/.test(s) ? s : null;
}
const companyIdent = (url: string) => /linkedin\.com\/(?:company|school|showcase)\/([^/?#]+)/i.exec(url)?.[1] ?? /linkedin\.com\/sales\/company\/(\d+)/i.exec(url)?.[1] ?? null;

export async function importsCreate(ctx: Ctx, body: Row): Promise<Row> {
  const store = ctx.store;
  if (!body.workspace_id || !body.kind) demoError('E_PAYLOAD_INVALID', 'workspace_id and kind required');
  if (body.workspace_id !== ctx.ws) demoError('E_FORBIDDEN');
  const kind = body.kind as Kind;
  if (!KINDS.includes(kind)) demoError('E_PAYLOAD_INVALID', `unknown import kind "${body.kind}"`);
  let params: Row = {};
  let total: number | null = null;
  let estimate: Row = {};
  let mode: 'upsert' | 'update_only' = 'upsert';
  let updateFields: string[] = [];
  const warnings: string[] = [];
  let sender: Row | null = null;

  if (LINKEDIN_KINDS.includes(kind)) {
    if (!body.sender_id) demoError('E_PAYLOAD_INVALID', 'sender_id required');
    sender = loadSender(store, ctx.ws, body.sender_id);
    if (sender.status !== 'ok') demoError('E_SENDER_NOT_OK', 'sender must be connected');
    const pagesPerDay = Math.max(1, capFor(store, sender, 'search_page'));
    if (kind === 'search_url') {
      const u = String(body.url ?? '').trim();
      if (!/^https:\/\/(www\.)?linkedin\.com\//i.test(u)) demoError('E_PAYLOAD_INVALID', 'paste a linkedin.com search URL');
      const meta = searchMeta(u);
      if (meta.category !== 'people') demoError('E_PAYLOAD_INVALID', 'only people searches can be imported as leads');
      const perPage = meta.api === 'classic' ? 10 : 50;
      const maxRows = Math.min(Number(body.max_results) || meta.cap, meta.cap);
      params = { url: u, api: meta.api, category: meta.category, max_results: maxRows };
      total = maxRows;
      estimate = { api: meta.api, cap: meta.cap, per_page: perPage, pages_per_day: pagesPerDay, estimated_days: Math.ceil(maxRows / (pagesPerDay * perPage)), sender: sender.display_name };
    } else if (kind === 'relations') {
      estimate = { note: '1 page (≤100 relations) per hour' };
    } else if (kind === 'post_engagement') {
      const postUrl = String(body.post_url ?? body.url ?? '').trim();
      if (!postIdFromUrl(postUrl)) demoError('E_PAYLOAD_INVALID', 'This does not look like a LinkedIn post URL. Open the post, choose "Copy link to post" and paste that link.');
      const asked = (Array.isArray(body.include) && body.include.length ? body.include : ['reactions', 'comments']).map((x: unknown) => String(x).toLowerCase());
      const include = asked.filter((x: string) => x === 'reactions' || x === 'comments');
      if (asked.includes('reposts')) warnings.push('LinkedIn does not share who reposted a post, so reposts are not imported. People who reacted or commented are.');
      if (!include.length) demoError('E_PAYLOAD_INVALID', 'Choose reactions or comments. LinkedIn does not share who reposted a post.');
      const maxRows = Math.min(Math.max(1, Number(body.max_results ?? 2000)), 5000);
      params = { post_url: postUrl, include, max_results: maxRows };
      estimate = { per_page: 100, pages_per_day: pagesPerDay, max_results: maxRows, estimated_days: Math.ceil((maxRows / 100 + 1) / pagesPerDay), sender: sender.display_name, note: "One page of up to 100 people every 20 to 90 minutes, inside the sender's working hours." };
    } else if (kind === 'sn_saved_search' || kind === 'sn_lead_list') {
      if (!sender.has_sales_nav) demoError('E_NO_SALES_NAV', `${sender.display_name ?? 'This sender'} has no Sales Navigator seat. Pick a sender that has one.`);
      const u = String(body.url ?? '');
      const fromUrl = kind === 'sn_saved_search' ? /savedSearchId=(\d+)/.exec(u)?.[1] : /\/sales\/lists\/people\/(\d+)/.exec(u)?.[1];
      const id = kind === 'sn_saved_search' ? (body.saved_search_id ?? fromUrl) : (body.lead_list_id ?? fromUrl);
      if (!id || !/^\d+$/.test(String(id))) demoError('E_PAYLOAD_INVALID', kind === 'sn_saved_search' ? 'Pick a saved search (or paste its Sales Navigator URL).' : 'Pick a lead list (or paste its Sales Navigator URL).');
      const maxRows = Math.min(Math.max(1, Number(body.max_results ?? 2500)), 2500);
      const known = [...SN_SAVED, ...SN_LISTS].find((x) => x.id === String(id));
      params = { ...(kind === 'sn_saved_search' ? { saved_search_id: String(id) } : { lead_list_id: String(id) }), api: 'sales_navigator', name: body.name ?? known?.title ?? null, max_results: maxRows };
      total = maxRows;
      estimate = { api: 'sales_navigator', cap: 2500, per_page: 50, pages_per_day: pagesPerDay, estimated_days: Math.ceil(maxRows / (pagesPerDay * 50)), sender: sender.display_name };
    } else if (kind === 'company_people') {
      const companies = (Array.isArray(body.companies) ? body.companies : []).map((c: Row) => ({ name: String(c?.name ?? '').trim() || undefined, linkedin_url: String(c?.linkedin_url ?? '').trim() || undefined, company_id: c?.company_id ? String(c.company_id).trim() : undefined }))
        .filter((c: Row) => c.name || c.linkedin_url || c.company_id);
      if (!companies.length) demoError('E_PAYLOAD_INVALID', 'Add at least one company (name, LinkedIn URL or company id).');
      if (companies.length > 100) demoError('E_TOO_MANY', 'At most 100 companies per import. Split the list.');
      const bad = companies.find((c: Row) => c.linkedin_url && !companyIdent(c.linkedin_url));
      if (bad) demoError('E_PAYLOAD_INVALID', `"${bad.linkedin_url}" is not a LinkedIn company URL.`);
      const titles = (Array.isArray(body.title_keywords) ? body.title_keywords : []).map((t: unknown) => String(t).trim()).filter(Boolean).slice(0, 10);
      if (!titles.length) demoError('E_PAYLOAD_INVALID', 'Add at least one job title keyword, for example "Head of Sales".');
      const perCompany = Math.max(1, Math.min(25, Number(body.per_company ?? 10)));
      params = { companies, title_keywords: titles, per_company: perCompany };
      total = companies.length * perCompany;
      const calls = companies.reduce((a: number, c: Row) => a + (c.company_id || /^\d+$/.test(companyIdent(c.linkedin_url ?? '') ?? '') ? 0 : 1) + Math.ceil(perCompany / 10), 0);
      estimate = { per_page: 10, pages_per_day: pagesPerDay, linkedin_calls: calls, estimated_days: Math.ceil(calls / pagesPerDay), sender: sender.display_name, slowest_source: true,
        note: "This is the slowest source: each company needs one lookup plus up to three search pages of 10, all from the sender's daily search allowance. Give company ids or URLs to skip the lookup." };
    }
  } else if (kind === 'csv') {
    if (!body.storage_path || !body.mapping) demoError('E_PAYLOAD_INVALID', 'storage_path and mapping required');
    if (!String(body.storage_path).startsWith(`${body.workspace_id}/`)) demoError('E_FORBIDDEN', 'bad storage path');
    const mapping: Record<string, string> = {};
    for (const [col, f] of Object.entries(body.mapping as Record<string, unknown>)) mapping[col] = CSV_LINKEDIN_FIELDS.includes(String(f)) ? 'linkedin_url' : String(f);
    const linkedinCols = Object.keys(mapping).filter((c) => mapping[c] === 'linkedin_url');
    if (linkedinCols.length > 1) demoError('E_PAYLOAD_INVALID', `Only one column can be the LinkedIn URL / identifier. ${linkedinCols.map((c) => `"${c}"`).join(' and ')} are both mapped to it: keep the one with each lead's own profile.`);
    const fields = new Set(Object.values(mapping));
    if (!fields.has('linkedin_url') && !fields.has('email_work') && !fields.has('email_personal')) demoError('E_PAYLOAD_INVALID', 'map a LinkedIn URL or an email column');
    if (Number(body.row_count ?? 0) > CSV_MAX_ROWS) demoError('E_TOO_MANY', `One CSV import takes up to ${CSV_MAX_ROWS.toLocaleString('en-US')} rows. Split the file and import the parts one after another.`);
    if (body.mode === 'update_only') {
      mode = 'update_only';
      updateFields = [...new Set((Array.isArray(body.update_fields) ? body.update_fields : []).map(String))];
      if (!updateFields.length) demoError('E_PAYLOAD_INVALID', 'Choose at least one column to update.');
      const unknown = updateFields.filter((f) => !UPDATABLE.includes(f) && !f.startsWith('custom.'));
      if (unknown.length) demoError('E_PAYLOAD_INVALID', `These fields cannot be updated from a CSV: ${unknown.join(', ')}`);
      const unmapped = updateFields.filter((f) => !fields.has(f));
      if (unmapped.length) demoError('E_PAYLOAD_INVALID', `No CSV column is mapped to: ${unmapped.join(', ')}`);
    }
    params = { storage_path: body.storage_path, mapping };
    total = body.row_count ?? null;
    estimate = { rows: total, ...(mode === 'update_only' ? { note: 'Update mode: rows are matched on LinkedIn URL or email. Only the chosen columns change, empty cells never blank a field, and no lead is created.' } : {}) };
  } else if (kind === 'conversations') {
    if (body.sender_id) sender = loadSender(store, ctx.ws, body.sender_id);
    const maxRows = Math.min(Math.max(1, Number(body.max_results ?? 2000)), 5000);
    params = { only_replied: !!body.only_replied, max_results: maxRows };
    const count = unlinkedChats(store, ctx.ws, sender?.id ?? null, false).length;
    total = Math.min(count, maxRows);
    estimate = { conversations_without_lead: count, note: 'No LinkedIn call is made: leads are created from conversations that are already synced.' };
  }

  if (body.dry_run) return { ok: true, estimate, params, warnings };

  const job = store.insert('outreach_import_jobs', {
    workspace_id: ctx.ws, client_id: body.client_id ?? null, sender_id: body.sender_id ?? null, kind, params, status: 'running', total_expected: total,
    fetched: 0, created_leads: 0, updated_leads: 0, next_offset: 0, cursor: null, next_run_at: new Date().toISOString(), capped: false, error: null,
    list_id: body.list_id ?? null, tag_ids: Array.isArray(body.tag_ids) ? body.tag_ids : [], created_by: ctx.userId, finished_at: null,
    mode, update_fields: updateFields, enrich: !!body.enrich, schedule_id: null,
  })[0];

  try {
    if (kind === 'csv') await runCsv(ctx, job);
    else if (kind === 'conversations') runConversations(ctx, job);
    else runLinkedIn(ctx, job, sender!);
  } catch (e) {
    const msg = e instanceof Error ? e.message.replace(/^E_[A-Z_]+:\s*/, '') : String(e);
    store.update('outreach_import_jobs', job.id, { status: 'failed', error: msg, next_run_at: null, finished_at: new Date().toISOString() });
  }
  return { ok: true, job: store.get('outreach_import_jobs', job.id), estimate, warnings };
}

// ---------------------------------------------------------------------------
function finish(ctx: Ctx, job: Row, patch: Row, leadIds: string[]) {
  const store = ctx.store;
  if (job.tag_ids?.length && leadIds.length) {
    const have = new Set(store.t('outreach_lead_tags').map((t) => `${t.lead_id}|${t.tag_id}`));
    const links: Row[] = [];
    for (const id of leadIds) for (const t of job.tag_ids) if (!have.has(`${id}|${t}`) && store.get('outreach_tags', t)) { links.push({ lead_id: id, tag_id: t }); have.add(`${id}|${t}`); }
    if (links.length) store.insert('outreach_lead_tags', links, { noId: true });
  }
  store.update('outreach_import_jobs', job.id, { status: 'done', finished_at: new Date().toISOString(), next_run_at: null, error: null, ...patch });
  if (job.enrich && leadIds.length) requestEnrichment(store, ctx.ws, leadIds, { reason: 'import' });
}

function cleanState(params: Row): Row { return { ...params, _state: { ...(params._state ?? {}) } }; }

/** The import worker's CSV pass (runCsvImport in _shared/outreach/workers.ts), all rows at once. */
async function runCsv(ctx: Ctx, job: Row) {
  const store = ctx.store;
  const path = String(job.params.storage_path ?? '');
  const blob = readStored('outreach-imports', path);
  if (!blob) throw new Error('The uploaded CSV file could not be read (file missing). Upload it again.');
  const text = (await blob.text()).replace(/^﻿/, '');
  const parsed = Papa.parse(text, { header: false, skipEmptyLines: 'greedy' });
  const rows = parsed.data.filter((r) => Array.isArray(r));
  const totalRows = Math.max(0, rows.length - 1);
  if (totalRows > CSV_MAX_ROWS) throw new Error(`This file has ${totalRows.toLocaleString('en-US')} rows. One import takes up to ${CSV_MAX_ROWS.toLocaleString('en-US')} rows: split the file and import the parts one after another.`);
  const mapping = (job.params.mapping ?? {}) as Record<string, string>;
  const header = rows[0] ?? [];
  const fieldIdx: Record<string, number> = {};
  header.forEach((h, i) => { const f = mapping[h] ?? mapping[String(h).trim()]; if (f) fieldIdx[f] = i; });
  if (!KEY_FIELDS.some((f) => f in fieldIdx)) throw new Error('None of the mapped columns exist in this file. Map the LinkedIn URL or the email column and start again.');
  const updateOnly = job.mode === 'update_only';
  const allowed: string[] = (job.update_fields ?? []).map(String);
  const fields = Object.entries(fieldIdx);
  const st: Row = {};
  const bump = (k: string) => { st[k] = Number(st[k] ?? 0) + 1; };

  const build = (r: string[]) => {
    const lead: Row = { client_id: job.client_id, list_id: job.list_id, custom: {} };
    const flat: Record<string, string> = {};
    for (const [field, idx] of fields) {
      const v = String(r[idx] ?? '').trim();
      if (!v) continue;
      if (field.startsWith('custom.')) { lead.custom[field.slice(7)] = v; flat[field] = v; }
      else if (CSV_LINKEDIN_FIELDS.includes(field)) { const id = normalizePublicIdentifier(v); if (id) { lead.public_identifier = id; lead.profile_url = `https://www.linkedin.com/in/${id}`; } }
      else if (field === 'instagram_handle') (lead.identities ??= []).push({ provider: 'INSTAGRAM', identifier: v, verified: true, source: 'import' });
      else if (field === 'whatsapp_phone') (lead.identities ??= []).push({ provider: 'WHATSAPP', identifier: v, verified: true, source: 'import' });
      else { lead[field] = v; flat[field] = v; }
    }
    if (lead.full_name && !lead.first_name && !lead.last_name) { const parts = String(lead.full_name).split(/\s+/); lead.first_name = parts[0]; lead.last_name = parts.slice(1).join(' ') || null; }
    if (lead.email && !lead.email_work) lead.email_work = lead.email;
    delete lead.email;
    return { lead, flat, email: normEmail(lead.email_work ?? lead.email_personal) };
  };
  const keysOf = (r: string[]) => {
    let pub: string | null = null; const emails: Row = {};
    for (const [f, idx] of fields) {
      if (!KEY_FIELDS.includes(f)) continue;
      const v = String(r[idx] ?? '').trim();
      if (!v) continue;
      if (CSV_LINKEDIN_FIELDS.includes(f)) pub = normalizePublicIdentifier(v) ?? pub; else emails[f] = v.toLowerCase();
    }
    const email = emails.email_work ?? emails.email_personal ?? emails.email ?? null;
    return [pub ? `p:${pub}` : '', email ? `e:${email}` : ''].filter(Boolean);
  };

  let fetched = 0, created = 0, updated = 0;
  const seen = new Set<string>();
  const touched: string[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r.length || r.every((c) => !c)) continue;
    fetched++;
    const ks = keysOf(r);
    if (!ks.length) { bump('skipped_rows'); continue; }
    const repeat = ks.some((k) => seen.has(k));
    for (const k of ks) seen.add(k);
    const b = build(r);
    try {
      if (updateOnly) {
        const lead = matchLead(store, ctx.ws, b.lead.public_identifier ?? null, b.email);
        if (!lead) { bump('not_found'); continue; }
        const patch: Row = {};
        for (const f of allowed) {
          const v = b.flat[f];
          if (v == null || v === '') continue;
          if (f.startsWith('custom.')) patch.custom = { ...(patch.custom ?? lead.custom ?? {}), [f.slice(7)]: v };
          else patch[f] = f.startsWith('email_') ? normEmail(v) : f === 'company_domain' ? cleanDomain(v) : v;
        }
        if (Object.keys(patch).length) store.update('outreach_leads', lead.id, patch);
        updated++; bump('updated');
        continue;
      }
      const res = upsertLead(store, ctx.ws, b.lead, 'csv', job.id);
      if (repeat) bump('merged_rows'); else if (res.created) created++; else updated++;
      touched.push(res.id);
    } catch (e) {
      bump('row_errors');
      st.first_row_error = st.first_row_error ?? String(e instanceof Error ? e.message : e).slice(0, 160);
    }
  }
  if (fetched > 0 && Number(st.row_errors ?? 0) >= fetched) throw new Error(`No row of this file could be imported. First error: ${st.first_row_error ?? 'unknown'}`);
  finish(ctx, job, { fetched, created_leads: created, updated_leads: updated, next_offset: totalRows, total_expected: totalRows, params: { ...cleanState(job.params), _state: st } }, updateOnly ? [] : [...new Set(touched)]);
}

function matchLead(store: DemoStore, ws: string, pub: string | null, email: string | null): Row | undefined {
  const leads = store.t('outreach_leads').filter((l) => l.workspace_id === ws);
  return (pub ? leads.find((l) => String(l.public_identifier ?? '').toLowerCase() === pub) : undefined)
    ?? (email ? leads.find((l) => l.email_work === email) ?? leads.find((l) => l.email_personal === email) : undefined);
}

// ---------------------------------------------------------------------------
export function unlinkedChats(store: DemoStore, ws: string, senderId: string | null, onlyReplied: boolean): Row[] {
  const inbound = onlyReplied ? new Set(rowsOf(store, 'outreach_messages').filter((m) => m.direction === 'in').map((m) => m.chat_id)) : null;
  return store.t('outreach_chats')
    .filter((c) => c.workspace_id === ws && !c.lead_id && c.provider === 'LINKEDIN' && (!senderId || c.sender_id === senderId) && (!inbound || inbound.has(c.id)))
    .sort((a, b) => String(b.last_message_at ?? '').localeCompare(String(a.last_message_at ?? '')));
}

/** import_conversations: one lead per LinkedIn conversation without a lead, and the conversation is linked to it. */
function runConversations(ctx: Ctx, job: Row) {
  const store = ctx.store;
  const chats = unlinkedChats(store, ctx.ws, job.sender_id, !!job.params.only_replied).slice(0, Number(job.params.max_results ?? 2000));
  let created = 0, updated = 0;
  const ids: string[] = [];
  for (const c of chats) {
    const name = String(c.attendee_name ?? '').trim();
    const [first, ...rest] = name.split(/\s+/);
    const res = upsertLead(store, ctx.ws, {
      public_identifier: c.attendee_public_identifier ?? null, provider_id: c.attendee_provider_id ?? null, full_name: name || null, first_name: first || null, last_name: rest.join(' ') || null,
      picture_url: c.attendee_picture_url ?? null, client_id: job.client_id ?? c.client_id ?? null, list_id: job.list_id,
    }, 'conversations', job.id);
    if (res.created) created++; else updated++;
    store.update('outreach_chats', c.id, { lead_id: res.id });
    const st = engineFor(store).state(res.id, c.sender_id);
    if (st.relation === 'none') store.update('outreach_lead_sender_state', (r) => r === st, { relation: 'first' }, { silent: true });
    ids.push(res.id);
  }
  finish(ctx, job, { fetched: chats.length, created_leads: created, updated_leads: updated, total_expected: chats.length }, ids);
}

// ---------------------------------------------------------------------------
/** Fictional people for the LinkedIn sources: invented names that are not leads yet, at invented companies. */
export function fictionalPeople(store: DemoStore, n: number, o: { companies?: string[]; titles?: string[] } = {}): Row[] {
  const used = new Set(store.t('outreach_leads').map((l) => String(l.full_name ?? '').toLowerCase()));
  const out: Row[] = [];
  for (let tries = 0; out.length < n && tries < n * 30; tries++) {
    const first = store.pick(FIRST_NAMES); const last = store.pick(LAST_NAMES);
    const full = `${first} ${last}`;
    if (used.has(full.toLowerCase())) continue;
    used.add(full.toLowerCase());
    const company = o.companies?.length ? o.companies[out.length % o.companies.length] : store.pick(COMPANIES);
    const kw = o.titles?.length ? o.titles[out.length % o.titles.length] : null;
    const title = kw ? kw.replace(/\b\w/g, (m) => m.toUpperCase()) : store.pick(TITLES);
    const id = `demo-${slug(full)}-${store.uid().slice(-4)}`;
    out.push({
      public_identifier: id, provider_id: `demo-li-${store.uid().slice(-8)}`, first_name: first, last_name: last, full_name: full, headline: `${title} at ${company}`,
      company, title, location: store.pick(LOCATIONS), is_open_profile: store.chance(0.1),
      email_work: store.chance(0.35) ? `${slug(first)}.${slug(last)}@example.com`.replace(/-/g, '') : null,
      custom: { website: `${slug(company)}.example.com` },
    });
  }
  return out;
}

function runLinkedIn(ctx: Ctx, job: Row, sender: Row) {
  const store = ctx.store;
  const p = job.params as Row;
  const asked = Number(p.max_results ?? 0) || 25;
  let people: Row[];
  if (job.kind === 'company_people') {
    const names = (p.companies as Row[]).map((c) => c.name ?? (/^\d+$/.test(companyIdent(String(c.linkedin_url ?? '')) ?? '') ? '' : (companyIdent(String(c.linkedin_url ?? '')) ?? '').replace(/-/g, ' ').replace(/\b\w/g, (m: string) => m.toUpperCase()))).filter(Boolean);
    const per = Math.min(Number(p.per_company ?? 3), 3);
    people = fictionalPeople(store, Math.max(1, names.length || 1) * per, { companies: names.length ? names : undefined, titles: p.title_keywords as string[] });
  } else {
    const n = job.kind === 'relations' ? 18 : job.kind === 'post_engagement' ? 14 : job.kind === 'search_url' ? 24 : 20;
    people = fictionalPeople(store, Math.min(asked, n));
  }
  let created = 0, updated = 0;
  const ids: string[] = [];
  for (const person of people) {
    const res = upsertLead(store, ctx.ws, { ...person, client_id: job.client_id, list_id: job.list_id, profile_fetched: true }, job.kind, job.id);
    if (res.created) created++; else updated++;
    if (job.kind === 'relations') {
      const st = engineFor(store).state(res.id, sender.id);
      store.update('outreach_lead_sender_state', (r) => r === st, { relation: 'first', invite_accepted_at: new Date(Date.now() - store.int(30, 400) * 86_400_000).toISOString() }, { silent: true });
    }
    ids.push(res.id);
  }
  const fetched = people.length;
  finish(ctx, job, { fetched, created_leads: created, updated_leads: updated, total_expected: job.kind === 'relations' || job.kind === 'post_engagement' ? fetched : Math.min(job.total_expected ?? fetched, fetched), next_offset: fetched, capped: false }, ids);
  ctx.ui.simulated(`Simulated. ${fetched} fictional people came back from ${sender.display_name ?? 'the demo account'}.`);
}
