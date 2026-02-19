// CSV import and processing utilities

export interface CsvRow {
  [key: string]: string;
}

export interface ParsedCsv {
  headers: string[];
  rows: CsvRow[];
}

// Simple CSV parser that handles quoted fields, commas, and newlines
export const parseCsv = (csvText: string): ParsedCsv => {
  const lines = csvText.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length === 0) {
    return { headers: [], rows: [] };
  }

  // Parse header
  const headers = parseCsvLine(lines[0]);
  
  // Parse rows
  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row: CsvRow = {};
    headers.forEach((header, index) => {
      row[header] = values[index] || '';
    });
    rows.push(row);
  }

  return { headers, rows };
};

// Parse a single CSV line, handling quoted fields
const parseCsvLine = (line: string): string[] => {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];
    
    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Escaped quote
        current += '"';
        i++; // Skip next quote
      } else {
        // Toggle quote state
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      // End of field
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  
  // Add last field
  values.push(current.trim());
  
  return values;
};

// Convert CSV data back to CSV string
export const csvToString = (headers: string[], rows: CsvRow[]): string => {
  const escapeCsvField = (value: any): string => {
    if (value === null || value === undefined) return '""';
    
    const str = String(value);
    // Always wrap in quotes and escape existing quotes (prevents URLs with / from breaking columns)
    return `"${str.replace(/"/g, '""')}"`;
  };

  const headerLine = headers.map(escapeCsvField).join(',');
  const rowLines = rows.map(row => 
    headers.map(header => escapeCsvField(row[header] || '')).join(',')
  );

  return [headerLine, ...rowLines].join('\n');
};

// Add or update columns in CSV rows using generic summary data
export const mergeQualificationData = (
  rows: CsvRow[],
  urlColumn: string,
  qualificationDataMap: Map<string, any>
): CsvRow[] => {
  const { writeSummaryToCsvRow } = require('./summaryUtils');

  const newRows = rows.map(row => {
    const url = row[urlColumn] || '';
    const qualificationData = qualificationDataMap.get(url);
    
    if (!qualificationData) {
      return row;
    }

    const updatedRow = { ...row };
    writeSummaryToCsvRow(qualificationData, updatedRow);
    return updatedRow;
  });

  return newRows;
};

// Ensure required non-summary columns exist in headers.
// Summary columns are added dynamically based on what the AI returns.
export const ensureColumnsExist = (
  headers: string[],
  extraColumns?: string[],
): string[] => {
  const alwaysRequired = ['Research Status'];
  
  const newHeaders = [...headers];
  
  for (const col of [...alwaysRequired, ...(extraColumns ?? [])]) {
    if (!newHeaders.includes(col)) {
      newHeaders.push(col);
    }
  }
  
  return newHeaders;
};
