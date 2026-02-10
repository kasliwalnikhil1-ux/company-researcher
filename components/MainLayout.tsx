'use client';

import { useAuth } from '@/contexts/AuthContext';
import { useMessageTemplates } from '@/contexts/MessageTemplatesContext';
import { supabase } from '@/utils/supabase/client';
import { useOwner } from '@/contexts/OwnerContext';
import { useCountry, COUNTRY_DATA, Country } from '@/contexts/CountryContext';
import { useOnboarding } from '@/contexts/OnboardingContext';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { useState, useEffect, useMemo } from 'react';
import { ChevronLeft, ChevronRight, Search, FileText, Building2, BarChart3, Globe, Sparkles, Menu, X, UserCircle, CreditCard, HelpCircle, Handshake, Target, Database, Users, RotateCcw, Wrench, Banknote } from 'lucide-react';
import OnboardingFlow from './OnboardingFlow';
import { BookDemoButton } from './BookDemoButton';
import DeleteConfirmationModal from './ui/DeleteConfirmationModal';

// User IDs allowed to access /research when primaryUse is "fundraising"
const RESEARCH_ALLOWED_USER_IDS = new Set([
  '2793f3da-9340-44f4-b285-b7836bfb8591',
  'e25d5e21-13fd-46ee-a39a-4c3386b77b65',
]);

// User IDs allowed to access /personalization
const PERSONALIZATION_ALLOWED_USER_IDS = new Set([
  '2793f3da-9340-44f4-b285-b7836bfb8591',
  'e25d5e21-13fd-46ee-a39a-4c3386b77b65',
]);

// User IDs allowed to access ME Data and ME Prospects
const ME_DATA_ALLOWED_USER_IDS = new Set([
  '2793f3da-9340-44f4-b285-b7836bfb8591',
  'e25d5e21-13fd-46ee-a39a-4c3386b77b65',
]);

// User IDs allowed to access Reset Account (same as ME Data)
const RESET_ACCOUNT_ALLOWED_USER_IDS = new Set([
  '2793f3da-9340-44f4-b285-b7836bfb8591',
  'e25d5e21-13fd-46ee-a39a-4c3386b77b65',
]);

