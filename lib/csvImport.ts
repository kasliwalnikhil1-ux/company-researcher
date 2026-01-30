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
    if (value === null || value === undefined) return '';
    
    const str = String(value);
    // If the string contains commas, quotes, or newlines, wrap it in quotes and escape existing quotes
    if (/[,\n"]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const headerLine = headers.map(escapeCsvField).join(',');
  const rowLines = rows.map(row => 
    headers.map(header => escapeCsvField(row[header] || '')).join(',')
  );

  return [headerLine, ...rowLines].join('\n');
};

// Add or update columns in CSV rows
export const mergeQualificationData = (
  rows: CsvRow[],
  urlColumn: string,
  qualificationDataMap: Map<string, any>
): CsvRow[] => {
  const newRows = rows.map(row => {
    const url = row[urlColumn] || '';
    const qualificationData = qualificationDataMap.get(url);
    
    if (!qualificationData) {
      return row; // No data to merge
    }

    const updatedRow = { ...row };
    
    // Add or update qualification columns
    updatedRow['Company Summary'] = qualificationData.company_summary || qualificationData.profile_summary || updatedRow['Company Summary'] || '';
    updatedRow['Company Industry'] = qualificationData.company_industry || qualificationData.profile_industry || updatedRow['Company Industry'] || '';
    updatedRow['Sales Opener Sentence'] = qualificationData.sales_opener_sentence || updatedRow['Sales Opener Sentence'] || '';
    updatedRow['Classification'] = qualificationData.classification || updatedRow['Classification'] || '';
    // Only update confidence score if it exists
    if (qualificationData.confidence_score !== undefined) {
      updatedRow['Confidence Score'] = String(qualificationData.confidence_score);
    }
    
    // Handle product types
    if (qualificationData.product_types && Array.isArray(qualificationData.product_types)) {
      const productTypes = qualificationData.product_types.filter((pt: any) => pt && typeof pt === 'string');
      if (productTypes.length > 0) {
        // Format product types as string: "A", "A and B", or "A, B, and C"
        if (productTypes.length === 1) {
          updatedRow['Product Types'] = productTypes[0];
        } else if (productTypes.length === 2) {
          updatedRow['Product Types'] = `${productTypes[0]} and ${productTypes[1]}`;
        } else {
          const allButLast = productTypes.slice(0, -1).join(', ');
          updatedRow['Product Types'] = `${allButLast}, and ${productTypes[productTypes.length - 1]}`;
        }
        
        // Add individual product type columns
        productTypes.forEach((pt: string, index: number) => {
          updatedRow[`PRODUCT${index + 1}`] = pt;
        });
      }
    }
    
    updatedRow['Sales Action'] = qualificationData.sales_action || updatedRow['Sales Action'] || '';
    
    return updatedRow;
  });

  return newRows;
};

// Ensure all required columns exist in headers
export const ensureColumnsExist = (headers: string[]): string[] => {
  const requiredColumns = [
    'Company Summary',
    'Company Industry',
    'Sales Opener Sentence',
    'Classification',
    'Confidence Score',
    'Product Types',
    'Sales Action',
    'Research Status',
    'Cleaned URL',
    'Entity Type',
    'Is Investor',
    'Clean Name',
    'Investor Types',
    'Links',
  ];
  
  const newHeaders = [...headers];
  
  requiredColumns.forEach(col => {
    if (!newHeaders.includes(col)) {
      newHeaders.push(col);
    }
  });
  
  return newHeaders;
};
