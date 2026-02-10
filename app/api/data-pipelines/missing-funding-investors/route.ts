import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

/** Allowed user IDs (same as ME Data / Data Pipelines) */
const ALLOWED_USER_IDS = new Set([
  '2793f3da-9340-44f4-b285-b7836bfb8591',
  'e25d5e21-13fd-46ee-a39a-4c3386b77b65',
]);

function getSupabaseClient(accessToken?: string) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Missing Supabase environment variables');
  }
  const options = accessToken
    ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } }
    : {};
  return createClient(supabaseUrl, supabaseAnonKey, options);
}

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) throw new Error('Missing Supabase service role key');
  return createClient(url, key);
}

interface FundingInvestor {
  name: string;
  url?: string;
}

interface ParsedFundingInvestor {
  name: string;
  url: string;
  type: 'domain' | 'linkedin';
  /** Cleaned domain (e.g. accel.com) or linkedin path (e.g. in/namankas) */
  identifier: string;
}

function parseFundingInvestor(inv: FundingInvestor): ParsedFundingInvestor | null {
  if (!inv.url) return null;
  const urlRaw = inv.url.trim();
  if (!urlRaw) return null;

  try {
    const href = urlRaw.startsWith('http') ? urlRaw : `https://${urlRaw}`;
    const parsed = new URL(href);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');

    if (host.includes('linkedin.com')) {
      const path = (parsed.pathname || '')
        .toLowerCase()
        .replace(/^\/+/, '')
        .replace(/\/+$/, '');
      if (!path) return null;
      return { name: inv.name, url: urlRaw, type: 'linkedin', identifier: path };
    } else {
      if (host && /[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(host)) {
        return { name: inv.name, url: urlRaw, type: 'domain', identifier: host };
      }
    }
  } catch {
    // ignore invalid URLs
  }
  return null;
}

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get('Authorization');
    const token = authHeader?.replace(/^Bearer\s+/i, '');
    if (!token) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const supabase = getSupabaseClient(token);
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(token);

    if (authError || !user) {
      return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });
    }

    if (!ALLOWED_USER_IDS.has(user.id)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Step 1: Fetch all rows from new_fundings with non-null investors
    const service = getServiceClient();
    const { data: fundings, error: fetchError } = await service
      .from('new_fundings')
      .select('id, name, domain, investors, funding_date')
      .not('investors', 'is', null);

    if (fetchError) {
      console.error('Failed to fetch new_fundings:', fetchError);
      return NextResponse.json({ error: 'Failed to fetch new_fundings' }, { status: 500 });
    }

    // Step 2: Flatten and deduplicate all investor entries
    // Map: identifier -> { parsed info, sourceFundings: [company names that reference this investor] }
    const investorMap = new Map<
      string,
      ParsedFundingInvestor & { sourceFundings: string[]; count: number }
    >();

    let totalInvestorEntries = 0;

    for (const funding of fundings || []) {
      const investors = funding.investors as FundingInvestor[] | null;
      if (!Array.isArray(investors)) continue;
      for (const inv of investors) {
        totalInvestorEntries++;
        const parsed = parseFundingInvestor(inv);
        if (!parsed) continue;
        const key = `${parsed.type}:${parsed.identifier}`;
        const existing = investorMap.get(key);
        if (existing) {
          existing.count += 1;
          const fundingName = funding.name || funding.domain || 'Unknown';
          if (!existing.sourceFundings.includes(fundingName)) {
            existing.sourceFundings.push(fundingName);
          }
        } else {
          const fundingName = funding.name || funding.domain || 'Unknown';
          investorMap.set(key, {
            ...parsed,
            sourceFundings: [fundingName],
            count: 1,
          });
        }
      }
    }

    // Step 3: Fetch all existing domains and linkedin URLs from the investors table
    const { data: existingDomains, error: domainError } = await service
      .from('investors')
      .select('domain')
      .not('domain', 'is', null);

    if (domainError) {
      console.error('Failed to fetch existing domains:', domainError);
      return NextResponse.json({ error: 'Failed to fetch existing domains' }, { status: 500 });
    }

    const { data: existingLinkedins, error: linkedinError } = await service
      .from('investors')
      .select('linkedin_url')
      .not('linkedin_url', 'is', null);

    if (linkedinError) {
      console.error('Failed to fetch existing linkedin URLs:', linkedinError);
      return NextResponse.json({ error: 'Failed to fetch existing linkedin URLs' }, { status: 500 });
    }

    // Build sets of existing identifiers
    const existingDomainSet = new Set<string>();
    for (const row of existingDomains || []) {
      if (row.domain) {
        existingDomainSet.add(row.domain.toLowerCase());
      }
    }

    const existingLinkedinSet = new Set<string>();
    for (const row of existingLinkedins || []) {
      if (row.linkedin_url) {
        const url = row.linkedin_url.toLowerCase();
        const match = url.match(/linkedin\.com\/(.+)/);
        if (match) {
          existingLinkedinSet.add(match[1].replace(/^\/+/, '').replace(/\/+$/, ''));
        } else {
          existingLinkedinSet.add(url.replace(/^\/+/, '').replace(/\/+$/, ''));
        }
      }
    }

    // Step 4: Find missing investors
    const missing: Array<{
      name: string;
      url: string;
      type: 'domain' | 'linkedin';
      identifier: string;
      count: number;
      sourceFundings: string[];
    }> = [];

    for (const [, entry] of investorMap) {
      if (entry.type === 'domain') {
        if (!existingDomainSet.has(entry.identifier.toLowerCase())) {
          missing.push({
            name: entry.name,
            url: entry.url,
            type: entry.type,
            identifier: entry.identifier,
            count: entry.count,
            sourceFundings: entry.sourceFundings,
          });
        }
      } else if (entry.type === 'linkedin') {
        if (!existingLinkedinSet.has(entry.identifier.toLowerCase())) {
          missing.push({
            name: entry.name,
            url: entry.url,
            type: entry.type,
            identifier: entry.identifier,
            count: entry.count,
            sourceFundings: entry.sourceFundings,
          });
        }
      }
    }

    // Sort by count descending (most referenced first)
    missing.sort((a, b) => b.count - a.count);

    return NextResponse.json({
      totalFundings: (fundings || []).length,
      totalInvestorEntries,
      uniqueInvestorEntries: investorMap.size,
      existingDomainCount: existingDomainSet.size,
      existingLinkedinCount: existingLinkedinSet.size,
      missingCount: missing.length,
      missing,
    });
  } catch (error) {
    console.error('data-pipelines/missing-funding-investors error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
