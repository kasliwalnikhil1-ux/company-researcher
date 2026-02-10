'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import ProtectedRoute from '@/components/ProtectedRoute';
import MainLayout from '@/components/MainLayout';
import { supabase } from '@/utils/supabase/client';
import { Loader2, Search, DollarSign, Calendar, Globe, Users, Briefcase, Sparkles, ExternalLink, Plus, Trash2, X, CheckCircle2, AlertCircle, Lightbulb, ChevronLeft, ChevronRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';

/** User IDs allowed to add new fundings (same as ME_DATA_ALLOWED_USER_IDS) */
const ADD_FUNDING_ALLOWED_USER_IDS = new Set([
  '2793f3da-9340-44f4-b285-b7836bfb8591',
  'e25d5e21-13fd-46ee-a39a-4c3386b77b65',
]);

interface Founder {
  name: string;
  url?: string;
}

interface Investor {
  name: string;
  url?: string;
}

interface NewFunding {
  id: string;
  name: string | null;
  domain: string | null;
  founders: Founder[] | null;
  what_they_do: string | null;
  usp: string | null;
  how_much_funding: number | null;
  founded_in_year: number | null;
  investors: Investor[] | null;
  funding_date: string | null;
}

function formatCurrency(value: number | null | undefined): string {
  if (value == null || value === 0) return '-';
  if (value >= 1_000_000_000) {
    const s = (value / 1_000_000_000).toFixed(1).replace(/\.0$/, '');
    return `$${s}B`;
  }
  if (value >= 1_000_000) {
    const s = (value / 1_000_000).toFixed(1).replace(/\.0$/, '');
    return `$${s}M`;
  }
  if (value >= 1_000) {
    const s = (value / 1_000).toFixed(1).replace(/\.0$/, '');
    return `$${s}K`;
  }
  return `$${value}`;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '-';
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return dateStr;
  }
}

/** Convert investors array to [name](url) format for search */
function investorsToNameUrlList(investors: Investor[]): string[] {
  return investors.map((inv) => {
    if (inv.url) {
      const url = inv.url.startsWith('http') ? inv.url : `https://${inv.url}`;
      return `[${inv.name}](${url})`;
    }
    return inv.name;
  });
}

