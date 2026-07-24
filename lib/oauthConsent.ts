// Session key checked after login so a user who had to sign in first is
// bounced back to /oauth/consent to finish the OAuth authorization instead
// of landing in the app. Written by the consent page, consumed (and cleared)
// by the login page and the auth callback.
export const PENDING_OAUTH_CONSENT_KEY = 'pending_oauth_consent';

/** Pop the pending consent path if one was stored (returns null when absent). */
export function popPendingOAuthConsent(): string | null {
  if (typeof window === 'undefined') return null;
  const path = sessionStorage.getItem(PENDING_OAUTH_CONSENT_KEY);
  if (!path || !path.startsWith('/oauth/consent')) {
    sessionStorage.removeItem(PENDING_OAUTH_CONSENT_KEY);
    return null;
  }
  sessionStorage.removeItem(PENDING_OAUTH_CONSENT_KEY);
  return path;
}
