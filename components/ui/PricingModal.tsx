'use client';

import React from 'react';
import { X, Check } from 'lucide-react';
import { CALENDLY_URL } from '@/components/BookDemoButton';

interface PricingModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const PLANS = [
  {
    id: 'free',
    name: 'Free',
    price: '$0',
    credits: '5 Credits',
    validity: 'Valid forever',
    description: 'Explore the full CapitalxAI platform with no restrictions.',
    includes: [
      '1 user',
      '5 credits',
      'Full access to all features',
      'Unlimited search & filters',
      'Full intelligence & insights',
      'Investor, company & people profiles',
      'Pipelines & advanced columns',
      'Network, intros, and analysis tools',
    ],
    bestFor: 'Trying the complete platform before upgrading',
    cta: 'Try Free',
    highlighted: false,
  },
  {
    id: 'basic',
    name: 'Basic',
    price: '$500',
    credits: '500 Credits',
    validity: 'Valid for 3 months',
    description: 'Everything you need to research, discover, and analyze at scale.',
    includes: [
      'Everything in Free',
      '500 credits',
      'Unlimited search',
      'Full access to insights & intelligence',
      'Investor, company & people discovery',
      'Advanced filtering & ranking',
      'Pipelines & data exports',
      'Notifications & alerts',
    ],
    bestFor: 'Founders, operators, analysts, and small teams',
    cta: 'Start Basic',
    highlighted: false,
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '$700',
    originalPrice: '$1000',
    credits: '500 Credits',
    validity: 'Valid for 6 months',
    discountNote: 'Your investment bankers at a fraction of the cost',
    description: 'Advanced intelligence, deep research, and network access.',
    includes: [
      'Everything in Basic',
      'Deep research & analysis tools',
      'Founder & portfolio company network',
      'Investor intent & fit analysis',
      'Intro pathways & relationship mapping',
      'Advanced signals & insights',
      'Priority access to new features',
      'Priority support',
      'Quarterly strategy call',
    ],
    bestFor: 'Funds, growth teams, and power users',
    cta: 'Go Pro',
    highlighted: true,
  },
];

const PricingModal: React.FC<PricingModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  const handleCta = () => {
    window.open(CALENDLY_URL, '_blank');
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl max-w-5xl w-full max-h-[90vh] overflow-y-auto border border-gray-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-4 border-b border-gray-200 bg-white/95 backdrop-blur-sm">
          <h2 className="text-xl font-semibold text-gray-900">Everything you need to fundraise quickly</h2>
          <button
            onClick={onClose}
            className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Plans grid */}
        <div className="p-6 grid grid-cols-1 md:grid-cols-3 gap-6">
          {PLANS.map((plan) => (
            <div
              key={plan.id}
              className={`relative flex flex-col rounded-xl border-2 p-6 transition-all ${
                plan.highlighted
                  ? 'border-brand-default bg-brand-fainter/30 shadow-lg scale-[1.02]'
                  : 'border-gray-200 bg-white hover:border-gray-300'
              }`}
            >
              {plan.highlighted && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-full bg-brand-default text-white text-xs font-medium">
                  Popular
                </div>
              )}
              <div className="mb-4">
                <h3 className="text-lg font-semibold text-gray-900">{plan.name}</h3>
                <div className="mt-2 flex items-baseline gap-2 flex-wrap">
                  {'originalPrice' in plan && plan.originalPrice && (
                    <span className="text-lg font-medium text-brand-default line-through">{plan.originalPrice}</span>
                  )}
                  <span className="text-2xl font-bold text-gray-900">{plan.price}</span>
                  <span className="text-sm text-gray-500">· {plan.credits}</span>
                </div>
                {'discountNote' in plan && plan.discountNote && (
                  <p className="mt-1 text-xs text-brand-default font-medium">{plan.discountNote}</p>
                )}
                <p className="mt-1 text-xs text-gray-500">{plan.validity}</p>
                <p className="mt-2 text-sm text-gray-600">{plan.description}</p>
              </div>
              <ul className="flex-1 space-y-2 mb-6">
                {plan.includes.map((item) => (
                  <li key={item} className="flex items-start gap-2 text-sm text-gray-700">
                    <Check className="w-4 h-4 text-brand-default shrink-0 mt-0.5" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-gray-500 mb-4">
                <span className="font-medium">Best for:</span> {plan.bestFor}
              </p>
              <button
                onClick={handleCta}
                className={`w-full py-2.5 px-4 rounded-lg text-sm font-medium transition-colors ${
                  plan.highlighted
                    ? 'bg-brand-default hover:bg-brand-dark text-white border-2 border-brand-fainter shadow-sm'
                    : 'bg-white border-2 border-gray-300 text-gray-700 hover:border-brand-default hover:text-brand-default hover:bg-brand-fainter/50'
                }`}
              >
                {plan.cta}
              </button>
            </div>
          ))}
        </div>

        {/* Trust badges */}
        <div className="px-6 py-4 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-[1.7fr_0.9fr_1.7fr] gap-x-6 gap-y-3 border-t border-gray-100">
          {[
            'Report missing investors and we add them for free',
            'No credit card to start',
            'Built for founders, VCs, and operators by ex-YC alumni',
            'Data refreshed frequently',
            'Human-verified data',
            'Used by 100+ startups across SaaS, AI, and fintech',
          ].map((item) => (
            <div key={item} className="flex items-center gap-2 text-sm text-gray-700">
              <Check className="w-4 h-4 text-green-600 shrink-0" />
              <span>{item}</span>
            </div>
          ))}
        </div>

        {/* Credit explanation */}
        <div className="px-6 pb-6 pt-2 border-t border-gray-100">
          <h3 className="text-sm font-semibold text-gray-900 mb-1">What's a credit?</h3>
          <p className="text-sm text-gray-600">
            Each credit unlocks 1 investor. A credit is used to analyze investors with AI, view detailed profiles, generate messages to reach out to investors thoughtfully, or generate insights.
          </p>
        </div>
      </div>
    </div>
  );
};

export default PricingModal;
