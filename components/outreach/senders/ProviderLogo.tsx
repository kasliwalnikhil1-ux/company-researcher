// Brand marks for sender channels. Inline SVG so they render crisp at any size and need no network request.
import { Mail } from 'lucide-react';
import type { Provider } from '@/lib/outreach/types';
import { cn } from '@/lib/utils';

export function ProviderLogo({ provider, className }: { provider: Provider; className?: string }) {
  const c = cn('w-4 h-4 shrink-0', className);
  if (provider === 'LINKEDIN') return (
    <svg viewBox="0 0 24 24" className={c} aria-label="LinkedIn" role="img">
      <rect width="24" height="24" rx="4" fill="#0A66C2" />
      <path fill="#fff" d="M7.12 20.45H3.56V9h3.56v11.45zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM20.45 20.45h-3.55v-5.57c0-1.33-.03-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28z" />
    </svg>
  );
  if (provider === 'INSTAGRAM') return (
    <svg viewBox="0 0 24 24" className={c} aria-label="Instagram" role="img">
      <defs>
        <linearGradient id="outreach-ig-gradient" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#F9A23F" />
          <stop offset="0.45" stopColor="#E1306C" />
          <stop offset="1" stopColor="#7038BF" />
        </linearGradient>
      </defs>
      <rect width="24" height="24" rx="6" fill="url(#outreach-ig-gradient)" />
      <rect x="5.5" y="5.5" width="13" height="13" rx="3.6" fill="none" stroke="#fff" strokeWidth="1.8" />
      <circle cx="12" cy="12" r="3.1" fill="none" stroke="#fff" strokeWidth="1.8" />
      <circle cx="15.7" cy="8.3" r="0.9" fill="#fff" />
    </svg>
  );
  if (provider === 'WHATSAPP') return (
    <svg viewBox="0 0 24 24" className={c} aria-label="WhatsApp" role="img">
      <rect width="24" height="24" rx="6" fill="#25D366" />
      <path fill="#fff" d="M12 4.6a7.3 7.3 0 0 0-6.3 11l-1 3.7 3.8-1a7.3 7.3 0 1 0 3.5-13.7zm0 13.3a6 6 0 0 1-3.1-.85l-.22-.13-2.25.6.6-2.2-.14-.23A6 6 0 1 1 12 17.9zm3.3-4.5c-.18-.09-1.07-.53-1.24-.59-.17-.06-.29-.09-.41.09-.12.18-.47.59-.58.71-.1.12-.21.14-.39.05-.18-.09-.76-.28-1.45-.9-.54-.48-.9-1.07-1-1.25-.1-.18-.01-.28.08-.37.08-.08.18-.21.27-.32.09-.1.12-.18.18-.3.06-.12.03-.23-.02-.32-.05-.09-.41-.98-.56-1.34-.15-.35-.3-.3-.41-.31h-.35c-.12 0-.32.05-.48.23-.17.18-.63.62-.63 1.5s.65 1.75.74 1.87c.09.12 1.27 1.94 3.08 2.72.43.19.77.3 1.03.38.43.14.83.12 1.14.07.35-.05 1.07-.44 1.22-.86.15-.42.15-.78.1-.86-.04-.08-.16-.12-.34-.21z" />
    </svg>
  );
  if (provider === 'GMAIL') return (
    <svg viewBox="52 42 88 66" className={c} aria-label="Gmail" role="img">
      <path fill="#4285f4" d="M58 108h14V74L52 59v43c0 3.32 2.69 6 6 6" />
      <path fill="#34a853" d="M120 108h14c3.32 0 6-2.69 6-6V59l-20 15" />
      <path fill="#fbbc04" d="M120 48v26l20-15v-8c0-7.42-8.47-11.65-14.4-7.2" />
      <path fill="#ea4335" d="M72 74V48l24 18 24-18v26L96 92" />
      <path fill="#c5221f" d="M52 51v8l20 15V48l-5.6-4.2c-5.94-4.45-14.4-.22-14.4 7.2" />
    </svg>
  );
  if (provider === 'OUTLOOK') return (
    <svg viewBox="0 0 24 24" className={c} aria-label="Outlook" role="img">
      <rect width="24" height="24" rx="4" fill="#0078D4" />
      <ellipse cx="12" cy="12" rx="5" ry="6" fill="none" stroke="#fff" strokeWidth="2.6" />
    </svg>
  );
  return <Mail className={cn(c, 'text-gray-500')} aria-label="IMAP" />;
}
