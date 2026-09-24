'use client';

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/utils/supabase/client';
import { isEmailAllowed, checkMfaRequired, MFA_CHALLENGE_PATH } from '@/contexts/AuthContext';
import { popPendingOAuthConsent } from '@/lib/oauthConsent';

export default function AuthCallback() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const handleAuthCallback = async () => {
      const code = searchParams.get('code');
      
      if (code) {
        try {
          const { data, error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) {
            console.error('Error exchanging code for session:', error);
            router.push('/login?error=auth_failed');
            return;
          }
          if (!isEmailAllowed(data.session?.user?.email)) {
            await supabase.auth.signOut();
            router.push('/login?error=not_authorized');
            return;
          }
          // Successfully authenticated. A 2FA account must verify its code
          // first (the challenge page resumes a pending OAuth consent);
          // otherwise finish a pending consent or go home.
          if (await checkMfaRequired()) {
            router.replace(MFA_CHALLENGE_PATH);
            return;
          }
          router.push(popPendingOAuthConsent() ?? '/');
        } catch (error) {
          console.error('Error in auth callback:', error);
          router.push('/login?error=auth_failed');
        }
      } else {
        // No code parameter, check if already authenticated
        try {
          const { data: { session } } = await supabase.auth.getSession();
          if (session) {
            if (!isEmailAllowed(session.user?.email)) {
              await supabase.auth.signOut();
              router.push('/login?error=not_authorized');
              return;
            }
            if (await checkMfaRequired()) {
              router.replace(MFA_CHALLENGE_PATH);
              return;
            }
            router.push(popPendingOAuthConsent() ?? '/');
          } else {
            router.push('/login');
          }
        } catch {
          // Invalid/expired refresh token - treat as unauthenticated
          router.push('/login');
        }
      }
    };

    handleAuthCallback();
  }, [searchParams, router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-secondary-default">
      <div className="text-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-default mx-auto mb-4"></div>
        <p className="text-gray-600">Completing sign in...</p>
      </div>
    </div>
  );
}
