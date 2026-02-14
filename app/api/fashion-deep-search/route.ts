/**
 * Local equivalent of the Deno "fashion-deep-search" Supabase edge function.
 * Uses Vertex AI (primary) with Gemini API fallback, matching the exact
 * structure of the original Deno function.
 *
 * Required env vars (at least ONE set):
 *   Vertex AI  : GCP_PROJECT_ID + GCP_SERVICE_ACCOUNT_KEY (JSON string)
 *   Gemini API : GEMINI_API_KEY
 */

import { NextRequest, NextResponse } from 'next/server';

// -----------------------------------------------------------
// CONFIG
// -----------------------------------------------------------
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PROJECT_ID = process.env.GCP_PROJECT_ID;
const MODEL_ID = 'gemini-3-pro-preview';
const GENERATE_CONTENT_API = 'generateContent';

// Allow long-running Gemini calls (up to 5 min)
export const maxDuration = 300;

// -----------------------------------------------------------
// TOKEN MANAGEMENT (for Vertex AI)
// -----------------------------------------------------------
let cachedToken: string | null = null;
let tokenExpiry = 0;

function base64UrlEncode(str: string): string {
  return Buffer.from(str)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function getAccessTokenFromServiceAccount(): Promise<string> {
  const saKey = process.env.GCP_SERVICE_ACCOUNT_KEY;
  if (!saKey) {
    throw new Error('Missing GCP_SERVICE_ACCOUNT_KEY');
  }
  const sa = JSON.parse(saKey);
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 3600;

  const header = { alg: 'RS256', typ: 'JWT' };
  const claimSet = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: sa.token_uri,
    exp,
    iat: now,
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const claimB64 = base64UrlEncode(JSON.stringify(claimSet));
  const unsignedJwt = `${headerB64}.${claimB64}`;

  // Import the RSA private key
  const keyData = sa.private_key.replace(/\\n/g, '\n');
  const pemContents = keyData
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '');
  const pkcs8 = Buffer.from(pemContents, 'base64');

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pkcs8,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsignedJwt),
  );

  const sigB64 = Buffer.from(sig)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const signedJwt = `${unsignedJwt}.${sigB64}`;

  const res = await fetch(sa.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signedJwt,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data.access_token;
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry - 60_000) return cachedToken;
  const token = await getAccessTokenFromServiceAccount();
  cachedToken = token;
  tokenExpiry = Date.now() + 55 * 60 * 1000; // valid ~55 min
  return token;
}

// -----------------------------------------------------------
// Vertex AI API call
// -----------------------------------------------------------
async function callVertexAI(input: string): Promise<{ text: string; status: number }> {
  console.log('[fashion-deep-search] Attempting Vertex AI call...');

  if (!PROJECT_ID) {
    throw new Error('Missing GCP_PROJECT_ID');
  }

  const ACCESS_TOKEN = await getAccessToken();
  console.log('[fashion-deep-search] Retrieved Vertex AI access token');

  const vertexUrl = `https://aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/global/publishers/google/models/${MODEL_ID}:generateContent`;
  console.log('[fashion-deep-search] Vertex AI URL (global):', vertexUrl);

  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ text: input }],
      },
    ],
    generationConfig: {
      thinkingConfig: {
        thinkingLevel: 'HIGH',
      },
    },
    tools: [{ googleSearch: {} }],
  };

  const response = await fetch(vertexUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('[fashion-deep-search] Vertex AI call failed', {
      status: response.status,
      error: JSON.stringify(data),
    });
    throw new Error(`Vertex AI error: ${response.status} - ${JSON.stringify(data)}`);
  }

  console.log('[fashion-deep-search] Vertex AI call successful', {
    status: response.status,
    hasCandidate: Boolean(data?.candidates?.[0]),
  });

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error('No text found in Vertex AI response');
  }

  return { text, status: response.status };
}

