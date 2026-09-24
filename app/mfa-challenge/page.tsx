'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';
import { Clock, ShieldCheck } from 'lucide-react';
import { useAuth, AAL1_DEADLINE_STORAGE_KEY } from '@/contexts/AuthContext';
import { useWhitelabel } from '@/hooks/useWhitelabel';
import { popPendingOAuthConsent } from '@/lib/oauthConsent';
import { OtpInput } from '@/components/ui/OtpInput';

const formatRemaining = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
};

/** Only allow same-origin paths as a post-verification destination. */
const safeNext = (raw: string | null): string | null => {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return null;
  return raw;
};

export default function MfaChallengePage() {
  return (
    <Suspense fallback={null}>
      <MfaChallenge />
    </Suspense>
  );
}

function MfaChallenge() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const whitelabel = useWhitelabel();
  const { user, mfaListFactors, mfaChallengeAndVerify, mfaGetAal, signOut } = useAuth();

  const [factorId, setFactorId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [remainingMs, setRemainingMs] = useState<number | null>(null);

  const nextPath = safeNext(searchParams.get('next'));

  const enterApp = useCallback(() => {
    // Finish a pending OAuth consent (e.g. Claude connector) if one started this login.
    const pendingConsent = popPendingOAuthConsent();
    router.replace(pendingConsent ?? nextPath ?? '/');
  }, [router, nextPath]);

  useEffect(() => {
    if (!user) {
      router.replace('/login');
      return;
    }

    let cancelled = false;
    const init = async () => {
      const { currentLevel, nextLevel, error: aalError } = await mfaGetAal();
      if (cancelled) return;

      if (aalError) {
        setError('Unable to verify two-factor status. Please sign in again.');
        setLoading(false);
        return;
      }

      if (currentLevel === 'aal2' || nextLevel !== 'aal2') {
        // Already verified, or this account has no 2FA: nothing to do here.
        enterApp();
        return;
      }

      const { data, error: listError } = await mfaListFactors();
      if (cancelled) return;

      if (listError || !data) {
        setError(listError?.message || 'Unable to load your authenticator.');
        setLoading(false);
        return;
      }

      const verified = data.totp.find((f) => f.status === 'verified');
      if (!verified) {
        setError('No verified authenticator found on this account.');
        setLoading(false);
        return;
      }
      setFactorId(verified.id);
      setLoading(false);
    };

    init().catch(() => {
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [user, router, mfaGetAal, mfaListFactors, enterApp]);

  // Live countdown for the AAL1 grace period.
  useEffect(() => {
    const tick = () => {
      try {
        const raw = window.localStorage.getItem(AAL1_DEADLINE_STORAGE_KEY);
        if (!raw) {
          setRemainingMs(null);
          return;
        }
        const deadline = Number(raw);
        if (!Number.isFinite(deadline)) {
          setRemainingMs(null);
          return;
        }
        setRemainingMs(Math.max(0, deadline - Date.now()));
      } catch {
        setRemainingMs(null);
      }
    };
    tick();
    const interval = window.setInterval(tick, 1000);
    return () => window.clearInterval(interval);
  }, []);

  const handleVerify = useCallback(
    async (otp?: string) => {
      const otpCode = (otp ?? code).trim();
      if (!factorId || otpCode.length !== 6) {
        setError('Enter the 6-digit code from your authenticator app.');
        return;
      }

      setError(null);
      setVerifying(true);
      const { error: verifyError } = await mfaChallengeAndVerify(factorId, otpCode);
      if (verifyError) {
        setVerifying(false);
        setCode('');
        setError(verifyError.message || 'Invalid code. Please try again.');
        return;
      }
      enterApp();
    },
    [code, factorId, mfaChallengeAndVerify, enterApp]
  );

  const handleCancel = async () => {
    await signOut();
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-secondary-default py-12 px-6">
      <div className="w-full max-w-[400px]">
        <div className="flex items-center gap-2 mb-8">
          <Image src={whitelabel.logoPath} alt={whitelabel.pageTitle} width={28} height={28} className="h-7 w-auto" />
          <span className="text-lg font-semibold text-gray-900 tracking-tight">{whitelabel.pageTitle}</span>
        </div>

        <h2 className="text-2xl font-medium text-gray-900 mb-1 flex items-center gap-2">
          <ShieldCheck className="h-6 w-6 text-brand-default" />
          Two-factor authentication
        </h2>
        <p className="text-gray-500 text-sm mb-8">
          Enter the 6-digit code from your authenticator app to finish signing in.
        </p>

        {error && (
          <div
            className="mb-5 rounded-lg px-4 py-3 text-sm bg-accent-maroon-light text-accent-maroon-dark border border-accent-maroon-dark/20"
            role="alert"
          >
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-6">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-default" />
          </div>
        ) : factorId ? (
          <form
            className="space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              handleVerify();
            }}
          >
            <div className="flex justify-center">
              <OtpInput
                value={code}
                onChange={(v) => {
                  setCode(v);
                  if (error) setError(null);
                }}
                onComplete={(v) => {
                  if (!verifying) handleVerify(v);
                }}
                disabled={verifying}
                autoFocus
              />
            </div>

            <button
              type="submit"
              disabled={verifying || code.length !== 6}
              className="w-full py-2.5 px-4 rounded-lg text-sm font-medium text-white bg-brand-default hover:bg-brand-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-brand-default transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {verifying ? 'Verifying...' : 'Verify'}
            </button>

            {remainingMs !== null && (
              <div
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
                  remainingMs <= 60_000
                    ? 'border-accent-maroon-dark/20 bg-accent-maroon-light text-accent-maroon-dark'
                    : 'border-gray-200 bg-white text-gray-500'
                }`}
              >
                <Clock className="h-3.5 w-3.5 shrink-0" />
                <span>
                  Verify within <span className="font-mono">{formatRemaining(remainingMs)}</span>
                  {' or you’ll be signed out.'}
                </span>
              </div>
            )}
          </form>
        ) : null}

        <button
          type="button"
          onClick={handleCancel}
          disabled={verifying}
          className="mt-6 w-full text-center text-sm text-gray-500 hover:text-gray-900 transition-colors disabled:opacity-50"
        >
          Cancel and sign out
        </button>
      </div>
    </div>
  );
}
