export type DealStage = 'new' | 'contacted' | 'replied' | 'meeting_booked' | 'meeting_held' | 'proposal_sent' | 'negotiation' | 'won' | 'lost';
export const STAGES: DealStage[] = ['new', 'contacted', 'replied', 'meeting_booked', 'meeting_held', 'proposal_sent', 'negotiation', 'won', 'lost'];
export const STAGE_LABELS: Record<DealStage, string> = {
  new: 'New', contacted: 'Contacted', replied: 'Replied', meeting_booked: 'Meeting booked', meeting_held: 'Meeting held',
  proposal_sent: 'Proposal sent', negotiation: 'Negotiation', won: 'Won', lost: 'Lost',
};
export const OPEN_STAGES = STAGES.filter((s) => s !== 'won' && s !== 'lost');
export const stageRank = (s: DealStage) => STAGES.indexOf(s);

export type MeetingStatus = 'scheduled' | 'held' | 'no_show' | 'cancelled';
export type Direction = 'outbound' | 'inbound';

export interface Lookup { id: string; slug: string; label: string; is_active: boolean; sort_order: number; notes?: string | null; counts_as?: string | null }
export type LookupKind = 'icp_segment' | 'source_channel' | 'activity_type';
export interface Member { user_id: string; display_name: string; email: string | null; is_active: boolean }

export interface CrmContextData {
  user_id: string;
  is_member: boolean;
  me: Member | null;
  members: Member[];
  settings: Record<string, unknown>;
  timezone: string;
  stale_after_days: number;
  stages: DealStage[];
  icp_segments: Lookup[];
  source_channels: Lookup[];
  activity_types: Lookup[];
  fx_rates: Record<string, number>;
}

export interface Company {
  id: string; name: string; website: string | null; domain: string | null; country: string | null; timezone: string | null;
  icp_segment_id: string | null; source_channel_id: string | null; notes: string | null; created_at: string; updated_at: string;
}

export interface Contact {
  id: string; company_id: string; name: string; role: string | null; email: string | null; phone: string | null; linkedin_url: string | null;
  timezone: string | null; notes: string | null; is_primary: boolean; created_at: string;
}

/** Row of crm_deals_v */
export interface Deal {
  id: string; company_id: string; title: string | null; stage: DealStage; owner_id: string | null; owner_name: string | null;
  value_monthly: number | null; currency: string; value_monthly_usd: number | null; videos_per_month: number | null;
  expected_close_date: string | null; next_step: string | null; next_step_date: string | null; lost_reason: string | null;
  source_channel_id: string | null; source_channel_label: string | null; icp_segment_id: string | null; icp_segment_label: string | null;
  delivery_project_id: string | null; stage_entered_at: string; last_activity_at: string | null; created_at: string; closed_at: string | null;
  company_name: string; company_domain: string | null; company_country: string | null; company_timezone: string | null;
  is_active: boolean; days_in_stage: number; days_since_activity: number; is_stuck: boolean; is_stale: boolean; is_slipping: boolean;
}

export interface StageHistory { id: string; deal_id: string; from_stage: DealStage | null; to_stage: DealStage; reason: string | null; changed_by: string | null; changed_at: string }

/** Row of crm_meetings_v */
export interface Meeting {
  id: string; deal_id: string; contact_id: string | null; scheduled_at: string; timezone: string | null; duration_min: number | null; attendees: string[];
  status: MeetingStatus; notes: string | null; created_at: string;
  company_id: string; company_name: string; deal_stage: DealStage; value_monthly: number | null; currency: string; value_monthly_usd: number | null; owner_id: string | null;
  contact_name: string | null; contact_role: string | null; contact_email: string | null; icp_segment_label: string | null; source_channel_label: string | null;
  has_capture: boolean; capture_outcome: 'held' | 'no_show' | null; has_transcript: boolean; has_recording: boolean;
}

