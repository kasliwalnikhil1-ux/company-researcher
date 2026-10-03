/**
 * outreach_upsert_lead in the demo (026): match on LinkedIn id, provider id, work email, personal email, then a channel
 * identity; merge into the match (only empty fields are filled) or insert a new lead; then upsert the identities.
 * Used by the CSV and LinkedIn-source imports (and usable by any handler that creates leads).
 */
import { demoError } from '../ctx';
import { faceFor } from '../seed/faces';
import type { DemoStore, Row } from '../store';
import { identityNormalize, leadDefaults, linkedInProfileUrl, normEmail, normalizeHandle, normalizePhone } from './util';

const nz = (v: unknown): string | null => (v == null || String(v).trim() === '' ? null : String(v).trim());
const PROVIDERS = new Set(['LINKEDIN', 'INSTAGRAM', 'WHATSAPP', 'GMAIL', 'OUTLOOK', 'IMAP']);

/** outreach__identity_upsert: normalise, refuse an identifier that belongs to another lead, insert or merge. */
export function upsertIdentity(store: DemoStore, ws: string, leadId: string, provider: string, identifier: unknown, source: string, verified: boolean, providerId: string | null = null): Row {
  const norm = identityNormalize(provider, identifier);
  if (!norm) {
    if (provider === 'WHATSAPP') demoError('E_PAYLOAD_INVALID', 'phone needs a country code, e.g. +91 98765 43210');
    if (provider === 'INSTAGRAM') demoError('E_PAYLOAD_INVALID', 'not an Instagram handle');
    demoError('E_PAYLOAD_INVALID', 'identifier is empty');
  }
  const existing = store.t('outreach_lead_identities').find((i) => i.workspace_id === ws && i.provider === provider && String(i.identifier).toLowerCase() === norm.toLowerCase());
  if (existing && existing.lead_id !== leadId) {
    const other = store.get('outreach_leads', existing.lead_id);
    const name = other?.full_name ?? other?.public_identifier ?? other?.email_work ?? 'another lead';
    demoError('E_IDENTITY_CONFLICT', `this ${provider === 'WHATSAPP' ? 'number' : provider === 'INSTAGRAM' ? 'handle' : 'identifier'} already belongs to ${name}`);
  }
  if (existing) {
    return store.update('outreach_lead_identities', existing.id, (r) => ({ provider_id: providerId ?? r.provider_id, verified: !!r.verified || verified, source: r.source ?? source }))[0];
  }
  return store.insert('outreach_lead_identities', {
    workspace_id: ws, lead_id: leadId, provider, identifier: norm, provider_id: providerId || null, verified, source: source || 'operator', is_valid: null, last_checked_at: null,
  })[0];
}

export interface UpsertResult { id: string; created: boolean }

