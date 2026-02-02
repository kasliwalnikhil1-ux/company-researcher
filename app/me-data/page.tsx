'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useRouter } from 'next/navigation';
import { supabase } from '@/utils/supabase/client';
import ProtectedRoute from '@/components/ProtectedRoute';
import MainLayout from '@/components/MainLayout';
import DeleteConfirmationModal from '@/components/ui/DeleteConfirmationModal';
import { Database, Plus, Loader2, Trash2, ChevronLeft, ChevronRight, Play } from 'lucide-react';

const ME_DATA_ALLOWED_USER_IDS = new Set([
  '2793f3da-9340-44f4-b285-b7836bfb8591',
  'e25d5e21-13fd-46ee-a39a-4c3386b77b65',
]);

const PAGE_SIZE = 20;

const ME_DATA_TYPES = [
  'Neutral',
  'Negative',
  'Doubtful',
  'Positive',
  'Acknowledged',
  'Networker',
  'Scrutinizer',
  'Referral',
] as const;

type MeDataType = (typeof ME_DATA_TYPES)[number];

type MeDataRow = {
  id: string;
  user_id: string;
  type: string | null;
  processed: boolean | null;
  created_at: string;
};

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

export default function MeDataPage() {
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
          {canAccess && <MeDataContent />}
        </div>
      </MainLayout>
    </ProtectedRoute>
  );
}

