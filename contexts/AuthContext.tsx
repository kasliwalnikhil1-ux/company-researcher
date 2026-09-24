'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AuthError, Session, User } from '@supabase/supabase-js';
import { useRouter } from 'next/navigation';
import { supabase } from '@/utils/supabase/client';

function isInvalidRefreshTokenError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'message' in error) {
    const msg = String((error as { message?: string }).message).toLowerCase();
    return msg.includes('refresh token') && (msg.includes('not found') || msg.includes('invalid'));
  }
  return false;
}

function clearInvalidAuthStorage(): void {
  try {
    if (typeof window === 'undefined') return;
    const keysToRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key?.startsWith('sb-')) keysToRemove.push(key);
    }
    keysToRemove.forEach((k) => window.localStorage.removeItem(k));
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Two-factor authentication (Supabase MFA, TOTP)
//
// A user who has enrolled an authenticator app signs in at AAL1 and must verify
// a 6-digit code to reach AAL2 before the app is usable. If they do not verify
// within the grace period, they are signed out. The deadline is persisted in
// localStorage so refreshing the page cannot reset the clock.
// ---------------------------------------------------------------------------
export const AAL1_GRACE_PERIOD_MS = 15 * 60 * 1000; // 15 minutes
export const AAL1_DEADLINE_STORAGE_KEY = 'mfa_aal1_deadline';
export const MFA_CHALLENGE_PATH = '/mfa-challenge';

type AalLevel = 'aal1' | 'aal2' | null;

export type MfaFactor = {
  id: string;
  status: 'verified' | 'unverified';
  friendly_name?: string | null;
};

const readAal1Deadline = (): number | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(AAL1_DEADLINE_STORAGE_KEY);
    if (!raw) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
};

const writeAal1Deadline = (deadline: number | null) => {
  if (typeof window === 'undefined') return;
  try {
    if (deadline === null) {
      window.localStorage.removeItem(AAL1_DEADLINE_STORAGE_KEY);
    } else {
      window.localStorage.setItem(AAL1_DEADLINE_STORAGE_KEY, String(deadline));
    }
  } catch {
    // ignore
  }
};

const getErrorMessage = (error: unknown): string => {
  if (!error) return '';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return '';
};

const toAuthError = (error: unknown, fallback: string): AuthError => {
  if (error instanceof AuthError) return error;
  return new AuthError(getErrorMessage(error) || fallback);
};

