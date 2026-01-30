// /app/api/investor-analyze/route.ts
// AI analysis of investor fit using deep_research
// Uses service role for DB access; requires auth for RPC (p_user_id)

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getJsonCompletion } from '@/utils/azureOpenAiHelper';
import { formatOnboardingCompanySummary, type OnboardingDataForSummary } from '@/lib/utils';

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
  "reason": "Clear explanation of why this company fits or does not fit the investor",
  "personalized_outreach_lines": [
    "I saw ...[additional <12 words]..., which is why I'm reaching out to you about <<<COMPANY_NAME>>>.", // Line 1
    "I believe ...[additional <12 words]... could greatly benefit us at <<<COMPANY_NAME>>>." // Line 2
  ],
  "mutual_interests": ["upto 2, optional, precise and accurate, non-generic items such as common place or work, industry, college, etc."]
}

Follow exactly the above sentence structures for personalized_outreach_lines, and be precise.`;

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

    const companyName = onboarding?.step5?.companyName?.trim() || 'the company';
    const companyContext = onboarding
      ? formatOnboardingCompanySummary(onboarding)
      : `Kaptured AI is an AI-powered platform that generates professional product photos and videos for brands (especially fashion & jewelry) from minimal input, scaling creative content production with AI. It combines computer vision and generative models to automate visual content at scale.`;

    const supabase = getSupabaseServiceClient();
    if (!supabase) {
      return NextResponse.json({ error: 'Database not configured' }, { status: 500 });
    }

    // Fetch investor's deep_research
    const { data: investor, error: fetchError } = await supabase
      .from('investors')
      .select('id, deep_research')
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
    const extracted = await getJsonCompletion(
      [
        { role: 'system', content: systemContent },
        { role: 'user', content: userMessage },
      ],
      { max_tokens: 1500 }
    );

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

    const newAiMetadata = {
      investor_fit: extracted?.investor_fit ?? null,
      reason: typeof extracted?.reason === 'string' ? extracted.reason : null,
      line1,
      line2,
      mutual_interests: mutualInterests,
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
