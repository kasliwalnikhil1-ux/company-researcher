'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, ShieldCheck } from 'lucide-react';
import { supabase } from '@/utils/supabase/client';
import { useWhitelabel } from '@/hooks/useWhitelabel';
import { PENDING_OAUTH_CONSENT_KEY } from '@/lib/oauthConsent';

// supabase-js ships these methods at runtime (OAuth 2.1 server, v2.110+),
// but the generated typings can lag behind, so the shape is pinned here
// instead of relying on the SDK types.
interface OAuthClientInfo {
  name?: string;
  client_name?: string;
  logo_uri?: string;
}

interface AuthorizationDetails {
  authorization_id?: string;
  client?: OAuthClientInfo;
  redirect_uri?: string;
  redirect_url?: string;
  scope?: string;
}

interface OAuthDecisionResult {
  data: { redirect_url: string } | null;
  error: { message: string } | null;
}

interface SupabaseOAuthApi {
  getAuthorizationDetails: (
    authorizationId: string
  ) => Promise<{ data: AuthorizationDetails | null; error: { message: string } | null }>;
  approveAuthorization: (authorizationId: string) => Promise<OAuthDecisionResult>;
  denyAuthorization: (authorizationId: string) => Promise<OAuthDecisionResult>;
}

// Requires @supabase/supabase-js >= 2.110 (OAuth 2.1 server client API). The
// runtime guard below turns a stale bundle into a readable error instead of a
// crash ("Cannot read properties of undefined").
const oauthApi = (supabase.auth as unknown as { oauth?: SupabaseOAuthApi }).oauth;

// Accounts that get the connector's write tools (same allowlist as ME Data /
// Data Pipelines / Add Funding). Everyone else gets read-only access, and the
// consent copy must not reveal that admin-only capabilities exist.
const ADMIN_USER_IDS = new Set([
  '2793f3da-9340-44f4-b285-b7836bfb8591',
  'e25d5e21-13fd-46ee-a39a-4c3386b77b65',
]);

function OAuthConsentInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const whitelabel = useWhitelabel();
  const authorizationId = searchParams.get('authorization_id');

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState<'approve' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<AuthorizationDetails | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (!authorizationId) {
        setError('Missing authorization_id in the URL. Please restart the connection from the app you were using.');
        setLoading(false);
        return;
      }

      if (!oauthApi) {
        setError('This build of the app does not support OAuth authorization yet. Please contact support.');
        setLoading(false);
        return;
      }

      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        // Remember where we were so login can bring the user back to finish consent.
        sessionStorage.setItem(
          PENDING_OAUTH_CONSENT_KEY,
          `${window.location.pathname}${window.location.search}`
        );
        router.replace('/login');
        return;
      }

      if (cancelled) return;
      setUserEmail(session.user.email ?? null);
      setIsAdmin(ADMIN_USER_IDS.has(session.user.id));

      const { data, error: detailsError } = await oauthApi.getAuthorizationDetails(authorizationId);

      if (cancelled) return;

      if (detailsError || !data) {
        setError(detailsError?.message || 'This authorization request is invalid or has expired. Please retry from the connecting app.');
        setLoading(false);
        return;
      }

      // User already consented to this client previously: Supabase returns just a
      // redirect_url. Send them straight back to the connecting app.
      if (!('authorization_id' in data) || !data.authorization_id) {
        if (data.redirect_url) {
          window.location.href = data.redirect_url;
          return;
        }
      }

      setDetails(data);
      setLoading(false);
    };

    load().catch((err: unknown) => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : 'Something went wrong while loading the authorization request.');
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [authorizationId, router]);

  const decide = useCallback(
    async (decision: 'approve' | 'deny') => {
      if (!authorizationId || !oauthApi) return;
      setSubmitting(decision);
      try {
        const { data, error: decisionError } =
          decision === 'approve'
            ? await oauthApi.approveAuthorization(authorizationId)
            : await oauthApi.denyAuthorization(authorizationId);

        if (decisionError || !data?.redirect_url) {
          setError(decisionError?.message || 'Something went wrong while completing the authorization. Please retry from the connecting app.');
          setSubmitting(null);
          return;
        }

        window.location.href = data.redirect_url;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong while completing the authorization.');
        setSubmitting(null);
      }
    },
    [authorizationId]
  );

  const clientName = details?.client?.name || details?.client?.client_name || 'An application';

  return (
    <div className="min-h-screen flex items-center justify-center bg-secondary-default px-4">
      <div className="w-full max-w-md bg-white rounded-xl shadow-sm border border-gray-200 p-8">
        <div className="text-center space-y-3 mb-6">
          <div className="flex items-center justify-center gap-2">
            <Image src={whitelabel.logoPath} alt={whitelabel.pageTitle} width={28} height={28} className="h-7 w-auto" />
            <span className="text-lg font-semibold text-gray-900 tracking-tight">{whitelabel.pageTitle}</span>
          </div>
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-brand-fainter">
            <ShieldCheck className="h-6 w-6 text-brand-default" />
          </div>
          <h1 className="text-xl font-medium text-gray-900">Authorize access</h1>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-8 text-gray-500 text-sm">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            Loading authorization request...
          </div>
        ) : error ? (
          <div
            className="rounded-lg px-4 py-3 text-sm bg-accent-maroon-light text-accent-maroon-dark border border-accent-maroon-dark/20 text-center"
            role="alert"
          >
            {error}
          </div>
        ) : (
          <div className="space-y-6">
            <p className="text-sm text-center text-gray-600">
              <span className="font-medium text-gray-900">{clientName}</span> wants to access your{' '}
              {whitelabel.pageTitle} account{userEmail ? ` (${userEmail})` : ''}.{' '}
              {isAdmin
                ? 'It will be able to read the investor database and add or update investors and fundings on your behalf.'
                : 'It will be able to read the investor database on your behalf.'}
            </p>

            <div className="flex gap-3">
              <button
                type="button"
                disabled={submitting !== null}
                onClick={() => decide('deny')}
                className="flex-1 py-2.5 px-4 rounded-lg text-sm font-medium text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting === 'deny' ? <Loader2 className="h-4 w-4 animate-spin mx-auto" /> : 'Deny'}
              </button>
              <button
                type="button"
                disabled={submitting !== null}
                onClick={() => decide('approve')}
                className="flex-1 py-2.5 px-4 rounded-lg text-sm font-medium text-white bg-brand-default hover:bg-brand-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-brand-default transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting === 'approve' ? <Loader2 className="h-4 w-4 animate-spin mx-auto" /> : 'Approve'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function OAuthConsent() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-secondary-default">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-default"></div>
        </div>
      }
    >
      <OAuthConsentInner />
    </Suspense>
  );
}
