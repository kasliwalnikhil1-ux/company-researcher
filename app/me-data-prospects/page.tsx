'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useRouter } from 'next/navigation';
import { supabase } from '@/utils/supabase/client';
import ProtectedRoute from '@/components/ProtectedRoute';
import MainLayout from '@/components/MainLayout';
import { downloadCsv } from '@/lib/csvExport';
import { Users, Loader2, ChevronLeft, ChevronRight, Download, Settings2 } from 'lucide-react';

const ME_DATA_ALLOWED_USER_IDS = new Set([
  '2793f3da-9340-44f4-b285-b7836bfb8591',
  'e25d5e21-13fd-46ee-a39a-4c3386b77b65',
]);

const PAGE_SIZE = 20;

const PROSPECT_COLUMNS = [
  { key: 'linkedin_url', label: 'LinkedIn URL' },
  { key: 'name', label: 'Name' },
  { key: 'headline', label: 'Headline' },
  { key: 'intent', label: 'Intent' },
  { key: 'status', label: 'Status' },
  { key: 'convo_date', label: 'Convo Date' },
] as const;

type ProspectColumnKey = (typeof PROSPECT_COLUMNS)[number]['key'];

type ProspectRow = {
  linkedin_url: string;
  name: string | null;
  headline: string | null;
  intent: string | null;
  status: string | null;
  convo_date: string | null;
};

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return '—';
  }
}

const csvEscape = (value: unknown): string => {
  if (value == null) return '';
  const str = String(value);
  return `"${str.replace(/"/g, '""')}"`;
};

function prospectsToCsv(rows: ProspectRow[], visibleColumns: ProspectColumnKey[]): string {
  const headers = visibleColumns.map((k) => PROSPECT_COLUMNS.find((c) => c.key === k)?.label ?? k);
  const rowsCsv = rows.map((row) =>
    visibleColumns.map((col) => csvEscape(row[col] ?? '')).join(',')
  );
  return [headers.map(csvEscape).join(','), ...rowsCsv].join('\n');
}

export default function MeDataProspectsPage() {
  const { user } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (user && !ME_DATA_ALLOWED_USER_IDS.has(user.id)) {
      router.replace('/');
    }
  }, [user, router]);

  const canAccess = user && ME_DATA_ALLOWED_USER_IDS.has(user.id);

  return (
    <ProtectedRoute>
      <MainLayout>
        <div className="flex-1 overflow-auto">
          {canAccess && <MeDataProspectsContent />}
        </div>
      </MainLayout>
    </ProtectedRoute>
  );
}

