// Plain-language text for the codes the engine stores on actions (error_code, decision). The app never shows a raw
// code such as E_CAP_ZERO or not_connected:branch to a user; it shows what happened in words.
// Mirrors outreach_reason_text() in migrations/outreach/012 (keep the two in step when adding a case).

const DECISIONS: Record<string, string> = {
  not_connected: 'Not connected yet',
  not_found: 'Profile not found',
  found: 'Found',
  connected: 'Connected',
  bounced: 'Email bounced',
  no_email: 'No email address',
  no_credit: 'No InMail credit',
  error: 'Failed',
  branch: 'Took a branch',
  suppressed: 'On the do-not-contact list',
  reply_exit: 'Stopped because the lead replied',
  replied: 'The lead replied',
  retry: 'Will try again',
  cancel: 'Cancelled',
  skip_node: 'Step skipped',
  user_skipped: 'Skipped by a teammate',
  user_rescheduled: 'Rescheduled by a teammate',
  rebalanced: 'Moved to another sender',
  node_deleted: 'The step was removed from the sequence',
  mark_lead_invalid: 'Lead marked as unreachable',
  sender_pause: 'Paused with the sender',
  sender_credentials: 'The sender needs to sign in again',
  sender_cap_hit: 'LinkedIn’s own limit was hit',
  sender_cap_hit_cascade: 'Held back after LinkedIn’s limit was hit',
  budget_deferred: 'Waiting for tomorrow’s allowance',
};

/** What the engine decided, in words. `not_connected:branch` → "Not connected yet (took a branch)". */
export function decisionText(decision: string | null | undefined): string | null {
  if (!decision) return null;
  const [head, ...rest] = String(decision).split(':');
  const main = DECISIONS[head] ?? head.replace(/_/g, ' ');
  const tail = rest.filter(Boolean).map((p) => DECISIONS[p]?.toLowerCase() ?? p.replace(/_/g, ' '));
  return tail.length ? `${main} (${tail.join(', ')})` : main;
}

/** Why an action failed or was skipped, in words. Same cases as outreach_reason_text() in the database. */
export function reasonText(code: string | null | undefined, decision?: string | null): string | null {
  if (!code) return decisionText(decision);
  const c = String(code);
  const has = (s: string) => c.includes(s);
  if (['E_LEAD_SUPPRESSED', 'suppressed', 'do_not_contact', 'unsubscribed'].includes(c)) return 'The lead is on a do-not-contact list';
  if (c === 'E_REPLIED' || c === 'replied') return 'The lead replied, so the sequence stopped';
  if (c === 'E_RELATION_INVALID') return 'LinkedIn says this profile cannot be invited (blocked or invalid)';
  if (c === 'E_RELATION_REQUIRED' || has('no_connection_with_recipient')) return 'Not connected yet, so a message could not be sent';
  if (c === 'E_PAYLOAD_INVALID' || has('payload_invalid')) return 'The step had no usable text for this lead';
  if (c === 'E_NO_EMAIL') return 'No email address on file';
  if (c === 'email_bounced' || has('recipient_rejected')) return 'The email address bounced';
  if (c === 'E_ENROLLMENT_NOT_LIVE') return 'The lead had already left the sequence';
  if (c === 'network_timeout_max' || c.startsWith('net:')) return 'Could not reach LinkedIn after three tries';
  if (has('invalid_recipient') || has('user_unreachable') || c.startsWith('404:')) return 'The profile no longer exists or cannot be reached';
  if (has('blocked_recipient') || has('cannot_invite_attendee')) return 'This person cannot be invited (they limit who can connect)';
  if (has('already_invited_recently') || has('cannot_resend') || c === 'invitation_pending') return 'An invitation is already pending or was sent recently';
  if (has('already_connected')) return 'Already connected, so the invitation was skipped';
  if (has('insufficient_credits') || has('not_allowed_inmail') || c === 'not_open_profile') return 'No InMail credit for this lead';
  if (c === 'no_recent_post') return 'The lead has no recent post to react to';
  if (c === 'no_skills') return 'No skills to endorse on the profile';
  if (c === 'no_voice_clip') return 'This sender has not recorded a voice note for the step';
  if (c === 'no_invitation') return 'There was no pending invitation to withdraw';
  if (has('comments_disabled') || has('invalid_post')) return 'The post does not accept comments';
  if (c.startsWith('401:') || c === 'E_SENDER_NOT_OK') return 'The sender was disconnected from LinkedIn';
  if (c.startsWith('403:')) return 'LinkedIn restricted the sender for this action';
  if (c.startsWith('429:')) return 'LinkedIn rate-limited the sender';
  if (/^5\d\d:/.test(c)) return 'LinkedIn had a temporary error';
  if (c.startsWith('http_')) return `The API call returned ${c.replace('http_', 'HTTP ')}`;
  if (c === 'graph_loop') return 'The sequence loops without a wait';
  if (c === 'unknown_node_type') return 'The sequence contains a step this version cannot run';
  if (c === 'user_skipped') return 'Skipped by a teammate';
  if (c === 'email_not_found') return 'No email address was found';
  if (c === 'E_CAP_ZERO') return 'The sender has no allowance for this action today';
  if (c === 'E_CAP_HIT_WEEKLY') return 'This week’s invitation limit is reached';
  if (c === 'E_BUDGET_EXHAUSTED') return 'Today’s sending limit is used up';
  if (c === 'E_OUT_OF_SCHEDULE') return 'Outside the sender’s working hours';
  if (c === 'E_SENDER_PAUSED' || c === 'E_HEALTH_PAUSED') return 'The sender is paused';
  if (c === 'E_NO_SCHEDULE') return 'The sender has no working hours set';
  if (c === 'E_NO_MAILBOX') return 'There is no email mailbox in the sender pool';
  if (c === 'E_SEQUENCE_NOT_ACTIVE') return 'The sequence is not active';
  if (c === 'E_PLATFORM_PAUSED' || c === 'E_PLAN_SUSPENDED') return 'Sending is paused for this workspace';
  return c.replace(/^E_/, '').replace(/[_:]/g, ' ').toLowerCase().replace(/^\w/, (m) => m.toUpperCase());
}
