'use client';

// Profile Studio (linkedin-profile-management-PRD.md): types, labels, hooks and small helpers shared by the sender's
// Profile tab, the Senders → Profiles page and the public owner pages. Every write goes through an RPC or the
// outreach-profile function; the database is the authority on permission, ceilings and pacing.
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/utils/supabase/client';
import { parseError, rpc } from './api';

export type FieldGroup = 'headline' | 'about' | 'photo' | 'cover' | 'location' | 'experience' | 'education' | 'skills' | 'custom_link';
export const FIELD_GROUPS: FieldGroup[] = ['headline', 'about', 'photo', 'cover', 'location', 'experience', 'education', 'skills', 'custom_link'];
export const GROUP_LABELS: Record<FieldGroup, string> = { headline: 'Headline', about: 'About', photo: 'Profile photo', cover: 'Cover image', location: 'Location', experience: 'Experience', education: 'Education', skills: 'Skills', custom_link: 'Custom link' };
export const GROUP_HELP: Record<FieldGroup, string> = {
  headline: 'The line under the name. Prospects read it before anything else.',
  about: 'The About section: who you help, how, and proof.',
  photo: 'Photo, crop and filter. LinkedIn treats photo changes as the strongest account-takeover signal, so one change per 30 days.',
  cover: 'The banner image. Two changes per 30 days.',
  location: 'Needs a LinkedIn location id or a postal code. LinkedIn reports the location as text, so a rollback restores the last id written here.',
  experience: 'Edit the description of an existing position, or add one. Adding positions across several profiles at once is not allowed.',
  education: 'Edit an existing entry or add one. One change per 30 days.',
  skills: 'The skills list. Repeated names are merged.',
  custom_link: 'The link shown on the profile. LinkedIn does not report it back, so the platform remembers what it wrote.',
};
export const LIMITS = { headline: 220, summary: 2600, experience_description: 2000, education_description: 1000, role: 100, company: 100, school: 100, skill: 80 } as const;
/** Where LinkedIn cuts headlines in search results and in the mobile app. */
export const TRUNCATION = { search: 120, mobile: 70 } as const;

export const PICTURE_FILTERS = ['ORIGINAL', 'STUDIO', 'SPOTLIGHT', 'PRIME', 'CLASSIC', 'EDGE', 'LUMINATE'] as const;
export type PictureFilter = (typeof PICTURE_FILTERS)[number];
/** CSS approximations of LinkedIn's photo filters, for the preview only. */
export const FILTER_CSS: Record<PictureFilter, string> = { ORIGINAL: '', STUDIO: 'contrast(1.05) saturate(0.9)', SPOTLIGHT: 'brightness(1.08) contrast(1.1)', PRIME: 'saturate(1.15) contrast(1.05)', CLASSIC: 'sepia(0.25) contrast(1.05)', EDGE: 'contrast(1.2) saturate(0.8)', LUMINATE: 'brightness(1.12) saturate(1.05)' };
export const CUSTOM_LINK_TYPES = ['WEBSITE', 'PORTFOLIO', 'BLOG', 'NEWSLETTER', 'STORE'] as const;
export const PRESENCES = ['ON_SITE', 'HYBRID', 'REMOTE'] as const;

export interface PictureSettings { filter?: PictureFilter; layout?: { topLeft?: { x: number; y: number }; bottomRight?: { x: number; y: number } }; contrast?: number; brightness?: number; saturation?: number; vignette?: number }
export interface MonthYear { month?: number; year: number }
export interface ExperienceInput { id?: string; role?: string; company?: string; company_id?: string; employment_type?: string; location?: string; presence?: (typeof PRESENCES)[number]; description?: string; start_date?: MonthYear; end_date?: MonthYear; skills?: string[] }
export interface EducationInput { id?: string; school?: string; degree?: string; field_of_study?: string; grade?: string; activities?: string; description?: string; start_date?: MonthYear; end_date?: MonthYear }
export interface ProfilePayload {
  headline?: string; summary?: string;
  picture_settings?: PictureSettings; cover_picture_settings?: PictureSettings;
  location?: { id?: string; postal_code?: string };
  experience?: ExperienceInput; education?: EducationInput;
  skills?: string[]; skills_follow?: boolean;
  custom_link?: { type: (typeof CUSTOM_LINK_TYPES)[number]; url: string; display_on?: 'PROFILE_ONLY' | 'EVERYWHERE' };
}
export interface ProfileAssets { picture?: string; picture_url?: string; cover_picture?: string; cover_url?: string }

