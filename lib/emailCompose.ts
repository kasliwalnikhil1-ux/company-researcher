/**
 * Email compose settings stored in user_settings.email_settings.
 */
export type EmailSettings = {
  provider: 'gmail' | 'outlook';
  signature: string;
};

const DEFAULT_SIGNATURE = 'Founder Name\nCEO, Company Name';

/**
 * Build body text: greeting + main body + signature.
 * Uses emailSettings.signature when provided, otherwise default.
 */
export function buildEmailBody(
  mainBody: string,
  greeting: string,
  emailSettings?: EmailSettings | null
): string {
  const sig = (emailSettings?.signature ?? DEFAULT_SIGNATURE).trim() || DEFAULT_SIGNATURE;
  const parts = [greeting, mainBody, sig].filter(Boolean);
  return parts.join('\n\n');
}

/**
 * Build compose URL for Gmail or Outlook from to/subject/body and user email settings.
 * Falls back to Gmail + default signature when emailSettings is null/undefined.
 */
export function buildEmailComposeUrl(
  to: string,
  options: {
    subject?: string;
    body?: string;
    emailSettings?: EmailSettings | null;
  } = {}
): string {
  const { subject, body, emailSettings } = options;
  const provider = emailSettings?.provider ?? 'gmail';
  const trimmedTo = to.trim();
  const encodedTo = encodeURIComponent(trimmedTo);

  if (provider === 'outlook') {
    // Outlook: https://outlook.office.com/mail/deeplink/compose?to=...&subject=...&body=...
    let url = `https://outlook.office.com/mail/deeplink/compose?to=${encodedTo}`;
    if (subject) {
      url += `&subject=${encodeURIComponent(subject)}`;
    }
    if (body) {
      url += `&body=${encodeURIComponent(body)}`;
    }
    return url;
  }

  // Gmail: https://mail.google.com/mail/?view=cm&fs=1&to=...&su=...&body=...
  let url = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodedTo}`;
  if (subject) {
    url += `&su=${encodeURIComponent(subject)}`;
  }
  if (body) {
    url += `&body=${encodeURIComponent(body)}`;
  }
  return url;
}