function MeDataProspectsContent() {
  const { user } = useAuth();
  const [rows, setRows] = useState<ProspectRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [visibleColumns, setVisibleColumns] = useState<Set<ProspectColumnKey>>(
    new Set(PROSPECT_COLUMNS.map((c) => c.key))
  );
  const [showColumnPicker, setShowColumnPicker] = useState(false);

  const fetchRows = useCallback(
    async (overridePage?: number) => {
      if (!user?.id) {
        setLoading(false);
        return;
      }
      const pageToUse = overridePage ?? page;
      try {
        setLoading(true);
        setError(null);
        const from = (pageToUse - 1) * PAGE_SIZE;
        const to = from + PAGE_SIZE - 1;
        const { data, error: fetchError, count } = await supabase
          .from('me_data_prospects')
          .select('linkedin_url, name, headline, intent, status, convo_date', { count: 'exact' })
          .eq('user_id', user.id)
          .order('convo_date', { ascending: false, nullsFirst: false })
          .range(from, to);

        if (fetchError) throw fetchError;
        setRows((data ?? []) as ProspectRow[]);
        setTotalCount(count ?? 0);
        if ((data ?? []).length === 0 && pageToUse > 1 && (count ?? 0) > 0) {
          setPage(pageToUse - 1);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load prospects');
        setRows([]);
      } finally {
        setLoading(false);
      }
    },
    [user?.id, page]
  );

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  const handleDownloadCsv = async () => {
    if (!user?.id) return;
    try {
      const { data, error: fetchError } = await supabase
        .from('me_data_prospects')
        .select('linkedin_url, name, headline, intent, status, convo_date')
        .eq('user_id', user.id)
        .order('convo_date', { ascending: false, nullsFirst: false });

      if (fetchError) throw fetchError;
      const allRows = (data ?? []) as ProspectRow[];
      const csv = prospectsToCsv(allRows, [...visibleColumns]);
      downloadCsv(csv, 'me-data-prospects.csv');
    } catch (e) {
      console.error('CSV download failed:', e);
      setError(e instanceof Error ? e.message : 'Failed to download CSV');
    }
  };

  const toggleColumn = (key: ProspectColumnKey) => {
    setVisibleColumns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        if (next.size <= 1) return prev;
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const hasPrev = page > 1;
  const hasNext = page < totalPages;
  const visibleCols = PROSPECT_COLUMNS.filter((c) => visibleColumns.has(c.key));

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-2 flex items-center gap-2">
        <Users className="w-7 h-7 text-indigo-600" />
        ME Data Prospects
      </h1>
      <p className="text-sm text-gray-500 mb-6">
        View prospects extracted from your ME data, sorted by conversation date (latest first).
      </p>

      <section className="bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden">
        <div className="p-6 pb-0 flex flex-wrap items-center justify-between gap-4">
          <h2 className="text-lg font-semibold text-gray-900">Prospects</h2>
          <div className="flex items-center gap-2">
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowColumnPicker(!showColumnPicker)}
                className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                title="Filter columns"
              >
                <Settings2 className="w-4 h-4" />
                Columns
              </button>
              {showColumnPicker && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setShowColumnPicker(false)}
                    aria-hidden="true"
                  />
                  <div className="absolute right-0 mt-1 z-20 w-48 py-2 bg-white border border-gray-200 rounded-lg shadow-lg">
                    {PROSPECT_COLUMNS.map((col) => (
                      <label
                        key={col.key}
                        className="flex items-center gap-2 px-4 py-2 hover:bg-gray-50 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={visibleColumns.has(col.key)}
                          onChange={() => toggleColumn(col.key)}
                          className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                        />
                        <span className="text-sm text-gray-700">{col.label}</span>
                      </label>
                    ))}
                  </div>
                </>
              )}
            </div>
            <button
              type="button"
              onClick={handleDownloadCsv}
              disabled={totalCount === 0}
              className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
              title="Download CSV"
            >
              <Download className="w-4 h-4" />
              Download CSV
            </button>
          </div>
        </div>

        {loading ? (
          <div className="p-12 flex items-center justify-center gap-2 text-gray-500">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="text-sm">Loading…</span>
          </div>
        ) : error ? (
          <div className="p-6">
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
              {error}
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  {visibleCols.map((col) => (
                    <th
                      key={col.key}
                      className="text-left px-4 py-3 font-medium text-gray-700 whitespace-nowrap"
                    >
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={visibleCols.length}
                      className="px-4 py-8 text-center text-gray-500"
                    >
                      No prospects yet. Process ME data entries to extract prospects.
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => (
                    <tr
                      key={row.linkedin_url}
                      className="border-b border-gray-100 last:border-0 hover:bg-gray-50"
                    >
                      {visibleCols.map((col) => (
                        <td key={col.key} className="px-4 py-3 text-gray-900">
                          {col.key === 'linkedin_url' && row.linkedin_url ? (
                            <a
                              href={row.linkedin_url.startsWith('http') ? row.linkedin_url : `https://${row.linkedin_url}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-indigo-600 hover:underline truncate block max-w-[200px]"
                            >
                              {row.linkedin_url}
                            </a>
                          ) : col.key === 'convo_date' ? (
                            formatDate(row.convo_date)
                          ) : (
                            (row[col.key] ?? '—') as string
                          )}
                        </td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {!loading && !error && totalCount > 0 && (
          <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-between gap-4">
            <p className="text-sm text-gray-500">
              Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, totalCount)} of{' '}
              {totalCount}
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={!hasPrev}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <ChevronLeft className="w-4 h-4" />
                Previous
              </button>
              <span className="text-sm text-gray-600">
                Page {page} of {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={!hasNext}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
