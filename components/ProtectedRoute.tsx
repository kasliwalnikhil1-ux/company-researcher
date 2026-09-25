'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Clock, ShieldOff } from 'lucide-react';
import { useAuth, MFA_CHALLENGE_PATH } from '@/contexts/AuthContext';
import { useAccess } from '@/contexts/AccessContext';

function Spinner() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-indigo-500"></div>
    </div>
  );
}

/**
 * Shown instead of the app while the account is waiting for approval or has been switched off by an admin.
 * The database refuses the product RPCs for these accounts as well; this screen just explains why.
 */
function AccountGate({ status, email, onSignOut, onRetry }: { status: 'pending' | 'blocked'; email: string | null; onSignOut: () => void; onRetry: () => void }) {
  const pending = status === 'pending';
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md bg-white border border-gray-200 rounded-2xl shadow-sm p-8 text-center">
        <div className={`mx-auto w-12 h-12 rounded-full flex items-center justify-center ${pending ? 'bg-amber-100 text-amber-700' : 'bg-rose-100 text-rose-700'}`}>
          {pending ? <Clock className="w-6 h-6" /> : <ShieldOff className="w-6 h-6" />}
        </div>
        <h1 className="mt-4 text-xl font-semibold text-gray-900">{pending ? 'Your account is waiting for approval' : 'Your access has been turned off'}</h1>
        <p className="mt-2 text-sm text-gray-600">
          {pending
            ? 'Thanks for signing up. An administrator reviews new accounts before they can use the app. You will be able to sign in as soon as it is approved.'
            : 'An administrator has switched off access for this account. If you think this is a mistake, contact support.'}
        </p>
        {email && <p className="mt-3 text-xs text-gray-400">Signed in as {email}</p>}
        <div className="mt-6 flex items-center justify-center gap-2">
          {pending && (
            <button type="button" onClick={onRetry} className="px-4 py-2 text-sm font-medium rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50">
              Check again
            </button>
          )}
          <button type="button" onClick={onSignOut} className="px-4 py-2 text-sm font-medium rounded-lg bg-gray-900 text-white hover:bg-gray-800">
            Sign out
          </button>
        </div>
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
    return <AccountGate status={access.status} email={user.email ?? null} onSignOut={() => { signOut().catch(() => undefined); }} onRetry={() => { access.refresh(); }} />;
  }

  return <>{children}</>;
}
