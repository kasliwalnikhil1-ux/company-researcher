// /app/api/investor-analyze/route.ts
// AI analysis of investor fit using deep_research
// Uses service role for DB access; requires auth for RPC (p_user_id)

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getJsonCompletion } from '@/utils/azureOpenAiHelper';
import { formatOnboardingCompanySummary, type OnboardingDataForSummary } from '@/lib/utils';
import { fetchTwitterTimeline, type TwitterTweet } from '@/utils/twitterApi';

const SYSTEM_MESSAGE = `You are an investment analysis assistant. Your role is to evaluate <<COMPANY_NAME>>> using only the provided company information and determine whether it is a good fit for investment based on investor criteria.

You must:
- Analyze the business model and industry.
- Decide if the company is fundable by the given investor type.
- Clearly explain the reasoning.
- Generate short, natural sounding outreach personalization lines.
- Avoid hype, buzzwords, or salesy language.
- Keep tone professional, friendly, and human.
- Do not make assumptions beyond the provided data.
- Avoid marketing language or exaggeration.

Your response must strictly follow the JSON structure provided in the user message.
Do not add extra fields.
Do not add explanations outside the JSON.`;

const USER_MESSAGE_TEMPLATE = (companyContext: string, companyName: string) => `<<<COMPANY_CONTEXT>>>

Investor Profile:
<<<DEEP_RESEARCH>>>

Return the result strictly in the following JSON format:
{
  "investor_fit": true | false | null,
  "reason": "Precise, short, clear explanation of why this company fits or does not fit the investor",
  "personalized_outreach_lines": [
    "I saw you...[additional <12 words]..., which is why I'm reaching out to you about <<<COMPANY_NAME>>>.", // Line 1
    "I believe you...[additional <12 words]... could greatly benefit us at <<<COMPANY_NAME>>>." // Line 2
  ],
  "mutual_interests": ["upto 2, optional, precise and accurate, non-generic items such as common place or work, industry, college, etc."]
}

Follow exactly the above sentence structures for personalized_outreach_lines. These are emails openers leading with why them. Be specific and precise.`;

const TWITTER_ICEBREAKER_PROMPT = (name: string, first_name: string, allValidTweets: string, dateString: string) =>
  `PROMPT START
${name} posted these on Twitter:${allValidTweets}

Write a one-line friendly icebreaker after just reading any one of ${first_name}'s tweets. Don't use hashtags. Keep it less than 120 characters. You don't know ${first_name} or ${first_name}'s skills personally. Do not ask question. Today is ${dateString}. No questions. Don't use  / (slash), Em Dashes (—), En Dashes (–) , and Hyphens (-)"

Reply as a JSON with key:
{ 
  "twitter_line": "I just read your tweet..."
}

Examples of a few other icebreakers:
I just read your tweet about WindBorne Systems' climate technology. Congratulations to you and the team!

I just read your tweet on stepping into our purpose and sharing our unique stories with the world!
PROMPT END`;

