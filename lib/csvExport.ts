import { generateMessageTemplates } from './messageTemplates';
import { summaryKeyToLabel, formatArrayNatural } from './summaryUtils';

// Normalize company data from the app's state to an exportable record.
// All summary fields are mapped generically from qualificationData.
const normalizeCompanyData = (companyName: string, data: any): Record<string, any> => {
  const result: Record<string, any> = { companyName };

  // Extract qualification data (the AI-generated summary)
  const qualificationData: Record<string, any> = data?.qualificationData || {};

  // Map each summary key to a Title-Case column name
  const summaryColumns: Record<string, string> = {};
  for (const [key, value] of Object.entries(qualificationData)) {
    if (value === null || value === undefined) continue;
    const label = summaryKeyToLabel(key);
    if (Array.isArray(value)) {
      const filtered = value.filter((v: any) => v != null && typeof v === 'string' && v.trim());
      summaryColumns[label] = formatArrayNatural(filtered);
    } else {
      summaryColumns[label] = String(value);
    }
  }
  result.summaryColumns = summaryColumns;

  // Extract email and phone (may come from qualification data or top-level)
  result.email = qualificationData.email || data?.email || '';
  result.phone = qualificationData.phone || data?.phone || '';

  // Determine if this is Instagram research
  const isInstagram = !!qualificationData.profile_summary && !qualificationData.company_summary;

  // Generate message templates
  result.messageTemplates =
    qualificationData.classification === 'QUALIFIED'
      ? generateMessageTemplates(qualificationData, isInstagram)
      : [];

  return result;
};

// Safe helper to escape and quote CSV field values
const csvEscape = (value: any): string => {
  if (value == null) return "";
  const str = String(value);
  return `"${str.replace(/"/g, '""')}"`;
};

// Convert an array of companies to CSV string
export const companiesToCsv = (companies: Array<{companyName: string, data: any}>): string => {
  if (!companies.length) return '';

  // Normalize all company data
  const normalized = companies.map(({ companyName, data }) =>
    normalizeCompanyData(companyName, data)
  );

  // Discover all unique summary column labels across all companies
  const summaryLabelSet = new Set<string>();
  for (const entry of normalized) {
    if (entry.summaryColumns) {
      for (const label of Object.keys(entry.summaryColumns)) {
        summaryLabelSet.add(label);
      }
    }
  }
  const summaryLabels = Array.from(summaryLabelSet);

  // Calculate maximum number of message templates
  const maxMessages = normalized.reduce((max, entry) =>
    Math.max(max, entry.messageTemplates?.length || 0), 0
  );

  // Build headers: Company Name, then all dynamic summary columns, Email, Phone, then messages
  const headers = ['Company Name', ...summaryLabels, 'Email', 'Phone'];

  if (maxMessages > 0) {
    for (let i = 1; i <= maxMessages; i++) {
      headers.push(`Message ${i}`);
    }
  }

  // Convert each company to a CSV row
  const rows = normalized.map(entry => {
    const row: string[] = [entry.companyName];

    // Summary columns in order
    for (const label of summaryLabels) {
      row.push(entry.summaryColumns?.[label] || '');
    }

    row.push(entry.email || '');
    row.push(entry.phone || '');

    if (maxMessages > 0) {
      for (let i = 0; i < maxMessages; i++) {
        row.push(entry.messageTemplates?.[i] || '');
      }
    }

    return row.map(csvEscape).join(',');
  });

  return [
    headers.map(csvEscape).join(','),
    ...rows,
  ].join('\n');
};

// Trigger CSV download in the browser
export const downloadCsv = (csvString: string, filename: string = 'search-results.csv'): void => {
  const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  link.style.visibility = 'hidden';
  
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};
