'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { Session, User } from '@supabase/supabase-js';
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

type AuthContextType = {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  signOutAll: () => Promise<void>;
  changePassword: (newPassword: string) => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  updatePassword: (newPassword: string) => Promise<void>;
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

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
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
        // Keep session updated for token refresh, etc.
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

  const signIn = async (email: string, password: string) => {
    if (!isEmailAllowed(email)) {
      throw new Error(NOT_AUTHORIZED_MESSAGE);
    }
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) throw error;
    router.push('/');
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

  const signOut = async () => {
    await supabase.auth.signOut();
    router.push('/login');
  };

  const signOutAll = async () => {
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

  const value = {
    user,
    session,
    loading,
    signIn,
    signUp,
    signOut,
    signOutAll,
    changePassword,
    resetPassword,
    signInWithGoogle,
    updatePassword,
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
