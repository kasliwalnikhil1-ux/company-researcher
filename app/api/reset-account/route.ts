// /app/api/reset-account/route.ts
// Reset account: clear onboarding, investor_personalization, message_templates
// Limited to RESET_ACCOUNT_ALLOWED_USER_IDS (same as ME Data users)

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const RESET_ACCOUNT_ALLOWED_USER_IDS = new Set([
  '2793f3da-9340-44f4-b285-b7836bfb8591',
  'e25d5e21-13fd-46ee-a39a-4c3386b77b65',
]);

function getSupabaseServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key);
}

function getSupabaseAuthClient(accessToken: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get('Authorization');
    const token = authHeader?.replace(/^Bearer\s+/i, '');

    if (!token) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const authClient = getSupabaseAuthClient(token);
    if (!authClient) {
      return NextResponse.json({ error: 'Auth not configured' }, { status: 500 });
    }

    const { data: { user }, error: authError } = await authClient.auth.getUser(token);
    if (authError || !user) {
      return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });
    }

    if (!RESET_ACCOUNT_ALLOWED_USER_IDS.has(user.id)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const supabase = getSupabaseServiceClient();
    if (!supabase) {
      return NextResponse.json({ error: 'Database not configured' }, { status: 500 });
    }

    // 1. Set user_settings.onboarding to null
    const { data: existing } = await supabase
      .from('user_settings')
      .select('personalization, owners, email_settings, column_settings')
      .eq('id', user.id)
      .maybeSingle();

    const payload = {
      id: user.id,
      personalization: existing?.personalization ?? null,
      owners: existing?.owners ?? null,
      email_settings: existing?.email_settings ?? null,
      column_settings: existing?.column_settings ?? null,
      onboarding: null,
    };

    const { error: upsertError } = await supabase
      .from('user_settings')
      .upsert(payload, { onConflict: 'id' });

    if (upsertError) {
      console.error('[reset-account] user_settings upsert error:', upsertError);
      return NextResponse.json({ error: 'Failed to reset onboarding', details: upsertError.message }, { status: 500 });
    }

    // 2. Delete all investor_personalization for this user
    const { error: deleteIpError } = await supabase
      .from('investor_personalization')
      .delete()
      .eq('user_id', user.id);

    if (deleteIpError) {
      console.error('[reset-account] investor_personalization delete error:', deleteIpError);
      return NextResponse.json({ error: 'Failed to reset investor personalization', details: deleteIpError.message }, { status: 500 });
    }

    // 3. Delete all message_templates for this user
    // Select ids first, then delete by ids (handles RLS/edge cases better)
    const { data: templateRows, error: selectMtError } = await supabase
      .from('message_templates')
      .select('id')
      .eq('user_id', user.id);

    if (selectMtError) {
      console.error('[reset-account] message_templates select error:', selectMtError);
      return NextResponse.json({ error: 'Failed to fetch message templates', details: selectMtError.message }, { status: 500 });
    }

    if (templateRows && templateRows.length > 0) {
      const ids = templateRows.map((r) => r.id);
      const { error: deleteMtError } = await supabase
        .from('message_templates')
        .delete()
        .in('id', ids);

      if (deleteMtError) {
        console.error('[reset-account] message_templates delete error:', deleteMtError);
        return NextResponse.json({ error: 'Failed to reset message templates', details: deleteMtError.message }, { status: 500 });
      }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[reset-account] Error:', msg);
    return NextResponse.json({ error: 'Something went wrong', details: msg }, { status: 500 });
  }
}
