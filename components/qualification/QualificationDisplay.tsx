'use client';

import React, { useState } from 'react';
import { generateMessageTemplates } from '../../lib/messageTemplates';
import { useMessageTemplates } from '@/contexts/MessageTemplatesContext';

interface QualificationData {
  company_summary: string;
  company_industry: string;
  sales_opener_sentence: string;
  classification: 'QUALIFIED' | 'NOT_QUALIFIED' | 'MAYBE';
  confidence_score: number;
  product_types: string[] | null;
  sales_action: 'OUTREACH' | 'EXCLUDE' | 'PARTNERSHIP' | 'MANUAL_REVIEW';
  email?: string | null;
  phone?: string | null;
}

interface QualificationDisplayProps {
  data: QualificationData | null;
}

const QualificationDisplay: React.FC<QualificationDisplayProps> = ({ data }) => {
  const [copiedMessage, setCopiedMessage] = useState<number | null>(null);
  const { templates } = useMessageTemplates();

  const handleCopy = async (text: string, messageNumber: number) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMessage(messageNumber);
      setTimeout(() => setCopiedMessage(null), 2000);
    } catch (err) {
      console.error('Failed to copy text:', err);
    }
  };

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

        {/* Contact Information */}
        {(data.email || data.phone) && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-6 mt-6 border-t border-gray-200">
            {data.email && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium text-gray-700 uppercase tracking-wide">Email</h4>
                <a 
                  href={`mailto:${data.email}`}
                  className="text-blue-600 hover:text-blue-800 hover:underline break-all"
                >
                  {data.email}
                </a>
              </div>
            )}
            {data.phone && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium text-gray-700 uppercase tracking-wide">Phone</h4>
                <a 
                  href={`tel:${data.phone}`}
                  className="text-blue-600 hover:text-blue-800 hover:underline"
                >
                  {data.phone}
                </a>
              </div>
            )}
          </div>
        )}

        {/* Message Templates for Domain Research */}
        {data.classification === 'QUALIFIED' && data.product_types && data.product_types.length > 0 && (() => {
          // Get all templates from database for 'direct' channel, or use undefined to fallback to hard-coded
          const dbTemplates = templates
            .filter(t => t.channel === 'direct')
            .map(t => t.template)
            .filter(t => t && t.trim().length > 0);
          const templateStrings = dbTemplates.length > 0 ? dbTemplates : undefined;
          const messages = generateMessageTemplates(data, false, templateStrings); // false = domain research
          
          return (
            <div className="pt-6 mt-6 border-t border-gray-200">
              <h3 className="text-xl font-semibold text-gray-900 mb-4">Domain Research Message Templates</h3>
              <div className="space-y-4">
                {messages.map((message, index) => (
                  <div key={index} className="bg-gray-50 p-4 rounded-lg border border-gray-200">
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="text-sm font-semibold text-gray-700">Message {index + 1}</h4>
                      <button
                        onClick={() => handleCopy(message, index + 1)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100 transition-colors"
                      >
                        {copiedMessage === index + 1 ? (
                          <>
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                            </svg>
                            Copied!
                          </>
                        ) : (
                          <>
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                            </svg>
                            Copy
                          </>
                        )}
                      </button>
                    </div>
                    <p className="text-gray-800 text-sm whitespace-pre-wrap leading-relaxed">{message}</p>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
};

export default QualificationDisplay;
