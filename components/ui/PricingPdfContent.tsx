'use client';

import React from 'react';
import { Check, Clock, Infinity, Zap } from 'lucide-react';

const PLAN_ORDER: Record<string, number> = { free: 0, basic: 1, pro: 2 };

type PlanSection = { title: string; items: string[] };

type PlanConfig = {
  id: string;
  name: string;
  price: string;
  credits: string;
  validity: string;
  description: string;
  includes?: string[];
  sections?: PlanSection[];
  bestFor: string;
  cta: string;
  highlighted: boolean;
  originalPrice?: string;
  savings?: string;
  discountNote?: string;
  valueNote?: string;
};

const PLANS: PlanConfig[] = [
  {
    id: 'free',
    name: 'Free',
    price: '$0',
    credits: '5 Credits',
    validity: 'Valid forever',
    description: 'Explore the full platform experience with limited credits.',
    includes: [
      '1 user',
      '5 credits',
      'Launch your fundraising campaign fast, the way experts do',
      'Full control & precision, without expensive fundraising consultants',
      'Evaluate the ROI of the platform',
      'Risk-free trial'
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
    sections: [
      { title: 'Core', items: ['1 user', '500 credits'] },
      {
        title: 'Discovery & search',
        items: [
          'Unlimited search & filters',
          'Investor, company & people discovery with vast coverage',
          'Identify investors most likely to fund your company with AI',
        ],
      },
      {
        title: 'Investor profiles',
        items: [
          'Investors profile with notable investments',
          'Verified investor contact details',
          'Official apply link or submission page',
        ],
      },
      {
        title: 'Outreach & messaging',
        items: [
          'Basic AI-assisted investor messaging leading with why them',
          'Identify mutual interests between you and the investor',
          'Co-investors they back deals with',
          'Basic investor outreach message templates',
        ],
      },
      {
        title: 'Pipeline & support',
        items: [
          'Pipeline tracking & data exports',
          'Analytic dashboard',
          'Standard support',
        ],
      },
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
    savings: '$300',
    credits: '500 Credits',
    validity: 'Valid for 6 months',
    discountNote: 'Your investment bankers at a fraction of the cost',
    valueNote: 'Close deals faster—save months of investor research and move from intro to term sheet at 2x the speed.',
    description: 'Advanced intelligence, deep research, and network access.',
    sections: [
      {
        title: 'What you get',
        items: ['Everything in Basic', 'Pro unlocks higher-impact usage per credit'],
      },
      {
        title: 'Advanced messaging & network',
        items: [
          'Advanced AI-assisted investor messaging with X personalization',
          'Founder-investor portfolio network',
          'Intro pathways & relationship mapping',
          'Top-performing investor outreach message templates',
        ],
      },
      {
        title: 'Deep research',
        items: [
          'Deep research & analysis tools',
          'Background and professional history',
          'Best way to approach or pitch the investor',
        ],
      },
      {
        title: 'Investor intelligence',
        items: [
          'Recent investor deals and activity',
          'Public quotes, essays, or interviews that reveal investment philosophy',
          'What this investor looks for in founders',
          'Red flags or common reasons they pass',
        ],
      },
      {
        title: 'Content and updates',
        items: [
          'Recent exclusive articles, podcasts, videos with links',
          'Latest investor news, updates, articles & videos',
        ],
      },
      {
        title: 'Pro perks',
        items: [
          'Priority access to new features',
          'Priority support',
          'Quarterly strategy call',
        ],
      },
    ],
    bestFor: 'Funds, growth teams, and power users',
    cta: 'Upgrade to Pro',
    highlighted: true,
  },
];

export function PricingPdfContent() {
  const renderPlanIncludes = (plan: PlanConfig) => {
    if (plan.sections) {
      return (
        <div className="flex-1 space-y-4 mb-6">
          {plan.sections.map((section) => (
            <div key={section.title}>
              <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                {section.title}
              </h4>
              <ul className="space-y-1.5">
                {section.items.map((item) => (
                  <li key={item} className="flex items-start gap-2 text-sm text-gray-700 break-words min-w-0">
                    <Check className="w-4 h-4 text-brand-default shrink-0 mt-0.5" />
                    <span className="min-w-0">{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      );
    }
    return (
      <ul className="flex-1 space-y-2 mb-6">
        {(plan.includes ?? []).map((item) => (
          <li key={item} className="flex items-start gap-2 text-sm text-gray-700 break-words min-w-0">
            <Check className="w-4 h-4 text-brand-default shrink-0 mt-0.5" />
            <span className="min-w-0">{item}</span>
          </li>
        ))}
      </ul>
    );
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6 w-[794px]">
      <h2 className="text-xl font-semibold text-gray-900 mb-6">Everything you need to fundraise quickly</h2>
      <div className="grid grid-cols-3 gap-4">
        {PLANS.map((plan) => (
          <div
            key={plan.id}
            className={`flex flex-col rounded-xl border-2 p-4 ${
              plan.highlighted ? 'border-brand-default bg-brand-fainter/30' : 'border-gray-200'
            }`}
          >
            {plan.highlighted && (
              <div className="mb-2 px-2 py-1 rounded-full bg-brand-default text-white text-xs font-medium text-center">
                Most teams choose this
              </div>
            )}
            <div className="mb-4">
              <h3 className="text-lg font-semibold text-gray-900">{plan.name}</h3>
              <div className="mt-2 flex items-baseline gap-2 flex-wrap gap-y-1">
                {plan.originalPrice && (
                  <span className="text-base font-medium text-gray-400 line-through">{plan.originalPrice}</span>
                )}
                <span className="text-xl font-bold text-gray-900">{plan.price}</span>
                {plan.savings && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-700 text-xs font-semibold">
                    Save {plan.savings}
                  </span>
                )}
                <span className="text-sm text-gray-500">· {plan.credits}</span>
              </div>
              {plan.discountNote && (
                <p className="mt-1 text-xs text-brand-default font-medium">{plan.discountNote}</p>
              )}
              {plan.valueNote && (
                <p className="mt-1.5 flex items-start gap-1.5 text-xs text-gray-700">
                  <Zap className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
                  <span>{plan.valueNote}</span>
                </p>
              )}
              {plan.id === 'pro' && (
                <p className="mt-2 text-xs font-medium text-brand-default">
                  One investor meeting can pay for this 100× over
                </p>
              )}
              <div className="mt-2">
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full font-medium ${
                    plan.validity.includes('6 months')
                      ? 'px-3 py-1.5 text-sm bg-brand-default text-white'
                      : 'px-2.5 py-1 text-xs bg-gray-100 text-gray-600 border border-gray-200'
                  }`}
                >
                  {plan.validity.toLowerCase().includes('forever') ? (
                    <Infinity className="w-3.5 h-3.5 shrink-0" />
                  ) : (
                    <Clock className="w-3.5 h-3.5 shrink-0" />
                  )}
                  {plan.validity}
                </span>
              </div>
              <p className="mt-2 text-sm text-gray-600">{plan.description}</p>
            </div>
            {renderPlanIncludes(plan)}
            <p className="text-xs text-gray-500 mb-4">
              <span className="font-medium">Best for:</span> {plan.bestFor}
            </p>
          </div>
        ))}
      </div>
      <div className="mt-6 pt-4 border-t border-gray-100 grid grid-cols-3 gap-x-4 gap-y-3">
        {[
          'Report missing investors & we add them for free',
          'No credit card to start',
          'Built by ex-YC alumni',
          'New funds & investors data refreshed frequently',
          'Human-verified data',
          'Used by 100+ startups across SaaS, AI & fintech',
        ].map((item) => (
          <div key={item} className="flex items-center gap-2 text-sm text-gray-700 min-w-0">
            <Check className="w-4 h-4 text-green-600 shrink-0" />
            <span className="min-w-0 break-words">{item}</span>
          </div>
        ))}
      </div>
      <div className="mt-4 pt-2 border-t border-gray-100">
        <h3 className="text-sm font-semibold text-gray-900 mb-1">What&apos;s a credit?</h3>
        <p className="text-sm text-gray-600">
          Each credit unlocks 1 investor. A credit is used to analyze investors with AI, view detailed profiles, generate messages to reach out to investors thoughtfully, or generate insights.
        </p>
      </div>
    </div>
  );
}
