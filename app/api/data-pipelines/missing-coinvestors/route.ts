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

    // Step 1: Fetch all investors with non-null coinvestors (paginated to avoid Supabase 1000-row default limit)
    const PAGE_SIZE = 1000;
    const allInvestors: { id: string; name: string; coinvestors: string[] | null }[] = [];
    let offset = 0;
    while (true) {
      const { data: page, error: fetchError } = await supabase
        .from('investors')
        .select('id, name, coinvestors')
        .not('coinvestors', 'is', null)
        .range(offset, offset + PAGE_SIZE - 1);

      if (fetchError) {
        console.error('Failed to fetch investors:', fetchError);
        return NextResponse.json({ error: 'Failed to fetch investors' }, { status: 500 });
      }
      if (!page || page.length === 0) break;
      allInvestors.push(...page);
      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    // Step 2: Flatten and deduplicate all coinvestor entries
    // Map: identifier -> { parsed info, sourceInvestors: [investor names that reference this co-investor] }
    const coinvestorMap = new Map<
      string,
      ParsedCoinvestor & { sourceInvestors: string[]; count: number }
    >();

    for (const inv of allInvestors) {
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

    // Step 3: Check which co-investor identifiers already exist in the investors table
    // AND the not_an_investor table, using batched .in() queries (same pattern as filter-existing)
    // to avoid the Supabase default 1000-row limit on .select() queries.

    // Separate domain and linkedin identifiers
    const domainIdentifiers: string[] = [];
    const linkedinIdentifiers: string[] = [];
    for (const [, entry] of coinvestorMap) {
      if (entry.type === 'domain') {
        domainIdentifiers.push(entry.identifier.toLowerCase());
      } else if (entry.type === 'linkedin') {
        linkedinIdentifiers.push(entry.identifier.toLowerCase());
      }
    }

    // Check domains against investors table (batched .in() queries)
    const BATCH_SIZE = 100;
    const existingDomainSet = new Set<string>();
    for (let i = 0; i < domainIdentifiers.length; i += BATCH_SIZE) {
      const batch = domainIdentifiers.slice(i, i + BATCH_SIZE);
      const { data, error } = await supabase
        .from('investors')
        .select('domain')
        .in('domain', batch);
      if (error) {
        console.error('Failed to check investor domains batch:', error);
        continue;
      }
      if (data) {
        for (const row of data) {
          if (row.domain) existingDomainSet.add(row.domain.toLowerCase());
        }
      }
    }

    // Check domains against not_an_investor table
    const notInvestorDomainSet = new Set<string>();
    for (let i = 0; i < domainIdentifiers.length; i += BATCH_SIZE) {
      const batch = domainIdentifiers.slice(i, i + BATCH_SIZE);
      const { data, error } = await supabase
        .from('not_an_investor')
        .select('domain')
        .in('domain', batch);
      if (error) {
        console.error('Failed to check not_an_investor domains batch:', error);
        continue;
      }
      if (data) {
        for (const row of data) {
          if (row.domain) notInvestorDomainSet.add(row.domain.toLowerCase());
        }
      }
    }

    // Check linkedin URLs against investors table (batched .in() queries)
    const existingLinkedinSet = new Set<string>();
    for (let i = 0; i < linkedinIdentifiers.length; i += BATCH_SIZE) {
      const batch = linkedinIdentifiers.slice(i, i + BATCH_SIZE);
      const { data, error } = await supabase
        .from('investors')
        .select('linkedin_url')
        .in('linkedin_url', batch);
      if (error) {
        console.error('Failed to check investor linkedin batch:', error);
        continue;
      }
      if (data) {
        for (const row of data) {
          if (row.linkedin_url) existingLinkedinSet.add(row.linkedin_url.toLowerCase());
        }
      }
    }

    // Check linkedin URLs against not_an_investor table
    const notInvestorLinkedinSet = new Set<string>();
    for (let i = 0; i < linkedinIdentifiers.length; i += BATCH_SIZE) {
      const batch = linkedinIdentifiers.slice(i, i + BATCH_SIZE);
      const { data, error } = await supabase
        .from('not_an_investor')
        .select('linkedin_url')
        .in('linkedin_url', batch);
      if (error) {
        console.error('Failed to check not_an_investor linkedin batch:', error);
        continue;
      }
      if (data) {
        for (const row of data) {
          if (row.linkedin_url) notInvestorLinkedinSet.add(row.linkedin_url.toLowerCase());
        }
      }
    }

    // Step 4: Find missing coinvestors (not in investors table AND not in not_an_investor table)
    const missing: Array<{
      name: string;
      url: string;
      type: 'domain' | 'linkedin';
      identifier: string;
      count: number;
      sourceInvestors: string[];
    }> = [];

    for (const [, entry] of coinvestorMap) {
      const id = entry.identifier.toLowerCase();
      if (entry.type === 'domain') {
        if (!existingDomainSet.has(id) && !notInvestorDomainSet.has(id)) {
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
        if (!existingLinkedinSet.has(id) && !notInvestorLinkedinSet.has(id)) {
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
      totalInvestorsWithCoinvestors: allInvestors.length,
      existingDomainCount: existingDomainSet.size,
      existingLinkedinCount: existingLinkedinSet.size,
      notInvestorDomainCount: notInvestorDomainSet.size,
      notInvestorLinkedinCount: notInvestorLinkedinSet.size,
      missingCount: missing.length,
      missing,
    });
  } catch (error) {
    console.error('data-pipelines/missing-coinvestors error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
