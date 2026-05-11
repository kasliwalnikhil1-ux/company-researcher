/**
 * Azure OpenAI & Google Gemini API Helper Module (server-only)
 *
 * This module provides centralized configuration and helper functions for Azure OpenAI, 
 * Google Gemini (API key), and Vertex AI (service account) API calls.
 * Keys must be set via environment variables (no hardcoded fallbacks).
 *
 * Default: Azure OpenAI first, fallback to Gemini (API key), then Vertex AI on failure.
 *
 * Usage:
 *   const response = await callAzureOpenAI(payload);  // Azure default, Gemini fallback, Vertex fallback
 *   const response = await callAzureOpenAI(payload, { provider: "azure" });  // Azure default chain
 *   const response = await callAzureOpenAI(payload, { provider: "gemini" });  // Gemini (API key) only
 *   const response = await callAzureOpenAI(payload, { provider: "vertex" });  // Vertex AI only
 *   const result = await getCompletion(messages);  // Azure default, Gemini fallback, Vertex fallback
 *   const result = await getJsonCompletion(messages, { provider: "gemini" });  // Gemini only
 */

import 'server-only';
import OpenAI from 'openai';

// Azure OpenAI Configuration (endpoint/deployment from env or defaults; API key from env only)
const AZURE_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || process.env.ENDPOINT_URL || "https://resourceplan.services.ai.azure.com/";
const DEPLOYMENT_NAME = process.env.AZURE_OPENAI_DEPLOYMENT_NAME || process.env.DEPLOYMENT_NAME || "gpt-4o";
const DEPLOYMENT_NAME_MINI = process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MINI || process.env.DEPLOYMENT_NAME_MINI || "gpt-4o-mini";
const API_VERSION = process.env.AZURE_OPENAI_API_VERSION || "2024-05-01-preview";
const API_KEY = process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_API_KEY || "";

// Gemini Configuration (API key authentication)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL_ID = process.env.GEMINI_MODEL_ID || "gemini-3-flash-preview";
const GEMINI_BASE_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}";

// Vertex AI Configuration (service account authentication)
// Set USE_VERTEX=true to enable Vertex AI (skipped by default)
// Uses global endpoint by default (recommended for better availability)
const USE_VERTEX = /^(?:true|1|yes)$/i.test(process.env.USE_VERTEX ?? "false");
const GCP_SERVICE_ACCOUNT_KEY = process.env.GCP_SERVICE_ACCOUNT_KEY || "";
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID || "";
const GCP_LOCATION = process.env.GCP_LOCATION || "global";
const VERTEX_MODEL_ID = process.env.VERTEX_MODEL_ID || "gemini-3-flash-preview";

// -----------------------------------------------------------
// VERTEX AI TOKEN MANAGEMENT
// -----------------------------------------------------------
let cachedToken: string | null = null;
let tokenExpiry = 0;

/**
 * Base64URL encode a string (for JWT creation)
 */
