/**
 * Azure OpenAI & Google Gemini API Helper Module (server-only)
 *
 * This module provides centralized configuration and helper functions for Azure OpenAI and Google Gemini API calls.
 * Uses API key authentication. Keys must be set via environment variables (no hardcoded fallbacks).
 *
 * Usage:
 *   const response = await callAzureOpenAI(payload);
 *   const response = await callAzureOpenAI(payload, { provider: "gemini" });
 *   const result = await getCompletion(messages, { provider: "gemini" });
 *   const result = await getJsonCompletion(messages, { provider: "gemini" });
 */

import 'server-only';
import OpenAI from 'openai';

// Azure OpenAI Configuration (endpoint/deployment from env or defaults; API key from env only)
const AZURE_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || process.env.ENDPOINT_URL || "https://resourceplan.services.ai.azure.com/";
const DEPLOYMENT_NAME = process.env.AZURE_OPENAI_DEPLOYMENT_NAME || process.env.DEPLOYMENT_NAME || "DeepSeek-V3-0324";
const DEPLOYMENT_NAME_MINI = process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MINI || process.env.DEPLOYMENT_NAME_MINI || "DeepSeek-V3-0324";
const API_VERSION = process.env.AZURE_OPENAI_API_VERSION || "2024-05-01-preview";
const API_KEY = process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_API_KEY || "";

// Gemini Configuration (key from env only)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL_ID = process.env.GEMINI_MODEL_ID || "gemini-2.5-flash";
const GEMINI_BASE_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}";

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
  provider?: "azure" | "gemini";
}

/**
 * Clean JSON response by removing markdown code blocks if present.
 * This handles cases where the API returns JSON wrapped in ```json ... ``` or ``` ... ```
 */
function cleanJsonResponse(content: string): string {
  // Check if content is wrapped in markdown code blocks
  // Pattern matches ```json ... ``` or ``` ... ```
  const codeBlockPattern = /^```(?:json)?\s*\n(.*?)\n```\s*$/s;
  const match = content.trim().match(codeBlockPattern);

  if (match) {
    return match[1].trim();
  }

  // If no markdown blocks found, return original content
  return content;
}

/**
 * Call Google Gemini API with Azure OpenAI-like payload format.
 */
async function callGeminiApi(
  payload: AzureOpenAIPayload,
  model: string = GEMINI_MODEL_ID,
  apiKey: string = GEMINI_API_KEY,
  retries: number = 3,
  backoff: number = 1.0
): Promise<AzureOpenAIResponse> {
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  // Extract parameters from Azure OpenAI-style payload
  const messages = payload.messages || [];
  const temperature = payload.temperature ?? 0.5;
  const maxTokens = payload.max_tokens ?? 2000;
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

  // Build Gemini request body
  const body: any = {
    contents: geminiContents,
    generationConfig: {
      temperature: temperature,
      maxOutputTokens: maxTokens,
    },
  };

  // Add system instruction if present
  if (systemInstruction) {
    body.systemInstruction = {
      parts: [{ text: systemInstruction }],
    };
  }

  // If JSON response format is requested, add to prompt
  if (responseFormat && typeof responseFormat === "object" && responseFormat.type === "json_object") {
    // Prepend JSON instruction to the last user message
    if (geminiContents.length > 0 && geminiContents[geminiContents.length - 1].role === "user") {
      const originalText = geminiContents[geminiContents.length - 1].parts[0].text;
      geminiContents[geminiContents.length - 1].parts[0].text =
        "Please respond with ONLY valid JSON. Do not include markdown code blocks or explanations.\n\n" +
        originalText;
    }
  }

  const endpoint = GEMINI_BASE_ENDPOINT.replace("{model}", model).replace("{key}", apiKey);
  const headers = { "Content-Type": "application/json" };

  // Retry logic
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000), // 60 second timeout
      });

      if (!resp.ok) {
        const errorText = await resp.text();
        const errorMsg = `Gemini API returned ${resp.status}: ${errorText.substring(0, 400)}`;
        console.error(errorMsg);
        if (attempt < retries) {
          await new Promise((resolve) => setTimeout(resolve, backoff * attempt * 1000));
          continue;
        }
        throw new Error(errorMsg);
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

      const responseContent = contentParts[0].text || "";
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
      const responseDict: AzureOpenAIResponse = {
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

      return responseDict;
    } catch (error) {
      console.error(`Error in Gemini API call (attempt ${attempt}/${retries}):`, error);
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, backoff * attempt * 1000));
        continue;
      }
      throw error;
    }
  }

  throw new Error(`Gemini API call failed after ${retries} attempts`);
}

/**
 * Make a call to Azure OpenAI API or Gemini API using the SDK.
 */
export async function callAzureOpenAI(
  payload: AzureOpenAIPayload,
  options: CallOptions = {}
): Promise<AzureOpenAIResponse> {
  const { provider = "azure" } = options;

  // Route to appropriate provider
  if (provider.toLowerCase() === "gemini") {
    return await callGeminiApi(payload);
  }

  // Default: Azure OpenAI
  if (!API_KEY) {
    throw new Error("Azure OpenAI API key is not set. Please set AZURE_OPENAI_API_KEY.");
  }

  // Extract parameters from payload
  const messages = payload.messages || [];
  const temperature = payload.temperature ?? 0.5;
  const topP = payload.top_p ?? 0.85;
  const maxTokens = payload.max_tokens ?? 800;
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
    console.log(`🔍 Raw response from DeepSeek: ${responseContent}`);

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
  provider?: "azure" | "gemini";
}

/**
 * Get a completion from Azure OpenAI or Gemini with simplified parameters and robust JSON handling.
 */
export async function getCompletion(
  messages: Message[],
  options: GetCompletionOptions = {}
): Promise<any> {
  const {
    temperature = 0.5,
    top_p = 0.85,
    max_tokens = 4000,
    response_format = "json_object",
    endpoint,
    provider = "azure",
  } = options;

  const providerName = provider.toLowerCase() === "gemini" ? "Gemini" : "DeepSeek";
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

  try {
    const responseData = await callAzureOpenAI(payload, { endpoint, provider });

    if (responseData.choices && responseData.choices.length > 0) {
      const content = responseData.choices[0].message.content;

      // If JSON format was requested, try to parse it
      if (response_format === "json_object") {
        try {
          return extractJsonFromResponse(content);
        } catch (e) {
          console.error("JSON parsing error:", e);
          console.error("Raw response content:", content);

          // Return error object if JSON parsing fails
          return {
            error: "Failed to parse JSON response",
            raw_content: content,
            json_error: String(e),
          };
        }
      } else {
        return content;
      }
    } else {
      return { error: "No response from API" };
    }
  } catch (error) {
    console.error("Error in getCompletion:", error);
    return { error: String(error) };
  }
}

/**
 * Get a JSON completion from Azure OpenAI or Gemini with robust error handling.
 * This is a convenience function for scripts that expect JSON responses.
 */
export async function getJsonCompletion(
  messages: Message[],
  options: Omit<GetCompletionOptions, "response_format"> = {}
): Promise<any> {
  return await getCompletion(messages, { ...options, response_format: "json_object" });
}