export default function MainLayout({ children }: { children: React.ReactNode }) {
  const { user, signOut } = useAuth();
  const { selectedOwner, setSelectedOwner, availableOwners, ownerColors } = useOwner();
  const defaultOwnerStyles = { bg: 'bg-gray-50', text: 'text-gray-700', border: 'border-gray-200' };
  const ownerStyle = ownerColors[selectedOwner] ?? defaultOwnerStyles;
  const { selectedCountry, setSelectedCountry, availableCountries } = useCountry();
  const { onboarding, loading: onboardingLoading, fetchOnboarding } = useOnboarding();
  const { refreshTemplates } = useMessageTemplates();
  const router = useRouter();
  const pathname = usePathname();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [isResetAccountModalOpen, setIsResetAccountModalOpen] = useState(false);
  const [isResettingAccount, setIsResettingAccount] = useState(false);

  const primaryUse = useMemo(
    () => onboarding?.flowType ?? onboarding?.step0?.primaryUse ?? 'fundraising',
    [onboarding]
  );

  const routeAccess = useMemo(() => {
    const isFundraising = primaryUse === 'fundraising';
    const isB2B = primaryUse === 'b2b';
    const canAccessResearch = RESEARCH_ALLOWED_USER_IDS.has(user?.id ?? '');
    const canAccessPersonalization = PERSONALIZATION_ALLOWED_USER_IDS.has(user?.id ?? '');
    const canAccessMeData = ME_DATA_ALLOWED_USER_IDS.has(user?.id ?? '');
    const canAccessResetAccount = isFundraising && RESET_ACCOUNT_ALLOWED_USER_IDS.has(user?.id ?? '');
    return {
      showResearch: canAccessResearch,
      showCompanies: isB2B,
      showInvestors: isFundraising,
      showEnrich: isB2B,
      showPersonalization: canAccessPersonalization,
      showMeData: canAccessMeData,
      canAccessResearch,
      canAccessCompanies: isB2B,
      canAccessInvestors: isFundraising,
      canAccessEnrich: isB2B,
      canAccessPersonalization,
      canAccessMeData,
      canAccessResetAccount,
      defaultRoute: isFundraising ? '/investors' : '/',
    };
  }, [primaryUse, user?.id]);

  // Show onboarding flow if onboarding is not completed (null or incomplete)
  // me-data, me-data-prospects, and data-pipelines are accessible irrespective of onboarding
  const isMeDataRoute = pathname === '/me-data' || pathname === '/me-data-prospects' || pathname === '/data-pipelines';
  const showOnboarding = !onboardingLoading && !onboarding?.completed && !isMeDataRoute;

  // Detect mobile screen size
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768);
      if (window.innerWidth >= 768) {
        setIsMobileMenuOpen(false);
      }
    };

    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // Close mobile menu when route changes
  useEffect(() => {
    setIsMobileMenuOpen(false);
  }, [pathname]);

  // When Country Code is shown (b2b) and Auto is selected, default to India
  useEffect(() => {
    if (primaryUse !== 'fundraising' && selectedCountry === 'Auto') {
      setSelectedCountry('India');
    }
  }, [primaryUse, selectedCountry, setSelectedCountry]);

  // Route guard: redirect users from inaccessible routes based on primaryUse
  useEffect(() => {
    if (onboardingLoading || !onboarding?.completed) return;
    if (pathname === '/login' || pathname === '/signup' || pathname === '/auth/callback' || pathname.startsWith('/reset-password')) return;

    if (pathname === '/' && routeAccess.canAccessInvestors && !routeAccess.canAccessResearch) {
      router.replace('/investors');
      return;
    }
    if (pathname === '/companies' && !routeAccess.canAccessCompanies) {
      router.replace(routeAccess.defaultRoute);
      return;
    }
    if (pathname === '/investors' && !routeAccess.canAccessInvestors) {
      router.replace('/');
      return;
    }
    if (pathname === '/enrich' && !routeAccess.canAccessEnrich) {
      router.replace(routeAccess.defaultRoute);
      return;
    }
    if (pathname === '/personalization' && !routeAccess.canAccessPersonalization) {
      router.replace(routeAccess.defaultRoute);
      return;
    }
    if (pathname === '/new-fundings' && !routeAccess.canAccessInvestors) {
      router.replace(routeAccess.defaultRoute);
      return;
    }
    if ((pathname === '/me-data' || pathname === '/me-data-prospects' || pathname === '/data-pipelines') && !routeAccess.canAccessMeData) {
      router.replace(routeAccess.defaultRoute);
      return;
    }
  }, [pathname, onboardingLoading, onboarding?.completed, routeAccess, router]);

  const handleSignOut = async () => {
    try {
      await signOut();
      router.push('/login');
    } catch (error) {
      console.error('Error signing out:', error);
    }
  };

  const handleResetAccountConfirm = async () => {
    if (isResettingAccount) return;
    try {
      setIsResettingAccount(true);
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        console.error('No session');
        return;
      }
      const res = await fetch('/api/reset-account', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || err.details || res.statusText);
      }
      // Clear investors localStorage filters
      localStorage.removeItem('investors-filters');
      localStorage.removeItem('investors-mode');
      localStorage.removeItem('investors-type');
      localStorage.removeItem('investors-view-mode');
      setIsResetAccountModalOpen(false);
      await Promise.all([fetchOnboarding(), refreshTemplates()]);
    } catch (error) {
      console.error('Reset account failed:', error);
      alert(error instanceof Error ? error.message : 'Failed to reset account');
    } finally {
      setIsResettingAccount(false);
    }
  };

  const isActive = (path: string) => {
    return pathname === path;
  };

  const toggleSidebar = () => {
    setIsCollapsed(!isCollapsed);
  };

  // Show onboarding flow if needed
  if (showOnboarding) {
    return <OnboardingFlow />;
  }

  // Prevent flash of home page content while redirecting fundraising users to /investors
  if (pathname === '/' && routeAccess.canAccessInvestors && !routeAccess.canAccessResearch) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-indigo-500"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex">
      {/* Mobile Menu Button */}
      {isMobile && !isMobileMenuOpen && (
        <button
          onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
          className="fixed top-4 left-4 z-50 bg-white border border-gray-200 rounded-lg p-2 shadow-md hover:shadow-lg transition-shadow md:hidden"
          aria-label="Toggle menu"
        >
          <Menu className="w-5 h-5 text-gray-600" />
        </button>
      )}

      {/* Mobile Overlay */}
      {isMobile && isMobileMenuOpen && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 z-40 md:hidden"
          onClick={() => setIsMobileMenuOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={`
        ${isMobile 
          ? `fixed top-0 left-0 w-64 h-screen z-40 transform transition-transform duration-300 ${
              isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full'
            }`
          : `fixed top-0 left-0 h-screen transition-[width] duration-300 ease-in-out ${isCollapsed ? 'w-16' : 'w-64'}`
        }
        bg-white border-r border-gray-200 flex flex-col
      `}>
        {/* Toggle Button - Desktop only */}
        {!isMobile && (
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
        )}

        <div className={`p-6 border-b border-gray-200 ${isCollapsed && !isMobile ? 'px-2' : ''}`}>
          <div className={`flex items-center ${isCollapsed && !isMobile ? 'justify-center' : 'justify-between'}`}>
            <div className={`flex items-center ${isCollapsed && !isMobile ? '' : 'gap-2'}`}>
              <Image
                src="/logo.png"
                alt="CapitalxAI"
                width={32}
                height={32}
                className="h-8 w-8 flex-shrink-0 object-contain"
              />
              {(!isCollapsed || isMobile) && (
                <h1 className="text-xl font-bold text-gray-900">CapitalxAI</h1>
              )}
            </div>
            {isMobile && (
              <button
                onClick={() => setIsMobileMenuOpen(false)}
                className="p-1 text-gray-500 hover:text-gray-700"
                aria-label="Close menu"
              >
                <X className="w-5 h-5" />
              </button>
            )}
          </div>
        </div>
        
        <nav className={`flex-1 py-6 space-y-2 overflow-y-auto ${isCollapsed && !isMobile ? 'px-2' : 'px-4'}`}>
          {routeAccess.showResearch && (
            <Link
              href="/"
              className={`flex items-center ${isCollapsed && !isMobile ? 'justify-center px-2' : 'px-4'} py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isActive('/')
                  ? 'bg-indigo-50 text-indigo-700'
                  : 'text-gray-700 hover:bg-gray-50'
              }`}
              title="Research"
            >
              <Search className={`w-5 h-5 flex-shrink-0 ${isCollapsed && !isMobile ? '' : 'mr-3'}`} />
              {(!isCollapsed || isMobile) && <span>Research</span>}
            </Link>
          )}

          {routeAccess.showCompanies && (
            <Link
              href="/companies"
              className={`flex items-center ${isCollapsed && !isMobile ? 'justify-center px-2' : 'px-4'} py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isActive('/companies')
                  ? 'bg-indigo-50 text-indigo-700'
                  : 'text-gray-700 hover:bg-gray-50'
              }`}
              title="Companies"
            >
              <Building2 className={`w-5 h-5 flex-shrink-0 ${isCollapsed && !isMobile ? '' : 'mr-3'}`} />
              {(!isCollapsed || isMobile) && <span>Companies</span>}
            </Link>
          )}

          {routeAccess.showInvestors && (
            <>
              <Link
                href="/investors"
                className={`flex items-center ${isCollapsed && !isMobile ? 'justify-center px-2' : 'px-4'} py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive('/investors')
                    ? 'bg-indigo-50 text-indigo-700'
                    : 'text-gray-700 hover:bg-gray-50'
                }`}
                title="Investors"
              >
                <Handshake className={`w-5 h-5 flex-shrink-0 ${isCollapsed && !isMobile ? '' : 'mr-3'}`} />
                {(!isCollapsed || isMobile) && <span>Investors</span>}
              </Link>
              <Link
                href="/new-fundings"
                className={`flex items-center ${isCollapsed && !isMobile ? 'justify-center px-2' : 'px-4'} py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive('/new-fundings')
                    ? 'bg-indigo-50 text-indigo-700'
                    : 'text-gray-700 hover:bg-gray-50'
                }`}
                title="New Fundings"
              >
                <Banknote className={`w-5 h-5 flex-shrink-0 ${isCollapsed && !isMobile ? '' : 'mr-3'}`} />
                {(!isCollapsed || isMobile) && <span>New Fundings</span>}
              </Link>
            </>
          )}
          
          {routeAccess.showEnrich && (
            <Link
              href="/enrich"
              className={`flex items-center ${isCollapsed && !isMobile ? 'justify-center px-2' : 'px-4'} py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isActive('/enrich')
                  ? 'bg-indigo-50 text-indigo-700'
                  : 'text-gray-700 hover:bg-gray-50'
              }`}
              title="Enrich CSV"
            >
              <Sparkles className={`w-5 h-5 flex-shrink-0 ${isCollapsed && !isMobile ? '' : 'mr-3'}`} />
              {(!isCollapsed || isMobile) && <span>Enrich</span>}
            </Link>
          )}
          
          <Link
            href="/templates"
            className={`flex items-center ${isCollapsed && !isMobile ? 'justify-center px-2' : 'px-4'} py-2.5 rounded-lg text-sm font-medium transition-colors ${
              isActive('/templates')
                ? 'bg-indigo-50 text-indigo-700'
                : 'text-gray-700 hover:bg-gray-50'
            }`}
            title="Templates"
          >
            <FileText className={`w-5 h-5 flex-shrink-0 ${isCollapsed && !isMobile ? '' : 'mr-3'}`} />
            {(!isCollapsed || isMobile) && <span>Message Templates</span>}
          </Link>
          
          {routeAccess.showPersonalization && (
            <Link
              href="/personalization"
              className={`flex items-center ${isCollapsed && !isMobile ? 'justify-center px-2' : 'px-4'} py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isActive('/personalization')
                  ? 'bg-indigo-50 text-indigo-700'
                  : 'text-gray-700 hover:bg-gray-50'
              }`}
              title="Personalization"
            >
              <Target className={`w-5 h-5 flex-shrink-0 ${isCollapsed && !isMobile ? '' : 'mr-3'}`} />
              {(!isCollapsed || isMobile) && <span>Personalization</span>}
            </Link>
          )}

          <Link
            href="/company-profile"
            className={`flex items-center ${isCollapsed && !isMobile ? 'justify-center px-2' : 'px-4'} py-2.5 rounded-lg text-sm font-medium transition-colors ${
              isActive('/company-profile')
                ? 'bg-indigo-50 text-indigo-700'
                : 'text-gray-700 hover:bg-gray-50'
            }`}
            title="Company Profile"
          >
            <Building2 className={`w-5 h-5 flex-shrink-0 ${isCollapsed && !isMobile ? '' : 'mr-3'}`} />
            {(!isCollapsed || isMobile) && <span>Company Profile</span>}
          </Link>

          <Link
            href="/account"
            className={`flex items-center ${isCollapsed && !isMobile ? 'justify-center px-2' : 'px-4'} py-2.5 rounded-lg text-sm font-medium transition-colors ${
              isActive('/account')
                ? 'bg-indigo-50 text-indigo-700'
                : 'text-gray-700 hover:bg-gray-50'
            }`}
            title="Account & Security"
          >
            <UserCircle className={`w-5 h-5 flex-shrink-0 ${isCollapsed && !isMobile ? '' : 'mr-3'}`} />
            {(!isCollapsed || isMobile) && <span>Account</span>}
          </Link>

          <Link
            href="/analytics"
            className={`flex items-center ${isCollapsed && !isMobile ? 'justify-center px-2' : 'px-4'} py-2.5 rounded-lg text-sm font-medium transition-colors ${
              isActive('/analytics')
                ? 'bg-indigo-50 text-indigo-700'
                : 'text-gray-700 hover:bg-gray-50'
            }`}
            title="Analytics"
          >
            <BarChart3 className={`w-5 h-5 flex-shrink-0 ${isCollapsed && !isMobile ? '' : 'mr-3'}`} />
            {(!isCollapsed || isMobile) && <span>Analytics</span>}
          </Link>

          <Link
            href="/usage"
            className={`flex items-center ${isCollapsed && !isMobile ? 'justify-center px-2' : 'px-4'} py-2.5 rounded-lg text-sm font-medium transition-colors ${
              isActive('/usage')
                ? 'bg-indigo-50 text-indigo-700'
                : 'text-gray-700 hover:bg-gray-50'
            }`}
            title="Usage"
          >
            <CreditCard className={`w-5 h-5 flex-shrink-0 ${isCollapsed && !isMobile ? '' : 'mr-3'}`} />
            {(!isCollapsed || isMobile) && <span>Usage</span>}
          </Link>

          <Link
            href="/domains-extractor"
            className={`flex items-center ${isCollapsed && !isMobile ? 'justify-center px-2' : 'px-4'} py-2.5 rounded-lg text-sm font-medium transition-colors ${
              isActive('/domains-extractor')
                ? 'bg-indigo-50 text-indigo-700'
                : 'text-gray-700 hover:bg-gray-50'
            }`}
            title="Extract Domains"
          >
            <Globe className={`w-5 h-5 flex-shrink-0 ${isCollapsed && !isMobile ? '' : 'mr-3'}`} />
            {(!isCollapsed || isMobile) && <span>Extract Domains</span>}
          </Link>

          {routeAccess.showMeData && (
            <>
              <Link
                href="/me-data"
                className={`flex items-center ${isCollapsed && !isMobile ? 'justify-center px-2' : 'px-4'} py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive('/me-data')
                    ? 'bg-indigo-50 text-indigo-700'
                    : 'text-gray-700 hover:bg-gray-50'
                }`}
                title="ME Data"
              >
                <Database className={`w-5 h-5 flex-shrink-0 ${isCollapsed && !isMobile ? '' : 'mr-3'}`} />
                {(!isCollapsed || isMobile) && <span>ME Data</span>}
              </Link>
              <Link
                href="/me-data-prospects"
                className={`flex items-center ${isCollapsed && !isMobile ? 'justify-center px-2' : 'px-4'} py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive('/me-data-prospects')
                    ? 'bg-indigo-50 text-indigo-700'
                    : 'text-gray-700 hover:bg-gray-50'
                }`}
                title="ME Data Prospects"
              >
                <Users className={`w-5 h-5 flex-shrink-0 ${isCollapsed && !isMobile ? '' : 'mr-3'}`} />
                {(!isCollapsed || isMobile) && <span>ME Prospects</span>}
              </Link>
              <Link
                href="/data-pipelines"
                className={`flex items-center ${isCollapsed && !isMobile ? 'justify-center px-2' : 'px-4'} py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive('/data-pipelines')
                    ? 'bg-indigo-50 text-indigo-700'
                    : 'text-gray-700 hover:bg-gray-50'
                }`}
                title="Data Updation Pipelines"
              >
                <Wrench className={`w-5 h-5 flex-shrink-0 ${isCollapsed && !isMobile ? '' : 'mr-3'}`} />
                {(!isCollapsed || isMobile) && <span>Data Pipelines</span>}
              </Link>
            </>
          )}

          {routeAccess.canAccessResetAccount && (
            <button
              type="button"
              onClick={() => setIsResetAccountModalOpen(true)}
              className={`flex items-center w-full ${isCollapsed && !isMobile ? 'justify-center px-2' : 'px-4'} py-2.5 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors`}
              title="Reset Account"
            >
              <RotateCcw className={`w-5 h-5 flex-shrink-0 ${isCollapsed && !isMobile ? '' : 'mr-3'}`} />
              {(!isCollapsed || isMobile) && <span>Reset Account</span>}
            </button>
          )}

          <a
            href="https://calendly.com/founders-capitalxai/20min"
            target="_blank"
            rel="noopener noreferrer"
            className={`flex items-center ${isCollapsed && !isMobile ? 'justify-center px-2' : 'px-4'} py-2.5 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors`}
            title="Need Help - Book a 15 min call"
          >
            <HelpCircle className={`w-5 h-5 flex-shrink-0 ${isCollapsed && !isMobile ? '' : 'mr-3'}`} />
            {(!isCollapsed || isMobile) && <span>Need Help</span>}
          </a>
        </nav>

        {/* User info and logout at bottom */}
        <div className={`p-4 border-t border-gray-200 space-y-3 ${isCollapsed && !isMobile ? 'px-2' : ''}`}>
          {(!isCollapsed || isMobile) && (
            <div className="px-4 py-2 space-y-3">
              {/* Owner Dropdown */}
              <div>
                <p className="text-xs text-gray-500 mb-2">Owner</p>
                <select
                  value={selectedOwner}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === '__add_owners__') {
                      router.push('/account');
                      return;
                    }
                    setSelectedOwner(val);
                  }}
                  className={`w-full px-3 py-2 text-sm font-medium rounded-lg border-2 transition-colors ${ownerStyle.bg} ${ownerStyle.text} ${ownerStyle.border} hover:opacity-80 focus:outline-none focus:ring-2 focus:ring-offset-1 ${ownerStyle.border.replace('border-', 'focus:ring-')}`}
                >
                  {availableOwners.length === 0 ? (
                    <>
                      <option value="">— No owners in Account —</option>
                      <option value="__add_owners__" className="text-brand-default font-medium">Add new owners</option>
                    </>
                  ) : (
                    <>
                      <option value="">— Select —</option>
                      {availableOwners.map((owner) => (
                        <option key={owner} value={owner} className="bg-white text-gray-900">
                          {owner}
                        </option>
                      ))}
                      <option value="__add_owners__" className="text-brand-default font-medium">Add new owners</option>
                    </>
                  )}
                </select>
              </div>

              {/* Country Dropdown - hidden for fundraising, and Auto option excluded */}
              {primaryUse !== 'fundraising' && (
                <div>
                  <p className="text-xs text-gray-500 mb-2">Country Code</p>
                  <select
                    value={selectedCountry === 'Auto' ? 'India' : selectedCountry}
                    onChange={(e) => {
                      setSelectedCountry(e.target.value as Country);
                    }}
                    className="w-full px-3 py-2 text-sm font-medium rounded-lg border border-gray-300 bg-white text-gray-900 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-colors"
                  >
                    {availableCountries.filter((c) => c !== 'Auto').map((country) => (
                      <option key={country} value={country} className="bg-white text-gray-900">
                        {COUNTRY_DATA[country].flag} {country} ({COUNTRY_DATA[country].code})
                      </option>
                    ))}
                  </select>
                </div>
              )}
              
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
            className={`w-full flex items-center ${isCollapsed && !isMobile ? 'justify-center px-2' : 'justify-center px-4'} py-2.5 text-sm font-medium text-red-700 bg-red-50 hover:bg-red-100 rounded-lg transition-colors`}
            title="Logout"
          >
            {isCollapsed && !isMobile ? (
              <span className="text-lg">🚪</span>
            ) : (
              <span>Logout</span>
            )}
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className={`
        ${isMobile ? 'ml-0' : isCollapsed ? 'ml-16' : 'ml-64'}
        flex-1 flex flex-col overflow-hidden transition-all duration-300
        ${isMobile ? 'pt-16' : ''}
      `}>
        {children}
      </main>

      <BookDemoButton />

      <DeleteConfirmationModal
        isOpen={isResetAccountModalOpen}
        title="Reset Account"
        message="This will clear your onboarding, all investor personalization data, and all message templates. You will need to complete onboarding again. This cannot be undone."
        onConfirm={handleResetAccountConfirm}
        onCancel={() => !isResettingAccount && setIsResetAccountModalOpen(false)}
        confirmText={isResettingAccount ? 'Resetting…' : 'Reset Account'}
        confirmDisabled={isResettingAccount}
      />
    </div>
  );
}
