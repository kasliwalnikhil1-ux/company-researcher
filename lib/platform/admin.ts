'use client';

/** Types + calls behind /admin. SQL side: migrations/platform/001_admin.sql. GoTrue side: app/api/admin/users/route.ts. */
import { getValidAccessToken } from '@/lib/api';
import { rpc, PlatformError, type AccessStatus } from '@/lib/platform/access';

export type OutreachPlan = 'trial' | 'team' | 'agency' | 'agency_plus' | 'suspended';
export type OutreachRole = 'owner' | 'manager' | 'member' | 'client_viewer';
export const OUTREACH_PLANS: OutreachPlan[] = ['trial', 'team', 'agency', 'agency_plus', 'suspended'];
export const OUTREACH_ROLES: OutreachRole[] = ['owner', 'manager', 'member', 'client_viewer'];
export const FUNDRAISING_PLANS = ['free', 'basic', 'pro'] as const;
export const BILLING_STATUSES = ['active', 'inactive', 'cancelled', 'past_due'] as const;
export const BILLING_CYCLES = ['monthly', 'quarterly', 'yearly'] as const;

export interface AdminOutreachSummary {
  workspace_id: string;
  name: string;
  slug: string;
  plan: OutreachPlan;
  role: OutreachRole;
  trial_ends_at: string;
  stripe_status: string | null;
  senders: number;
  members: number;
}

export interface AdminUser {
  id: string;
  email: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  email_confirmed_at: string | null;
  banned: boolean;
  provider: string;
  status: AccessStatus;
  is_admin: boolean;
  features: Record<string, boolean>;
  overrides: Record<string, boolean>;
  note: string | null;
  approved_at: string | null;
  plan: string;
  billing_status: string;
  billing_cycle: string | null;
  renewal_date: string | null;
  last_billed_at: string | null;
  stripe_customer_id: string | null;
  credits_remaining: number;
  credits_used: number;
  primary_use: string | null;
  onboarding_completed: boolean;
  outreach: AdminOutreachSummary[];
  crm: { is_active: boolean; display_name: string } | null;
}

export interface CreditLogRow { id: string; action: string; credits_used: number; investor_name: string | null; created_at: string }
export interface AuditRow { id: number; admin_id: string | null; admin_email: string | null; target_user_id: string | null; target_email: string | null; action: string; details: Record<string, unknown>; created_at: string }

export interface AdminUserDetail extends AdminUser {
  credit_log: CreditLogRow[];
  audit: Pick<AuditRow, 'id' | 'admin_email' | 'action' | 'details' | 'created_at'>[];
  outreach_memberships: { workspace_id: string; role: OutreachRole; client_ids: string[]; can_reply: boolean; created_at: string }[];
}

export interface AdminOverview {
  users: number; pending: number; active: number; blocked: number; banned: number; signups_7d: number;
  credits_outstanding: number; credits_used_30d: number; paid_plans: number;
  outreach_workspaces: number; outreach_by_plan: Record<string, number>; outreach_senders: number;
  crm_members: number; admins: number; signup_mode: 'approval' | 'open'; default_features: Record<string, boolean>;
}

export interface AdminWorkspaceMember { user_id: string; email: string | null; role: OutreachRole; client_ids: string[]; can_reply: boolean }
export interface AdminWorkspace {
  id: string; name: string; slug: string; plan: OutreachPlan; trial_ends_at: string; stripe_status: string | null; past_due_since: string | null;
  created_at: string; deleted_at: string | null; plan_before_suspension: string | null; owner_email: string | null;
  members: AdminWorkspaceMember[]; senders: number; senders_ok: number; leads: number; sequences: number; clients: number; actions_7d: number;
}

export interface CrmMemberRow { user_id: string; email: string | null; display_name: string; is_active: boolean; created_at: string; deals_owned: number; meetings: number }
export interface AdminSettings { settings: { signup_mode?: 'approval' | 'open'; default_features?: Record<string, boolean> }; admins: { user_id: string; email: string | null; note: string | null; created_at: string }[] }

export interface UserFilter { status?: AccessStatus | ''; plan?: string; crm?: boolean; outreach?: boolean; admin?: boolean; banned?: boolean; sort?: 'newest' | 'oldest' | 'last_seen' | 'credits' | 'email' }

