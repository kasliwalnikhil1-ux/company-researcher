import { NextRequest, NextResponse } from 'next/server';
import { getJsonCompletion } from '@/utils/azureOpenAiHelper';
import { createClient } from '@supabase/supabase-js';
import { DEFAULT_B2B_NEWS_PROMPT } from '@/app/personalization/investorAnalyzeDefault';

export const maxDuration = 60;

const SYSTEM_MESSAGE = DEFAULT_B2B_NEWS_PROMPT;

function getSupabaseAuthClient(accessToken: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

function getSupabaseServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key);
}

async function loadUserNewsPrompt(req: NextRequest): Promise<string> {
  try {
    const authHeader = req.headers.get('Authorization');
    const token = authHeader?.replace(/^Bearer\s+/i, '');
    if (!token) return SYSTEM_MESSAGE;

    const authClient = getSupabaseAuthClient(token);
    if (!authClient) return SYSTEM_MESSAGE;

    const { data: { user } } = await authClient.auth.getUser(token);
    if (!user) return SYSTEM_MESSAGE;

    const supabase = getSupabaseServiceClient();
    if (!supabase) return SYSTEM_MESSAGE;

    const { data: userSettings } = await supabase
      .from('user_settings')
      .select('personalization')
      .eq('id', user.id)
      .single();

    let personalization: any = userSettings?.personalization ?? null;
    if (typeof personalization === 'string') {
      try {
        personalization = JSON.parse(personalization);
      } catch {
        personalization = null;
      }
    }
    const customPrompt = personalization?.b2bNews?.prompt;
    if (typeof customPrompt === 'string' && customPrompt.trim().length > 0) {
      return customPrompt;
    }
  } catch {
    // fall through to default
  }
  return SYSTEM_MESSAGE;
}

function normalizeLine(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, 60);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const news = typeof body?.news === 'string' ? body.news.trim() : '';

    if (!news) {
      return NextResponse.json({ error: 'News text is required' }, { status: 400 });
    }

    const systemPrompt = await loadUserNewsPrompt(req);

    const extracted = await getJsonCompletion(
      [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `I will paste a news item below.\n\nNews:\n${news}`,
        },
      ],
      { max_tokens: 300 }
    );

    if (extracted?.error) {
      const errMsg = typeof extracted.error === 'string' ? extracted.error : 'AI generation failed';
      return NextResponse.json({ error: errMsg }, { status: 500 });
    }

    const firstLine = normalizeLine(extracted?.first_line_to_start_email);
    const subjectLine = normalizeLine(extracted?.subject_line);

    if (!firstLine || !subjectLine) {
      return NextResponse.json(
        { error: 'AI did not return valid first line and subject line.' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      first_line_to_start_email: firstLine,
      subject_line: subjectLine,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: 'Failed to generate email opener from news.', details: msg },
      { status: 500 }
    );
  }
}
