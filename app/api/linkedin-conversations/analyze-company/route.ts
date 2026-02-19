import { NextRequest, NextResponse } from 'next/server';
import { getJsonCompletion, Message } from '@/utils/azureOpenAiHelper';

const SYSTEM_PROMPT = `You are an expert startup analyst and investment research assistant.

Your task is to analyze the provided company details and return structured JSON.
{
  "cleaned_company_name": "", // Remove "Inc", "LLC", "Pvt Ltd", "Private Limited", etc from company name

  "about_startup": "", // 1 line description of what the startup does

  "competitive_landscape": "", // 1 line describing competitors or market landscape

  "startup_usp": "", // 1 line describing unique advantage

  "target_audiences": [
    "", // Target audience 1
    "", // Target audience 2
    ""  // Target audience 3
  ],

  "fundraising_amplify": "", // 1 line explaining how fundraising will accelerate growth

  "fund_allocation": [
    "", // Fund use 1
    "", // Fund use 2
    ""  // Fund use 3
  ],

  "potential_investors": "", // 1 line mentioning relevant investors, firms, or investor types

  "investor_positioning": [
    "", // Positioning point 1
    "", // Positioning point 2
    ""  // Positioning point 3
  ],

  "focus_areas": [
    {
      "focus_area": "", // Focus area name
      "why_it_aligns": "" // Why this aligns with startup business
    },
    {
      "focus_area": "",
      "why_it_aligns": ""
    },
    {
      "focus_area": "",
      "why_it_aligns": ""
    }
  ]
}`;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const companyDescription = body.company_description ?? '';

    if (typeof companyDescription !== 'string' || !companyDescription.trim()) {
      return NextResponse.json(
        { error: 'company_description must be a non-empty string' },
        { status: 400 }
      );
    }

    const userPrompt = `Analyze the following company description and generate structured JSON.

Company Description:
${companyDescription}`;

    const messages: Message[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ];

    const result = await getJsonCompletion(messages, {
      temperature: 0.7,
    });

    if (result?.error) {
      return NextResponse.json(
        { error: result.error, raw_content: result.raw_content },
        { status: 500 }
      );
    }

    return NextResponse.json(result);
  } catch (err) {
    console.error('[analyze-company] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to analyze company' },
      { status: 500 }
    );
  }
}
