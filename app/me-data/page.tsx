'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/utils/supabase/client';
import ProtectedRoute from '@/components/ProtectedRoute';
import MainLayout from '@/components/MainLayout';
import { Database, Plus, Loader2, Trash2 } from 'lucide-react';

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
  return (
    <ProtectedRoute>
      <MainLayout>
        <div className="flex-1 overflow-auto">
          <MeDataContent />
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

  const fetchRows = useCallback(async () => {
    if (!user?.id) {
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const { data, error: fetchError } = await supabase
        .from('me_data')
        .select('id, user_id, type, created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (fetchError) {
        throw fetchError;
      }
      setRows((data ?? []) as MeDataRow[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load ME Data');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

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
      await fetchRows();
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
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete');
    } finally {
      setDeletingId(null);
    }
  };

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
        <h2 className="text-lg font-semibold text-gray-900 p-6 pb-0">Entries</h2>
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
                  <th className="text-left px-4 py-3 font-medium text-gray-700">Type</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-700">Created</th>
                  <th className="w-12 px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-4 py-8 text-center text-gray-500">
                      No entries yet. Add one above.
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => (
                    <tr
                      key={row.id}
                      className="border-b border-gray-100 last:border-0 hover:bg-gray-50"
                    >
                      <td className="px-4 py-3 font-medium text-gray-900">
                        {row.type ?? '—'}
                      </td>
                      <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                        {formatDateTime(row.created_at)}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => handleDelete(row.id)}
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
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