function encodeBase64Url(input: string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Base64URL encode a Uint8Array (for JWT signature)
 */
function encodeBase64UrlBytes(input: Uint8Array): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Create a signed JWT and exchange it for a Google Cloud access token
 */
async function getAccessTokenFromServiceAccount(): Promise<string> {
  if (!GCP_SERVICE_ACCOUNT_KEY) {
    throw new Error("GCP_SERVICE_ACCOUNT_KEY is not configured");
  }

  const sa = JSON.parse(GCP_SERVICE_ACCOUNT_KEY);
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 3600;

  const header = { alg: "RS256", typ: "JWT" };
  const claimSet = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: sa.token_uri,
    exp,
    iat: now,
  };

  const headerB64 = encodeBase64Url(JSON.stringify(header));
  const claimB64 = encodeBase64Url(JSON.stringify(claimSet));
  const unsignedJwt = `${headerB64}.${claimB64}`;

  // Parse the private key from PEM format
  const keyData = sa.private_key.replace(/\\n/g, "\n");
  const pemContents = keyData
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  const pkcs8 = Buffer.from(pemContents, 'base64');

  // Import the key and sign the JWT
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsignedJwt)
  );

  const signedJwt = `${unsignedJwt}.${encodeBase64UrlBytes(new Uint8Array(signature))}`;

  // Exchange the signed JWT for an access token
  const res = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: signedJwt,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${JSON.stringify(data)}`);
  }

  return data.access_token;
}

/**
 * Get a cached access token (refreshes if expired or about to expire)
 */
async function getAccessToken(): Promise<string> {
  // Return cached token if still valid (with 60 second buffer)
  if (cachedToken && Date.now() < tokenExpiry - 60_000) {
    return cachedToken;
  }

  // Get a new token
  const token = await getAccessTokenFromServiceAccount();
  cachedToken = token;
  tokenExpiry = Date.now() + 55 * 60 * 1000; // valid ~55 min
  return token;
}

// Initialize Azure OpenAI client with API key authentication
// Note: We'll create the client on-demand to support different deployments
function createAzureOpenAIClient(deployment: string = DEPLOYMENT_NAME): OpenAI {
  // Azure OpenAI endpoint format: https://{resource}.openai.azure.com/
  // The baseURL should point to the deployments endpoint
  const baseURL = AZURE_ENDPOINT.endsWith('/') 
    ? `${AZURE_ENDPOINT}openai/deployments/${deployment}`
    : `${AZURE_ENDPOINT}/openai/deployments/${deployment}`;
  
  return new OpenAI({
    baseURL: baseURL,
    apiKey: API_KEY,
    defaultQuery: { 'api-version': API_VERSION },
    defaultHeaders: {
      'api-key': API_KEY,
    },
  });
}

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AzureOpenAIPayload {
  messages: Message[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  response_format?: { type: "json_object" } | { type: "text" };
}

export interface AzureOpenAIResponse {
  choices: Array<{
    message: {
      content: string;
      role: string;
    };
    finish_reason: string;
    index: number;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  id: string;
  model: string;
  created: number;
}

export interface CallOptions {
  endpoint?: string;
  provider?: "azure" | "gemini" | "vertex";
}

// Slack webhook URL for error notifications
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";

/**
 * Send an error notification to Slack
 */
async function sendSlackError(provider: string, error: string, context?: string): Promise<void> {
  if (!SLACK_WEBHOOK_URL) {
    console.warn("[azureOpenAiHelper] SLACK_WEBHOOK_URL not configured, skipping Slack notification");
    return;
  }

  try {
    const message = `🚨 *${provider} API Error*\n\n*Error:* ${error}${context ? `\n\n*Context:* ${context}` : ""}`;
    
    await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
    });
  } catch (slackError) {
    console.error("[azureOpenAiHelper] Failed to send Slack notification:", slackError);
  }
}

/**
 * Clean JSON response by removing markdown code blocks and preamble text if present.
 * This handles cases where the API returns:
 * - JSON wrapped in ```json ... ``` or ``` ... ```
 * - Preamble text like "Here is the JSON:" before the actual JSON
 * - Trailing text after the JSON
 */
function cleanJsonResponse(content: string): string {
  let cleaned = content.trim();
  
  // If empty or too short to be valid JSON, return as-is
  if (!cleaned || cleaned.length < 2) {
    return cleaned;
  }
  
  // Check if content is wrapped in markdown code blocks (anywhere in the content)
  // Pattern matches ```json ... ``` or ``` ... ```
  const codeBlockPattern = /```(?:json)?\s*\n?([\s\S]*?)\n?```/;
  const codeBlockMatch = cleaned.match(codeBlockPattern);

  if (codeBlockMatch) {
    cleaned = codeBlockMatch[1].trim();
  }

  // Remove common preamble text patterns like "Here is the JSON:", "Here is the JSON requested:", etc.
  const preamblePatterns = [
    /^[\s\S]*?here\s+is\s+the\s+json[^{[\n]*[:.]?\s*\n?/i,
    /^[\s\S]*?json\s+response[^{[\n]*[:.]?\s*\n?/i,
    /^[\s\S]*?the\s+(?:following|result)[^{[\n]*[:.]?\s*\n?/i,
    /^[\s\S]*?response[^{[\n]*[:.]?\s*\n?/i,
  ];
  
  for (const pattern of preamblePatterns) {
    if (pattern.test(cleaned) && (cleaned.includes("{") || cleaned.includes("["))) {
      cleaned = cleaned.replace(pattern, "").trim();
      break;
    }
  }

  // If the response doesn't start with { or [, try to find the first JSON object or array
  if (!cleaned.startsWith("{") && !cleaned.startsWith("[")) {
    // Try to find a JSON object first (more common)
    const jsonObjectStart = cleaned.indexOf("{");
    const jsonArrayStart = cleaned.indexOf("[");
    
    let startIndex = -1;
    if (jsonObjectStart !== -1 && jsonArrayStart !== -1) {
      startIndex = Math.min(jsonObjectStart, jsonArrayStart);
    } else if (jsonObjectStart !== -1) {
      startIndex = jsonObjectStart;
    } else if (jsonArrayStart !== -1) {
      startIndex = jsonArrayStart;
    }
    
    if (startIndex !== -1) {
      cleaned = cleaned.substring(startIndex);
    }
  }

  // Try to find and extract a balanced JSON object or array
  if (cleaned.startsWith("{") || cleaned.startsWith("[")) {
    const openChar = cleaned[0];
    const closeChar = openChar === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    let endIndex = -1;
    
    for (let i = 0; i < cleaned.length; i++) {
      const char = cleaned[i];
      
      if (escaped) {
        escaped = false;
        continue;
      }
      
      if (char === "\\") {
        escaped = true;
        continue;
      }
      
      if (char === '"') {
        inString = !inString;
        continue;
      }
      
      if (inString) continue;
      
      if (char === openChar || (openChar === "{" ? char === "{" : char === "[")) {
        depth++;
      } else if (char === closeChar || (openChar === "{" ? char === "}" : char === "]")) {
        depth--;
        if (depth === 0) {
          endIndex = i + 1;
          break;
        }
      }
    }
    
    if (endIndex !== -1 && endIndex <= cleaned.length) {
      cleaned = cleaned.substring(0, endIndex);
    }
  }

  return cleaned;
}

/**
 * Call Google Gemini API with Azure OpenAI-like payload format.
 */
async function callGeminiApi(
  payload: AzureOpenAIPayload,
  model: string = GEMINI_MODEL_ID,
  apiKey: string = GEMINI_API_KEY,
  retries: number = 2,
  backoff: number = 1.0
): Promise<AzureOpenAIResponse> {
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  // Extract parameters from Azure OpenAI-style payload
  const messages = payload.messages || [];
  const temperature = payload.temperature ?? 0.5;
  const maxTokens = payload.max_tokens ?? 65536;
  const responseFormat = payload.response_format;

  // Convert messages to Gemini format
  const geminiContents: any[] = [];
  let systemInstruction: string | null = null;

  for (const msg of messages) {
    const role = msg.role;
    const content = msg.content;

    if (role === "system") {
      // Gemini handles system instructions separately
      systemInstruction = content;
    } else if (role === "user") {
      geminiContents.push({
        role: "user",
        parts: [{ text: content }],
      });
    } else if (role === "assistant") {
      geminiContents.push({
        role: "model", // Gemini uses "model" instead of "assistant"
        parts: [{ text: content }],
      });
    }
  }

  // Add system instruction if present
  const systemInstructionObj = systemInstruction ? {
    parts: [{ text: systemInstruction }],
  } : undefined;

  // Track if JSON format is requested
  const wantsJson = responseFormat && typeof responseFormat === "object" && responseFormat.type === "json_object";

  // If JSON response format is requested, add to prompt
  if (wantsJson) {
    // Prepend JSON instruction to the last user message
    if (geminiContents.length > 0 && geminiContents[geminiContents.length - 1].role === "user") {
      const originalText = geminiContents[geminiContents.length - 1].parts[0].text;
      geminiContents[geminiContents.length - 1].parts[0].text =
        "CRITICAL: Your response MUST be ONLY a valid JSON object. Start directly with { and end with }. NO preamble text like 'Here is the JSON', NO markdown, NO explanations before or after the JSON.\n\n" +
        originalText;
    }
  }

  const endpoint = GEMINI_BASE_ENDPOINT.replace("{model}", model).replace("{key}", apiKey);
  const headers = { "Content-Type": "application/json" };

  // Helper function to build request body
  const buildBody = (includeMaxTokens: boolean) => {
    const generationConfig: any = {
      temperature: temperature,
    };
    
    // Only use thinkingConfig for non-JSON responses or with lower thinking level for JSON
    // Thinking models sometimes ignore responseMimeType, so we reduce thinking for JSON
    if (wantsJson) {
      // For JSON responses, use lower thinking level to improve format compliance
      generationConfig.thinkingConfig = {
        thinkingLevel: "MEDIUM",
      };
      generationConfig.responseMimeType = "application/json";
    } else {
      generationConfig.thinkingConfig = {
        thinkingLevel: "HIGH",
      };
    }
    
    if (includeMaxTokens) {
      generationConfig.maxOutputTokens = maxTokens;
    }
    const body: any = {
      contents: geminiContents,
      generationConfig,
    };
    if (systemInstructionObj) {
      body.systemInstruction = systemInstructionObj;
    }
    return body;
  };

  // Helper function to make the API call and parse response
  const makeCall = async (body: any): Promise<AzureOpenAIResponse> => {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000), // 60 second timeout
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(`Gemini API returned ${resp.status}: ${errorText.substring(0, 400)}`);
    }

    const data = await resp.json();

    // Convert Gemini response to Azure OpenAI format
    const candidates = data.candidates || [];
    if (candidates.length === 0) {
      throw new Error("No candidates in Gemini response");
    }

    const contentParts = candidates[0].content?.parts || [];
    if (contentParts.length === 0) {
      throw new Error("No content parts in Gemini response");
    }

    // When using thinking models, the response may have multiple parts:
    // - Parts with "thought: true" contain the thinking process
    // - The last non-thought part contains the actual response
    // Find the actual response part (not the thinking part)
    let responseContent = "";
    for (let i = contentParts.length - 1; i >= 0; i--) {
      const part = contentParts[i];
      if (part.text && !part.thought) {
        responseContent = part.text;
        break;
      }
    }
    // Fallback to first part if no non-thought part found
    if (!responseContent && contentParts[0].text) {
      responseContent = contentParts[0].text;
    }
    console.log(`🔍 Raw response from Gemini: ${responseContent}`);

    // Clean JSON from markdown code blocks if present
    const cleanedContent = cleanJsonResponse(responseContent);
    if (cleanedContent !== responseContent) {
      console.log(`✅ Cleaned JSON from markdown code blocks`);
    }

    // Extract usage metadata
    const usageMetadata = data.usageMetadata || {};
    const promptTokens = usageMetadata.promptTokenCount || 0;
    const completionTokens = usageMetadata.candidatesTokenCount || 0;
    const totalTokens = usageMetadata.totalTokenCount || promptTokens + completionTokens;

    // Build Azure OpenAI-compatible response
    return {
      choices: [
        {
          message: {
            content: cleanedContent,
            role: "assistant",
          },
          finish_reason: candidates[0].finishReason || "stop",
          index: 0,
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
      },
      id: `gemini-${Date.now()}-${Math.random()}`,
      model: model,
      created: Math.floor(Date.now() / 1000),
    };
  };

  // Retry logic: first try with maxOutputTokens, then without on failure
  let lastError: Error | null = null;

  // Phase 1: Try with maxOutputTokens
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const body = buildBody(true);
      return await makeCall(body);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(`Error in Gemini API call with maxOutputTokens (attempt ${attempt}/${retries}):`, error);
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, backoff * attempt * 1000));
        continue;
      }
    }
  }

  // Phase 2: Retry without maxOutputTokens
  console.warn("[azureOpenAiHelper] Gemini failed with maxOutputTokens, retrying without maxOutputTokens...");
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const body = buildBody(false);
      return await makeCall(body);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(`Error in Gemini API call without maxOutputTokens (attempt ${attempt}/${retries}):`, error);
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, backoff * attempt * 1000));
        continue;
      }
    }
  }

  // Send Slack notification for Gemini failure
  const errorMessage = lastError?.message || `Gemini API call failed after ${retries * 2} attempts`;
  await sendSlackError("Gemini", errorMessage, `Model: ${model}`);
  
  throw lastError || new Error(`Gemini API call failed after ${retries * 2} attempts (with and without maxOutputTokens)`);
}

/**
 * Call Vertex AI (Google Cloud) Gemini API with Azure OpenAI-like payload format.
 * Uses service account authentication via GCP_SERVICE_ACCOUNT_KEY environment variable.
 */
async function callVertexApi(
  payload: AzureOpenAIPayload,
  model: string = VERTEX_MODEL_ID,
  retries: number = 2,
  backoff: number = 1.0
): Promise<AzureOpenAIResponse> {
  if (!GCP_SERVICE_ACCOUNT_KEY) {
    throw new Error("GCP_SERVICE_ACCOUNT_KEY is not configured");
  }

  // Get project ID from service account if not explicitly set
  let projectId = GCP_PROJECT_ID;
  if (!projectId) {
    try {
      const sa = JSON.parse(GCP_SERVICE_ACCOUNT_KEY);
      projectId = sa.project_id;
    } catch (e) {
      throw new Error("GCP_PROJECT_ID is not set and could not be extracted from service account");
    }
  }

  if (!projectId) {
    throw new Error("GCP_PROJECT_ID is not configured");
  }

  // Extract parameters from Azure OpenAI-style payload
  const messages = payload.messages || [];
  const temperature = payload.temperature ?? 0.5;
  const maxTokens = payload.max_tokens ?? 65536;
  const responseFormat = payload.response_format;

  // Convert messages to Gemini format
  const geminiContents: any[] = [];
  let systemInstruction: string | null = null;

  for (const msg of messages) {
    const role = msg.role;
    const content = msg.content;

    if (role === "system") {
      // Gemini handles system instructions separately
      systemInstruction = content;
    } else if (role === "user") {
      geminiContents.push({
        role: "user",
        parts: [{ text: content }],
      });
    } else if (role === "assistant") {
      geminiContents.push({
        role: "model", // Gemini uses "model" instead of "assistant"
        parts: [{ text: content }],
      });
    }
  }

  // Add system instruction if present
  const systemInstructionObj = systemInstruction ? {
    parts: [{ text: systemInstruction }],
  } : undefined;

  // Track if JSON format is requested
  const wantsJson = responseFormat && typeof responseFormat === "object" && responseFormat.type === "json_object";

  // If JSON response format is requested, add to prompt
  if (wantsJson) {
    // Prepend JSON instruction to the last user message
    if (geminiContents.length > 0 && geminiContents[geminiContents.length - 1].role === "user") {
      const originalText = geminiContents[geminiContents.length - 1].parts[0].text;
      geminiContents[geminiContents.length - 1].parts[0].text =
        "CRITICAL: Your response MUST be ONLY a valid JSON object. Start directly with { and end with }. NO preamble text like 'Here is the JSON', NO markdown, NO explanations before or after the JSON.\n\n" +
        originalText;
    }
  }

  // Vertex AI endpoint format
  // Use global endpoint (no location prefix) for "global", otherwise use regional endpoint
  const endpoint = GCP_LOCATION === "global"
    ? `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/global/publishers/google/models/${model}:generateContent`
    : `https://${GCP_LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${GCP_LOCATION}/publishers/google/models/${model}:generateContent`;

  // Helper function to build request body
  const buildBody = (includeMaxTokens: boolean) => {
    const generationConfig: any = {
      temperature: temperature,
    };
    
    // Only use thinkingConfig for non-JSON responses or with lower thinking level for JSON
    // Thinking models sometimes ignore responseMimeType, so we reduce thinking for JSON
    if (wantsJson) {
      // For JSON responses, use lower thinking level to improve format compliance
      generationConfig.thinkingConfig = {
        thinkingLevel: "MEDIUM",
      };
      generationConfig.responseMimeType = "application/json";
    } else {
      generationConfig.thinkingConfig = {
        thinkingLevel: "HIGH",
      };
    }
    
    if (includeMaxTokens) {
      generationConfig.maxOutputTokens = maxTokens;
    }
    const body: any = {
      contents: geminiContents,
      generationConfig,
    };
    if (systemInstructionObj) {
      body.systemInstruction = systemInstructionObj;
    }
    return body;
  };

  // Helper function to make the API call and parse response
  const makeCall = async (body: any): Promise<AzureOpenAIResponse> => {
    // Get access token (handles token refresh)
    const accessToken = await getAccessToken();
    
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
    };

    const resp = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000), // 60 second timeout
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(`Vertex AI API returned ${resp.status}: ${errorText.substring(0, 400)}`);
    }

    const data = await resp.json();

    // Convert Gemini response to Azure OpenAI format
    const candidates = data.candidates || [];
    if (candidates.length === 0) {
      throw new Error("No candidates in Vertex AI response");
    }

    const contentParts = candidates[0].content?.parts || [];
    if (contentParts.length === 0) {
      throw new Error("No content parts in Vertex AI response");
    }

    // When using thinking models, the response may have multiple parts:
    // - Parts with "thought: true" contain the thinking process
    // - The last non-thought part contains the actual response
    // Find the actual response part (not the thinking part)
    let responseContent = "";
    for (let i = contentParts.length - 1; i >= 0; i--) {
      const part = contentParts[i];
      if (part.text && !part.thought) {
        responseContent = part.text;
        break;
      }
    }
    // Fallback to first part if no non-thought part found
    if (!responseContent && contentParts[0].text) {
      responseContent = contentParts[0].text;
    }
    console.log(`🔍 Raw response from Vertex AI: ${responseContent}`);

    // Clean JSON from markdown code blocks if present
    const cleanedContent = cleanJsonResponse(responseContent);
    if (cleanedContent !== responseContent) {
      console.log(`✅ Cleaned JSON from markdown code blocks`);
    }

    // Extract usage metadata
    const usageMetadata = data.usageMetadata || {};
    const promptTokens = usageMetadata.promptTokenCount || 0;
    const completionTokens = usageMetadata.candidatesTokenCount || 0;
    const totalTokens = usageMetadata.totalTokenCount || promptTokens + completionTokens;

    // Build Azure OpenAI-compatible response
    return {
      choices: [
        {
          message: {
            content: cleanedContent,
            role: "assistant",
          },
          finish_reason: candidates[0].finishReason || "stop",
          index: 0,
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
      },
      id: `vertex-${Date.now()}-${Math.random()}`,
      model: model,
      created: Math.floor(Date.now() / 1000),
    };
  };

  // Retry logic: first try with maxOutputTokens, then without on failure
  let lastError: Error | null = null;

  // Phase 1: Try with maxOutputTokens
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const body = buildBody(true);
      return await makeCall(body);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(`Error in Vertex AI API call with maxOutputTokens (attempt ${attempt}/${retries}):`, error);
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, backoff * attempt * 1000));
        continue;
      }
    }
  }

  // Phase 2: Retry without maxOutputTokens
  console.warn("[azureOpenAiHelper] Vertex AI failed with maxOutputTokens, retrying without maxOutputTokens...");
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const body = buildBody(false);
      return await makeCall(body);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(`Error in Vertex AI API call without maxOutputTokens (attempt ${attempt}/${retries}):`, error);
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, backoff * attempt * 1000));
        continue;
      }
    }
  }

  // Send Slack notification for Vertex AI failure
  const errorMessage = lastError?.message || `Vertex AI API call failed after ${retries * 2} attempts`;
  await sendSlackError("Vertex AI", errorMessage, `Model: ${model}, Location: ${GCP_LOCATION}`);
  
  throw lastError || new Error(`Vertex AI API call failed after ${retries * 2} attempts (with and without maxOutputTokens)`);
}

