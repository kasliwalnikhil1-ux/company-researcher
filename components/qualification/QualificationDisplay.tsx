'use client';

import React from 'react';

interface QualificationData {
  company_summary: string;
  company_industry: string;
  sales_opener_sentence: string;
  classification: 'QUALIFIED' | 'NOT_QUALIFIED' | 'MAYBE';
  confidence_score: number;
  product_types: string[] | null;
  sales_action: 'OUTREACH' | 'EXCLUDE' | 'PARTNERSHIP' | 'MANUAL_REVIEW';
}

interface QualificationDisplayProps {
  data: QualificationData | null;
}

const QualificationDisplay: React.FC<QualificationDisplayProps> = ({ data }) => {
  if (!data) {
    return (
      <div className="w-full bg-white border shadow-sm p-4 sm:p-8 mt-2 rounded-lg">
        <p className="text-gray-500">No qualification data available</p>
      </div>
    );
  }

  const getClassificationColor = (classification: string) => {
    switch (classification) {
      case 'QUALIFIED':
        return 'bg-green-100 text-green-800 border-green-300';
      case 'NOT_QUALIFIED':
        return 'bg-red-100 text-red-800 border-red-300';
      case 'MAYBE':
        return 'bg-yellow-100 text-yellow-800 border-yellow-300';
      default:
        return 'bg-gray-100 text-gray-800 border-gray-300';
    }
  };

  const getSalesActionColor = (action: string) => {
    switch (action) {
      case 'OUTREACH':
        return 'bg-blue-100 text-blue-800 border-blue-300';
      case 'EXCLUDE':
        return 'bg-red-100 text-red-800 border-red-300';
      case 'PARTNERSHIP':
        return 'bg-purple-100 text-purple-800 border-purple-300';
      case 'MANUAL_REVIEW':
        return 'bg-orange-100 text-orange-800 border-orange-300';
      default:
        return 'bg-gray-100 text-gray-800 border-gray-300';
    }
  };

  const getConfidenceColor = (score: number) => {
    if (score >= 0.8) return 'text-green-600';
    if (score >= 0.6) return 'text-yellow-600';
    return 'text-red-600';
  };

  return (
    <div className="w-full bg-white border shadow-sm p-4 sm:p-8 mt-2 rounded-lg">
      <div className="space-y-6">
        <div>
          <h3 className="text-xl font-semibold text-gray-900 mb-4">Sales Qualification Assessment</h3>
        </div>

        {/* Company Summary */}
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-gray-700 uppercase tracking-wide">Company Summary</h4>
          <p className="text-gray-700 leading-relaxed text-sm sm:text-base">
            {data.company_summary}
          </p>
        </div>

        {/* Company Industry */}
        {data.company_industry && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-gray-700 uppercase tracking-wide">Company Industry</h4>
            <p className="text-gray-700 leading-relaxed text-sm sm:text-base">
              {data.company_industry}
            </p>
          </div>
        )}

        {/* Sales Opener Sentence */}
        {data.sales_opener_sentence && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-gray-700 uppercase tracking-wide">Sales Opener Sentence</h4>
            <p className="text-gray-700 leading-relaxed text-sm sm:text-base italic">
              {data.sales_opener_sentence}
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Classification */}
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-gray-700 uppercase tracking-wide">Classification</h4>
            <div className={`inline-flex items-center px-3 py-1.5 rounded-full border font-semibold text-sm ${getClassificationColor(data.classification)}`}>
              {data.classification}
            </div>
          </div>

          {/* Confidence Score */}
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-gray-700 uppercase tracking-wide">Confidence Score</h4>
            <div className="flex items-center gap-2">
              <span className={`text-2xl font-bold ${getConfidenceColor(data.confidence_score)}`}>
                {(data.confidence_score * 100).toFixed(0)}%
              </span>
              <div className="flex-1 bg-gray-200 rounded-full h-2.5">
                <div
                  className={`h-2.5 rounded-full ${
                    data.confidence_score >= 0.8
                      ? 'bg-green-600'
                      : data.confidence_score >= 0.6
                      ? 'bg-yellow-600'
                      : 'bg-red-600'
                  }`}
                  style={{ width: `${data.confidence_score * 100}%` }}
                ></div>
              </div>
            </div>
          </div>
        </div>

        {/* Product Types - Only show when QUALIFIED and product_types exist */}
        {data.classification === 'QUALIFIED' && data.product_types && Array.isArray(data.product_types) && data.product_types.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-gray-700 uppercase tracking-wide">Product Types</h4>
            <div className="flex flex-wrap gap-2">
              {data.product_types.map((type, index) => (
                <span
                  key={index}
                  className="inline-flex items-center px-3 py-1 rounded-md bg-blue-50 text-blue-700 border border-blue-200 text-sm font-medium capitalize"
                >
                  {type}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Sales Action */}
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-gray-700 uppercase tracking-wide">Recommended Sales Action</h4>
          <div className={`inline-flex items-center px-4 py-2 rounded-lg border font-semibold ${getSalesActionColor(data.sales_action)}`}>
            {data.sales_action.replace('_', ' ')}
          </div>
        </div>
      </div>
    </div>
  );
};

export default QualificationDisplay;