function MeDataContent() {
  const { user } = useAuth();
  const [rows, setRows] = useState<MeDataRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inserting, setInserting] = useState(false);
  const [insertType, setInsertType] = useState<MeDataType>('Neutral');
  const [insertDataRaw, setInsertDataRaw] = useState('');
  const [insertError, setInsertError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [rowToDelete, setRowToDelete] = useState<string | null>(null);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [processError, setProcessError] = useState<string | null>(null);
  const [processedFilter, setProcessedFilter] = useState<'all' | 'processed' | 'unprocessed'>('all');
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkProcessing, setBulkProcessing] = useState(false);

  const fetchRows = useCallback(async (overridePage?: number) => {
    if (!user?.id) {
      setLoading(false);
      return;
    }
    const pageToUse = overridePage ?? page;
    try {
      setLoading(true);
      setError(null);
      let query = supabase
        .from('me_data')
        .select('id, user_id, type, processed, created_at', { count: 'exact' })
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (processedFilter === 'processed') {
        query = query.eq('processed', true);
      } else if (processedFilter === 'unprocessed') {
        query = query.or('processed.is.null,processed.eq.false');
      }

      const from = (pageToUse - 1) * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;
      const { data, error: fetchError, count } = await query.range(from, to);

      if (fetchError) {
        throw fetchError;
      }
      const rowsData = (data ?? []) as MeDataRow[];
      setRows(rowsData);
      setTotalCount(count ?? 0);
      if (rowsData.length === 0 && pageToUse > 1 && (count ?? 0) > 0) {
        setPage(pageToUse - 1);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load ME Data');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [user?.id, processedFilter, page]);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  useEffect(() => {
    setPage(1);
    setSelectedIds(new Set());
  }, [processedFilter]);

  const handleInsert = async () => {
    if (!user?.id) return;
    setInsertError(null);
    let parsed: unknown;
    try {
      parsed = insertDataRaw.trim() ? JSON.parse(insertDataRaw) : {};
    } catch {
      setInsertError('Invalid JSON. Please enter valid JSON.');
      return;
    }
    try {
      setInserting(true);
      const { error: insertErr } = await supabase.from('me_data').insert({
        user_id: user.id,
        type: insertType,
        data: parsed,
      });
      if (insertErr) throw insertErr;
      setInsertDataRaw('');
      setPage(1);
      await fetchRows(1);
    } catch (e) {
      setInsertError(e instanceof Error ? e.message : 'Failed to insert');
    } finally {
      setInserting(false);
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      const { error: deleteErr } = await supabase.from('me_data').delete().eq('id', id);
      if (deleteErr) throw deleteErr;
      await fetchRows();
      setRowToDelete(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete');
    } finally {
      setDeletingId(null);
    }
  };

  const handleProcess = async (id: string) => {
    setProcessingId(id);
    setProcessError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        throw new Error('Not authenticated');
      }
      const res = await fetch('/api/me-data-process', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ meDataId: id }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || data.details || 'Failed to process');
      }
      await fetchRows();
    } catch (e) {
      setProcessError(e instanceof Error ? e.message : 'Failed to process');
    } finally {
      setProcessingId(null);
    }
  };

  const toggleRowSelection = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const unprocessedRows = rows.filter((r) => !r.processed);
  const toggleAllOnPage = () => {
    const selectableRows = unprocessedRows;
    const allSelected = selectableRows.length > 0 && selectableRows.every((r) => selectedIds.has(r.id));
    if (allSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        selectableRows.forEach((r) => next.delete(r.id));
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        selectableRows.forEach((r) => next.add(r.id));
        return next;
      });
    }
  };

  const handleBulkProcess = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkProcessing(true);
    setProcessError(null);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      setProcessingId(id);
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token) {
          throw new Error('Not authenticated');
        }
        const res = await fetch('/api/me-data-process', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ meDataId: id }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || data.details || 'Failed to process');
        }
        setSelectedIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        await fetchRows();
      } catch (e) {
        setProcessError(e instanceof Error ? e.message : 'Failed to process');
        break;
      } finally {
        setProcessingId(null);
      }
    }
    setBulkProcessing(false);
  };

  const rowToDeleteType = rows.find((r) => r.id === rowToDelete)?.type ?? 'this entry';
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const hasPrev = page > 1;
  const hasNext = page < totalPages;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-2 flex items-center gap-2">
        <Database className="w-7 h-7 text-indigo-600" />
        ME Data
      </h1>
      <p className="text-sm text-gray-500 mb-6">
        Add and view your ME data entries. Select a type and enter JSON data.
      </p>

      {/* Insert form */}
      <section className="bg-white border border-gray-200 rounded-lg shadow-sm p-6 mb-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <Plus className="w-5 h-5 text-indigo-600" />
          Add entry
        </h2>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Type</label>
            <select
              value={insertType}
              onChange={(e) => setInsertType(e.target.value as MeDataType)}
              className="w-full max-w-xs px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            >
              {ME_DATA_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Data (JSON)</label>
            <textarea
              value={insertDataRaw}
              onChange={(e) => setInsertDataRaw(e.target.value)}
              placeholder='{"key": "value"}'
              rows={6}
              className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            />
          </div>
          {insertError && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {insertError}
            </div>
          )}
          <button
            type="button"
            onClick={handleInsert}
            disabled={inserting}
            className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {inserting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Adding…
              </>
            ) : (
              <>
                <Plus className="w-4 h-4" />
                Add entry
              </>
            )}
          </button>
        </div>
      </section>

      {/* List */}
      <section className="bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden">
        <div className="p-6 pb-0 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <h2 className="text-lg font-semibold text-gray-900">Entries</h2>
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-gray-700">Filter:</label>
              <select
                value={processedFilter}
                onChange={(e) => setProcessedFilter(e.target.value as 'all' | 'processed' | 'unprocessed')}
                className="px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              >
                <option value="all">All</option>
                <option value="processed">Processed</option>
                <option value="unprocessed">Unprocessed</option>
              </select>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {selectedIds.size > 0 && (
              <button
                type="button"
                onClick={handleBulkProcess}
                disabled={bulkProcessing}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {bulkProcessing ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Processing {selectedIds.size}…
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4" />
                    Bulk process ({selectedIds.size})
                  </>
                )}
              </button>
            )}
          </div>
        </div>
        {processError && (
          <div className="mx-6 mt-4">
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {processError}
            </div>
          </div>
        )}
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
                  <th className="w-10 px-4 py-3">
                    <input
                      type="checkbox"
                      checked={unprocessedRows.length > 0 && unprocessedRows.every((r) => selectedIds.has(r.id))}
                      onChange={toggleAllOnPage}
                      disabled={bulkProcessing || unprocessedRows.length === 0}
                      className="w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                      aria-label="Select all unprocessed on page"
                    />
                  </th>
                  <th className="text-left px-4 py-3 font-medium text-gray-700">Type</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-700">Processed</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-700">Created</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-700">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                      No entries yet. Add one above.
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => (
                    <tr
                      key={row.id}
                      className={`border-b border-gray-100 last:border-0 hover:bg-gray-50 ${selectedIds.has(row.id) ? 'bg-indigo-50' : ''}`}
                    >
                      <td className="w-10 px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(row.id)}
                          onChange={() => toggleRowSelection(row.id)}
                          disabled={bulkProcessing || !!row.processed}
                          className="w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                          aria-label={row.processed ? 'Already processed' : `Select ${row.type ?? 'entry'}`}
                        />
                      </td>
                      <td className="px-4 py-3 font-medium text-gray-900">
                        {row.type ?? '—'}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex px-2 py-0.5 text-xs font-medium rounded-full ${
                            row.processed
                              ? 'bg-green-100 text-green-800'
                              : 'bg-gray-100 text-gray-600'
                          }`}
                        >
                          {row.processed ? 'Processed' : 'Unprocessed'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                        {formatDateTime(row.created_at)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => handleProcess(row.id)}
                            disabled={processingId === row.id || bulkProcessing}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm font-medium text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors disabled:opacity-50"
                            title="Process data"
                          >
                            {processingId === row.id ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Play className="w-4 h-4" />
                            )}
                            Process
                          </button>
                          <button
                            type="button"
                            onClick={() => setRowToDelete(row.id)}
                            disabled={deletingId === row.id}
                            className="p-1.5 text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50"
                            title="Delete"
                          >
                            {deletingId === row.id ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Trash2 className="w-4 h-4" />
                            )}
                          </button>
                        </div>
                      </td>
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
              Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, totalCount)} of {totalCount}
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

      <DeleteConfirmationModal
        isOpen={rowToDelete !== null}
        title="Delete entry"
        message={`Are you sure you want to delete this ${rowToDeleteType} entry? This cannot be undone.`}
        onConfirm={() => rowToDelete && handleDelete(rowToDelete)}
        onCancel={() => setRowToDelete(null)}
      />
    </div>
  );
}
