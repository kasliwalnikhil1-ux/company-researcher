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
  // channels (docs/outreach/CHANNELS-BUILD-CONTRACT.md §3)
  hourly_deferred: 'Waiting for the next hour’s allowance',
  no_chat: 'No conversation exists yet, and this step may not start one',
  not_on_whatsapp: 'The number is not on WhatsApp',
  followed_back: 'They followed back',
  no_follow_back: 'They did not follow back',
  has_consent: 'They agreed to hear from you',
  no_consent: 'No recorded consent',
  valid: 'The number is on WhatsApp',
  invalid: 'The number is not on WhatsApp',
  no_reply: 'No reply in time',
  unavailable: 'The other channel was not available for this lead',
  consent_revoked: 'They withdrew their consent',
  stop_request: 'They asked to stop',
  blocked: 'They blocked the account',
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
  // channels (docs/outreach/CHANNELS-BUILD-CONTRACT.md §3 and §6)
  if (c === 'E_NO_CONSENT' || c === 'no_consent') return 'No recorded WhatsApp consent for this lead, so nothing was sent';
  if (c === 'E_NO_IDENTITY' || c === 'no_identity') return 'No handle or number on file for this channel';
  if (c === 'E_IDENTITY_CONFLICT') return 'This handle or number already belongs to another lead';
  if (c === 'E_IDENTIFIER_INVALID' || c === 'not_on_whatsapp') return 'The number is not on WhatsApp';
  if (c === 'E_HOURLY_CAP') return 'This hour’s allowance for the account is used up';
  if (c === 'E_QUIET_PERIOD') return 'The account connected recently and waits 24 hours before any outreach';
  if (c === 'E_MIN_GAP') return 'Held a moment: actions on this account are spaced out';
  if (c === 'E_PROVIDER_WARNING') return 'Paused after the platform warned the account about automated activity';
  if (c === 'E_ACCOUNT_TOO_NEW') return 'WhatsApp numbers need at least 6 months of real use before outreach';
  if (c === 'E_NO_CONSENT_GUARD') return 'A WhatsApp message needs a “Check consent” step before it';
  if (c === 'E_LIKE_COUNT') return 'A step can like at most 3 recent posts';
  if (c === 'E_NO_CHANNEL_SENDER') return 'The sender pool has no account for this step’s channel';
  if (c === 'no_chat') return 'No conversation exists yet, and this step may not start one';
  if (c === 'consent_revoked') return 'They withdrew their consent';
  if (c === 'stop_request') return 'They asked to stop';
  if (c === 'blocked' || has('blocked_recipient')) return 'They blocked the account';
  if (c === 'unsupported_unfollow') return 'Unfollowing is not available on this channel yet';
  if (c === 'unsupported_follow') return 'Following is not available on this channel';
  if (has('account_restricted')) return 'The platform restricted the account for now';
  if (c === 'E_SEQUENCE_NOT_ACTIVE') return 'The sequence is not active';
  if (c === 'E_PLATFORM_PAUSED' || c === 'E_PLAN_SUSPENDED') return 'Sending is paused for this workspace';
  if (c === 'E_NO_PROFILE_AUTHORITY') return 'The account owner had not given permission for this part of the profile';
  if (c === 'E_PROFILE_CEILING') return 'The limit for this kind of profile change was used up';
  if (c === 'E_EXPERIMENT_LOCK') return 'The field was locked by an experiment';
  if (c === 'E_PROFILE_STATE') return 'The profile change was no longer eligible';
  if (c.startsWith('E_PROFILE_IMAGE_REJECTED')) return 'LinkedIn rejected the image';
  if (c.startsWith('E_PROFILE_ID_UNRESOLVED')) return 'LinkedIn did not recognise an id in the change';
  if (c.startsWith('E_PROFILE_REJECTED') || c.startsWith('E_PROFILE_FORBIDDEN')) return 'LinkedIn rejected the profile change';
  if (c === 'profile_edit_retry_exhausted') return 'LinkedIn kept refusing; the change was not retried again';
  return c.replace(/^E_/, '').replace(/[_:]/g, ' ').toLowerCase().replace(/^\w/, (m) => m.toUpperCase());
}
