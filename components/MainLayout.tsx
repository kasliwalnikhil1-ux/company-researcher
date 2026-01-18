'use client';

import { useAuth } from '@/contexts/AuthContext';
import { useOwner, OWNER_COLORS } from '@/contexts/OwnerContext';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { useState } from 'react';
import { ChevronLeft, ChevronRight, Search, FileText, Building2, BarChart3 } from 'lucide-react';

export default function MainLayout({ children }: { children: React.ReactNode }) {
  const { user, signOut } = useAuth();
  const { selectedOwner, setSelectedOwner, availableOwners } = useOwner();
  const router = useRouter();
  const pathname = usePathname();
  const [isCollapsed, setIsCollapsed] = useState(false);

  const handleSignOut = async () => {
    try {
      await signOut();
      router.push('/login');
    } catch (error) {
      console.error('Error signing out:', error);
    }
  };

  const isActive = (path: string) => {
    return pathname === path;
  };

  const toggleSidebar = () => {
    setIsCollapsed(!isCollapsed);
  };

  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <aside className={`${isCollapsed ? 'w-16' : 'w-64'} bg-white border-r border-gray-200 flex flex-col transition-all duration-300 relative`}>
        {/* Toggle Button */}
        <button
          onClick={toggleSidebar}
          className="absolute -right-3 top-6 z-10 bg-white border border-gray-200 rounded-full p-1.5 shadow-sm hover:shadow-md transition-shadow"
          aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {isCollapsed ? (
            <ChevronRight className="w-4 h-4 text-gray-600" />
          ) : (
            <ChevronLeft className="w-4 h-4 text-gray-600" />
          )}
        </button>

        <div className={`p-6 border-b border-gray-200 ${isCollapsed ? 'px-2' : ''}`}>
          <h1 className={`text-xl font-bold text-gray-900 transition-opacity duration-300 ${isCollapsed ? 'opacity-0 w-0 overflow-hidden' : 'opacity-100'}`}>
            Kaptured.AI CRM
          </h1>
        </div>
        
        <nav className="flex-1 px-4 py-6 space-y-2">
          <Link
            href="/"
            className={`flex items-center ${isCollapsed ? 'justify-center px-2' : 'px-4'} py-2.5 rounded-lg text-sm font-medium transition-colors ${
              isActive('/')
                ? 'bg-indigo-50 text-indigo-700'
                : 'text-gray-700 hover:bg-gray-50'
            }`}
            title="Research"
          >
            <Search className={`w-5 h-5 ${isCollapsed ? '' : 'mr-3'}`} />
            {!isCollapsed && <span>Research</span>}
          </Link>
          
          <Link
            href="/templates"
            className={`flex items-center ${isCollapsed ? 'justify-center px-2' : 'px-4'} py-2.5 rounded-lg text-sm font-medium transition-colors ${
              isActive('/templates')
                ? 'bg-indigo-50 text-indigo-700'
                : 'text-gray-700 hover:bg-gray-50'
            }`}
            title="Templates"
          >
            <FileText className={`w-5 h-5 ${isCollapsed ? '' : 'mr-3'}`} />
            {!isCollapsed && <span>Templates</span>}
          </Link>
          
          <Link
            href="/companies"
            className={`flex items-center ${isCollapsed ? 'justify-center px-2' : 'px-4'} py-2.5 rounded-lg text-sm font-medium transition-colors ${
              isActive('/companies')
                ? 'bg-indigo-50 text-indigo-700'
                : 'text-gray-700 hover:bg-gray-50'
            }`}
            title="Companies"
          >
            <Building2 className={`w-5 h-5 ${isCollapsed ? '' : 'mr-3'}`} />
            {!isCollapsed && <span>Companies</span>}
          </Link>
          
          <Link
            href="/analytics"
            className={`flex items-center ${isCollapsed ? 'justify-center px-2' : 'px-4'} py-2.5 rounded-lg text-sm font-medium transition-colors ${
              isActive('/analytics')
                ? 'bg-indigo-50 text-indigo-700'
                : 'text-gray-700 hover:bg-gray-50'
            }`}
            title="Analytics"
          >
            <BarChart3 className={`w-5 h-5 ${isCollapsed ? '' : 'mr-3'}`} />
            {!isCollapsed && <span>Analytics</span>}
          </Link>
        </nav>

        {/* User info and logout at bottom */}
        <div className={`p-4 border-t border-gray-200 space-y-3 ${isCollapsed ? 'px-2' : ''}`}>
          {!isCollapsed && (
            <div className="px-4 py-2 space-y-3">
              {/* Owner Dropdown */}
              <div>
                <p className="text-xs text-gray-500 mb-2">Owner</p>
                <select
                  value={selectedOwner}
                  onChange={(e) => {
                    const newOwner = e.target.value as 'Aarushi' | 'Naman' | 'Ram' | 'Deepak';
                    setSelectedOwner(newOwner);
                  }}
                  className={`w-full px-3 py-2 text-sm font-medium rounded-lg border-2 transition-colors ${OWNER_COLORS[selectedOwner].bg} ${OWNER_COLORS[selectedOwner].text} ${OWNER_COLORS[selectedOwner].border} hover:opacity-80 focus:outline-none focus:ring-2 focus:ring-offset-1 ${OWNER_COLORS[selectedOwner].border.replace('border-', 'focus:ring-')}`}
                >
                  {availableOwners.map((owner) => (
                    <option key={owner} value={owner} className="bg-white text-gray-900">
                      {owner}
                    </option>
                  ))}
                </select>
              </div>
              
              {/* User Email */}
              {user && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">Signed in as</p>
                  <p className="text-sm font-medium text-gray-700 truncate">{user.email}</p>
                </div>
              )}
            </div>
          )}
          <button
            onClick={handleSignOut}
            className={`w-full flex items-center ${isCollapsed ? 'justify-center px-2' : 'justify-center px-4'} py-2.5 text-sm font-medium text-red-700 bg-red-50 hover:bg-red-100 rounded-lg transition-colors`}
            title="Logout"
          >
            {isCollapsed ? (
              <span className="text-lg">🚪</span>
            ) : (
              <span>Logout</span>
            )}
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {children}
      </main>
    </div>
  );
}
