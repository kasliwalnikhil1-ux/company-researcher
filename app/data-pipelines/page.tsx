'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useRouter } from 'next/navigation';
import { supabase } from '@/utils/supabase/client';
import ProtectedRoute from '@/components/ProtectedRoute';
import MainLayout from '@/components/MainLayout';
import {
  Wrench,
  Play,
  Loader2,
  Download,
  ChevronDown,
  ChevronUp,
  Users,
  Globe,
  Linkedin,
  AlertCircle,
  CheckCircle2,
  Building2,
  Calendar,
  Search,
  RefreshCw,
  Square,
  CheckSquare,
  XCircle,
  SkipForward,
  StopCircle,
  UserSearch,
  MailX,
  MailCheck,
  Upload,
  FileUp,
  ShieldOff,
  Trash2,
  ExternalLink,
  DollarSign,
  Sparkles,
  FileSearch,
} from 'lucide-react';

const ALLOWED_USER_IDS = new Set([
  '2793f3da-9340-44f4-b285-b7836bfb8591',
  'e25d5e21-13fd-46ee-a39a-4c3386b77b65',
]);

interface MissingCoinvestor {
  name: string;
  url: string;
  type: 'domain' | 'linkedin';
  identifier: string;
  count: number;
  sourceInvestors: string[];
}

interface MissingCoinvestorsResult {
  totalCoinvestorEntries: number;
  totalInvestorsWithCoinvestors: number;
  existingDomainCount: number;
  existingLinkedinCount: number;
  missingCount: number;
  missing: MissingCoinvestor[];
}

export default function DataPipelinesPage() {
  const { user } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (user && !ALLOWED_USER_IDS.has(user.id)) {
      router.replace('/');
    }
  }, [user, router]);

  const canAccess = user && ALLOWED_USER_IDS.has(user.id);

  return (
    <ProtectedRoute>
      <MainLayout>
        <div className="flex-1 overflow-auto">
          {canAccess && <DataPipelinesContent />}
        </div>
      </MainLayout>
    </ProtectedRoute>
  );
}

