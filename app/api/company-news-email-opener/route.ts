import { NextRequest, NextResponse } from 'next/server';
import { getJsonCompletion } from '@/utils/azureOpenAiHelper';
import { createClient } from '@supabase/supabase-js';
import { DEFAULT_B2B_NEWS_PROMPT, DEFAULT_B2B_ADS_PROMPT } from '@/app/personalization/investorAnalyzeDefault';

export const maxDuration = 60;

type OpenerMode = 'news' | 'ads';

const DEFAULT_PROMPT_BY_MODE: Record<OpenerMode, string> = {
  news: DEFAULT_B2B_NEWS_PROMPT,
  ads: DEFAULT_B2B_ADS_PROMPT,
};

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

async function loadUserNewsPrompt(req: NextRequest, mode: OpenerMode): Promise<string> {
  const fallback = DEFAULT_PROMPT_BY_MODE[mode];
  const settingsKey = mode === 'ads' ? 'b2bAds' : 'b2bNews';
  try {
    const authHeader = req.headers.get('Authorization');
    const token = authHeader?.replace(/^Bearer\s+/i, '');
    if (!token) return fallback;

    const authClient = getSupabaseAuthClient(token);
    if (!authClient) return fallback;

    const { data: { user } } = await authClient.auth.getUser(token);
    if (!user) return fallback;

    const supabase = getSupabaseServiceClient();
    if (!supabase) return fallback;

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
    const customPrompt = personalization?.[settingsKey]?.prompt;
    if (typeof customPrompt === 'string' && customPrompt.trim().length > 0) {
      return customPrompt;
    }
  } catch {
    // fall through to default
  }
  return fallback;
}

function normalizeLine(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

function applyVariables(
  template: string,
  vars: { companyName: string; companyUrl: string }
): string {
  const map: Record<string, string> = {
    Company: vars.companyName || vars.companyUrl,
    CompanyName: vars.companyName,
    Url: vars.companyUrl,
    URL: vars.companyUrl,
    CompanyUrl: vars.companyUrl,
    Domain: vars.companyUrl,
  };
  return template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (full, key: string) => {
    if (Object.prototype.hasOwnProperty.call(map, key)) {
      return map[key];
    }
    return full;
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const news = typeof body?.news === 'string' ? body.news.trim() : '';
    const mode: OpenerMode = body?.mode === 'ads' ? 'ads' : 'news';
    const companyName = typeof body?.companyName === 'string' ? body.companyName.trim() : '';
    const companyUrl = typeof body?.companyUrl === 'string' ? body.companyUrl.trim() : '';

    if (!news) {
      return NextResponse.json(
        { error: `${mode === 'ads' ? 'Ad' : 'News'} text is required` },
        { status: 400 }
      );
    }

    const rawSystemPrompt = await loadUserNewsPrompt(req, mode);
    const systemPrompt = applyVariables(rawSystemPrompt, { companyName, companyUrl });
    const userLabel = mode === 'ads' ? 'ad' : 'news item';

    const companyHeader =
      companyName || companyUrl
        ? `Company: ${companyName || companyUrl}${companyUrl ? ` (${companyUrl})` : ''}\n\n`
        : '';

    const extracted = await getJsonCompletion(
      [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `${companyHeader}I will paste ${mode === 'ads' ? 'an' : 'a'} ${userLabel} below.\n\n${mode === 'ads' ? 'Ad' : 'News'}:\n${news}`,
        },
      ],
      { max_tokens: 2000 }
    );

    if (extracted?.error) {
      const errMsg = typeof extracted.error === 'string' ? extracted.error : 'AI generation failed';
      return NextResponse.json({ error: errMsg }, { status: 500 });
    }

    const firstLine = normalizeLine(extracted?.first_line_to_start_email);
    const subjectLine = normalizeLine(extracted?.subject_line);

    // If either field is missing, the model has signaled the news isn't
    // relevant enough to draft an opener. That's a legitimate outcome — return
    // 200 with null fields so callers can attach the news without an opener
    // rather than treating it as a server error.
    if (!firstLine || !subjectLine) {
      return NextResponse.json({
        first_line_to_start_email: null,
        subject_line: null,
      });
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
