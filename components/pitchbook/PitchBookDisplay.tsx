import React from 'react';

interface PitchBookDisplayProps {
  data: {
    name?: string;
    valuation?: number;
    url?: string;
    title?: string;
    [key: string]: any;
  } | null;
}

export default function PitchBookDisplay({ data }: PitchBookDisplayProps) {
  if (!data) return null;
  
  // Format valuation to currency if it exists
  const formatValuation = (val?: number) => {
    if (!val) return 'Not available';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0
    }).format(val);
  };

  // Get company name from data
  const companyName = data.name || data.title || 'Company';
  const valuation = data.valuation ? formatValuation(data.valuation) : null;
  const pitchbookUrl = data.url || `https://pitchbook.com/profiles/company/${encodeURIComponent(companyName)}`;

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden hover:shadow-md transition-shadow duration-200">
      <div className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xl font-semibold text-gray-900">PitchBook Information</h3>
          <div className="w-8 h-8">
            <img
              src="https://pbs.twimg.com/profile_images/1637877946/logo_400x400.png"
              alt="PitchBook"
              className="w-full h-full object-contain"
            />
          </div>
        </div>

        <div className="space-y-4">
          {companyName && (
            <div className="flex items-center">
              <span className="font-medium text-gray-700 w-32 flex-shrink-0">Company:</span>
              <span className="text-gray-900">{companyName}</span>
            </div>
          )}

          {valuation && (
            <div className="flex items-center">
              <span className="font-medium text-gray-700 w-32 flex-shrink-0">Valuation:</span>
              <span className="text-gray-900">{valuation}</span>
            </div>
          )}

          {/* Display any additional data */}
          {Object.entries(data).map(([key, value]) => {
            // Skip if value is empty or already displayed
            if (!value || ['name', 'title', 'valuation', 'url'].includes(key)) return null;
            
            // Format the key for display
            const formattedKey = key
              .replace(/([A-Z])/g, ' $1') // Add space before capital letters
              .replace(/^./, str => str.toUpperCase()) // Capitalize first letter
              .trim();

            return (
              <div key={key} className="flex items-start">
                <span className="font-medium text-gray-700 w-32 flex-shrink-0">
                  {formattedKey}:
                </span>
                <span className="text-gray-900 break-words flex-1">
                  {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                </span>
              </div>
            );
          })}
        </div>

        <div className="mt-6">
          <a
            href={pitchbookUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center text-blue-600 hover:text-blue-800 hover:underline"
          >
            View on PitchBook
            <svg
              className="w-4 h-4 ml-1"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
              ></path>
            </svg>
          </a>
        </div>
      </div>
    </div>
  );
}