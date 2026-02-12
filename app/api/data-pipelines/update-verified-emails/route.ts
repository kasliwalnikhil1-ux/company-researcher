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

export const maxDuration = 120;

/**
 * Normalize a LinkedIn URL to a short path like "in/namankas" for matching.
 * Handles full URLs, partial paths, etc.
 */
function normalizeLinkedInUrl(url: string): string {
  let cleaned = url.trim();
  if (!cleaned) return '';
  // Remove protocol and domain
  cleaned = cleaned.replace(/^https?:\/\/(www\.)?linkedin\.com\/?/i, '');
  // Remove leading/trailing slashes
  cleaned = cleaned.replace(/^\/+|\/+$/g, '');
  return cleaned.toLowerCase();
}

interface MasterRow {
  linkedin_url: string;
  work_email: string;
  personal_email: string;
  work_phone: string;
  personal_phone: string;
  twitter_nickname: string;
  about: string;
}

/**
 * POST /api/data-pipelines/update-verified-emails
 *
 * Accept parsed master CSV rows and update matching investors.
 * Body: { rows: MasterRow[] }
 *
 * For each row:
 *   1. Normalize LinkedIn URL and match to investor
 *   2. Set email_verified = true (always)
 *   3. Set email = comma-separated Work Email + Personal Email (lowercase), only if at least one is non-empty
 *   4. Set phone = comma-separated Work Phone + Personal Phone, only if at least one is non-empty
 *   5. Set twitter_url from Twitter Nickname, only if non-empty in master
 *
 * If master col is empty but original has data, don't overwrite (except email_verified).
 *
 * Returns: { total, matched, updated, notFound, failed, results[] }
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
    const rows: MasterRow[] = body.rows;

    if (!Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json({ error: 'No rows provided' }, { status: 400 });
    }

    const supabase = getServiceClient();

    // Fetch all person-type investors with linkedin_url for matching
    const allInvestors: Array<{
      id: string;
      linkedin_url: string | null;
      email: string | null;
      phone: string | null;
      twitter_url: string | null;
    }> = [];

    // Paginate fetch in case of many investors
    const pageSize = 1000;
    let from = 0;
    let hasMore = true;

    while (hasMore) {
      const { data, error: fetchError } = await supabase
        .from('investors')
        .select('id, linkedin_url, email, phone, twitter_url')
        .eq('type', 'person')
        .not('linkedin_url', 'is', null)
        .range(from, from + pageSize - 1);

      if (fetchError) {
        console.error('Failed to fetch investors:', fetchError);
        return NextResponse.json({ error: 'Failed to fetch investors' }, { status: 500 });
      }

      if (data && data.length > 0) {
        allInvestors.push(...data);
        from += pageSize;
        hasMore = data.length === pageSize;
      } else {
        hasMore = false;
      }
    }

    // Build map: normalized linkedin path -> investor
    const investorMap = new Map<
      string,
      { id: string; email: string | null; phone: string | null; twitter_url: string | null }
    >();
    for (const inv of allInvestors) {
      if (inv.linkedin_url) {
        const normalized = normalizeLinkedInUrl(inv.linkedin_url);
        if (normalized) {
          investorMap.set(normalized, inv);
        }
      }
    }

    const results: Array<{
      linkedin_url: string;
      status: 'updated' | 'not_found' | 'failed' | 'skipped';
      investorId?: string;
      message?: string;
    }> = [];
    let matched = 0;
    let updated = 0;
    let notFound = 0;
    let failed = 0;

    for (const row of rows) {
      const normalizedUrl = normalizeLinkedInUrl(row.linkedin_url);
      if (!normalizedUrl) {
        results.push({ linkedin_url: row.linkedin_url, status: 'skipped', message: 'Empty LinkedIn URL' });
        continue;
      }

      const investor = investorMap.get(normalizedUrl);

      if (!investor) {
        notFound++;
        results.push({ linkedin_url: row.linkedin_url, status: 'not_found' });
        continue;
      }

      matched++;

      // Build email: combine Work Email + Personal Email, lowercase, comma-separated
      const newEmails: string[] = [];
      if (row.work_email?.trim()) newEmails.push(row.work_email.trim().toLowerCase());
      if (row.personal_email?.trim()) newEmails.push(row.personal_email.trim().toLowerCase());

      // Build phone: combine Work Phone + Personal Phone, comma-separated
      // Strip formatting characters (dots, dashes, spaces, parentheses) keeping only digits and leading +
      const cleanPhone = (raw: string): string => {
        const trimmed = raw.trim();
        if (!trimmed) return '';
        const hasPlus = trimmed.startsWith('+');
        const digits = trimmed.replace(/[^0-9]/g, '');
        return digits ? (hasPlus ? '+' : '') + digits : '';
      };
      const newPhones: string[] = [];
      const wp = cleanPhone(row.work_phone || '');
      const pp = cleanPhone(row.personal_phone || '');
      if (wp) newPhones.push(wp);
      if (pp) newPhones.push(pp);

      // Build update object
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const updateObj: Record<string, any> = {
        email_verified: true, // Always set to true
      };

      // Only update email if master has at least one non-empty email
      if (newEmails.length > 0) {
        updateObj.email = newEmails.join(', ');
      }
      // If master emails are all empty, keep existing email unchanged

      // Only update phone if master has at least one non-empty phone
      if (newPhones.length > 0) {
        updateObj.phone = newPhones.join(', ');
      }
      // If master phones are all empty, keep existing phone unchanged

      // Only update twitter_url if master has a non-empty Twitter Nickname
      if (row.twitter_nickname?.trim()) {
        const nickname = row.twitter_nickname.trim().replace(/^@/, '');
        updateObj.twitter_url = `https://x.com/${nickname}`;
      }
      // If master twitter is empty, keep existing twitter_url unchanged

      const { error: updateError } = await supabase
        .from('investors')
        .update(updateObj)
        .eq('id', investor.id);

      if (updateError) {
        console.error(`Failed to update investor ${investor.id}:`, updateError);
        results.push({ linkedin_url: row.linkedin_url, status: 'failed', investorId: investor.id, message: updateError.message });
        failed++;
      } else {
        results.push({ linkedin_url: row.linkedin_url, status: 'updated', investorId: investor.id });
        updated++;
      }
    }

    return NextResponse.json({
      total: rows.length,
      matched,
      updated,
      notFound,
      failed,
      results,
    });
  } catch (error) {
    console.error('data-pipelines/update-verified-emails error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