export type SpeakerRole = 'prospect' | 'team' | 'unknown';
/** `speaker` is Deepgram's 0-based index; an unnamed one is labelled "Speaker N+1". */
export interface TranscriptSpeaker { speaker: number; label: string; role: SpeakerRole; contact_id?: string; member_id?: string; words?: number; share_of_words?: number; speaking_seconds?: number }
export interface TranscriptTurn { i: number; speaker?: number; label: string; role: SpeakerRole; start?: number; end?: number; text: string }
/** What company_brief carries per meeting — enough to show that a transcript exists without loading it. */
export interface TranscriptSummary { summary: string | null; topics: string[]; duration_seconds: number | null; word_count: number | null; speakers: TranscriptSpeaker[] }
/** The call audio stored for a meeting (the file itself is in Oracle Object Storage; see lib/crm/recordings.ts). */
export interface RecordingSummary { bytes: number | null; content_type: string | null; duration_seconds: number | null; original_name: string | null; uploaded_via: 'app' | 'skill' | null; created_at: string }
/** Result of crm_get_transcript */
export interface Transcript extends TranscriptSummary {
  meeting_id: string; company: string; company_id: string; contact: string | null; scheduled_at: string;
  language: string | null; avg_confidence: number | null; low_confidence: Array<{ word: string; start?: number; confidence?: number }>;
  turn_count: number; source: string | null; engine: string | null; model: string | null; saved_by: string | null; created_at: string; updated_at: string;
  has_recording: boolean; matched_turns: number; returned: number; turns: TranscriptTurn[];
}

export interface Capture {
  id: string; meeting_id: string; outcome: 'held' | 'no_show'; pain_points: string[]; commercials_discussed: Record<string, unknown> | null; objections: string[];
  next_step: string | null; next_step_date: string | null; is_dead: boolean; dead_reason: string | null;
  no_show_reason: string | null; follow_up_action: string | null; follow_up_date: string | null; is_repeat_no_show: boolean; raw_notes: string | null; created_at: string;
}

/** Row of crm_activities_v */
export interface Activity {
  id: string; contact_id: string | null; company_id: string; deal_id: string | null; activity_type_id: string; activity_type_slug: string; activity_type_label: string; counts_as: string | null;
  direction: Direction; occurred_at: string; source_channel_id: string | null; source_channel_label: string | null; body: string | null; outcome: string | null;
  owner_id: string | null; owner_name: string | null; contact_name: string | null; contact_role: string | null; company_name: string; external_ref: string | null;
}

export interface ScoreRow { id: string | null; slug: string; label: string; is_active: boolean; dials: number; connects: number; linkedin_accepts: number; replies: number; meetings_booked: number; meetings_held: number; no_shows: number; proposals_sent: number; closes: number }
export type ScoreTotals = Omit<ScoreRow, 'id' | 'slug' | 'label' | 'is_active'>;
export const SCORE_KEYS: Array<{ key: keyof ScoreTotals; label: string; short: string }> = [
  { key: 'dials', label: 'Dials', short: 'Dials' }, { key: 'connects', label: 'Connects', short: 'Conn.' }, { key: 'linkedin_accepts', label: 'LinkedIn accepts', short: 'LI acc.' },
  { key: 'replies', label: 'Replies', short: 'Replies' }, { key: 'meetings_booked', label: 'Meetings booked', short: 'Booked' }, { key: 'meetings_held', label: 'Meetings held', short: 'Held' },
  { key: 'no_shows', label: 'No-shows', short: 'No-show' }, { key: 'proposals_sent', label: 'Proposals sent', short: 'Proposals' }, { key: 'closes', label: 'Closes', short: 'Closes' },
];

export interface Scoreboard { date: string; timezone: string; day: { channels: ScoreRow[]; totals: ScoreTotals }; trailing_7d: { from: string; to: string; channels: ScoreRow[]; totals: ScoreTotals } }

export interface TodayMeeting {
  meeting_id: string; scheduled_at: string; local_time: string; prospect_local_time: string | null; status: MeetingStatus; has_capture: boolean; attendees: string[]; meeting_notes: string | null;
  company: { id: string; name: string; domain: string | null; country: string | null; notes: string | null };
  contact: { id: string; name: string; role: string | null; email: string | null } | null;
  icp_segment: string | null; source_channel: string | null;
  deal: { id: string; stage: DealStage; value_monthly: number | null; currency: string; value_monthly_usd: number | null; videos_per_month: number | null; owner: string | null; next_step: string | null; next_step_date: string | null; days_in_stage: number };
  prior_no_shows: number;
  activity_history: Array<{ at: string; type: string; direction: Direction; channel: string | null; outcome: string | null; body: string | null; by: string | null }>;
  last_capture: (Partial<Capture> & { meeting_at: string }) | null;
}

