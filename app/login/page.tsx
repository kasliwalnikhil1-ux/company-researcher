'use client';

import { useState, useEffect, useRef } from 'react';
import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';

const TYPEWRITER_WORDS = ['investor', 'company', 'person', 'prospect'];
const CHAR_SPEED_MS = 45;
const INITIAL_DELAY_MS = 220;
const END_PAUSE_MS = 800;
const CURSOR_BLINK_MS = 500;

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isLogin, setIsLogin] = useState(true);
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  // Typewriter state
  const [wordIndex, setWordIndex] = useState(0);
  const [displayedLength, setDisplayedLength] = useState(0);
  const [phase, setPhase] = useState<'initial' | 'typing' | 'pause' | 'deleting'>('initial');
  const [cursorVisible, setCursorVisible] = useState(true);
  const typewriterRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cursorRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { signIn, signUp, resetPassword, signInWithGoogle } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  // Cursor blink
  useEffect(() => {
    cursorRef.current = setInterval(() => {
      setCursorVisible((v) => !v);
    }, CURSOR_BLINK_MS);
    return () => {
      if (cursorRef.current) clearInterval(cursorRef.current);
    };
  }, []);

  // Typewriter loop
  useEffect(() => {
    const word = TYPEWRITER_WORDS[wordIndex];

    if (phase === 'initial') {
      const t = setTimeout(() => setPhase('typing'), INITIAL_DELAY_MS);
      return () => clearTimeout(t);
    }

    if (phase === 'pause') {
      const t = setTimeout(() => {
        setPhase('deleting');
        setCursorVisible(true);
      }, END_PAUSE_MS);
      return () => clearTimeout(t);
    }

    if (phase === 'typing') {
      if (displayedLength >= word.length) {
        setPhase('pause');
        setCursorVisible(false);
        return;
      }
      typewriterRef.current = setInterval(() => {
        setDisplayedLength((n) => Math.min(n + 1, word.length));
      }, CHAR_SPEED_MS);
      return () => {
        if (typewriterRef.current) clearInterval(typewriterRef.current);
      };
    }

    if (phase === 'deleting') {
      if (displayedLength <= 0) {
        setWordIndex((i) => (i + 1) % TYPEWRITER_WORDS.length);
        setPhase('typing');
        return;
      }
      typewriterRef.current = setInterval(() => {
        setDisplayedLength((n) => Math.max(n - 1, 0));
      }, CHAR_SPEED_MS);
      return () => {
        if (typewriterRef.current) clearInterval(typewriterRef.current);
      };
    }

    return () => {};
  }, [phase, wordIndex, displayedLength]);

  useEffect(() => {
    const errorParam = searchParams.get('error');
    if (errorParam === 'auth_failed') {
      setError('Authentication failed. Please try again.');
    }
  }, [searchParams]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setIsLoading(true);

    try {
      if (isLogin) {
        await signIn(email, password);
        router.push('/');
      } else {
        await signUp(email, password);
        setIsLogin(true);
        setSuccess('Please check your email for the confirmation link.');
        setEmail('');
        setPassword('');
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setIsLoading(true);

    try {
      await resetPassword(email);
      setSuccess('Password reset email sent! Please check your inbox.');
      setShowForgotPassword(false);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoogleAuth = async () => {
    setError(null);
    setIsLoading(true);
    try {
      await signInWithGoogle();
    } catch (err: any) {
      setError(err.message);
      setIsLoading(false);
    }
  };

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
            Research any{' '}
            <span className="inline-block">
              <span>{TYPEWRITER_WORDS[wordIndex].slice(0, displayedLength)}</span>
              {phase !== 'pause' && (
                <span
                  className="inline-block w-0.5 h-[1em] align-baseline bg-white ml-0.5"
                  style={{ opacity: cursorVisible ? 1 : 0 }}
                  aria-hidden
                />
              )}
            </span>
            <br />
            inside out.
          </h1>
          <p className="text-white/80 text-sm leading-relaxed">
            Get detailed insights and know everything about your target accounts—instantly.
          </p>
        </div>
        <div className="relative text-sm text-white/60">
          © ResourcePlan Solution Private Limited
        </div>
      </div>

      {/* Right: login form */}
      <div className="flex-1 flex items-center justify-center py-12 px-6 sm:px-8 lg:px-12">
        <div className="w-full max-w-[400px]">
          {/* Mobile logo */}
          <div className="flex items-center gap-2 mb-8 lg:hidden">
            <Image src="/logo.png" alt="CapitalxAI CRM" width={28} height={28} className="h-7 w-auto" />
            <span className="text-lg font-semibold text-gray-900 tracking-tight">CapitalxAI CRM</span>
          </div>

          <h2 className="text-2xl font-medium text-gray-900 mb-1">
            {isLogin ? 'Sign in to your account' : 'Create an account'}
          </h2>
          <p className="text-gray-500 text-sm mb-8">
            {isLogin ? 'Enter your credentials to continue.' : 'Start researching companies with confidence.'}
          </p>

          {showForgotPassword ? (
            <form className="space-y-5" onSubmit={handleForgotPassword}>
              <div className="space-y-4">
                <p className="text-sm text-gray-600">
                  Enter your email address and we'll send you a link to reset your password.
                </p>
                {error && (
                  <div
                    className="rounded-lg px-4 py-3 text-sm bg-accent-maroon-light text-accent-maroon-dark border border-accent-maroon-dark/20"
                    role="alert"
                  >
                    {error}
                  </div>
                )}
                {success && (
                  <div
                    className="rounded-lg px-4 py-3 text-sm bg-accent-darkgreen-light text-accent-darkgreen-dark border border-accent-darkgreen-dark/20"
                    role="alert"
                  >
                    {success}
                  </div>
                )}
                <div className="space-y-1">
                  <label htmlFor="reset-email" className="block text-sm font-medium text-gray-700">
                    Email
                  </label>
                  <input
                    id="reset-email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                    className="block w-full px-3.5 py-2.5 rounded-lg border border-gray-300 bg-white text-gray-900 placeholder-gray-400 text-sm focus:outline-none focus:ring-2 focus:ring-brand-fainter focus:border-brand-default transition-shadow"
                    placeholder="you@company.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setShowForgotPassword(false);
                      setError(null);
                      setSuccess(null);
                    }}
                    className="flex-1 py-2.5 px-4 rounded-lg text-sm font-medium text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-300 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isLoading}
                    className="flex-1 py-2.5 px-4 rounded-lg text-sm font-medium text-white bg-brand-default hover:bg-brand-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-brand-default transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isLoading ? 'Sending...' : 'Send reset link'}
                  </button>
                </div>
              </div>
            </form>
          ) : (
            <>
              <form className="space-y-5" onSubmit={handleSubmit}>
                {error && (
                  <div
                    className="rounded-lg px-4 py-3 text-sm bg-accent-maroon-light text-accent-maroon-dark border border-accent-maroon-dark/20"
                    role="alert"
                  >
                    {error}
                  </div>
                )}
                {success && (
                  <div
                    className="rounded-lg px-4 py-3 text-sm bg-accent-darkgreen-light text-accent-darkgreen-dark border border-accent-darkgreen-dark/20"
                    role="alert"
                  >
                    {success}
                  </div>
                )}

                <div className="space-y-1">
                  <label htmlFor="email-address" className="block text-sm font-medium text-gray-700">
                    Email
                  </label>
                  <input
                    id="email-address"
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                    className="block w-full px-3.5 py-2.5 rounded-lg border border-gray-300 bg-white text-gray-900 placeholder-gray-400 text-sm focus:outline-none focus:ring-2 focus:ring-brand-fainter focus:border-brand-default transition-shadow"
                    placeholder="you@company.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>

                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <label htmlFor="password" className="block text-sm font-medium text-gray-700">
                      Password
                    </label>
                    {isLogin && (
                      <button
                        type="button"
                        onClick={() => {
                          setShowForgotPassword(true);
                          setError(null);
                          setSuccess(null);
                        }}
                        className="text-sm font-medium text-brand-default hover:text-brand-dark"
                      >
                        Forgot password?
                      </button>
                    )}
                  </div>
                  <input
                    id="password"
                    name="password"
                    type="password"
                    autoComplete={isLogin ? 'current-password' : 'new-password'}
                    required
                    className="block w-full px-3.5 py-2.5 rounded-lg border border-gray-300 bg-white text-gray-900 placeholder-gray-400 text-sm focus:outline-none focus:ring-2 focus:ring-brand-fainter focus:border-brand-default transition-shadow"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>

                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full py-2.5 px-4 rounded-lg text-sm font-medium text-white bg-brand-default hover:bg-brand-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-brand-default transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isLoading ? 'Please wait...' : isLogin ? 'Sign in' : 'Sign up'}
                </button>
              </form>

              <div className="relative my-6">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-gray-300"></div>
                </div>
                <div className="relative flex justify-center text-sm">
                  <span className="px-2 bg-secondary-default text-gray-500">Or continue with</span>
                </div>
              </div>

              <button
                type="button"
                onClick={handleGoogleAuth}
                disabled={isLoading}
                className="w-full flex items-center justify-center gap-3 py-2.5 px-4 rounded-lg text-sm font-medium text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24">
                  <path
                    fill="#4285F4"
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                  />
                  <path
                    fill="#34A853"
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                  />
                  <path
                    fill="#EA4335"
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                  />
                </svg>
                {isLogin ? 'Sign in with Google' : 'Sign up with Google'}
              </button>

              <p className="mt-4 text-center text-xs text-gray-500">
                By clicking "{isLogin ? 'Sign in' : 'Sign up'}" or "{isLogin ? 'Sign in with Google' : 'Sign up with Google'}", you agree to our{' '}
                <a
                  href="https://capitalxai.com/terms"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand-default hover:text-brand-dark underline"
                >
                  Terms
                </a>
                ,{' '}
                <a
                  href="https://capitalxai.com/content-safety"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand-default hover:text-brand-dark underline"
                >
                  Content Safety
                </a>
                , and{' '}
                <a
                  href="https://capitalxai.com/privacy"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand-default hover:text-brand-dark underline"
                >
                  Privacy Policy
                </a>
                .
              </p>
            </>
          )}

          <p className="mt-6 text-center text-sm text-gray-500">
            <button
              type="button"
              onClick={() => {
                setIsLogin(!isLogin);
                setError(null);
              }}
              className="font-medium text-brand-default hover:text-brand-dark"
            >
              {isLogin ? 'Need an account? Sign up' : 'Already have an account? Sign in'}
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
