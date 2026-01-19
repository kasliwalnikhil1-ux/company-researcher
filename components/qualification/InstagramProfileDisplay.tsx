'use client';

import React, { useState } from 'react';
import { generateMessageTemplates } from '../../lib/messageTemplates';
import { useMessageTemplates } from '@/contexts/MessageTemplatesContext';
import { copyToClipboard } from '@/lib/utils';

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

interface InstagramQualificationData {
  profile_summary: string;
  profile_industry: string;
  sales_opener_sentence: string;
  classification: 'QUALIFIED' | 'NOT_QUALIFIED' | 'MAYBE' | 'EXPIRED';
  confidence_score?: number; // Optional - only show if present
  product_types: string[] | null;
  sales_action: 'OUTREACH' | 'EXCLUDE' | 'PARTNERSHIP' | 'MANUAL_REVIEW';
  email?: string | null;
  phone?: string | null;
}

interface InstagramProfileDisplayProps {
  data: InstagramProfileData | null;
  instagramUrl: string;
  qualificationData?: InstagramQualificationData | null;
}

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

        {/* Qualification Section */}
        {qualificationData ? (
          <div className="pt-6 mt-6 border-t border-gray-200">
            <h3 className="text-xl font-semibold text-gray-900 mb-4">Sales Qualification Assessment</h3>
            
            {/* Profile Summary */}
            {qualificationData.profile_summary && (
              <div className="space-y-2 mb-6">
                <h4 className="text-sm font-medium text-gray-700 uppercase tracking-wide">Profile Summary</h4>
                <p className="text-gray-700 leading-relaxed text-sm sm:text-base">
                  {qualificationData.profile_summary}
                </p>
              </div>
            )}

            {/* Profile Industry */}
            {qualificationData.profile_industry && (
              <div className="space-y-2 mb-6">
                <h4 className="text-sm font-medium text-gray-700 uppercase tracking-wide">Profile Industry</h4>
                <p className="text-gray-700 leading-relaxed text-sm sm:text-base">
                  {qualificationData.profile_industry}
                </p>
              </div>
            )}

            {/* Sales Opener Sentence */}
            {qualificationData.sales_opener_sentence && (
              <div className="space-y-2 mb-6">
                <h4 className="text-sm font-medium text-gray-700 uppercase tracking-wide">Sales Opener Sentence</h4>
                <p className="text-gray-700 leading-relaxed text-sm sm:text-base italic">
                  {qualificationData.sales_opener_sentence}
                </p>
              </div>
            )}

            <div className={`grid ${qualificationData.confidence_score !== undefined ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1'} gap-4 mb-6`}>
              {/* Classification */}
              <div className="space-y-2">
                <h4 className="text-sm font-medium text-gray-700 uppercase tracking-wide">Classification</h4>
                <div className={`inline-flex items-center px-3 py-1.5 rounded-full border font-semibold text-sm ${
                  qualificationData.classification === 'QUALIFIED' 
                    ? 'bg-green-100 text-green-800 border-green-300'
                    : qualificationData.classification === 'NOT_QUALIFIED'
                    ? 'bg-red-100 text-red-800 border-red-300'
                    : qualificationData.classification === 'MAYBE'
                    ? 'bg-yellow-100 text-yellow-800 border-yellow-300'
                    : 'bg-gray-100 text-gray-800 border-gray-300'
                }`}>
                  {qualificationData.classification}
                </div>
              </div>

              {/* Confidence Score - Only show if present */}
              {qualificationData.confidence_score !== undefined && (
                <div className="space-y-2">
                  <h4 className="text-sm font-medium text-gray-700 uppercase tracking-wide">Confidence Score</h4>
                  <div className="flex items-center gap-2">
                    <span className={`text-2xl font-bold ${
                      qualificationData.confidence_score >= 0.8
                        ? 'text-green-600'
                        : qualificationData.confidence_score >= 0.6
                        ? 'text-yellow-600'
                        : 'text-red-600'
                    }`}>
                      {(qualificationData.confidence_score * 100).toFixed(0)}%
                    </span>
                    <div className="flex-1 bg-gray-200 rounded-full h-2.5">
                      <div
                        className={`h-2.5 rounded-full ${
                          qualificationData.confidence_score >= 0.8
                            ? 'bg-green-600'
                            : qualificationData.confidence_score >= 0.6
                            ? 'bg-yellow-600'
                            : 'bg-red-600'
                        }`}
                        style={{ width: `${qualificationData.confidence_score * 100}%` }}
                      ></div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Product Types - Show when QUALIFIED and product_types exist (can be 1 or more items) */}
            {qualificationData.classification === 'QUALIFIED' && qualificationData.product_types && Array.isArray(qualificationData.product_types) && qualificationData.product_types.length > 0 && (
              <div className="space-y-2 mb-6">
                <h4 className="text-sm font-medium text-gray-700 uppercase tracking-wide">Product Types</h4>
                <div className="flex flex-wrap gap-2">
                  {qualificationData.product_types.map((type, index) => (
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
            <div className="space-y-2 mb-6">
              <h4 className="text-sm font-medium text-gray-700 uppercase tracking-wide">Recommended Sales Action</h4>
              <div className={`inline-flex items-center px-4 py-2 rounded-lg border font-semibold ${
                qualificationData.sales_action === 'OUTREACH'
                  ? 'bg-blue-100 text-blue-800 border-blue-300'
                  : qualificationData.sales_action === 'EXCLUDE'
                  ? 'bg-red-100 text-red-800 border-red-300'
                  : qualificationData.sales_action === 'PARTNERSHIP'
                  ? 'bg-purple-100 text-purple-800 border-purple-300'
                  : 'bg-orange-100 text-orange-800 border-orange-300'
              }`}>
                {qualificationData.sales_action.replace('_', ' ')}
              </div>
            </div>

            {/* Contact Information */}
            {(qualificationData.email || qualificationData.phone) && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                {qualificationData.email && (
                  <div className="space-y-2">
                    <h4 className="text-sm font-medium text-gray-700 uppercase tracking-wide">Email</h4>
                    <a 
                      href={`mailto:${qualificationData.email}`}
                      className="text-blue-600 hover:text-blue-800 hover:underline break-all"
                    >
                      {qualificationData.email}
                    </a>
                  </div>
                )}
                {qualificationData.phone && (
                  <div className="space-y-2">
                    <h4 className="text-sm font-medium text-gray-700 uppercase tracking-wide">Phone</h4>
                    <a 
                      href={`tel:${qualificationData.phone}`}
                      className="text-blue-600 hover:text-blue-800 hover:underline"
                    >
                      {qualificationData.phone}
                    </a>
                  </div>
                )}
              </div>
            )}

            {/* Message Templates for Instagram Research */}
            {qualificationData.classification === 'QUALIFIED' && qualificationData.product_types && qualificationData.product_types.length > 0 && (() => {
              // Get all templates from database for 'instagram' channel, or use undefined to fallback to hard-coded
              const dbTemplates = templates
                .filter(t => t.channel === 'instagram')
                .map(t => t.template)
                .filter(t => t && t.trim().length > 0);
              const templateStrings = dbTemplates.length > 0 ? dbTemplates : undefined;
              const messages = generateMessageTemplates(qualificationData, true, templateStrings); // true = Instagram research
              
              return (
                <div className="pt-6 mt-6 border-t border-gray-200">
                  <h3 className="text-xl font-semibold text-gray-900 mb-4">Instagram Research Message Templates</h3>
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

