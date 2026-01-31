// Shared message template generator
// This is the single source of truth for all message templates

interface QualificationData {
  product_types: string[] | null;
  sales_opener_sentence?: string;
  company_industry?: string;
  profile_industry?: string;
}

// Helper function to unescape common escape sequences in strings
// Converts literal \n, \t, etc. to actual newlines, tabs, etc.
function unescapeString(str: string): string {
  return str
    .replace(/\\n/g, '\n')  // Convert \n to actual newline
    .replace(/\\t/g, '\t')  // Convert \t to actual tab
    .replace(/\\r/g, '\r')  // Convert \r to carriage return
    .replace(/\\\\/g, '\\'); // Convert \\ to single \
}

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

/**
 * Template substitution helper function
 * Replaces ${variable} syntax with actual values and unescapes escape sequences
 *
 * If a placeholder is immediately followed by punctuation (`,`, `!`, `.`), and the variable
 * value ends with any punctuation, the trailing punctuation is removed from the value
 * to avoid duplication (regardless of whether it matches the following punctuation).
 *
 * @param template - Template string with ${variable} placeholders
 * @param variables - Object mapping variable names to their values
 * @returns Template string with variables substituted and escape sequences unescaped
 *
 * @example
 * ```typescript
 * const template = "Hello ${name}, welcome to ${product}";
 * const variables = { name: "John", product: "Company Researcher" };
 * const result = substituteVariables(template, variables);
 * // Returns: "Hello John, welcome to Company Researcher"
 * ```
 *
 * @example
 * ```typescript
 * // Removes duplicate punctuation
 * const template = "${sales_opener_sentence}, we can help";
 * const variables = { sales_opener_sentence: "Hello." };
 * const result = substituteVariables(template, variables);
 * // Returns: "Hello, we can help" (removed . since followed by ,)
 * ```
 *
 * @example
 * ```typescript
 * // Date placeholders
 * const template = "Let's schedule a call ${followUpRelativeDay} at 2 PM";
 * const result = substituteVariables(template, { followUpRelativeDay: "this Tuesday" });
 * // Returns: "Let's schedule a call this Tuesday at 2 PM"
 * ```
 */
export function substituteVariables(template: string, variables: Record<string, string>): string {
  // First unescape the template string to convert \n to actual newlines
  let result = unescapeString(template);

  Object.entries(variables).forEach(([key, value]) => {
    // Match ${variable} followed by optional punctuation (`,`, `!`, `.`)
    // Use a capturing group to check what follows the placeholder
    const regex = new RegExp(`\\$\\{${key}\\}([,\\!.])?`, 'g');

    result = result.replace(regex, (match, followingPunctuation) => {
      let substitutedValue = value;

      // If placeholder is followed by punctuation, remove any trailing punctuation from value
      // This prevents "sentence.," situations by removing punctuation from value when followed by punctuation
      if (followingPunctuation) {
        const lastChar = substitutedValue.slice(-1);
        // Remove trailing punctuation (comma, period, exclamation mark)
        if ([',', '.', '!'].includes(lastChar)) {
          substitutedValue = substitutedValue.slice(0, -1);
        }
      }

      // Return substituted value with the following punctuation (if any)
      return substitutedValue + (followingPunctuation || '');
    });
  });

  return result;
}

/**
 * Generate message templates based on qualification data and research mode
 * @param qualificationData - The qualification data containing product types, sales opener, etc.
 * @param isInstagram - Whether this is Instagram research (true) or domain research (false)
 * @param dbTemplates - Optional array of template strings from database
 * @param holidays - Optional array of holiday dates in YYYY-MM-DD format to skip when calculating follow-up dates
 * @returns Array of message template strings
 */
