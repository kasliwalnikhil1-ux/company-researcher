'use client';

import React, { useRef, useState } from 'react';
import { X, Check, Clock, Infinity, Zap, Download } from 'lucide-react';
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';
import { CALENDLY_URL } from '@/components/BookDemoButton';
import { useOwner } from '@/contexts/OwnerContext';
import { usePricingModal } from '@/contexts/PricingModalContext';
import { PricingPdfContent } from '@/components/ui/PricingPdfContent';
import { ROIPdfContent } from '@/components/ui/ROIPdfContent';

interface PricingModalProps {
  isOpen: boolean;
  onClose: () => void;
}

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
      {
        title: 'Core',
        items: ['1 user', '500 credits'],
      },
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
        items: [
          'Everything in Basic',
          'Pro unlocks higher-impact usage per credit',
        ],
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
        title: 'Content & updates',
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

const PricingModal: React.FC<PricingModalProps> = ({ isOpen, onClose }) => {
  const { plan: currentPlan } = useOwner();
  const { openROIModal } = usePricingModal();
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const pdfContainerRef = useRef<HTMLDivElement>(null);

  if (!isOpen) return null;

  const handleDownloadPdf = async () => {
    if (!pdfContainerRef.current || isExportingPdf) return;
    setIsExportingPdf(true);
    try {
      const pages = pdfContainerRef.current.querySelectorAll('[data-pdf-page]');
      const pdf = new jsPDF({ unit: 'px', format: 'a4', hotfixes: ['px_scaling'] });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();

      for (let i = 0; i < pages.length; i++) {
        const canvas = await html2canvas(pages[i] as HTMLElement, {
          scale: 2,
          useCORS: true,
          logging: false,
          backgroundColor: '#ffffff',
        });
        const imgData = canvas.toDataURL('image/png');
        const imgWidth = pageWidth;
        const imgHeight = (canvas.height * imgWidth) / canvas.width;

        if (i > 0) pdf.addPage();
        pdf.addImage(imgData, 'PNG', 0, 0, imgWidth, Math.min(imgHeight, pageHeight));
      }

      pdf.save('capitalxai-pricing-and-roi.pdf');
    } catch (err) {
      console.error('PDF export failed:', err);
    } finally {
      setIsExportingPdf(false);
    }
  };

  const handleCta = () => {
    window.open(CALENDLY_URL, '_blank');
    onClose();
  };

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
    <>
      {/* Hidden container for PDF export - invisible but in DOM for html2canvas */}
      <div
        ref={pdfContainerRef}
        className="fixed left-[-9999px] top-0 w-[794px] pointer-events-none"
        style={{ zIndex: -9999 }}
        aria-hidden="true"
      >
        <div data-pdf-page className="bg-white">
          <PricingPdfContent />
        </div>
        <div data-pdf-page className="bg-white mt-4">
          <ROIPdfContent />
        </div>
      </div>
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center p-3 sm:p-4 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      >
      <div
        className="bg-white rounded-xl shadow-2xl max-w-5xl w-full max-h-[90vh] overflow-y-auto border border-gray-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between px-4 sm:px-6 py-3 sm:py-4 border-b border-gray-200 bg-white/95 backdrop-blur-sm">
          <h2 className="text-base sm:text-xl font-semibold text-gray-900 pr-2">Everything you need to fundraise quickly</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={handleDownloadPdf}
              disabled={isExportingPdf}
              className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label="Download as PDF"
            >
              <Download className="w-4 h-4" />
              {isExportingPdf ? 'Generating…' : 'Download PDF'}
            </button>
            <button
              onClick={onClose}
              className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Plans grid */}
        <div className="p-4 sm:p-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
          {PLANS.map((plan) => {
            const isCurrentPlan = currentPlan === plan.id;
            const isBelowCurrentPlan =
              currentPlan != null &&
              (PLAN_ORDER[plan.id] ?? -1) < (PLAN_ORDER[currentPlan] ?? -1);
            const showCta = !isBelowCurrentPlan;
            return (
            <div
              key={plan.id}
              className={`relative flex flex-col rounded-xl border-2 p-4 sm:p-6 transition-all ${
                plan.highlighted
                  ? 'border-brand-default bg-brand-fainter/30 shadow-lg lg:scale-[1.02]'
                  : 'border-gray-200 bg-white hover:border-gray-300'
              }`}
            >
              {plan.highlighted && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-2 sm:px-3 py-1 rounded-full bg-brand-default text-white text-[10px] sm:text-xs font-medium shadow-sm whitespace-nowrap">
                  Most teams choose this
                </div>
              )}
              <div className="mb-4">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-lg font-semibold text-gray-900">{plan.name}</h3>
                  {plan.id === 'pro' && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        openROIModal();
                      }}
                      className="text-xs font-medium text-brand-default hover:text-brand-dark hover:underline shrink-0"
                    >
                      View ROI
                    </button>
                  )}
                </div>
                <div className="mt-2 flex items-baseline gap-2 flex-wrap gap-y-1">
                  {'originalPrice' in plan && plan.originalPrice && (
                    <span className="text-base sm:text-lg font-medium text-gray-400 line-through">{plan.originalPrice}</span>
                  )}
                  <span className="text-xl sm:text-2xl font-bold text-gray-900">{plan.price}</span>
                  {'savings' in plan && plan.savings && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-700 text-[10px] sm:text-xs font-semibold shrink-0">
                      Save {plan.savings}
                    </span>
                  )}
                  <span className="text-xs sm:text-sm text-gray-500">· {plan.credits}</span>
                </div>
                {'discountNote' in plan && plan.discountNote && (
                  <p className="mt-1 text-xs text-brand-default font-medium">{plan.discountNote}</p>
                )}
                {'valueNote' in plan && plan.valueNote && (
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
                        ? 'px-3 py-1.5 text-sm bg-brand-default text-white shadow-md ring-2 ring-brand-default/30'
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
              {showCta && (
                <button
                  onClick={isCurrentPlan ? undefined : handleCta}
                  disabled={isCurrentPlan}
                  className={`w-full py-2.5 px-4 rounded-lg text-sm font-medium transition-colors ${
                    isCurrentPlan
                      ? 'bg-gray-100 text-gray-600 border-2 border-gray-200 cursor-default'
                      : plan.highlighted
                        ? 'bg-brand-default hover:bg-brand-dark text-white border-2 border-brand-fainter shadow-sm'
                        : 'bg-white border-2 border-gray-300 text-gray-700 hover:border-brand-default hover:text-brand-default hover:bg-brand-fainter/50'
                  }`}
                >
                  {isCurrentPlan ? 'Current plan' : plan.cta}
                </button>
              )}
            </div>
          );
          })}
        </div>

        {/* Trust badges */}
        <div className="px-4 sm:px-6 py-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-[1.7fr_0.9fr_1.7fr] gap-x-4 sm:gap-x-6 gap-y-3 border-t border-gray-100">
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

        {/* Credit explanation */}
        <div className="px-4 sm:px-6 pt-2 border-t border-gray-100">
          <h3 className="text-sm font-semibold text-gray-900 mb-1">What's a credit?</h3>
          <p className="text-sm text-gray-600">
            Each credit unlocks 1 investor. A credit is used to analyze investors with AI, view detailed profiles, generate messages to reach out to investors thoughtfully, or generate insights.
          </p>
        </div>

        {/* Need more credits */}
        <div className="px-4 sm:px-6 pb-6 pt-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-1">Out of credits mid-campaign?</h3>
          <p className="text-sm text-gray-600">
            Top up instantly or repurchase your plan whenever you need more outreach.
          </p>
        </div>
      </div>
    </div>
    </>
  );
};

export default PricingModal;
