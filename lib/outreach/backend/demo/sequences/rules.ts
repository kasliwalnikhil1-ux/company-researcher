/**
 * Auto-enrol rules (migrations/outreach/012 item 18): which leads a rule would pick up now, and one run of a rule
 * (the same plan as a manual enrolment, a daily cap, a log row).
 */
import { makeCtx } from '../ctx';
import { engineFor } from '../sim/engine';
import type { DemoStore, Row } from '../store';
import { D, enrollPlan, stepNow } from './core';

const ilike = (v: unknown, needle: unknown) => String(v ?? '').toLowerCase().includes(String(needle ?? '').toLowerCase());

/** outreach__rule_candidates: never enrolled in the sequence before, not suppressed, list + filter match. */
export function ruleCandidates(store: DemoStore, r: Row, limit: number): string[] {
  const f: Row = r.filter ?? {};
  const enrolled = new Set(store.t('outreach_enrollments').filter((e) => e.sequence_id === r.sequence_id).map((e) => e.lead_id));
  const tagIds: string[] = Array.isArray(f.tag_ids) ? f.tag_ids : [];
  const tagged = tagIds.length ? new Set(store.t('outreach_lead_tags').filter((t) => tagIds.includes(t.tag_id)).map((t) => t.lead_id)) : null;
  const now = Date.now();
  return store.t('outreach_leads')
    .filter((l) => {
      if (l.workspace_id !== r.workspace_id || l.do_not_contact || l.unsubscribed || enrolled.has(l.id)) return false;
      if (r.list_id && l.list_id !== r.list_id) return false;
      if (f.client_id && l.client_id !== f.client_id) return false;
      if (f.stage_id && l.stage_id !== f.stage_id) return false;
      if (f.source && l.source !== f.source) return false;
      if (f.title_contains && !ilike(l.title, f.title_contains) && !ilike(l.headline, f.title_contains)) return false;
      if (f.company_contains && !ilike(l.company, f.company_contains)) return false;
      if (f.location_contains && !ilike(l.location, f.location_contains)) return false;
      if (tagged && !tagged.has(l.id)) return false;
      if (f.min_followers != null || f.posted_within_days != null) {
        const pr = store.get('outreach_lead_profiles', l.id, 'lead_id');
        if (f.min_followers != null && !(Number(pr?.follower_count ?? -1) >= Number(f.min_followers))) return false;
        if (f.posted_within_days != null && !(pr?.last_posted_at && Date.parse(pr.last_posted_at) > now - Number(f.posted_within_days) * D)) return false;
      }
      return true;
    })
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .slice(0, limit)
    .map((l) => l.id);
}

/** One pass of a rule (outreach_run_auto_enroll for one rule): up to the room left under today's cap. */
/**
 * `day`: the day the daily cap counts against (the simulator passes its own simulated day). The log row keeps it in
 * `cap_day`; its `day` is the calendar date the UI shows.
 */
export function runRule(store: DemoStore, r: Row, userId: string | null, day?: string): { matched: number; enrolled: number } {
  const seq = store.get('outreach_sequences', r.sequence_id);
  if (!seq || seq.status !== 'active' || !r.active) return { matched: 0, enrolled: 0 };
  const today = day ?? new Date().toISOString().slice(0, 10);
  const used = store.t('outreach_auto_enroll_log').filter((l) => l.rule_id === r.id && (l.cap_day ?? l.day) === today).reduce((n, l) => n + (l.enrolled ?? 0), 0);
  const room = Number(r.daily_cap ?? 50) - used;
  store.update('outreach_auto_enroll_rules', r.id, { last_run_at: new Date().toISOString() });
  if (room <= 0) return { matched: 0, enrolled: 0 };
  const ids = ruleCandidates(store, r, room);
  if (!ids.length) return { matched: 0, enrolled: 0 };
  const ctx = makeCtx(store);
  let plan;
  try { plan = enrollPlan(ctx, seq, ids, null, false); } catch { return { matched: ids.length, enrolled: 0 }; }
  const eng = engineFor(store);
  const skipped = { active: 0, suppressed: 0, replied_recently: 0, other: 0 };
  const created: string[] = [];
  const now = Date.now();
  for (const p of plan) {
    if (!p.sender_id) {
      if (p.reason?.startsWith('suppressed:')) skipped.suppressed++;
      else if (p.reason === 'replied_recently') skipped.replied_recently++;
      else if (p.reason === 'already_enrolled') skipped.active++;
      else skipped.other++;
      continue;
    }
    const res = eng.enroll(seq.id, [p.lead_id], { senderId: p.sender_id, includeReplied: true, ruleId: r.id, now });
    if (res.enrollment_ids[0]) { created.push(res.enrollment_ids[0]); store.update('outreach_enrollments', res.enrollment_ids[0], { created_by: userId, paused_from: null }); }
    else skipped.active++;
  }
  store.insert('outreach_auto_enroll_log', { id: store.t('outreach_auto_enroll_log').reduce((m, l) => Math.max(m, Number(l.id) || 0), 0) + 1, rule_id: r.id, day: new Date(now).toISOString().slice(0, 10), cap_day: today, matched: ids.length, enrolled: created.length, skipped, at: new Date().toISOString() }, { noId: true });
  for (const id of created) stepNow(store, store.get('outreach_enrollments', id), now);
  return { matched: ids.length, enrolled: created.length };
}