export interface ProfileDoc {
  headline: string | null; summary: string | null; location: string | null; picture_url: string | null; cover_url: string | null;
  first_name: string | null; last_name: string | null; public_identifier: string | null; connections_count: number | null; follower_count: number | null;
  experience: Array<{ id: string | null; title: string | null; company: string | null; company_id: string | null; start: string | null; end: string | null; current: boolean; location: string | null; description: string | null; skills: string[] }>;
  education: Array<{ id: string | null; school: string | null; degree: string | null; field: string | null; start: string | null; end: string | null; description: string | null }>;
  skills: Array<{ name: string; endorsements: number | null }>;
  languages: string[]; certifications: Array<{ name: string; issuer: string | null }>; projects: Array<{ name: string }>; websites: string[];
  fetched_sections: string[]; fetched_at: string;
}

export interface Cause { code: string; blocking: boolean; group?: FieldGroup; detail: string; remedy: string }
export interface Validation { ok: boolean; mode: 'propose_only' | 'direct'; groups: FieldGroup[]; causes: Cause[] }
export interface CeilingUse { key: string; max: number | null; window_days?: number; used: number; remaining: number; next_at: string | null; new_entry?: CeilingUse }
export interface Authority { id: string; mode: 'propose_only' | 'direct'; granted_by: string; via: 'signed_link' | 'owner_is_operator'; expires_at: string | null }
export interface GroupStatus { group: FieldGroup; authority: Authority | null; ceiling: CeilingUse; locked_by: { experiment_id: string; name: string } | null }
export interface WhyNot { groups: GroupStatus[]; combined: { week: CeilingUse; day: CeilingUse }; blockers: Cause[]; identity_verified: boolean; warmup_level: number; owner_email: string | null; daily_allowance: number; /** Workspace setting profile_owner_permission (off by default) */ permission_required: boolean }
export type ChangeStatus = 'draft' | 'awaiting_owner' | 'approved' | 'queued' | 'applied' | 'partially_applied' | 'failed' | 'cancelled' | 'reverted';
export interface PendingChange { id: string; status: ChangeStatus; field_groups: FieldGroup[]; source: string; scheduled_for: string | null; created_at: string; mode: string | null; note: string | null; payload: ProfilePayload; assets: ProfileAssets; error_code: string | null }
export interface ProfileOverview {
  sender: { id: string; name: string | null; public_identifier: string | null; picture_url: string | null; owner_email: string | null; status: string; warmup_level: number; connections_count: number | null; timezone: string; auth_method: string; identity_unverified: boolean };
  snapshot: { id: string; kind: string; captured_at: string; fidelity: string; sections: string[]; data: ProfileDoc } | null;
  qa: { score: number; checks: QaCheck[]; computed_at: string } | null;
  status: WhyNot;
  pending: PendingChange[];
  last_written: Partial<Record<'picture_settings' | 'cover_picture_settings' | 'custom_link' | 'skills_follow' | 'location', unknown>>;
  experiment: { id: string; name: string; status: string; field_group: FieldGroup } | null;
  ceilings: Record<string, { max: number; window_days: number }>;
}
export interface QaCheck { code: string; severity: 'critical' | 'high' | 'medium' | 'low'; pass: boolean | null; detail: string; fix_hint: string }
export interface ProfileChange extends PendingChange {
  applied_fields: string[]; failed_fields: Record<string, string>; requested_by_email: string | null; approved_by_email: string | null; owner_notified_at: string | null;
  applied_at: string | null; verified_at: string | null; reverted_at: string | null; reverts_change_id: string | null; pre_snapshot_id: string | null; post_snapshot_id: string | null; before: ProfileDoc | null; can_revert: boolean;
}
export interface RevertBuild { change_id: string; payload: ProfilePayload; assets: ProfileAssets; fields: Array<{ key: string; fidelity: 'full' | 'partial' | 'written_only'; note: string }>; unrecoverable: Array<{ key: string; why: string }>; possible: boolean }
export interface AuthorityList { grants: Array<{ id: string; field_group: FieldGroup; mode: 'propose_only' | 'direct'; granted_by_email: string; granted_via: string; granted_at: string; expires_at: string | null; revoked_at: string | null; revoked_reason: string | null; active: boolean }>; links: Array<{ id: string; field_groups: FieldGroup[]; mode: string; owner_email: string; expires_at: string; accepted_at: string | null; declined_at: string | null; created_at: string }>; owner_email: string | null; caller_is_owner: boolean }
export interface ProfileTemplate { id: string; workspace_id: string; client_id: string | null; name: string; field_groups: FieldGroup[]; body: ProfilePayload; variables: Record<string, string>; created_at: string; updated_at: string }
export interface WorkspaceChange { id: string; sender_id: string; sender_name: string | null; sender_picture: string | null; status: ChangeStatus; field_groups: FieldGroup[]; source: string; mode: string | null; scheduled_for: string | null; applied_at: string | null; created_at: string; error_code: string | null; template_id: string | null; experiment_id: string | null; owner_email: string | null; payload: ProfilePayload }
export interface BulkPreview { run_id: string; template: { id: string; name: string; field_groups: FieldGroup[] }; rows: Array<{ sender_id: string; name?: string; picture_url?: string | null; owner_email?: string | null; payload?: ProfilePayload; field_groups?: FieldGroup[]; ok: boolean; mode?: string; causes: Cause[] }>; eligible: number; excluded: number; expires_at: string; pacing: string }
export interface ExperimentArm { key: string; senders: number; resolved: number; accepted: number; pending: number; rate: number | null; last_invite_at: string | null }
export interface ExperimentResult { experiment_id: string; status: string; arms: ExperimentArm[]; comparison: { a: string; b: string; rate_a: number; rate_b: number; difference_points: number; ci_low: number; ci_high: number; p_value: number; required_per_variant: number | null } | null; verdict: 'a_better' | 'b_better' | 'not_conclusive' | 'insufficient_data' | 'insufficient_senders'; ready: boolean; warnings: Array<{ code: string; text: string }>; summary: string; washout_until: string | null }
export interface Experiment { id: string; name: string; field_group: FieldGroup; status: 'draft' | 'washout' | 'running' | 'ready' | 'concluded' | 'abandoned'; variants: Array<{ key: string; value: string }>; sender_ids: string[]; assignment: Record<string, string>; washout_days: number; min_invites_per_variant: number; started_at: string | null; washout_until: string | null; concluded_at: string | null; result: ExperimentResult | null; created_at: string; senders: Array<{ id: string; name: string | null; variant: string | null }> | null; changes: Array<{ id: string; sender_id: string; status: ChangeStatus }> | null }

