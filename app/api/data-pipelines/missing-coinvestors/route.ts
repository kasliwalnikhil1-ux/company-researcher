import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

/** Allowed user IDs (same as ME Data) */
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

/** Regex for [name](url) format */
const NAME_URL_REGEX = /^\[([^\]]+)\]\(([^)]+)\)$/;

interface ParsedCoinvestor {
  raw: string;
  name: string;
  url: string;
  type: 'domain' | 'linkedin';
  /** Cleaned domain (e.g. accel.com) or linkedin path (e.g. in/namankas) */
  identifier: string;
}

function parseCoinvestorEntry(entry: string): ParsedCoinvestor | null {
  const match = entry.trim().match(NAME_URL_REGEX);
  if (!match) return null;
  const name = match[1];
  const urlRaw = match[2].trim();
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
      return { raw: entry, name, url: urlRaw, type: 'linkedin', identifier: path };
    } else {
      if (host && /[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(host)) {
        return { raw: entry, name, url: urlRaw, type: 'domain', identifier: host };
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

    // Step 1: Fetch all investors with non-null coinvestors
    // We select: id, name, coinvestors, domain, linkedin_url
    const { data: investors, error: fetchError } = await supabase
      .from('investors')
      .select('id, name, coinvestors')
      .not('coinvestors', 'is', null);

    if (fetchError) {
      console.error('Failed to fetch investors:', fetchError);
      return NextResponse.json({ error: 'Failed to fetch investors' }, { status: 500 });
    }

    // Step 2: Flatten and deduplicate all coinvestor entries
    // Map: identifier -> { parsed info, sourceInvestors: [investor names that reference this co-investor] }
    const coinvestorMap = new Map<
      string,
      ParsedCoinvestor & { sourceInvestors: string[]; count: number }
    >();

    for (const inv of investors || []) {
      const coinvestors = inv.coinvestors as string[] | null;
      if (!Array.isArray(coinvestors)) continue;
      for (const entry of coinvestors) {
        const parsed = parseCoinvestorEntry(entry);
        if (!parsed) continue;
        const key = `${parsed.type}:${parsed.identifier}`;
        const existing = coinvestorMap.get(key);
        if (existing) {
          existing.count += 1;
          if (!existing.sourceInvestors.includes(inv.name)) {
            existing.sourceInvestors.push(inv.name);
          }
        } else {
          coinvestorMap.set(key, {
            ...parsed,
            sourceInvestors: [inv.name],
            count: 1,
          });
        }
      }
    }

    // Step 3: Fetch all existing domains and linkedin URLs from the investors table
    const { data: existingDomains, error: domainError } = await supabase
      .from('investors')
      .select('domain')
      .not('domain', 'is', null);

    if (domainError) {
      console.error('Failed to fetch existing domains:', domainError);
      return NextResponse.json({ error: 'Failed to fetch existing domains' }, { status: 500 });
    }

    const { data: existingLinkedins, error: linkedinError } = await supabase
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
        // linkedin_url could be a full URL or a path like "in/username"
        const url = row.linkedin_url.toLowerCase();
        const match = url.match(/linkedin\.com\/(.+)/);
        if (match) {
          existingLinkedinSet.add(match[1].replace(/^\/+/, '').replace(/\/+$/, ''));
        } else {
          existingLinkedinSet.add(url.replace(/^\/+/, '').replace(/\/+$/, ''));
        }
      }
    }

    // Step 4: Find missing coinvestors
    const missing: Array<{
      name: string;
      url: string;
      type: 'domain' | 'linkedin';
      identifier: string;
      count: number;
      sourceInvestors: string[];
    }> = [];

    for (const [, entry] of coinvestorMap) {
      if (entry.type === 'domain') {
        if (!existingDomainSet.has(entry.identifier.toLowerCase())) {
          missing.push({
            name: entry.name,
            url: entry.url,
            type: entry.type,
            identifier: entry.identifier,
            count: entry.count,
            sourceInvestors: entry.sourceInvestors,
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
            sourceInvestors: entry.sourceInvestors,
          });
        }
      }
    }

    // Sort by count descending (most referenced first)
    missing.sort((a, b) => b.count - a.count);

    return NextResponse.json({
      totalCoinvestorEntries: coinvestorMap.size,
      totalInvestorsWithCoinvestors: (investors || []).length,
      existingDomainCount: existingDomainSet.size,
      existingLinkedinCount: existingLinkedinSet.size,
      missingCount: missing.length,
      missing,
    });
  } catch (error) {
    console.error('data-pipelines/missing-coinvestors error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
