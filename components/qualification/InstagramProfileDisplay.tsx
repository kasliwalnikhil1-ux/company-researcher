'use client';

import React, { useState } from 'react';
import { generateMessageTemplates } from '../../lib/messageTemplates';
import { useMessageTemplates } from '@/contexts/MessageTemplatesContext';
import { copyToClipboard } from '@/lib/utils';
import { summaryKeyToLabel, formatSummaryValue } from '@/lib/summaryUtils';

export interface InstagramProfileData {
  id: string;
  username: string;
  is_private: boolean;
  profile_pic_url: string;
  profile_pic_url_hd: string;
  biography: string;
  full_name: string;
  edge_owner_to_timeline_media?: {
    count: number;
  }; 
  edge_followed_by?: {
    count: number;
  };
  edge_follow?: {
    count: number;
  };
}

interface InstagramProfileDisplayProps {
  data: InstagramProfileData | null;
  instagramUrl: string;
  qualificationData?: Record<string, any> | null;
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

const InstagramProfileDisplay: React.FC<InstagramProfileDisplayProps> = ({ data, instagramUrl, qualificationData }) => {
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
        <p className="text-gray-500">No Instagram profile data available</p>
      </div>
    );
  }

  const renderQualificationValue = (key: string, value: any) => {
    if (value === null || value === undefined) return null;
    const label = summaryKeyToLabel(key);

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
        <div key={key} className="space-y-2 mb-6">
          <h4 className="text-sm font-medium text-gray-700 uppercase tracking-wide">{label}</h4>
          <div className={`inline-flex items-center px-4 py-2 rounded-lg border font-semibold ${color}`}>
            {value.replace(/_/g, ' ')}
          </div>
        </div>
      );
    }

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

    if (Array.isArray(value)) {
      const filtered = value.filter(v => v != null && String(v).trim() !== '');
      if (filtered.length === 0) return null;
      return (
        <div key={key} className="space-y-2 mb-6">
          <h4 className="text-sm font-medium text-gray-700 uppercase tracking-wide">{label}</h4>
          <div className="flex flex-wrap gap-2">
            {filtered.map((item, idx) => (
              <span key={idx} className="inline-flex items-center px-3 py-1 rounded-md bg-blue-50 text-blue-700 border border-blue-200 text-sm font-medium capitalize">
                {String(item)}
              </span>
            ))}
          </div>
        </div>
      );
    }

    if (key === 'email' && typeof value === 'string' && value.includes('@')) {
      return (
        <div key={key} className="space-y-2">
          <h4 className="text-sm font-medium text-gray-700 uppercase tracking-wide">{label}</h4>
          <a href={`mailto:${value}`} className="text-blue-600 hover:text-blue-800 hover:underline break-all">{value}</a>
        </div>
      );
    }

    if (key === 'phone' && typeof value === 'string' && value.trim()) {
      return (
        <div key={key} className="space-y-2">
          <h4 className="text-sm font-medium text-gray-700 uppercase tracking-wide">{label}</h4>
          <a href={`tel:${value}`} className="text-blue-600 hover:text-blue-800 hover:underline">{value}</a>
        </div>
      );
    }

    const displayValue = formatSummaryValue(value);
    if (displayValue === '-') return null;

    return (
      <div key={key} className="space-y-2 mb-6">
        <h4 className="text-sm font-medium text-gray-700 uppercase tracking-wide">{label}</h4>
        <p className="text-gray-700 leading-relaxed text-sm sm:text-base">{displayValue}</p>
      </div>
    );
  };

  return (
    <div className="w-full bg-white border shadow-sm p-4 sm:p-8 mt-2 rounded-lg">
      <div className="space-y-6">
        <div>
          <h3 className="text-xl font-semibold text-gray-900 mb-4">Instagram Profile</h3>
        </div>

        {/* Profile Header */}
        <div className="flex items-start gap-6 pb-6 border-b border-gray-200">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 mb-2">
              <h2 className="text-2xl font-bold text-gray-900">{data.full_name || data.username}</h2>
              {data.is_private && (
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800 border border-gray-300">
                  Private
                </span>
              )}
            </div>
            <a
              href={`https://instagram.com/${data.username}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-blue-600 hover:text-blue-800 hover:underline"
            >
              @{data.username}
            </a>
            {data.biography && (
              <p className="mt-3 text-gray-700 leading-relaxed text-sm sm:text-base whitespace-pre-wrap">
                {data.biography}
              </p>
            )}
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-4 pb-6 border-b border-gray-200">
          <div className="text-center">
            <div className="text-2xl font-bold text-gray-900">
              {(data.edge_owner_to_timeline_media?.count || 0).toLocaleString()}
            </div>
            <div className="text-sm text-gray-600 mt-1">Posts</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-gray-900">
              {(data.edge_followed_by?.count || 0).toLocaleString()}
            </div>
            <div className="text-sm text-gray-600 mt-1">Followers</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-gray-900">
              {(data.edge_follow?.count || 0).toLocaleString()}
            </div>
            <div className="text-sm text-gray-600 mt-1">Following</div>
          </div>
        </div>

        {/* Instagram URL */}
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-gray-700 uppercase tracking-wide">Instagram URL</h4>
          <a
            href={instagramUrl.startsWith('http') ? instagramUrl : `https://instagram.com/${data.username}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:text-blue-800 hover:underline break-all"
          >
            {instagramUrl.startsWith('http') ? instagramUrl : `https://instagram.com/${data.username}`}
          </a>
        </div>

        {/* Qualification Section - renders all fields dynamically */}
        {qualificationData ? (
          <div className="pt-6 mt-6 border-t border-gray-200">
            <h3 className="text-xl font-semibold text-gray-900 mb-4">Research Summary</h3>
            
            {Object.entries(qualificationData)
              .filter(([key]) => key !== 'email' && key !== 'phone')
              .map(([key, value]) => renderQualificationValue(key, value))}

            {/* Contact Information */}
            {(qualificationData.email || qualificationData.phone) && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                {qualificationData.email && renderQualificationValue('email', qualificationData.email)}
                {qualificationData.phone && renderQualificationValue('phone', qualificationData.phone)}
              </div>
            )}

            {/* Message Templates */}
            {(() => {
              const dbTemplates = templates
                .filter(t => t.channel === 'instagram')
                .map(t => t.template)
                .filter(t => t && t.trim().length > 0);
              const templateStrings = dbTemplates.length > 0 ? dbTemplates : undefined;
              const messages = generateMessageTemplates(qualificationData, true, templateStrings);
              
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
        ) : (
          <div className="pt-6 mt-6 border-t border-gray-200">
            <div className="text-center py-8">
              <p className="text-gray-500 text-sm">Qualification assessment is being processed...</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default InstagramProfileDisplay;
