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

// Template substitution helper
// Replaces ${variable} syntax with actual values and unescapes escape sequences
function substituteVariables(template: string, variables: Record<string, string>): string {
  // First unescape the template string to convert \n to actual newlines
  let result = unescapeString(template);
  
  Object.entries(variables).forEach(([key, value]) => {
    // Match ${variable} syntax (e.g., ${PRODUCT1}, ${sales_opener_sentence})
    const regex = new RegExp(`\\$\\{${key}\\}`, 'g');
    result = result.replace(regex, value);
  });
  return result;
}

/**
 * Generate message templates based on qualification data and research mode
 * @param qualificationData - The qualification data containing product types, sales opener, etc.
 * @param isInstagram - Whether this is Instagram research (true) or domain research (false)
 * @param dbTemplates - Optional array of template strings from database
 * @returns Array of message template strings
 */
export const generateMessageTemplates = (
  qualificationData: QualificationData | null | undefined,
  isInstagram: boolean = false,
  dbTemplates?: string[]
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
