'use client';

import React from 'react';
import { X, ChevronLeft, ChevronRight, MapPin, Briefcase, DollarSign, Target, Globe } from 'lucide-react';
import { Investor } from '@/contexts/InvestorsContext';

interface InvestorDetailsDrawerProps {
  isOpen: boolean;
  investor: Investor | null;
  onClose: () => void;
  investors: Investor[];
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onInvestorChange?: (investor: Investor) => void;
}

const formatCurrency = (value: number | null | undefined): string => {
  if (value == null || value === 0) return '-';
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value}`;
};

const InvestorDetailsDrawer: React.FC<InvestorDetailsDrawerProps> = ({
  isOpen,
  investor,
  onClose,
  investors,
  currentPage,
  totalPages,
  onPageChange,
  onInvestorChange,
}) => {
  if (!isOpen) return null;

  const currentIndex = investor ? investors.findIndex((i) => i.id === investor.id) : -1;
  const hasPrev = currentIndex > 0 || (currentIndex === 0 && currentPage > 1);
  const hasNext = currentIndex >= 0 && (currentIndex < investors.length - 1 || currentPage < totalPages);

  const handlePrev = () => {
    if (currentIndex > 0 && onInvestorChange) {
      onInvestorChange(investors[currentIndex - 1]);
    } else if (currentPage > 1) {
      onPageChange(currentPage - 1);
    }
  };

  const handleNext = () => {
    if (currentIndex >= 0 && currentIndex < investors.length - 1 && onInvestorChange) {
      onInvestorChange(investors[currentIndex + 1]);
    } else if (currentPage < totalPages) {
      onPageChange(currentPage + 1);
    }
  };

  return (
    <>
      <div
        className="fixed inset-0 bg-black/30 backdrop-blur-sm z-40 transition-opacity duration-300"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className={`fixed right-0 top-0 h-full w-full max-w-lg bg-white shadow-xl z-50 transform transition-transform duration-300 ease-in-out flex flex-col ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200 flex-shrink-0">
          <div className="flex items-center gap-2">
            <button
              onClick={handlePrev}
              disabled={!hasPrev}
              className="p-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label="Previous investor"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button
              onClick={handleNext}
              disabled={!hasNext}
              className="p-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label="Next investor"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-full"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {!investor ? (
            <p className="text-gray-500 text-sm">Select an investor to view details.</p>
          ) : (
            <div className="space-y-6">
              <div>
                <h2 className="text-xl font-semibold text-gray-900">{investor.name}</h2>
                {investor.role && (
                  <p className="text-sm text-gray-600 mt-1 flex items-center gap-2">
                    <Briefcase className="w-4 h-4 text-gray-400" />
                    {investor.role}
                  </p>
                )}
              </div>

              {(investor.hq_state || investor.hq_country) && (
                <div className="flex items-start gap-2">
                  <MapPin className="w-4 h-4 text-gray-400 mt-0.5 flex-shrink-0" />
                  <div className="text-sm text-gray-700">
                    {[investor.hq_state, investor.hq_country].filter(Boolean).join(', ')}
                  </div>
                </div>
              )}

              {investor.investor_type && investor.investor_type.length > 0 && (
                <div>
                  <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Investor type</h3>
                  <div className="flex flex-wrap gap-2">
                    {investor.investor_type.map((t) => (
                      <span
                        key={t}
                        className="inline-flex px-2.5 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-800"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div className="flex items-center gap-2">
                  <DollarSign className="w-4 h-4 text-gray-400" />
                  <div>
                    <p className="text-xs text-gray-500">Fund size</p>
                    <p className="text-sm font-medium text-gray-900">
                      {formatCurrency(investor.fund_size_usd)}
                    </p>
                  </div>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Check size</p>
                  <p className="text-sm font-medium text-gray-900">
                    {formatCurrency(investor.check_size_min_usd)} – {formatCurrency(investor.check_size_max_usd)}
                  </p>
                </div>
              </div>

              {investor.investment_stages && investor.investment_stages.length > 0 && (
                <div>
                  <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1">
                    <Target className="w-3.5 h-3.5" /> Investment stages
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {investor.investment_stages.map((s) => (
                      <span
                        key={s}
                        className="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-800"
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {investor.investment_industries && investor.investment_industries.length > 0 && (
                <div>
                  <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Industries</h3>
                  <div className="flex flex-wrap gap-2">
                    {investor.investment_industries.map((i) => (
                      <span
                        key={i}
                        className="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-emerald-50 text-emerald-800"
                      >
                        {i}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {investor.investment_geographies && investor.investment_geographies.length > 0 && (
                <div>
                  <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1">
                    <Globe className="w-3.5 h-3.5" /> Geographies
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {investor.investment_geographies.map((g) => (
                      <span
                        key={g}
                        className="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-sky-50 text-sky-800"
                      >
                        {g}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {investor.investment_thesis && (
                <div>
                  <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Investment thesis</h3>
                  <p className="text-sm text-gray-700 whitespace-pre-wrap">{investor.investment_thesis}</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
};

export default InvestorDetailsDrawer;