async function api<T>(method: 'POST' | 'PATCH' | 'DELETE', body: Record<string, unknown>): Promise<T> {
  const token = await getValidAccessToken();
  if (!token) throw new PlatformError('Your session has expired. Sign in again.', 'E_UNAUTHORIZED');
  const res = await fetch('/api/admin/users', { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new PlatformError(data?.error || res.statusText, 'E_API');
  return data as T;
}

export const adminApi = {
  overview: () => rpc<AdminOverview>('admin_overview'),
  listUsers: (search: string, filter: UserFilter, limit = 50, offset = 0) =>
    rpc<{ total: number; rows: AdminUser[] }>('admin_list_users', { p_search: search || null, p_filter: filter, p_limit: limit, p_offset: offset }),
  getUser: (id: string) => rpc<AdminUserDetail>('admin_get_user', { p_user: id }),
  setAccess: (id: string, patch: { status?: AccessStatus; features?: Record<string, boolean>; note?: string }) =>
    rpc<AdminUser>('admin_set_access', { p_user: id, p_status: patch.status ?? null, p_features: patch.features ?? null, p_note: patch.note ?? null }),
  bulkStatus: (ids: string[], status: AccessStatus) => rpc<number>('admin_bulk_set_status', { p_users: ids, p_status: status }),
  setAdmin: (id: string, isAdmin: boolean, note?: string) => rpc<AdminUser>('admin_set_admin', { p_user: id, p_is_admin: isAdmin, p_note: note ?? null }),
  settings: () => rpc<AdminSettings>('admin_settings'),
  setSetting: (key: 'signup_mode' | 'default_features', value: unknown) => rpc<Record<string, unknown>>('admin_set_setting', { p_key: key, p_value: value }),
  setBilling: (id: string, patch: { plan?: string; billing_status?: string; billing_cycle?: string | null; renewal_date?: string | null }) =>
    rpc<AdminUser>('admin_set_billing', { p_user: id, p_patch: patch }),
  adjustCredits: (id: string, change: { delta?: number; set?: number; note?: string }) =>
    rpc<AdminUser>('admin_adjust_credits', { p_user: id, p_delta: change.delta ?? null, p_set: change.set ?? null, p_note: change.note ?? null }),
  workspaces: (search = '', includeDeleted = false) => rpc<AdminWorkspace[]>('admin_outreach_workspaces', { p_search: search || null, p_include_deleted: includeDeleted }),
  setWorkspace: (ws: string, patch: { plan?: OutreachPlan; trial_ends_at?: string; name?: string }) => rpc<AdminWorkspace>('admin_outreach_set_workspace', { p_ws: ws, p_patch: patch }),
  setWorkspaceMember: (ws: string, user: string, role: OutreachRole | null, clientIds?: string[]) =>
    rpc<AdminUser>('admin_outreach_set_member', { p_ws: ws, p_user: user, p_role: role, p_client_ids: clientIds ?? null }),
  createWorkspaceFor: (user: string, name?: string) => rpc<AdminUser>('admin_outreach_create_workspace', { p_user: user, p_name: name ?? null }),
  crmMembers: () => rpc<CrmMemberRow[]>('admin_crm_members'),
  setCrmMember: (user: string, patch: { active?: boolean; displayName?: string }) =>
    rpc<AdminUser>('admin_crm_set_member', { p_user: user, p_active: patch.active ?? null, p_display_name: patch.displayName ?? null }),
  auditLog: (limit = 100, offset = 0, user?: string) => rpc<{ total: number; rows: AuditRow[] }>('admin_audit_log', { p_limit: limit, p_offset: offset, p_user: user ?? null }),

  // GoTrue admin API (service role) — app/api/admin/users/route.ts
  createAccount: (input: { email: string; password?: string; note?: string }) => api<{ userId: string; email: string; inviteLink: string | null }>('POST', input),
  setBanned: (userId: string, banned: boolean) => api<{ success: true }>('PATCH', { userId, banned }),
  recoveryLink: (userId: string) => api<{ link: string | null }>('PATCH', { userId, action: 'recovery_link' }),
  deleteAccount: (userId: string, confirmEmail: string) => api<{ success: true }>('DELETE', { userId, confirmEmail }),
};

/** "access.updated" → "Access updated" */
export function actionLabel(action: string): string {
  const map: Record<string, string> = {
    'access.updated': 'Access updated', 'admin.granted': 'Made admin', 'admin.revoked': 'Admin removed', 'setting.updated': 'Setting changed',
    'billing.updated': 'Plan / billing updated', 'credits.adjusted': 'Credits adjusted', 'outreach.workspace_updated': 'Outreach workspace updated',
    'outreach.workspace_created': 'Outreach workspace created', 'outreach.member_added': 'Added to workspace', 'outreach.member_updated': 'Workspace role changed',
    'outreach.member_removed': 'Removed from workspace', 'crm.member_added': 'Added to CRM team', 'crm.member_updated': 'CRM membership updated',
    'account.created': 'Account created', 'account.banned': 'Sign-in banned', 'account.unbanned': 'Ban lifted', 'account.recovery_link': 'Recovery link issued', 'account.deleted': 'Account deleted',
  };
  return map[action] ?? action;
}

/** Short human line for an audit `details` object. */
export function describeDetails(details: Record<string, unknown> | null | undefined): string {
  if (!details || typeof details !== 'object') return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(details)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && ('from' in (v as object) || 'to' in (v as object))) {
      const { from, to } = v as { from?: unknown; to?: unknown };
      parts.push(`${k}: ${fmtVal(from)} → ${fmtVal(to)}`);
    } else if (v !== null && v !== undefined && v !== '') {
      parts.push(`${k}: ${fmtVal(v)}`);
    }
  }
  return parts.join(' · ');
}

function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}