export function upsertLead(store: DemoStore, ws: string, p: Row, source: string | null = null, importJob: string | null = null): UpsertResult {
  const pid = nz(p.public_identifier)?.toLowerCase() ?? null;
  const ew = normEmail(p.email_work);
  const ep = normEmail(p.email_personal);
  const idents: Row[] = Array.isArray(p.identities) ? [...p.identities] : [];
  if (nz(p.instagram_handle)) idents.push({ provider: 'INSTAGRAM', identifier: p.instagram_handle });
  if (nz(p.whatsapp_phone)) idents.push({ provider: 'WHATSAPP', identifier: p.whatsapp_phone });
  for (const it of idents) {
    const prov = String(it.provider ?? '').toUpperCase();
    if (!PROVIDERS.has(prov)) demoError('E_PAYLOAD_INVALID', `unknown identity provider ${it.provider}`);
    if (prov === 'WHATSAPP' && !normalizePhone(it.identifier)) demoError('E_PAYLOAD_INVALID', 'phone needs a country code, e.g. +91 98765 43210');
    if (prov === 'INSTAGRAM' && !normalizeHandle(it.identifier)) demoError('E_PAYLOAD_INVALID', 'not an Instagram handle');
  }
  const leads = store.t('outreach_leads').filter((l) => l.workspace_id === ws);
  let existing: Row | undefined;
  if (pid) existing = leads.find((l) => l.public_identifier && String(l.public_identifier).toLowerCase() === pid);
  if (!existing && nz(p.provider_id)) existing = leads.find((l) => l.provider_id === p.provider_id);
  if (!existing && ew) existing = leads.find((l) => l.email_work === ew);
  if (!existing && ep) existing = leads.find((l) => l.email_personal === ep);
  if (!existing) {
    for (const it of idents) {
      const prov = String(it.provider).toUpperCase();
      const norm = identityNormalize(prov, it.identifier);
      const hit = store.t('outreach_lead_identities').find((i) => i.workspace_id === ws && i.provider === prov && String(i.identifier).toLowerCase() === String(norm).toLowerCase());
      if (hit) { existing = store.get('outreach_leads', hit.lead_id); if (existing) break; }
    }
  }
  if (!existing && !pid && !ew && !ep && !nz(p.provider_id) && idents.length === 0) demoError('E_PAYLOAD_INVALID', 'lead needs public_identifier, email or a channel identity');

  let id: string; let created = false;
  if (existing) {
    const keep = (k: string) => nz(p[k]) ?? existing![k];
    store.update('outreach_leads', existing.id, (l) => ({
      public_identifier: l.public_identifier ?? pid,
      provider_id: nz(p.provider_id) ?? l.provider_id,
      profile_url: nz(p.profile_url) ?? l.profile_url ?? (l.public_identifier ?? pid ? linkedInProfileUrl(l.public_identifier ?? pid) : null),
      first_name: keep('first_name'), last_name: keep('last_name'), full_name: keep('full_name'), headline: keep('headline'), company: keep('company'),
      company_id: keep('company_id'), title: keep('title'), location: keep('location'), phone: keep('phone'), company_domain: cleanDomain(p.company_domain) ?? l.company_domain ?? null,
      picture_url: keep('picture_url'), email_work: l.email_work ?? ew, email_personal: l.email_personal ?? ep,
      is_open_profile: p.is_open_profile == null ? l.is_open_profile : !!p.is_open_profile,
      custom: { ...(l.custom ?? {}), ...(p.custom && typeof p.custom === 'object' ? p.custom : {}) },
      list_id: nz(p.list_id) ?? l.list_id, stage_id: nz(p.stage_id) ?? l.stage_id, client_id: l.client_id ?? nz(p.client_id),
    }));
    id = existing.id;
  } else {
    const row = store.insert('outreach_leads', leadDefaults({
      client_id: nz(p.client_id), public_identifier: pid, provider_id: nz(p.provider_id), profile_url: nz(p.profile_url),
      first_name: nz(p.first_name), last_name: nz(p.last_name), full_name: nz(p.full_name), headline: nz(p.headline), company: nz(p.company), company_id: nz(p.company_id),
      title: nz(p.title), location: nz(p.location), picture_url: nz(p.picture_url) ?? faceFor(nz(p.first_name) ?? String(p.full_name ?? '').split(' ')[0], String(pid ?? p.full_name ?? ew ?? '')), phone: nz(p.phone), company_domain: cleanDomain(p.company_domain),
      email_work: ew, email_personal: ep, is_open_profile: p.is_open_profile == null ? null : !!p.is_open_profile,
      custom: p.custom && typeof p.custom === 'object' ? { ...p.custom } : {}, list_id: nz(p.list_id), stage_id: nz(p.stage_id), source, import_job_id: importJob,
      last_profile_fetch_at: p.profile_fetched ? new Date().toISOString() : null,
    }, ws))[0];
    id = row.id; created = true;
  }
  for (const it of idents) {
    upsertIdentity(store, ws, id, String(it.provider).toUpperCase(), it.identifier, nz(it.source) ?? (importJob ? 'import' : source ?? 'operator'), it.verified == null ? true : !!it.verified, nz(it.provider_id));
  }
  return { id, created };
}

/** outreach_clean_domain: host only, lower case, no www. */
export function cleanDomain(v: unknown): string | null {
  const s = String(v ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '');
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s : null;
}
