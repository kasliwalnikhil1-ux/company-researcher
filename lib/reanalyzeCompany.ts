// Shared helpers for (re)analyzing a company via the companymap pipeline.
// Used by both CompanyResearchHome (initial analysis) and CompanyDetailsDrawer
// (re-run analysis from the drawer). Centralizing here keeps the request shape,
// news-draft merging, and persistence semantics in one place.

import { supabase } from '@/utils/supabase/client';
import { fetchCompanyMap, sendSlackNotification, type NewsEmailOpener } from './api';
import type { Company } from '@/contexts/CompaniesContext';

export interface PersonalizationDirect {
  query?: string;
  schema?: any;
}

// Extract `personalization.direct` for the given user from user_settings.
// Returns null when no settings exist or on any error (the API falls back to defaults).
export const fetchPersonalizationDirect = async (
  userId: string | null | undefined
): Promise<PersonalizationDirect | null> => {
  if (!userId) return null;
  try {
    const { data, error } = await supabase
      .from('user_settings')
      .select('personalization')
      .eq('id', userId)
      .single();

    if (error || !data?.personalization) return null;

    const personalization =
      typeof data.personalization === 'string'
        ? JSON.parse(data.personalization)
        : data.personalization;

    return personalization?.direct || null;
  } catch (err) {
    console.error('[fetchPersonalizationDirect] error:', err);
    return null;
  }
};

// Merge a news-draft email opener into a summary blob without mutating the
// input. Only fields with a non-empty value overwrite — when the relevance
// check returns null fields, we keep whatever the previous summary had.
export const mergeNewsDraftIntoSummary = <T extends Record<string, any> | null | undefined>(
  summary: T,
  draft: NewsEmailOpener | null | undefined
): T => {
  if (!summary || !draft) return summary;
  const merged: Record<string, any> = { ...summary };
  if (draft.first_line_to_start_email) {
    merged.first_line_to_start_email = draft.first_line_to_start_email;
  }
  if (draft.subject_line) {
    merged.subject_line = draft.subject_line;
  }
  return merged as T;
};

export interface AnalyzeCompanyArgs {
  // Already extracted/cleaned domain (e.g. "example.com") or LinkedIn person key
  // (e.g. "in/handle") — whatever fetchCompanyMap expects.
  domain: string;
  userId?: string | null;
  personalization?: PersonalizationDirect | null;
  newsDraft?: NewsEmailOpener | null;
}

export interface AnalyzeCompanyResult {
  qualificationData: any | null;
  email: string | null;
  phone: string | null;
  error?: string;
}

// Run the companymap pipeline for a single domain and merge an optional news draft.
// Does NOT persist — callers decide whether to create or update.
export const analyzeCompanyDomain = async (
  args: AnalyzeCompanyArgs
): Promise<AnalyzeCompanyResult> => {
  const { domain, userId, personalization, newsDraft } = args;
  try {
    const raw = await fetchCompanyMap(domain, userId ?? null, personalization ?? null);
    if (!raw) {
      return {
        qualificationData: null,
        email: null,
        phone: null,
        error: 'Could not load qualification data.',
      };
    }
    const qualificationData = mergeNewsDraftIntoSummary(raw, newsDraft ?? null);
    return {
      qualificationData,
      email: qualificationData?.email ?? null,
      phone: qualificationData?.phone ?? null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendSlackNotification(`❌ Unexpected error for ${domain}\nError: ${msg}`).catch(
      (slackError) => console.error('Failed to send Slack notification:', slackError)
    );
    return {
      qualificationData: null,
      email: null,
      phone: null,
      error: msg,
    };
  }
};

export interface ReanalyzeArgs {
  company: Pick<Company, 'id' | 'domain' | 'email' | 'phone'>;
  userId?: string | null;
  // Optional — when omitted, `fetchPersonalizationDirect` is called with `userId`.
  personalization?: PersonalizationDirect | null;
  newsDraft?: NewsEmailOpener | null;
  updateCompany: (
    id: string,
    updates: Partial<Omit<Company, 'id' | 'user_id'>>
  ) => Promise<void>;
}

export interface ReanalyzeResult {
  ok: boolean;
  updates?: Partial<Omit<Company, 'id' | 'user_id'>>;
  error?: string;
}

// Reanalyze an existing company and persist the result via the provided updater.
// Returns the merged update payload so the caller can sync local state (e.g. drawer).
export const reanalyzeCompany = async (args: ReanalyzeArgs): Promise<ReanalyzeResult> => {
  const { company, userId, newsDraft, updateCompany } = args;
  const domain = (company.domain || '').trim();
  if (!domain) {
    return { ok: false, error: 'Company has no domain to reanalyze.' };
  }

  const personalization =
    args.personalization !== undefined
      ? args.personalization
      : await fetchPersonalizationDirect(userId);

  const result = await analyzeCompanyDomain({
    domain,
    userId,
    personalization,
    newsDraft,
  });

  if (!result.qualificationData) {
    return { ok: false, error: result.error || 'Could not load qualification data.' };
  }

  const updates: Partial<Omit<Company, 'id' | 'user_id'>> = {
    summary: result.qualificationData,
    email: result.email || company.email || '',
    phone: result.phone || company.phone || '',
  };

  try {
    await updateCompany(company.id, updates);
    return { ok: true, updates };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
};
