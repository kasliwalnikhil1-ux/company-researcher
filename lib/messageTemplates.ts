// Shared message template generator
// This is the single source of truth for all message templates

import { substituteVariables } from './utils';
import { summaryKeyToLabel, formatArrayNatural } from './summaryUtils';

/**
 * Get common US holidays for a given year
 * @param year - The year to get holidays for (defaults to current year)
 * @returns Array of holiday dates in YYYY-MM-DD format
 */
export function getCommonUSHolidays(year: number = new Date().getFullYear()): string[] {
  const holidays = [
    `${year}-01-01`, // New Year's Day
    `${year}-01-15`, // Martin Luther King Jr. Day (approximate)
    `${year}-01-26`, // Republic Day / Australia Day
    `${year}-02-14`, // Valentine's Day (business holiday for some)
    `${year}-02-17`, // Presidents' Day (approximate)
    `${year}-05-27`, // Memorial Day (approximate)
    `${year}-07-04`, // Independence Day
    `${year}-09-02`, // Labor Day (approximate)
    `${year}-11-11`, // Veterans Day
    `${year}-11-28`, // Thanksgiving (approximate)
    `${year}-12-25`, // Christmas Day
    `${year}-12-31`, // New Year's Eve (business holiday for some)
  ];
  return holidays;
}

/**
 * Calculate follow-up date (2 days from base date, skipping holidays/weekends) and return various date formats
 * @param baseDate - The base date to calculate from (defaults to today)
 * @param holidays - Array of holiday dates in YYYY-MM-DD format to skip
 * @returns Object with different date format representations
 */
export function getFollowUpDate(baseDate = new Date(), holidays: string[] = []) {
  let result = new Date(baseDate);
  let daysAdded = 0;

  // Convert holidays to Date objects for comparison
  const holidayDates = holidays.map(holiday => {
    const [year, month, day] = holiday.split('-').map(Number);
    return new Date(year, month - 1, day);
  });

  // Helper function to check if a date is a holiday
  const isHoliday = (date: Date) => {
    return holidayDates.some(holiday =>
      holiday.getFullYear() === date.getFullYear() &&
      holiday.getMonth() === date.getMonth() &&
      holiday.getDate() === date.getDate()
    );
  };

  // Helper function to check if a date is a weekend
  const isWeekend = (date: Date) => {
    const day = date.getDay();
    return day === 0 || day === 6; // Sunday = 0, Saturday = 6
  };

  // Add days until we have 2 business days (excluding weekends and holidays)
  while (daysAdded < 2) {
    result.setDate(result.getDate() + 1);

    // Skip if it's a weekend or holiday
    if (!isWeekend(result) && !isHoliday(result)) {
      daysAdded++;
    }
  }

  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const shortDays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // Calculate if the follow-up date is in the same week
  // Get the week number (Monday-based)
  const getWeekNumber = (date: Date) => {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 4 - (d.getDay() || 7));
    const yearStart = new Date(d.getFullYear(), 0, 1);
    return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  };

  const sameWeek = getWeekNumber(baseDate) === getWeekNumber(result);

  const thisOrNext = sameWeek ? "this" : "next";

  return {
    fullDate: `${days[result.getDay()]}, ${months[result.getMonth()]} ${result.getDate()}`,
    weekdayDate: `${days[result.getDay()]} ${months[result.getMonth()]} ${result.getDate()}`,
    shortDay: shortDays[result.getDay()],
    relativeDay: `${thisOrNext} ${days[result.getDay()]}`,
    relativeShortDay: `${thisOrNext} ${shortDays[result.getDay()]}`,
    dateOnly: `${months[result.getMonth()]} ${result.getDate()}`
  };
}

// Re-export substituteVariables from utils for backwards compatibility
export { substituteVariables } from './utils';

/**
 * Generate message templates based on qualification/summary data and research mode.
 * Accepts a generic Record<string, any> so it works with any personalization schema.
 *
 * @param summaryData - The AI-generated summary data (any keys)
 * @param isInstagram - Whether this is Instagram research (true) or domain research (false)
 * @param dbTemplates - Optional array of template strings from database
 * @param holidays - Optional array of holiday dates in YYYY-MM-DD format to skip when calculating follow-up dates
 * @returns Array of message template strings
 */
