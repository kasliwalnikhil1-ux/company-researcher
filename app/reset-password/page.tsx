'use client';

import { useState, useEffect } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/utils/supabase/client';
import { Lock } from 'lucide-react';

export default function ResetPassword() {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isCheckingSession, setIsCheckingSession] = useState(true);
  const [canReset, setCanReset] = useState(false);
  const { updatePassword } = useAuth();
  const router = useRouter();

  // Supabase redirects with tokens in the hash fragment (#access_token=...&refresh_token=...&type=recovery)
  useEffect(() => {
    const establishSession = async () => {
      const hash = typeof window !== 'undefined' ? window.location.hash : '';
      const params = new URLSearchParams(hash.replace(/^#/, ''));

      const accessToken = params.get('access_token');
      const refreshToken = params.get('refresh_token');
      const type = params.get('type');

      if (accessToken && refreshToken && type === 'recovery') {
        try {
          const { error: sessionError } = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          });
          if (sessionError) {
            setError('Invalid or expired reset link. Please request a new password reset.');
            setCanReset(false);
          } else {
            // Clear hash from URL without reloading
            window.history.replaceState(null, '', window.location.pathname + window.location.search);
            setError(null);
            setCanReset(true);
          }
        } catch {
          setError('Invalid or expired reset link. Please request a new password reset.');
          setCanReset(false);
        }
      } else {
        // No tokens in hash; maybe session was already restored by Supabase
        const { data: { session } } = await supabase.auth.getSession();
        if (session) {
          setCanReset(true);
          setError(null);
        } else {
          setError('Invalid or expired reset link. Please request a new password reset.');
          setCanReset(false);
        }
      }
      setIsCheckingSession(false);
    };

    establishSession();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password.length < 6) {
      setError('Password must be at least 6 characters long.');
      return;
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setIsLoading(true);

    try {
      await updatePassword(password);
      setSuccess(true);
      setTimeout(() => {
        router.push('/login');
      }, 2000);
    } catch (err: any) {
      setError(err.message || 'Failed to update password. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-secondary-default py-12 px-4 sm:px-6 lg:px-8">
        <div className="max-w-md w-full">
          <div className="text-center">
            <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-accent-darkgreen-light mb-4">
              <Lock className="h-6 w-6 text-accent-darkgreen-dark" />
            </div>
            <h2 className="text-2xl font-medium text-gray-900 mb-2">Password updated!</h2>
            <p className="text-gray-600 mb-6">Your password has been successfully updated. Redirecting to login...</p>
          </div>
        </div>
      </div>
    );
  }

  if (isCheckingSession) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-secondary-default">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-default mx-auto mb-4" />
          <p className="text-gray-600">Verifying reset link...</p>
        </div>
      </div>
    );
  }

  if (!canReset) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-secondary-default py-12 px-4 sm:px-6 lg:px-8">
        <div className="max-w-md w-full text-center">
          <div className="rounded-lg px-4 py-3 text-sm bg-accent-maroon-light text-accent-maroon-dark border border-accent-maroon-dark/20 mb-6">
            {error}
          </div>
          <button
            type="button"
            onClick={() => router.push('/login')}
            className="font-medium text-brand-default hover:text-brand-dark"
          >
            Back to sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex bg-secondary-default">
      {/* Left: branding panel (hidden on small screens) */}
      <div className="hidden lg:flex lg:w-[45%] flex-col justify-between p-12 bg-brand-default text-white relative overflow-hidden">
        <div className="absolute inset-0 opacity-10">
          <div className="absolute top-0 left-0 w-96 h-96 rounded-full bg-white -translate-x-1/2 -translate-y-1/2" />
          <div className="absolute bottom-0 right-0 w-80 h-80 rounded-full bg-white translate-x-1/2 translate-y-1/2" />
        </div>
        <div className="relative">
          <div className="flex items-center gap-2">
            <Image src="/logo.png" alt="CapitalxAI CRM" width={32} height={32} className="h-8 w-auto" />
            <span className="text-xl font-semibold tracking-tight">CapitalxAI CRM</span>
          </div>
        </div>
        <div className="relative space-y-4 max-w-sm">
          <h1 className="text-3xl font-medium leading-tight">
            Reset your password.
          </h1>
          <p className="text-white/80 text-sm leading-relaxed">
            Enter your new password below to complete the reset process.
          </p>
        </div>
        <div className="relative text-sm text-white/60">
          © CapitalxAI
        </div>
      </div>

      {/* Right: reset form */}
      <div className="flex-1 flex items-center justify-center py-12 px-6 sm:px-8 lg:px-12">
        <div className="w-full max-w-[400px]">
          {/* Mobile logo */}
          <div className="flex items-center gap-2 mb-8 lg:hidden">
            <Image src="/logo.png" alt="CapitalxAI CRM" width={28} height={28} className="h-7 w-auto" />
            <span className="text-lg font-semibold text-gray-900 tracking-tight">CapitalxAI CRM</span>
          </div>

          <h2 className="text-2xl font-medium text-gray-900 mb-1">
            Reset your password
          </h2>
          <p className="text-gray-500 text-sm mb-8">
            Enter your new password below.
          </p>

          <form className="space-y-5" onSubmit={handleSubmit}>
            {error && (
              <div
                className="rounded-lg px-4 py-3 text-sm bg-accent-maroon-light text-accent-maroon-dark border border-accent-maroon-dark/20"
                role="alert"
              >
                {error}
              </div>
            )}

            <div className="space-y-1">
              <label htmlFor="password" className="block text-sm font-medium text-gray-700">
                New Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={6}
                className="block w-full px-3.5 py-2.5 rounded-lg border border-gray-300 bg-white text-gray-900 placeholder-gray-400 text-sm focus:outline-none focus:ring-2 focus:ring-brand-fainter focus:border-brand-default transition-shadow"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <p className="text-xs text-gray-500">Must be at least 6 characters</p>
            </div>

            <div className="space-y-1">
              <label htmlFor="confirm-password" className="block text-sm font-medium text-gray-700">
                Confirm Password
              </label>
              <input
                id="confirm-password"
                name="confirm-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={6}
                className="block w-full px-3.5 py-2.5 rounded-lg border border-gray-300 bg-white text-gray-900 placeholder-gray-400 text-sm focus:outline-none focus:ring-2 focus:ring-brand-fainter focus:border-brand-default transition-shadow"
                placeholder="••••••••"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-2.5 px-4 rounded-lg text-sm font-medium text-white bg-brand-default hover:bg-brand-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-brand-default transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoading ? 'Updating...' : 'Update password'}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-gray-500">
            <button
              type="button"
              onClick={() => router.push('/login')}
              className="font-medium text-brand-default hover:text-brand-dark"
            >
              Back to sign in
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
