'use client';

import { useState, useEffect } from 'react';
import { useCompanies, CompanyCountByOwner } from '@/contexts/CompaniesContext';
import { OWNER_COLORS } from '@/contexts/OwnerContext';
import ProtectedRoute from '@/components/ProtectedRoute';
import MainLayout from '@/components/MainLayout';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Cell } from 'recharts';

type AnalyticsPeriod = 'today' | 'yesterday' | 'week' | 'month';

export default function AnalyticsPage() {
  const { getCompanyCountsByOwner } = useCompanies();
  const [period, setPeriod] = useState<AnalyticsPeriod>('today');
  const [data, setData] = useState<CompanyCountByOwner[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        setError(null);
        const result = await getCompanyCountsByOwner(period);
        setData(result);
      } catch (err) {
        console.error('Error fetching analytics data:', err);
        setError(err instanceof Error ? err.message : 'Failed to fetch analytics data');
        setData([]);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [period, getCompanyCountsByOwner]);

  // Map owner colors for the chart
  const getBarColor = (owner: string) => {
    const ownerKey = owner as keyof typeof OWNER_COLORS;
    if (OWNER_COLORS[ownerKey]) {
      // Extract color from Tailwind classes - use blue, purple, green, orange
      const colorMap: Record<string, string> = {
        'Aarushi': '#2563eb', // blue-600
        'Naman': '#9333ea', // purple-600
        'Ram': '#16a34a', // green-600
        'Deepak': '#ea580c', // orange-600
      };
      return colorMap[ownerKey] || '#64748b';
    }
    return '#64748b';
  };

  // Format period label
  const getPeriodLabel = (p: AnalyticsPeriod) => {
    switch (p) {
      case 'today':
        return 'Today';
      case 'yesterday':
        return 'Yesterday';
      case 'week':
        return 'Last Week';
      case 'month':
        return 'Last Month';
      default:
        return p;
    }
  };

  return (
    <ProtectedRoute>
      <MainLayout>
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-auto bg-gray-50">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
              <div className="mb-6">
                <h1 className="text-3xl font-bold text-gray-900 mb-2">Analytics</h1>
                <p className="text-gray-600">View company counts by owner</p>
              </div>

              {/* Period Selector */}
              <div className="mb-6">
                <label htmlFor="period" className="block text-sm font-medium text-gray-700 mb-2">
                  Time Period
                </label>
                <select
                  id="period"
                  value={period}
                  onChange={(e) => setPeriod(e.target.value as AnalyticsPeriod)}
                  className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                >
                  <option value="today">Today</option>
                  <option value="yesterday">Yesterday</option>
                  <option value="week">Last Week</option>
                  <option value="month">Last Month</option>
                </select>
              </div>

              {/* Chart Container */}
              <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                {loading ? (
                  <div className="flex items-center justify-center h-96">
                    <div className="text-gray-500">Loading...</div>
                  </div>
                ) : error ? (
                  <div className="flex items-center justify-center h-96">
                    <div className="text-red-600">Error: {error}</div>
                  </div>
                ) : data.length === 0 ? (
                  <div className="flex items-center justify-center h-96">
                    <div className="text-gray-500">No data available for {getPeriodLabel(period)}</div>
                  </div>
                ) : (
                  <>
                    <h2 className="text-xl font-semibold text-gray-900 mb-4">
                      Company Counts by Owner - {getPeriodLabel(period)}
                    </h2>
                    <ResponsiveContainer width="100%" height={400}>
                      <BarChart
                        data={data}
                        margin={{
                          top: 20,
                          right: 30,
                          left: 20,
                          bottom: 5,
                        }}
                      >
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis 
                          dataKey="owner" 
                          tick={{ fill: '#6b7280' }}
                          style={{ fontSize: '14px' }}
                        />
                        <YAxis 
                          tick={{ fill: '#6b7280' }}
                          style={{ fontSize: '14px' }}
                        />
                        <Tooltip 
                          contentStyle={{
                            backgroundColor: '#fff',
                            border: '1px solid #e5e7eb',
                            borderRadius: '6px',
                          }}
                        />
                        <Legend />
                        <Bar 
                          dataKey="total" 
                          name="Companies"
                        >
                          {data.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={getBarColor(entry.owner)} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </MainLayout>
    </ProtectedRoute>
  );
}
