import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const INVESTOR_SEARCH_URL = 'https://ktwqkvjuzsunssudqnrt.supabase.co/functions/v1/investor-search';

/** Allowed user IDs (same as Data Pipelines page) */
const ALLOWED_USER_IDS = new Set([
  '2793f3da-9340-44f4-b285-b7836bfb8591',
  'e25d5e21-13fd-46ee-a39a-4c3386b77b65',
]);

/** Auth client (anon key + user token) for verifying user identity */
function getAuthClient(accessToken: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  if (!url || !anonKey) throw new Error('Missing Supabase environment variables');
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

export const maxDuration = 60;

/**
 * POST /api/data-pipelines/rerun-contacts/fetch-contacts
 *
 * Fetch contacts for a firm by calling INVESTOR_SEARCH_URL with the firm domain.
 * Body: { firmId: string, domain: string }
 * Returns: { firmId, domain, contactCount, contacts[] }
 */
export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get('Authorization');
    const token = authHeader?.replace(/^Bearer\s+/i, '');
    if (!token) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    // Auth check with anon key
    const authClient = getAuthClient(token);
    const {
      data: { user },
      error: authError,
    } = await authClient.auth.getUser(token);

    if (authError || !user) {
      return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });
    }

    if (!ALLOWED_USER_IDS.has(user.id)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const { firmId, domain } = body;

    if (!firmId || !domain) {
      return NextResponse.json({ error: 'firmId and domain are required' }, { status: 400 });
    }

    // Call investor-search to find contacts for this firm
    console.log('[rerun-contacts] Fetching contacts for firm:', domain);

    const investorSearchRes = await fetch(INVESTOR_SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain }),
    });

    if (!investorSearchRes.ok) {
      const errText = await investorSearchRes.text();
      console.error('[rerun-contacts] investor-search failed:', investorSearchRes.status, errText.substring(0, 300));
      return NextResponse.json(
        { error: 'Failed to fetch contacts from investor-search', details: errText.substring(0, 500) },
        { status: 502 }
      );
    }

    const investorSearchData = await investorSearchRes.json();
    const results = Array.isArray(investorSearchData?.results) ? investorSearchData.results : [];

    console.log('[rerun-contacts] Got', results.length, 'raw contacts for domain:', domain);

    // Format contacts - only include those with a LinkedIn URL
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contacts = results
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((c: any) => c?.linkedin_url && typeof c.linkedin_url === 'string')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((c: any) => {
        const linkedInInput = c.linkedin_url.startsWith('http')
          ? c.linkedin_url
          : `https://www.linkedin.com/${c.linkedin_url.replace(/^\//, '')}`;
        return {
          full_name: c.full_name || null,
          linkedin_url: c.linkedin_url,
          input: linkedInInput,
          email: c.email && c.email_status === 'verified' ? c.email : null,
          title: c.title || null,
        };
      });

    console.log('[rerun-contacts] Returning', contacts.length, 'contacts with LinkedIn for firm:', domain);

    return NextResponse.json({
      firmId,
      domain,
      contactCount: contacts.length,
      totalResults: results.length,
      contacts,
    });
  } catch (error) {
    console.error('fetch-contacts error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
