'use client';

/**
 * Platform access + admin: the client half of migrations/platform/001_admin.sql.
 *
 * Every account has a status (pending | active | blocked) and a map of feature overrides. Admins (platform_admins)
 * manage both from /admin. The database enforces the important parts (outreach RPCs, CRM membership, credit spend);
 * the client reads `platform_my_access()` once per session to decide what to show.
 */
import { supabase } from '@/utils/supabase/client';

export type AccessStatus = 'pending' | 'active' | 'blocked';

/** Keys the admin can switch per account. A key that is not set falls back to the app's own default rule. */
export type FeatureKey =
  | 'fundraising'
  | 'outreach'
  | 'research'
  | 'b2b'
  | 'personalization'
  | 'linkedin_inbox'
  | 'sender_profiles'
  | 'new_fundings_add';

export interface FeatureDef {
  key: FeatureKey;
  label: string;
  description: string;
  /** What applies when the admin leaves the switch on "Default". */
  defaultRule: string;
}

export const FEATURES: FeatureDef[] = [
  { key: 'fundraising', label: 'Fundraising', description: 'Investors, New fundings, Templates, Analytics and the credit-based AI analysis.', defaultRule: 'On for everyone (platform default)' },
  { key: 'outreach', label: 'Outreach', description: 'The /outreach product: senders, leads, sequences, inbox, reports. Enforced by the database too.', defaultRule: 'On for everyone (platform default)' },
  { key: 'research', label: 'Company research', description: 'The company researcher on the home page.', defaultRule: 'Only the internal team' },
  { key: 'b2b', label: 'B2B tools', description: 'Companies and Enrich (CSV enrichment).', defaultRule: 'Follows onboarding: on when the account chose B2B' },
  { key: 'personalization', label: 'Personalization', description: 'The investor personalization workbench.', defaultRule: 'Only the internal team' },
  { key: 'linkedin_inbox', label: 'LinkedIn inbox', description: 'LinkedIn conversations page.', defaultRule: 'Only the internal team' },
  { key: 'sender_profiles', label: 'Sender profiles', description: 'Manage sender profiles (add, edit, remove).', defaultRule: 'Only the internal team' },
  { key: 'new_fundings_add', label: 'Add fundings', description: 'The "add funding" action on New fundings.', defaultRule: 'Only the internal team' },
];

export interface MyAccess {
  user_id: string;
  email: string | null;
  status: AccessStatus;
  is_admin: boolean;
  /** platform defaults overlaid with this account's overrides */
  features: Record<string, boolean>;
  overrides: Record<string, boolean>;
  crm_member: boolean;
  signup_mode: 'approval' | 'open';
}

export class PlatformError extends Error {
  code: string;
  constructor(message: string, code = 'E_UNKNOWN') {
    super(message);
    this.code = code;
  }
}

const HUMAN: Record<string, string> = {
  E_UNAUTHORIZED: 'Sign in first',
  E_FORBIDDEN: 'You do not have permission to do this',
  E_NOT_FOUND: 'Not found',
  E_PAYLOAD_INVALID: 'Something in the request is not valid',
  E_FEATURE_DISABLED: 'This feature is not enabled for your account',
  E_LAST_ADMIN: 'At least one admin must remain',
  E_LAST_MEMBER: 'The CRM needs at least one active member',
};

/** Parse `E_CODE: message` errors raised by the SQL functions into something readable. */
export function parseError(err: unknown): PlatformError {
  if (err instanceof PlatformError) return err;
  const raw = (err as { message?: string })?.message ?? String(err);
  const m = /^(E_[A-Z_]+)(?::\s*(.*))?$/s.exec(String(raw).trim());
  if (m) return new PlatformError(m[2] || HUMAN[m[1]] || m[1], m[1]);
  return new PlatformError(String(raw), 'E_UNKNOWN');
}

/** Call a platform_* SQL RPC (name without the `platform_` prefix). */
export async function rpc<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase.rpc(`platform_${name}` as any, args as any);
  if (error) throw parseError(error);
  return data as T;
}

export async function fetchMyAccess(): Promise<MyAccess> {
  return rpc<MyAccess>('my_access');
}
