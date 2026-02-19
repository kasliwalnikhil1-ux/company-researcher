import { SupabaseClient } from '@supabase/supabase-js';

interface GenerateFilledPresentationParams {
  supabaseClient: SupabaseClient;
  templateUrl: string;
  data: Record<string, unknown>;
  copyName?: string;
  imageIdentifier?: string;
  faviconUrl?: string;
}

interface GenerateFilledPresentationResult {
  presentationUrl: string;
  presentationId: string;
  replaceResult: Record<string, unknown>;
}

export interface DuplicateTemplateResult {
  presentationUrl: string;
  presentationId: string;
  accessToken?: string;
}

export interface ReplaceInPresentationParams {
  supabaseClient: SupabaseClient;
  presentationId: string;
  presentationUrl: string;
  data: Record<string, unknown>;
  accessToken?: string;
  imageIdentifier?: string;
  faviconUrl?: string;
}

function extractErrorMessage(err: unknown, fallback: string): string {
  if (!err) return fallback;
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null) {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === 'string') return obj.message;
    if (typeof obj.error === 'string') return obj.error;
    if (typeof obj.msg === 'string') return obj.msg;
  }
  if (typeof err === 'string') return err;
  return fallback;
}

/**
 * Step 1 — Duplicate a Google Slides template and return the new presentation info.
 */
export async function duplicateTemplate({
  supabaseClient,
  templateUrl,
  copyName,
}: {
  supabaseClient: SupabaseClient;
  templateUrl: string;
  copyName?: string;
}): Promise<DuplicateTemplateResult> {
  if (!templateUrl || !templateUrl.includes('/d/')) {
    throw new Error(
      'Invalid template URL. Please provide a valid Google Slides URL.'
    );
  }

  let duplicateResult: Record<string, unknown> | null = null;
  try {
    const body: Record<string, string> = { file_url: templateUrl };
    if (copyName) body.copy_name = copyName;

    const resp = await supabaseClient.functions.invoke('duplicate-google-file', {
      body,
    });

    if (resp.error) {
      throw new Error(
        extractErrorMessage(resp.error, 'The duplicate-google-file function returned an error.')
      );
    }

    duplicateResult = resp.data;
  } catch (err) {
    if (err instanceof Error && err.message !== 'Failed to send request') throw err;
    throw new Error(
      'Network error while duplicating the template. Check your connection and try again.'
    );
  }

  if (!duplicateResult?.url || typeof duplicateResult.url !== 'string') {
    throw new Error(
      'The duplicate function did not return a valid presentation URL.'
    );
  }

  const newUrl: string = duplicateResult.url;
  const accessToken = typeof duplicateResult.accessToken === 'string'
    ? duplicateResult.accessToken
    : undefined;
  const presentationId = newUrl.match(/\/d\/([^/]+)/)?.[1];

  if (!presentationId) {
    throw new Error(
      'Could not extract a presentation ID from the duplicated URL. Received: ' +
      newUrl.slice(0, 120)
    );
  }

  return {
    presentationUrl: `${newUrl}/edit`,
    presentationId,
    accessToken,
  };
}

/**
 * Step 2 — Replace placeholders and images in a duplicated presentation.
 */
export async function replaceInPresentation({
  supabaseClient,
  presentationId,
  presentationUrl,
  data,
  accessToken,
  imageIdentifier = '',
  faviconUrl = '',
}: ReplaceInPresentationParams): Promise<GenerateFilledPresentationResult> {
  if (!data || Object.keys(data).length === 0) {
    throw new Error('No data provided to fill the presentation.');
  }

  let replaceResult: Record<string, unknown> | null = null;
  try {
    const replaceBody: Record<string, unknown> = {
      presentation_id: presentationId,
      image_identifier: imageIdentifier,
      favicon_url: faviconUrl,
      data,
    };
    if (accessToken) replaceBody.accessToken = accessToken;

    const resp = await supabaseClient.functions.invoke('replace_in_google_slides', {
      body: replaceBody,
    });

    if (resp.error) {
      throw new Error(
        extractErrorMessage(resp.error, 'The replace_in_google_slides function returned an error.')
      );
    }

    replaceResult = resp.data;
  } catch (err) {
    if (err instanceof Error && err.message !== 'Failed to send request') throw err;
    throw new Error(
      'Network error while replacing placeholders. The presentation was duplicated but not filled. ' +
      `You can open it manually: ${presentationUrl}`
    );
  }

  return {
    presentationUrl,
    presentationId,
    replaceResult: replaceResult ?? {},
  };
}

/**
 * Duplicates a Google Slides template and fills it with data (convenience wrapper).
 */
export async function generateFilledPresentation({
  supabaseClient,
  templateUrl,
  data,
  copyName,
  imageIdentifier = '',
  faviconUrl = '',
}: GenerateFilledPresentationParams): Promise<GenerateFilledPresentationResult> {
  const dup = await duplicateTemplate({ supabaseClient, templateUrl, copyName });

  return replaceInPresentation({
    supabaseClient,
    presentationId: dup.presentationId,
    presentationUrl: dup.presentationUrl,
    data,
    accessToken: dup.accessToken,
    imageIdentifier,
    faviconUrl,
  });
}
