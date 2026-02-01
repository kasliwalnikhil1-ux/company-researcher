'use client';

import { useState } from 'react';
import { X, LayoutGrid } from 'lucide-react';

// Aligned with investor-research route (investment_industries) - exported for reuse
export const SECTORS = [
  'artificial-intelligence', 'machine-learning', 'healthtech', 'biotech', 'digital-health', 'mental-health',
  'wellness', 'longevity', 'fitness', 'consumer-health', 'medtech', 'pharma', 'genomics', 'bioinformatics',
  'neuroscience', 'consumer-tech', 'enterprise-software', 'saas', 'vertical-saas', 'developer-tools',
  'productivity', 'collaboration', 'fintech', 'payments', 'lending', 'credit', 'insurtech', 'regtech',
  'wealthtech', 'climate-tech', 'energy', 'clean-energy', 'carbon-removal', 'sustainability', 'web3',
  'blockchain', 'crypto', 'defi', 'nft', 'social-platforms', 'marketplaces', 'creator-economy', 'edtech',
  'hr-tech', 'future-of-work', 'mobility', 'transportation', 'autonomous-vehicles', 'robotics', 'hardware',
  'deep-tech', 'semiconductors', 'data-infrastructure', 'cloud-infrastructure', 'devops', 'cybersecurity',
  'security', 'privacy', 'identity', 'digital-identity', 'consumer-internet', 'ecommerce', 'retail-tech',
  'proptech', 'real-estate', 'construction-tech', 'smart-cities', 'supply-chain', 'logistics',
  'manufacturing', 'industrial-tech', 'agtech', 'foodtech', 'gaming', 'esports', 'media', 'entertainment',
  'music-tech', 'sports-tech', 'travel-tech', 'hospitality', 'martech', 'adtech', 'legal-tech', 'govtech',
  'defense-tech', 'space-tech', 'aerospace', 'iot', 'edge-computing', 'network-effects',
];

const SECTOR_CATEGORIES: { label: string; sectors: string[] }[] = [
  {
    label: 'Technology & Software',
    sectors: [
      'artificial-intelligence', 'machine-learning', 'consumer-tech', 'enterprise-software', 'saas', 'vertical-saas',
      'developer-tools', 'productivity', 'collaboration', 'deep-tech', 'semiconductors', 'data-infrastructure',
      'cloud-infrastructure', 'devops', 'cybersecurity', 'security', 'privacy', 'identity', 'digital-identity',
      'web3', 'blockchain', 'crypto', 'defi', 'nft', 'consumer-internet', 'iot', 'edge-computing', 'network-effects',
    ],
  },
  {
    label: 'Healthcare & Life Sciences',
    sectors: [
      'healthtech', 'biotech', 'digital-health', 'mental-health', 'wellness', 'longevity', 'fitness',
      'consumer-health', 'medtech', 'pharma', 'genomics', 'bioinformatics', 'neuroscience',
    ],
  },
  {
    label: 'Industry, Finance & Consumer',
    sectors: [
      'fintech', 'payments', 'lending', 'credit', 'insurtech', 'regtech', 'wealthtech', 'climate-tech',
      'energy', 'clean-energy', 'carbon-removal', 'sustainability', 'social-platforms', 'marketplaces',
      'creator-economy', 'edtech', 'hr-tech', 'future-of-work', 'mobility', 'transportation',
      'autonomous-vehicles', 'robotics', 'hardware', 'proptech', 'real-estate', 'construction-tech',
      'smart-cities', 'supply-chain', 'logistics', 'manufacturing', 'industrial-tech', 'agtech', 'foodtech',
      'gaming', 'esports', 'media', 'entertainment', 'music-tech', 'sports-tech', 'travel-tech', 'hospitality',
      'martech', 'adtech', 'legal-tech', 'govtech', 'defense-tech', 'space-tech', 'aerospace', 'ecommerce', 'retail-tech',
    ],
  },
];

const formatKebabLabel = (value: string): string =>
  value.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');

export interface SectorSelectorProps {
  value: string[];
  onChange: (sectors: string[]) => void;
  label?: string;
  required?: boolean;
  removableChips?: boolean;
}