/** Client mirror of outreach_profile_groups_of / fieldGroupsOf. */
export function fieldGroupsOf(p: ProfilePayload, a: ProfileAssets = {}): FieldGroup[] {
  const g = new Set<FieldGroup>();
  if (p.headline !== undefined) g.add('headline');
  if (p.summary !== undefined) g.add('about');
  if (p.picture_settings !== undefined || a.picture || a.picture_url) g.add('photo');
  if (p.cover_picture_settings !== undefined || a.cover_picture || a.cover_url) g.add('cover');
  if (p.location !== undefined) g.add('location');
  if (p.experience !== undefined) g.add('experience');
  if (p.education !== undefined) g.add('education');
  if (p.skills !== undefined || p.skills_follow !== undefined) g.add('skills');
  if (p.custom_link !== undefined) g.add('custom_link');
  return FIELD_GROUPS.filter((x) => g.has(x));
}

export const STATUS_LABELS: Record<ChangeStatus, string> = { draft: 'Draft', awaiting_owner: 'Waiting for the owner', approved: 'Approved', queued: 'Scheduled', applied: 'Applied', partially_applied: 'Partly applied', failed: 'Failed', cancelled: 'Cancelled', reverted: 'Reverted' };
export const STATUS_TONE: Record<ChangeStatus, 'gray' | 'green' | 'red' | 'amber' | 'blue' | 'indigo' | 'purple'> = { draft: 'gray', awaiting_owner: 'amber', approved: 'blue', queued: 'indigo', applied: 'green', partially_applied: 'amber', failed: 'red', cancelled: 'gray', reverted: 'purple' };
export const SOURCE_LABELS: Record<string, string> = { manual: 'Edited here', template: 'Template', experiment: 'Experiment', ai_draft: 'AI draft', rollback: 'Rollback', mcp: 'Assistant' };
export const FIDELITY: Record<'full' | 'partial' | 'written_only', { label: string; tone: 'green' | 'amber' | 'gray'; help: string }> = {
  full: { label: 'Full', tone: 'green', help: 'Restored exactly from the snapshot taken before the change.' },
  partial: { label: 'Partial', tone: 'amber', help: 'The image is restored from its URL; the crop and filter LinkedIn had cannot be restored.' },
  written_only: { label: 'Last written', tone: 'gray', help: 'LinkedIn does not report this field. It is restored to the last value written through the platform; a change made on LinkedIn since is lost.' },
};
export const QA_SEVERITY: Record<QaCheck['severity'], { label: string; tone: 'red' | 'amber' | 'blue' | 'gray' }> = { critical: { label: 'Critical', tone: 'red' }, high: { label: 'High', tone: 'red' }, medium: { label: 'Medium', tone: 'amber' }, low: { label: 'Low', tone: 'blue' } };
export function qaTone(score: number | null | undefined): 'green' | 'amber' | 'red' | 'gray' { if (score == null) return 'gray'; return score >= 80 ? 'green' : score >= 55 ? 'amber' : 'red'; }
export function payloadKeyLabel(k: string): string {
  return ({ headline: 'Headline', summary: 'About', picture: 'Profile photo', picture_url: 'Profile photo', picture_settings: 'Photo settings', cover_picture: 'Cover image', cover_url: 'Cover image', cover_picture_settings: 'Cover settings', location: 'Location', experience: 'Experience', education: 'Education', skills: 'Skills', skills_follow: 'Follow skills', custom_link: 'Custom link' } as Record<string, string>)[k] ?? k;
}
/** Short human text of a payload value for lists and tables. */
export function payloadValueText(k: string, v: unknown): string {
  if (v == null || v === '') return '(empty)';
  if (k === 'picture' || k === 'picture_url' || k === 'cover_picture' || k === 'cover_url') return 'new image';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : (x as { name?: string })?.name ?? '')).filter(Boolean).join(', ');
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (k === 'experience' || k === 'education') return [o.role ?? o.title, o.company ?? o.school, o.description].filter(Boolean).join(' · ');
    if (k === 'custom_link') return `${o.type ?? ''} ${o.url ?? ''}`.trim();
    if (k === 'location') return String(o.postal_code ?? o.id ?? '');
    return Object.entries(o).map(([a, b]) => `${a}: ${typeof b === 'object' ? JSON.stringify(b) : String(b)}`).join(', ');
  }
  return String(v);
}