function DataPipelinesContent() {
  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
      {/* Page Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2 bg-indigo-50 rounded-lg">
            <Wrench className="w-6 h-6 text-indigo-600" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Data Updation Pipelines</h1>
        </div>
        <p className="text-gray-500 text-sm ml-14">
          Tools for maintaining and updating investor data. Run pipelines to find gaps and generate actionable CSV exports.
        </p>
      </div>

      {/* Tools */}
      <div className="space-y-6">
        <MissingCoinvestorsTool />
        <RerunContactsTool />
        <RerunProfileTool />
        <UnverifiedEmailsTool />
        <UpdateVerifiedEmailsTool />
        <NotAnInvestorTool />
        <MissingFundingInvestorsTool />
        <MissingDeepResearchTool />
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   Tool 1: Missing Co-investors
   ───────────────────────────────────────────────────────────── */

function MissingCoinvestorsTool() {
  const [expanded, setExpanded] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MissingCoinvestorsResult | null>(null);
  const [typeFilter, setTypeFilter] = useState<'all' | 'domain' | 'linkedin'>('all');
  const [sortBy, setSortBy] = useState<'count' | 'name'>('count');

  const runPipeline = useCallback(async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      if (!accessToken) {
        setError('No active session. Please log in again.');
        return;
      }

      const res = await fetch('/api/data-pipelines/missing-coinvestors', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error || `Request failed (${res.status})`);
        return;
      }

      const data: MissingCoinvestorsResult = await res.json();
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  const filteredMissing = result
    ? result.missing.filter((m) => typeFilter === 'all' || m.type === typeFilter)
    : [];

  const sortedMissing = [...filteredMissing].sort((a, b) => {
    if (sortBy === 'count') return b.count - a.count;
    return a.name.localeCompare(b.name);
  });

  const downloadCSV = useCallback(() => {
    if (!sortedMissing.length) return;

    const headers = ['Name', 'Type', 'Identifier', 'URL', 'Referenced By Count', 'Referenced By Investors'];
    const rows = sortedMissing.map((m) => [
      m.name,
      m.type,
      m.identifier,
      m.type === 'linkedin'
        ? `https://www.linkedin.com/${m.identifier}`
        : `https://${m.identifier}`,
      String(m.count),
      m.sourceInvestors.join('; '),
    ]);

    const csvContent = [headers, ...rows]
      .map((row) =>
        row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(',')
      )
      .join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const filterSuffix = typeFilter === 'all' ? '' : `-${typeFilter}`;
    link.download = `missing-coinvestors${filterSuffix}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [sortedMissing, typeFilter]);

  const domainCount = result ? result.missing.filter((m) => m.type === 'domain').length : 0;
  const linkedinCount = result ? result.missing.filter((m) => m.type === 'linkedin').length : 0;

  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
      {/* Tool Header */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-6 py-4 hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="p-1.5 bg-orange-50 rounded-lg">
            <Users className="w-5 h-5 text-orange-600" />
          </div>
          <div className="text-left">
            <h2 className="text-base font-semibold text-gray-900">
              Tool 1: Missing Co-investors Finder
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Find Featured Co-investors from all investors that are not yet in the database
            </p>
          </div>
        </div>
        {expanded ? (
          <ChevronUp className="w-5 h-5 text-gray-400" />
        ) : (
          <ChevronDown className="w-5 h-5 text-gray-400" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-gray-100">
          {/* Description & Run */}
          <div className="px-6 py-4 bg-gray-50 border-b border-gray-100">
            <div className="flex items-start justify-between gap-4">
              <div className="text-sm text-gray-600 space-y-1">
                <p>
                  This pipeline scans all investors in the database, collects their{' '}
                  <span className="font-medium text-gray-800">Featured Co-investors</span>, and identifies
                  co-investors that are <span className="font-medium text-gray-800">not yet present</span> in the
                  investors table.
                </p>
                <p className="text-xs text-gray-500">
                  Handles both domains (e.g. accel.com) and LinkedIn URLs (e.g. in/namankas).
                  Same logic as the &quot;Search these co-investors&quot; button in the Investor Details drawer.
                </p>
              </div>
              <button
                type="button"
                onClick={runPipeline}
                disabled={loading}
                className="flex-shrink-0 inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors shadow-sm"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Running...
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4" />
                    Run Pipeline
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="px-6 py-3 bg-red-50 border-b border-red-100 flex items-center gap-2 text-sm text-red-700">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {error}
            </div>
          )}

          {/* Results */}
          {result && (
            <div className="px-6 py-4 space-y-4">
              {/* Summary Stats */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatCard
                  label="Investors with Co-investors"
                  value={result.totalInvestorsWithCoinvestors}
                />
                <StatCard
                  label="Unique Co-investor Entries"
                  value={result.totalCoinvestorEntries}
                />
                <StatCard
                  label="Already in DB"
                  value={result.totalCoinvestorEntries - result.missingCount}
                  color="green"
                />
                <StatCard
                  label="Missing from DB"
                  value={result.missingCount}
                  color={result.missingCount > 0 ? 'orange' : 'green'}
                />
              </div>

              {result.missingCount > 0 && (
                <>
                  {/* Filters & Actions Bar */}
                  <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
                    <div className="flex items-center gap-2">
                      {/* Type filter tabs */}
                      <div className="inline-flex rounded-lg border border-gray-200 bg-white overflow-hidden text-xs">
                        <button
                          type="button"
                          onClick={() => setTypeFilter('all')}
                          className={`px-3 py-1.5 font-medium transition-colors ${
                            typeFilter === 'all'
                              ? 'bg-indigo-50 text-indigo-700'
                              : 'text-gray-600 hover:bg-gray-50'
                          }`}
                        >
                          All ({result.missingCount})
                        </button>
                        <button
                          type="button"
                          onClick={() => setTypeFilter('domain')}
                          className={`px-3 py-1.5 font-medium transition-colors border-l border-gray-200 flex items-center gap-1 ${
                            typeFilter === 'domain'
                              ? 'bg-indigo-50 text-indigo-700'
                              : 'text-gray-600 hover:bg-gray-50'
                          }`}
                        >
                          <Globe className="w-3 h-3" />
                          Domains ({domainCount})
                        </button>
                        <button
                          type="button"
                          onClick={() => setTypeFilter('linkedin')}
                          className={`px-3 py-1.5 font-medium transition-colors border-l border-gray-200 flex items-center gap-1 ${
                            typeFilter === 'linkedin'
                              ? 'bg-indigo-50 text-indigo-700'
                              : 'text-gray-600 hover:bg-gray-50'
                          }`}
                        >
                          <Linkedin className="w-3 h-3" />
                          LinkedIn ({linkedinCount})
                        </button>
                      </div>

                      {/* Sort */}
                      <select
                        value={sortBy}
                        onChange={(e) => setSortBy(e.target.value as 'count' | 'name')}
                        className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 text-gray-600 bg-white"
                      >
                        <option value="count">Sort by References</option>
                        <option value="name">Sort by Name</option>
                      </select>
                    </div>

                    {/* Download CSV */}
                    <button
                      type="button"
                      onClick={downloadCSV}
                      disabled={sortedMissing.length === 0}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-green-600 hover:bg-green-700 disabled:opacity-50 transition-colors shadow-sm"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Download CSV ({sortedMissing.length})
                    </button>
                  </div>

                  {/* Results Table */}
                  <div className="border border-gray-200 rounded-lg overflow-hidden">
                    <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                      <table className="min-w-full divide-y divide-gray-200 text-sm">
                        <thead className="bg-gray-50 sticky top-0 z-10">
                          <tr>
                            <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              #
                            </th>
                            <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Name
                            </th>
                            <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Type
                            </th>
                            <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Identifier
                            </th>
                            <th className="px-4 py-2.5 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Refs
                            </th>
                            <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Referenced By
                            </th>
                          </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-100">
                          {sortedMissing.map((m, idx) => (
                            <tr key={`${m.type}:${m.identifier}`} className="hover:bg-gray-50">
                              <td className="px-4 py-2 text-gray-400 text-xs">
                                {idx + 1}
                              </td>
                              <td className="px-4 py-2 font-medium text-gray-900">
                                <a
                                  href={
                                    m.type === 'linkedin'
                                      ? `https://www.linkedin.com/${m.identifier}`
                                      : `https://${m.identifier}`
                                  }
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-indigo-600 hover:text-indigo-800 hover:underline"
                                >
                                  {m.name}
                                </a>
                              </td>
                              <td className="px-4 py-2">
                                {m.type === 'linkedin' ? (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700">
                                    <Linkedin className="w-3 h-3" />
                                    LinkedIn
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700">
                                    <Globe className="w-3 h-3" />
                                    Domain
                                  </span>
                                )}
                              </td>
                              <td className="px-4 py-2 text-gray-600 font-mono text-xs">
                                {m.identifier}
                              </td>
                              <td className="px-4 py-2 text-center">
                                <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-orange-50 text-orange-700 text-xs font-medium">
                                  {m.count}
                                </span>
                              </td>
                              <td className="px-4 py-2 text-gray-500 text-xs max-w-[300px]">
                                <span className="truncate block" title={m.sourceInvestors.join(', ')}>
                                  {m.sourceInvestors.slice(0, 3).join(', ')}
                                  {m.sourceInvestors.length > 3 && (
                                    <span className="text-gray-400">
                                      {' '}+{m.sourceInvestors.length - 3} more
                                    </span>
                                  )}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              )}

              {result.missingCount === 0 && (
                <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-green-50 text-green-700 text-sm">
                  <CheckCircle2 className="w-5 h-5" />
                  All co-investors are already present in the database. No missing entries found.
                </div>
              )}
            </div>
          )}

          {/* Empty state before run */}
          {!result && !loading && !error && (
            <div className="px-6 py-12 text-center text-gray-400 text-sm">
              Click <span className="font-medium text-gray-600">&quot;Run Pipeline&quot;</span> to scan all Featured Co-investors and find missing entries.
            </div>
          )}

          {/* Loading state */}
          {loading && !result && (
            <div className="px-6 py-12 flex flex-col items-center gap-3 text-gray-500">
              <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
              <p className="text-sm">Scanning all investors and co-investors...</p>
              <p className="text-xs text-gray-400">This may take a moment depending on database size.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   Tool 2: Rerun Firm Contacts
   ───────────────────────────────────────────────────────────── */

interface Firm {
  id: string;
  name: string;
  domain: string;
  updated_at: string;
  linkedin_url: string | null;
}

interface FirmContact {
  key: string;
  firmId: string;
  firmName: string;
  firmDomain: string;
  full_name: string | null;
  linkedin_url: string;
  input: string;
  email: string | null;
  title: string | null;
}

type ContactStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

interface ContactResult {
  status: ContactStatus;
  message?: string;
  investor_id?: string;
}

function RerunContactsTool() {
  const [expanded, setExpanded] = useState(false);

  // Filters
  const [updatedAtFrom, setUpdatedAtFrom] = useState('');
  const [updatedAtTo, setUpdatedAtTo] = useState('');

  // Firms
  const [firms, setFirms] = useState<Firm[]>([]);
  const [selectedFirmIds, setSelectedFirmIds] = useState<Set<string>>(new Set());
  const [loadingFirms, setLoadingFirms] = useState(false);
  const [firmsError, setFirmsError] = useState<string | null>(null);

  // Contacts
  const [contacts, setContacts] = useState<FirmContact[]>([]);
  const [selectedContactKeys, setSelectedContactKeys] = useState<Set<string>>(new Set());
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [contactsFetchProgress, setContactsFetchProgress] = useState<{ done: number; total: number } | null>(null);
  const [contactsError, setContactsError] = useState<string | null>(null);

  // Processing
  const [processing, setProcessing] = useState(false);
  const [contactResults, setContactResults] = useState<Map<string, ContactResult>>(new Map());
  const [skipExisting, setSkipExisting] = useState(true);
  const stopRef = useRef(false);

  const getAccessToken = useCallback(async (): Promise<string | null> => {
    const { data: sessionData } = await supabase.auth.getSession();
    return sessionData?.session?.access_token || null;
  }, []);

  // ── Fetch Firms ──
  const fetchFirms = useCallback(async () => {
    setLoadingFirms(true);
    setFirmsError(null);
    setFirms([]);
    setSelectedFirmIds(new Set());
    setContacts([]);
    setSelectedContactKeys(new Set());
    setContactResults(new Map());

    try {
      const accessToken = await getAccessToken();
      if (!accessToken) {
        setFirmsError('No active session. Please log in again.');
        return;
      }

      const body: Record<string, string> = {};
      if (updatedAtFrom) body.updatedAtFrom = new Date(updatedAtFrom).toISOString();
      if (updatedAtTo) body.updatedAtTo = new Date(updatedAtTo).toISOString();

      const res = await fetch('/api/data-pipelines/rerun-contacts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setFirmsError(data?.error || `Request failed (${res.status})`);
        return;
      }

      const data = await res.json();
      setFirms(data.firms || []);
    } catch (err) {
      setFirmsError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoadingFirms(false);
    }
  }, [updatedAtFrom, updatedAtTo, getAccessToken]);

  // ── Fetch Contacts for selected firms ──
  const fetchContacts = useCallback(async () => {
    const selectedFirms = firms.filter((f) => selectedFirmIds.has(f.id));
    if (selectedFirms.length === 0) return;

    setLoadingContacts(true);
    setContactsError(null);
    setContacts([]);
    setSelectedContactKeys(new Set());
    setContactResults(new Map());
    setContactsFetchProgress({ done: 0, total: selectedFirms.length });

    try {
      const accessToken = await getAccessToken();
      if (!accessToken) {
        setContactsError('No active session. Please log in again.');
        return;
      }

      const allContacts: FirmContact[] = [];
      let done = 0;

      for (const firm of selectedFirms) {
        try {
          const res = await fetch('/api/data-pipelines/rerun-contacts/fetch-contacts', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify({ firmId: firm.id, domain: firm.domain }),
          });

          if (res.ok) {
            const data = await res.json();
            const firmContacts: FirmContact[] = (data.contacts || []).map(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (c: any) => ({
                key: `${firm.id}:${c.linkedin_url}`,
                firmId: firm.id,
                firmName: firm.name,
                firmDomain: firm.domain,
                full_name: c.full_name,
                linkedin_url: c.linkedin_url,
                input: c.input,
                email: c.email,
                title: c.title,
              })
            );
            allContacts.push(...firmContacts);
          } else {
            console.error(`Failed to fetch contacts for ${firm.domain}:`, res.status);
          }
        } catch (e) {
          console.error(`Error fetching contacts for ${firm.domain}:`, e);
        }
        done++;
        setContactsFetchProgress({ done, total: selectedFirms.length });
      }

      setContacts(allContacts);
      // Auto-select all contacts
      setSelectedContactKeys(new Set(allContacts.map((c) => c.key)));
    } catch (err) {
      setContactsError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoadingContacts(false);
      setContactsFetchProgress(null);
    }
  }, [firms, selectedFirmIds, getAccessToken]);

  // ── Process Contacts ──
  const processContacts = useCallback(
    async (contactsToProcess: FirmContact[]) => {
      if (contactsToProcess.length === 0) return;

      setProcessing(true);
      stopRef.current = false;

      // Initialize all statuses to pending
      const newResults = new Map(contactResults);
      for (const c of contactsToProcess) {
        newResults.set(c.key, { status: 'pending' });
      }
      setContactResults(new Map(newResults));

      const BATCH_SIZE = 10;
      for (let i = 0; i < contactsToProcess.length; i += BATCH_SIZE) {
        if (stopRef.current) {
          console.log('[rerun-contacts] Processing stopped by user');
          break;
        }

        const batch = contactsToProcess.slice(i, i + BATCH_SIZE);

        // Set all contacts in this batch to running
        for (const contact of batch) {
          newResults.set(contact.key, { status: 'running' });
        }
        setContactResults(new Map(newResults));

        // Process batch in parallel
        await Promise.all(
          batch.map(async (contact) => {
            try {
              const res = await fetch('/api/investor-research', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  input: contact.input,
                  skipExisting,
                  affiliateWithFirmId: contact.firmId,
                  affiliateContactEmail: contact.email || undefined,
                }),
              });

              if (res.ok) {
                const data = await res.json();
                if (data.skipped) {
                  newResults.set(contact.key, {
                    status: 'skipped',
                    message: data.reason || 'Already exists',
                    investor_id: data.investor_id,
                  });
                } else {
                  newResults.set(contact.key, {
                    status: 'done',
                    message: data.summary?.clean_name || 'Processed',
                    investor_id: data.investor_id,
                  });
                }
              } else {
                const errData = await res.json().catch(() => null);
                newResults.set(contact.key, {
                  status: 'failed',
                  message: errData?.error || `HTTP ${res.status}`,
                });
              }
            } catch (err) {
              newResults.set(contact.key, {
                status: 'failed',
                message: err instanceof Error ? err.message : 'Unknown error',
              });
            }

            setContactResults(new Map(newResults));
          })
        );
      }

      setProcessing(false);
    },
    [contactResults, skipExisting]
  );

  const handleRunSelected = useCallback(() => {
    const selected = contacts.filter((c) => selectedContactKeys.has(c.key));
    processContacts(selected);
  }, [contacts, selectedContactKeys, processContacts]);

  const handleRunAll = useCallback(() => {
    processContacts(contacts);
  }, [contacts, processContacts]);

  const handleStop = useCallback(() => {
    stopRef.current = true;
  }, []);

  // ── Selection helpers ──
  const toggleFirm = (id: string) => {
    setSelectedFirmIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllFirms = () => {
    if (selectedFirmIds.size === firms.length) {
      setSelectedFirmIds(new Set());
    } else {
      setSelectedFirmIds(new Set(firms.map((f) => f.id)));
    }
  };

  const toggleContact = (key: string) => {
    setSelectedContactKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAllContacts = () => {
    if (selectedContactKeys.size === contacts.length) {
      setSelectedContactKeys(new Set());
    } else {
      setSelectedContactKeys(new Set(contacts.map((c) => c.key)));
    }
  };

  // Stats for processing
  const processedCount = Array.from(contactResults.values()).filter((r) => r.status === 'done').length;
  const skippedCount = Array.from(contactResults.values()).filter((r) => r.status === 'skipped').length;
  const failedCount = Array.from(contactResults.values()).filter((r) => r.status === 'failed').length;
  const runningCount = Array.from(contactResults.values()).filter((r) => r.status === 'running').length;
  const totalProcessed = processedCount + skippedCount + failedCount;

  const formatDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return iso;
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
      {/* Tool Header */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-6 py-4 hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="p-1.5 bg-indigo-50 rounded-lg">
            <RefreshCw className="w-5 h-5 text-indigo-600" />
          </div>
          <div className="text-left">
            <h2 className="text-base font-semibold text-gray-900">
              Tool 2: Rerun Firm Contacts
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Fetch and re-process contacts for firms filtered by updated_at timestamp
            </p>
          </div>
        </div>
        {expanded ? (
          <ChevronUp className="w-5 h-5 text-gray-400" />
        ) : (
          <ChevronDown className="w-5 h-5 text-gray-400" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-gray-100">
          {/* Description & Filters */}
          <div className="px-6 py-4 bg-gray-50 border-b border-gray-100">
            <div className="text-sm text-gray-600 space-y-1 mb-4">
              <p>
                Filter firms by <span className="font-medium text-gray-800">updated_at</span> timestamp,
                fetch their contacts via investor-search, then run the full investor research pipeline
                for each contact (classification, deep research, structured extraction, and affiliation creation).
              </p>
            </div>

            {/* Date Filters */}
            <div className="flex flex-wrap items-end gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  <Calendar className="w-3 h-3 inline mr-1" />
                  Updated At From
                </label>
                <input
                  type="datetime-local"
                  value={updatedAtFrom}
                  onChange={(e) => setUpdatedAtFrom(e.target.value)}
                  className="block w-full px-3 py-1.5 text-sm border border-gray-300 rounded-lg bg-white focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  disabled={loadingFirms || processing}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  <Calendar className="w-3 h-3 inline mr-1" />
                  Updated At To
                </label>
                <input
                  type="datetime-local"
                  value={updatedAtTo}
                  onChange={(e) => setUpdatedAtTo(e.target.value)}
                  className="block w-full px-3 py-1.5 text-sm border border-gray-300 rounded-lg bg-white focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  disabled={loadingFirms || processing}
                />
              </div>
              <button
                type="button"
                onClick={fetchFirms}
                disabled={loadingFirms || processing}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors shadow-sm"
              >
                {loadingFirms ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Fetching...
                  </>
                ) : (
                  <>
                    <Search className="w-4 h-4" />
                    Fetch Firms
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Firms Error */}
          {firmsError && (
            <div className="px-6 py-3 bg-red-50 border-b border-red-100 flex items-center gap-2 text-sm text-red-700">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {firmsError}
            </div>
          )}

          {/* Firms Table */}
          {firms.length > 0 && (
            <div className="px-6 py-4 border-b border-gray-100">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
                  <Building2 className="w-4 h-4 text-gray-500" />
                  Firms ({firms.length})
                  {selectedFirmIds.size > 0 && (
                    <span className="text-xs font-normal text-indigo-600">
                      ({selectedFirmIds.size} selected)
                    </span>
                  )}
                </h3>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={fetchContacts}
                    disabled={selectedFirmIds.size === 0 || loadingContacts || processing}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
                  >
                    {loadingContacts ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        Fetching Contacts...
                        {contactsFetchProgress && (
                          <span>({contactsFetchProgress.done}/{contactsFetchProgress.total})</span>
                        )}
                      </>
                    ) : (
                      <>
                        <UserSearch className="w-3.5 h-3.5" />
                        Fetch Contacts ({selectedFirmIds.size})
                      </>
                    )}
                  </button>
                </div>
              </div>

              <div className="border border-gray-200 rounded-lg overflow-hidden">
                <div className="overflow-x-auto max-h-[300px] overflow-y-auto">
                  <table className="min-w-full divide-y divide-gray-200 text-sm">
                    <thead className="bg-gray-50 sticky top-0 z-10">
                      <tr>
                        <th className="px-3 py-2.5 text-left w-10">
                          <button type="button" onClick={toggleAllFirms} className="text-gray-400 hover:text-gray-600">
                            {selectedFirmIds.size === firms.length ? (
                              <CheckSquare className="w-4 h-4 text-indigo-600" />
                            ) : (
                              <Square className="w-4 h-4" />
                            )}
                          </button>
                        </th>
                        <th className="px-3 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Name
                        </th>
                        <th className="px-3 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Domain
                        </th>
                        <th className="px-3 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Updated At
                        </th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-100">
                      {firms.map((firm) => (
                        <tr
                          key={firm.id}
                          className={`hover:bg-gray-50 cursor-pointer ${
                            selectedFirmIds.has(firm.id) ? 'bg-indigo-50/50' : ''
                          }`}
                          onClick={() => toggleFirm(firm.id)}
                        >
                          <td className="px-3 py-2">
                            {selectedFirmIds.has(firm.id) ? (
                              <CheckSquare className="w-4 h-4 text-indigo-600" />
                            ) : (
                              <Square className="w-4 h-4 text-gray-300" />
                            )}
                          </td>
                          <td className="px-3 py-2 font-medium text-gray-900">{firm.name}</td>
                          <td className="px-3 py-2 text-gray-600 font-mono text-xs">
                            <a
                              href={`https://${firm.domain}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-indigo-600 hover:text-indigo-800 hover:underline"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {firm.domain}
                            </a>
                          </td>
                          <td className="px-3 py-2 text-gray-500 text-xs">
                            {formatDate(firm.updated_at)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* Contacts Error */}
          {contactsError && (
            <div className="px-6 py-3 bg-red-50 border-b border-red-100 flex items-center gap-2 text-sm text-red-700">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {contactsError}
            </div>
          )}

          {/* Contacts Table */}
          {contacts.length > 0 && (
            <div className="px-6 py-4">
              {/* Contacts header + action bar */}
              <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
                  <Users className="w-4 h-4 text-gray-500" />
                  Contacts ({contacts.length})
                  {selectedContactKeys.size > 0 && selectedContactKeys.size < contacts.length && (
                    <span className="text-xs font-normal text-indigo-600">
                      ({selectedContactKeys.size} selected)
                    </span>
                  )}
                </h3>
                <div className="flex items-center gap-2">
                  {/* Skip existing toggle */}
                  <label className="inline-flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={skipExisting}
                      onChange={(e) => setSkipExisting(e.target.checked)}
                      disabled={processing}
                      className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                    />
                    Skip existing
                  </label>

                  {processing ? (
                    <button
                      type="button"
                      onClick={handleStop}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-red-600 hover:bg-red-700 transition-colors shadow-sm"
                    >
                      <StopCircle className="w-3.5 h-3.5" />
                      Stop
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={handleRunSelected}
                        disabled={selectedContactKeys.size === 0}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
                      >
                        <Play className="w-3.5 h-3.5" />
                        Run Selected ({selectedContactKeys.size})
                      </button>
                      <button
                        type="button"
                        onClick={handleRunAll}
                        disabled={contacts.length === 0}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
                      >
                        <Play className="w-3.5 h-3.5" />
                        Run All Filtered ({contacts.length})
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Processing Progress */}
              {contactResults.size > 0 && (
                <div className="mb-3">
                  <div className="flex items-center gap-3 text-xs text-gray-600 mb-2">
                    {runningCount > 0 && (
                      <span className="inline-flex items-center gap-1 text-indigo-600">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Running: {runningCount}
                      </span>
                    )}
                    <span className="inline-flex items-center gap-1 text-green-600">
                      <CheckCircle2 className="w-3 h-3" />
                      Done: {processedCount}
                    </span>
                    <span className="inline-flex items-center gap-1 text-amber-600">
                      <SkipForward className="w-3 h-3" />
                      Skipped: {skippedCount}
                    </span>
                    <span className="inline-flex items-center gap-1 text-red-600">
                      <XCircle className="w-3 h-3" />
                      Failed: {failedCount}
                    </span>
                    <span className="text-gray-400">
                      {totalProcessed} / {contactResults.size} total
                    </span>
                  </div>
                  {/* Progress bar */}
                  <div className="w-full bg-gray-200 rounded-full h-1.5">
                    <div
                      className="h-1.5 rounded-full bg-indigo-500 transition-all duration-300"
                      style={{
                        width: contactResults.size > 0
                          ? `${((totalProcessed + runningCount) / contactResults.size) * 100}%`
                          : '0%',
                      }}
                    />
                  </div>
                </div>
              )}

              {/* Contacts Table */}
              <div className="border border-gray-200 rounded-lg overflow-hidden">
                <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                  <table className="min-w-full divide-y divide-gray-200 text-sm">
                    <thead className="bg-gray-50 sticky top-0 z-10">
                      <tr>
                        <th className="px-3 py-2.5 text-left w-10">
                          <button
                            type="button"
                            onClick={toggleAllContacts}
                            disabled={processing}
                            className="text-gray-400 hover:text-gray-600 disabled:opacity-50"
                          >
                            {selectedContactKeys.size === contacts.length ? (
                              <CheckSquare className="w-4 h-4 text-indigo-600" />
                            ) : (
                              <Square className="w-4 h-4" />
                            )}
                          </button>
                        </th>
                        <th className="px-3 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Name
                        </th>
                        <th className="px-3 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          LinkedIn
                        </th>
                        <th className="px-3 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Email
                        </th>
                        <th className="px-3 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Firm
                        </th>
                        <th className="px-3 py-2.5 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Status
                        </th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-100">
                      {contacts.map((contact) => {
                        const result = contactResults.get(contact.key);
                        const status = result?.status;
                        return (
                          <tr
                            key={contact.key}
                            className={`hover:bg-gray-50 ${
                              selectedContactKeys.has(contact.key) ? 'bg-indigo-50/30' : ''
                            } ${status === 'running' ? 'bg-yellow-50/50' : ''}`}
                          >
                            <td className="px-3 py-2">
                              <button
                                type="button"
                                onClick={() => toggleContact(contact.key)}
                                disabled={processing}
                                className="disabled:opacity-50"
                              >
                                {selectedContactKeys.has(contact.key) ? (
                                  <CheckSquare className="w-4 h-4 text-indigo-600" />
                                ) : (
                                  <Square className="w-4 h-4 text-gray-300" />
                                )}
                              </button>
                            </td>
                            <td className="px-3 py-2 font-medium text-gray-900 text-xs">
                              {contact.full_name || '—'}
                              {contact.title && (
                                <span className="block text-[10px] text-gray-400 mt-0.5">{contact.title}</span>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              <a
                                href={contact.input}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-indigo-600 hover:text-indigo-800 hover:underline font-mono text-[11px]"
                              >
                                {contact.linkedin_url}
                              </a>
                            </td>
                            <td className="px-3 py-2 text-gray-600 text-xs">
                              {contact.email || '—'}
                            </td>
                            <td className="px-3 py-2 text-gray-600 text-xs">
                              {contact.firmName}
                            </td>
                            <td className="px-3 py-2 text-center">
                              <ContactStatusBadge status={status} message={result?.message} />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* Empty contacts result */}
          {!loadingContacts && contacts.length === 0 && firms.length > 0 && selectedFirmIds.size > 0 && contactResults.size === 0 && (
            <div className="px-6 py-6 text-center text-gray-400 text-sm">
              Select firms and click <span className="font-medium text-gray-600">&quot;Fetch Contacts&quot;</span> to
              find contacts to process.
            </div>
          )}

          {/* Empty state before fetching firms */}
          {!loadingFirms && firms.length === 0 && !firmsError && (
            <div className="px-6 py-12 text-center text-gray-400 text-sm">
              Set <span className="font-medium text-gray-600">updated_at</span> filters and click{' '}
              <span className="font-medium text-gray-600">&quot;Fetch Firms&quot;</span> to get started.
            </div>
          )}

          {/* Firms loaded but none matched */}
          {!loadingFirms && firms.length === 0 && !firmsError && updatedAtFrom && (
            <div className="px-6 py-6 text-center text-gray-400 text-sm">
              No firms found matching the filter criteria. Try adjusting the date range.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   Tool 3: Rerun Investor Profile (Step 3 Only)
   ───────────────────────────────────────────────────────────── */

interface InvestorRow {
  id: string;
  name: string;
  type: 'firm' | 'person';
  domain: string | null;
  linkedin_url: string | null;
  updated_at: string;
}

type ProfileStatus = 'pending' | 'running' | 'done' | 'failed';

interface ProfileResult {
  status: ProfileStatus;
  message?: string;
  fieldsUpdated?: number;
}

function RerunProfileTool() {
  const [expanded, setExpanded] = useState(false);

  // Filters
  const [typeFilter, setTypeFilter] = useState<'all' | 'firm' | 'person'>('all');
  const [updatedAtFrom, setUpdatedAtFrom] = useState('');
  const [updatedAtTo, setUpdatedAtTo] = useState('');

  // Investors
  const [investors, setInvestors] = useState<InvestorRow[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loadingInvestors, setLoadingInvestors] = useState(false);
  const [investorsError, setInvestorsError] = useState<string | null>(null);

  // Processing
  const [processing, setProcessing] = useState(false);
  const [results, setResults] = useState<Map<string, ProfileResult>>(new Map());
  const stopRef = useRef(false);

  const getAccessToken = useCallback(async (): Promise<string | null> => {
    const { data: sessionData } = await supabase.auth.getSession();
    return sessionData?.session?.access_token || null;
  }, []);

  // ── Fetch Investors ──
  const fetchInvestors = useCallback(async () => {
    setLoadingInvestors(true);
    setInvestorsError(null);
    setInvestors([]);
    setSelectedIds(new Set());
    setResults(new Map());

    try {
      const accessToken = await getAccessToken();
      if (!accessToken) {
        setInvestorsError('No active session. Please log in again.');
        return;
      }

      const body: Record<string, string> = {};
      if (typeFilter !== 'all') body.type = typeFilter;
      if (updatedAtFrom) body.updatedAtFrom = new Date(updatedAtFrom).toISOString();
      if (updatedAtTo) body.updatedAtTo = new Date(updatedAtTo).toISOString();

      const res = await fetch('/api/data-pipelines/rerun-profile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setInvestorsError(data?.error || `Request failed (${res.status})`);
        return;
      }

      const data = await res.json();
      setInvestors(data.investors || []);
    } catch (err) {
      setInvestorsError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoadingInvestors(false);
    }
  }, [typeFilter, updatedAtFrom, updatedAtTo, getAccessToken]);

  // ── Process Investors (Step 3 only) ──
  const processInvestors = useCallback(
    async (investorsToProcess: InvestorRow[]) => {
      if (investorsToProcess.length === 0) return;

      setProcessing(true);
      stopRef.current = false;

      const newResults = new Map(results);
      for (const inv of investorsToProcess) {
        newResults.set(inv.id, { status: 'pending' });
      }
      setResults(new Map(newResults));

      const BATCH_SIZE = 100;
      for (let i = 0; i < investorsToProcess.length; i += BATCH_SIZE) {
        if (stopRef.current) {
          console.log('[rerun-profile] Processing stopped by user');
          break;
        }

        const batch = investorsToProcess.slice(i, i + BATCH_SIZE);

        // Set all investors in this batch to running
        for (const inv of batch) {
          newResults.set(inv.id, { status: 'running' });
        }
        setResults(new Map(newResults));

        // Process batch in parallel
        await Promise.all(
          batch.map(async (inv) => {
            try {
              const accessToken = await getAccessToken();
              if (!accessToken) {
                newResults.set(inv.id, { status: 'failed', message: 'No session' });
                setResults(new Map(newResults));
                return;
              }

              const res = await fetch('/api/data-pipelines/rerun-profile/process', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${accessToken}`,
                },
                body: JSON.stringify({ investorId: inv.id }),
              });

              if (res.ok) {
                const data = await res.json();
                newResults.set(inv.id, {
                  status: 'done',
                  message: `${data.fieldsUpdated?.length || 0} fields updated`,
                  fieldsUpdated: data.fieldsUpdated?.length || 0,
                });
              } else {
                const errData = await res.json().catch(() => null);
                newResults.set(inv.id, {
                  status: 'failed',
                  message: errData?.error || `HTTP ${res.status}`,
                });
              }
            } catch (err) {
              newResults.set(inv.id, {
                status: 'failed',
                message: err instanceof Error ? err.message : 'Unknown error',
              });
            }

            setResults(new Map(newResults));
          })
        );
      }

      setProcessing(false);
    },
    [results, getAccessToken]
  );

  const handleRunSelected = useCallback(() => {
    const selected = investors.filter((inv) => selectedIds.has(inv.id));
    processInvestors(selected);
  }, [investors, selectedIds, processInvestors]);

  const handleRunAll = useCallback(() => {
    processInvestors(investors);
  }, [investors, processInvestors]);

  const handleStop = useCallback(() => {
    stopRef.current = true;
  }, []);

  // ── Selection helpers ──
  const toggleInvestor = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllInvestors = () => {
    if (selectedIds.size === investors.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(investors.map((inv) => inv.id)));
    }
  };

  // Stats
  const doneCount = Array.from(results.values()).filter((r) => r.status === 'done').length;
  const failedCount = Array.from(results.values()).filter((r) => r.status === 'failed').length;
  const runningCount = Array.from(results.values()).filter((r) => r.status === 'running').length;
  const totalProcessed = doneCount + failedCount;

  const formatDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return iso;
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
      {/* Tool Header */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-6 py-4 hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="p-1.5 bg-purple-50 rounded-lg">
            <UserSearch className="w-5 h-5 text-purple-600" />
          </div>
          <div className="text-left">
            <h2 className="text-base font-semibold text-gray-900">
              Tool 3: Rerun Investor Profile Extraction
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Re-extract structured profile data from existing deep research using LLM (Step 3 only)
            </p>
          </div>
        </div>
        {expanded ? (
          <ChevronUp className="w-5 h-5 text-gray-400" />
        ) : (
          <ChevronDown className="w-5 h-5 text-gray-400" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-gray-100">
          {/* Description & Filters */}
          <div className="px-6 py-4 bg-gray-50 border-b border-gray-100">
            <div className="text-sm text-gray-600 space-y-1 mb-4">
              <p>
                Find investors whose profile needs updating. This tool re-runs{' '}
                <span className="font-medium text-gray-800">Step 3 only</span> (LLM structured extraction)
                on the existing <span className="font-medium text-gray-800">deep_research</span> text
                &mdash; it does <em>not</em> re-run the full pipeline or deep search.
              </p>
              <p className="text-xs text-gray-500">
                Only investors with existing deep research are shown. Useful when the extraction prompt has
                been updated and you want to re-process existing data.
              </p>
            </div>

            {/* Filters */}
            <div className="flex flex-wrap items-end gap-4">
              {/* Type filter */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  <Building2 className="w-3 h-3 inline mr-1" />
                  Type
                </label>
                <select
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value as 'all' | 'firm' | 'person')}
                  disabled={loadingInvestors || processing}
                  className="block w-full px-3 py-1.5 text-sm border border-gray-300 rounded-lg bg-white focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                >
                  <option value="all">All Types</option>
                  <option value="firm">Firm</option>
                  <option value="person">Person</option>
                </select>
              </div>

              {/* Date Filters */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  <Calendar className="w-3 h-3 inline mr-1" />
                  Updated At From
                </label>
                <input
                  type="datetime-local"
                  value={updatedAtFrom}
                  onChange={(e) => setUpdatedAtFrom(e.target.value)}
                  className="block w-full px-3 py-1.5 text-sm border border-gray-300 rounded-lg bg-white focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  disabled={loadingInvestors || processing}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  <Calendar className="w-3 h-3 inline mr-1" />
                  Updated At To
                </label>
                <input
                  type="datetime-local"
                  value={updatedAtTo}
                  onChange={(e) => setUpdatedAtTo(e.target.value)}
                  className="block w-full px-3 py-1.5 text-sm border border-gray-300 rounded-lg bg-white focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  disabled={loadingInvestors || processing}
                />
              </div>

              <button
                type="button"
                onClick={fetchInvestors}
                disabled={loadingInvestors || processing}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white bg-purple-600 hover:bg-purple-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors shadow-sm"
              >
                {loadingInvestors ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Fetching...
                  </>
                ) : (
                  <>
                    <Search className="w-4 h-4" />
                    Fetch Investors
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Error */}
          {investorsError && (
            <div className="px-6 py-3 bg-red-50 border-b border-red-100 flex items-center gap-2 text-sm text-red-700">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {investorsError}
            </div>
          )}

          {/* Investors Table */}
          {investors.length > 0 && (
            <div className="px-6 py-4">
              {/* Header + Action bar */}
              <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
                  <Users className="w-4 h-4 text-gray-500" />
                  Investors ({investors.length})
                  {selectedIds.size > 0 && selectedIds.size < investors.length && (
                    <span className="text-xs font-normal text-purple-600">
                      ({selectedIds.size} selected)
                    </span>
                  )}
                </h3>
                <div className="flex items-center gap-2">
                  {processing ? (
                    <button
                      type="button"
                      onClick={handleStop}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-red-600 hover:bg-red-700 transition-colors shadow-sm"
                    >
                      <StopCircle className="w-3.5 h-3.5" />
                      Stop
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={handleRunSelected}
                        disabled={selectedIds.size === 0}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-purple-600 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
                      >
                        <Play className="w-3.5 h-3.5" />
                        Run Selected ({selectedIds.size})
                      </button>
                      <button
                        type="button"
                        onClick={handleRunAll}
                        disabled={investors.length === 0}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
                      >
                        <Play className="w-3.5 h-3.5" />
                        Run All ({investors.length})
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Processing Progress */}
              {results.size > 0 && (
                <div className="mb-3">
                  <div className="flex items-center gap-3 text-xs text-gray-600 mb-2">
                    {runningCount > 0 && (
                      <span className="inline-flex items-center gap-1 text-purple-600">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Running: {runningCount}
                      </span>
                    )}
                    <span className="inline-flex items-center gap-1 text-green-600">
                      <CheckCircle2 className="w-3 h-3" />
                      Done: {doneCount}
                    </span>
                    <span className="inline-flex items-center gap-1 text-red-600">
                      <XCircle className="w-3 h-3" />
                      Failed: {failedCount}
                    </span>
                    <span className="text-gray-400">
                      {totalProcessed} / {results.size} total
                    </span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-1.5">
                    <div
                      className="h-1.5 rounded-full bg-purple-500 transition-all duration-300"
                      style={{
                        width: results.size > 0
                          ? `${((totalProcessed + runningCount) / results.size) * 100}%`
                          : '0%',
                      }}
                    />
                  </div>
                </div>
              )}

              {/* Table */}
              <div className="border border-gray-200 rounded-lg overflow-hidden">
                <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                  <table className="min-w-full divide-y divide-gray-200 text-sm">
                    <thead className="bg-gray-50 sticky top-0 z-10">
                      <tr>
                        <th className="px-3 py-2.5 text-left w-10">
                          <button
                            type="button"
                            onClick={toggleAllInvestors}
                            disabled={processing}
                            className="text-gray-400 hover:text-gray-600 disabled:opacity-50"
                          >
                            {selectedIds.size === investors.length ? (
                              <CheckSquare className="w-4 h-4 text-purple-600" />
                            ) : (
                              <Square className="w-4 h-4" />
                            )}
                          </button>
                        </th>
                        <th className="px-3 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Name
                        </th>
                        <th className="px-3 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Type
                        </th>
                        <th className="px-3 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Domain / LinkedIn
                        </th>
                        <th className="px-3 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Updated At
                        </th>
                        <th className="px-3 py-2.5 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Status
                        </th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-100">
                      {investors.map((inv) => {
                        const result = results.get(inv.id);
                        const status = result?.status;
                        return (
                          <tr
                            key={inv.id}
                            className={`hover:bg-gray-50 cursor-pointer ${
                              selectedIds.has(inv.id) ? 'bg-purple-50/30' : ''
                            } ${status === 'running' ? 'bg-yellow-50/50' : ''}`}
                            onClick={() => !processing && toggleInvestor(inv.id)}
                          >
                            <td className="px-3 py-2">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleInvestor(inv.id);
                                }}
                                disabled={processing}
                                className="disabled:opacity-50"
                              >
                                {selectedIds.has(inv.id) ? (
                                  <CheckSquare className="w-4 h-4 text-purple-600" />
                                ) : (
                                  <Square className="w-4 h-4 text-gray-300" />
                                )}
                              </button>
                            </td>
                            <td className="px-3 py-2 font-medium text-gray-900 text-xs">
                              {inv.name || '—'}
                            </td>
                            <td className="px-3 py-2">
                              {inv.type === 'firm' ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700">
                                  <Building2 className="w-3 h-3" />
                                  Firm
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700">
                                  <Users className="w-3 h-3" />
                                  Person
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-gray-600 font-mono text-[11px]">
                              {inv.domain ? (
                                <a
                                  href={`https://${inv.domain}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-indigo-600 hover:text-indigo-800 hover:underline"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {inv.domain}
                                </a>
                              ) : inv.linkedin_url ? (
                                <a
                                  href={`https://www.linkedin.com/${inv.linkedin_url}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-indigo-600 hover:text-indigo-800 hover:underline"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {inv.linkedin_url}
                                </a>
                              ) : (
                                <span className="text-gray-300">—</span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-gray-500 text-xs">
                              {formatDate(inv.updated_at)}
                            </td>
                            <td className="px-3 py-2 text-center">
                              <ProfileStatusBadge status={status} message={result?.message} />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* Empty state before fetching */}
          {!loadingInvestors && investors.length === 0 && !investorsError && (
            <div className="px-6 py-12 text-center text-gray-400 text-sm">
              Set filters and click <span className="font-medium text-gray-600">&quot;Fetch Investors&quot;</span> to
              find investors with existing deep research.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProfileStatusBadge({ status, message }: { status?: ProfileStatus; message?: string }) {
  if (!status) return <span className="text-gray-300 text-xs">—</span>;

  const config: Record<ProfileStatus, { bg: string; text: string; icon: React.ReactNode; label: string }> = {
    pending: {
      bg: 'bg-gray-100',
      text: 'text-gray-500',
      icon: <Square className="w-3 h-3" />,
      label: 'Pending',
    },
    running: {
      bg: 'bg-yellow-50',
      text: 'text-yellow-700',
      icon: <Loader2 className="w-3 h-3 animate-spin" />,
      label: 'Running',
    },
    done: {
      bg: 'bg-green-50',
      text: 'text-green-700',
      icon: <CheckCircle2 className="w-3 h-3" />,
      label: 'Done',
    },
    failed: {
      bg: 'bg-red-50',
      text: 'text-red-700',
      icon: <XCircle className="w-3 h-3" />,
      label: 'Failed',
    },
  };

  const c = config[status];
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${c.bg} ${c.text}`}
      title={message || c.label}
    >
      {c.icon}
      {c.label}
    </span>
  );
}

function ContactStatusBadge({ status, message }: { status?: ContactStatus; message?: string }) {
  if (!status) return <span className="text-gray-300 text-xs">—</span>;

  const config: Record<ContactStatus, { bg: string; text: string; icon: React.ReactNode; label: string }> = {
    pending: {
      bg: 'bg-gray-100',
      text: 'text-gray-500',
      icon: <Square className="w-3 h-3" />,
      label: 'Pending',
    },
    running: {
      bg: 'bg-yellow-50',
      text: 'text-yellow-700',
      icon: <Loader2 className="w-3 h-3 animate-spin" />,
      label: 'Running',
    },
    done: {
      bg: 'bg-green-50',
      text: 'text-green-700',
      icon: <CheckCircle2 className="w-3 h-3" />,
      label: 'Done',
    },
    skipped: {
      bg: 'bg-amber-50',
      text: 'text-amber-700',
      icon: <SkipForward className="w-3 h-3" />,
      label: 'Skipped',
    },
    failed: {
      bg: 'bg-red-50',
      text: 'text-red-700',
      icon: <XCircle className="w-3 h-3" />,
      label: 'Failed',
    },
  };

  const c = config[status];
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${c.bg} ${c.text}`}
      title={message || c.label}
    >
      {c.icon}
      {c.label}
    </span>
  );
}

/* ─────────────────────────────────────────────────────────────
   Tool 4: Unverified Emails Export
   ───────────────────────────────────────────────────────────── */

interface UnverifiedEmailInvestor {
  id: string;
  name: string | null;
  linkedin_url: string | null;
  email: string | null;
  email_verified: boolean | null;
  firm_domain: string | null;
}

interface UnverifiedEmailRow {
  id: string;
  name: string;
  first_name: string;
  last_name: string;
  linkedin_url: string;
  email: string;
  email_verified: string;
  firm_domain: string;
}

function UnverifiedEmailsTool() {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [investors, setInvestors] = useState<UnverifiedEmailInvestor[]>([]);
  const [csvRows, setCsvRows] = useState<UnverifiedEmailRow[]>([]);

  const runPipeline = useCallback(async () => {
    setLoading(true);
    setError(null);
    setInvestors([]);
    setCsvRows([]);

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      if (!accessToken) {
        setError('No active session. Please log in again.');
        return;
      }

      const res = await fetch('/api/data-pipelines/unverified-emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error || `Request failed (${res.status})`);
        return;
      }

      const data = await res.json();
      const fetched: UnverifiedEmailInvestor[] = data.investors || [];
      setInvestors(fetched);

      // Build exploded CSV rows: one row per email, or one row with empty email if missing
      const rows: UnverifiedEmailRow[] = [];
      for (const inv of fetched) {
        const rawLinkedin = inv.linkedin_url || '';
        const linkedinVal = rawLinkedin
          ? rawLinkedin.startsWith('http')
            ? rawLinkedin
            : `https://www.linkedin.com/${rawLinkedin.replace(/^\/+/, '')}`
          : '';
        const verifiedVal = inv.email_verified === true ? 'verified' : 'unverified';
        const fullName = inv.name || '';
        const nameParts = fullName.trim().split(/\s+/);
        const firstName = nameParts[0] || '';
        const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';
        const firmDomain = inv.firm_domain || '';

        if (!inv.email || inv.email.trim() === '') {
          // Missing email — add a row with empty email and "missing" status
          rows.push({
            id: inv.id,
            name: fullName,
            first_name: firstName,
            last_name: lastName,
            linkedin_url: linkedinVal,
            email: '',
            email_verified: 'missing',
            firm_domain: firmDomain,
          });
        } else {
          // Split comma/semicolon separated emails into individual rows
          const emails = inv.email.split(/[,;]\s*/).map((e) => e.trim()).filter(Boolean);
          if (emails.length === 0) {
            rows.push({
              id: inv.id,
              name: fullName,
              first_name: firstName,
              last_name: lastName,
              linkedin_url: linkedinVal,
              email: '',
              email_verified: 'missing',
              firm_domain: firmDomain,
            });
          } else {
            for (const email of emails) {
              rows.push({
                id: inv.id,
                name: fullName,
                first_name: firstName,
                last_name: lastName,
                linkedin_url: linkedinVal,
                email,
                email_verified: verifiedVal,
                firm_domain: firmDomain,
              });
            }
          }
        }
      }

      setCsvRows(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  const downloadCSV = useCallback(() => {
    if (!csvRows.length) return;

    const headers = ['investor_id', 'name', 'first_name', 'last_name', 'firm_domain', 'linkedin_url', 'email', 'email_verified'];
    const rows = csvRows.map((r) => [r.id, r.name, r.first_name, r.last_name, r.firm_domain, r.linkedin_url, r.email, r.email_verified]);

    const csvContent = [headers, ...rows]
      .map((row) =>
        row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(',')
      )
      .join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `unverified-emails-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [csvRows]);

  const missingEmailCount = csvRows.filter((r) => r.email_verified === 'missing').length;
  const unverifiedCount = csvRows.filter((r) => r.email_verified !== 'missing').length;

  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
      {/* Tool Header */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-6 py-4 hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="p-1.5 bg-red-50 rounded-lg">
            <MailX className="w-5 h-5 text-red-600" />
          </div>
          <div className="text-left">
            <h2 className="text-base font-semibold text-gray-900">
              Tool 4: Unverified Emails Export
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Find all person-type investors with unverified or missing emails and export as CSV
            </p>
          </div>
        </div>
        {expanded ? (
          <ChevronUp className="w-5 h-5 text-gray-400" />
        ) : (
          <ChevronDown className="w-5 h-5 text-gray-400" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-gray-100">
          {/* Description & Run */}
          <div className="px-6 py-4 bg-gray-50 border-b border-gray-100">
            <div className="flex items-start justify-between gap-4">
              <div className="text-sm text-gray-600 space-y-1">
                <p>
                  This pipeline finds all investors of type{' '}
                  <span className="font-medium text-gray-800">person</span> whose{' '}
                  <span className="font-medium text-gray-800">email_verified</span> is{' '}
                  <span className="font-medium text-gray-800">false</span> or{' '}
                  <span className="font-medium text-gray-800">null</span>.
                </p>
                <p className="text-xs text-gray-500">
                  Exports a CSV with one row per email. Comma-separated emails are split into separate rows
                  sharing the same investor ID, LinkedIn URL, and verification status.
                  Investors with no email get a row marked as &quot;missing&quot;.
                </p>
              </div>
              <button
                type="button"
                onClick={runPipeline}
                disabled={loading}
                className="flex-shrink-0 inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors shadow-sm"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Running...
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4" />
                    Run Pipeline
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="px-6 py-3 bg-red-50 border-b border-red-100 flex items-center gap-2 text-sm text-red-700">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {error}
            </div>
          )}

          {/* Results */}
          {investors.length > 0 && (
            <div className="px-6 py-4 space-y-4">
              {/* Summary Stats */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatCard label="Unverified Investors" value={investors.length} />
                <StatCard label="Total CSV Rows" value={csvRows.length} />
                <StatCard
                  label="With Emails (unverified)"
                  value={unverifiedCount}
                  color="orange"
                />
                <StatCard
                  label="Missing Email"
                  value={missingEmailCount}
                  color={missingEmailCount > 0 ? 'orange' : 'green'}
                />
              </div>

              {/* Download CSV */}
              <div className="flex items-center justify-end pt-2">
                <button
                  type="button"
                  onClick={downloadCSV}
                  disabled={csvRows.length === 0}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-green-600 hover:bg-green-700 disabled:opacity-50 transition-colors shadow-sm"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download CSV ({csvRows.length} rows)
                </button>
              </div>

              {/* Results Table (preview first 100 rows) */}
              <div className="border border-gray-200 rounded-lg overflow-hidden">
                <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                  <table className="min-w-full divide-y divide-gray-200 text-sm">
                    <thead className="bg-gray-50 sticky top-0 z-10">
                      <tr>
                        <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          #
                        </th>
                        <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Investor ID
                        </th>
                        <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Name
                        </th>
                        <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Firm Domain
                        </th>
                        <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          LinkedIn
                        </th>
                        <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Email
                        </th>
                        <th className="px-4 py-2.5 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Status
                        </th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-100">
                      {csvRows.slice(0, 100).map((row, idx) => (
                        <tr key={`${row.id}-${row.email}-${idx}`} className="hover:bg-gray-50">
                          <td className="px-4 py-2 text-gray-400 text-xs">
                            {idx + 1}
                          </td>
                          <td className="px-4 py-2 text-gray-700 font-mono text-[11px]">
                            {row.id.slice(0, 8)}...
                          </td>
                          <td className="px-4 py-2 text-gray-900 text-xs font-medium">
                            {row.name || <span className="text-gray-300">—</span>}
                          </td>
                          <td className="px-4 py-2 text-gray-600 font-mono text-[11px]">
                            {row.firm_domain ? (
                              <a
                                href={`https://${row.firm_domain}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-indigo-600 hover:text-indigo-800 hover:underline"
                              >
                                {row.firm_domain}
                              </a>
                            ) : (
                              <span className="text-gray-300">—</span>
                            )}
                          </td>
                          <td className="px-4 py-2">
                            {row.linkedin_url ? (
                              <a
                                href={
                                  row.linkedin_url.startsWith('http')
                                    ? row.linkedin_url
                                    : `https://www.linkedin.com/${row.linkedin_url}`
                                }
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-indigo-600 hover:text-indigo-800 hover:underline font-mono text-[11px]"
                              >
                                {row.linkedin_url}
                              </a>
                            ) : (
                              <span className="text-gray-300">—</span>
                            )}
                          </td>
                          <td className="px-4 py-2 text-gray-600 text-xs">
                            {row.email || <span className="text-gray-300">—</span>}
                          </td>
                          <td className="px-4 py-2 text-center">
                            {row.email_verified === 'missing' ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-gray-100 text-gray-500">
                                <XCircle className="w-3 h-3" />
                                Missing
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-orange-50 text-orange-700">
                                <AlertCircle className="w-3 h-3" />
                                Unverified
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {csvRows.length > 100 && (
                  <div className="px-4 py-2 bg-gray-50 border-t border-gray-100 text-xs text-gray-500 text-center">
                    Showing first 100 of {csvRows.length} rows. Download CSV for the complete data.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Empty state before run */}
          {investors.length === 0 && !loading && !error && (
            <div className="px-6 py-12 text-center text-gray-400 text-sm">
              Click <span className="font-medium text-gray-600">&quot;Run Pipeline&quot;</span> to find all person-type investors with unverified emails.
            </div>
          )}

          {/* Loading state */}
          {loading && investors.length === 0 && (
            <div className="px-6 py-12 flex flex-col items-center gap-3 text-gray-500">
              <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
              <p className="text-sm">Fetching investors with unverified emails...</p>
              <p className="text-xs text-gray-400">Querying all person-type investors where email_verified is false or null.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   Tool 5: Update Verified Emails from CSV
   ───────────────────────────────────────────────────────────── */

interface GroupedUpdate {
  investorId: string;
  emails: string[];
}

type UpdateStatus = 'idle' | 'uploading' | 'running' | 'done';

function UpdateVerifiedEmailsTool() {
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<UpdateStatus>('idle');
  const [grouped, setGrouped] = useState<GroupedUpdate[]>([]);
  const [totalCsvRows, setTotalCsvRows] = useState(0);
  const [skippedRows, setSkippedRows] = useState(0);
  const [updateResult, setUpdateResult] = useState<{ total: number; succeeded: number; failed: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Parse CSV text
  const parseCSV = useCallback((text: string) => {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) {
      setError('CSV must have a header row and at least one data row.');
      return;
    }

    // Parse header to find column indices
    const headerLine = lines[0];
    const headers = parseCSVLine(headerLine).map((h) => h.trim().toLowerCase());

    const idIdx = headers.findIndex((h) => h === 'investor_id' || h === 'id');
    const emailIdx = headers.findIndex((h) => h === 'email');
    const verifiedIdx = headers.findIndex((h) => h === 'email_verified');

    if (idIdx === -1) {
      setError('CSV must have an "investor_id" or "id" column.');
      return;
    }
    if (emailIdx === -1) {
      setError('CSV must have an "email" column.');
      return;
    }
    if (verifiedIdx === -1) {
      setError('CSV must have an "email_verified" column.');
      return;
    }

    // Parse rows, filter only email_verified === 'true'
    const dataLines = lines.slice(1);
    setTotalCsvRows(dataLines.length);
    let skipped = 0;

    // Group emails by investor ID
    const emailMap = new Map<string, Set<string>>();

    for (const line of dataLines) {
      if (!line.trim()) continue;
      const cols = parseCSVLine(line);
      const investorId = (cols[idIdx] || '').trim();
      const email = (cols[emailIdx] || '').trim();
      const verified = (cols[verifiedIdx] || '').trim().toLowerCase();

      if (!investorId) {
        skipped++;
        continue;
      }

      if (verified !== 'true') {
        skipped++;
        continue;
      }

      if (!emailMap.has(investorId)) {
        emailMap.set(investorId, new Set());
      }

      // email may itself be comma-separated within the cell
      if (email) {
        const parts = email.split(/[,;]\s*/).map((e) => e.trim()).filter(Boolean);
        for (const part of parts) {
          emailMap.get(investorId)!.add(part);
        }
      }
    }

    setSkippedRows(skipped);

    const updates: GroupedUpdate[] = [];
    for (const [investorId, emailSet] of emailMap) {
      updates.push({ investorId, emails: Array.from(emailSet) });
    }

    setGrouped(updates);
  }, []);

  const handleFileUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setError(null);
      setGrouped([]);
      setUpdateResult(null);
      setTotalCsvRows(0);
      setSkippedRows(0);

      const file = e.target.files?.[0];
      if (!file) return;

      if (!file.name.endsWith('.csv')) {
        setError('Please upload a .csv file.');
        return;
      }

      setStatus('uploading');
      const reader = new FileReader();
      reader.onload = (event) => {
        const text = event.target?.result as string;
        parseCSV(text);
        setStatus('idle');
      };
      reader.onerror = () => {
        setError('Failed to read the file.');
        setStatus('idle');
      };
      reader.readAsText(file);
    },
    [parseCSV]
  );

  const runUpdate = useCallback(async () => {
    if (grouped.length === 0) return;

    setStatus('running');
    setError(null);
    setUpdateResult(null);

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      if (!accessToken) {
        setError('No active session. Please log in again.');
        setStatus('idle');
        return;
      }

      const res = await fetch('/api/data-pipelines/update-verified-emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ updates: grouped }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error || `Request failed (${res.status})`);
        setStatus('idle');
        return;
      }

      const data = await res.json();
      setUpdateResult({ total: data.total, succeeded: data.succeeded, failed: data.failed });
      setStatus('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setStatus('idle');
    }
  }, [grouped]);

  const reset = useCallback(() => {
    setError(null);
    setGrouped([]);
    setUpdateResult(null);
    setTotalCsvRows(0);
    setSkippedRows(0);
    setStatus('idle');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
      {/* Tool Header */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-6 py-4 hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="p-1.5 bg-green-50 rounded-lg">
            <MailCheck className="w-5 h-5 text-green-600" />
          </div>
          <div className="text-left">
            <h2 className="text-base font-semibold text-gray-900">
              Tool 5: Update Verified Emails from CSV
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Upload a CSV with verified emails to bulk-update investor email and email_verified fields
            </p>
          </div>
        </div>
        {expanded ? (
          <ChevronUp className="w-5 h-5 text-gray-400" />
        ) : (
          <ChevronDown className="w-5 h-5 text-gray-400" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-gray-100">
          {/* Description */}
          <div className="px-6 py-4 bg-gray-50 border-b border-gray-100">
            <div className="text-sm text-gray-600 space-y-1">
              <p>
                Upload a CSV containing columns{' '}
                <span className="font-mono text-xs bg-gray-100 px-1.5 py-0.5 rounded">investor_id</span>,{' '}
                <span className="font-mono text-xs bg-gray-100 px-1.5 py-0.5 rounded">email</span>, and{' '}
                <span className="font-mono text-xs bg-gray-100 px-1.5 py-0.5 rounded">email_verified</span>.
                Other columns are ignored.
              </p>
              <p className="text-xs text-gray-500">
                Only rows where <span className="font-medium text-gray-700">email_verified</span> is{' '}
                <span className="font-medium text-gray-700">true</span> are processed.
                Rows are grouped by investor ID &mdash; all emails for the same investor are merged as comma-separated
                and the investor&apos;s <span className="font-medium text-gray-700">email</span> and{' '}
                <span className="font-medium text-gray-700">email_verified = true</span> are saved to the database.
              </p>
            </div>
          </div>

          <div className="px-6 py-4 space-y-4">
            {/* File Upload */}
            <div className="flex items-center gap-4">
              <label
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border-2 border-dashed cursor-pointer transition-colors ${
                  status === 'running'
                    ? 'border-gray-200 text-gray-400 cursor-not-allowed'
                    : 'border-gray-300 text-gray-600 hover:border-indigo-400 hover:text-indigo-600 hover:bg-indigo-50/30'
                }`}
              >
                <FileUp className="w-4 h-4" />
                {grouped.length > 0 ? 'Replace CSV' : 'Choose CSV File'}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv"
                  onChange={handleFileUpload}
                  disabled={status === 'running'}
                  className="hidden"
                />
              </label>

              {grouped.length > 0 && status !== 'done' && (
                <button
                  type="button"
                  onClick={runUpdate}
                  disabled={status === 'running'}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors shadow-sm"
                >
                  {status === 'running' ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Updating...
                    </>
                  ) : (
                    <>
                      <Upload className="w-4 h-4" />
                      Update {grouped.length} Investors
                    </>
                  )}
                </button>
              )}

              {(grouped.length > 0 || updateResult) && status !== 'running' && (
                <button
                  type="button"
                  onClick={reset}
                  className="text-xs text-gray-500 hover:text-gray-700 underline"
                >
                  Reset
                </button>
              )}
            </div>

            {/* Error */}
            {error && (
              <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-red-50 text-red-700 text-sm">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                {error}
              </div>
            )}

            {/* Parse Summary */}
            {grouped.length > 0 && !updateResult && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <StatCard label="Total CSV Rows" value={totalCsvRows} />
                  <StatCard label="Skipped (not verified)" value={skippedRows} color="orange" />
                  <StatCard label="Unique Investors" value={grouped.length} color="green" />
                  <StatCard
                    label="Total Emails"
                    value={grouped.reduce((sum, g) => sum + g.emails.length, 0)}
                  />
                </div>

                {/* Preview Table */}
                <div className="border border-gray-200 rounded-lg overflow-hidden">
                  <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
                    <table className="min-w-full divide-y divide-gray-200 text-sm">
                      <thead className="bg-gray-50 sticky top-0 z-10">
                        <tr>
                          <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            #
                          </th>
                          <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Investor ID
                          </th>
                          <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Emails (merged)
                          </th>
                          <th className="px-4 py-2.5 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Count
                          </th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-100">
                        {grouped.slice(0, 100).map((g, idx) => (
                          <tr key={g.investorId} className="hover:bg-gray-50">
                            <td className="px-4 py-2 text-gray-400 text-xs">{idx + 1}</td>
                            <td className="px-4 py-2 text-gray-700 font-mono text-[11px]">
                              {g.investorId.slice(0, 8)}...
                            </td>
                            <td className="px-4 py-2 text-gray-600 text-xs max-w-[400px]">
                              <span className="block truncate" title={g.emails.join(', ')}>
                                {g.emails.join(', ')}
                              </span>
                            </td>
                            <td className="px-4 py-2 text-center">
                              <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-green-50 text-green-700 text-xs font-medium">
                                {g.emails.length}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {grouped.length > 100 && (
                    <div className="px-4 py-2 bg-gray-50 border-t border-gray-100 text-xs text-gray-500 text-center">
                      Showing first 100 of {grouped.length} investors.
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Update Result */}
            {updateResult && (
              <div className="space-y-3">
                <div className="grid grid-cols-3 gap-3">
                  <StatCard label="Total" value={updateResult.total} />
                  <StatCard label="Succeeded" value={updateResult.succeeded} color="green" />
                  <StatCard
                    label="Failed"
                    value={updateResult.failed}
                    color={updateResult.failed > 0 ? 'orange' : 'green'}
                  />
                </div>
                {updateResult.failed === 0 && (
                  <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-green-50 text-green-700 text-sm">
                    <CheckCircle2 className="w-5 h-5" />
                    All {updateResult.succeeded} investors updated successfully with verified emails.
                  </div>
                )}
                {updateResult.failed > 0 && (
                  <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-amber-50 text-amber-700 text-sm">
                    <AlertCircle className="w-5 h-5" />
                    {updateResult.succeeded} succeeded, {updateResult.failed} failed. Check console for details.
                  </div>
                )}
              </div>
            )}

            {/* Empty state */}
            {grouped.length === 0 && !error && !updateResult && status === 'idle' && (
              <div className="py-8 text-center text-gray-400 text-sm">
                Upload a CSV file to preview and apply verified email updates.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   Tool 6: Not An Investor Viewer
   ───────────────────────────────────────────────────────────── */

interface NotAnInvestorRow {
  id: string;
  domain: string | null;
  linkedin_url: string | null;
  status: string | null;
}

interface NotAnInvestorSummary {
  totalCount: number;
  notInvestorCount: number;
  errorCount: number;
  errorCounts: Record<string, number>;
}

type StatusFilter = 'all' | 'not-investor' | string;

const ERROR_STATUS_LABELS: Record<string, string> = {
  'exa-api-error': 'Exa API Error',
  'exa-no-results': 'Exa No Results',
  'db-update-error': 'DB Update Error',
  'db-insert-error': 'DB Insert Error',
  'deep-search-error': 'Deep Search Error',
  'deep-search-invalid-response': 'Deep Search Invalid',
  'extraction-error': 'Extraction Error',
  'db-final-update-error': 'DB Final Update Error',
  'unexpected-error': 'Unexpected Error',
};

function NotAnInvestorTool() {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<NotAnInvestorRow[]>([]);
  const [summary, setSummary] = useState<NotAnInvestorSummary | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());

  const fetchData = useCallback(async (filter: StatusFilter) => {
    setLoading(true);
    setError(null);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      if (!accessToken) {
        setError('No active session. Please log in again.');
        return;
      }

      const res = await fetch('/api/data-pipelines/not-an-investor', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ statusFilter: filter }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error || `Request failed (${res.status})`);
        return;
      }

      const data = await res.json();
      setRows(data.rows || []);
      setSummary(data.summary || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleFilterChange = useCallback((filter: StatusFilter) => {
    setStatusFilter(filter);
    fetchData(filter);
  }, [fetchData]);

  const handleDelete = useCallback(async (id: string) => {
    setDeletingIds((prev) => new Set(prev).add(id));
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      if (!accessToken) return;

      // Use supabase client directly with service role via API isn't possible from client,
      // so we delete via the client supabase (RLS must allow or use service role endpoint).
      // For simplicity, remove from local state and delete via supabase client.
      const { error: delError } = await supabase.from('not_an_investor').delete().eq('id', id);
      if (delError) {
        console.error('Delete error:', delError.message);
        return;
      }
      setRows((prev) => prev.filter((r) => r.id !== id));
      // Update summary counts
      setSummary((prev) => {
        if (!prev) return prev;
        const deletedRow = rows.find((r) => r.id === id);
        if (!deletedRow) return prev;
        const newTotal = prev.totalCount - 1;
        if (!deletedRow.status) {
          return { ...prev, totalCount: newTotal, notInvestorCount: prev.notInvestorCount - 1 };
        }
        const newErrorCounts = { ...prev.errorCounts };
        if (deletedRow.status && newErrorCounts[deletedRow.status]) {
          newErrorCounts[deletedRow.status]--;
          if (newErrorCounts[deletedRow.status] <= 0) delete newErrorCounts[deletedRow.status];
        }
        return { ...prev, totalCount: newTotal, errorCount: prev.errorCount - 1, errorCounts: newErrorCounts };
      });
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, [rows]);

  // Filter rows by search query (domain or linkedin_url)
  const filteredRows = searchQuery
    ? rows.filter(
        (r) =>
          (r.domain && r.domain.toLowerCase().includes(searchQuery.toLowerCase())) ||
          (r.linkedin_url && r.linkedin_url.toLowerCase().includes(searchQuery.toLowerCase()))
      )
    : rows;

  // Collect all unique error statuses from summary for the dropdown
  const errorStatuses = summary
    ? Object.keys(summary.errorCounts).sort()
    : [];

  const downloadCSV = useCallback(() => {
    if (!filteredRows.length) return;
    const headers = ['ID', 'Domain', 'LinkedIn URL', 'Status'];
    const csvRows = filteredRows.map((r) => [
      r.id,
      r.domain || '',
      r.linkedin_url ? `https://www.linkedin.com/${r.linkedin_url}` : '',
      r.status || 'not-an-investor',
    ]);
    const csvContent = [headers, ...csvRows]
      .map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `not-an-investor-${statusFilter}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [filteredRows, statusFilter]);

  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
      {/* Tool Header */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-6 py-4 hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="p-1.5 bg-red-50 rounded-lg">
            <ShieldOff className="w-5 h-5 text-red-600" />
          </div>
          <div className="text-left">
            <h2 className="text-base font-semibold text-gray-900">
              Tool 6: Not An Investor Viewer
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              View entries flagged as &quot;not an investor&quot; or that errored during research
            </p>
          </div>
        </div>
        {expanded ? (
          <ChevronUp className="w-5 h-5 text-gray-400" />
        ) : (
          <ChevronDown className="w-5 h-5 text-gray-400" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-gray-100">
          {/* Description & Fetch */}
          <div className="px-6 py-4 bg-gray-50 border-b border-gray-100">
            <div className="flex items-start justify-between gap-4">
              <div className="text-sm text-gray-600 space-y-1">
                <p>
                  Browse all entries in the{' '}
                  <span className="font-medium text-gray-800">not_an_investor</span> table.
                  Entries with <span className="font-medium text-gray-800">no status</span> were
                  classified as not investors. Entries with a{' '}
                  <span className="font-medium text-gray-800">status value</span> had errors during
                  the research pipeline.
                </p>
                <p className="text-xs text-gray-500">
                  Use the filter to narrow by classification or specific error type.
                  Delete rows to allow re-processing.
                </p>
              </div>
              <button
                type="button"
                onClick={() => fetchData(statusFilter)}
                disabled={loading}
                className="flex-shrink-0 inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors shadow-sm"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading...
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-4 h-4" />
                    Fetch Data
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="px-6 py-3 bg-red-50 border-b border-red-100 flex items-center gap-2 text-sm text-red-700">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {error}
            </div>
          )}

          {/* Results */}
          {summary && (
            <div className="px-6 py-4 space-y-4">
              {/* Summary Stats */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatCard label="Total Rows" value={summary.totalCount} />
                <StatCard
                  label="Not Investors"
                  value={summary.notInvestorCount}
                  color={summary.notInvestorCount > 0 ? 'orange' : 'green'}
                />
                <StatCard
                  label="Errors"
                  value={summary.errorCount}
                  color={summary.errorCount > 0 ? 'orange' : 'green'}
                />
                <StatCard
                  label="Filtered Results"
                  value={filteredRows.length}
                />
              </div>

              {/* Filters Bar */}
              <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
                <div className="flex items-center gap-2 flex-wrap">
                  {/* Status filter tabs */}
                  <div className="inline-flex rounded-lg border border-gray-200 bg-white overflow-hidden text-xs">
                    <button
                      type="button"
                      onClick={() => handleFilterChange('all')}
                      className={`px-3 py-1.5 font-medium transition-colors ${
                        statusFilter === 'all'
                          ? 'bg-indigo-50 text-indigo-700'
                          : 'text-gray-600 hover:bg-gray-50'
                      }`}
                    >
                      All ({summary.totalCount})
                    </button>
                    <button
                      type="button"
                      onClick={() => handleFilterChange('not-investor')}
                      className={`px-3 py-1.5 font-medium transition-colors border-l border-gray-200 flex items-center gap-1 ${
                        statusFilter === 'not-investor'
                          ? 'bg-indigo-50 text-indigo-700'
                          : 'text-gray-600 hover:bg-gray-50'
                      }`}
                    >
                      <ShieldOff className="w-3 h-3" />
                      Not Investor ({summary.notInvestorCount})
                    </button>
                  </div>

                  {/* Error status dropdown */}
                  {errorStatuses.length > 0 && (
                    <select
                      value={statusFilter.startsWith('exa-') || statusFilter.startsWith('db-') || statusFilter.startsWith('deep-') || statusFilter.startsWith('extraction-') || statusFilter.startsWith('unexpected-') ? statusFilter : ''}
                      onChange={(e) => {
                        if (e.target.value) {
                          handleFilterChange(e.target.value);
                        }
                      }}
                      className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 text-gray-600 bg-white"
                    >
                      <option value="">Filter by error type...</option>
                      {errorStatuses.map((s) => (
                        <option key={s} value={s}>
                          {ERROR_STATUS_LABELS[s] || s} ({summary.errorCounts[s]})
                        </option>
                      ))}
                    </select>
                  )}

                  {/* Search */}
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                    <input
                      type="text"
                      placeholder="Search domain or LinkedIn..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-8 pr-3 py-1.5 text-xs border border-gray-200 rounded-lg bg-white text-gray-700 placeholder-gray-400 w-56"
                    />
                  </div>
                </div>

                {/* Download CSV */}
                <button
                  type="button"
                  onClick={downloadCSV}
                  disabled={filteredRows.length === 0}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-green-600 hover:bg-green-700 disabled:opacity-50 transition-colors shadow-sm"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download CSV ({filteredRows.length})
                </button>
              </div>

              {/* Results Table */}
              {filteredRows.length > 0 && (
                <div className="border border-gray-200 rounded-lg overflow-hidden">
                  <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                    <table className="min-w-full divide-y divide-gray-200 text-sm">
                      <thead className="bg-gray-50 sticky top-0 z-10">
                        <tr>
                          <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            #
                          </th>
                          <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Domain
                          </th>
                          <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            LinkedIn
                          </th>
                          <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Status
                          </th>
                          <th className="px-4 py-2.5 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Actions
                          </th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-100">
                        {filteredRows.map((row, idx) => (
                          <tr key={row.id} className="hover:bg-gray-50">
                            <td className="px-4 py-2 text-gray-400 text-xs">
                              {idx + 1}
                            </td>
                            <td className="px-4 py-2 font-mono text-xs">
                              {row.domain ? (
                                <a
                                  href={`https://${row.domain}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-indigo-600 hover:text-indigo-800 hover:underline inline-flex items-center gap-1"
                                >
                                  {row.domain}
                                  <ExternalLink className="w-3 h-3" />
                                </a>
                              ) : (
                                <span className="text-gray-300">—</span>
                              )}
                            </td>
                            <td className="px-4 py-2 font-mono text-xs">
                              {row.linkedin_url ? (
                                <a
                                  href={`https://www.linkedin.com/${row.linkedin_url}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-blue-600 hover:text-blue-800 hover:underline inline-flex items-center gap-1"
                                >
                                  {row.linkedin_url}
                                  <ExternalLink className="w-3 h-3" />
                                </a>
                              ) : (
                                <span className="text-gray-300">—</span>
                              )}
                            </td>
                            <td className="px-4 py-2">
                              {!row.status ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700">
                                  <ShieldOff className="w-3 h-3" />
                                  Not Investor
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-50 text-red-700">
                                  <AlertCircle className="w-3 h-3" />
                                  {ERROR_STATUS_LABELS[row.status] || row.status}
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-2 text-center">
                              <button
                                type="button"
                                onClick={() => handleDelete(row.id)}
                                disabled={deletingIds.has(row.id)}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium text-red-600 hover:text-red-800 hover:bg-red-50 disabled:opacity-50 transition-colors"
                                title="Delete row (allows re-processing)"
                              >
                                {deletingIds.has(row.id) ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <Trash2 className="w-3.5 h-3.5" />
                                )}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {filteredRows.length === 0 && rows.length > 0 && (
                <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-gray-50 text-gray-500 text-sm">
                  <Search className="w-4 h-4" />
                  No rows match the current search query.
                </div>
              )}

              {rows.length === 0 && (
                <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-green-50 text-green-700 text-sm">
                  <CheckCircle2 className="w-5 h-5" />
                  No entries in the not_an_investor table.
                </div>
              )}
            </div>
          )}

          {/* Empty state before fetch */}
          {!summary && !loading && !error && (
            <div className="px-6 py-12 text-center text-gray-400 text-sm">
              Click <span className="font-medium text-gray-600">&quot;Fetch Data&quot;</span> to
              load all not-an-investor entries.
            </div>
          )}

          {/* Loading state */}
          {loading && !summary && (
            <div className="px-6 py-12 flex flex-col items-center gap-3 text-gray-500">
              <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
              <p className="text-sm">Loading not_an_investor data...</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Parse a single CSV line respecting quoted fields */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++; // skip escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}

/* ─────────────────────────────────────────────────────────────
   Tool: Missing Investors from New Fundings
   ───────────────────────────────────────────────────────────── */

interface MissingFundingInvestor {
  name: string;
  url: string;
  type: 'domain' | 'linkedin';
  identifier: string;
  count: number;
  sourceFundings: string[];
}

interface MissingFundingInvestorsResult {
  totalFundings: number;
  totalInvestorEntries: number;
  uniqueInvestorEntries: number;
  existingDomainCount: number;
  existingLinkedinCount: number;
  missingCount: number;
  missing: MissingFundingInvestor[];
}

function MissingFundingInvestorsTool() {
  const [expanded, setExpanded] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MissingFundingInvestorsResult | null>(null);
  const [typeFilter, setTypeFilter] = useState<'all' | 'domain' | 'linkedin'>('all');
  const [sortBy, setSortBy] = useState<'count' | 'name'>('count');

  const runPipeline = useCallback(async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      if (!accessToken) {
        setError('No active session. Please log in again.');
        return;
      }

      const res = await fetch('/api/data-pipelines/missing-funding-investors', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error || `Request failed (${res.status})`);
        return;
      }

      const data: MissingFundingInvestorsResult = await res.json();
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  const filteredMissing = result
    ? result.missing.filter((m) => typeFilter === 'all' || m.type === typeFilter)
    : [];

  const sortedMissing = [...filteredMissing].sort((a, b) => {
    if (sortBy === 'count') return b.count - a.count;
    return a.name.localeCompare(b.name);
  });

  const downloadCSV = useCallback(() => {
    if (!sortedMissing.length) return;

    const headers = ['Name', 'Type', 'Identifier', 'URL', 'Referenced By Count', 'Source Fundings'];
    const rows = sortedMissing.map((m) => [
      m.name,
      m.type,
      m.identifier,
      m.type === 'linkedin'
        ? `https://www.linkedin.com/${m.identifier}`
        : `https://${m.identifier}`,
      String(m.count),
      m.sourceFundings.join('; '),
    ]);

    const csvContent = [headers, ...rows]
      .map((row) =>
        row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(',')
      )
      .join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const filterSuffix = typeFilter === 'all' ? '' : `-${typeFilter}`;
    link.download = `missing-funding-investors${filterSuffix}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [sortedMissing, typeFilter]);

  const domainCount = result ? result.missing.filter((m) => m.type === 'domain').length : 0;
  const linkedinCount = result ? result.missing.filter((m) => m.type === 'linkedin').length : 0;

  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
      {/* Tool Header */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-6 py-4 hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="p-1.5 bg-emerald-50 rounded-lg">
            <Sparkles className="w-5 h-5 text-emerald-600" />
          </div>
          <div className="text-left">
            <h2 className="text-base font-semibold text-gray-900">
              Tool 7: Missing Investors from New Fundings
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Find investors listed in New Fundings that are not yet in the investors database
            </p>
          </div>
        </div>
        {expanded ? (
          <ChevronUp className="w-5 h-5 text-gray-400" />
        ) : (
          <ChevronDown className="w-5 h-5 text-gray-400" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-gray-100">
          {/* Description & Run */}
          <div className="px-6 py-4 bg-gray-50 border-b border-gray-100">
            <div className="flex items-start justify-between gap-4">
              <div className="text-sm text-gray-600 space-y-1">
                <p>
                  This pipeline scans all entries in the{' '}
                  <span className="font-medium text-gray-800">new_fundings</span> table, collects their{' '}
                  <span className="font-medium text-gray-800">investors</span>, and identifies
                  those that are <span className="font-medium text-gray-800">not yet present</span> in the
                  investors table.
                </p>
                <p className="text-xs text-gray-500">
                  Handles both domains (e.g. accel.com) and LinkedIn URLs (e.g. in/namankas).
                  Same logic as the &quot;Search these investors&quot; button on the New Fundings page.
                </p>
              </div>
              <button
                type="button"
                onClick={runPipeline}
                disabled={loading}
                className="flex-shrink-0 inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors shadow-sm"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Running...
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4" />
                    Run Pipeline
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="px-6 py-3 bg-red-50 border-b border-red-100 flex items-center gap-2 text-sm text-red-700">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {error}
            </div>
          )}

          {/* Results */}
          {result && (
            <div className="px-6 py-4 space-y-4">
              {/* Summary Stats */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatCard
                  label="Fundings with Investors"
                  value={result.totalFundings}
                />
                <StatCard
                  label="Unique Investor Entries"
                  value={result.uniqueInvestorEntries}
                />
                <StatCard
                  label="Already in DB"
                  value={result.uniqueInvestorEntries - result.missingCount}
                  color="green"
                />
                <StatCard
                  label="Missing from DB"
                  value={result.missingCount}
                  color={result.missingCount > 0 ? 'orange' : 'green'}
                />
              </div>

              {result.missingCount > 0 && (
                <>
                  {/* Filters & Actions Bar */}
                  <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
                    <div className="flex items-center gap-2">
                      {/* Type filter tabs */}
                      <div className="inline-flex rounded-lg border border-gray-200 bg-white overflow-hidden text-xs">
                        <button
                          type="button"
                          onClick={() => setTypeFilter('all')}
                          className={`px-3 py-1.5 font-medium transition-colors ${
                            typeFilter === 'all'
                              ? 'bg-indigo-50 text-indigo-700'
                              : 'text-gray-600 hover:bg-gray-50'
                          }`}
                        >
                          All ({result.missingCount})
                        </button>
                        <button
                          type="button"
                          onClick={() => setTypeFilter('domain')}
                          className={`px-3 py-1.5 font-medium transition-colors border-l border-gray-200 flex items-center gap-1 ${
                            typeFilter === 'domain'
                              ? 'bg-indigo-50 text-indigo-700'
                              : 'text-gray-600 hover:bg-gray-50'
                          }`}
                        >
                          <Globe className="w-3 h-3" />
                          Domains ({domainCount})
                        </button>
                        <button
                          type="button"
                          onClick={() => setTypeFilter('linkedin')}
                          className={`px-3 py-1.5 font-medium transition-colors border-l border-gray-200 flex items-center gap-1 ${
                            typeFilter === 'linkedin'
                              ? 'bg-indigo-50 text-indigo-700'
                              : 'text-gray-600 hover:bg-gray-50'
                          }`}
                        >
                          <Linkedin className="w-3 h-3" />
                          LinkedIn ({linkedinCount})
                        </button>
                      </div>

                      {/* Sort */}
                      <select
                        value={sortBy}
                        onChange={(e) => setSortBy(e.target.value as 'count' | 'name')}
                        className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 text-gray-600 bg-white"
                      >
                        <option value="count">Sort by References</option>
                        <option value="name">Sort by Name</option>
                      </select>
                    </div>

                    {/* Download CSV */}
                    <button
                      type="button"
                      onClick={downloadCSV}
                      disabled={sortedMissing.length === 0}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-green-600 hover:bg-green-700 disabled:opacity-50 transition-colors shadow-sm"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Download CSV ({sortedMissing.length})
                    </button>
                  </div>

                  {/* Results Table */}
                  <div className="border border-gray-200 rounded-lg overflow-hidden">
                    <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                      <table className="min-w-full divide-y divide-gray-200 text-sm">
                        <thead className="bg-gray-50 sticky top-0 z-10">
                          <tr>
                            <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              #
                            </th>
                            <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Name
                            </th>
                            <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Type
                            </th>
                            <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Identifier
                            </th>
                            <th className="px-4 py-2.5 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Refs
                            </th>
                            <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Source Fundings
                            </th>
                          </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-100">
                          {sortedMissing.map((m, idx) => (
                            <tr key={`${m.type}:${m.identifier}`} className="hover:bg-gray-50">
                              <td className="px-4 py-2 text-gray-400 text-xs">
                                {idx + 1}
                              </td>
                              <td className="px-4 py-2 font-medium text-gray-900">
                                <a
                                  href={
                                    m.type === 'linkedin'
                                      ? `https://www.linkedin.com/${m.identifier}`
                                      : `https://${m.identifier}`
                                  }
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-indigo-600 hover:text-indigo-800 hover:underline"
                                >
                                  {m.name}
                                </a>
                              </td>
                              <td className="px-4 py-2">
                                {m.type === 'linkedin' ? (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700">
                                    <Linkedin className="w-3 h-3" />
                                    LinkedIn
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700">
                                    <Globe className="w-3 h-3" />
                                    Domain
                                  </span>
                                )}
                              </td>
                              <td className="px-4 py-2 text-gray-600 font-mono text-xs">
                                {m.identifier}
                              </td>
                              <td className="px-4 py-2 text-center">
                                <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-orange-50 text-orange-700 text-xs font-medium">
                                  {m.count}
                                </span>
                              </td>
                              <td className="px-4 py-2 text-gray-500 text-xs max-w-[300px]">
                                <span className="truncate block" title={m.sourceFundings.join(', ')}>
                                  {m.sourceFundings.slice(0, 3).join(', ')}
                                  {m.sourceFundings.length > 3 && (
                                    <span className="text-gray-400">
                                      {' '}+{m.sourceFundings.length - 3} more
                                    </span>
                                  )}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              )}

              {result.missingCount === 0 && (
                <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-green-50 text-green-700 text-sm">
                  <CheckCircle2 className="w-5 h-5" />
                  All investors from New Fundings are already present in the database. No missing entries found.
                </div>
              )}
            </div>
          )}

          {/* Empty state before run */}
          {!result && !loading && !error && (
            <div className="px-6 py-12 text-center text-gray-400 text-sm">
              Click <span className="font-medium text-gray-600">&quot;Run Pipeline&quot;</span> to scan all investors from New Fundings and find missing entries.
            </div>
          )}

          {/* Loading state */}
          {loading && !result && (
            <div className="px-6 py-12 flex flex-col items-center gap-3 text-gray-500">
              <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
              <p className="text-sm">Scanning all new fundings and their investors...</p>
              <p className="text-xs text-gray-400">This may take a moment depending on database size.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   Tool 8: Missing Deep Research
   ───────────────────────────────────────────────────────────── */

interface MissingDeepResearchInvestor {
  id: string;
  name: string;
  type: 'firm' | 'person';
  domain: string | null;
  linkedin_url: string | null;
  updated_at: string;
}

type DeepResearchStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

interface DeepResearchResult {
  status: DeepResearchStatus;
  message?: string;
}

function MissingDeepResearchTool() {
  const [expanded, setExpanded] = useState(false);

  // Filters
  const [typeFilter, setTypeFilter] = useState<'all' | 'firm' | 'person'>('all');

  // Investors
  const [investors, setInvestors] = useState<MissingDeepResearchInvestor[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loadingInvestors, setLoadingInvestors] = useState(false);
  const [investorsError, setInvestorsError] = useState<string | null>(null);

  // Processing
  const [processing, setProcessing] = useState(false);
  const [results, setResults] = useState<Map<string, DeepResearchResult>>(new Map());
  const stopRef = useRef(false);

  const getAccessToken = useCallback(async (): Promise<string | null> => {
    const { data: sessionData } = await supabase.auth.getSession();
    return sessionData?.session?.access_token || null;
  }, []);

  // ── Fetch Investors ──
  const fetchInvestors = useCallback(async () => {
    setLoadingInvestors(true);
    setInvestorsError(null);
    setInvestors([]);
    setSelectedIds(new Set());
    setResults(new Map());

    try {
      const accessToken = await getAccessToken();
      if (!accessToken) {
        setInvestorsError('No active session. Please log in again.');
        return;
      }

      const body: Record<string, string> = {};
      if (typeFilter !== 'all') body.type = typeFilter;

      const res = await fetch('/api/data-pipelines/missing-deep-research', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setInvestorsError(data?.error || `Request failed (${res.status})`);
        return;
      }

      const data = await res.json();
      setInvestors(data.investors || []);
    } catch (err) {
      setInvestorsError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoadingInvestors(false);
    }
  }, [typeFilter, getAccessToken]);

  // ── Process Investors (full investor-research pipeline) ──
  const processInvestors = useCallback(
    async (investorsToProcess: MissingDeepResearchInvestor[]) => {
      if (investorsToProcess.length === 0) return;

      setProcessing(true);
      stopRef.current = false;

      const newResults = new Map(results);
      for (const inv of investorsToProcess) {
        newResults.set(inv.id, { status: 'pending' });
      }
      setResults(new Map(newResults));

      const BATCH_SIZE = 10;
      for (let i = 0; i < investorsToProcess.length; i += BATCH_SIZE) {
        if (stopRef.current) {
          console.log('[missing-deep-research] Processing stopped by user');
          break;
        }

        const batch = investorsToProcess.slice(i, i + BATCH_SIZE);

        // Set all investors in this batch to running
        for (const inv of batch) {
          newResults.set(inv.id, { status: 'running' });
        }
        setResults(new Map(newResults));

        // Process batch in parallel
        await Promise.all(
          batch.map(async (inv) => {
            try {
              const accessToken = await getAccessToken();
              if (!accessToken) {
                newResults.set(inv.id, { status: 'failed', message: 'No session' });
                setResults(new Map(newResults));
                return;
              }

              const res = await fetch('/api/data-pipelines/missing-deep-research/process', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${accessToken}`,
                },
                body: JSON.stringify({ investorId: inv.id }),
              });

              if (res.ok) {
                const data = await res.json();
                if (data.skipped) {
                  newResults.set(inv.id, {
                    status: 'skipped',
                    message: data.reason || 'Skipped',
                  });
                } else {
                  newResults.set(inv.id, {
                    status: 'done',
                    message: data.deepResearchComplete
                      ? `Research complete (${data.result?.entity_type || 'unknown'})`
                      : 'Processed',
                  });
                }
              } else {
                const errData = await res.json().catch(() => null);
                newResults.set(inv.id, {
                  status: 'failed',
                  message: errData?.error || `HTTP ${res.status}`,
                });
              }
            } catch (err) {
              newResults.set(inv.id, {
                status: 'failed',
                message: err instanceof Error ? err.message : 'Unknown error',
              });
            }

            setResults(new Map(newResults));
          })
        );
      }

      setProcessing(false);
    },
    [results, getAccessToken]
  );

  const handleRunSelected = useCallback(() => {
    const selected = investors.filter((inv) => selectedIds.has(inv.id));
    processInvestors(selected);
  }, [investors, selectedIds, processInvestors]);

  const handleRunAll = useCallback(() => {
    processInvestors(investors);
  }, [investors, processInvestors]);

  const handleStop = useCallback(() => {
    stopRef.current = true;
  }, []);

  // ── Selection helpers ──
  const toggleInvestor = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllInvestors = () => {
    if (selectedIds.size === investors.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(investors.map((inv) => inv.id)));
    }
  };

  // Stats
  const doneCount = Array.from(results.values()).filter((r) => r.status === 'done').length;
  const skippedCount = Array.from(results.values()).filter((r) => r.status === 'skipped').length;
  const failedCount = Array.from(results.values()).filter((r) => r.status === 'failed').length;
  const runningCount = Array.from(results.values()).filter((r) => r.status === 'running').length;
  const totalProcessed = doneCount + skippedCount + failedCount;

  const formatDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return iso;
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
      {/* Tool Header */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-6 py-4 hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="p-1.5 bg-rose-50 rounded-lg">
            <FileSearch className="w-5 h-5 text-rose-600" />
          </div>
          <div className="text-left">
            <h2 className="text-base font-semibold text-gray-900">
              Tool 8: Missing Deep Research
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Find investors with no deep research and run the full research pipeline on them
            </p>
          </div>
        </div>
        {expanded ? (
          <ChevronUp className="w-5 h-5 text-gray-400" />
        ) : (
          <ChevronDown className="w-5 h-5 text-gray-400" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-gray-100">
          {/* Description & Filters */}
          <div className="px-6 py-4 bg-gray-50 border-b border-gray-100">
            <div className="text-sm text-gray-600 space-y-1 mb-4">
              <p>
                Find all investors whose{' '}
                <span className="font-medium text-gray-800">deep_research</span> column is{' '}
                <span className="font-medium text-gray-800">null or empty</span>. Then process
                each investor through the{' '}
                <span className="font-medium text-gray-800">full investor-research pipeline</span>{' '}
                (Step 1: Exa classification + Step 2: Deep Search + Step 3: LLM extraction).
              </p>
              <p className="text-xs text-gray-500">
                This runs the same pipeline as the investor-research API. Investors are
                processed in parallel batches of 10. Processing may take 30-60 seconds per investor.
              </p>
            </div>

            {/* Filters */}
            <div className="flex flex-wrap items-end gap-4">
              {/* Type filter */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  <Building2 className="w-3 h-3 inline mr-1" />
                  Type
                </label>
                <select
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value as 'all' | 'firm' | 'person')}
                  disabled={loadingInvestors || processing}
                  className="block w-full px-3 py-1.5 text-sm border border-gray-300 rounded-lg bg-white focus:ring-2 focus:ring-rose-500 focus:border-rose-500"
                >
                  <option value="all">All Types</option>
                  <option value="firm">Firm</option>
                  <option value="person">Person</option>
                </select>
              </div>

              <button
                type="button"
                onClick={fetchInvestors}
                disabled={loadingInvestors || processing}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white bg-rose-600 hover:bg-rose-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors shadow-sm"
              >
                {loadingInvestors ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Fetching...
                  </>
                ) : (
                  <>
                    <Search className="w-4 h-4" />
                    Find Missing Investors
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Error */}
          {investorsError && (
            <div className="px-6 py-3 bg-red-50 border-b border-red-100 flex items-center gap-2 text-sm text-red-700">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {investorsError}
            </div>
          )}

          {/* Investors Table */}
          {investors.length > 0 && (
            <div className="px-6 py-4">
              {/* Header + Action bar */}
              <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
                  <Users className="w-4 h-4 text-gray-500" />
                  Investors Missing Deep Research ({investors.length})
                  {selectedIds.size > 0 && selectedIds.size < investors.length && (
                    <span className="text-xs font-normal text-rose-600">
                      ({selectedIds.size} selected)
                    </span>
                  )}
                </h3>
                <div className="flex items-center gap-2">
                  {processing ? (
                    <button
                      type="button"
                      onClick={handleStop}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-red-600 hover:bg-red-700 transition-colors shadow-sm"
                    >
                      <StopCircle className="w-3.5 h-3.5" />
                      Stop
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={handleRunSelected}
                        disabled={selectedIds.size === 0}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-rose-600 hover:bg-rose-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
                      >
                        <Play className="w-3.5 h-3.5" />
                        Run Selected ({selectedIds.size})
                      </button>
                      <button
                        type="button"
                        onClick={handleRunAll}
                        disabled={investors.length === 0}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
                      >
                        <Play className="w-3.5 h-3.5" />
                        Run All ({investors.length})
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Processing Progress */}
              {results.size > 0 && (
                <div className="mb-3">
                  <div className="flex items-center gap-3 text-xs text-gray-600 mb-2">
                    {runningCount > 0 && (
                      <span className="inline-flex items-center gap-1 text-rose-600">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Running: {runningCount}
                      </span>
                    )}
                    <span className="inline-flex items-center gap-1 text-green-600">
                      <CheckCircle2 className="w-3 h-3" />
                      Done: {doneCount}
                    </span>
                    {skippedCount > 0 && (
                      <span className="inline-flex items-center gap-1 text-amber-600">
                        <SkipForward className="w-3 h-3" />
                        Skipped: {skippedCount}
                      </span>
                    )}
                    <span className="inline-flex items-center gap-1 text-red-600">
                      <XCircle className="w-3 h-3" />
                      Failed: {failedCount}
                    </span>
                    <span className="text-gray-400">
                      {totalProcessed} / {results.size} total
                    </span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-1.5">
                    <div
                      className="h-1.5 rounded-full bg-rose-500 transition-all duration-300"
                      style={{
                        width: results.size > 0
                          ? `${((totalProcessed + runningCount) / results.size) * 100}%`
                          : '0%',
                      }}
                    />
                  </div>
                </div>
              )}

              {/* Table */}
              <div className="border border-gray-200 rounded-lg overflow-hidden">
                <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                  <table className="min-w-full divide-y divide-gray-200 text-sm">
                    <thead className="bg-gray-50 sticky top-0 z-10">
                      <tr>
                        <th className="px-3 py-2.5 text-left w-10">
                          <button
                            type="button"
                            onClick={toggleAllInvestors}
                            disabled={processing}
                            className="text-gray-400 hover:text-gray-600 disabled:opacity-50"
                          >
                            {selectedIds.size === investors.length ? (
                              <CheckSquare className="w-4 h-4 text-rose-600" />
                            ) : (
                              <Square className="w-4 h-4" />
                            )}
                          </button>
                        </th>
                        <th className="px-3 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Name
                        </th>
                        <th className="px-3 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Type
                        </th>
                        <th className="px-3 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Domain / LinkedIn
                        </th>
                        <th className="px-3 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Updated At
                        </th>
                        <th className="px-3 py-2.5 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Status
                        </th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-100">
                      {investors.map((inv) => {
                        const result = results.get(inv.id);
                        const status = result?.status;
                        return (
                          <tr
                            key={inv.id}
                            className={`hover:bg-gray-50 cursor-pointer ${
                              selectedIds.has(inv.id) ? 'bg-rose-50/30' : ''
                            } ${status === 'running' ? 'bg-yellow-50/50' : ''}`}
                            onClick={() => !processing && toggleInvestor(inv.id)}
                          >
                            <td className="px-3 py-2">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleInvestor(inv.id);
                                }}
                                disabled={processing}
                                className="disabled:opacity-50"
                              >
                                {selectedIds.has(inv.id) ? (
                                  <CheckSquare className="w-4 h-4 text-rose-600" />
                                ) : (
                                  <Square className="w-4 h-4 text-gray-300" />
                                )}
                              </button>
                            </td>
                            <td className="px-3 py-2 font-medium text-gray-900 text-xs">
                              {inv.name || '—'}
                            </td>
                            <td className="px-3 py-2">
                              {inv.type === 'firm' ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700">
                                  <Building2 className="w-3 h-3" />
                                  Firm
                                </span>
                              ) : inv.type === 'person' ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700">
                                  <Users className="w-3 h-3" />
                                  Person
                                </span>
                              ) : (
                                <span className="text-gray-300 text-xs">—</span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-gray-600 font-mono text-[11px]">
                              {inv.domain ? (
                                <a
                                  href={`https://${inv.domain}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-indigo-600 hover:text-indigo-800 hover:underline"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {inv.domain}
                                </a>
                              ) : inv.linkedin_url ? (
                                <a
                                  href={`https://www.linkedin.com/${inv.linkedin_url}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-indigo-600 hover:text-indigo-800 hover:underline"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {inv.linkedin_url}
                                </a>
                              ) : (
                                <span className="text-gray-300">—</span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-gray-500 text-xs">
                              {formatDate(inv.updated_at)}
                            </td>
                            <td className="px-3 py-2 text-center">
                              <DeepResearchStatusBadge status={status} message={result?.message} />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* Empty state after fetching with zero results */}
          {!loadingInvestors && investors.length === 0 && !investorsError && results.size === 0 && (
            <div className="px-6 py-12 text-center text-gray-400 text-sm">
              Click <span className="font-medium text-gray-600">&quot;Find Missing Investors&quot;</span> to
              find investors without deep research.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DeepResearchStatusBadge({ status, message }: { status?: DeepResearchStatus; message?: string }) {
  if (!status) return <span className="text-gray-300 text-xs">—</span>;

  const config: Record<DeepResearchStatus, { bg: string; text: string; icon: React.ReactNode; label: string }> = {
    pending: {
      bg: 'bg-gray-100',
      text: 'text-gray-500',
      icon: <Square className="w-3 h-3" />,
      label: 'Pending',
    },
    running: {
      bg: 'bg-yellow-50',
      text: 'text-yellow-700',
      icon: <Loader2 className="w-3 h-3 animate-spin" />,
      label: 'Running',
    },
    done: {
      bg: 'bg-green-50',
      text: 'text-green-700',
      icon: <CheckCircle2 className="w-3 h-3" />,
      label: 'Done',
    },
    skipped: {
      bg: 'bg-amber-50',
      text: 'text-amber-700',
      icon: <SkipForward className="w-3 h-3" />,
      label: 'Skipped',
    },
    failed: {
      bg: 'bg-red-50',
      text: 'text-red-700',
      icon: <XCircle className="w-3 h-3" />,
      label: 'Failed',
    },
  };

  const c = config[status];
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${c.bg} ${c.text}`}
      title={message || c.label}
    >
      {c.icon}
      {c.label}
    </span>
  );
}

/* ─────────────────────────────────────────────────────────────
   Shared Components
   ───────────────────────────────────────────────────────────── */

function StatCard({
  label,
  value,
  color = 'gray',
}: {
  label: string;
  value: number;
  color?: 'gray' | 'green' | 'orange';
}) {
  const colorClasses = {
    gray: 'bg-gray-50 text-gray-900',
    green: 'bg-green-50 text-green-800',
    orange: 'bg-orange-50 text-orange-800',
  };

  return (
    <div className={`rounded-lg px-4 py-3 ${colorClasses[color]}`}>
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className="text-xl font-semibold">{value.toLocaleString()}</p>
    </div>
  );
}