export const generateMessageTemplates = (
  qualificationData: QualificationData | null | undefined,
  isInstagram: boolean = false,
  dbTemplates?: string[],
  holidays: string[] = []
): string[] => {
  // Only generate messages if QUALIFIED and product_types exist
  if (
    !qualificationData?.product_types ||
    !Array.isArray(qualificationData.product_types) ||
    qualificationData.product_types.length === 0
  ) {
    return [];
  }

  const productTypes = qualificationData.product_types;
  const PRODUCT1 = productTypes[0] || '';
  const PRODUCT2 = productTypes[1] || productTypes[0] || '';
  const salesOpenerSentence = qualificationData.sales_opener_sentence || '';
  const companyIndustry = qualificationData.company_industry || '';
  const profileIndustry = qualificationData.profile_industry || '';

  // If database templates are provided, use them with variable substitution
  if (dbTemplates && dbTemplates.length > 0) {
    const productTypesFormatted = productTypes.length === 1
      ? productTypes[0]
      : productTypes.length === 2
      ? `${productTypes[0]} and ${productTypes[1]}`
      : `${productTypes.slice(0, -1).join(', ')}, and ${productTypes[productTypes.length - 1]}`;

    // Get follow-up date formats
    const followUpDate = getFollowUpDate(new Date(), holidays);

    const variables: Record<string, string> = {
      // Support both camelCase and snake_case naming conventions
      PRODUCT1,
      PRODUCT2,
      sales_opener_sentence: salesOpenerSentence,
      salesOpenerSentence, // camelCase variant
      company_industry: companyIndustry,
      companyIndustry, // camelCase variant
      profile_industry: profileIndustry,
      profileIndustry, // camelCase variant
      product_types: productTypesFormatted,
      productTypes: productTypesFormatted, // camelCase variant
      // Follow-up date placeholders
      followUpFullDate: followUpDate.fullDate,
      followUpWeekdayDate: followUpDate.weekdayDate,
      followUpShortDay: followUpDate.shortDay,
      followUpRelativeDay: followUpDate.relativeDay,
      followUpRelativeShortDay: followUpDate.relativeShortDay,
      followUpDateOnly: followUpDate.dateOnly,
    };

    // Process all database templates and filter out empty ones
    return dbTemplates
      .map(template => template?.trim())
      .filter(template => template && template.length > 0)
      .map(template => substituteVariables(template!, variables));
  }

  // Fallback to hard-coded templates if no database templates
  if (isInstagram) {
    // Instagram Research Message Templates (2 messages)
    const message1 = `Just visited your page - ${salesOpenerSentence} We can create KILLER product photos/videos for your ${PRODUCT1} products using AI, and have worked with top brands like Polki Stories, Onya, and Armuse. Worth a chat?`;

    const message2 = `Just visited your page - ${salesOpenerSentence} We help brands like yours create unlimited, on-brand product photos/videos using AI - specifically to keep up with daily drops without the photoshoot burnout. We've produced content for Polki Stories, Onya, and Armuse. Would you be open to a 10-min chat to show how we could scale your ${PRODUCT1} creatives without you ever writing a single prompt?`;

    return [message1, message2];
  } else {
    // Domain Research Message Templates (4 messages)
    const product_types =
      productTypes.length === 1
        ? productTypes[0]
        : productTypes.length === 2
        ? `${productTypes[0]} and ${productTypes[1]}`
        : `${productTypes.slice(0, -1).join(', ')}, and ${productTypes[productTypes.length - 1]}`;

    const message1 = `John, loved your ${PRODUCT1}! We can create KILLER product photos/videos using AI, and have worked with top brands like Polki Stories, Onya, and Armuse. Worth a chat?`;

    const message2 = `John, saw your ${product_types} products. ${salesOpenerSentence}\n\nWe can deliver end-to-end AI photos and short videos for your ${companyIndustry} catalog, cutting shoot costs by 70% with studio-grade quality.\n\nFree to start. Zero risk. Want samples?`;

    const message3 = `Brands like Polki Stories, Onya, and House of Armuse use our AI photos and short videos to dominate ads, listings, and social.\n\nHappy to run a free live demo with one of your ${PRODUCT2}.`;

    const message4 = `Your ${product_types} products are perfect`;

    return [message1, message2, message3, message4];
  }
};

/** Investor ai_metadata fields for message template substitution */
export interface InvestorAiMetadata {
  line1?: string | null;
  line2?: string | null;
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

  return dbTemplates
    .map((t) => t?.trim())
    .filter((t) => t && t.length > 0)
    .map((t) => substituteVariables(t!, variables));
};
