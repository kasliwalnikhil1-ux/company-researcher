// /app/api/generate-messages/route.ts
// AI-generated investor outreach emails using company context
// Uses Azure LLM (like investor-analyze)

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getJsonCompletion } from '@/utils/azureOpenAiHelper';
import { formatOnboardingCompanySummary, type OnboardingDataForSummary } from '@/lib/utils';

const SYSTEM_MESSAGE = `You are an expert B2B outbound copywriter specializing in investor outreach.

Using the company context provided below, generate 4 short investor outreach emails in a warm, intelligent, and non-salesy tone. The goal is to spark interest and start a conversation, not to hard-sell.

Rules:
Follow the exact email structure and order below
Keep language natural, concise, and human
Avoid hype or exaggerated claim
Maintain all personalization placeholders exactly as written
Write as if reaching out to a thoughtful investor or senior operator
Do not add new placeholders
Do not remove any placeholders \${...}
Do not explain anything outside the emails
Don't use  / (slash), Em Dashes (—), En Dashes (–) , and Hyphens (-)`;

const USER_MESSAGE_TEMPLATE = `Generate emails for <<<COMPANY_CONTEXT>>>

Reply as a JSON with keys:
{
  "subjectline": str
  "email1": str
  "email2": str
}

Subject line
Format it like (some examples for format, not real values): 
Enterprise SaaS – 2x exited founder – US – Pre-Seed
B2C Delivery – $1M GMV, +30% MoM – Nigeria – Seed
Crypto / Payment – Lead secured – UK – Series A

Email 1
Hey \${cleaned_name}, {twitter_line}

\${line1}

No-bullshit value prop in one line, starting with company name.

3 points, starting with -
Positive signal on team, product, growth.
Bullet points make it easy to read. Names and numbers make it tangible.
No features or roadmap.

Can we connect for a quick call on \${followUpRelativeDay}?

Cheers,
<<<FOUNDER_SIGNATURE>>>


Email 2
Hey \${cleaned_name}, \${line2}

..usp..info..about the company in 2 precise lines.


What are your thoughts?

best,
<<<FOUNDER_SIGNATURE>>>
END PROMPT`;

function getSupabaseAuthClient(accessToken: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get('Authorization');
    const token = authHeader?.replace(/^Bearer\s+/i, '');

    if (!token) {
      return NextResponse.json(
        { error: 'You need to be signed in to perform this action.' },
        { status: 401 }
      );
    }

    const authClient = getSupabaseAuthClient(token);
    if (!authClient) {
      return NextResponse.json({ error: 'Auth not configured' }, { status: 500 });
    }

    const { data: { user }, error: authError } = await authClient.auth.getUser(token);
    if (authError || !user) {
      return NextResponse.json(
        { error: 'You need to be signed in to perform this action.' },
        { status: 401 }
      );
    }

    const body = await req.json();
    const { onboarding } = body as { onboarding?: OnboardingDataForSummary };

    const companyContext = onboarding
      ? formatOnboardingCompanySummary(onboarding)
      : 'No company context provided. Please complete onboarding or provide company details.';

    const step1 = onboarding?.step1;
    const step5 = onboarding?.step5;
    const b2bStep3 = onboarding?.b2bStep3;

    const founderParts = [
      step1?.firstName?.trim(),
      step1?.lastName?.trim(),
    ].filter(Boolean);
    const founderName = founderParts.join(' ');
    const title = step1?.title?.trim() ?? b2bStep3?.yourRole?.trim();
    const companyName = step5?.companyName?.trim() ?? b2bStep3?.companyName?.trim();

    const line2Parts = [title, companyName].filter(Boolean);
    const line2 = line2Parts.join(', ');
    const founderSignature = founderName
      ? line2 ? `${founderName}\n${line2}` : founderName
      : line2 || 'Founder';

    const userMessage = USER_MESSAGE_TEMPLATE
      .replace('<<<COMPANY_CONTEXT>>>', companyContext)
      .replace(/<<<FOUNDER_SIGNATURE>>>/g, founderSignature);

    const extracted = await getJsonCompletion(
      [
        { role: 'system', content: SYSTEM_MESSAGE },
        { role: 'user', content: userMessage },
      ],
      { max_tokens: 2000 }
    );

    if (extracted?.error) {
      const errMsg = typeof extracted.error === 'string' ? extracted.error : 'AI generation failed';
      console.error('[generate-messages] AI error:', errMsg);
      return NextResponse.json({ error: errMsg }, { status: 500 });
    }

    const subjectline = typeof extracted?.subjectline === 'string' ? extracted.subjectline.trim() : '';
    const email1 = typeof extracted?.email1 === 'string' ? extracted.email1.trim() : '';
    const email2 = typeof extracted?.email2 === 'string' ? extracted.email2.trim() : '';

    if (!subjectline || !email1 || !email2) {
      return NextResponse.json(
        { error: 'AI did not return valid subject line and emails.' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      subjectline,
      email1,
      email2,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[generate-messages] Error:', msg, err);
    return NextResponse.json(
      { error: 'Something went wrong while generating messages. Please try again.' },
      { status: 500 }
    );
  }
}