export const generateMessageTemplates = (
  summaryData: Record<string, any> | null | undefined,
  isInstagram: boolean = false,
  dbTemplates?: string[],
  holidays: string[] = []
): string[] => {
  if (!summaryData) return [];

  // If database templates are provided, build variables from ALL summary fields
  if (dbTemplates && dbTemplates.length > 0) {
    const followUpDate = getFollowUpDate(new Date(), holidays);

    const variables: Record<string, string> = {
      followUpFullDate: followUpDate.fullDate,
      followUpWeekdayDate: followUpDate.weekdayDate,
      followUpShortDay: followUpDate.shortDay,
      followUpRelativeDay: followUpDate.relativeDay,
      followUpRelativeShortDay: followUpDate.relativeShortDay,
      followUpDateOnly: followUpDate.dateOnly,
    };

    // Map every summary key to both snake_case and camelCase variables
    for (const [key, value] of Object.entries(summaryData)) {
      if (value === null || value === undefined) continue;

      // snake_case key
      let strValue: string;
      if (Array.isArray(value)) {
        const filtered = value.filter((v: any) => v != null && typeof v === 'string' && v.trim());
        strValue = formatArrayNatural(filtered);
      } else {
        strValue = String(value);
      }
      variables[key] = strValue;

      // camelCase variant
      const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      if (camelKey !== key) {
        variables[camelKey] = strValue;
      }
    }

    // Legacy convenience aliases for product_types array items
    const productTypes = Array.isArray(summaryData.product_types)
      ? summaryData.product_types.filter((v: any) => v != null && typeof v === 'string' && v.trim())
      : [];
    if (productTypes.length > 0) {
      variables['PRODUCT1'] = productTypes[0] || '';
      variables['PRODUCT2'] = productTypes[1] || productTypes[0] || '';
    }

    return dbTemplates
      .map(template => template?.trim())
      .filter(template => template && template.length > 0)
      .map(template => substituteVariables(template!, variables));
  }

  // No db templates - return empty (hard-coded fallback templates removed to be generic)
  return [];
};

/** Investor ai_metadata fields for message template substitution */
export interface InvestorAiMetadata {
  line1?: string | null;
  line2?: string | null;
  additional_line?: string | null;
  reason?: string | null;
  investor_fit?: boolean | null;
  twitter_line?: string | null;
}

/** Investor data for message template substitution */
export interface InvestorTemplateData {
  name?: string | null;
  investment_thesis?: string | null;
  ai_metadata?: InvestorAiMetadata | null;
}

/**
 * Generate message templates for investors using ai_metadata (line1, line2, reason, investor_fit)
 * and substituteVariables with investor-specific placeholders.
 * @param investorData - Investor name, thesis, ai_metadata
 * @param dbTemplates - Array of template strings from database
 * @param holidays - Optional array of holiday dates in YYYY-MM-DD format
 * @returns Array of message template strings
 */
export const generateInvestorMessageTemplates = (
  investorData: InvestorTemplateData | null | undefined,
  dbTemplates?: string[],
  holidays: string[] = []
): string[] => {
  if (!dbTemplates || dbTemplates.length === 0) return [];

  const aiMeta = investorData?.ai_metadata ?? {};
  const line1 = typeof aiMeta.line1 === 'string' ? aiMeta.line1 : '';
  const line2 = typeof aiMeta.line2 === 'string' ? aiMeta.line2 : '';
  const additionalLine = typeof aiMeta.additional_line === 'string' ? aiMeta.additional_line : '';
  const reason = typeof aiMeta.reason === 'string' ? aiMeta.reason : '';
  const twitterLine = typeof aiMeta.twitter_line === 'string' ? aiMeta.twitter_line : '';
  const investorFit = aiMeta.investor_fit;
  const fitLabel =
    investorFit === true ? 'Strong Fit' : investorFit === false ? 'Weak Fit' : investorFit === null ? 'Unclear Fit' : '';
  const name = investorData?.name?.trim() ?? '';
  const investmentThesis = investorData?.investment_thesis?.trim() ?? '';
  const cleanedName = name ? name.split(/\s+/)[0] || name : '';

  const followUpDate = getFollowUpDate(new Date(), holidays);

  const variables: Record<string, string> = {
    line1,
    line2,
    additional_line: additionalLine,
    additionalLine,
    reason,
    twitter_line: twitterLine,
    twitterLine,
    investor_fit: fitLabel,
    investorFit: fitLabel,
    name,
    cleaned_name: cleanedName,
    cleanedName,
    investment_thesis: investmentThesis,
    investmentThesis: investmentThesis,
    followUpFullDate: followUpDate.fullDate,
    followUpWeekdayDate: followUpDate.weekdayDate,
    followUpShortDay: followUpDate.shortDay,
    followUpRelativeDay: followUpDate.relativeDay,
    followUpRelativeShortDay: followUpDate.relativeShortDay,
    followUpDateOnly: followUpDate.dateOnly,
  };

  // Sentence fields that should always end with punctuation (period added if missing)
  const sentenceFields = [
    'line1',
    'line2',
    'additional_line',
    'additionalLine',
    'twitter_line',
    'twitterLine',
  ];

  return dbTemplates
    .map((t) => t?.trim())
    .filter((t) => t && t.length > 0)
    .map((t) => substituteVariables(t!, variables, sentenceFields));
};