export interface AttentionDeal { deal_id: string; company: string; stage: DealStage; owner: string | null; value_monthly: number | null; currency: string; days_in_stage?: number; missing?: string; days_since_activity?: number; last_activity_at?: string | null; next_step?: string | null; next_step_date?: string | null; days_late?: number }
export interface Attention { stuck: AttentionDeal[]; stale: AttentionDeal[]; slipping: AttentionDeal[]; stale_after_days: number }

export interface CommitmentRow { date: string; owner: string; owner_id: string; committed: Record<string, number>; actual: Record<string, number>; metrics_missed: number; metrics_committed: number; all_met: boolean; notes: string | null }

export interface Standup {
  date: string; timezone: string; scoreboard: Scoreboard; meetings_today: TodayMeeting[]; attention: Attention;
  next_steps_today?: Array<AttentionDeal & { company_id: string }>;
  /** Monday of the standup day's week, and open next steps from the standup day through the Sunday of next week. */
  week_start?: string; next_steps_upcoming?: Array<AttentionDeal & { company_id: string }>;
  commitments_today: Array<{ owner: string; owner_id: string; targets: Record<string, number>; notes: string | null }>;
  yesterday_commitments: CommitmentRow[];
  uncaptured_meetings: Array<{ meeting_id: string; company: string; contact: string | null; scheduled_at: string; deal_id: string }>;
}

export interface PipelineDeal {
  deal_id: string; company: string; company_id: string; logo_domain?: string | null; title: string | null; value_monthly: number | null; currency: string; value_monthly_usd: number | null; videos_per_month: number | null;
  owner: string | null; days_in_stage: number; next_step: string | null; next_step_date: string | null; is_stale: boolean; is_stuck: boolean; is_slipping: boolean;
  icp_segment: string | null; source_channel: string | null; expected_close_date: string | null; lost_reason: string | null;
}
export interface Pipeline { stages: Array<{ stage: DealStage; count: number; value_monthly_usd: number; deals: PipelineDeal[] }>; totals: { open_deals: number; open_value_monthly_usd: number; won_value_monthly_usd: number; stale: number; stuck: number; slipping: number } }

export interface FunnelChannel {
  source_channel_id: string | null; slug: string; label: string;
  leads: number; contacted: number; replied: number; meeting_booked: number; meeting_held: number; proposal_sent: number; negotiation: number; won: number; lost: number;
  won_value_monthly_usd: number; won_customers: number; revenue_usd: number; cost_usd: number | null; cac_usd: number | null; ltv_usd: number | null;
  conversion_pct: Record<string, number | null>;
}
export interface Funnel { from: string; to: string; source_channel: string | null; channels: FunnelChannel[]; note: string }

export interface CompanyBrief {
  company: Company & { icp_segment: string | null; source_channel: string | null; created_by_name: string | null };
  contacts: Contact[];
  deals: Array<Deal & { stage_history: Array<{ from: DealStage | null; to: DealStage; at: string; reason: string | null; by: string | null }> }>;
  meetings: Array<{ meeting_id: string; deal_id: string; scheduled_at: string; status: MeetingStatus; contact: string | null; attendees: string[]; notes: string | null; capture: (Capture & { tags: string[] }) | null; transcript: TranscriptSummary | null; recording: RecordingSummary | null }>;
  activities: Array<{ at: string; type: string; direction: Direction; channel: string | null; contact: string | null; outcome: string | null; body: string | null; by: string | null; deal_id: string | null }>;
  pain_points: string[]; pain_point_tags: string[]; objections: string[]; commercials: Array<Record<string, unknown>>;
  open_next_steps: Array<{ deal_id: string; stage: DealStage; next_step: string | null; next_step_date: string | null; owner: string | null }>;
  delivery_project_ids: string[];
}

export const COMMIT_KEYS = ['dials', 'connects', 'linkedin_connects', 'linkedin_messages', 'emails', 'meetings_booked', 'proposals_sent', 'closes'] as const;

export function fmtMoney(v: number | null | undefined, cur: string | null | undefined): string {
  if (v == null) return '—';
  const c = cur ?? 'USD';
  try { return new Intl.NumberFormat(c === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency: c, maximumFractionDigits: 0 }).format(Number(v)); } catch { return `${c} ${Number(v).toLocaleString()}`; }
}
export const fmtUsd = (v: number | null | undefined) => (v == null ? '—' : `$${Math.round(Number(v)).toLocaleString('en-US')}`);