/**
 * Make a call to Azure OpenAI API, Gemini API, or Vertex AI using the SDK.
 * Default: try Azure OpenAI first, fallback to Gemini (API key), then Vertex AI on failure.
 */
export async function callAzureOpenAI(
  payload: AzureOpenAIPayload,
  options: CallOptions = {}
): Promise<AzureOpenAIResponse> {
  const { provider = "azure" } = options;

  // If explicitly Gemini (API key), use Gemini only
  if (provider.toLowerCase() === "gemini") {
    if (!GEMINI_API_KEY) {
      throw new Error("Gemini API key is not set. Please set GEMINI_API_KEY.");
    }
    const result = await callGeminiApi(payload);
    console.log(`[azureOpenAiHelper] Used: Gemini (${result.model})`);
    return result;
  }

  // If explicitly Vertex, use Vertex only
  if (provider.toLowerCase() === "vertex") {
    if (!GCP_SERVICE_ACCOUNT_KEY) {
      throw new Error("Vertex AI is not configured. Please set GCP_SERVICE_ACCOUNT_KEY.");
    }
    const result = await callVertexApi(payload);
    console.log(`[azureOpenAiHelper] Used: Vertex AI (${result.model})`);
    return result;
  }

  // Default / Azure: try Azure OpenAI first, fallback to Gemini (API key), then Vertex AI

  // Try Azure OpenAI first
  try {
    if (API_KEY) {
      const result = await callAzureOpenAIInternal(payload, options);
      console.log(`[azureOpenAiHelper] Used: Azure OpenAI (${result.model})`);
      return result;
    }
  } catch (azureError) {
    const errorStr =
      azureError instanceof Error
        ? `${azureError.name}: ${azureError.message}\n${azureError.stack ?? ""}`
        : String(azureError);
    console.error("[azureOpenAiHelper] Azure OpenAI error:", errorStr);
    console.warn("[azureOpenAiHelper] Azure OpenAI failed, falling back to Gemini (API key)");
  }

  // Try Gemini (API key) as first fallback
  try {
    if (GEMINI_API_KEY) {
      const result = await callGeminiApi(payload);
      console.log(`[azureOpenAiHelper] Used: Gemini (${result.model}) [fallback from Azure]`);
      return result;
    }
  } catch (geminiError) {
    const errorStr =
      geminiError instanceof Error
        ? `${geminiError.name}: ${geminiError.message}\n${geminiError.stack ?? ""}`
        : String(geminiError);
    console.error("[azureOpenAiHelper] Gemini error:", errorStr);
    console.warn("[azureOpenAiHelper] Gemini failed, falling back to Vertex AI");
  }

  // Fallback to Vertex AI (only if USE_VERTEX is enabled and credentials present)
  if (USE_VERTEX && GCP_SERVICE_ACCOUNT_KEY) {
    const result = await callVertexApi(payload);
    console.log(`[azureOpenAiHelper] Used: Vertex AI (${result.model}) [fallback]`);
    return result;
  }

  throw new Error(
    "All providers failed or unconfigured. Set AZURE_OPENAI_API_KEY, GEMINI_API_KEY, or GCP_SERVICE_ACCOUNT_KEY (with USE_VERTEX=true)."
  );
}