// ---------------------------------------------------------------------------
// Query keys + hooks
// ---------------------------------------------------------------------------
export const pqk = {
  overview: (senderId: string) => ['outreach', 'profile', senderId, 'overview'] as const,
  history: (senderId: string) => ['outreach', 'profile', senderId, 'history'] as const,
  authority: (senderId: string) => ['outreach', 'profile', senderId, 'authority'] as const,
  templates: (ws: string) => ['outreach', ws, 'profile-templates'] as const,
  experiments: (ws: string) => ['outreach', ws, 'profile-experiments'] as const,
  changes: (ws: string, statuses: string[] | null) => ['outreach', ws, 'profile-changes', statuses] as const,
  correlation: (ws: string) => ['outreach', ws, 'profile-qa-correlation'] as const,
};
async function sel<T>(q: PromiseLike<{ data: unknown; error: unknown }>): Promise<T> { const { data, error } = await q; if (error) throw parseError(error); return data as T; }

export function useProfileOverview(senderId: string | null | undefined) {
  return useQuery({ queryKey: pqk.overview(senderId ?? ''), enabled: !!senderId, refetchInterval: 30000, queryFn: () => rpc<ProfileOverview>('profile_overview', { p_sender: senderId }) });
}
export function useProfileHistory(senderId: string | null | undefined) {
  return useQuery({ queryKey: pqk.history(senderId ?? ''), enabled: !!senderId, queryFn: () => rpc<ProfileChange[]>('profile_history', { p_sender: senderId, p_limit: 100 }) });
}
export function useProfileAuthority(senderId: string | null | undefined) {
  return useQuery({ queryKey: pqk.authority(senderId ?? ''), enabled: !!senderId, queryFn: () => rpc<AuthorityList>('profile_authority_list', { p_sender: senderId }) });
}
export function useProfileTemplates(ws: string | null | undefined) {
  return useQuery({ queryKey: pqk.templates(ws ?? ''), enabled: !!ws, queryFn: () => sel<ProfileTemplate[]>(supabase.from('outreach_profile_templates').select('*').eq('workspace_id', ws!).order('name')) });
}
export function useProfileExperiments(ws: string | null | undefined) {
  return useQuery({ queryKey: pqk.experiments(ws ?? ''), enabled: !!ws, refetchInterval: 60000, queryFn: () => rpc<Experiment[]>('profile_experiments_list', { p_ws: ws }) });
}
export function useProfileChanges(ws: string | null | undefined, statuses: ChangeStatus[] | null) {
  return useQuery({ queryKey: pqk.changes(ws ?? '', statuses), enabled: !!ws, refetchInterval: 30000, queryFn: () => rpc<WorkspaceChange[]>('profile_changes_list', { p_ws: ws, p_statuses: statuses, p_limit: 200 }) });
}
export function useQaCorrelation(ws: string | null | undefined) {
  return useQuery({ queryKey: pqk.correlation(ws ?? ''), enabled: !!ws, queryFn: () => rpc<Array<{ sender_id: string; name: string | null; qa: number | null; health: number; invites_30d: number; accepted_30d: number; acceptance_rate: number | null }>>('profile_qa_correlation', { p_ws: ws }) });
}
/** Everything a sender's profile tab shows; call after any write. */
export const profileKeysFor = (senderId: string, ws?: string | null) => [pqk.overview(senderId), pqk.history(senderId), pqk.authority(senderId), ...(ws ? [pqk.changes(ws, null), ['outreach', ws, 'senders'] as const] : [])];

