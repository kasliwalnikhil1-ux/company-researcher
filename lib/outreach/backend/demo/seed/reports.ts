/**
 * Demo seed: saved ranges, report schedules, and the funnel milestones the history implies.
 *
 * Milestones (outreach_lead_milestones) are what the real database writes when a lead reaches Interested / Meeting
 * booked / Won. The history leaves a few leads at Interested; three of them went further (two meetings booked, one
 * won), so the dashboard, the funnel and the cost tab have meetings and a won deal to show.
 */
import type { DemoStore, Row } from '../store';
import { milestoneRow, syncMilestones, MILESTONES } from '../reports/facts';
import { localParts } from '../sim/caps';
import { DEMO_USER_ID, DEMO_WS_ID, MEMBER, STAGE } from './ids';

const H = 3_600_000;
const D = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

export function seedReports(s: DemoStore, now: number): void {
  // 1. milestones: Interested from the history's replies, then a few leads move on
  syncMilestones(s);
  const stages = new Map(s.t('outreach_stages').map((x) => [x.id, x]));
  const interested = s.t(MILESTONES).filter((m) => m.kind === 'interested' && Date.parse(m.at) < now - 2 * D).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const meetingStage = stages.get(STAGE.meeting);
  const wonStage = stages.get(STAGE.won);
  const move = (m: Row, stage: Row | undefined, at: number, also?: { stage: Row | undefined; at: number }) => {
    const lead = s.get('outreach_leads', m.lead_id);
    if (!lead || !stage) return;
    const rows: Row[] = [];
    if (also?.stage) rows.push(milestoneRow(s, lead, also.stage, iso(also.at), 'stage'));
    rows.push(milestoneRow(s, lead, stage, iso(at), 'stage'));
    s.insert(MILESTONES, rows, { silent: true });
    s.update('outreach_leads', lead.id, { stage_id: stage.id, updated_at: iso(at) }, { silent: true });
  };
  if (interested.length >= 3) {
    // the oldest interested lead booked a meeting and signed
    const w = interested[0];
    const wAt = Date.parse(w.at);
    const meetAt = Math.min(wAt + s.int(20, 60) * H, now - 3 * D);
    move(w, wonStage, Math.min(meetAt + s.int(5, 12) * D, now - D), { stage: meetingStage, at: meetAt });
    // the two most recent ones booked a meeting a day or two after answering
    for (const m of interested.slice(-2)) move(m, meetingStage, Math.min(Date.parse(m.at) + s.int(18, 48) * H, now - 2 * H));
  }

  // 2. saved ranges (own rows of the demo user)
  const today = localParts(now, 'America/New_York').day;
  const [y, mo] = today.split('-').map(Number);
  const q = Math.floor((mo - 1) / 3);                      // this quarter, 0-based
  const pq = q === 0 ? 3 : q - 1, py = q === 0 ? y - 1 : y;  // the previous quarter
  const qFrom = `${py}-${String(pq * 3 + 1).padStart(2, '0')}-01`;
  const qEndMonth = new Date(Date.UTC(py, pq * 3 + 3, 0));  // last day of the quarter's third month
  s.insert('outreach_saved_ranges', [
    { workspace_id: DEMO_WS_ID, user_id: DEMO_USER_ID, name: 'Month to date', preset: 'this_month', from_date: null, to_date: null, created_at: iso(now - 21 * D) },
    { workspace_id: DEMO_WS_ID, user_id: DEMO_USER_ID, name: `Q${pq + 1} ${py} review`, preset: null, from_date: qFrom, to_date: qEndMonth.toISOString().slice(0, 10), created_at: iso(now - 9 * D) },
  ]);

  // 3. the weekly digest (Monday morning, to the owner and a manager)
  const sam = s.t('outreach_members').find((m) => m.user_id === MEMBER.sam);
  const owner = s.t('outreach_members').find((m) => m.user_id === DEMO_USER_ID);
  const weekday = new Date(now).getUTCDay();
  const lastMonday = now - ((weekday + 6) % 7) * D;
  s.insert('outreach_report_schedules', {
    workspace_id: DEMO_WS_ID, client_id: null, kind: 'digest', cadence: 'weekly',
    recipients: [owner?.email ?? 'maya.chen@example.com', sam?.email].filter(Boolean),
    include_client_viewers: false, active: true, last_sent_at: iso(Math.min(lastMonday - (lastMonday % D) + 12 * H, now - H)), created_by: DEMO_USER_ID, created_at: iso(now - 40 * D),
  });
}