/**
 * Internal Azure OpenAI call (no fallback logic).
 */
async function callAzureOpenAIInternal(
  payload: AzureOpenAIPayload,
  options: CallOptions = {}
): Promise<AzureOpenAIResponse> {

  // Extract parameters from payload
  const messages = payload.messages || [];
  const temperature = payload.temperature ?? 0.3;
  const topP = payload.top_p ?? 0.85;
  const maxTokens = payload.max_tokens ?? 128000;
  const responseFormat = payload.response_format;

  // Determine which deployment to use
  const deployment = options.endpoint === AZURE_ENDPOINT ? DEPLOYMENT_NAME_MINI : DEPLOYMENT_NAME;

  // Create client with the appropriate deployment
  const client = createAzureOpenAIClient(deployment);

  // Build completion parameters
  const completionParams: any = {
    model: deployment,
    messages: messages,
    max_tokens: maxTokens,
    temperature: temperature,
    top_p: topP,
    stream: false,
  };

  // Add response format if specified
  if (responseFormat && typeof responseFormat === "object" && responseFormat.type === "json_object") {
    completionParams.response_format = { type: "json_object" };
  }

  // Make the API call
  try {
    const completion = await client.chat.completions.create(completionParams);

    // Convert to dictionary format matching old API response structure
    const responseContent = completion.choices[0].message.content || "";
    console.log(`🔍 Raw response from Azure OpenAI: ${responseContent}`);

    // Clean JSON from markdown code blocks if present
    const cleanedContent = cleanJsonResponse(responseContent);
    if (cleanedContent !== responseContent) {
      console.log(`✅ Cleaned JSON from markdown code blocks`);
    }

    const responseDict: AzureOpenAIResponse = {
      choices: [
        {
          message: {
            content: cleanedContent,
            role: completion.choices[0].message.role || "assistant",
          },
          finish_reason: completion.choices[0].finish_reason || "stop",
          index: 0,
        },
      ],
      usage: {
        prompt_tokens: completion.usage?.prompt_tokens || 0,
        completion_tokens: completion.usage?.completion_tokens || 0,
        total_tokens: completion.usage?.total_tokens || 0,
      },
      id: completion.id,
      model: completion.model,
      created: completion.created,
    };

    return responseDict;
  } catch (error) {
    console.error("Error calling Azure OpenAI:", error);
    throw error;
  }
}