export function SectorSelector({ value, onChange, label = 'Sector', required, removableChips = true }: SectorSelectorProps) {
  const [sectorSearch, setSectorSearch] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);

  const search = sectorSearch.toLowerCase();
  const filteredSectors = SECTORS.filter(s =>
    s.toLowerCase().includes(search) || formatKebabLabel(s).toLowerCase().includes(search)
  );

  const toggleSector = (sector: string) => {
    const updated = value.includes(sector)
      ? value.filter(s => s !== sector)
      : [...value, sector];
    onChange(updated);
  };

  const removeSector = (sector: string) => {
    onChange(value.filter(s => s !== sector));
  };

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-2">
        {label} {required && <span className="text-red-500">*</span>} (Multi-select)
      </label>
      <div className="flex gap-2 mb-3">
        <input
          type="text"
          value={sectorSearch}
          onChange={(e) => setSectorSearch(e.target.value)}
          className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
          placeholder="Search sectors..."
        />
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          className="flex items-center gap-2 px-4 py-2 border-2 border-indigo-300 rounded-lg text-indigo-600 hover:bg-indigo-50 hover:border-indigo-400 transition-colors font-medium shrink-0"
        >
          <LayoutGrid className="w-5 h-5" />
          Browse all
        </button>
      </div>
      <div className="border border-gray-300 rounded-lg max-h-60 overflow-y-auto p-2">
        {filteredSectors.map((sector) => {
          const isSelected = value.includes(sector);
          return (
            <label
              key={sector}
              className="flex items-center p-2 hover:bg-gray-50 rounded cursor-pointer"
            >
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => toggleSector(sector)}
                className="mr-3"
              />
              <span>{formatKebabLabel(sector)}</span>
            </label>
          );
        })}
      </div>
      {value.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {value.map((sector) => (
            <span
              key={sector}
              className="px-3 py-1 bg-indigo-100 text-indigo-700 rounded-full text-sm flex items-center gap-2"
            >
              {formatKebabLabel(sector)}
              {removableChips && (
                <button
                  type="button"
                  onClick={() => removeSector(sector)}
                  className="hover:text-indigo-900"
                  aria-label={`Remove ${formatKebabLabel(sector)}`}
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {/* Sector selection drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-[100] flex">
          <div
            className="absolute inset-0 bg-black/30 backdrop-blur-sm transition-opacity duration-300"
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
          <div className="relative ml-auto w-full max-w-4xl h-full bg-white shadow-2xl flex flex-col animate-in slide-in-from-right duration-300">
            <div className="flex items-center justify-between p-4 border-b border-gray-200 shrink-0">
              <h3 className="text-lg font-semibold text-gray-900">Select sectors</h3>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 border-b border-gray-100 shrink-0">
              <input
                type="text"
                value={sectorSearch}
                onChange={(e) => setSectorSearch(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder="Search sectors..."
                autoFocus
              />
            </div>
            <div className="flex-1 overflow-y-auto p-4 pb-8 space-y-6">
              {SECTOR_CATEGORIES.map((category) => {
                const categorySectors = category.sectors.filter(s =>
                  s.toLowerCase().includes(search) || formatKebabLabel(s).toLowerCase().includes(search)
                );
                if (categorySectors.length === 0) return null;
                return (
                  <div key={category.label}>
                    <h4 className="text-sm font-semibold text-gray-700 mb-2">{category.label}</h4>
                    <div className="grid grid-cols-4 sm:grid-cols-5 gap-1.5">
                      {categorySectors.map((sector) => {
                        const isSelected = value.includes(sector);
                        return (
                          <label
                            key={sector}
                            className={`flex items-center p-1.5 rounded border-2 cursor-pointer transition-all min-w-0 ${
                              isSelected ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleSector(sector)}
                              className="sr-only"
                            />
                            <span className="text-xs font-medium truncate" title={formatKebabLabel(sector)}>{formatKebabLabel(sector)}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="p-4 border-t border-gray-200 shrink-0 flex items-center justify-between">
              <span className="text-sm text-gray-500">{value.length} selected</span>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="px-6 py-2 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
