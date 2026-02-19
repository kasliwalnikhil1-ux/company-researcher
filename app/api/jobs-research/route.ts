import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 60;

const EXA_API_KEYS = process.env.EXA_API_KEYS
  ? process.env.EXA_API_KEYS.split(',').map((k) => k.trim()).filter((k) => k.length > 0)
  : [];

const EXA_RETRYABLE_STATUS_CODES = [401, 402, 403, 429, 500, 501, 502, 503];
const EXA_KEY_SWITCH_STATUS_CODES = [401, 402, 403, 429];
const EXA_MAX_RETRIES = 3;
const EXA_INITIAL_BACKOFF_MS = 1000;

async function callExaApiWithRetry(
  exaUrl: string,
  payload: object,
  exaKeys: string[],
  initialKeyIndex: number
): Promise<{ response: Response; usedKeyIndex: number }> {
  let lastError: { status: number; text: string } | null = null;
  let currentKeyIndex = initialKeyIndex;

  for (let attempt = 0; attempt < EXA_MAX_RETRIES; attempt++) {
    const exaKey = exaKeys[currentKeyIndex];

    console.log(`[jobs-research] Exa API attempt ${attempt + 1}/${EXA_MAX_RETRIES}, key index: ${currentKeyIndex}`);
    const response = await fetch(exaUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': exaKey,
      },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      return { response, usedKeyIndex: currentKeyIndex };
    }

    const status = response.status;
    const errText = await response.text();
    lastError = { status, text: errText };

    console.warn(`[jobs-research] Exa API error (attempt ${attempt + 1}): status=${status}, error=${errText}`);

    if (!EXA_RETRYABLE_STATUS_CODES.includes(status)) {
      throw { status, text: errText, retryable: false };
    }

    if (EXA_KEY_SWITCH_STATUS_CODES.includes(status) && currentKeyIndex !== 0 && exaKeys.length > 1) {
      console.log(`[jobs-research] Key issue (${status}), switching to key index 0`);
      currentKeyIndex = 0;
    }

    if (attempt < EXA_MAX_RETRIES - 1) {
      const backoffMs = EXA_INITIAL_BACKOFF_MS * Math.pow(2, attempt);
      console.log(`[jobs-research] Retrying in ${backoffMs}ms...`);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  throw { status: lastError?.status || 500, text: lastError?.text || 'Max retries exceeded', retryable: true };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { url } = body;

    if (!url || typeof url !== 'string') {
      return NextResponse.json({ error: 'Job URL is required' }, { status: 400 });
    }

    if (EXA_API_KEYS.length === 0) {
      return NextResponse.json({ error: 'No Exa API keys configured' }, { status: 500 });
    }

    let normalizedUrl = url.trim();
    if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
      normalizedUrl = 'https://' + normalizedUrl;
    }

    console.log('[jobs-research] POST received:', { url: normalizedUrl });

    const initialKeyIndex = Math.floor(Math.random() * EXA_API_KEYS.length);
    const exaUrl = 'https://api.exa.ai/contents';

    const payload = {
      ids: [normalizedUrl],
      livecrawlTimeout: 30000,
      summary: {
        query:
          'Your goal is to determine whether the job application is a good fit for a B2B GTM or ABM expert, and capture the key signals in a strict JSON output.',
        schema: {
          description: 'Schema for extracting job posting information',
          type: 'object',
          required: [
            'job_title',
            'company_name',
            'company_website',
            'company_description',
            'company_customers',
            'compensation_type',
            'compensation_amount',
            'job_application_fit_for_B2B_GTM_ABM_expert',
          ],
          additionalProperties: false,
          properties: {
            job_title: {
              type: 'string',
              description: 'Title of the job posting',
            },
            company_name: {
              type: 'string',
              description: 'Name of the hiring company without Inc, Pvt Limited, trademark, etc.',
            },
            company_website: {
              type: 'string',
              description: 'Official domain of the company, not LinkedIn company url',
            },
            company_description: {
              type: 'string',
              description: 'Description of the company of what it does',
            },
            company_customers: {
              type: 'string',
              description: 'Type of customers the company serves',
            },
            compensation_type: {
              type: 'string',
              enum: ['fixed', 'commission_only', 'both'],
              description: 'Type of compensation offered',
            },
            compensation_amount: {
              type: 'string',
              description: 'Compensation details as written in the job posting',
            },
            job_application_fit_for_B2B_GTM_ABM_expert: {
              type: 'boolean',
            },
          },
        },
      },
    };

    let exaRes: Response;
    try {
      const result = await callExaApiWithRetry(exaUrl, payload, EXA_API_KEYS, initialKeyIndex);
      exaRes = result.response;
    } catch (exaError: unknown) {
      const err = exaError as { status?: number; text?: string };
      const status = err?.status || 500;
      const errText = err?.text || 'Unknown Exa API error';
      console.error('[jobs-research] Exa API error after retries:', status, errText);
      return NextResponse.json(
        { error: 'Exa API failed', details: errText },
        { status: status >= 500 ? 502 : 400 }
      );
    }

    const exaData = await exaRes.json();
    const results = exaData?.results;

    if (!results || !Array.isArray(results) || results.length === 0) {
      console.error('[jobs-research] No results from Exa API');
      return NextResponse.json({ error: 'No results from Exa API' }, { status: 502 });
    }

    const first = results[0];
    let summary: {
      job_title?: string;
      company_name?: string;
      company_website?: string;
      company_description?: string;
      company_customers?: string;
      compensation_type?: string;
      compensation_amount?: string;
      job_application_fit_for_B2B_GTM_ABM_expert?: boolean;
    } | null = null;

    if (first?.summary) {
      try {
        summary = typeof first.summary === 'string' ? JSON.parse(first.summary) : first.summary;
      } catch (e) {
        console.error('[jobs-research] Failed to parse Exa summary:', e);
      }
    }

    if (!summary) {
      return NextResponse.json({ error: 'Could not parse job data from response' }, { status: 502 });
    }

    console.log('[jobs-research] Result:', {
      job_title: summary.job_title,
      company_name: summary.company_name,
      company_website: summary.company_website,
      fit: summary.job_application_fit_for_B2B_GTM_ABM_expert,
    });

    return NextResponse.json({
      url: normalizedUrl,
      summary,
    });
  } catch (err) {
    console.error('[jobs-research] Unexpected error:', err);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: 'Jobs research failed', details: msg }, { status: 500 });
  }
}
