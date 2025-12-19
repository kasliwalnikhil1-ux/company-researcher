import React from 'react';
import { downloadCsv, companiesToCsv } from '@/lib/csvExport';

interface ExportCsvButtonProps {
  companies: Array<{companyName: string, data: any}>;
  className?: string;
}

const ExportCsvButton: React.FC<ExportCsvButtonProps> = ({ 
  companies,
  className = ''
}) => {
  const handleExport = () => {
    if (!companies?.length) return;
    
    try {
      const csvString = companiesToCsv(companies);
      downloadCsv(csvString, 'search-results.csv');
    } catch (error) {
      console.error('Failed to export CSV:', error);
      alert('Failed to export CSV. Please check the console for details.');
    }
  };

  if (!companies?.length) return null;

  return (
    <button
      onClick={handleExport}
      aria-label="Export search results to CSV"
      className={`
        fixed bottom-6 right-6 px-6 py-3 rounded-full 
        bg-blue-600 hover:bg-blue-700 text-white 
        shadow-lg hover:shadow-xl transition-all duration-200
        flex items-center space-x-2 z-50
        focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2
        ${className}
      `}
    >
      <svg 
        xmlns="http://www.w3.org/2000/svg" 
        className="h-5 w-5" 
        viewBox="0 0 20 20" 
        fill="currentColor"
      >
        <path 
          fillRule="evenodd" 
          d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" 
          clipRule="evenodd" 
        />
      </svg>
      <span>Export CSV</span>
    </button>
  );
};

export default ExportCsvButton;