/* ── Company logo helper (mirrors InvestorDetailsDrawer) ── */
function getDomainFromUrl(urlStr: string): string | null {
  try {
    const u = new URL(urlStr);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function CompanyLogo({ name, url }: { name: string; url?: string }) {
  const domain = url ? getDomainFromUrl(url) : null;
  const [clearbitFailed, setClearbitFailed] = useState(false);
  const [faviconFailed, setFaviconFailed] = useState(false);

  const showLetter = !domain || (clearbitFailed && faviconFailed);
  const showFavicon = domain && clearbitFailed && !faviconFailed;
  const showClearbit = domain && !clearbitFailed;

  return (
    <div className="w-5 h-5 rounded-full overflow-hidden flex items-center justify-center flex-shrink-0 bg-gray-100">
      {showLetter ? (
        <span className="text-xs font-semibold text-gray-600">{name.charAt(0).toUpperCase()}</span>
      ) : showFavicon ? (
        <img
          src={`https://www.google.com/s2/favicons?sz=256&domain=${domain}`}
          alt=""
          onError={() => setFaviconFailed(true)}
          className="w-full h-full object-contain"
        />
      ) : showClearbit ? (
        <img
          src={`https://logo.clearbit.com/${domain}`}
          alt=""
          onError={() => setClearbitFailed(true)}
          className="w-full h-full object-contain"
        />
      ) : null}
    </div>
  );
}

/* ── Add-funding modal types ── */
interface FundingEntry {
  id: string;
  domain: string;
  description: string;
}

type EntryStatus = 'pending' | 'processing' | 'done' | 'error';

interface EntryResult {
  status: EntryStatus;
  error?: string;
  row?: NewFunding;
}

export default function NewFundingsPage() {
  return (
    <ProtectedRoute>
      <MainLayout>
        <div className="flex-1 overflow-auto">
          <NewFundingsContent />
        </div>
      </MainLayout>
    </ProtectedRoute>
  );
}

function NewFundingsContent() {
  const router = useRouter();
  const { user } = useAuth();
  const canAddFunding = ADD_FUNDING_ALLOWED_USER_IDS.has(user?.id ?? '');
  const [fundings, setFundings] = useState<NewFunding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [addModalOpen, setAddModalOpen] = useState(false);
  const PAGE_SIZE = 10;

  const fetchFundings = useCallback(async () => {
    try {
      setLoading(true);
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        setError('Not authenticated');
        return;
      }

      const res = await fetch('/api/new-fundings', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || res.statusText);
      }

      const body = await res.json();
      setFundings(body.rows || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load fundings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchFundings();
  }, [fetchFundings]);

  const handleSearchInvestors = (funding: NewFunding) => {
    if (!funding.investors || funding.investors.length === 0) return;
    const nameUrlList = investorsToNameUrlList(funding.investors);
    localStorage.setItem(
      'new-fundings-coinvestor-search',
      JSON.stringify({ investors: nameUrlList, companyName: funding.name || 'Unknown' })
    );
    router.push('/investors');
  };

  const filteredFundings = fundings.filter((f) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      (f.name && f.name.toLowerCase().includes(q)) ||
      (f.domain && f.domain.toLowerCase().includes(q)) ||
      (f.what_they_do && f.what_they_do.toLowerCase().includes(q)) ||
      (f.founders && f.founders.some((fo) => fo.name.toLowerCase().includes(q))) ||
      (f.investors && f.investors.some((inv) => inv.name.toLowerCase().includes(q)))
    );
  });

  const totalPages = Math.max(1, Math.ceil(filteredFundings.length / PAGE_SIZE));
  // Clamp page if filter narrows results
  const safePage = Math.min(currentPage, totalPages);
  if (safePage !== currentPage) setCurrentPage(safePage);
  const paginatedFundings = filteredFundings.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return (
    <div className="p-4 md:p-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-2">
          <div className="flex items-center gap-3">
            <Sparkles className="w-7 h-7 text-indigo-600" />
            <h1 className="text-2xl font-bold text-gray-900">New Fundings</h1>
          </div>
          {canAddFunding && (
            <button
              type="button"
              onClick={() => setAddModalOpen(true)}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-indigo-600 hover:bg-indigo-700 text-white transition-colors shadow-sm"
            >
              <Plus className="w-4 h-4" />
              Add New Funding
            </button>
          )}
        </div>
        <p className="text-sm text-gray-500">
          Recently funded companies and their investors
        </p>
      </div>

      {/* Search bar */}
      <div className="mb-6">
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search by name, domain, description, founder, or investor..."
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1); }}
            className="w-full pl-10 pr-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          />
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && filteredFundings.length === 0 && (
        <div className="text-center py-20 text-gray-500">
          {searchQuery ? 'No fundings match your search.' : 'No fundings found.'}
        </div>
      )}

      {/* Cards grid */}
      {!loading && !error && filteredFundings.length > 0 && (
        <>
          <div className="space-y-4">
            {paginatedFundings.map((funding) => (
              <FundingCard
                key={funding.id}
                funding={funding}
                onSearchInvestors={() => handleSearchInvestors(funding)}
              />
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="mt-6 flex items-center justify-between">
              <p className="text-sm text-gray-500">
                Showing {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filteredFundings.length)} of {filteredFundings.length}
              </p>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={safePage === 1}
                  className="inline-flex items-center justify-center w-9 h-9 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  aria-label="Previous page"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
                  <button
                    key={page}
                    type="button"
                    onClick={() => setCurrentPage(page)}
                    className={`inline-flex items-center justify-center w-9 h-9 rounded-lg text-sm font-medium transition-colors ${
                      page === safePage
                        ? 'bg-indigo-600 text-white'
                        : 'border border-gray-300 text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {page}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={safePage === totalPages}
                  className="inline-flex items-center justify-center w-9 h-9 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  aria-label="Next page"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Add New Funding Modal (admin only) */}
      {canAddFunding && addModalOpen && (
        <AddFundingModal
          onClose={() => setAddModalOpen(false)}
          onComplete={() => {
            setAddModalOpen(false);
            fetchFundings();
          }}
        />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   Add Funding Modal
   ═══════════════════════════════════════════════════════ */

function AddFundingModal({ onClose, onComplete }: { onClose: () => void; onComplete: () => void }) {
  const nextId = useRef(1);
  const [entries, setEntries] = useState<FundingEntry[]>([
    { id: String(nextId.current++), domain: '', description: '' },
  ]);
  const [results, setResults] = useState<Record<string, EntryResult>>({});
  const [isProcessing, setIsProcessing] = useState(false);
  const abortRef = useRef(false);

  const addEntry = () => {
    setEntries((prev) => [...prev, { id: String(nextId.current++), domain: '', description: '' }]);
  };

  const removeEntry = (id: string) => {
    setEntries((prev) => prev.filter((e) => e.id !== id));
  };

  const updateEntry = (id: string, field: 'domain' | 'description', value: string) => {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, [field]: value } : e)));
  };

  const validEntries = entries.filter((e) => e.description.trim());

  const handleProcess = async () => {
    if (validEntries.length === 0) return;
    setIsProcessing(true);
    abortRef.current = false;

    // Mark all valid entries as pending
    const initial: Record<string, EntryResult> = {};
    for (const e of validEntries) {
      initial[e.id] = { status: 'pending' };
    }
    setResults(initial);

    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) {
      setIsProcessing(false);
      return;
    }

    // Process entries sequentially (one Gemini call at a time to avoid rate limits)
    for (const entry of validEntries) {
      if (abortRef.current) break;

      setResults((prev) => ({ ...prev, [entry.id]: { status: 'processing' } }));

      try {
        const res = await fetch('/api/new-fundings/research', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ description: entry.description.trim(), domain: entry.domain.trim() }),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || res.statusText);
        }

        const body = await res.json();
        setResults((prev) => ({
          ...prev,
          [entry.id]: { status: 'done', row: body.row },
        }));
      } catch (err) {
        setResults((prev) => ({
          ...prev,
          [entry.id]: { status: 'error', error: err instanceof Error ? err.message : 'Failed' },
        }));
      }
    }

    setIsProcessing(false);
  };

  const doneCount = Object.values(results).filter((r) => r.status === 'done').length;
  const errorCount = Object.values(results).filter((r) => r.status === 'error').length;
  const allDone = validEntries.length > 0 && (doneCount + errorCount) === validEntries.length && !isProcessing;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Add New Fundings</h2>
          <button
            type="button"
            onClick={isProcessing ? undefined : (allDone ? onComplete : onClose)}
            disabled={isProcessing}
            className="p-1 text-gray-400 hover:text-gray-600 disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          <p className="text-sm text-gray-500 mb-3">
            Describe recently funded companies. We&apos;ll research each one using AI and add them to the database.
          </p>

          {entries.map((entry, idx) => {
            const result = results[entry.id];
            const statusIcon = result?.status === 'processing' ? (
              <Loader2 className="w-4 h-4 animate-spin text-indigo-500 shrink-0" />
            ) : result?.status === 'done' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
            ) : result?.status === 'error' ? (
              <div className="group relative">
                <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />
                {result.error && (
                  <div className="absolute bottom-full left-0 mb-1 hidden group-hover:block z-10 bg-gray-900 text-white text-xs rounded px-2 py-1 whitespace-nowrap max-w-xs truncate">
                    {result.error}
                  </div>
                )}
              </div>
            ) : null;

            return (
              <div
                key={entry.id}
                className={`flex items-start gap-3 p-3 rounded-lg border transition-colors ${
                  result?.status === 'done'
                    ? 'border-emerald-200 bg-emerald-50'
                    : result?.status === 'error'
                      ? 'border-red-200 bg-red-50'
                      : result?.status === 'processing'
                        ? 'border-indigo-200 bg-indigo-50'
                        : 'border-gray-200 bg-white'
                }`}
              >
                <span className="text-xs font-medium text-gray-400 mt-2.5 w-5 text-right shrink-0">
                  {idx + 1}
                </span>
                <div className="flex-1 min-w-0 space-y-2">
                  <input
                    type="text"
                    placeholder="Description (e.g. Serval is the AI-native ITSM for modern teams)"
                    value={entry.description}
                    onChange={(e) => updateEntry(entry.id, 'description', e.target.value)}
                    disabled={isProcessing}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 disabled:bg-gray-50 disabled:text-gray-500"
                  />
                  <input
                    type="text"
                    placeholder="Domain (optional, e.g. company.com)"
                    value={entry.domain}
                    onChange={(e) => updateEntry(entry.id, 'domain', e.target.value)}
                    disabled={isProcessing}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 disabled:bg-gray-50 disabled:text-gray-500"
                  />
                </div>
                <div className="flex items-center gap-2 mt-2">
                  {statusIcon}
                  {!isProcessing && entries.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeEntry(entry.id)}
                      className="p-1 text-gray-400 hover:text-red-500 transition-colors"
                      title="Remove"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          {!isProcessing && !allDone && (
            <button
              type="button"
              onClick={addEntry}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium text-gray-600 hover:text-indigo-600 hover:bg-indigo-50 border border-dashed border-gray-300 hover:border-indigo-300 transition-colors w-full justify-center"
            >
              <Plus className="w-4 h-4" />
              Add Another
            </button>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-between">
          <div className="text-sm text-gray-500">
            {isProcessing && (
              <span>
                Processing {doneCount + errorCount + 1} of {validEntries.length}...
              </span>
            )}
            {allDone && (
              <span>
                Done: {doneCount} succeeded{errorCount > 0 ? `, ${errorCount} failed` : ''}
              </span>
            )}
            {!isProcessing && !allDone && (
              <span>{validEntries.length} {validEntries.length === 1 ? 'company' : 'companies'} to research</span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {!isProcessing && !allDone && (
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 rounded-lg transition-colors"
              >
                Cancel
              </button>
            )}
            {isProcessing && (
              <button
                type="button"
                onClick={() => { abortRef.current = true; }}
                className="px-4 py-2 text-sm font-medium text-red-700 bg-red-50 hover:bg-red-100 rounded-lg transition-colors"
              >
                Stop
              </button>
            )}
            {allDone ? (
              <button
                type="button"
                onClick={onComplete}
                className="px-4 py-2.5 text-sm font-medium bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors shadow-sm"
              >
                Done
              </button>
            ) : (
              <button
                type="button"
                onClick={handleProcess}
                disabled={isProcessing || validEntries.length === 0}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isProcessing ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Researching...
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4" />
                    Research &amp; Add
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function FundingCard({
  funding,
  onSearchInvestors,
}: {
  funding: NewFunding;
  onSearchInvestors: () => void;
}) {
  const founders = Array.isArray(funding.founders) ? funding.founders : [];
  const investors = Array.isArray(funding.investors) ? funding.investors : [];
  const hasInvestors = investors.length > 0;

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-5 shadow-sm hover:border-gray-300 transition-colors">
      {/* Top row: Name + Domain + Funding Amount + Date */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h3 className="font-semibold text-lg text-gray-900">{funding.name || 'Unknown Company'}</h3>
            {funding.domain && (
              <a
                href={`https://${funding.domain}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-indigo-600 transition-colors"
              >
                <Globe className="w-3.5 h-3.5" />
                {funding.domain}
              </a>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          {funding.how_much_funding != null && funding.how_much_funding > 0 && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
              {formatCurrency(funding.how_much_funding)}
            </span>
          )}
          {funding.funding_date && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
              <Calendar className="w-3.5 h-3.5" />
              {formatDate(funding.funding_date)}
            </span>
          )}
        </div>
      </div>

      {/* What they do */}
      {funding.what_they_do && (
        <p className="text-sm text-gray-600 mt-3 leading-relaxed">{funding.what_they_do.trimEnd().endsWith('.') ? funding.what_they_do : `${funding.what_they_do.trimEnd()}.`}</p>
      )}

      {/* USP */}
      {funding.usp && (
        <div className="mt-2 flex items-start gap-1.5">
          <Lightbulb className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
          <p className="text-sm text-gray-600 leading-relaxed">{funding.usp.trimEnd().endsWith('.') ? funding.usp : `${funding.usp.trimEnd()}.`}</p>
        </div>
      )}

      {/* Founded year */}
      {funding.founded_in_year && (
        <div className="mt-3 flex items-center gap-1.5 text-xs text-gray-500">
          <Briefcase className="w-3.5 h-3.5" />
          Founded in {funding.founded_in_year}
          {(() => {
            const yrs = new Date().getFullYear() - funding.founded_in_year;
            const isRecent = yrs <= 5;
            return (
              <span className={`ml-1 px-1.5 py-0.5 rounded font-medium ${isRecent ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
                {'<'}{yrs <= 1 ? '1 year ago' : `${yrs} years ago`}
              </span>
            );
          })()}
        </div>
      )}

      {/* Founders */}
      {founders.length > 0 && (
        <div className="mt-4 pt-3 border-t border-gray-100">
          <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Users className="w-3.5 h-3.5 text-gray-400" />
            Founders
          </h4>
          <div className="flex flex-wrap gap-2">
            {founders.map((founder, idx) => {
              const url = founder.url
                ? (founder.url.startsWith('http') ? founder.url : `https://${founder.url}`)
                : null;
              return url ? (
                <a
                  key={idx}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-sm font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 border border-indigo-100 hover:border-indigo-200 transition-colors"
                >
                  {founder.name}
                  <ExternalLink className="w-3 h-3" />
                </a>
              ) : (
                <span
                  key={idx}
                  className="inline-flex items-center px-2.5 py-1 rounded-md text-sm font-medium text-gray-700 bg-gray-100 border border-gray-200"
                >
                  {founder.name}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* Investors */}
      {investors.length > 0 && (
        <div className="mt-4 pt-3 border-t border-gray-100">
          <div className="flex items-center gap-2 flex-wrap mb-2">
            <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
              <DollarSign className="w-3.5 h-3.5 text-gray-400" />
              Investors
            </h4>
            {hasInvestors && (
              <button
                type="button"
                onClick={onSearchInvestors}
                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium text-gray-600 bg-gray-100 hover:text-indigo-600 hover:bg-indigo-50 border border-gray-200 hover:border-indigo-200 transition-colors"
                title="Search these investors"
                aria-label="Search these investors"
              >
                <Search className="w-3.5 h-3.5 shrink-0" />
                <span>Search these investors</span>
              </button>
            )}
          </div>
          <ul className="space-y-1.5">
            {investors.map((investor, idx) => {
              const url = investor.url
                ? (investor.url.startsWith('http') ? investor.url : `https://${investor.url}`)
                : null;
              return (
                <li key={idx} className="flex items-center gap-2.5">
                  <CompanyLogo name={investor.name} url={url ?? undefined} />
                  {url ? (
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-indigo-600 hover:text-indigo-800 hover:underline"
                    >
                      {investor.name}
                    </a>
                  ) : (
                    <span className="text-sm text-gray-700">{investor.name}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
