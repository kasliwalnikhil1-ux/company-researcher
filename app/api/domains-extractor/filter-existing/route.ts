import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

/** Allowed user IDs */
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
 * POST /api/domains-extractor/filter-existing
 *
 * Takes arrays of domains and LinkedIn URLs, checks which ones already exist
 * in the `investors` table OR the `not_an_investor` table, and returns only
 * the ones that do NOT exist in either table.
 *
 * Body: { domains: string[], linkedinUrls: string[] }
 * Returns: { domains, linkedinUrls, removedDomains, removedLinkedIn,
 *            removedDomainsInvestors, removedDomainsNotInvestor,
 *            removedLinkedInInvestors, removedLinkedInNotInvestor }
 */
export async function POST(req: NextRequest) {
  try {
    // --- Auth ---
    const authHeader = req.headers.get('authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) {
      return NextResponse.json({ error: 'Missing authorization token' }, { status: 401 });
    }

    const authClient = getAuthClient(token);
    const { data: { user }, error: authError } = await authClient.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!ALLOWED_USER_IDS.has(user.id)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // --- Parse body ---
    const body = await req.json();
    const domains: string[] = Array.isArray(body.domains) ? body.domains : [];
    const linkedinUrls: string[] = Array.isArray(body.linkedinUrls) ? body.linkedinUrls : [];

    if (domains.length === 0 && linkedinUrls.length === 0) {
      return NextResponse.json({ domains: [], linkedinUrls: [], removedDomains: 0, removedLinkedIn: 0 });
    }

    const supabase = getServiceClient();

    // --- Check domains in batches ---
    // Batch size kept small to avoid HeadersOverflowError:
    // Supabase .in() encodes all values into the URL query string, which can
    // exceed Node's default HTTP header size limit with long values.
    const existingDomains = new Set<string>();
    const DOMAIN_BATCH = 100;

    for (let i = 0; i < domains.length; i += DOMAIN_BATCH) {
      const batch = domains.slice(i, i + DOMAIN_BATCH);
      const { data, error } = await supabase
        .from('investors')
        .select('domain')
        .in('domain', batch);

      if (error) {
        console.error('Error querying domains:', error);
        continue;
      }
      if (data) {
        for (const row of data) {
          if (row.domain) existingDomains.add(row.domain.toLowerCase());
        }
      }
    }

    // --- Check LinkedIn URLs in batches ---
    // The DB stores LinkedIn as path-only (e.g. "in/john-smith"), but the frontend
    // may send full URLs (e.g. "https://www.linkedin.com/in/john-smith").
    // Normalize to path-only for querying, then map results back.
    const toLinkedInPath = (url: string): string => {
      try {
        if (url.startsWith('http')) {
          const u = new URL(url);
          return u.pathname.replace(/^\/+|\/+$/g, '');
        }
      } catch { /* not a valid URL, treat as path */ }
      return url.replace(/^\/+|\/+$/g, '');
    };

    // Build a map: normalized path (lowercase) -> original full URLs from input
    const pathToOriginals = new Map<string, string[]>();
    for (const url of linkedinUrls) {
      const path = toLinkedInPath(url).toLowerCase();
      if (!pathToOriginals.has(path)) pathToOriginals.set(path, []);
      pathToOriginals.get(path)!.push(url);
    }

    const existingLinkedInPaths = new Set<string>();
    const LINKEDIN_BATCH = 50;
    const allPaths = Array.from(pathToOriginals.keys());

    for (let i = 0; i < allPaths.length; i += LINKEDIN_BATCH) {
      const batch = allPaths.slice(i, i + LINKEDIN_BATCH);
      const { data, error } = await supabase
        .from('investors')
        .select('linkedin_url')
        .in('linkedin_url', batch);

      if (error) {
        console.error('Error querying LinkedIn URLs:', error);
        continue;
      }
      if (data) {
        for (const row of data) {
          if (row.linkedin_url) existingLinkedInPaths.add(row.linkedin_url.toLowerCase());
        }
      }
    }

    // --- Check domains in not_an_investor table ---
    const notInvestorDomains = new Set<string>();

    for (let i = 0; i < domains.length; i += DOMAIN_BATCH) {
      const batch = domains.slice(i, i + DOMAIN_BATCH);
      const { data, error } = await supabase
        .from('not_an_investor')
        .select('domain')
        .in('domain', batch);

      if (error) {
        console.error('Error querying not_an_investor domains:', error);
        continue;
      }
      if (data) {
        for (const row of data) {
          if (row.domain) notInvestorDomains.add(row.domain.toLowerCase());
        }
      }
    }

    // --- Check LinkedIn URLs in not_an_investor table ---
    const notInvestorLinkedInPaths = new Set<string>();

    for (let i = 0; i < allPaths.length; i += LINKEDIN_BATCH) {
      const batch = allPaths.slice(i, i + LINKEDIN_BATCH);
      const { data, error } = await supabase
        .from('not_an_investor')
        .select('linkedin_url')
        .in('linkedin_url', batch);

      if (error) {
        console.error('Error querying not_an_investor LinkedIn URLs:', error);
        continue;
      }
      if (data) {
        for (const row of data) {
          if (row.linkedin_url) notInvestorLinkedInPaths.add(row.linkedin_url.toLowerCase());
        }
      }
    }

    // --- Filter out existing (from both investors and not_an_investor tables) ---
    const remainingDomains = domains.filter(d => {
      const lower = d.toLowerCase();
      return !existingDomains.has(lower) && !notInvestorDomains.has(lower);
    });
    const remainingLinkedIn = linkedinUrls.filter(l => {
      const path = toLinkedInPath(l).toLowerCase();
      return !existingLinkedInPaths.has(path) && !notInvestorLinkedInPaths.has(path);
    });

    // Compute per-table removal counts
    const removedDomainsInvestors = domains.filter(d => existingDomains.has(d.toLowerCase())).length;
    const removedDomainsNotInvestor = domains.filter(d => !existingDomains.has(d.toLowerCase()) && notInvestorDomains.has(d.toLowerCase())).length;
    const removedLinkedInInvestors = linkedinUrls.filter(l => existingLinkedInPaths.has(toLinkedInPath(l).toLowerCase())).length;
    const removedLinkedInNotInvestor = linkedinUrls.filter(l => !existingLinkedInPaths.has(toLinkedInPath(l).toLowerCase()) && notInvestorLinkedInPaths.has(toLinkedInPath(l).toLowerCase())).length;

    return NextResponse.json({
      domains: remainingDomains,
      linkedinUrls: remainingLinkedIn,
      removedDomains: domains.length - remainingDomains.length,
      removedLinkedIn: linkedinUrls.length - remainingLinkedIn.length,
      removedDomainsInvestors,
      removedDomainsNotInvestor,
      removedLinkedInInvestors,
      removedLinkedInNotInvestor,
    });
  } catch (err: any) {
    console.error('filter-existing error:', err);
    return NextResponse.json({ error: err?.message || 'Internal server error' }, { status: 500 });
  }
}
