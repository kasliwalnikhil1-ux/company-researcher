/**
 * Errors from AI providers (Gemini, OpenAI, Anthropic, Vertex…) are never shown as-is: no provider name, status code,
 * quota text or links. Anything that looks like one becomes a short plain message. Use on any error text bound for the UI.
 */
export const AI_BUSY_MESSAGE = 'AI is busy right now. Please try again later.';

const PROVIDER_ERROR = new RegExp(
  [
    'gemini', 'vertex ai', 'generativelanguage', 'googleapis', 'ai\\.google\\.dev', 'aiplatform',
    'azure openai', 'openai', 'anthropic', '\\bgpt-', '\\bclaude-',
    'RESOURCE_EXHAUSTED', 'exceeded your current quota', 'insufficient_quota', 'generate_content',
    'No candidates in', 'E_AI_BUSY', 'E_AI_FAILED', 'the AI did not answer', 'the AI could not draft',
  ].join('|'),
  'i',
);

/** True when this text is (or wraps) an AI provider error. */
export function isAiProviderError(text: unknown): boolean {
  return typeof text === 'string' && PROVIDER_ERROR.test(text);
}

/** The text unchanged, or the plain AI message when it is a provider error. */
export function friendlyErrorText(text: string): string {
  return isAiProviderError(text) ? AI_BUSY_MESSAGE : text;
}
