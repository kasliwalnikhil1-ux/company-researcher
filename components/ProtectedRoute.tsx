'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth, MFA_CHALLENGE_PATH } from '@/contexts/AuthContext';

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading, mfaRequired, mfaCheckLoading } = useAuth();
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

  if (loading || !user || mfaCheckLoading || mfaRequired) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-indigo-500"></div>
      </div>
    );
  }

  return <>{children}</>;
}
