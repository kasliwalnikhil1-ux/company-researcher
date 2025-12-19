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
    mindMap
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

  // Define CSV headers in the required order
  const headers = [
    'Company Name',
    'Company LinkedIn Profile',
    'CEO Profile',
    'CTO Profile',
    'Founders',
    'Similar Companies',
    'Latest News',
    'Company Mentions on Reddit',
    'GitHub',
    'Summary',
    'Mind Map'
  ];

  // Convert each company to a CSV row
  const rows = normalizedCompanies.map(company => {
    // Join array fields with appropriate separators
    const row = [
      company.companyName,
      company.linkedInProfile,
      company.ceoProfile,
      company.ctoProfile,
      company.founders.join('; '),
      company.similarCompanies.join('; '),
      company.latestNews.join('\n'),
      company.companyMentionsOnReddit.join('\n'),
      company.github,
      company.summary,
      company.mindMap
    ];
    
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
