'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarCheck, ExternalLink, ShieldOff } from 'lucide-react';
import { useAuth, MFA_CHALLENGE_PATH } from '@/contexts/AuthContext';
import { useAccess } from '@/contexts/AccessContext';
import { ONBOARDING_CALENDLY_URL, trackMySignup } from '@/lib/platform/leads';

function Spinner() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-indigo-500"></div>
    </div>
  );
}

/** Calendly URL with the person's details prefilled and the GDPR banner off (the app already has its own notice). */
function calendlyUrl(email: string | null, name: string | null): string {
  const u = new URL(ONBOARDING_CALENDLY_URL);
  u.searchParams.set('hide_gdpr_banner', '1');
  u.searchParams.set('utm_source', 'app');
  u.searchParams.set('utm_medium', 'signup_gate');
  if (email) u.searchParams.set('email', email);
  if (name) u.searchParams.set('name', name);
  return u.toString();
}

/** What Calendly's widget script would build: the same page framed inline, tagged with the embedding host. */
function calendlyEmbedUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.set('embed_domain', typeof window === 'undefined' ? '' : window.location.host);
  u.searchParams.set('embed_type', 'Inline');
  return u.toString();
}

/** Is a postMessage from the framed Calendly page? */
function fromCalendly(origin: unknown): boolean {
  if (typeof origin !== 'string') return false;
  try { return /(^|\.)calendly\.com$/.test(new URL(origin).hostname); } catch { return false; }
}

/**
 * The embedded onboarding-call calendar. Frames the Calendly page directly (no third-party widget script, which ad
 * blockers often stop), listens for the "event scheduled" message so the booking is recorded on the person's lead row,
 * and falls back to a plain link if the frame never reports in.
 */