// -----------------------------------------------------------
// Gemini API call (fallback)
// -----------------------------------------------------------
async function callGeminiAPI(input: string): Promise<{ text: string; status: number }> {
  console.log('[fashion-deep-search] Attempting Gemini API call (fallback)...');

  if (!GEMINI_API_KEY) {
    throw new Error('Missing GEMINI_API_KEY');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:${GENERATE_CONTENT_API}?key=${GEMINI_API_KEY}`;
  console.log('[fashion-deep-search] Gemini API URL:', url.replace(GEMINI_API_KEY, '[REDACTED]'));

  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ text: input }],
      },
    ],
    generationConfig: {
      thinkingConfig: {
        thinkingLevel: 'HIGH',
      },
    },
    tools: [{ urlContext: {} }, { googleSearch: {} }],
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('[fashion-deep-search] Gemini API call failed', {
      status: response.status,
      error: JSON.stringify(data),
    });
    throw new Error(`Gemini API error: ${response.status} - ${JSON.stringify(data)}`);
  }

  console.log('[fashion-deep-search] Gemini API call successful', {
    status: response.status,
    hasCandidate: Boolean(data?.candidates?.[0]),
  });

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error('No text found in Gemini API response');
  }

  return { text, status: response.status };
}

// -----------------------------------------------------------
// parseIfJSON helper (matches Deno version)
// -----------------------------------------------------------
function parseIfJSON(text: string): unknown {
  try {
    // Try to extract JSON from markdown code fences first
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    const candidate = fenceMatch ? fenceMatch[1].trim() : text.trim();
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

// -----------------------------------------------------------
// MAIN HANDLER
// -----------------------------------------------------------
export async function POST(req: NextRequest) {
  let body: { input?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { input } = body;

  if (!input) {
    return NextResponse.json({ error: 'Missing input' }, { status: 400 });
  }

  console.log('[fashion-deep-search] Processing request', {
    inputLength: input.length,
    hasVertexConfig: Boolean(PROJECT_ID && process.env.GCP_SERVICE_ACCOUNT_KEY),
    hasGeminiConfig: Boolean(GEMINI_API_KEY),
  });

  let text: string | undefined;
  let status: number | undefined;
  let usedMethod: string | undefined;

  // Try Vertex AI first, then fall back to Gemini API
  const hasVertexConfig = PROJECT_ID && process.env.GCP_SERVICE_ACCOUNT_KEY;

  if (hasVertexConfig) {
    try {
      console.log('[fashion-deep-search] Using Vertex AI (primary)');
      const result = await callVertexAI(input);
      text = result.text;
      status = result.status;
      usedMethod = 'vertex';
      console.log('[fashion-deep-search] SUCCESS: Used Vertex AI');
    } catch (vertexError) {
      console.error('[fashion-deep-search] Vertex AI failed, falling back to Gemini API', {
        error: vertexError instanceof Error ? vertexError.message : String(vertexError),
      });

      if (GEMINI_API_KEY) {
        try {
          const result = await callGeminiAPI(input);
          text = result.text;
          status = result.status;
          usedMethod = 'gemini';
          console.log('[fashion-deep-search] SUCCESS: Used Gemini API (fallback)');
        } catch (geminiError) {
          console.error('[fashion-deep-search] Both Vertex AI and Gemini API failed', {
            vertexError: vertexError instanceof Error ? vertexError.message : String(vertexError),
            geminiError: geminiError instanceof Error ? geminiError.message : String(geminiError),
          });
          return NextResponse.json(
            {
              error: 'Both Vertex AI and Gemini API failed',
              details: {
                vertex: vertexError instanceof Error ? vertexError.message : String(vertexError),
                gemini: geminiError instanceof Error ? geminiError.message : String(geminiError),
              },
            },
            { status: 500 },
          );
        }
      } else {
        console.error('[fashion-deep-search] Vertex AI failed and no Gemini API key available');
        return NextResponse.json(
          {
            error: 'Vertex AI failed and no fallback available',
            details: vertexError instanceof Error ? vertexError.message : String(vertexError),
          },
          { status: 500 },
        );
      }
    }
  } else if (GEMINI_API_KEY) {
    console.log('[fashion-deep-search] No Vertex AI config, using Gemini API directly');
    try {
      const result = await callGeminiAPI(input);
      text = result.text;
      status = result.status;
      usedMethod = 'gemini';
      console.log('[fashion-deep-search] SUCCESS: Used Gemini API (no Vertex config)');
    } catch (geminiError) {
      console.error('[fashion-deep-search] Gemini API failed', {
        error: geminiError instanceof Error ? geminiError.message : String(geminiError),
      });
      return NextResponse.json(
        {
          error: 'Gemini API failed',
          details: geminiError instanceof Error ? geminiError.message : String(geminiError),
        },
        { status: 500 },
      );
    }
  } else {
    console.error('[fashion-deep-search] No API configuration available');
    return NextResponse.json(
      {
        error:
          'Missing API configuration (need GCP_PROJECT_ID + GCP_SERVICE_ACCOUNT_KEY or GEMINI_API_KEY)',
      },
      { status: 500 },
    );
  }

  // Safety check – text must be set by now
  if (!text || status === undefined) {
    return NextResponse.json({ error: 'Unexpected: no response generated' }, { status: 500 });
  }

  console.log('[fashion-deep-search] Response ready', {
    usedMethod,
    textLength: text.length,
  });

  // Check if prompt contains "json"
  const wantsJson = /\bjson\b/i.test(input);

  // If JSON is expected, try to parse it
  let result: unknown = text;
  if (wantsJson) {
    const parsed = parseIfJSON(text);
    if (parsed !== undefined && typeof parsed === 'object' && parsed !== null) {
      result = parsed;
    }
  }

  return NextResponse.json(result, { status });
}
