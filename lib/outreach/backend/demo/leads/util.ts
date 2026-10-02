/**
 * Leads area helpers: what the database does for leads by default, by trigger and by cascade (migrations/outreach 001,
 * 011 trg_lead_dnc, 014 profile search columns, 025/026 identities, normalize_email_columns.sql).
 */
import { engineFor, LIVE } from '../sim/engine';
import type { DemoStore, Row } from '../store';

/** Same rule as normalizePublicIdentifier (components/outreach/leads/helpers.ts) and csvPublicIdentifier (workers.ts). */
export function normalizePublicIdentifier(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  let id = /linkedin\.com\/(?:mwlite\/)?in\/([^/?#\s]+)/i.exec(s)?.[1] ?? null;
  if (!id) {
    if (/^https?:\/\//i.test(s) || /linkedin\.com/i.test(s)) return null;
    id = s.replace(/^@/, '').replace(/^\/?in\//i, '').replace(/[/?#].*$/, '');
    if (!id || /[\s@.]/.test(id)) return null;
  }
  try { id = decodeURIComponent(id); } catch { /* keep as written */ }
  return id.toLowerCase() || null;
}

export const linkedInProfileUrl = (id: string) => `https://www.linkedin.com/in/${id}`;

/** outreach_normalize_phone: E.164 with a country code, or null. */
export function normalizePhone(raw: unknown): string | null {
  const d = String(raw ?? '').replace(/[\s().-]/g, '');
  if (/^\+[0-9]{8,15}$/.test(d)) return d;
  if (/^00[0-9]{8,15}$/.test(d)) return `+${d.slice(2)}`;
  return null;
}

/** outreach_normalize_handle: lower case, no @, no instagram.com/ prefix. */
export function normalizeHandle(raw: unknown): string | null {
  const h = String(raw ?? '').trim().toLowerCase().replace(/^(https?:\/\/)?(www\.)?instagram\.com\//, '').replace(/[/?#].*$/, '').replace(/^@/, '');
  return /^[a-z0-9._]{1,30}$/.test(h) ? h : null;
}

/** outreach__identity_normalize */
export function identityNormalize(provider: string, raw: unknown): string | null {
  if (provider === 'WHATSAPP') return normalizePhone(raw);
  if (provider === 'INSTAGRAM') return normalizeHandle(raw);
  if (provider === 'LINKEDIN') {
    const s = String(raw ?? '').trim().toLowerCase().replace(/^.*linkedin\.com\/in\//, '').replace(/[/?#].*$/, '');
    return s || null;
  }
  const s = String(raw ?? '').trim().toLowerCase();
  return s || null;
}

/** Every saved email is lower-cased and trimmed (trigger a0_normalize_emails). */
export const normEmail = (v: unknown): string | null => {
  const s = String(v ?? '').trim().toLowerCase();
  return s || null;
};

const str = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
};

/** The column defaults of outreach_leads plus the derived full name, for a row about to be inserted. */
export function leadDefaults(row: Row, ws: string): Row {
  const first = str(row.first_name);
  const last = str(row.last_name);
  const pub = row.public_identifier != null ? normalizePublicIdentifier(row.public_identifier) ?? String(row.public_identifier).toLowerCase() : null;
  return {
    workspace_id: ws, client_id: null, provider_id: null, headline: null, company: null, company_id: null,
    company_domain: null, title: null, location: null, picture_url: null, is_open_profile: null, list_id: null, stage_id: null, source: null,
    import_job_id: null, last_profile_fetch_at: null, last_replied_at: null, last_replied_channel: null, phone: null, enriched_at: null,
    email_status: null, unsubscribed: false,
    ...row,
    public_identifier: pub,
    profile_url: str(row.profile_url) ?? (pub ? linkedInProfileUrl(pub) : null),
    first_name: first,
    last_name: last,
    full_name: str(row.full_name) ?? ([first, last].filter(Boolean).join(' ') || null),
    email_work: normEmail(row.email_work),
    email_personal: normEmail(row.email_personal),
    custom: row.custom && typeof row.custom === 'object' && !Array.isArray(row.custom) ? row.custom : {},
    do_not_contact: !!row.do_not_contact,
    enrich_status: row.enrich_status ?? 'none',
  };
}

/** Tables that point at a lead, and what a lead delete does to them (the foreign keys' on delete rules). */
const CASCADE = [
  'outreach_lead_tags', 'outreach_lead_sender_state', 'outreach_enrollments', 'outreach_actions', 'outreach_tasks', 'outreach_lead_milestones',
  'outreach_lead_profiles', 'outreach_enrich_queue', 'outreach_ai_values', 'outreach_ai_route_decisions', 'outreach_crm_links', 'outreach_lead_identities',
  'outreach_lead_consent', 'outreach_lead_ai_notes', 'outreach_ai_lead_notes_queue',
];
const SET_NULL = ['outreach_chats', 'outreach_booking_events', 'outreach_ai_reply_runs', 'outreach_chat_notes', 'outreach_webchat_visitors'];

/** Deletes leads the way Postgres does: dependent rows go, conversations stay without their lead. Returns the number deleted. */
export function deleteLeads(store: DemoStore, ids: Set<string>): number {
  const removed = store.remove('outreach_leads', (r) => ids.has(r.id));
  if (!removed.length) return 0;
  cascadeLeadDelete(store, new Set(removed.map((r) => r.id)));
  return removed.length;
}

/** What the foreign keys do once leads are gone. */
export function cascadeLeadDelete(store: DemoStore, gone: Set<string>): void {
  for (const t of CASCADE) if (store.has(t)) store.remove(t, (r) => gone.has(r.lead_id), { silent: t !== 'outreach_enrollments' && t !== 'outreach_tasks' });
  for (const t of SET_NULL) if (store.has(t)) store.update(t, (r) => gone.has(r.lead_id), { lead_id: null });
  const pending = store.meta<Row[]>('leads:enrichPending', () => []);
  if (pending.length) store.setMeta('leads:enrichPending', pending.filter((p) => !gone.has(p.lead_id)));
  engineFor(store).resetIndexes();
}

const MILESTONE_KINDS = new Set(['interested', 'meeting', 'won', 'lost']);

/**
 * outreach_trg_lead_dnc after an update: a lead marked do-not-contact (or unsubscribed) leaves every live enrollment and its
 * queued actions are cancelled; a stage of kind interested / meeting / won / lost records a milestone (once per kind).
 * Idempotent, so it can run on every write without knowing the old values.
 */
export function leadTriggers(store: DemoStore, leads: Row[], now = Date.now()): void {
  const engine = engineFor(store);
  for (const l of leads) {
    // emails are stored lower-cased (a0_normalize_emails)
    for (const k of ['email_work', 'email_personal'] as const) if (typeof l[k] === 'string' && l[k] !== l[k].trim().toLowerCase()) l[k] = normEmail(l[k]);
    if (l.do_not_contact || l.unsubscribed) {
      const reason = l.do_not_contact ? 'do_not_contact' : 'unsubscribed';
      const live = store.t('outreach_enrollments').filter((e) => e.lead_id === l.id && LIVE.includes(e.status));
      for (const e of live) engine.exit(e, 'exited_suppressed', reason, now);
      for (const a of store.t('outreach_actions')) {
        if (a.lead_id === l.id && (a.status === 'queued' || a.status === 'reserved') && a.action_type !== 'reply') { a.status = 'cancelled'; a.decision = 'suppressed'; }
      }
    }
    if (l.stage_id) {
      const stage = store.get('outreach_stages', l.stage_id);
      const kind = stage?.kind;
      if (kind && MILESTONE_KINDS.has(kind) && !store.t('outreach_lead_milestones').some((m) => m.lead_id === l.id && m.kind === kind)) {
        const e = store.t('outreach_enrollments').filter((x) => x.lead_id === l.id).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
        const seq = e ? store.get('outreach_sequences', e.sequence_id) : undefined;
        const value = kind === 'won' ? (Number(l.custom?.deal_value) || stage.deal_value || null) : null;
        store.insert('outreach_lead_milestones', {
          workspace_id: l.workspace_id, lead_id: l.id, kind, at: new Date(now).toISOString(), client_id: seq?.client_id ?? l.client_id ?? null, sequence_id: e?.sequence_id ?? null,
          sender_id: e?.sender_id ?? null, enrollment_id: e?.id ?? null, source: 'stage', value, currency: kind === 'won' ? (l.custom?.deal_currency ?? null) : null,
        });
      }
    }
  }
}

/** companies_text / skills_text: the lower-cased search columns a trigger keeps on outreach_lead_profiles (014). */
export function profileSearchText(p: Row): void {
  const companies = (Array.isArray(p.experience) ? p.experience : []).map((x: Row) => x?.company).filter((x: unknown) => typeof x === 'string' && x);
  p.companies_text = companies.length ? companies.join(' | ').toLowerCase() : null;
  p.skills_text = Array.isArray(p.skills) && p.skills.length ? p.skills.join(' | ').toLowerCase() : null;
}

/** Rows of a table, without creating it when it does not exist yet. */
export function rowsOf(store: DemoStore, table: string): Row[] {
  return store.has(table) ? store.t(table) : [];
}

/** `outreach_audit`: one row in outreach_audit_log (bigserial id, like the settings area's rows). */
export function audit(store: DemoStore, ws: string, actor: string | null, action: string, entity: string | null, entityId: string | null, diff: unknown = null): void {
  let max = 0;
  for (const r of store.t('outreach_audit_log')) if (typeof r.id === 'number' && r.id > max) max = r.id;
  store.insert('outreach_audit_log', { id: max + 1, workspace_id: ws, actor, actor_type: actor ? 'user' : 'system', action, entity, entity_id: entityId, diff, at: store.nowIso() });
}

export function initcap(s: string): string {
  return s.toLowerCase().replace(/(^|[^a-z0-9])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
}