// ---------------------------------------------------------------------------
// Storage: uploaded images live in a private bucket, kept so a rollback can restore the original
// ---------------------------------------------------------------------------
export const PROFILE_ASSETS_BUCKET = 'outreach-profile-assets';
export const IMAGE_RULES = { maxBytes: 8 * 1024 * 1024, types: ['image/jpeg', 'image/png', 'image/webp'], photo: { min: 400, max: 7680, hint: 'Square, at least 400×400 px, JPG/PNG/WebP under 8 MB.' }, cover: { min: 1128, max: 7680, hint: 'At least 1128×191 px (a 4:1 banner), JPG/PNG/WebP under 8 MB.' } } as const;

export function imageDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve({ width: img.naturalWidth, height: img.naturalHeight }); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not an image the browser can read')); };
    img.src = url;
  });
}

/** Validate + upload an image; returns the storage path to put in assets.picture / assets.cover_picture. */
export async function uploadProfileAsset(ws: string, senderId: string, file: File, kind: 'photo' | 'cover'): Promise<{ path: string; width: number; height: number }> {
  if (!(IMAGE_RULES.types as readonly string[]).includes(file.type)) throw new Error('Use a JPG, PNG or WebP image');
  if (file.size > IMAGE_RULES.maxBytes) throw new Error('The image is over 8 MB');
  const dim = await imageDimensions(file);
  const rule = IMAGE_RULES[kind];
  if (kind === 'photo' && (dim.width < rule.min || dim.height < rule.min)) throw new Error(`The photo is too small: at least ${rule.min}×${rule.min} px`);
  if (kind === 'cover' && dim.width < rule.min) throw new Error(`The cover is too narrow: at least ${rule.min} px wide`);
  if (dim.width > rule.max || dim.height > rule.max) throw new Error(`The image is too large: at most ${rule.max} px on a side`);
  const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
  const path = `${ws}/${senderId}/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from(PROFILE_ASSETS_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw new Error(error.message);
  return { path, ...dim };
}

export async function signedAssetUrl(path: string): Promise<string | null> {
  const { data } = await supabase.storage.from(PROFILE_ASSETS_BUCKET).createSignedUrl(path, 600);
  return data?.signedUrl ?? null;
}

/** Human sentence for a blocking cause (already plain language from the database; this only adds the group). */
export function causeText(c: Cause): string { return c.group ? `${GROUP_LABELS[c.group]}: ${c.detail}` : c.detail; }
