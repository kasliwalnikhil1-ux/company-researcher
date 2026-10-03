'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { CalendarCheck, Compass, ExternalLink, LogOut, ShieldOff } from 'lucide-react';
import { useAuth, MFA_CHALLENGE_PATH } from '@/contexts/AuthContext';
import { useAccess } from '@/contexts/AccessContext';
import { onboardingCalendlyUrl, trackMySignup } from '@/lib/platform/leads';
import { DEMO_PREFIX } from '@/lib/outreach/mode';
import { useWhitelabel } from '@/hooks/useWhitelabel';

function Spinner() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-indigo-500"></div>
    </div>
  );
}

/**
 * What Calendly's widget script would build: the same page framed inline, tagged with the embedding host.
 * Compact (phones) drops Calendly's event-details panel (host photo, title, duration) so the calendar is the first thing seen.
 */
function calendlyEmbedUrl(url: string, compact: boolean): string {
  const u = new URL(url);
  u.searchParams.set('embed_domain', typeof window === 'undefined' ? '' : window.location.host);
  u.searchParams.set('embed_type', 'Inline');
  if (compact) u.searchParams.set('hide_event_type_details', '1');
  return u.toString();
}

/** Below the lg breakpoint, where the embed switches to its full-width phone layout. */
const PHONE_QUERY = '(max-width: 1023px)';

function useIsPhone(): boolean {
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia(PHONE_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(PHONE_QUERY);
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
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
  const url = onboardingCalendlyUrl(email, name);
  const [booked, setBooked] = useState(false);
  const [failed, setFailed] = useState(false);
  // the framed page's own height (it posts calendly.page_height as it renders and grows), so nothing scrolls inside the frame
  const [pageHeight, setPageHeight] = useState<number | null>(null);
  const heard = useRef(false);
  const onBookedRef = useRef(onBooked);
  useEffect(() => { onBookedRef.current = onBooked; }, [onBooked]);

  // the frame src carries the page host; the gate only renders in the browser, after sign-in resolves
  const phone = useIsPhone();
  const embedSrc = useMemo(() => (typeof window === 'undefined' ? null : calendlyEmbedUrl(url, phone)), [url, phone]);

  useEffect(() => {
    heard.current = false;
    const onMessage = (e: MessageEvent) => {
      if (!fromCalendly(e.origin)) return;
      heard.current = true;
      const d = e.data as { event?: string; payload?: { height?: string; event?: { uri?: string }; invitee?: { uri?: string } } } | undefined;
      if (d?.event === 'calendly.page_height') {
        const h = parseInt(d.payload?.height ?? '', 10);
        if (Number.isFinite(h) && h > 100) setPageHeight(h);
      } else if (d?.event === 'calendly.event_scheduled') {
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
          {/*
            Phones: the frame is the page, full width, as tall as Calendly says (no inner scroll).
            Desktop: Calendly's card is 800px wide, centred, 66px from the top of a 1100px-wide frame. The frame is
            rendered at that width and the wrapper crops the frame's own margins so the card sits flush in ours.
          */}
          {embedSrc && (
            <div className="overflow-hidden h-[calc(var(--ph)-40px)] lg:h-[calc(var(--ph)-90px)]" style={{ '--ph': `${pageHeight ?? 720}px` } as CSSProperties}>
              <iframe src={embedSrc} title="Book your onboarding call" allow="payment"
                className="block border-0 w-full lg:w-[1100px] lg:ml-[calc(50%-550px)] lg:-mt-[50px]"
                style={{ minWidth: 320, height: pageHeight ?? 720 }} />
            </div>
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
  const whitelabel = useWhitelabel();

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
    <div className="min-h-screen bg-white lg:bg-gray-50 lg:px-4 lg:py-12">
      {/* a card on desktop (sized to Calendly's 800px booking card plus padding); on phones the page itself, edge to edge */}
      <div className="mx-auto w-full lg:max-w-[864px] bg-white lg:border lg:border-gray-200 lg:rounded-2xl lg:shadow-sm overflow-hidden">
        <div className="flex items-center gap-2 px-6 sm:px-8 py-3 border-b border-gray-100 bg-gray-50/60">
          <Image src={whitelabel.logoPath} alt={whitelabel.pageTitle} width={24} height={24} className="h-6 w-auto" />
          <span className="text-sm font-semibold tracking-tight text-gray-900">{whitelabel.pageTitle}</span>
        </div>
        <div className="px-6 sm:px-8 pt-6 sm:pt-8">
          <p className="text-xs font-semibold uppercase tracking-wider text-indigo-600">You&apos;re in</p>
          <h1 className="mt-1 text-2xl font-semibold text-gray-900">Welcome to {whitelabel.pageTitle}</h1>
          <p className="mt-2 flex flex-wrap items-center gap-1 text-xs text-gray-400">
            {email && <span>Signed in as {email}</span>}
            {email && <span aria-hidden>·</span>}
            <button type="button" onClick={onSignOut} className="inline-flex items-center gap-1 text-gray-400 hover:text-gray-700 hover:underline">
              <LogOut className="w-3 h-3" /> Sign out
            </button>
          </p>
        </div>

        {/* the tour: its own area, first, since it needs nothing from us */}
        <div className="mx-6 sm:mx-8 mt-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 rounded-xl border border-indigo-100 bg-indigo-50/50 p-5">
          <div className="flex items-start gap-3">
            <div className="shrink-0 w-10 h-10 rounded-lg flex items-center justify-center bg-indigo-100 text-indigo-600"><Compass className="w-5 h-5" /></div>
            <div>
              <p className="text-sm font-semibold text-gray-900">Take the product tour</p>
              <p className="mt-0.5 text-sm text-gray-600">See it now, instant demo. A full workspace with sample data, no setup.</p>
            </div>
          </div>
          {/* a plain link: the tour runs on its own in-browser data, so entering it is a full page load */}
          <a href={DEMO_PREFIX} className="shrink-0 inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-700" data-gate-product-tour>
            <Compass className="w-4 h-4" /> Product tour
          </a>
        </div>

        <div className="flex items-center gap-3 px-6 sm:px-8 mt-8" role="separator">
          <span className="h-px flex-1 bg-gray-200" />
          <span className="text-xs uppercase tracking-wider text-gray-500">Or book your onboarding call</span>
          <span className="h-px flex-1 bg-gray-200" />
        </div>

        <div className="px-6 sm:px-8 pt-6 pb-4">
          <h2 className="text-lg font-semibold text-gray-900">Book your 20-minute onboarding call</h2>
          <p className="mt-1 text-sm text-gray-600 max-w-2xl">
            Thanks for signing up. Every new account is set up on a short call: we connect your first sending accounts, build your first
            sequence with you, setup your AI auto reply agent, and switch your workspace on.
          </p>
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
