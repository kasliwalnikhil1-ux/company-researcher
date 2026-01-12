// Types for our normalized company data
type ExportableCompany = {
  companyName: string;
  linkedInProfile: string;
  ceoProfile: string;
  ctoProfile: string;
  founders: string[];
  similarCompanies: string[];
  latestNews: string[];
  companyMentionsOnReddit: string[];
  github: string;
  summary: string;
  mindMap: string;
  productTypes: string[];
  companySummary: string;
  companyIndustry: string;
  salesOpenerSentence: string;
  classification: string;
  confidenceScore: number;
  productTypesFormatted: string;
  salesAction: string;
};

// Normalize company data from the app's state to our exportable format
const normalizeCompanyData = (companyName: string, data: any): ExportableCompany => {
  const getField = (possibleKeys: string[], defaultValue: any = '') => {
    if (!data) return defaultValue;
    
    for (const key of possibleKeys) {
      if (data[key] !== undefined && data[key] !== null) {
        return data[key];
      }
    }
    return defaultValue;
  };

  // Helper to convert array of objects to formatted strings
  const formatArray = (items: any[], formatFn: (item: any) => string) => {
    if (!items || !Array.isArray(items)) return [];
    return items.map(item => formatFn(item));
  };

  // Extract LinkedIn profile URL with fallbacks for different possible field names
  const linkedInProfile = data?.linkedinData?.url || 
                         data?.linkedInUrl || 
                         data?.linkedinUrl || 
                         data?.url || '';
  // Extract CEO and CTO profile links
  const ceoProfile = data?.founders?.find((f: any) => f.title === 'CEO')?.url || '';
  const ctoProfile = data?.founders?.find((f: any) => f.title === 'CTO')?.url || '';
  
  const founders = formatArray(data?.founders || [], (f: any) => {
    if (f.title && f.name) return `${f.title}: ${f.name} (${f.url || 'No URL'})`;
    if (f.title) return f.title;
    if (f.name) return f.name;
    return '';
  }).filter(Boolean);
  const similarCompanies = formatArray(data?.competitors || [], (c: any) => c.title || c.name || '').filter(Boolean);
  
  const latestNews = formatArray(data?.news || [], (n: any) => {
    if (n.title && n.url) return `${n.title} - ${n.url}`;
    if (n.title) return n.title;
    if (n.url) return n.url;
    return '';
  }).filter(Boolean);

  const companyMentionsOnReddit = formatArray(data?.redditPosts || [], (p: any) => {
    if (p.title && p.url) return `${p.title} - ${p.url}`;
    if (p.title) return p.title;
    if (p.url) return p.url;
    return '';
  }).filter(Boolean);

  const github = data?.githubUrl || '';
  const summary = data?.companySummary?.summary || data?.summary || '';
  
  // Convert mind map to a simplified string representation
  let mindMap = '';
  if (data?.companyMap?.rootNode) {
    try {
      const { title, children = [] } = data.companyMap.rootNode;
      const sections = children.map((section: any) => 
        `${section.title}: ${(section.children || []).map((item: any) => item.title).join('; ')}`
      );
      mindMap = `${title} | ${sections.join(' | ')}`;
    } catch (e) {
      console.warn('Failed to stringify mind map', e);
    }
  }

  // Extract product_types from qualificationData
  const productTypes: string[] = [];
  if (data?.qualificationData?.product_types && Array.isArray(data.qualificationData.product_types)) {
    productTypes.push(...data.qualificationData.product_types.filter((pt: any) => pt && typeof pt === 'string'));
  }

  // Extract qualification data fields
  const qualificationData = data?.qualificationData || {};
  const companySummary = qualificationData.company_summary || '';
  const companyIndustry = qualificationData.company_industry || '';
  const salesOpenerSentence = qualificationData.sales_opener_sentence || '';
  const classification = qualificationData.classification || '';
  const confidenceScore = qualificationData.confidence_score ?? '';
  const salesAction = qualificationData.sales_action || '';

  // Format product types as string: "A", "A and B", or "A, B, and C"
  const formatProductTypes = (types: string[]): string => {
    if (!types || types.length === 0) return '';
    if (types.length === 1) return types[0];
    if (types.length === 2) return `${types[0]} and ${types[1]}`;
    // For 3 or more: "A, B, and C"
    const allButLast = types.slice(0, -1).join(', ');
    return `${allButLast}, and ${types[types.length - 1]}`;
  };
  const productTypesFormatted = formatProductTypes(productTypes);

  return {
    companyName,
    linkedInProfile,
    ceoProfile,
    ctoProfile,
    founders,
    similarCompanies,
    latestNews,
    companyMentionsOnReddit,
    github,
    summary,
    mindMap,
    productTypes,
    companySummary,
    companyIndustry,
    salesOpenerSentence,
    classification,
    confidenceScore,
    productTypesFormatted,
    salesAction
  };
};

// Escape a CSV field value
const escapeCsvField = (value: any): string => {
  if (value === null || value === undefined) return '';
  
  const str = String(value);
  // If the string contains commas, quotes, or newlines, wrap it in quotes and escape existing quotes
  if (/[,\n"]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

// Convert an array of companies to CSV string
export const companiesToCsv = (companies: Array<{companyName: string, data: any}>): string => {
  if (!companies.length) return '';

  // Normalize all company data
  const normalizedCompanies = companies.map(({ companyName, data }) => 
    normalizeCompanyData(companyName, data)
  );

  // Calculate maximum number of product types across all companies
  const maxProductTypes = normalizedCompanies.reduce((max, company) => {
    return Math.max(max, company.productTypes?.length || 0);
  }, 0);

  // Define CSV headers in the required order
  const headers = [
    'Company Name',
    'Company Summary',
    'Company Industry',
    'Sales Opener Sentence',
    'Classification',
    'Confidence Score',
    'Product Types',
    'Sales Action'
  ];

  // Add dynamic product type headers if there are any product types
  if (maxProductTypes > 0) {
    for (let i = 1; i <= maxProductTypes; i++) {
      headers.push(`PRODUCT${i}`);
    }
  }

  // Convert each company to a CSV row
  const rows = normalizedCompanies.map(company => {
    // Join array fields with appropriate separators
    const row = [
      company.companyName,
      company.companySummary,
      company.companyIndustry,
      company.salesOpenerSentence,
      company.classification,
      company.confidenceScore,
      company.productTypesFormatted,
      company.salesAction
    ];

    // Add product types as separate columns
    if (maxProductTypes > 0) {
      for (let i = 0; i < maxProductTypes; i++) {
        row.push(company.productTypes?.[i] || '');
      }
    }
    
    // Escape each field and join with commas
    return row.map(escapeCsvField).join(',');
  });

  // Combine headers and rows
  return [
    headers.map(escapeCsvField).join(','),
    ...rows
  ].join('\n');
};

// Trigger CSV download in the browser
export const downloadCsv = (csvString: string, filename: string = 'search-results.csv'): void => {
  // Create a Blob with the CSV data
  const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
  
  // Create a download link and trigger it
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  link.style.visibility = 'hidden';
  
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};
