'use client';

import React, { useState } from 'react';
import { renderCompanyTemplate } from '../../lib/messageTemplates';
import { useMessageTemplates } from '@/contexts/MessageTemplatesContext';
import { copyToClipboard } from '@/lib/utils';
import { summaryKeyToLabel, formatSummaryValue } from '@/lib/summaryUtils';

interface QualificationDisplayProps {
  data: Record<string, any> | null;
}

const CLASSIFICATION_COLORS: Record<string, string> = {
  QUALIFIED: 'bg-green-100 text-green-800 border-green-300',
  NOT_QUALIFIED: 'bg-red-100 text-red-800 border-red-300',
  MAYBE: 'bg-yellow-100 text-yellow-800 border-yellow-300',
  EXPIRED: 'bg-gray-100 text-gray-800 border-gray-300',
};

const SALES_ACTION_COLORS: Record<string, string> = {
  OUTREACH: 'bg-blue-100 text-blue-800 border-blue-300',
  EXCLUDE: 'bg-red-100 text-red-800 border-red-300',
  PARTNERSHIP: 'bg-purple-100 text-purple-800 border-purple-300',
  MANUAL_REVIEW: 'bg-orange-100 text-orange-800 border-orange-300',
};

const QualificationDisplay: React.FC<QualificationDisplayProps> = ({ data }) => {
  const [copiedMessage, setCopiedMessage] = useState<number | null>(null);
  const { templates } = useMessageTemplates();

  const handleCopy = async (text: string, messageNumber: number) => {
    try {
      await copyToClipboard(text);
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

  const renderValue = (key: string, value: any) => {
    if (value === null || value === undefined) return null;

    const label = summaryKeyToLabel(key);

    // Badge rendering for classification-like enums
    if (key === 'classification' && typeof value === 'string') {
      const color = CLASSIFICATION_COLORS[value] || 'bg-gray-100 text-gray-800 border-gray-300';
      return (
        <div key={key} className="space-y-2">
          <h4 className="text-sm font-medium text-gray-700 uppercase tracking-wide">{label}</h4>
          <div className={`inline-flex items-center px-3 py-1.5 rounded-full border font-semibold text-sm ${color}`}>
            {value}
          </div>
        </div>
      );
    }

    if (key === 'sales_action' && typeof value === 'string') {
      const color = SALES_ACTION_COLORS[value] || 'bg-gray-100 text-gray-800 border-gray-300';
      return (
        <div key={key} className="space-y-2">
          <h4 className="text-sm font-medium text-gray-700 uppercase tracking-wide">{label}</h4>
          <div className={`inline-flex items-center px-4 py-2 rounded-lg border font-semibold ${color}`}>
            {value.replace(/_/g, ' ')}
          </div>
        </div>
      );
    }

    // Confidence score with progress bar (number in 0-1 range)
    if (key === 'confidence_score' && typeof value === 'number') {
      const pct = value <= 1 ? value * 100 : value;
      const color = pct >= 80 ? 'text-green-600' : pct >= 60 ? 'text-yellow-600' : 'text-red-600';
      const barColor = pct >= 80 ? 'bg-green-600' : pct >= 60 ? 'bg-yellow-600' : 'bg-red-600';
      return (
        <div key={key} className="space-y-2">
          <h4 className="text-sm font-medium text-gray-700 uppercase tracking-wide">{label}</h4>
          <div className="flex items-center gap-2">
            <span className={`text-2xl font-bold ${color}`}>{pct.toFixed(0)}%</span>
            <div className="flex-1 bg-gray-200 rounded-full h-2.5">
              <div className={`h-2.5 rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
            </div>
          </div>
        </div>
      );
    }

    // Array values as tag chips
    if (Array.isArray(value)) {
      const filtered = value.filter(v => v != null && String(v).trim() !== '');
      if (filtered.length === 0) return null;
      return (
        <div key={key} className="space-y-2">
          <h4 className="text-sm font-medium text-gray-700 uppercase tracking-wide">{label}</h4>
          <div className="flex flex-wrap gap-2">
            {filtered.map((item, idx) => (
              <span
                key={idx}
                className="inline-flex items-center px-3 py-1 rounded-md bg-blue-50 text-blue-700 border border-blue-200 text-sm font-medium capitalize"
              >
                {String(item)}
              </span>
            ))}
          </div>
        </div>
      );
    }

    // Boolean values
    if (typeof value === 'boolean') {
      return (
        <div key={key} className="space-y-2">
          <h4 className="text-sm font-medium text-gray-700 uppercase tracking-wide">{label}</h4>
          <p className="text-gray-700 text-sm">{value ? 'Yes' : 'No'}</p>
        </div>
      );
    }

    // Contact-like fields (email/phone) - render as links
    if (key === 'email' && typeof value === 'string' && value.includes('@')) {
      return (
        <div key={key} className="space-y-2">
          <h4 className="text-sm font-medium text-gray-700 uppercase tracking-wide">{label}</h4>
          <a href={`mailto:${value}`} className="text-blue-600 hover:text-blue-800 hover:underline break-all">
            {value}
          </a>
        </div>
      );
    }

    if (key === 'phone' && typeof value === 'string' && value.trim()) {
      return (
        <div key={key} className="space-y-2">
          <h4 className="text-sm font-medium text-gray-700 uppercase tracking-wide">{label}</h4>
          <a href={`tel:${value}`} className="text-blue-600 hover:text-blue-800 hover:underline">
            {value}
          </a>
        </div>
      );
    }

    // Default: string or number
    const displayValue = formatSummaryValue(value);
    if (displayValue === '-') return null;

    return (
      <div key={key} className="space-y-2">
        <h4 className="text-sm font-medium text-gray-700 uppercase tracking-wide">{label}</h4>
        <p className="text-gray-700 leading-relaxed text-sm sm:text-base">{displayValue}</p>
      </div>
    );
  };

  // Separate keys into categories for better layout
  const allKeys = Object.keys(data);
  const contactKeySet = new Set(['email', 'phone']);
  const contactKeys = allKeys.filter(k => contactKeySet.has(k));
  const summaryKeys = allKeys.filter(k => !contactKeySet.has(k));

  return (
    <div className="w-full bg-white border shadow-sm p-4 sm:p-8 mt-2 rounded-lg">
      <div className="space-y-6">
        <div>
          <h3 className="text-xl font-semibold text-gray-900 mb-4">Research Summary</h3>
        </div>

        {summaryKeys.map(key => renderValue(key, data[key]))}

        {/* Contact Information */}
        {contactKeys.length > 0 && contactKeys.some(k => data[k]) && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-6 mt-6 border-t border-gray-200">
            {contactKeys.map(key => renderValue(key, data[key]))}
          </div>
        )}

        {/* Message Templates - generate if there are product_types and classification is QUALIFIED */}
        {data.classification === 'QUALIFIED' && data.product_types && Array.isArray(data.product_types) && data.product_types.length > 0 && (() => {
          const directTemplates = templates.filter(
            (t) => t.channel === 'direct' && t.template && t.template.trim().length > 0
          );
          const messages = directTemplates
            .map((t) => renderCompanyTemplate(t, data, templates))
            .filter((s) => s && s.length > 0);

          if (messages.length === 0) return null;
          
          return (
            <div className="pt-6 mt-6 border-t border-gray-200">
              <h3 className="text-xl font-semibold text-gray-900 mb-4">Message Templates</h3>
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
