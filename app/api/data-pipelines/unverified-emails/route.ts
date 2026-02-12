import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

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

/** Service role client for data queries (bypasses RLS) */
function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) throw new Error('Missing Supabase service role key');
  return createClient(url, key);
}

/**
 * POST /api/data-pipelines/unverified-emails
 *
 * Find all investors of type 'person' whose email_verified is false or null.
 * Returns: { count, investors: { id, name, linkedin_url, email, email_verified, firm_domain }[] }
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

    // Use service role client for data queries (bypasses RLS)
    const supabase = getServiceClient();

    // Fetch all person-type investors where email_verified is false or null
    const { data: investors, error: fetchError } = await supabase
      .from('investors')
      .select('id, name, linkedin_url, email, email_verified')
      .eq('type', 'person')
      .or('email_verified.is.null,email_verified.eq.false')
      .order('email', { ascending: true, nullsFirst: false });

    if (fetchError) {
      console.error('Failed to fetch unverified email investors:', fetchError);
      return NextResponse.json({ error: 'Failed to fetch investors' }, { status: 500 });
    }

    const personIds = (investors || []).map((inv) => inv.id);

    // Fetch firm domains via investor_affiliations for all these person IDs
    // person_id -> firm_id, then get domain from the firm investor row
    const firmDomainMap = new Map<string, string>();

    if (personIds.length > 0) {
      // Batch in small chunks to avoid HeadersOverflowError (UUIDs in .in() go into URL params)
      const chunkSize = 50;

      // First collect all affiliations
      const allAffiliations: Array<{ person_id: string; firm_id: string }> = [];
      for (let i = 0; i < personIds.length; i += chunkSize) {
        const chunk = personIds.slice(i, i + chunkSize);
        const { data: affiliations, error: affError } = await supabase
          .from('investor_affiliations')
          .select('person_id, firm_id')
          .in('person_id', chunk);

        if (affError) {
          console.error('Failed to fetch affiliations:', affError);
          continue;
        }

        if (affiliations) allAffiliations.push(...affiliations);
      }

      if (allAffiliations.length > 0) {
        // Collect unique firm IDs and fetch their domains in batches
        const allFirmIds = [...new Set(allAffiliations.map((a) => a.firm_id))];
        const firmIdToDomain = new Map<string, string>();

        for (let i = 0; i < allFirmIds.length; i += chunkSize) {
          const firmChunk = allFirmIds.slice(i, i + chunkSize);
          const { data: firms, error: firmError } = await supabase
            .from('investors')
            .select('id, domain')
            .in('id', firmChunk);

          if (firmError) {
            console.error('Failed to fetch firm domains:', firmError);
            continue;
          }

          for (const firm of firms || []) {
            if (firm.domain) firmIdToDomain.set(firm.id, firm.domain);
          }
        }

        // Map person_id -> first available firm domain
        for (const aff of allAffiliations) {
          if (!firmDomainMap.has(aff.person_id)) {
            const domain = firmIdToDomain.get(aff.firm_id);
            if (domain) firmDomainMap.set(aff.person_id, domain);
          }
        }
      }
    }

    // Attach firm_domain to each investor
    const investorsWithFirm = (investors || []).map((inv) => ({
      ...inv,
      firm_domain: firmDomainMap.get(inv.id) || null,
    }));

    return NextResponse.json({
      count: investorsWithFirm.length,
      investors: investorsWithFirm,
    });
  } catch (error) {
    console.error('data-pipelines/unverified-emails error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