function CalendlyEmbed({ email, name, onBooked }: { email: string | null; name: string | null; onBooked: (booking: { event: string | null; invitee: string | null }) => void }) {
  const url = calendlyUrl(email, name);
  const [booked, setBooked] = useState(false);
  const [failed, setFailed] = useState(false);
  const heard = useRef(false);
  const onBookedRef = useRef(onBooked);
  useEffect(() => { onBookedRef.current = onBooked; }, [onBooked]);

  // the frame src carries the page host; the gate only renders in the browser, after sign-in resolves
  const embedSrc = useMemo(() => (typeof window === 'undefined' ? null : calendlyEmbedUrl(url)), [url]);

  useEffect(() => {
    heard.current = false;
    const onMessage = (e: MessageEvent) => {
      if (!fromCalendly(e.origin)) return;
      heard.current = true;
      const d = e.data as { event?: string; payload?: { event?: { uri?: string }; invitee?: { uri?: string } } } | undefined;
      if (d?.event === 'calendly.event_scheduled') {
        setBooked(true);
        onBookedRef.current({ event: d.payload?.event?.uri ?? null, invitee: d.payload?.invitee?.uri ?? null });
      }
    };
    window.addEventListener('message', onMessage);
    // the framed page posts its height as soon as it renders; if nothing arrives (blocked frame, offline) show the link instead
    const t = setTimeout(() => { if (!heard.current) setFailed(true); }, 15000);
    return () => { clearTimeout(t); window.removeEventListener('message', onMessage); };
  }, [url]);

  return (
    <div>
      {booked && (
        <div className="mx-6 sm:mx-8 mb-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 flex items-start gap-2">
          <CalendarCheck className="w-4 h-4 mt-0.5 shrink-0" />
          <span>Your call is booked. The invitation is in your inbox; your account is switched on right after we speak, often sooner.</span>
        </div>
      )}
      {failed ? (
        <div className="mx-6 sm:mx-8 rounded-xl border border-dashed border-gray-300 p-6 text-center">
          <p className="text-sm text-gray-600">The calendar could not load here (an ad blocker or a strict network often does this).</p>
          <a href={url} target="_blank" rel="noopener" className="mt-3 inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-700">
            Open the calendar in a new tab <ExternalLink className="w-4 h-4" />
          </a>
        </div>
      ) : (
        <>
          {/* the frame sits flush in the card, wide enough for Calendly's two-column layout (details left, dates right) */}
          {embedSrc && (
            <iframe src={embedSrc} title="Book your onboarding call" className="block w-full border-0" style={{ minWidth: 320, height: 720 }} allow="payment" />
          )}
          <p className="px-6 sm:px-8 pt-2 text-xs text-gray-400 text-right">
            Calendar not showing?{' '}
            <a href={url} target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-indigo-600 hover:underline">
              Open it in a new tab <ExternalLink className="w-3 h-3" />
            </a>
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Shown instead of the app while the account is waiting for approval or has been switched off by an admin.
 * The database refuses the product RPCs for these accounts as well; this screen just explains why.
 * Pending accounts see the onboarding-call calendar embedded (lib/platform/leads ONBOARDING_CALENDLY_URL); the visit
 * and the booking are recorded on the person's lead row (/admin → Leads) through /api/leads/track.
 */
function AccountGate({ status, email, name, onSignOut }: { status: 'pending' | 'blocked'; email: string | null; name: string | null; onSignOut: () => void }) {
  const pending = status === 'pending';

  // record where this sign-up came from (best effort, once per mount)
  useEffect(() => { if (pending) trackMySignup(); }, [pending]);

  if (!pending) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="w-full max-w-md bg-white border border-gray-200 rounded-2xl shadow-sm p-8 text-center">
          <div className="mx-auto w-12 h-12 rounded-full flex items-center justify-center bg-rose-100 text-rose-700"><ShieldOff className="w-6 h-6" /></div>
          <h1 className="mt-4 text-xl font-semibold text-gray-900">Your access has been turned off</h1>
          <p className="mt-2 text-sm text-gray-600">An administrator has switched off access for this account. If you think this is a mistake, contact support.</p>
          {email && <p className="mt-3 text-xs text-gray-400">Signed in as {email}</p>}
          <div className="mt-6 flex items-center justify-center gap-2">
            <button type="button" onClick={onSignOut} className="px-4 py-2 text-sm font-medium rounded-lg bg-gray-900 text-white hover:bg-gray-800">Sign out</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 px-4 py-8 sm:py-12">
      <div className="mx-auto w-full max-w-6xl bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 p-6 sm:p-8 pb-4 sm:pb-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-indigo-600">You&apos;re in</p>
            <h1 className="mt-1 text-2xl font-semibold text-gray-900">Book your 20-minute onboarding call</h1>
            <p className="mt-2 text-sm text-gray-600 max-w-2xl">
              Thanks for signing up. Every new account is set up on a short call: we connect your first sending accounts, build your first
              sequence with you, setup your AI auto reply agent, and switch your workspace on. Pick a time that suits you below.
            </p>
            {email && <p className="mt-2 text-xs text-gray-400">Signed in as {email}</p>}
          </div>
          <button type="button" onClick={onSignOut} className="shrink-0 px-3 py-2 text-sm font-medium rounded-lg bg-gray-900 text-white hover:bg-gray-800">
            Sign out
          </button>
        </div>

        <CalendlyEmbed email={email} name={name} onBooked={(booking) => { trackMySignup({ booked: true, booking }); }} />

        <p className="px-6 sm:px-8 py-4 text-xs text-gray-400">
          Can&apos;t find a time? Write to <a href="mailto:hello@growthxai.com" className="text-indigo-600 hover:underline">hello@growthxai.com</a> and we&apos;ll sort it out by email.
        </p>
      </div>
    </div>
  );
}

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading, mfaRequired, mfaCheckLoading, signOut } = useAuth();
  const access = useAccess();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.push('/login');
      return;
    }
    // Account has an authenticator enrolled but this session has not verified
    // it yet: nothing in the app is shown until the code is entered.
    if (!mfaCheckLoading && mfaRequired) {
      router.replace(MFA_CHALLENGE_PATH);
    }
  }, [user, loading, mfaRequired, mfaCheckLoading, router]);

  if (loading || !user || mfaCheckLoading || mfaRequired || access.loading) {
    return <Spinner />;
  }

  // Pending / blocked accounts see an explanation instead of the app. (If the access read failed the app
  // still renders: the database refuses the product calls on its own.)
  if (access.status === 'pending' || access.status === 'blocked') {
    const meta = (user.user_metadata ?? {}) as { full_name?: string; name?: string };
    return (
      <AccountGate status={access.status} email={user.email ?? null} name={meta.full_name ?? meta.name ?? null}
        onSignOut={() => { signOut().catch(() => undefined); }} />
    );
  }

  return <>{children}</>;
}