type AuthContextType = {
  user: User | null;
  session: Session | null;
  loading: boolean;
  /** True when the account has 2FA enrolled and this session has not verified it yet. */
  mfaRequired: boolean;
  /** True only during the first MFA level check after a fresh sign-in. */
  mfaCheckLoading: boolean;
  signIn: (email: string, password: string) => Promise<{ mfaRequired: boolean }>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  signOutAll: () => Promise<void>;
  changePassword: (newPassword: string) => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  updatePassword: (newPassword: string) => Promise<void>;
  // MFA
  mfaListFactors: () => Promise<{ data: { totp: MfaFactor[] } | null; error: AuthError | null }>;
  mfaEnrollTotp: (friendlyName?: string) => Promise<{
    data: { id: string; totp: { qr_code: string; secret: string; uri: string } } | null;
    error: AuthError | null;
  }>;
  mfaChallengeAndVerify: (factorId: string, code: string) => Promise<{ error: AuthError | null }>;
  mfaUnenroll: (factorId: string) => Promise<{ error: AuthError | null }>;
  mfaGetAal: () => Promise<{ currentLevel: AalLevel; nextLevel: AalLevel; error: AuthError | null }>;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const SIGNUP_USER_EXISTS_MESSAGE =
  'An account with this email already exists. Please sign in instead.';

const ALLOWED_EMAILS = new Set<string>([
  'kasliwalnikhil1@gmail.com',
  'nkjaipur21@gmail.com',
]);

export const NOT_AUTHORIZED_MESSAGE =
  'This email is not authorized to access the app. Please contact the administrator.';

export function isEmailAllowed(email: string | null | undefined): boolean {
  if (!email) return false;
  return ALLOWED_EMAILS.has(email.trim().toLowerCase());
}

/**
 * Reads the session's authenticator assurance level straight from the client
 * (no network call) and says whether a 2FA challenge is still outstanding.
 */
export async function checkMfaRequired(): Promise<boolean> {
  try {
    const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error || !data) return false;
    return data.nextLevel === 'aal2' && data.currentLevel !== 'aal2';
  } catch {
    return false;
  }
}

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [mfaCheckLoading, setMfaCheckLoading] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const getSession = async () => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();

        setSession(session);
        setUser(session?.user ?? null);
      } catch (error) {
        if (isInvalidRefreshTokenError(error)) {
          clearInvalidAuthStorage();
          setSession(null);
          setUser(null);
        } else {
          setSession(null);
          setUser(null);
        }
      } finally {
        setLoading(false);
      }
    };

    getSession();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, newSession) => {
      try {
        // Keep session updated for token refresh, MFA verification, etc.
        setSession((prev) => {
          const prevToken = prev?.access_token ?? null;
          const nextToken = newSession?.access_token ?? null;
          if (prevToken === nextToken) return prev;
          return newSession;
        });

        // Only update user state if the user identity changes
        setUser((prevUser) => {
          const prevId = prevUser?.id ?? null;
          const nextId = newSession?.user?.id ?? null;
          if (prevId === nextId) return prevUser;
          return newSession?.user ?? null;
        });
      } catch (error) {
        if (isInvalidRefreshTokenError(error)) {
          clearInvalidAuthStorage();
          setSession(null);
          setUser(null);
        }
      } finally {
        setLoading(false);
      }
    });

    return () => {
      subscription?.unsubscribe();
    };
  }, []);

  // Refresh session when the tab becomes visible again.
  // Browser timers are throttled/paused in background tabs, so Supabase's
  // autoRefreshToken may not fire while inactive. This ensures we get a
  // fresh access token when the user returns after a period of inactivity.
  useEffect(() => {
    let lastRefresh = Date.now();

    const handleVisibilityChange = async () => {
      if (document.visibilityState !== 'visible') return;

      // Only attempt refresh if at least 5 minutes have passed since last refresh
      // to avoid unnecessary network requests on rapid tab switches
      const elapsed = Date.now() - lastRefresh;
      if (elapsed < 5 * 60 * 1000) return;

      try {
        const {
          data: { session: current },
        } = await supabase.auth.getSession();

        if (!current) return; // No session to refresh

        // Check if the access token is expired or will expire within 2 minutes
        const expiresAt = current.expires_at; // Unix timestamp in seconds
        const now = Math.floor(Date.now() / 1000);
        const isExpiringSoon = expiresAt != null && expiresAt - now < 120;

        if (isExpiringSoon) {
          const {
            data: { session: refreshed },
            error,
          } = await supabase.auth.refreshSession();
          lastRefresh = Date.now();

          if (error) {
            if (isInvalidRefreshTokenError(error)) {
              clearInvalidAuthStorage();
            }
            setSession(null);
            setUser(null);
          } else if (refreshed) {
            setSession(refreshed);
            setUser(refreshed.user);
          }
        } else {
          lastRefresh = Date.now();
        }
      } catch (err) {
        console.error('Error refreshing session on visibility change:', err);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  const signOut = useCallback(async () => {
    writeAal1Deadline(null);
    await supabase.auth.signOut();
    router.push('/login');
  }, [router]);

  const signIn = async (email: string, password: string) => {
    if (!isEmailAllowed(email)) {
      throw new Error(NOT_AUTHORIZED_MESSAGE);
    }
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) throw error;
    // Password accepted. If the account has an authenticator app enrolled the
    // session is only AAL1 and the caller must send the user to the challenge.
    const needsMfa = await checkMfaRequired();
    return { mfaRequired: needsMfa };
  };

  const signUp = async (email: string, password: string) => {
    if (!isEmailAllowed(email)) {
      throw new Error(NOT_AUTHORIZED_MESSAGE);
    }
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
    });
    if (error) throw error;
    // Supabase returns success (no error) for existing emails to prevent enumeration,
    // but identities is empty when the user already exists.
    if (data.user && (!data.user.identities || data.user.identities.length === 0)) {
      throw new Error(SIGNUP_USER_EXISTS_MESSAGE);
    }
  };

  const signOutAll = async () => {
    writeAal1Deadline(null);
    await supabase.auth.signOut({ scope: 'global' });
    router.push('/login');
  };

  const changePassword = async (newPassword: string) => {
    const { error } = await supabase.auth.updateUser({
      password: newPassword,
    });
    if (error) throw error;
  };

  const getBaseUrl = () => {
    // On client side, always use current origin so auth redirects come back to the running app
    // (avoids redirecting to production when developing locally)
    if (typeof window !== 'undefined') return window.location.origin;
    // SSR fallback
    return (process.env.NEXT_PUBLIC_APP_URL || 'https://app.capitalxai.com').replace(/\/$/, '');
  };

  const resetPassword = async (email: string) => {
    const redirectTo = `${getBaseUrl()}/reset-password`;
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo,
    });
    if (error) throw error;
  };

  const signInWithGoogle = async () => {
    const redirectTo = `${getBaseUrl()}/auth/callback`;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo,
      },
    });
    if (error) throw error;
  };

  const updatePassword = async (newPassword: string) => {
    const { error } = await supabase.auth.updateUser({
      password: newPassword,
    });
    if (error) throw error;
  };

  // ---- MFA -----------------------------------------------------------------

  const mfaListFactors = useCallback(async () => {
    try {
      const { data, error } = await supabase.auth.mfa.listFactors();
      if (error) return { data: null, error };
      return { data: { totp: (data?.totp ?? []) as MfaFactor[] }, error: null };
    } catch (error) {
      return { data: null, error: toAuthError(error, 'Failed to list MFA factors.') };
    }
  }, []);

  const mfaEnrollTotp = useCallback(async (friendlyName?: string) => {
    try {
      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        ...(friendlyName ? { friendlyName } : {}),
      });
      if (error || !data) {
        return { data: null, error: error ?? new AuthError('Failed to enroll MFA factor.') };
      }
      return {
        data: {
          id: data.id,
          totp: { qr_code: data.totp.qr_code, secret: data.totp.secret, uri: data.totp.uri },
        },
        error: null,
      };
    } catch (error) {
      return { data: null, error: toAuthError(error, 'Failed to enroll MFA factor.') };
    }
  }, []);

  const mfaChallengeAndVerify = useCallback(async (factorId: string, code: string) => {
    try {
      const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
      return { error: error ?? null };
    } catch (error) {
      return { error: toAuthError(error, 'Failed to verify code.') };
    }
  }, []);

  const mfaUnenroll = useCallback(async (factorId: string) => {
    try {
      const { error } = await supabase.auth.mfa.unenroll({ factorId });
      return { error: error ?? null };
    } catch (error) {
      return { error: toAuthError(error, 'Failed to disable two-factor authentication.') };
    }
  }, []);

  const mfaGetAal = useCallback(async () => {
    try {
      const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (error) return { currentLevel: null, nextLevel: null, error };
      return {
        currentLevel: (data?.currentLevel ?? null) as AalLevel,
        nextLevel: (data?.nextLevel ?? null) as AalLevel,
        error: null,
      };
    } catch (error) {
      return { currentLevel: null, nextLevel: null, error: toAuthError(error, 'Failed to read MFA level.') };
    }
  }, []);

  // Recompute the MFA requirement whenever the access token changes (fresh
  // sign-in, MFA verification, token refresh). Keyed on the token string, not
  // the session object, so tab-focus re-emits do not flip the gating spinner.
  // The spinner is only shown for the first check after a sign-in; later
  // checks run in the background so mounted pages keep their in-memory state.
  const sessionAccessToken = session?.access_token ?? null;
  const mfaInitialCheckDoneRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    if (!sessionAccessToken) {
      setMfaRequired(false);
      setMfaCheckLoading(false);
      mfaInitialCheckDoneRef.current = false;
      return;
    }
    if (!mfaInitialCheckDoneRef.current) {
      setMfaCheckLoading(true);
    }
    checkMfaRequired()
      .then((required) => {
        if (cancelled) return;
        setMfaRequired(required);
      })
      .finally(() => {
        if (cancelled) return;
        mfaInitialCheckDoneRef.current = true;
        setMfaCheckLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionAccessToken]);

  // Enforce the AAL1 grace period: a user with 2FA who has not verified within
  // 15 minutes of signing in is signed out. Only clear the persisted deadline
  // once MFA is known to be satisfied or the user is signed out, never while
  // the session/AAL is still resolving, otherwise a refresh would restart the
  // clock.
  useEffect(() => {
    if (loading) return;

    if (!session) {
      writeAal1Deadline(null);
      return;
    }

    if (mfaCheckLoading) return;

    if (!mfaRequired) {
      writeAal1Deadline(null);
      return;
    }

    let deadline = readAal1Deadline();
    if (!deadline || deadline <= Date.now()) {
      deadline = Date.now() + AAL1_GRACE_PERIOD_MS;
      writeAal1Deadline(deadline);
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      signOut().catch(() => {});
      return;
    }

    const timer = window.setTimeout(() => {
      signOut().catch(() => {});
    }, remaining);

    return () => {
      window.clearTimeout(timer);
    };
  }, [loading, session, mfaRequired, mfaCheckLoading, signOut]);

  const value: AuthContextType = {
    user,
    session,
    loading,
    mfaRequired,
    mfaCheckLoading,
    signIn,
    signUp,
    signOut,
    signOutAll,
    changePassword,
    resetPassword,
    signInWithGoogle,
    updatePassword,
    mfaListFactors,
    mfaEnrollTotp,
    mfaChallengeAndVerify,
    mfaUnenroll,
    mfaGetAal,
  };

  return <AuthContext.Provider value={value}>{!loading && children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