const MIN_TWEET_TEXT_LENGTH = 30;
const NEGATIVE_WORDS = /\b(hiring|buy now|limited time|act now|sale now|discount|shop now|apply now|join our team)\b/i;

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function parseTweetDate(createdAt: string): Date | null {
  try {
    const d = new Date(createdAt);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

function isTweetWithinOneWeek(tweet: TwitterTweet): boolean {
  const d = parseTweetDate(tweet.created_at);
  if (!d) return false;
  return Date.now() - d.getTime() < ONE_WEEK_MS;
}

function hasEnoughText(text: string): boolean {
  const t = (text || '').trim();
  return t.length >= MIN_TWEET_TEXT_LENGTH;
}

function containsNegativeWords(text: string): boolean {
  return NEGATIVE_WORDS.test(text || '');
}

function filterValidTweets(
  pinned: TwitterTweet | null | undefined,
  timeline: TwitterTweet[] | null | undefined
): TwitterTweet[] {
  const valid: TwitterTweet[] = [];

  if (pinned && typeof pinned.text === 'string') {
    const t = pinned.text.trim();
    if (hasEnoughText(t) && !containsNegativeWords(t)) {
      valid.push(pinned);
    }
  }

  const timelineList = Array.isArray(timeline) ? timeline : [];
  for (const tweet of timelineList) {
    if (!tweet || typeof tweet.text !== 'string') continue;
    if (!isTweetWithinOneWeek(tweet)) continue;
    const t = tweet.text.trim();
    if (!hasEnoughText(t) || containsNegativeWords(t)) continue;
    valid.push(tweet);
  }

  return valid;
}

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

type ErrorMapping = { errorCode: string; userMessage: string };

function mapInvestorAnalyzeError(message: string): ErrorMapping {
  const m = (message || '').toLowerCase();
  if (m.includes('unauthorized') || m.includes('authentication required') || m.includes('invalid or expired session')) {
    return { errorCode: 'UNAUTHORIZED', userMessage: 'You need to be signed in to perform this action.' };
  }
  if (m.includes('account inactive')) {
    return { errorCode: 'ACCOUNT_INACTIVE', userMessage: 'Your account is currently inactive. Please contact support or update your subscription.' };
  }
  if (m.includes('insufficient credits')) {
    return { errorCode: 'INSUFFICIENT_CREDITS', userMessage: "You've run out of credits. Upgrade your plan or purchase more credits to continue." };
  }
  if (m.includes('null value in column') || m.includes('violates not-null constraint')) {
    return { errorCode: 'NULL_CONSTRAINT', userMessage: 'Something went wrong. Please refresh and try again.' };
  }
  if (m.includes('permission denied') || m.includes('row-level security')) {
    return { errorCode: 'PERMISSION_DENIED', userMessage: "You don't have permission to perform this action." };
  }
  return { errorCode: 'UNKNOWN', userMessage: 'Something went wrong while processing your request. Please try again.' };
}

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let userId: string | undefined;
  let investorIdParam: string | undefined;
  try {
    const authHeader = req.headers.get('Authorization');
    const token = authHeader?.replace(/^Bearer\s+/i, '');

    if (!token) {
      const { userMessage, errorCode } = mapInvestorAnalyzeError('Authentication required');
      return NextResponse.json({ error: userMessage, errorCode }, { status: 401 });
    }

    const authClient = getSupabaseAuthClient(token);
    if (!authClient) {
      return NextResponse.json({ error: 'Auth not configured' }, { status: 500 });
    }

    const { data: { user }, error: authError } = await authClient.auth.getUser(token);
    userId = user?.id;
    if (authError || !user) {
      const { userMessage, errorCode } = mapInvestorAnalyzeError(authError?.message || 'Invalid or expired session');
      return NextResponse.json({ error: userMessage, errorCode }, { status: 401 });
    }

    const body = await req.json();
    const { investorId, onboarding } = body as { investorId?: string; onboarding?: OnboardingDataForSummary };
    investorIdParam = typeof investorId === 'string' ? investorId : undefined;

    if (!investorId || typeof investorId !== 'string') {
      return NextResponse.json({ error: 'investorId is required' }, { status: 400 });
    }

    const primaryUse = onboarding?.flowType ?? onboarding?.step0?.primaryUse;
    const companyName =
      primaryUse === 'b2b'
        ? onboarding?.b2bStep3?.companyName?.trim() || 'the company'
        : onboarding?.step5?.companyName?.trim() || 'the company';
    const companyContext = onboarding
      ? formatOnboardingCompanySummary(onboarding)
      : `Kaptured AI is an AI-powered platform that generates professional product photos and videos for brands (especially fashion & jewelry) from minimal input, scaling creative content production with AI. It combines computer vision and generative models to automate visual content at scale.`;

    console.log('[investor-analyze] Input:', { investorId, companyName, companyContextLength: companyContext?.length });

    const supabase = getSupabaseServiceClient();
    if (!supabase) {
      return NextResponse.json({ error: 'Database not configured' }, { status: 500 });
    }

    // Fetch investor's deep_research, twitter_url, name
    const { data: investor, error: fetchError } = await supabase
      .from('investors')
      .select('id, deep_research, twitter_url, name')
      .eq('id', investorId)
      .single();

    if (fetchError || !investor) {
      return NextResponse.json(
        { error: 'Investor not found', details: fetchError?.message },
        { status: 404 }
      );
    }

    const deepResearch = investor.deep_research;
    if (!deepResearch || typeof deepResearch !== 'string' || !deepResearch.trim()) {
      return NextResponse.json(
        { error: 'Investor has no deep research data. Run investor research first.' },
        { status: 400 }
      );
    }

    const userMessage = USER_MESSAGE_TEMPLATE(companyContext, companyName)
      .replace('<<<COMPANY_CONTEXT>>>', companyContext)
      .replace(/<<<COMPANY_NAME>>>/g, companyName)
      .replace('<<<DEEP_RESEARCH>>>', deepResearch.trim());

    const systemContent = SYSTEM_MESSAGE.replace(/<<COMPANY_NAME>>>/g, companyName);
    const userHasPlaceholder = userMessage.includes('<<<COMPANY_NAME>>>');
    const systemHasPlaceholder = systemContent.includes('<<COMPANY_NAME>>>');
    if (userHasPlaceholder || systemHasPlaceholder) {
      console.warn('[investor-analyze] Placeholder NOT replaced:', { userHasPlaceholder, systemHasPlaceholder });
    }
    console.log('[investor-analyze] Prompts:', {
      companyName,
      userMessageSnippet: userMessage.slice(0, 500) + '...',
    });
    const extracted = await getJsonCompletion(
      [
        { role: 'system', content: systemContent },
        { role: 'user', content: userMessage },
      ],
      { max_tokens: 1500 }
    );

    console.log('[investor-analyze] AI response:', {
      investor_fit: extracted?.investor_fit,
      personalized_outreach_lines: extracted?.personalized_outreach_lines,
      linesContainPlaceholder: (extracted?.personalized_outreach_lines ?? []).some(
        (l: string) => typeof l === 'string' && (l.includes('<<<COMPANY_NAME>>>') || l.includes('<<COMPANY_NAME>>>'))
      ),
    });

    if (extracted?.error) {
      const errMsg = typeof extracted.error === 'string' ? extracted.error : 'AI analysis failed';
      const { userMessage, errorCode } = mapInvestorAnalyzeError(errMsg);
      if (errorCode === 'UNKNOWN') {
        console.error('[investor-analyze] AI extraction error:', { message: errMsg, userId, investorId: investorIdParam, extracted });
      }
      return NextResponse.json({ error: userMessage, errorCode }, { status: 500 });
    }

    // Break personalized_outreach_lines into line1 and line2
    const lines = Array.isArray(extracted?.personalized_outreach_lines)
      ? extracted.personalized_outreach_lines.filter(Boolean)
      : [];
    const line1 = (lines[0] && typeof lines[0] === 'string' ? lines[0] : null) ?? '';
    const line2 = (lines[1] && typeof lines[1] === 'string' ? lines[1] : null) ?? '';

    const mutualInterests = Array.isArray(extracted?.mutual_interests)
      ? extracted.mutual_interests.filter(Boolean)
      : [];

    let twitterLine: string | null = null;
    const twitterUrl = investor.twitter_url?.trim();
    const investorName = investor.name?.trim() ?? '';
    const firstName = investorName ? investorName.split(/\s+/)[0] || investorName : '';

    if (twitterUrl) {
      try {
        const timelineData = await fetchTwitterTimeline(twitterUrl);
        const validTweets = filterValidTweets(timelineData.pinned, timelineData.timeline);
        if (validTweets.length > 0) {
          const allValidTweets = validTweets
            .map((t) => `\n- "${(t.text || '').trim()}"`)
            .join('');
          const dateString = new Date().toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          });
          const twitterPrompt = TWITTER_ICEBREAKER_PROMPT(
            investorName || 'They',
            firstName || 'them',
            allValidTweets,
            dateString
          );
          const twitterExtracted = await getJsonCompletion(
            [{ role: 'user', content: twitterPrompt }],
            { max_tokens: 200 }
          );
          if (twitterExtracted?.twitter_line && typeof twitterExtracted.twitter_line === 'string') {
            const raw = twitterExtracted.twitter_line.trim();
            twitterLine = raw.length > 120 ? raw.slice(0, 120) : raw;
          }
        }
      } catch (twitterErr) {
        console.warn('[investor-analyze] Twitter icebreaker failed:', twitterErr);
      }
    }

    const twitterLineValue = twitterLine ?? undefined;
    const newAiMetadata = {
      investor_fit: extracted?.investor_fit ?? null,
      reason: typeof extracted?.reason === 'string' ? extracted.reason : null,
      line1,
      line2,
      mutual_interests: mutualInterests,
      ...(twitterLineValue ? { twitter_line: twitterLineValue } : {}),
    };

    const { error: rpcError } = await supabase.rpc('upsert_investor_ai_metadata', {
      p_user_id: user.id,
      p_investor_id: investorId,
      new_ai_metadata: newAiMetadata,
    });

    if (rpcError) {
      const { userMessage, errorCode } = mapInvestorAnalyzeError(rpcError.message);
      if (errorCode === 'NULL_CONSTRAINT') {
        console.error('[investor-analyze] RPC null/constraint error (internal):', rpcError.message);
      }
      if (errorCode === 'UNKNOWN') {
        console.error('[investor-analyze] RPC error:', { message: rpcError.message, userId, investorId: investorIdParam });
      }
      return NextResponse.json({ error: userMessage, errorCode }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      investor_fit: newAiMetadata.investor_fit,
      reason: newAiMetadata.reason,
      line1: newAiMetadata.line1,
      line2: newAiMetadata.line2,
      mutual_interests: newAiMetadata.mutual_interests,
      ...(newAiMetadata.twitter_line && { twitter_line: newAiMetadata.twitter_line }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const { userMessage, errorCode } = mapInvestorAnalyzeError(msg);
    if (errorCode === 'UNKNOWN') {
      console.error('[investor-analyze] Error:', { message: msg, userId, investorId: investorIdParam, err });
    }
    return NextResponse.json({ error: userMessage, errorCode }, { status: 500 });
  }
}
