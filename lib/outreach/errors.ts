/** Outreach error type and the `E_CODE` → plain-language map (shared by both backends; see backend/contract.ts). */

export class OutreachError extends Error {
  code: string;
  details?: unknown;
  constructor(message: string, code = 'E_UNKNOWN', details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** Parse `E_CODE: message` style errors raised by SQL functions / edge functions. */
export function parseError(err: unknown): OutreachError {
  if (err instanceof OutreachError) return err;
  const raw = (err as any)?.message ?? (err as any)?.error ?? String(err);
  const m = /^(E_[A-Z_]+)(?::\s*(.*))?$/s.exec(String(raw).trim());
  if (m) return new OutreachError(m[2] || humanize(m[1]), m[1], (err as any)?.details);
  return new OutreachError(String(raw), 'E_UNKNOWN', err);
}

export function humanize(code: string): string {
  const map: Record<string, string> = {
    E_BUDGET_EXHAUSTED: 'Today’s sending limit is used up',
    E_OUT_OF_SCHEDULE: 'Outside the sender’s working hours',
    E_SENDER_NOT_OK: 'The sender account is not connected',
    E_LEAD_SUPPRESSED: 'This lead is on a do-not-contact list',
    E_RELATION_REQUIRED: 'The lead has to be a connection first',
    E_NOTE_TOO_LONG: 'The invitation note is too long',
    E_NO_MAILBOX: 'There is no email mailbox in the sender pool',
    E_NO_EMAIL: 'The lead has no email address',
    E_INMAIL_NO_CREDIT: 'No InMail credits left',
    E_CAP_HIT_WEEKLY: 'This week’s invitation limit is reached',
    E_PAYLOAD_INVALID: 'Something in this step is not filled in correctly',
    E_GRAPH_INVALID: 'The sequence has steps that need fixing',
    E_POOL_EMPTY: 'Add at least one sender to the pool',
    E_SENDER_NOT_IN_POOL: 'That sender is not in this sequence’s pool',
    E_DUPLICATE_ENROLLMENT: 'This lead is already in the sequence with this sender',
    E_PLAN_SUSPENDED: 'This workspace is paused because of a billing issue',
    // Billing v2
    E_ACCOUNT_LIMIT: 'Every account on your plan is in use. Add an account to connect another',
    E_PLAN_REQUIRED: 'This is part of a higher plan',
    E_QUOTE_STALE: 'The price changed. Review the new amount',
    E_PAYMENT_FAILED: 'The payment did not go through. Nothing was changed',
    E_PAYMENT_PENDING: 'A payment is waiting to be confirmed. Finish or abandon it first',
    E_PAST_DUE: 'Pay the open invoice first',
    E_DECREASE_COSTS_MORE: 'That number of accounts would cost more than what you have now',
    E_NO_CHANGE: 'That is the plan you already have',
    E_TALK_TO_US: 'Plans this size are set up with our team. Talk to us',
    E_MANAGED_PLAN: 'This plan is managed by our team. Talk to us to change it',
    E_ALREADY_SUBSCRIBED: 'This workspace already has a subscription',
    E_NO_SUBSCRIPTION: 'This workspace has no subscription yet',
    E_NOT_CONFIGURED: 'This is not switched on yet',
    E_RATE_LIMITED: 'Too many requests. Wait a moment and try again',
    E_FORBIDDEN: 'You do not have permission to do this',
    E_NOT_FOUND: 'Not found. It may have been deleted',
    E_CAP_ABOVE_CEILING: 'That limit is higher than the platform allows',
    E_INFLIGHT: 'Leads are still moving through this sequence',
    E_DRAFT_STALE: 'Someone published a newer version while you were editing',
    E_INVITE_EXPIRED: 'This invitation has expired',
    E_INVITE_USED: 'This invitation was already used',
    E_INVITE_EMAIL_MISMATCH: 'Sign in with the invited email address',
    // Profile Studio
    E_NO_PROFILE_AUTHORITY: 'The account owner has not given permission to edit this part of the profile',
    E_PROFILE_CEILING: 'The limit for this kind of profile change is used up for now',
    E_PROFILE_WARMUP: 'The account is still at warm-up level 0, so its profile cannot be edited yet',
    E_PROFILE_QUIET_PERIOD: 'The account connected less than 72 hours ago. Profile edits wait until then',
    E_EXPERIMENT_LOCK: 'This field is locked by a running experiment',
    E_PROFILE_SENDER_NOT_OK: 'The account must be connected and not paused',
    E_PROFILE_IDENTITY_UNVERIFIED: 'This account was not connected by its owner, so its profile cannot be edited',
    E_PROFILE_PROHIBITED: 'That kind of change is not allowed',
    E_PROFILE_STATE: 'This change is not in a state where that can be done',
    E_PROFILE_UNRECOVERABLE: 'Nothing in this change can be restored automatically',
    E_PROFILE_HEALTH: 'Health is below 50, so the account has no allowance today',
    E_PROFILE_PROVIDER: 'Profile editing works for LinkedIn accounts',
    E_EXPERIMENT_NO_WINNER: 'The experiment has no winner, so nothing was applied',
    E_EXPERIMENT_NOT_READY: 'Not every sender can take the change yet',
    E_PREVIEW_EXPIRED: 'The preview expired. Run it again',
    E_BUDGET_PROFILE_VIEW: 'No profile-view allowance left today',
    E_PROFILE_ID_UNRESOLVED: 'LinkedIn did not recognise an id in this change',
    E_PROFILE_IMAGE_REJECTED: 'LinkedIn rejected the image (size, format or dimensions)',
    E_AI_UNAVAILABLE: 'AI drafting is not configured for this workspace',
    E_AI_VARIABLE_OFF: 'This variable is switched off',
    // Channels (Instagram / WhatsApp)
    E_NO_CONSENT: 'No recorded WhatsApp consent for this lead. Record a consent basis first',
    E_NO_IDENTITY: 'The lead has no handle or number on file for this channel',
    E_IDENTITY_CONFLICT: 'This handle or number already belongs to another lead',
    E_IDENTIFIER_INVALID: 'This number is not on WhatsApp',
    E_HOURLY_CAP: 'This hour’s Instagram allowance is used up. It resumes next hour',
    E_QUIET_PERIOD: 'This account connected recently and waits 24 hours before outreach starts',
    E_MIN_GAP: 'The account needs a short pause between actions',
    E_PROVIDER_WARNING: 'Instagram flagged automated behaviour. Outreach is paused for 48 hours',
    E_ACCOUNT_TOO_NEW: 'WhatsApp numbers need at least 6 months of real use before outreach',
    // Private notes
    E_NOTE_BODY_TOO_LONG: 'A note can hold up to 10,000 characters',
  };
  if (map[code]) return map[code];
  // unknown code: "E_SOME_THING" → "Some thing"
  const words = code.replace(/^E_/, '').toLowerCase().replace(/_/g, ' ');
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Something went wrong';
}