/**
 * Extract JSON from a response that may be wrapped in markdown code blocks.
 */
export function extractJsonFromResponse(content: string): any {
  // First, try to parse directly
  try {
    return JSON.parse(content);
  } catch (e) {
    // Continue to try other methods
  }

  // Try to extract from markdown code blocks (```json ... ``` or ``` ... ```)
  const codeBlockPattern = /```(?:json)?\s*\n?(.*?)\n?```/s;
  const match = content.match(codeBlockPattern);
  if (match) {
    try {
      return JSON.parse(match[1].trim());
    } catch (e) {
      // Continue to try other methods
    }
  }

  // Try to find any JSON object in the content
  const jsonMatch = content.match(/\{.*\}/s);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      // Continue
    }
  }

  // If all else fails, throw an error
  throw new Error("Could not extract valid JSON from response");
}

export interface GetCompletionOptions {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  response_format?: "json_object" | "text";
  endpoint?: string;
  provider?: "azure" | "gemini" | "vertex";
}

/**
 * Get a completion from Azure OpenAI, Gemini, or Vertex AI with simplified parameters and robust JSON handling.
 * Default: Azure OpenAI first, fallback to Gemini (API key), then Vertex AI.
 */
export async function getCompletion(
  messages: Message[],
  options: GetCompletionOptions = {}
): Promise<any> {
  const {
    temperature = 0.5,
    top_p = 0.85,
    max_tokens,
    response_format = "json_object",
    endpoint,
    provider = "azure",
  } = options;

  const providerName =
    provider.toLowerCase() === "gemini" ? "Gemini (API key)" :
    provider.toLowerCase() === "vertex" ? "Vertex AI" :
    "Azure OpenAI (fallback: Gemini, Vertex)";
  console.log(
    `🚀 Making request to ${providerName} with ${messages.length} messages, format: ${response_format}`
  );

  const payload: AzureOpenAIPayload = {
    messages,
    temperature,
    top_p,
    max_tokens,
  };

  if (response_format === "json_object") {
    payload.response_format = { type: "json_object" };
  }

  const parseOrError = (content: string): { ok: true; data: any } | { ok: false; error: string; raw_content: string } => {
    try {
      return { ok: true, data: extractJsonFromResponse(content) };
    } catch (e) {
      return { ok: false, error: String(e), raw_content: content };
    }
  };

  const callAndParse = async (
    useProvider: "azure" | "gemini" | "vertex"
  ): Promise<{ ok: true; data: any } | { ok: false; error: string; raw_content?: string }> => {
    const responseData = await callAzureOpenAI(payload, { endpoint, provider: useProvider });
    if (!responseData.choices?.length) return { ok: false, error: "No response from API" };
    const content = responseData.choices[0].message.content;
    if (response_format !== "json_object") return { ok: true, data: content };
    const parsed = parseOrError(content);
    if (parsed.ok) return parsed;
    return { ok: false, error: parsed.error, raw_content: parsed.raw_content };
  };

  try {
    // First attempt with configured provider (default: azure)
    let result = await callAndParse(provider);
    if (!result.ok && result.raw_content) {
      console.warn("[azureOpenAiHelper] JSON parse failed, retrying once with same provider");
      result = await callAndParse(provider);
    }
    // If azure failed, try gemini
    if (!result.ok && result.raw_content && provider === "azure") {
      console.warn("[azureOpenAiHelper] Retry failed, switching to Gemini (API key)");
      result = await callAndParse("gemini");
    }
    // If still failed (azure or gemini), try vertex
    if (!result.ok && result.raw_content && provider !== "vertex") {
      console.warn("[azureOpenAiHelper] Retry failed, switching to Vertex AI");
      result = await callAndParse("vertex");
    }
    if (!result.ok && result.raw_content) {
      console.warn("[azureOpenAiHelper] Vertex JSON parse failed, retrying Vertex once");
      result = await callAndParse("vertex");
    }
    if (result.ok) return result.data;
    return {
      error: "Failed to parse JSON response",
      raw_content: result.raw_content,
      json_error: result.error,
    };
  } catch (error) {
    console.error("Error in getCompletion:", error);
    return { error: String(error) };
  }
}

/**
 * Get a JSON completion from Azure OpenAI, Gemini, or Vertex AI with robust error handling.
 * This is a convenience function for scripts that expect JSON responses.
 * Default: Azure OpenAI first, fallback to Gemini (API key), then Vertex AI.
 */
export async function getJsonCompletion(
  messages: Message[],
  options: Omit<GetCompletionOptions, "response_format"> = {}
): Promise<any> {
  return await getCompletion(messages, { ...options, response_format: "json_object" });
}

