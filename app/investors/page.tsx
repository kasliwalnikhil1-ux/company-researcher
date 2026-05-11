'use client';

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { DotLottieReact } from '@lottiefiles/dotlottie-react';
import ProtectedRoute from '@/components/ProtectedRoute';
import MainLayout from '@/components/MainLayout';
import Toast from '@/components/ui/Toast';
import InvestorDetailsDrawer from '@/components/ui/InvestorDetailsDrawer';
import ManageInvestorColumnsDrawer from '@/components/ui/ManageInvestorColumnsDrawer';
import ReportMissingInvestorsModal from '@/components/ui/ReportMissingInvestorsModal';
import InsufficientCreditsModal from '@/components/ui/InsufficientCreditsModal';
import {
  useInvestorSearch,
  fetchInvestorById,
  fetchInvestorsForExport,
  type InvestorSearchFilters,
  type InvestorSearchResult,
  type InvestorTypeFilter,
} from '@/hooks/useInvestorSearch';
import {
  Handshake,
  Filter,
  ChevronDown,
  Eye,
  X,
  Check,
  Sparkles,
  Loader2,
  Globe,
  CheckCircle2,
  ArrowRight,
  Table,
  List,
  Download,
  Building2,
  User,
} from 'lucide-react';
import { formatGeographyForDisplay, formatHqLocationShort, getCountryName, resolveCountryInput } from '@/lib/isoCodes';
import { Skeleton } from '@/components/ui/skeleton';
import { usePricingModal } from '@/contexts/PricingModalContext';
import { fetchInvestorAnalyze } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { useOwner } from '@/contexts/OwnerContext';
import { useRouter } from 'next/navigation';
import { useOnboarding } from '@/contexts/OnboardingContext';
import { useMessageTemplates } from '@/contexts/MessageTemplatesContext';
import { supabase } from '@/utils/supabase/client';
import { getValidAccessToken } from '@/lib/api';
import { buildEmailComposeUrl, buildEmailBody, type EmailSettings } from '@/lib/emailCompose';
import { renderInvestorTemplate } from '@/lib/messageTemplates';
import { copyToClipboard, extractPhoneNumber, columnKeyToStoredForTemplateSelection, storedToColumnKeyForTemplateSelection, parseNameUrlListToSearchParams, normalizeLinkedInUrl, cleanSearchInput } from '@/lib/utils';
import { downloadCsv } from '@/lib/csvExport';

// Filter options - must match what's stored in backend (investor-research API)
const INVESTOR_TYPE_OPTIONS = [
  'Venture Capital',
  'Angel Investor',
  'Family Office',
  'Private Equity',
  'Hedge Fund',
  'Corporate Venture Capital',
  'Accelerator / Incubator',
  'Investment Holding Company',
  'Sovereign Wealth Fund',
  'Institutional Investor',
  'Fund of Funds',
  'Venture Debt / Credit Investor',
  'Crowdfunding / Community Investor',
  'Government or Public Investment Fund'
];

const TIER_OPTIONS = ['A', 'B', 'C'];

const STAGE_OPTIONS = [
  'angel',
  'pre-seed',
  'seed',
  'post-seed',
  'series-a',
  'series-b',
  'series-c',
  'growth',
  'late-stage',
  'pre-ipo',
  'public-equity',
];

const INDUSTRY_OPTIONS = [
  'artificial-intelligence',
  'machine-learning',
  'healthtech',
  'biotech',
  'digital-health',
  'mental-health',
  'wellness',
  'longevity',
  'fitness',
  'consumer-health',
  'medtech',
  'pharma',
  'genomics',
  'bioinformatics',
  'neuroscience',
  'consumer-tech',
  'enterprise-software',
  'saas',
  'vertical-saas',
  'developer-tools',
  'productivity',
  'collaboration',
  'fintech',
  'payments',
  'lending',
  'credit',
  'insurtech',
  'regtech',
  'wealthtech',
  'climate-tech',
  'energy',
  'clean-energy',
  'carbon-removal',
  'sustainability',
  'web3',
  'blockchain',
  'crypto',
  'defi',
  'nft',
  'social-platforms',
  'marketplaces',
  'creator-economy',
  'edtech',
  'hr-tech',
  'future-of-work',
  'mobility',
  'transportation',
  'autonomous-vehicles',
  'robotics',
  'hardware',
  'deep-tech',
  'semiconductors',
  'data-infrastructure',
  'cloud-infrastructure',
  'devops',
  'cybersecurity',
  'security',
  'privacy',
  'identity',
  'digital-identity',
  'consumer-internet',
  'ecommerce',
  'retail-tech',
  'proptech',
  'real-estate',
  'construction-tech',
  'smart-cities',
  'supply-chain',
  'logistics',
  'manufacturing',
  'industrial-tech',
  'agtech',
  'foodtech',
  'gaming',
  'esports',
  'media',
  'entertainment',
  'music-tech',
  'sports-tech',
  'travel-tech',
  'hospitality',
  'martech',
  'adtech',
  'legal-tech',
  'govtech',
  'defense-tech',
  'space-tech',
  'aerospace',
  'iot',
  'edge-computing',
  'network-effects',
];

// ISO country codes (alpha-2) and regions aligned with investor-research route
const GEOGRAPHY_OPTIONS = [
  'US',
  'GB',
  'DE',
  'FR',
  'IN',
  'CA',
  'SG',
  'AU',
  'NL',
  'IL',
  'CH',
  'SE',
  'ES',
  'IT',
  'JP',
  'CN',
  'KR',
  'BR',
  'MX',
  'ZA',
  'AE',
  'SA',
  'NG',
  'KE',
  'EG',
  'EU',
  'North America',
  'MENA',
  'APAC',
  'LATAM',
  'EMEA',
  'Sub-Saharan Africa',
];

const ROLE_OPTIONS = [
  'CEO / Founder',
  'Partner',
  'Managing Partner',
  'General Partner',
  'Principal',
  'Venture Partner',
  'Operating Partner',
  'Independent Investor / Angel',
  'Associate',
  'Research Analyst',
  'Scout',
];

// Reviewed tab only: pipeline stage options
const REVIEWED_STAGE_OPTIONS = [
  'Identified',
  'Seeking Intro',
  'Call Scheduled',
  'Due Diligence',
  'Verbal Agreement',
  'Closed/Signed',
  'Closed/Lost',
  'Disappeared',
];

// Investor fit: Strong Fit -> true, Weak Fit -> false, Unclear Fit -> null
const INVESTOR_FIT_OPTIONS: { value: boolean | null; label: string }[] = [
  { value: true, label: '😊 Strong Fit' },
  { value: false, label: '😕 Weak Fit' },
  { value: null, label: '😐 Unclear Fit' },
];

const INVESTORS_COLUMN_ORDER_KEY = 'investors-column-order';
const INVESTORS_COLUMN_VISIBILITY_KEY = 'investors-column-visibility';
const INVESTORS_CLIPBOARD_COLUMN_KEY = 'investors-clipboard-column';
const INVESTORS_CLIPBOARD_LINKEDIN_COLUMN_KEY = 'investors-clipboard-linkedin-column';
const INVESTORS_SUBJECT_COLUMN_KEY = 'investors-subject-column';
const INVESTORS_PHONE_CLICK_BEHAVIOR_KEY = 'investors-phone-click-behavior';
const INVESTORS_FILTERS_KEY = 'investors-filters';

/** Stored filter format (onboarding-like structure) for localStorage */
interface StoredInvestorFilters {
  step0?: { primaryUse: string };
  step6?: { sector: string[] };
  step7?: { stage: string[] };
  step8?: { hqCountry: string };
  step10?: Record<string, unknown>;
  step11?: { lookingToRaiseFrom: string[] };
  step12?: { investorType: string };
}

function storedToFilters(stored: StoredInvestorFilters | null): Partial<InvestorSearchFilters> {
  if (!stored) return {};
  const partial: Partial<InvestorSearchFilters> = {};
  if (stored.step6?.sector?.length) partial.investment_industries = [...stored.step6.sector];
  if (stored.step7?.stage?.length) {
    const stage = stored.step7.stage;
    partial.investment_stages = Array.isArray(stage) ? [...stage] : [stage];
  }
  if (stored.step8?.hqCountry?.trim()) {
    const hq = stored.step8.hqCountry.trim();
    // Region names (MENA, APAC, etc.) pass through as-is; country names resolve to ISO code
    const REGION_NAMES = ['North America', 'MENA', 'APAC', 'LATAM', 'EMEA', 'Sub-Saharan Africa'];
    const regionMatch = REGION_NAMES.find(r => r.toLowerCase() === hq.toLowerCase());
    const resolved = regionMatch || resolveCountryInput(hq);
    if (resolved) partial.investment_geographies = [resolved];
  }
  if (stored.step11?.lookingToRaiseFrom?.length) partial.investor_type = [...stored.step11.lookingToRaiseFrom];
  if (stored.step12?.investorType) {
    const t = stored.step12.investorType;
    // Note: type (Firm/Person) is persisted separately via investors-type; step12 maps to leads_round only
    partial.leads_round = t === 'lead' ? true : t === 'follow_on' ? false : null;
  }
  return partial;
}

function onboardingToStored(onboarding: { step0?: { primaryUse?: string }; step6?: { sector?: string[] }; step7?: { stage?: string | string[] }; step8?: { hqCountry?: string }; step10?: Record<string, unknown>; step11?: { lookingToRaiseFrom?: string[] }; step12?: { investorType?: string } } | null): StoredInvestorFilters | null {
  if (!onboarding) return null;
  const stored: StoredInvestorFilters = {};
  if (onboarding.step0?.primaryUse) stored.step0 = { primaryUse: onboarding.step0.primaryUse };
  if (onboarding.step6?.sector?.length) stored.step6 = { sector: [...onboarding.step6.sector] };
  if (onboarding.step7?.stage) {
    const s = onboarding.step7.stage;
    stored.step7 = { stage: Array.isArray(s) ? [...s] : [s] };
  }
  if (onboarding.step8?.hqCountry?.trim()) stored.step8 = { hqCountry: onboarding.step8.hqCountry.trim() };
  if (onboarding.step10 && Object.keys(onboarding.step10).length > 0) stored.step10 = { ...onboarding.step10 };
  if (onboarding.step11?.lookingToRaiseFrom?.length) stored.step11 = { lookingToRaiseFrom: [...onboarding.step11.lookingToRaiseFrom] };
  if (onboarding.step12?.investorType) stored.step12 = { investorType: onboarding.step12.investorType };
  return Object.keys(stored).length ? stored : null;
}

function filtersToStored(filters: InvestorSearchFilters): StoredInvestorFilters {
  const stored: StoredInvestorFilters = { step0: { primaryUse: 'fundraising' } };
  if (filters.investment_industries?.length) stored.step6 = { sector: [...filters.investment_industries] };
  if (filters.investment_stages?.length) stored.step7 = { stage: [...filters.investment_stages] };
  if (filters.investment_geographies?.length) {
    const geo = filters.investment_geographies[0].trim();
    // Region names (MENA, APAC, etc.) pass through as-is; ISO codes convert to country name
    const REGION_NAMES = ['North America', 'MENA', 'APAC', 'LATAM', 'EMEA', 'Sub-Saharan Africa'];
    const regionMatch = REGION_NAMES.find(r => r.toLowerCase() === geo.toLowerCase());
    stored.step8 = { hqCountry: regionMatch || getCountryName(geo) || geo };
  }
  stored.step10 = {};
  if (filters.investor_type?.length) stored.step11 = { lookingToRaiseFrom: [...filters.investor_type] };
  const investorType =
    filters.leads_round === true ? 'lead' : filters.leads_round === false ? 'follow_on' : 'both';
  stored.step12 = { investorType };
  return stored;
}

const INVESTOR_BASE_COLUMNS = [
  'name',
  'role',
  'tier',
  'investor_type',
  'investment_stages',
  'investment_industries',
  'investment_geographies',
  'hq_location',
  'investment_thesis',
  'fund_size_usd',
  'check_size_min_usd',
  'check_size_max_usd',
  'domain',
  'linkedin_url',
  'email',
  'phone',
  'set_name',
  'stage',
  'owner',
  'investor_fit',
  'twitter_line',
  'line1',
  'line2',
  'additional_line',
  'mutual_interests',
  'reason',
  'notes',
];

const EDITABLE_AI_METADATA_COLUMNS = ['twitter_line', 'line1', 'line2', 'additional_line', 'mutual_interests'] as const;

const DEFAULT_FILTERS: InvestorSearchFilters = {
  type: 'firm',
  mode: 'global',
  name: '',
  active: true,
  role: [],
  hq_state: null,
  hq_country: null,
  investor_type: [],
  tier: [],
  fund_size_min: null,
  fund_size_max: null,
  check_size_min: null,
  check_size_max: null,
  investment_stages: [],
  investment_industries: [],
  investment_geographies: [],
  leads_round: null,
  reviewed_stage: [],
  set: [],
  owner: [],
  investor_fit: [],
  domains: [],
  linkedin_urls: [],
};

const formatKebabLabel = (value: string): string =>
  value
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');

function parseNumericInput(value: string): number | null {
  const cleaned = value.replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

export default function InvestorsPage() {
  return (
    <ProtectedRoute>
      <MainLayout>
        <div className="flex-1 overflow-auto">
          <InvestorsContent />
        </div>
      </MainLayout>
    </ProtectedRoute>
  );
}

function InvestorsContent() {
  const { user } = useAuth();
  const { availableOwners, isFreePlan, plan } = useOwner();
  const router = useRouter();
  const { openPricingModal, openROIModal } = usePricingModal();
  const { onboarding } = useOnboarding();
  const { templates } = useMessageTemplates();
  const [investorSets, setInvestorSets] = useState<string[]>([]);
  const [emailSettings, setEmailSettings] = useState<EmailSettings | null>(null);
  const [columnSettingsFromApi, setColumnSettingsFromApi] = useState<{
    columnOrder?: string[];
    visibleColumns?: string[];
    clipboardColumn?: string | null;
    clipboardLinkedInColumn?: string | null;
    subjectColumn?: string | null;
    phoneClickBehavior?: 'whatsapp' | 'call';
  } | null>(null);
  // Track whether a coinvestor search from another page (e.g. New Fundings) was found at init
  const hadCoinvestorSearchAtInit = useRef(false);
  const [filters, setFilters] = useState<InvestorSearchFilters>(() => {
    const base = { ...DEFAULT_FILTERS };
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('investors-mode');
      if (saved === 'global' || saved === 'reviewed') base.mode = saved;
      const savedType = localStorage.getItem('investors-type');
      if (savedType === 'firm' || savedType === 'person') base.type = savedType;

      // Check for pending coinvestor search from another page (e.g. New Fundings).
      // Apply domains/linkedin_urls to the initial state so the very first fetch
      // uses them, avoiding a flash of unfiltered results.
      const coinvestorRaw = localStorage.getItem('new-fundings-coinvestor-search');
      if (coinvestorRaw) {
        try {
          const { investors } = JSON.parse(coinvestorRaw) as { investors: string[]; companyName: string };
          if (Array.isArray(investors) && investors.length > 0) {
            const { domains, linkedin_urls } = parseNameUrlListToSearchParams(investors);
            if (domains.length > 0 || linkedin_urls.length > 0) {
              base.name = '';
              base.domains = domains;
              base.linkedin_urls = linkedin_urls;
              hadCoinvestorSearchAtInit.current = true;
            }
          }
        } catch {
          // ignore malformed data
        }
      }

      // Also apply stored filters from localStorage (if no coinvestor search overrides them)
      if (!hadCoinvestorSearchAtInit.current) {
        const raw = localStorage.getItem(INVESTORS_FILTERS_KEY);
        if (raw && raw !== 'null') {
          try {
            const stored = JSON.parse(raw) as StoredInvestorFilters | null;
            if (stored) {
              const partial = storedToFilters(stored);
              Object.assign(base, partial);
            }
          } catch {
            // fall through
          }
        }
      }
    }
    return base;
  });
  const hasAppliedOnboardingFallback = useRef(false);
  const clearedFiltersRef = useRef(false);
  const skipNextPersistRef = useRef(true);
  const [localSearchInput, setLocalSearchInput] = useState('');
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [investorToView, setInvestorToView] = useState<InvestorSearchResult | null>(null);
  /** When viewing a firm opened from a person, the person we came from (for "Back to person") */
  const [backToInvestor, setBackToInvestor] = useState<InvestorSearchResult | null>(null);
  /** When viewing a person opened from firm's Contacts tab, the firm we came from (for "Back to firm") */
  const [backToFirm, setBackToFirm] = useState<InvestorSearchResult | null>(null);
  const [toastMessage, setToastMessage] = useState('');
  const [toastVisible, setToastVisible] = useState(false);
  const [reportMissingModalOpen, setReportMissingModalOpen] = useState(false);
  const [insufficientCreditsModalOpen, setInsufficientCreditsModalOpen] = useState(false);
  /** When set, search results are filtered by co-investors (p_domains/p_linkedin_urls); chip shows "Notable co-investors of {name}" */
  const [coInvestorsChipLabel, setCoInvestorsChipLabel] = useState<string | null>(null);
  const [findCompanyModalOpen, setFindCompanyModalOpen] = useState(false);
  const [findCompanyInput, setFindCompanyInput] = useState('');
  const [findCompanyLoading, setFindCompanyLoading] = useState(false);
  const [findCompanyError, setFindCompanyError] = useState<string | null>(null);
  /** Tracks the original investors from "Find investors of a company" to detect missing ones after search */
  const [pendingInvestorSearch, setPendingInvestorSearch] = useState<{
    company: string;
    originalInvestors: string[];
    searchedDomains: string[];
    searchedLinkedinUrls: string[];
  } | null>(null);
  const [analyzingIds, setAnalyzingIds] = useState<Set<string>>(new Set());
  const [analyzingAllCount, setAnalyzingAllCount] = useState(0);
  const [showCelebration, setShowCelebration] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);
  /** Pending analyze results for immediate card update before refresh completes */
  const [pendingAnalyzeResults, setPendingAnalyzeResults] = useState<
    Record<string, { investor_fit: boolean | null; reason: string | null }>
  >({});
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  // Table drag-to-pan state
  const [isDragging, setIsDragging] = useState(false);
  const [dragStartX, setDragStartX] = useState(0);
  const [scrollStartX, setScrollStartX] = useState(0);
  const tableScrollContainerRef = useRef<HTMLDivElement>(null);

  // Inline editing state for ai_metadata columns (twitter_line, line1, line2, additional_line, mutual_interests)
  const [editingCell, setEditingCell] = useState<{
    investorId: string;
    columnKey: 'twitter_line' | 'line1' | 'line2' | 'additional_line' | 'mutual_interests';
    value: string;
  } | null>(null);
  const editInputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  // Row hover state - when a row is hovered, all cells in that row expand
  const [hoveredRowId, setHoveredRowId] = useState<string | null>(null);

  // Multi-select state (table view only; global + reviewed)
  const [selectedInvestorIds, setSelectedInvestorIds] = useState<Set<string>>(new Set());
  const [assignSetModalOpen, setAssignSetModalOpen] = useState(false);
  const [assignOwnerModalOpen, setAssignOwnerModalOpen] = useState(false);
  const [assignStageModalOpen, setAssignStageModalOpen] = useState(false);
  const [assignSetSelected, setAssignSetSelected] = useState('');
  const [assignSetNewName, setAssignSetNewName] = useState('');
  const [assignOwner, setAssignOwner] = useState('');
  const [assignStage, setAssignStage] = useState('');

  // View mode state (table or list)
  const [viewMode, setViewMode] = useState<'table' | 'list'>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('investors-view-mode');
      return (saved === 'list' || saved === 'table') ? saved : 'list';
    }
    return 'list';
  });
  const [columnFilterOpen, setColumnFilterOpen] = useState(false);

  const getTemplateColumnKeys = useCallback(() => {
    return templates.map((t) => `template_${t.id}`);
  }, [templates]);

  const [columnOrder, setColumnOrder] = useState<string[]>(() => {
    const initialDefault = [...INVESTOR_BASE_COLUMNS, ...templates.map((t) => `template_${t.id}`)];
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(INVESTORS_COLUMN_ORDER_KEY);
      if (saved) {
        try {
          const parsed = JSON.parse(saved) as string[];
          if (Array.isArray(parsed) && parsed.length > 0) {
            const savedBase = parsed.filter((c) => !c.startsWith('template_'));
            const missing = INVESTOR_BASE_COLUMNS.filter((c) => !savedBase.includes(c));
            const currentTemplates = templates.map((t) => `template_${t.id}`);
            const order = [...savedBase, ...missing, ...currentTemplates.filter((tc) => parsed.includes(tc)), ...currentTemplates.filter((tc) => !parsed.includes(tc))];
            return order;
          }
        } catch {
          // fall through
        }
      }
    }
    return initialDefault;
  });
  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(() => {
    const initialDefault = new Set([...INVESTOR_BASE_COLUMNS, ...templates.map((t) => `template_${t.id}`)]);
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(INVESTORS_COLUMN_VISIBILITY_KEY);
      if (saved) {
        try {
          const parsed = JSON.parse(saved) as string[];
          const set = new Set(parsed.length ? parsed : INVESTOR_BASE_COLUMNS);
          INVESTOR_BASE_COLUMNS.forEach((c) => set.add(c));
          templates.forEach((t) => set.add(`template_${t.id}`));
          return set;
        } catch {
          return initialDefault;
        }
      }
    }
    return initialDefault;
  });
  const [clipboardColumn, setClipboardColumn] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      const raw = localStorage.getItem(INVESTORS_CLIPBOARD_COLUMN_KEY) || null;
      if (raw?.startsWith('template_') || raw?.startsWith('template_label:')) return null;
      return raw;
    }
    return null;
  });
  const [clipboardLinkedInColumn, setClipboardLinkedInColumn] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      const raw = localStorage.getItem(INVESTORS_CLIPBOARD_LINKEDIN_COLUMN_KEY) || null;
      if (raw?.startsWith('template_') || raw?.startsWith('template_label:')) return null;
      return raw;
    }
    return null;
  });
  const [subjectColumn, setSubjectColumn] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      const raw = localStorage.getItem(INVESTORS_SUBJECT_COLUMN_KEY) || null;
      if (raw?.startsWith('template_') || raw?.startsWith('template_label:')) return null;
      return raw;
    }
    return null;
  });
  const [phoneClickBehavior, setPhoneClickBehavior] = useState<'whatsapp' | 'call'>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(INVESTORS_PHONE_CLICK_BEHAVIOR_KEY);
      return saved === 'call' || saved === 'whatsapp' ? saved : 'whatsapp';
    }
    return 'whatsapp';
  });

  const pageSize = isFreePlan ? 5 : 20;
  const excludeInvestors = onboarding?.excludeInvestors ?? undefined;
  const { data, loading, error, hasMore, page, setPage, loadMore, refresh } =
    useInvestorSearch({ filters, pageSize, excludeInvestors });

  // Fetch investor sets (used in drawer pipeline and reviewed filters)
  const refetchInvestorSets = useCallback(async () => {
    const { data: sets, error } = await supabase.rpc('get_investor_sets');
    if (!error && Array.isArray(sets)) {
      setInvestorSets(sets.filter((s): s is string => typeof s === 'string'));
    }
  }, []);

  useEffect(() => {
    refetchInvestorSets();
  }, [refetchInvestorSets]);

  // Detect and report missing investors after "Find investors of a company" search completes
  useEffect(() => {
    // Only run when search completes (loading becomes false) and we have pending search data
    if (loading || !pendingInvestorSearch) return;

    const { company, originalInvestors, searchedDomains, searchedLinkedinUrls } = pendingInvestorSearch;

    // Extract found domains and linkedin URLs from search results
    const foundDomains = new Set<string>();
    const foundLinkedinUrls = new Set<string>();
    for (const investor of data) {
      if (investor.domain) {
        foundDomains.add(investor.domain.toLowerCase());
      }
      if (investor.linkedin_url) {
        // Normalize to match format: in/username
        const url = investor.linkedin_url.toLowerCase();
        const match = url.match(/linkedin\.com\/(.+)/);
        if (match) {
          foundLinkedinUrls.add(match[1].replace(/^\/+/, '').replace(/\/+$/, ''));
        } else {
          foundLinkedinUrls.add(url.replace(/^\/+/, '').replace(/\/+$/, ''));
        }
      }
    }

    // Find missing domains and linkedin URLs
    const missingDomains = searchedDomains.filter((d) => !foundDomains.has(d.toLowerCase()));
    const missingLinkedinUrls = searchedLinkedinUrls.filter((url) => {
      const normalized = url.toLowerCase().replace(/^\/+/, '').replace(/\/+$/, '');
      return !foundLinkedinUrls.has(normalized);
    });

    // Map back to original investor entries for cleaner reporting
    const missingInvestors: string[] = [];
    for (const inv of originalInvestors) {
      const match = inv.trim().match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (!match) continue;
      const urlRaw = match[2].trim();
      try {
        const href = urlRaw.startsWith('http') ? urlRaw : `https://${urlRaw}`;
        const parsed = new URL(href);
        const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
        if (host.includes('linkedin.com')) {
          const path = (parsed.pathname || '').toLowerCase().replace(/^\/+/, '').replace(/\/+$/, '');
          if (missingLinkedinUrls.some((m) => m.toLowerCase() === path)) {
            missingInvestors.push(inv);
          }
        } else {
          if (missingDomains.some((m) => m.toLowerCase() === host)) {
            missingInvestors.push(inv);
          }
        }
      } catch {
        // skip invalid URLs
      }
    }

    // Report missing investors if any
    if (missingInvestors.length > 0) {
      const content = `Company: ${company}\nFound: ${data.length}/${originalInvestors.length} investors\n\nMissing investors:\n${missingInvestors.join('\n')}`;
      console.log('[Missing Investors]', { company, found: data.length, total: originalInvestors.length, missing: missingInvestors });

      // Call API to report missing investors (async, fire-and-forget)
      (async () => {
        try {
          const accessToken = await getValidAccessToken();
          if (!accessToken) {
            console.warn('[Missing Investors] No session, skipping report');
            return;
          }
          const res = await fetch('/api/missing-investors', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${accessToken}`,
            },
            body: JSON.stringify({ content }),
          });
          if (!res.ok) {
            console.error('[Missing Investors] Failed to report:', await res.text());
          } else {
            console.log('[Missing Investors] Reported successfully');
          }
        } catch (err) {
          console.error('[Missing Investors] Error reporting:', err);
        }
      })();
    }

    // Clear pending search data
    setPendingInvestorSearch(null);
  }, [loading, data, pendingInvestorSearch]);

  // Fetch email_settings and column_settings.investors from user_settings
  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('user_settings')
        .select('email_settings, column_settings')
        .eq('id', user.id)
        .single();
      if (cancelled) return;
      const es = data?.email_settings;
      if (es && typeof es === 'object') {
        const parsed = typeof es === 'string' ? JSON.parse(es) : es;
        if (parsed && (parsed.provider === 'gmail' || parsed.provider === 'outlook')) {
          setEmailSettings({
            provider: parsed.provider,
            signature: typeof parsed.signature === 'string' ? parsed.signature : '',
          });
        } else {
          setEmailSettings(null);
        }
      } else {
        setEmailSettings(null);
      }
      const cs = data?.column_settings;
      if (cs && typeof cs === 'object') {
        const parsed = typeof cs === 'string' ? JSON.parse(cs) : cs;
        const investors = parsed?.investors;
        if (investors && typeof investors === 'object' && (Array.isArray(investors.columnOrder) || Array.isArray(investors.visibleColumns))) {
          setColumnSettingsFromApi(investors);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [user?.id]);

  // Apply column_settings.investors from API when loaded (once)
  useEffect(() => {
    if (!columnSettingsFromApi) return;
    const cs = columnSettingsFromApi;
    if (Array.isArray(cs.columnOrder) && cs.columnOrder.length > 0) {
      const savedBase = cs.columnOrder.filter(
        (c) => !c.startsWith('template_')
      );
      const missing = INVESTOR_BASE_COLUMNS.filter((c) => !savedBase.includes(c));
      const currentTemplates = getTemplateColumnKeys();
      const order = [...savedBase, ...missing, ...currentTemplates.filter((tc) => cs.columnOrder!.includes(tc)), ...currentTemplates.filter((tc) => !cs.columnOrder!.includes(tc))];
      setColumnOrder(order);
    }
    if (Array.isArray(cs.visibleColumns) && cs.visibleColumns.length > 0) {
      const next = new Set(cs.visibleColumns);
      INVESTOR_BASE_COLUMNS.forEach((c) => next.add(c));
      getTemplateColumnKeys().forEach((c) => next.add(c));
      setVisibleColumns(next);
    }
    if (cs.clipboardColumn != null) {
      const resolved = templates.length > 0 ? storedToColumnKeyForTemplateSelection(cs.clipboardColumn, templates) : cs.clipboardColumn;
      setClipboardColumn(resolved ?? cs.clipboardColumn);
    }
    if (cs.clipboardLinkedInColumn != null) {
      const resolved = templates.length > 0 ? storedToColumnKeyForTemplateSelection(cs.clipboardLinkedInColumn, templates) : cs.clipboardLinkedInColumn;
      setClipboardLinkedInColumn(resolved ?? cs.clipboardLinkedInColumn);
    }
    if (cs.subjectColumn != null) {
      const resolved = templates.length > 0 ? storedToColumnKeyForTemplateSelection(cs.subjectColumn, templates) : cs.subjectColumn;
      setSubjectColumn(resolved ?? cs.subjectColumn);
    }
    if (cs.phoneClickBehavior) setPhoneClickBehavior(cs.phoneClickBehavior);
    setColumnSettingsFromApi(null);
  }, [columnSettingsFromApi, getTemplateColumnKeys]);

  // Re-resolve LinkedIn/Email/Subject column selections when templates change (e.g. template deleted and recreated with same name)
  useEffect(() => {
    if (templates.length === 0) return;
    const storedClipboard = typeof window !== 'undefined' ? localStorage.getItem(INVESTORS_CLIPBOARD_COLUMN_KEY) : null;
    const storedLinkedIn = typeof window !== 'undefined' ? localStorage.getItem(INVESTORS_CLIPBOARD_LINKEDIN_COLUMN_KEY) : null;
    const storedSubject = typeof window !== 'undefined' ? localStorage.getItem(INVESTORS_SUBJECT_COLUMN_KEY) : null;
    const resolvedClipboard = storedClipboard ? storedToColumnKeyForTemplateSelection(storedClipboard, templates) : null;
    const resolvedLinkedIn = storedLinkedIn ? storedToColumnKeyForTemplateSelection(storedLinkedIn, templates) : null;
    const resolvedSubject = storedSubject ? storedToColumnKeyForTemplateSelection(storedSubject, templates) : null;
    setClipboardColumn((prev) => (storedClipboard ? (resolvedClipboard ?? null) : prev));
    setClipboardLinkedInColumn((prev) => (storedLinkedIn ? (resolvedLinkedIn ?? null) : prev));
    setSubjectColumn((prev) => (storedSubject ? (resolvedSubject ?? null) : prev));
  }, [templates]);

  // Sync column order when templates change
  useEffect(() => {
    const currentTemplates = getTemplateColumnKeys();
    setColumnOrder((prev) => {
      const base = prev.filter((c) => !c.startsWith('template_'));
      const existingTemplates = prev.filter((c) => c.startsWith('template_'));
      const newTemplates = currentTemplates.filter((tc) => !existingTemplates.includes(tc));
      return [...base, ...existingTemplates.filter((tc) => currentTemplates.includes(tc)), ...newTemplates];
    });
    setVisibleColumns((prev) => {
      const next = new Set(prev);
      currentTemplates.forEach((c) => next.add(c));
      prev.forEach((c) => {
        if (c.startsWith('template_') && !currentTemplates.includes(c)) next.delete(c);
      });
      return next;
    });
  }, [getTemplateColumnKeys]);

  // Auto-assign Clipboard Column ← Sequence 1 (email1), Subject Column ← Subject (subjectline), LinkedIn Column ← Sequence 1
  useEffect(() => {
    const subjectTemplate = templates.find((t) => t.channel === 'email' && t.title === 'Subject');
    const sequence1Template = templates.find((t) => t.channel === 'email' && t.title === 'Sequence 1');
    setSubjectColumn((prev) => {
      if (prev) return prev;
      if (subjectTemplate) return `template_${subjectTemplate.id}`;
      return prev;
    });
    setClipboardColumn((prev) => {
      if (prev) return prev;
      if (sequence1Template) return `template_${sequence1Template.id}`;
      return prev;
    });
    setClipboardLinkedInColumn((prev) => {
      if (prev) return prev;
      if (sequence1Template) return `template_${sequence1Template.id}`;
      return prev;
    });
  }, [templates]);

  // Save view mode to localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('investors-view-mode', viewMode);
    }
  }, [viewMode]);

  // Save All/Reviewed mode to localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('investors-mode', filters.mode);
    }
  }, [filters.mode]);

  // Save Firm/Person type to localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('investors-type', filters.type);
    }
  }, [filters.type]);

  // Save column order and visibility to localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(INVESTORS_COLUMN_ORDER_KEY, JSON.stringify(columnOrder));
    }
  }, [columnOrder]);
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(INVESTORS_COLUMN_VISIBILITY_KEY, JSON.stringify(Array.from(visibleColumns)));
    }
  }, [visibleColumns]);
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const stored = columnKeyToStoredForTemplateSelection(clipboardColumn ?? '', templates);
      if (stored) localStorage.setItem(INVESTORS_CLIPBOARD_COLUMN_KEY, stored);
      else localStorage.removeItem(INVESTORS_CLIPBOARD_COLUMN_KEY);
    }
  }, [clipboardColumn, templates]);
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const stored = columnKeyToStoredForTemplateSelection(clipboardLinkedInColumn ?? '', templates);
      if (stored) localStorage.setItem(INVESTORS_CLIPBOARD_LINKEDIN_COLUMN_KEY, stored);
      else localStorage.removeItem(INVESTORS_CLIPBOARD_LINKEDIN_COLUMN_KEY);
    }
  }, [clipboardLinkedInColumn, templates]);
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const stored = columnKeyToStoredForTemplateSelection(subjectColumn ?? '', templates);
      if (stored) localStorage.setItem(INVESTORS_SUBJECT_COLUMN_KEY, stored);
      else localStorage.removeItem(INVESTORS_SUBJECT_COLUMN_KEY);
    }
  }, [subjectColumn, templates]);
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(INVESTORS_PHONE_CLICK_BEHAVIOR_KEY, phoneClickBehavior);
    }
  }, [phoneClickBehavior]);

  const persistInvestorColumnSettings = useCallback(async () => {
    if (!user?.id) return;
    const { data: existing } = await supabase
      .from('user_settings')
      .select('personalization, owners, email_settings, onboarding, column_settings')
      .eq('id', user.id)
      .single();
    let existingColumnSettings: Record<string, unknown> = {};
    const raw = existing?.column_settings;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      existingColumnSettings = raw as Record<string, unknown>;
    }
    const payload = {
      id: user.id,
      personalization: existing?.personalization ?? null,
      owners: existing?.owners ?? null,
      email_settings: existing?.email_settings ?? null,
      onboarding: existing?.onboarding ?? null,
        column_settings: {
        ...existingColumnSettings,
        investors: {
          columnOrder,
          visibleColumns: Array.from(visibleColumns),
          clipboardColumn: columnKeyToStoredForTemplateSelection(clipboardColumn ?? '', templates) || null,
          clipboardLinkedInColumn: columnKeyToStoredForTemplateSelection(clipboardLinkedInColumn ?? '', templates) || null,
          subjectColumn: columnKeyToStoredForTemplateSelection(subjectColumn ?? '', templates) || null,
          phoneClickBehavior,
        },
      },
    };
    const { error } = await supabase.from('user_settings').upsert(payload, { onConflict: 'id' });
    if (error) throw error;
  }, [user?.id, columnOrder, visibleColumns, clipboardColumn, clipboardLinkedInColumn, subjectColumn, phoneClickBehavior, templates]);

  // Sync drawer investor with refreshed data (e.g. after analyze) so personalization fields appear
  useEffect(() => {
    if (investorToView && data.length > 0) {
      const refreshed = data.find((i) => i.id === investorToView.id);
      if (refreshed && refreshed !== investorToView) {
        setInvestorToView(refreshed);
      }
    }
  }, [data, investorToView]);

  const updateInvestor = useCallback(
    async (
      investorId: string,
      updates: {
        notes?: Array<{ message: string; date: string }> | null;
        owner?: string | null;
        set_name?: string | null;
        stage?: string | null;
        ai_metadata?: Record<string, unknown> | null;
      }
    ) => {
      if (!user?.id) throw new Error('User must be logged in');
      const payload: Record<string, unknown> = {};
      if ('notes' in updates) payload.notes = updates.notes ?? null;
      if ('owner' in updates) payload.owner = updates.owner ?? null;
      if ('set_name' in updates) payload.set_name = updates.set_name ?? null;
      if ('stage' in updates) payload.stage = updates.stage ?? null;
      if ('ai_metadata' in updates) payload.ai_metadata = updates.ai_metadata ?? null;
      if (Object.keys(payload).length === 0) return;

      const { error } = await supabase
        .from('investor_personalization')
        .update(payload)
        .eq('investor_id', investorId)
        .eq('user_id', user.id);

      if (error) {
        console.error('Error updating investor personalization:', error);
        throw new Error(error.message || 'Failed to update investor');
      }

      setInvestorToView((prev) =>
        prev?.id === investorId ? { ...prev, ...payload } : prev
      );
      refresh();
    },
    [user?.id, refresh]
  );

  const handleAnalyze = useCallback(
    async (investorId: string, investorName?: string) => {
      setAnalyzingIds((prev) => new Set([...prev, investorId]));
      const result = await fetchInvestorAnalyze(investorId, onboarding ?? undefined, plan ?? undefined);
      setAnalyzingIds((prev) => {
        const next = new Set(prev);
        next.delete(investorId);
        return next;
      });
      if (result?.error) {
        if (result.errorCode === 'INSUFFICIENT_CREDITS') {
          setInsufficientCreditsModalOpen(true);
        } else {
          setToastMessage(result.error);
          setToastVisible(true);
        }
      } else {
        const name = investorName?.trim() || 'Investor';
        const investorFit = result?.investor_fit ?? null;
        const reason = result?.reason ?? null;

        // Update card immediately with investor_fit and reason
        setPendingAnalyzeResults((prev) => ({
          ...prev,
          [investorId]: { investor_fit: investorFit, reason },
        }));

        if (investorFit === true) {
          setShowCelebration(true);
          setToastMessage(`${name} is a strong fit for your company`);
          setTimeout(() => setShowCelebration(false), 3500);
        } else {
          setToastMessage('Investor analyzed successfully.');
        }
        setToastVisible(true);
        refresh();

        // If good fit or null, fetch full investor and auto-open drawer
        if (investorFit === true || investorFit === null) {
          const fullInvestor = await fetchInvestorById(investorId, {
            type: filters.type,
            mode: filters.mode,
          }, excludeInvestors);
          if (fullInvestor) {
            setInvestorToView({
              ...fullInvestor,
              has_personalization: true,
              ai_metadata: {
                ...fullInvestor.ai_metadata,
                investor_fit: investorFit,
                reason,
              },
            });
            setDrawerOpen(true);
          }
        }

        // Clear pending result after a short delay (refresh will have updated data)
        setTimeout(() => {
          setPendingAnalyzeResults((prev) => {
            const next = { ...prev };
            delete next[investorId];
            return next;
          });
        }, 2000);
      }
    },
    [refresh, filters.type, filters.mode, onboarding, plan]
  );

  const handleAnalyzeAll = useCallback(async () => {
    const ids = Array.from(selectedInvestorIds);
    if (ids.length === 0) return;
    setAnalyzingAllCount(ids.length);
    let done = 0;
    let hadError = false;
    let insufficientCredits = false;
    for (const investorId of ids) {
      setAnalyzingIds((prev) => new Set([...prev, investorId]));
      const result = await fetchInvestorAnalyze(investorId, onboarding ?? undefined, plan ?? undefined);
      setAnalyzingIds((prev) => {
        const next = new Set(prev);
        next.delete(investorId);
        return next;
      });
      done += 1;
      setAnalyzingAllCount((prev) => Math.max(0, prev - 1));
      if (result?.error) {
        hadError = true;
        if (result.errorCode === 'INSUFFICIENT_CREDITS') {
          insufficientCredits = true;
          setInsufficientCreditsModalOpen(true);
          break;
        }
        setToastMessage(result.error);
        setToastVisible(true);
        break;
      }
      const investorFit = result?.investor_fit ?? null;
      const reason = result?.reason ?? null;
      setPendingAnalyzeResults((prev) => ({
        ...prev,
        [investorId]: { investor_fit: investorFit, reason },
      }));
    }
    if (!insufficientCredits) {
      setToastMessage(hadError ? 'Some analyses failed.' : `Analyzed ${done} investor${done === 1 ? '' : 's'} successfully.`);
      setToastVisible(true);
    }
    setAnalyzingAllCount(0);
    refresh();
    setSelectedInvestorIds((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.delete(id));
      return next;
    });
    setTimeout(() => {
      setPendingAnalyzeResults((prev) => {
        const next = { ...prev };
        ids.forEach((id) => delete next[id]);
        return next;
      });
    }, 2000);
  }, [selectedInvestorIds, data, onboarding, plan, refresh]);

  // Initial load: mark onboarding fallback as handled if we already applied stored filters
  // or coinvestor search in the useState initializer (client-only, runs once on mount).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    // If coinvestor search was applied at init, skip stored-filter logic
    if (hadCoinvestorSearchAtInit.current) {
      hasAppliedOnboardingFallback.current = true;
      return;
    }
    const raw = localStorage.getItem(INVESTORS_FILTERS_KEY);
    if (raw === 'null') {
      // User explicitly cleared filters - keep DEFAULT_FILTERS, don't apply onboarding
      hasAppliedOnboardingFallback.current = true;
      return;
    }
    if (raw) {
      // Stored filters were already applied in the initializer; just mark onboarding as handled
      hasAppliedOnboardingFallback.current = true;
    }
  }, []);

  // Apply onboarding as fallback when localStorage key is absent (never set)
  useEffect(() => {
    if (hasAppliedOnboardingFallback.current) return;
    if (typeof window === 'undefined') return;
    const raw = localStorage.getItem(INVESTORS_FILTERS_KEY);
    if (raw === 'null') return; // User explicitly cleared - don't apply onboarding
    if (raw) return; // Already have stored filters (handled by first effect)
    if (!onboarding) return;
    const stored = onboardingToStored(onboarding);
    if (stored) {
      const partial = storedToFilters(stored);
      setFilters((prev) => ({ ...prev, ...partial }));
    }
    hasAppliedOnboardingFallback.current = true;
  }, [onboarding]);

  // Pick up pending coinvestor search from another page (e.g. New Fundings).
  // Filter state (domains/linkedin_urls) was already applied in the useState initializer
  // to avoid a flash of unfiltered results. This effect only handles side effects:
  // setting the chip label and cleaning up localStorage.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const raw = localStorage.getItem('new-fundings-coinvestor-search');
    if (!raw) return;
    localStorage.removeItem('new-fundings-coinvestor-search');
    try {
      const { investors, companyName } = JSON.parse(raw) as { investors: string[]; companyName: string };
      if (Array.isArray(investors) && investors.length > 0) {
        const { domains, linkedin_urls } = parseNameUrlListToSearchParams(investors);
        if (domains.length > 0 || linkedin_urls.length > 0) {
          // Filters already applied in useState init; just set the chip label
          setLocalSearchInput('');
          setCoInvestorsChipLabel(`Investors of ${companyName}`);
        }
      }
    } catch {
      // ignore malformed data
    }
  }, []);

  // Persist filters to localStorage when user changes them (excluding debounced name)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (skipNextPersistRef.current) {
      skipNextPersistRef.current = false;
      return;
    }
    if (clearedFiltersRef.current) {
      clearedFiltersRef.current = false;
      return;
    }
    const stored = filtersToStored(filters);
    localStorage.setItem(INVESTORS_FILTERS_KEY, JSON.stringify(stored));
  }, [
    filters.type,
    filters.investment_industries,
    filters.investment_stages,
    filters.investment_geographies,
    filters.investor_type,
    filters.leads_round,
  ]);

  const handleClearFilters = useCallback(() => {
    clearedFiltersRef.current = true;
    localStorage.setItem(INVESTORS_FILTERS_KEY, 'null');
    setLocalSearchInput('');
    // Preserve the "Investors of" chip and its associated domains/linkedin_urls
    setFilters((prev) => ({
      ...DEFAULT_FILTERS,
      type: prev.type,
      mode: prev.mode,
      ...(coInvestorsChipLabel ? { domains: prev.domains, linkedin_urls: prev.linkedin_urls } : {}),
    }));
  }, [coInvestorsChipLabel]);

  // Debounced search - cleans domains and LinkedIn URLs before searching
  useEffect(() => {
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => {
      const cleanedInput = cleanSearchInput(localSearchInput);
      setFilters((prev) => ({ ...prev, name: cleanedInput }));
    }, 400);
    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    };
  }, [localSearchInput]);

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
        searchTimeoutRef.current = null;
      }
      const cleanedInput = cleanSearchInput(localSearchInput);
      setFilters((prev) => ({ ...prev, name: cleanedInput }));
    }
  };

  const handleClearSearch = () => {
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
      searchTimeoutRef.current = null;
    }
    setLocalSearchInput('');
    setCoInvestorsChipLabel(null);
    setPendingInvestorSearch(null);
    setFilters((prev) => ({ ...prev, name: '', domains: [], linkedin_urls: [] }));
  };

  const handleSearchCoinvestors = useCallback((nameUrlList: string[], sourceName: string) => {
    const { domains, linkedin_urls } = parseNameUrlListToSearchParams(nameUrlList);
    if (domains.length === 0 && linkedin_urls.length === 0) return;
    setFilters((prev) => ({
      ...prev,
      name: '',
      domains,
      linkedin_urls,
    }));
    setLocalSearchInput('');
    setCoInvestorsChipLabel(`Notable co-investors of ${sourceName}`);
    // Track original investors for missing detection
    setPendingInvestorSearch({
      company: `Co-investors of ${sourceName}`,
      originalInvestors: nameUrlList,
      searchedDomains: domains,
      searchedLinkedinUrls: linkedin_urls,
    });
    setDrawerOpen(false);
    setInvestorToView(null);
    setBackToInvestor(null);
    setBackToFirm(null);
  }, []);

  /** Apply a list of [name](url) investors to search (reusable from find-company or elsewhere). */
  const applyInvestorsListToSearch = useCallback((investors: string[], chipLabel: string) => {
    const { domains, linkedin_urls } = parseNameUrlListToSearchParams(investors);
    if (domains.length === 0 && linkedin_urls.length === 0) return false;
    setFilters((prev) => ({
      ...prev,
      name: '',
      domains,
      linkedin_urls,
    }));
    setLocalSearchInput('');
    setCoInvestorsChipLabel(chipLabel);
    return true;
  }, []);

  const handleFindCompanyInvestorsSubmit = useCallback(async () => {
    const company = findCompanyInput.trim();
    if (!company) return;
    setFindCompanyError(null);
    setFindCompanyLoading(true);
    try {
      const res = await fetch('/api/find-company-investors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFindCompanyError(data.error || `Request failed (${res.status})`);
        return;
      }
      const investors = Array.isArray(data.investors) ? data.investors : [];
      console.log('[Find company investors]', { company, status: res.status, investorsCount: investors.length, investors });
      
      // Parse investors to track what we're searching for
      const { domains, linkedin_urls } = parseNameUrlListToSearchParams(investors);
      
      const applied = applyInvestorsListToSearch(investors, `Investors of ${company}`);
      if (applied) {
        // Store original investors for missing detection after search completes
        setPendingInvestorSearch({
          company,
          originalInvestors: investors,
          searchedDomains: domains,
          searchedLinkedinUrls: linkedin_urls,
        });
        setFindCompanyModalOpen(false);
        setFindCompanyInput('');
      } else {
        setFindCompanyError('No valid investors found. Try a different company or description.');
      }
    } catch (e) {
      setFindCompanyError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setFindCompanyLoading(false);
    }
  }, [findCompanyInput, applyInvestorsListToSearch]);

  const updateFilter = useCallback(<K extends keyof InvestorSearchFilters>(
    key: K,
    value: InvestorSearchFilters[K]
  ) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }, []);

  const toggleArrayFilter = useCallback((
    key: 'investor_type' | 'tier' | 'investment_stages' | 'investment_industries' | 'investment_geographies' | 'reviewed_stage' | 'set' | 'owner' | 'role',
    item: string
  ) => {
    setFilters((prev) => {
      const arr = prev[key];
      const next = arr.includes(item) ? arr.filter((x) => x !== item) : [...arr, item];
      return { ...prev, [key]: next };
    });
  }, []);

  const toggleInvestorFitFilter = useCallback((value: boolean | null) => {
    setFilters((prev) => {
      const arr = prev.investor_fit;
      const has = arr.some((v) => v === value);
      const next = has ? arr.filter((v) => v !== value) : [...arr, value];
      return { ...prev, investor_fit: next };
    });
  }, []);

  const columnLabels = useMemo<Record<string, string>>(() => {
    const base: Record<string, string> = {
      name: 'Name',
      role: 'Role',
      tier: 'Tier',
      investor_type: 'Investor Type',
      investment_stages: 'Stages',
      investment_industries: 'Industries',
      investment_geographies: 'Investment Geographies',
      hq_location: 'HQ Location',
      investment_thesis: 'Thesis',
      fund_size_usd: 'Fund Size',
      check_size_min_usd: 'Check Min',
      check_size_max_usd: 'Check Max',
      domain: 'Domain',
      linkedin_url: 'LinkedIn',
      email: 'Email',
      phone: 'Phone',
      set_name: 'Set',
      stage: 'Stage',
      owner: 'Owner',
      investor_fit: 'Fit',
      twitter_line: 'Twitter Line',
      line1: 'Line 1',
      line2: 'Line 2',
      additional_line: 'Additional Line',
      mutual_interests: 'Mutual Interests',
      reason: 'Reason',
      notes: 'Notes',
    };
    templates.forEach((t) => {
      const channelLabel = t.channel === 'direct' ? 'Direct Message' : t.channel === 'instagram' ? 'Instagram Message' : t.channel === 'email' ? 'Email' : t.channel === 'linkedin' ? 'LinkedIn' : t.channel;
      base[`template_${t.id}`] = `${t.title} - ${channelLabel}`;
    });
    return base;
  }, [templates]);

  const toggleColumn = useCallback((column: string) => {
    setVisibleColumns((prev) => {
      const next = new Set(prev);
      if (next.has(column)) next.delete(column);
      else next.add(column);
      return next;
    });
  }, []);

  const orderedVisibleColumns = useMemo(
    () =>
      columnOrder.filter((col) => {
        if (!visibleColumns.has(col)) return false;
        // Hide Role column in Firm mode - Role is only for Person
        if (col === 'role' && filters.type === 'firm') return false;
        return true;
      }),
    [columnOrder, visibleColumns, filters.type]
  );

  const getMessageForInvestorTemplate = useCallback(
    (investor: InvestorSearchResult, templateId: string, pendingAnalyze?: { investor_fit: boolean | null; reason: string | null }): string => {
      if (!investor.has_personalization) return '-';
      const template = templates.find((t) => t.id === templateId);
      if (!template) return '';
      const aiMeta = investor.ai_metadata ?? {};
      const reasonVal = pendingAnalyze?.reason ?? aiMeta.reason;
      const investorData = {
        name: investor.name,
        investment_thesis: investor.investment_thesis,
        ai_metadata: {
          twitter_line: typeof aiMeta.twitter_line === 'string' ? aiMeta.twitter_line : null,
          line1: typeof aiMeta.line1 === 'string' ? aiMeta.line1 : null,
          line2: typeof aiMeta.line2 === 'string' ? aiMeta.line2 : null,
          reason: typeof reasonVal === 'string' ? (reasonVal as string) : null,
          investor_fit: pendingAnalyze?.investor_fit !== undefined ? pendingAnalyze.investor_fit : (typeof aiMeta.investor_fit === 'boolean' || aiMeta.investor_fit === null ? aiMeta.investor_fit : undefined),
        },
      };
      return renderInvestorTemplate(template, investorData, templates);
    },
    [templates]
  );

  const getInvestorCellValue = useCallback(
    (investor: InvestorSearchResult, columnKey: string, pendingAnalyze?: { investor_fit: boolean | null; reason: string | null }): string => {
      const loc = formatHqLocationShort(investor.hq_state, investor.hq_country);
      const aiMeta = investor.ai_metadata ?? {};
      const investorFit =
        pendingAnalyze?.investor_fit !== undefined
          ? pendingAnalyze.investor_fit
          : (aiMeta.investor_fit as boolean | null | undefined);
      const fitLabel =
        investorFit === true ? 'Strong Fit' : investorFit === false ? 'Weak Fit' : investorFit === null ? 'Unclear Fit' : '';

      switch (columnKey) {
        case 'name':
          return investor.name ?? '-';
        case 'role':
          return investor.role ?? '-';
        case 'tier':
          return investor.tier ?? '-';
        case 'investor_type':
          return Array.isArray(investor.investor_type) ? investor.investor_type.join(', ') : '-';
        case 'investment_stages':
          return Array.isArray(investor.investment_stages)
            ? investor.investment_stages.map(formatKebabLabel).join(', ')
            : '-';
        case 'investment_industries':
          return Array.isArray(investor.investment_industries)
            ? investor.investment_industries.map(formatKebabLabel).join(', ')
            : '-';
        case 'investment_geographies':
          return Array.isArray(investor.investment_geographies)
            ? investor.investment_geographies.map(formatGeographyForDisplay).join(', ')
            : '-';
        case 'hq_location':
          return loc || '-';
        case 'investment_thesis':
          return investor.investment_thesis?.trim() ?? '-';
        case 'fund_size_usd':
          return investor.fund_size_usd != null ? String(investor.fund_size_usd) : '-';
        case 'check_size_min_usd':
          return investor.check_size_min_usd != null ? String(investor.check_size_min_usd) : '-';
        case 'check_size_max_usd':
          return investor.check_size_max_usd != null ? String(investor.check_size_max_usd) : '-';
        case 'domain':
          return investor.domain?.trim() ?? '-';
        case 'linkedin_url':
          return investor.linkedin_url?.trim() ?? '-';
        case 'email':
          return investor.email?.trim() ?? '-';
        case 'phone':
          return investor.phone?.trim() ?? '-';
        case 'set_name':
          return investor.set_name ?? '-';
        case 'stage':
          return investor.stage ?? '-';
        case 'owner':
          return investor.owner ?? '-';
        case 'investor_fit':
          return fitLabel || '-';
        case 'twitter_line':
          return (typeof aiMeta.twitter_line === 'string' ? aiMeta.twitter_line : '') || '-';
        case 'line1':
          return (typeof aiMeta.line1 === 'string' ? aiMeta.line1 : '') || '-';
        case 'line2':
          return (typeof aiMeta.line2 === 'string' ? aiMeta.line2 : '') || '-';
        case 'additional_line':
          return (typeof aiMeta.additional_line === 'string' ? aiMeta.additional_line : '') || '-';
        case 'mutual_interests': {
          const interests = Array.isArray(aiMeta.mutual_interests)
            ? (aiMeta.mutual_interests as string[]).filter((s): s is string => typeof s === 'string')
            : [];
          return interests.length > 0 ? interests.join('\n') : '-';
        }
        case 'reason': {
          const r = pendingAnalyze?.reason ?? aiMeta.reason;
          return typeof r === 'string' ? r : '-';
        }
        case 'notes':
          return Array.isArray(investor.notes) && investor.notes.length > 0
            ? investor.notes.map((n) => n.message).join('; ')
            : '-';
        default:
          if (columnKey.startsWith('template_')) {
            const templateId = columnKey.replace('template_', '');
            return getMessageForInvestorTemplate(investor, templateId, pendingAnalyze);
          }
          return '-';
      }
    },
    [getMessageForInvestorTemplate]
  );

  const handleExportCsv = useCallback(async () => {
    const csvEscape = (value: unknown): string => {
      if (value == null) return '';
      const str = String(value);
      return `"${str.replace(/"/g, '""')}"`;
    };
    if (filters.mode !== 'reviewed') return;
    setExportLoading(true);
    try {
      const investors = await fetchInvestorsForExport(filters, excludeInvestors);
      const isPerson = filters.type === 'person';

      const headers: string[] = [
        'Name',
        ...(isPerson ? ['First Name', 'Role', 'Associated Firm Name'] : []),
        'Owner',
        'Stage',
        'Set',
        'LinkedIn URL',
        'Twitter URL',
        'Apply URL',
        'Email 1',
        'Email 2',
        'Phone 1',
        'Phone 2',
        'Investor Fit',
        'Reason',
        'Twitter Line',
        'Line 1',
        'Line 2',
        'Additional Line',
        'Mutual Interests',
        'Notes',
      ];

      const rows = investors.map((inv) => {
        const aiMeta = inv.ai_metadata ?? {};
        const investorFit = aiMeta.investor_fit;
        const fitLabel =
          investorFit === true ? 'Strong Fit' : investorFit === false ? 'Weak Fit' : investorFit === null ? 'Unclear Fit' : '';
        const firstName = inv.name?.trim() ? inv.name.trim().split(/\s+/)[0] || inv.name : '';
        const emails = (inv.email ?? '')
          .split(',')
          .map((e) => e.trim())
          .filter(Boolean)
          .slice(0, 2);
        const phones = (inv.phone ?? '')
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean)
          .slice(0, 2);
        const mutualInterests = Array.isArray(aiMeta.mutual_interests)
          ? (aiMeta.mutual_interests as string[]).filter((s): s is string => typeof s === 'string').join(', ')
          : '';
        const notesStr = Array.isArray(inv.notes) && inv.notes.length > 0
          ? inv.notes.map((n) => (n?.message ?? '').trim()).filter(Boolean).join('; ')
          : '';

        // Ensure full LinkedIn URL (e.g. in/namankas -> https://www.linkedin.com/in/namankas)
        const rawLinkedin = inv.linkedin_url ?? '';
        const fullLinkedin = rawLinkedin
          ? rawLinkedin.startsWith('http')
            ? rawLinkedin
            : `https://www.linkedin.com/${rawLinkedin.replace(/^\/+/, '')}`
          : '';

        const row: string[] = [
          inv.name ?? '',
          ...(isPerson ? [firstName, inv.role ?? '', inv.associated_firm_name ?? ''] : []),
          inv.owner ?? '',
          inv.stage ?? '',
          inv.set_name ?? '',
          fullLinkedin,
          inv.twitter_url ?? '',
          inv.apply_url ?? '',
          emails[0] ?? '',
          emails[1] ?? '',
          phones[0] ?? '',
          phones[1] ?? '',
          fitLabel,
          typeof aiMeta.reason === 'string' ? aiMeta.reason : '',
          typeof aiMeta.twitter_line === 'string' ? aiMeta.twitter_line : '',
          typeof aiMeta.line1 === 'string' ? aiMeta.line1 : '',
          typeof aiMeta.line2 === 'string' ? aiMeta.line2 : '',
          typeof aiMeta.additional_line === 'string' ? aiMeta.additional_line : '',
          mutualInterests,
          notesStr,
        ];
        return row.map(csvEscape).join(',');
      });

      const csvString = [headers.map(csvEscape).join(','), ...rows].join('\n');
      downloadCsv(csvString, `investors-export-${new Date().toISOString().split('T')[0]}.csv`);
      setToastMessage(`Exported ${investors.length} investors to CSV`);
      setToastVisible(true);
    } catch (e) {
      console.error('Export failed', e);
      setToastMessage(e instanceof Error ? e.message : 'Failed to export CSV');
      setToastVisible(true);
    } finally {
      setExportLoading(false);
    }
  }, [filters]);

  const handleInvestorCellClick = useCallback(
    async (investor: InvestorSearchResult, columnKey: string) => {
      if (columnKey === 'domain' || columnKey === 'email') {
        if (clipboardColumn) {
          const val = getInvestorCellValue(investor, clipboardColumn, pendingAnalyzeResults[investor.id]);
          if (val && val !== '-') {
            try {
              await copyToClipboard(val);
              setToastMessage(`${columnLabels[clipboardColumn]} copied to clipboard`);
              setToastVisible(true);
            } catch (e) {
              console.error('Failed to copy', e);
            }
          }
        }
      } else if (columnKey === 'linkedin_url') {
        if (clipboardLinkedInColumn) {
          const val = getInvestorCellValue(investor, clipboardLinkedInColumn, pendingAnalyzeResults[investor.id]);
          if (val && val !== '-') {
            try {
              await copyToClipboard(val);
              setToastMessage(`${columnLabels[clipboardLinkedInColumn]} copied to clipboard`);
              setToastVisible(true);
            } catch (e) {
              console.error('Failed to copy', e);
            }
          }
        }
      } else if (columnKey.startsWith('template_')) {
        const val = getInvestorCellValue(investor, columnKey, pendingAnalyzeResults[investor.id]);
        if (val && val !== '-') {
          try {
            await copyToClipboard(val);
            setToastMessage('Message copied to clipboard');
            setToastVisible(true);
          } catch (e) {
            console.error('Failed to copy', e);
          }
        }
      }
    },
    [clipboardColumn, clipboardLinkedInColumn, getInvestorCellValue, columnLabels]
  );

  // Handle row selection (reviewed mode + table view)
  const handleRowSelect = useCallback((investorId: string, isSelected: boolean) => {
    setSelectedInvestorIds((prev) => {
      const next = new Set(prev);
      if (isSelected) next.add(investorId);
      else next.delete(investorId);
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(
    (isSelected: boolean) => {
      if (isSelected) {
        const ids =
          filters.mode === 'reviewed'
            ? data.filter((i) => i.has_personalization).map((i) => i.id)
            : data.map((i) => i.id);
        setSelectedInvestorIds(new Set(ids));
      } else {
        setSelectedInvestorIds(new Set());
      }
    },
    [data, filters.mode]
  );

  // Bulk update investor_personalization for set_name, owner, or stage
  const bulkUpdateInvestors = useCallback(
    async (
      ids: string[],
      field: 'set_name' | 'owner' | 'stage',
      value: string | null
    ) => {
      if (!user?.id || ids.length === 0) return;
      const trimmed = value?.trim() || null;
      const payload: Record<string, string | null> = { [field]: trimmed };

      const { error } = await supabase
        .from('investor_personalization')
        .update(payload)
        .in('investor_id', ids)
        .eq('user_id', user.id);

      if (error) {
        console.error(`Error bulk updating ${field}:`, error);
        throw new Error(error.message || `Failed to bulk update ${field}`);
      }
      refresh();
    },
    [user?.id, refresh]
  );

  const handleBulkAssignSet = useCallback(async () => {
    if (selectedInvestorIds.size === 0) {
      setToastMessage('Please select at least one investor');
      setToastVisible(true);
      return;
    }
    const setName =
      assignSetSelected === '__create_new_set__'
        ? (assignSetNewName.trim() || null)
        : (assignSetSelected || null);
    if (assignSetSelected === '__create_new_set__' && !assignSetNewName.trim()) {
      setToastMessage('Please enter a set name');
      setToastVisible(true);
      return;
    }
    try {
      const count = selectedInvestorIds.size;
      await bulkUpdateInvestors(Array.from(selectedInvestorIds), 'set_name', setName);
      setSelectedInvestorIds(new Set());
      setAssignSetModalOpen(false);
      setAssignSetSelected('');
      setAssignSetNewName('');
      refetchInvestorSets();
      setToastMessage(`Assigned set "${setName || 'empty'}" to ${count} investor${count === 1 ? '' : 's'}`);
      setToastVisible(true);
    } catch (e) {
      setToastMessage(e instanceof Error ? e.message : 'Failed to assign set');
      setToastVisible(true);
    }
  }, [selectedInvestorIds, assignSetSelected, assignSetNewName, bulkUpdateInvestors, refetchInvestorSets]);

  const handleBulkAssignOwner = useCallback(async () => {
    if (selectedInvestorIds.size === 0) {
      setToastMessage('Please select at least one investor');
      setToastVisible(true);
      return;
    }
    try {
      const count = selectedInvestorIds.size;
      const owner = assignOwner.trim() || null;
      await bulkUpdateInvestors(Array.from(selectedInvestorIds), 'owner', owner);
      setSelectedInvestorIds(new Set());
      setAssignOwnerModalOpen(false);
      setAssignOwner('');
      setToastMessage(`Assigned owner "${owner || 'empty'}" to ${count} investor${count === 1 ? '' : 's'}`);
      setToastVisible(true);
    } catch (e) {
      setToastMessage(e instanceof Error ? e.message : 'Failed to assign owner');
      setToastVisible(true);
    }
  }, [selectedInvestorIds, assignOwner, bulkUpdateInvestors]);

  const handleBulkAssignStage = useCallback(async () => {
    if (selectedInvestorIds.size === 0) {
      setToastMessage('Please select at least one investor');
      setToastVisible(true);
      return;
    }
    try {
      const count = selectedInvestorIds.size;
      const stage = assignStage.trim() || null;
      await bulkUpdateInvestors(Array.from(selectedInvestorIds), 'stage', stage);
      setSelectedInvestorIds(new Set());
      setAssignStageModalOpen(false);
      setAssignStage('');
      setToastMessage(`Assigned stage "${stage || 'empty'}" to ${count} investor${count === 1 ? '' : 's'}`);
      setToastVisible(true);
    } catch (e) {
      setToastMessage(e instanceof Error ? e.message : 'Failed to assign stage');
      setToastVisible(true);
    }
  }, [selectedInvestorIds, assignStage, bulkUpdateInvestors]);

  // Clear selection when switching away from reviewed mode or table view
  useEffect(() => {
    if (filters.mode !== 'reviewed' || viewMode !== 'table') {
      setSelectedInvestorIds(new Set());
    }
  }, [filters.mode, viewMode]);

  const buildReportContent = () => {
    const parts: string[] = [];
    if (coInvestorsChipLabel) parts.push(coInvestorsChipLabel);
    if (filters.name) parts.push(`Search: ${filters.name}`);
    if (filters.investment_stages.length) parts.push(`Stage: ${filters.investment_stages.join(', ')}`);
    if (filters.investment_industries.length) parts.push(`Industry: ${filters.investment_industries.join(', ')}`);
    if (filters.investment_geographies.length) parts.push(`Investment Geography: ${filters.investment_geographies.join(', ')}`);
    if (filters.hq_country) parts.push(`Country: ${filters.hq_country}`);
    if (filters.mode === 'reviewed') {
      if (filters.reviewed_stage.length) parts.push(`Pipeline Stage: ${filters.reviewed_stage.join(', ')}`);
      if (filters.set.length) parts.push(`Sets: ${filters.set.join(', ')}`);
      if (filters.owner.length) parts.push(`Owners: ${filters.owner.join(', ')}`);
      if (filters.investor_fit.length) {
        const labels = filters.investor_fit.map((v) =>
          v === true ? 'Strong Fit' : v === false ? 'Weak Fit' : 'Unclear Fit'
        );
        parts.push(`Investor Fit: ${labels.join(', ')}`);
      }
    }
    return parts.length ? parts.join('\n') : 'No search terms or filters applied';
  };

  // Infinite scroll observer
  useEffect(() => {
    if (!hasMore || loading) return;
    const el = loadMoreRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      { rootMargin: '100px', threshold: 0.1 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loading, loadMore]);

  const handleDrawerPageChange = useCallback(
    (newPage: number) => {
      if (newPage > page && hasMore && !loading) {
        loadMore();
      }
    },
    [page, hasMore, loading, loadMore]
  );

  const handleCellDoubleClick = useCallback(
    (investor: InvestorSearchResult, columnKey: string) => {
      if (!EDITABLE_AI_METADATA_COLUMNS.includes(columnKey as (typeof EDITABLE_AI_METADATA_COLUMNS)[number])) return;
      const value = getInvestorCellValue(investor, columnKey, pendingAnalyzeResults[investor.id]);
      setEditingCell({
        investorId: investor.id,
        columnKey: columnKey as 'twitter_line' | 'line1' | 'line2' | 'additional_line' | 'mutual_interests',
        value: value === '-' ? '' : value,
      });
    },
    [getInvestorCellValue, pendingAnalyzeResults]
  );

  const handleInlineEditSave = useCallback(async () => {
    if (!editingCell) return;
    const { investorId, columnKey, value } = editingCell;
    const investor = data.find((i) => i.id === investorId);
    if (!investor) return;

    const aiMeta = investor.ai_metadata ?? {};
    const trimmed = value.trim();

    let hasChanges = false;
    if (columnKey === 'mutual_interests') {
      const newInterests = trimmed
        ? trimmed
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      const currentInterests = Array.isArray(aiMeta.mutual_interests)
        ? (aiMeta.mutual_interests as string[]).filter((s): s is string => typeof s === 'string')
        : [];
      hasChanges =
        newInterests.length !== currentInterests.length ||
        newInterests.some((s, i) => s !== currentInterests[i]);
    } else {
      const currentVal = typeof aiMeta[columnKey] === 'string' ? (aiMeta[columnKey] as string).trim() || null : null;
      const newVal = trimmed || null;
      hasChanges = currentVal !== newVal;
    }

    if (!hasChanges) {
      setEditingCell(null);
      return;
    }

    const meta = investor.ai_metadata && typeof investor.ai_metadata === 'object' ? { ...investor.ai_metadata } : {};
    if (columnKey === 'mutual_interests') {
      const interests = trimmed
        ? trimmed
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      (meta as Record<string, unknown>).mutual_interests = interests;
    } else {
      (meta as Record<string, unknown>)[columnKey] = trimmed || null;
    }

    try {
      await updateInvestor(investorId, { ai_metadata: meta });
      setEditingCell(null);
      setToastMessage('Personalization saved');
      setToastVisible(true);
    } catch (err) {
      console.error('Error saving ai_metadata:', err);
      setToastMessage(err instanceof Error ? err.message : 'Failed to save');
      setToastVisible(true);
    }
  }, [editingCell, data, updateInvestor]);

  useEffect(() => {
    if (editingCell && editInputRef.current) {
      editInputRef.current.focus();
      if (editInputRef.current instanceof HTMLInputElement || editInputRef.current instanceof HTMLTextAreaElement) {
        editInputRef.current.setSelectionRange(editInputRef.current.value.length, editInputRef.current.value.length);
      }
    }
  }, [editingCell]);

  // Table drag-to-pan handlers
  const handleTableMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (
      target.tagName === 'BUTTON' ||
      target.tagName === 'INPUT' ||
      target.tagName === 'A' ||
      target.tagName === 'SELECT' ||
      target.tagName === 'TEXTAREA' ||
      target.closest('button, input, a, select, textarea')
    ) {
      return;
    }
    setIsDragging(true);
    setDragStartX(e.clientX);
    if (tableScrollContainerRef.current) {
      setScrollStartX(tableScrollContainerRef.current.scrollLeft);
    }
    e.preventDefault();
  }, []);

  const handleTableMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDragging || !tableScrollContainerRef.current) return;
    const deltaX = e.clientX - dragStartX;
    tableScrollContainerRef.current.scrollLeft = scrollStartX - deltaX;
    e.preventDefault();
  }, [isDragging, dragStartX, scrollStartX]);

  const handleTableMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleTableMouseLeave = useCallback(() => {
    setIsDragging(false);
  }, []);

  useEffect(() => {
    if (!isDragging) return;
    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (!tableScrollContainerRef.current) return;
      const deltaX = e.clientX - dragStartX;
      tableScrollContainerRef.current.scrollLeft = scrollStartX - deltaX;
    };
    const handleGlobalMouseUp = () => {
      setIsDragging(false);
    };
    document.addEventListener('mousemove', handleGlobalMouseMove);
    document.addEventListener('mouseup', handleGlobalMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleGlobalMouseMove);
      document.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, [isDragging, dragStartX, scrollStartX]);

  return (
    <div className="p-4 md:p-8 max-w-full mx-auto">
      <div className="mb-4 md:mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <h1 className="text-2xl md:text-3xl font-bold text-gray-900 flex items-center gap-2">
          <Handshake className="w-6 h-6 md:w-8 md:h-8" />
          Investors
        </h1>
        <div className="flex flex-wrap items-center gap-2 self-start">
          {selectedInvestorIds.size > 0 ? (
            <>
              <button
                onClick={() => handleAnalyzeAll()}
                disabled={analyzingAllCount > 0}
                className="inline-flex items-center gap-1.5 px-3 md:px-4 py-2 border border-transparent text-xs md:text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50"
                title="Analyze selected investors with AI"
              >
                {analyzingAllCount > 0 ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Sparkles className="w-4 h-4" />
                )}
                <span className="hidden sm:inline">Analyze all with AI </span>({selectedInvestorIds.size})
              </button>
              {filters.mode === 'reviewed' && (
                <>
                  <button
                    onClick={() => setAssignStageModalOpen(true)}
                    className="inline-flex items-center px-3 md:px-4 py-2 border border-transparent text-xs md:text-sm font-medium rounded-md text-white bg-amber-600 hover:bg-amber-700"
                  >
                    <span className="hidden sm:inline">Assign Stage </span>({selectedInvestorIds.size})
                  </button>
                  <button
                    onClick={() => setAssignSetModalOpen(true)}
                    className="inline-flex items-center px-3 md:px-4 py-2 border border-transparent text-xs md:text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
                  >
                    <span className="hidden sm:inline">Assign Set </span>({selectedInvestorIds.size})
                  </button>
                  <button
                    onClick={() => setAssignOwnerModalOpen(true)}
                    className="inline-flex items-center px-3 md:px-4 py-2 border border-transparent text-xs md:text-sm font-medium rounded-md text-white bg-emerald-600 hover:bg-emerald-700"
                  >
                    <span className="hidden sm:inline">Assign Owner </span>({selectedInvestorIds.size})
                  </button>
                </>
              )}
              <button
                onClick={() => setSelectedInvestorIds(new Set())}
                className="inline-flex items-center gap-1.5 px-3 md:px-4 py-2 border border-gray-300 text-xs md:text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                title={selectedInvestorIds.size === 1 ? 'Clear selection' : 'Clear selections'}
              >
                <X className="w-4 h-4" />
                <span className="hidden sm:inline">
                  Clear {selectedInvestorIds.size === 1 ? 'selection' : 'selections'}
                </span>
              </button>
            </>
          ) : (
            <>
          <button
            onClick={() => setColumnFilterOpen(!columnFilterOpen)}
            className="inline-flex items-center gap-2 px-3 md:px-4 py-2 border border-gray-300 text-xs md:text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 w-full sm:w-auto"
          >
            <Filter className="w-4 h-4" />
            Manage Columns
          </button>
          {/* View Toggle: List/Table (List first, default) */}
          <div className="inline-flex items-center border border-gray-300 rounded-md overflow-hidden bg-white">
            <button
              onClick={() => setViewMode('list')}
              className={`px-3 md:px-4 py-2 transition-colors flex items-center justify-center ${
                viewMode === 'list'
                  ? 'text-white bg-indigo-600 hover:bg-indigo-700'
                  : 'text-gray-700 hover:bg-gray-50'
              }`}
              title="List View"
            >
              <List className="w-4 h-4" />
            </button>
            <div className="h-6 w-px bg-gray-300" />
            <button
              onClick={() => setViewMode('table')}
              className={`px-3 md:px-4 py-2 transition-colors flex items-center justify-center ${
                viewMode === 'table'
                  ? 'text-white bg-indigo-600 hover:bg-indigo-700'
                  : 'text-gray-700 hover:bg-gray-50'
              }`}
              title="Table View"
            >
              <Table className="w-4 h-4" />
            </button>
          </div>
          {/* All / Reviewed toggle */}
          <div className="inline-flex items-center border border-gray-300 rounded-md overflow-hidden bg-white">
            <button
              onClick={() => updateFilter('mode', 'global')}
              className={`px-3 md:px-4 py-2 transition-colors flex items-center justify-center gap-1.5 text-sm font-medium ${
                filters.mode === 'global'
                  ? 'text-white bg-indigo-600 hover:bg-indigo-700'
                  : 'text-gray-700 hover:bg-gray-50'
              }`}
              title="All investors"
            >
              <Globe className="w-4 h-4" />
              All
            </button>
            <div className="h-6 w-px bg-gray-300" />
            <button
              onClick={() => updateFilter('mode', 'reviewed')}
              className={`px-3 md:px-4 py-2 transition-colors flex items-center justify-center gap-1.5 text-sm font-medium ${
                filters.mode === 'reviewed'
                  ? 'text-white bg-indigo-600 hover:bg-indigo-700'
                  : 'text-gray-700 hover:bg-gray-50'
              }`}
              title="Reviewed investors only"
            >
              <CheckCircle2 className="w-4 h-4" />
              Reviewed
            </button>
          </div>
            </>
          )}
        </div>
      </div>

      {/* Manage Columns Drawer */}
      <ManageInvestorColumnsDrawer
        isOpen={columnFilterOpen}
        onClose={() => setColumnFilterOpen(false)}
        columnOrder={columnOrder}
        visibleColumns={visibleColumns}
        columnLabels={columnLabels}
        clipboardColumn={clipboardColumn}
        clipboardLinkedInColumn={clipboardLinkedInColumn}
        subjectColumn={subjectColumn}
        phoneClickBehavior={phoneClickBehavior}
        onColumnOrderChange={setColumnOrder}
        onToggleColumn={toggleColumn}
        onClipboardColumnChange={setClipboardColumn}
        onClipboardLinkedInColumnChange={setClipboardLinkedInColumn}
        onSubjectColumnChange={setSubjectColumn}
        onPhoneClickBehaviorChange={setPhoneClickBehavior}
        onSave={async () => {
          try {
            await persistInvestorColumnSettings();
            setToastMessage('Column settings saved.');
            setToastVisible(true);
            setColumnFilterOpen(false);
          } catch (e) {
            setToastMessage(e instanceof Error ? e.message : 'Failed to save column settings.');
            setToastVisible(true);
          }
        }}
      />

      {/* Search form */}
      <div className="mb-6 space-y-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex flex-col sm:flex-row flex-1 gap-2">
            {/* Search input - full width on mobile, flex on desktop */}
            <div className="relative flex-1">
              {filters.type === 'person' ? (
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              ) : (
                <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              )}
              <input
                type="text"
                placeholder={filters.type === 'person' ? "Search person by name or LinkedIn..." : "Search firm by name, domain, or LinkedIn..."}
                value={localSearchInput}
                onChange={(e) => setLocalSearchInput(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                className="block w-full pl-10 pr-10 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 text-sm"
              />
              {localSearchInput && (
                <button
                  onClick={handleClearSearch}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600"
                  aria-label="Clear search"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
            {/* Buttons row - wraps on mobile, inline on desktop */}
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => setFindCompanyModalOpen(true)}
                className="inline-flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 shrink-0"
              >
                <Building2 className="w-4 h-4" />
                <span className="hidden sm:inline">Find investors of a company</span>
                <span className="sm:hidden">Find by company</span>
              </button>
              <div className="relative">
                <select
                  value={filters.type}
                  onChange={(e) => {
                    const newType = e.target.value as InvestorTypeFilter;
                    setFilters((prev) => ({
                      ...prev,
                      type: newType,
                      role: newType === 'firm' ? [] : prev.role,
                    }));
                  }}
                  className="pl-3 pr-9 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 min-w-[120px] appearance-none"
                >
                  <option value="firm">Firm</option>
                  <option value="person">Person</option>
                </select>
                <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
              </div>
            </div>
          </div>
          <button
            onClick={() => setFiltersExpanded(!filtersExpanded)}
            className={`inline-flex items-center justify-between gap-2 px-4 py-2 border rounded-md text-sm font-medium min-w-[120px] ${
              filtersExpanded
                ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                : 'border-gray-300 text-gray-700 bg-white hover:bg-gray-50'
            }`}
          >
            <span className="inline-flex items-center gap-2">
              <Filter className="w-4 h-4" />
              Filters
            </span>
            <ChevronDown className={`w-4 h-4 transition-transform ${filtersExpanded ? 'rotate-180' : ''}`} />
          </button>
        </div>

        {/* Co-investors search chip */}
        {coInvestorsChipLabel && (
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-indigo-50 text-indigo-800 text-sm font-medium">
              {coInvestorsChipLabel}
              <button
                type="button"
                onClick={() => {
                  setCoInvestorsChipLabel(null);
                  setFilters((prev) => ({ ...prev, domains: [], linkedin_urls: [] }));
                }}
                className="p-0.5 rounded hover:bg-indigo-100 text-indigo-600"
                aria-label="Clear co-investors filter"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </span>
          </div>
        )}

        {/* Expanded filters */}
        {filtersExpanded && (
          <div className="p-4 bg-gray-50 border border-gray-200 rounded-lg space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <MultiSelectFilter
                label="Investor type"
                options={INVESTOR_TYPE_OPTIONS}
                selected={filters.investor_type}
                onToggle={(item) => toggleArrayFilter('investor_type', item)}
              />
              <MultiSelectFilter
                label="Stages"
                options={STAGE_OPTIONS}
                selected={filters.investment_stages}
                onToggle={(item) => toggleArrayFilter('investment_stages', item)}
                formatLabel={formatKebabLabel}
              />
              <MultiSelectFilter
                label="Industries"
                options={INDUSTRY_OPTIONS}
                selected={filters.investment_industries}
                onToggle={(item) => toggleArrayFilter('investment_industries', item)}
                formatLabel={formatKebabLabel}
              />
              <MultiSelectFilter
                label="Investment Geographies"
                options={GEOGRAPHY_OPTIONS}
                selected={filters.investment_geographies}
                onToggle={(item) => toggleArrayFilter('investment_geographies', item)}
                formatLabel={formatGeographyForDisplay}
              />
              {filters.type === 'person' && (
                <MultiSelectFilter
                  label="Roles"
                  options={ROLE_OPTIONS}
                  selected={filters.role}
                  onToggle={(item) => toggleArrayFilter('role', item)}
                />
              )}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <NumericRangeInput
                label="Fund size (USD) min"
                value={filters.fund_size_min}
                onChange={(v) => updateFilter('fund_size_min', v)}
                placeholder="e.g. 1000000"
              />
              <NumericRangeInput
                label="Fund size (USD) max"
                value={filters.fund_size_max}
                onChange={(v) => updateFilter('fund_size_max', v)}
                placeholder="e.g. 100000000"
              />
              <NumericRangeInput
                label="Check size (USD) min"
                value={filters.check_size_min}
                onChange={(v) => updateFilter('check_size_min', v)}
                placeholder="e.g. 100000"
              />
              <NumericRangeInput
                label="Check size (USD) max"
                value={filters.check_size_max}
                onChange={(v) => updateFilter('check_size_max', v)}
                placeholder="e.g. 5000000"
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">HQ Country</label>
                <input
                  type="text"
                  placeholder="e.g. US, India, United States"
                  value={filters.hq_country ?? ''}
                  onChange={(e) => updateFilter('hq_country', e.target.value.trim() || null)}
                  className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">HQ State / Region</label>
                <input
                  type="text"
                  placeholder="e.g. US-CA, Tamil Nadu, California"
                  value={filters.hq_state ?? ''}
                  onChange={(e) => updateFilter('hq_state', e.target.value.trim() || null)}
                  className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-4 items-center justify-between">
              <div className="flex flex-wrap gap-4 items-center">
                <ToggleFilter
                  label="Active"
                  value={filters.active}
                  onChange={(v) => updateFilter('active', v)}
                />
                <ToggleFilter
                  label="Leads round"
                  value={filters.leads_round}
                  onChange={(v) => updateFilter('leads_round', v)}
                />
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-700">Tier</span>
                  <MultiSelectFilter
                    label={filters.tier.length ? '' : 'All'}
                    options={TIER_OPTIONS}
                    selected={filters.tier}
                    onToggle={(item) => toggleArrayFilter('tier', item)}
                    searchPlaceholder="Search investor tiers..."
                  />
                </div>
              </div>
              <button
                onClick={handleClearFilters}
                disabled={
                  !filters.investment_industries?.length &&
                  !filters.investment_stages?.length &&
                  !filters.investment_geographies?.length &&
                  !filters.investor_type?.length &&
                  !filters.tier?.length &&
                  filters.type === 'firm' &&
                  filters.active === true &&
                  filters.leads_round === null &&
                  !filters.role?.length &&
                  !filters.hq_country &&
                  !filters.hq_state &&
                  filters.fund_size_min === null &&
                  filters.fund_size_max === null &&
                  filters.check_size_min === null &&
                  filters.check_size_max === null &&
                  !filters.reviewed_stage?.length &&
                  !filters.set?.length &&
                  !filters.owner?.length &&
                  !filters.investor_fit?.length &&
                  !localSearchInput.trim()
                }
                className="inline-flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
              >
                <X className="w-4 h-4" />
                Clear Filters
              </button>
            </div>
            {/* Reviewed tab only: Stage, Sets, Owners, Investor Fit */}
            {filters.mode === 'reviewed' && (
              <div className="pt-4 border-t border-gray-200">
                <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                  <p className="text-xs font-medium text-gray-500">Pipeline</p>
                  <button
                    onClick={handleExportCsv}
                    disabled={exportLoading || data.length === 0}
                    className="inline-flex items-center gap-2 px-3 md:px-4 py-2 border border-gray-300 text-xs md:text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {exportLoading ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Download className="w-4 h-4" />
                    )}
                    Export CSV
                  </button>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                  <MultiSelectFilter
                    label="Stage"
                    options={REVIEWED_STAGE_OPTIONS}
                    selected={filters.reviewed_stage}
                    onToggle={(item) => toggleArrayFilter('reviewed_stage', item)}
                  />
                  <InvestorFitFilter
                    options={INVESTOR_FIT_OPTIONS}
                    selected={filters.investor_fit}
                    onToggle={toggleInvestorFitFilter}
                  />
                  <MultiSelectFilter
                    label="Sets"
                    options={investorSets}
                    selected={filters.set}
                    onToggle={(item) => toggleArrayFilter('set', item)}
                  />
                  <MultiSelectFilter
                    label="Owners"
                    options={availableOwners}
                    selected={filters.owner}
                    onToggle={(item) => toggleArrayFilter('owner', item)}
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Error state */}
      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error.message}
        </div>
      )}

      {/* Loading state */}
      {loading && data.length === 0 ? (
        <div className="flex items-center justify-center py-16">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-indigo-500" />
        </div>
      ) : data.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 md:p-12 text-center">
          <Handshake className="w-10 h-10 md:w-12 md:h-12 text-gray-400 mx-auto mb-4" />
          <p className="text-sm md:text-base text-gray-500 mb-4 inline-flex items-center justify-center flex-wrap gap-x-2">
            {(() => {
              const activeFilterNames: string[] = [];
              if (filters.name) activeFilterNames.push('Name');
              if ((filters.domains?.length ?? 0) > 0) activeFilterNames.push('Domains');
              if ((filters.linkedin_urls?.length ?? 0) > 0) activeFilterNames.push('LinkedIn URLs');
              if (filters.investment_stages.length) activeFilterNames.push('Stages');
              if (filters.investment_industries.length) activeFilterNames.push('Industries');
              if (filters.investment_geographies.length) activeFilterNames.push('Geographies');
              if (filters.investor_type.length) activeFilterNames.push('Investor Type');
              if (filters.tier.length) activeFilterNames.push('Tier');
              if (filters.reviewed_stage.length) activeFilterNames.push('Reviewed Stage');
              if (filters.set.length) activeFilterNames.push('Set');
              if (filters.owner.length) activeFilterNames.push('Owner');
              if (filters.investor_fit.length) activeFilterNames.push('Investor Fit');
              if (activeFilterNames.length > 0) {
                const formatted = activeFilterNames.length === 1
                  ? activeFilterNames[0]
                  : `${activeFilterNames.slice(0, -1).join(', ')} and ${activeFilterNames[activeFilterNames.length - 1]}`;
                return (
                  <>
                    <span>No investors found matching <span className="text-indigo-500">{formatted}</span> filters.</span>
                    <button
                      onClick={handleClearFilters}
                      className="inline-flex items-center gap-1.5 px-3 py-1 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
                    >
                      <X className="w-3.5 h-3.5" />
                      Clear Filters
                    </button>
                  </>
                );
              }
              return <span>No investors found. Try adjusting your search or filters.</span>;
            })()}
          </p>
          <p className="text-sm text-gray-600 mb-3">Spot a missing investor? Tell us and we&apos;ll add them for free.</p>
          <button
            onClick={() => setReportMissingModalOpen(true)}
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700"
          >
            Report Missing Investors
          </button>
        </div>
      ) : viewMode === 'table' ? (
        <>
          <div className="relative">
            {loading && data.length > 0 && (
              <div className="absolute inset-0 bg-white/60 flex items-center justify-center z-10 rounded-lg">
                <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-indigo-500" />
              </div>
            )}
            <div className="bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden">
              <div
                ref={tableScrollContainerRef}
                className={`overflow-x-auto overflow-y-auto max-h-[calc(100vh-300px)] ${isDragging ? 'cursor-grabbing select-none' : 'cursor-grab'}`}
                onMouseDown={handleTableMouseDown}
                onMouseMove={handleTableMouseMove}
                onMouseUp={handleTableMouseUp}
                onMouseLeave={handleTableMouseLeave}
                style={{ userSelect: isDragging ? 'none' : 'auto' }}
              >
                <table className="min-w-full divide-y divide-gray-200" style={{ tableLayout: 'fixed', width: '100%' }}>
                  <colgroup>
                    {viewMode === 'table' && <col style={{ width: '40px' }} />}
                    {orderedVisibleColumns.map((col: string) => {
                      const isTemplate = col.startsWith('template_');
                      const isWide = col === 'investment_thesis' || col === 'notes' || col === 'twitter_line' || col === 'line1' || col === 'line2' || col === 'additional_line' || col === 'mutual_interests' || col === 'reason' || isTemplate;
                      return <col key={col} style={{ width: isWide ? '280px' : '160px', minWidth: isTemplate ? '200px' : '120px' }} />;
                    })}
                    <col style={{ width: '160px' }} />
                  </colgroup>
                  <thead className="bg-gray-50 sticky top-0 z-10">
                    <tr>
                      {viewMode === 'table' && (
                        <th className="px-2 md:px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider bg-gray-50 align-middle">
                          <input
                            type="checkbox"
                            checked={(() => {
                              const selectableCount =
                                filters.mode === 'reviewed'
                                  ? data.filter((i) => i.has_personalization).length
                                  : data.length;
                              return selectableCount > 0 && selectedInvestorIds.size === selectableCount;
                            })()}
                            onChange={(e) => handleSelectAll(e.target.checked)}
                            className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                            onClick={(e) => e.stopPropagation()}
                          />
                        </th>
                      )}
                      {orderedVisibleColumns.map((column: string) => (
                        <th
                          key={column}
                          className="px-3 md:px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider align-middle"
                        >
                          {columnLabels[column] ?? column.replace(/_/g, ' ')}
                        </th>
                      ))}
                      <th className="px-3 md:px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider align-middle">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {data.map((investor) => {
                      const aiMeta = investor.ai_metadata ?? {};
                      const investorFit =
                        pendingAnalyzeResults[investor.id]?.investor_fit !== undefined
                          ? pendingAnalyzeResults[investor.id].investor_fit
                          : (aiMeta.investor_fit as boolean | null | undefined);
                      const getRowBgColor = () => {
                        if (investorFit === true) return 'bg-green-200 hover:bg-green-300';
                        if (investorFit === false) return 'bg-red-200 hover:bg-red-300';
                        if (investorFit === null) return 'bg-amber-100 hover:bg-amber-200';
                        return 'hover:bg-gray-50';
                      };
                      return (
                      <tr
                        key={investor.id}
                        className={`cursor-pointer ${getRowBgColor()}`}
                        onMouseEnter={() => setHoveredRowId(investor.id)}
                        onMouseLeave={() => setHoveredRowId(null)}
                        onClick={(e) => {
                          if (e.ctrlKey || e.metaKey) {
                            setInvestorToView(investor);
                            setDrawerOpen(true);
                          }
                        }}
                      >
                        {viewMode === 'table' && (
                          <td className="px-2 md:px-4 py-4 whitespace-nowrap align-middle" onClick={(e) => e.stopPropagation()}>
                            {filters.mode === 'reviewed' ? (
                              investor.has_personalization ? (
                                <input
                                  type="checkbox"
                                  checked={selectedInvestorIds.has(investor.id)}
                                  onChange={(e) => handleRowSelect(investor.id, e.target.checked)}
                                  className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                                  onClick={(e) => e.stopPropagation()}
                                />
                              ) : (
                                <span className="w-4 inline-block" />
                              )
                            ) : (
                              <input
                                type="checkbox"
                                checked={selectedInvestorIds.has(investor.id)}
                                onChange={(e) => handleRowSelect(investor.id, e.target.checked)}
                                className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                                onClick={(e) => e.stopPropagation()}
                              />
                            )}
                          </td>
                        )}
                        {orderedVisibleColumns.map((columnKey: string) => {
                          const value = getInvestorCellValue(
                            investor,
                            columnKey,
                            pendingAnalyzeResults[investor.id]
                          );
                          const isTemplateColumn = columnKey.startsWith('template_');
                          const isInvestorFitColumn = columnKey === 'investor_fit';
                          const isDomainColumn = columnKey === 'domain';
                          const isLinkedInColumn = columnKey === 'linkedin_url';
                          const isEmailColumn = columnKey === 'email';
                          const isPhoneColumn = columnKey === 'phone';
                          const isEditableAiMetadataColumn = EDITABLE_AI_METADATA_COLUMNS.includes(
                            columnKey as (typeof EDITABLE_AI_METADATA_COLUMNS)[number]
                          );
                          const isEditingThisCell =
                            editingCell?.investorId === investor.id && editingCell?.columnKey === columnKey;

                          let href: string | null = null;
                          if (isDomainColumn && investor.domain?.trim()) {
                            const d = investor.domain!.trim();
                            href = d.startsWith('http') ? d : `https://${d}`;
                          } else if (isLinkedInColumn && investor.linkedin_url?.trim()) {
                            href = normalizeLinkedInUrl(investor.linkedin_url!.trim());
                          } else if (isEmailColumn && investor.email?.trim()) {
                            const email = investor.email!.trim().split(',')[0].trim();
                            let subject: string | undefined;
                            let body: string | undefined;
                            if (subjectColumn) {
                              const subVal = getInvestorCellValue(investor, subjectColumn, pendingAnalyzeResults[investor.id]);
                              if (subVal && subVal !== '-') subject = subVal;
                            }
                            if (clipboardColumn) {
                              const clipVal = getInvestorCellValue(investor, clipboardColumn, pendingAnalyzeResults[investor.id]);
                              if (clipVal && clipVal !== '-') {
                                const isClipboardEmailChannel = templates.some((t) => `template_${t.id}` === clipboardColumn && t.channel === 'email');
                                body = isClipboardEmailChannel ? clipVal : buildEmailBody(clipVal, 'Hi,\n\n', emailSettings);
                              }
                            }
                            href = buildEmailComposeUrl(email, { subject, body, emailSettings });
                          } else if (isPhoneColumn && investor.phone?.trim()) {
                            const phone = extractPhoneNumber(investor.phone!.trim().split(',')[0].trim());
                            if (phone) {
                              if (phoneClickBehavior === 'call') {
                                href = `tel:${phone}`;
                              } else {
                                let whatsappUrl = `https://wa.me/${phone}`;
                                if (clipboardColumn) {
                                  const clipVal = getInvestorCellValue(investor, clipboardColumn, pendingAnalyzeResults[investor.id]);
                                  if (clipVal && clipVal !== '-') {
                                    whatsappUrl += `?text=${encodeURIComponent(clipVal)}`;
                                  }
                                }
                                href = whatsappUrl;
                              }
                            }
                          }

                          const handleLinkClick = async (e: React.MouseEvent) => {
                            e.stopPropagation();
                            const shouldCopyEmailOrDomain = (isDomainColumn || isEmailColumn) && clipboardColumn;
                            const shouldCopyLinkedIn = isLinkedInColumn && clipboardLinkedInColumn;
                            if (shouldCopyEmailOrDomain || shouldCopyLinkedIn) {
                              await handleInvestorCellClick(investor, columnKey);
                            }
                          };

                          const handleTemplateClick = (e: React.MouseEvent) => {
                            e.stopPropagation();
                            handleInvestorCellClick(investor, columnKey);
                          };

                          const isRowHovered = hoveredRowId === investor.id;

                          // Determine if this column should open the drawer on click
                          const shouldOpenDrawerOnClick = !isTemplateColumn && !isEditableAiMetadataColumn && !href && !isInvestorFitColumn;

                          const handleCellClick = (e: React.MouseEvent) => {
                            if (isTemplateColumn && value !== '-') {
                              handleTemplateClick(e);
                            } else if (shouldOpenDrawerOnClick) {
                              e.stopPropagation();
                              setInvestorToView(investor);
                              setDrawerOpen(true);
                            }
                          };

                          return (
                            <td
                              key={columnKey}
                              className={`px-3 md:px-4 py-3 text-sm text-gray-700 max-w-[200px] align-middle ${
                                (href || isTemplateColumn) && value !== '-' ? 'cursor-pointer hover:bg-blue-50' : ''
                              } ${isEditableAiMetadataColumn ? 'cursor-text hover:bg-indigo-50/50' : ''} ${
                                shouldOpenDrawerOnClick ? 'cursor-pointer' : ''
                              }`}
                              title={
                                isEditableAiMetadataColumn
                                  ? 'Double-click to edit'
                                  : value
                              }
                              onClick={handleCellClick}
                              onDoubleClick={
                                isEditableAiMetadataColumn
                                  ? (e) => {
                                      e.stopPropagation();
                                      handleCellDoubleClick(investor, columnKey);
                                    }
                                  : undefined
                              }
                            >
                              {isEditingThisCell ? (
                                <div className="flex items-start gap-2" onClick={(e) => e.stopPropagation()}>
                                  <textarea
                                    ref={editInputRef as React.RefObject<HTMLTextAreaElement>}
                                    value={editingCell?.value ?? ''}
                                    onChange={(e) =>
                                      setEditingCell((prev) => (prev ? { ...prev, value: e.target.value } : null))
                                    }
                                    onBlur={handleInlineEditSave}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                                        e.preventDefault();
                                        handleInlineEditSave();
                                      } else if (e.key === 'Escape') {
                                        setEditingCell(null);
                                      }
                                    }}
                                    className="flex-1 min-w-0 px-2 py-1 text-sm border border-indigo-500 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500"
                                    rows={columnKey === 'mutual_interests' ? 4 : 2}
                                  />
                                  <div className="flex flex-col gap-0.5 flex-shrink-0">
                                    <button
                                      type="button"
                                      onClick={handleInlineEditSave}
                                      className="p-1 text-green-600 hover:text-green-800"
                                      title="Save (Ctrl+Enter)"
                                    >
                                      ✓
                                    </button>
                                    <button
                                      type="button"
                                      onMouseDown={(e) => {
                                        e.preventDefault();
                                        setEditingCell(null);
                                      }}
                                      className="p-1 text-red-600 hover:text-red-800"
                                      title="Cancel (Esc)"
                                    >
                                      ✕
                                    </button>
                                  </div>
                                </div>
                              ) : href ? (
                                <a
                                  href={href}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={handleLinkClick}
                                  className={`text-indigo-600 hover:underline block ${
                                    isRowHovered ? 'whitespace-normal break-words' : 'truncate'
                                  }`}
                                  title={value}
                                >
                                  {value === '-' ? '' : value}
                                </a>
                              ) : (
                                <div
                                  className={`${
                                    isRowHovered
                                      ? isTemplateColumn
                                        ? 'whitespace-pre-wrap break-words'
                                        : 'whitespace-normal break-words'
                                      : 'truncate'
                                  } ${
                                    isInvestorFitColumn && value !== '-'
                                      ? `block font-medium ${
                                          investorFit === true
                                            ? 'text-emerald-700'
                                            : investorFit === false
                                              ? 'text-red-700'
                                              : 'text-amber-700'
                                        }`
                                      : 'block'
                                  }`}
                                  title={value}
                                >
                                  {value}
                                </div>
                              )}
                            </td>
                          );
                        })}
                        <td
                          className="px-3 md:px-4 py-3 text-right align-middle"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="flex items-center justify-end gap-1">
                            {investor.has_personalization ? (
                              <span
                                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${
                                  investorFit === true
                                    ? 'bg-emerald-100 text-emerald-800'
                                    : investorFit === false
                                      ? 'bg-red-100 text-red-800'
                                      : investorFit === null
                                        ? 'bg-amber-100 text-amber-800'
                                        : 'bg-gray-100 text-gray-800'
                                }`}
                              >
                                <Check className="w-3 h-3" />
                                Reviewed
                              </span>
                            ) : (
                              <button
                                onClick={() => handleAnalyze(investor.id, investor.name)}
                                disabled={analyzingIds.has(investor.id)}
                                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-700 border border-indigo-600 disabled:opacity-50"
                                title={`Analyze ${investor.name || 'investor'} with AI`}
                              >
                                {analyzingIds.has(investor.id) ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <Sparkles className="w-3.5 h-3.5" />
                                )}
                                Analyze with AI
                              </button>
                            )}
                            <button
                              onClick={() => {
                                setInvestorToView(investor);
                                setDrawerOpen(true);
                              }}
                              className="p-1.5 rounded text-gray-600 hover:bg-gray-100"
                              title={`View ${investor.name || 'investor'} details`}
                            >
                              <Eye className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          {!isFreePlan && hasMore && <div ref={loadMoreRef} className="h-4" />}
          {!isFreePlan && hasMore && (
            <div className="mt-4 flex justify-center sm:hidden">
              <button
                onClick={() => loadMore()}
                disabled={loading}
                className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
              >
                {loading ? 'Loading...' : 'Load more'}
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="relative">
            {loading && data.length > 0 && (
              <div className="absolute inset-0 bg-white/60 flex items-center justify-center z-10 rounded-lg">
                <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-indigo-500" />
              </div>
            )}
            {/* List view: select all bar */}
            {data.length > 0 && (
              <div className="flex items-center gap-3 mb-3 py-2 px-1">
                <label className="inline-flex items-center gap-2 cursor-pointer text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={(() => {
                      const selectableCount =
                        filters.mode === 'reviewed'
                          ? data.filter((i) => i.has_personalization).length
                          : data.length;
                      return selectableCount > 0 && selectedInvestorIds.size === selectableCount;
                    })()}
                    onChange={(e) => handleSelectAll(e.target.checked)}
                    className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                    onClick={(e) => e.stopPropagation()}
                  />
                  <span>Select all</span>
                </label>
              </div>
            )}
            <div className="space-y-3">
              {data.map((investor) => (
                <InvestorResultCard
                  key={investor.id}
                  investor={investor}
                  pendingAnalyze={pendingAnalyzeResults[investor.id]}
                  onView={() => {
                    setInvestorToView(investor);
                    setDrawerOpen(true);
                  }}
                  onAnalyze={() => handleAnalyze(investor.id, investor.name)}
                  isAnalyzing={analyzingIds.has(investor.id)}
                  selected={selectedInvestorIds.has(investor.id)}
                  onSelectChange={(checked) => handleRowSelect(investor.id, checked)}
                  showCheckbox={
                    filters.mode === 'global' ? true : Boolean(investor.has_personalization)
                  }
                />
              ))}
              {/* Free plan: skeletons + Upgrade button below the 5 results */}
              {isFreePlan && data.length > 0 && (
                <div className="relative pt-2">
                  <div className="space-y-3">
                    {[1, 2, 3].map((i) => (
                      <InvestorCardSkeleton key={i} />
                    ))}
                  </div>
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white/90 backdrop-blur-sm rounded-lg">
                    <p className="text-sm text-gray-600 text-center">
                    Upgrade your plan to connect with the right investors and complete your raise.
                    </p>
                    <div className="flex flex-wrap items-center justify-center gap-2">
                      <button
                        type="button"
                        onClick={() => openPricingModal()}
                        className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-brand-default hover:bg-brand-dark text-white border-2 border-brand-fainter transition-colors shadow-sm"
                      >
                        Upgrade Plan
                      </button>
                      <button
                        type="button"
                        onClick={() => openROIModal()}
                        className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-white hover:bg-gray-50 text-gray-700 border-2 border-gray-300 hover:border-brand-subtle transition-colors"
                      >
                        Why it&apos;s worth it
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Infinite scroll sentinel - hide for free plan (no load more) */}
          {!isFreePlan && hasMore && <div ref={loadMoreRef} className="h-4" />}

          {/* Pagination fallback - show load more button on mobile (hide for free plan) */}
          {!isFreePlan && hasMore && (
            <div className="mt-4 flex justify-center sm:hidden">
              <button
                onClick={() => loadMore()}
                disabled={loading}
                className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
              >
                {loading ? 'Loading...' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}

      {showCelebration && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center pointer-events-none">
          <div className="w-64 h-64 md:w-80 md:h-80">
            <DotLottieReact
              src="/celebrations.lottie"
              loop={false}
              autoplay={true}
              className="w-full h-full"
            />
          </div>
        </div>
      )}

      <Toast message={toastMessage} isVisible={toastVisible} onClose={() => setToastVisible(false)} />

      <InvestorDetailsDrawer
        isOpen={drawerOpen}
        investor={investorToView}
        onClose={() => {
          setDrawerOpen(false);
          setInvestorToView(null);
          setBackToInvestor(null);
          setBackToFirm(null);
        }}
        investors={data}
        currentPage={1}
        totalPages={isFreePlan ? 1 : hasMore ? 2 : 1}
        onPageChange={handleDrawerPageChange}
        onInvestorChange={(inv) => {
          setInvestorToView(inv as InvestorSearchResult);
          if (backToInvestor && inv?.id === backToInvestor.id) setBackToInvestor(null);
          if (backToFirm && inv?.id === backToFirm.id) setBackToFirm(null);
        }}
        onOpenContactFromFirm={(contact, firm) => {
          setBackToFirm(firm as InvestorSearchResult);
          setInvestorToView(contact as InvestorSearchResult);
        }}
        onOpenInvestorById={async (id) => {
          const firm = await fetchInvestorById(id, { type: 'firm', mode: filters.mode }, excludeInvestors);
          if (firm && investorToView?.type === 'person') {
            setBackToInvestor(investorToView);
            setInvestorToView(firm);
          } else if (firm) {
            setInvestorToView(firm);
          }
        }}
        backToInvestor={backToInvestor}
        backToFirm={backToFirm}
        onAnalyze={(id) => handleAnalyze(id, investorToView?.name)}
        isAnalyzing={investorToView ? analyzingIds.has(investorToView.id) : false}
        updateInvestor={updateInvestor}
        stageOptions={REVIEWED_STAGE_OPTIONS}
        setOptions={investorSets}
        ownerOptions={availableOwners}
        filtersMode={filters.mode}
        isFreePlan={isFreePlan}
        clipboardColumn={clipboardColumn}
        clipboardLinkedInColumn={clipboardLinkedInColumn}
        subjectColumn={subjectColumn}
        phoneClickBehavior={phoneClickBehavior}
        emailSettings={emailSettings}
        isClipboardEmailChannel={templates.some((t) => `template_${t.id}` === clipboardColumn && t.channel === 'email')}
        getInvestorCellValue={(inv, col) => getInvestorCellValue(inv as InvestorSearchResult, col, pendingAnalyzeResults[inv.id])}
        columnLabels={columnLabels}
        onCopyToClipboard={(msg) => {
          setToastMessage(msg);
          setToastVisible(true);
        }}
        onSetCreated={refetchInvestorSets}
        onSearchCoinvestors={handleSearchCoinvestors}
        excludeInvestors={excludeInvestors}
      />

      {/* Find investors of a company modal (available on Free and Pro; Basic sees Upgrade to Pro) */}
      {findCompanyModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-4 md:p-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-2">Find investors of a company</h2>
            <p className="text-sm text-gray-600 mb-4">
              Enter the company name or a short description. We&apos;ll find investors (firms and individuals) and show them in search.
            </p>
            <input
              type="text"
              placeholder="e.g. Stripe, Harvey AI Law, Notion, Freshworks CRM"
              value={findCompanyInput}
              onChange={(e) => {
                setFindCompanyInput(e.target.value);
                setFindCompanyError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  if (plan === 'basic') {
                    setFindCompanyModalOpen(false);
                    setFindCompanyInput('');
                    setFindCompanyError(null);
                    openPricingModal();
                  } else {
                    handleFindCompanyInvestorsSubmit();
                  }
                }
                if (e.key === 'Escape') setFindCompanyModalOpen(false);
              }}
              className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 text-sm mb-4"
              disabled={findCompanyLoading}
              autoFocus
            />
            {findCompanyError && (
              <p className="text-sm text-red-600 mb-4">{findCompanyError}</p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  if (!findCompanyLoading) {
                    setFindCompanyModalOpen(false);
                    setFindCompanyInput('');
                    setFindCompanyError(null);
                  }
                }}
                className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
                disabled={findCompanyLoading}
              >
                Cancel
              </button>
              {plan === 'basic' ? (
                <button
                  type="button"
                  onClick={() => {
                    setFindCompanyModalOpen(false);
                    setFindCompanyInput('');
                    setFindCompanyError(null);
                    openPricingModal();
                  }}
                  className="inline-flex items-center gap-2 px-4 py-2 border border-transparent rounded-md text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700"
                >
                  Upgrade to Pro
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleFindCompanyInvestorsSubmit}
                  disabled={findCompanyLoading || !findCompanyInput.trim()}
                  className="inline-flex items-center gap-2 px-4 py-2 border border-transparent rounded-md text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {findCompanyLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Finding…
                    </>
                  ) : (
                    'Find investors'
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Assign Set Modal */}
      {assignSetModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-4 md:p-6 max-h-[90vh] overflow-y-auto">
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">Assign Set</h2>
            <p className="text-gray-600 mb-4">
              Assign a set name to {selectedInvestorIds.size} selected investor{selectedInvestorIds.size === 1 ? '' : 's'}. Select from existing sets or create a new one.
            </p>
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 mb-2">Set Name</label>
              <select
                value={assignSetSelected}
                onChange={(e) => setAssignSetSelected(e.target.value)}
                className={`block w-full px-3 py-2 text-sm font-medium rounded-lg border-2 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1 ${
                  investorSets.length === 0
                    ? 'border-gray-200 bg-gray-50 text-gray-700 focus:ring-gray-200'
                    : 'border-gray-300 bg-white text-gray-900 focus:ring-indigo-500 focus:border-indigo-500'
                }`}
                autoFocus
              >
                <option value="">— Select —</option>
                {investorSets.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
                <option value="__create_new_set__" className="text-brand-default font-medium">Create new set</option>
              </select>
              {assignSetSelected === '__create_new_set__' && (
                <input
                  type="text"
                  value={assignSetNewName}
                  onChange={(e) => setAssignSetNewName(e.target.value)}
                  placeholder="Enter new set name"
                  className="mt-3 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                />
              )}
            </div>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => {
                  setAssignSetModalOpen(false);
                  setAssignSetSelected('');
                  setAssignSetNewName('');
                }}
                className="px-6 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                Cancel
              </button>
              <button
                onClick={handleBulkAssignSet}
                disabled={assignSetSelected === '__create_new_set__' && !assignSetNewName.trim()}
                className="px-6 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-brand-default hover:bg-brand-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-brand-default disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Assign
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Assign Owner Modal */}
      {assignOwnerModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-4 md:p-6 max-h-[90vh] overflow-y-auto">
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">Assign Owner</h2>
            <p className="text-gray-600 mb-4">
              Assign an owner to {selectedInvestorIds.size} selected investor{selectedInvestorIds.size === 1 ? '' : 's'}. Leave empty to clear the owner.
            </p>
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 mb-2">Owner</label>
              <select
                value={assignOwner}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === '__add_owners__') {
                    router.push('/account');
                    return;
                  }
                  setAssignOwner(val);
                }}
                className={`block w-full px-3 py-2 text-sm font-medium rounded-lg border-2 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1 ${
                  availableOwners.length === 0
                    ? 'border-gray-200 bg-gray-50 text-gray-700 focus:ring-gray-200'
                    : 'border-gray-300 bg-white text-gray-900 focus:ring-indigo-500 focus:border-indigo-500'
                }`}
                autoFocus
              >
                {availableOwners.length === 0 ? (
                  <>
                    <option value="">— No owners in Account —</option>
                    <option value="__add_owners__" className="text-brand-default font-medium">Add new owners</option>
                  </>
                ) : (
                  <>
                    <option value="">— Select —</option>
                    {availableOwners.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                    <option value="__add_owners__" className="text-brand-default font-medium">Add new owners</option>
                  </>
                )}
              </select>
            </div>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => {
                  setAssignOwnerModalOpen(false);
                  setAssignOwner('');
                }}
                className="px-6 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                Cancel
              </button>
              <button
                onClick={handleBulkAssignOwner}
                className="px-6 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-emerald-600 hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-emerald-500"
              >
                Assign
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Assign Stage Modal */}
      {assignStageModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-4 md:p-6 max-h-[90vh] overflow-y-auto">
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">Assign Stage</h2>
            <p className="text-gray-600 mb-4">
              Assign a pipeline stage to {selectedInvestorIds.size} selected investor{selectedInvestorIds.size === 1 ? '' : 's'}.
            </p>
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 mb-2">Stage</label>
              <select
                value={assignStage}
                onChange={(e) => setAssignStage(e.target.value)}
                className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                autoFocus
              >
                <option value="" disabled>Select a stage</option>
                {REVIEWED_STAGE_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => {
                  setAssignStageModalOpen(false);
                  setAssignStage('');
                }}
                className="px-6 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                Cancel
              </button>
              <button
                onClick={handleBulkAssignStage}
                disabled={!assignStage.trim()}
                className="px-6 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-amber-600 hover:bg-amber-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Assign
              </button>
            </div>
          </div>
        </div>
      )}

      <ReportMissingInvestorsModal
        isOpen={reportMissingModalOpen}
        onClose={() => setReportMissingModalOpen(false)}
        initialContent={buildReportContent()}
        onSuccess={() => {
          setToastMessage("Report submitted successfully. We'll add these investors for you.");
          setToastVisible(true);
        }}
      />

      <InsufficientCreditsModal
        isOpen={insufficientCreditsModalOpen}
        onClose={() => setInsufficientCreditsModalOpen(false)}
      />
    </div>
  );
}

function InvestorFitFilter({
  options,
  selected,
  onToggle,
}: {
  options: { value: boolean | null; label: string }[];
  selected: (boolean | null)[];
  onToggle: (value: boolean | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const isSelected = (v: boolean | null) => selected.some((s) => s === v);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
      >
        <span>
          Investor Fit {selected.length ? `(${selected.length})` : ''}
        </span>
        <ChevronDown className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full mt-1 z-20 w-full min-w-[200px] bg-white border border-gray-200 rounded-md shadow-lg overflow-hidden">
            <div className="max-h-52 overflow-y-auto py-1">
              {options.map((opt) => (
                <label
                  key={String(opt.value)}
                  className="flex items-center px-3 py-1.5 hover:bg-gray-50 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={isSelected(opt.value)}
                    onChange={() => onToggle(opt.value)}
                    className="mr-2 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span className="text-sm text-gray-700">{opt.label}</span>
                </label>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function MultiSelectFilter({
  label,
  options,
  selected,
  onToggle,
  formatLabel = (v: string) => v,
  searchPlaceholder,
}: {
  label: string;
  options: string[];
  selected: string[];
  onToggle: (item: string) => void;
  formatLabel?: (value: string) => string;
  searchPlaceholder?: string;
}) {
  const placeholder = searchPlaceholder ?? `Search ${label.toLowerCase()}...`;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const searchLower = search.trim().toLowerCase();
  const filteredOptions = searchLower
    ? options.filter(
        (opt) =>
          opt.toLowerCase().includes(searchLower) ||
          formatLabel(opt).toLowerCase().includes(searchLower)
      )
    : options;

  return (
    <div className="relative">
      <button
        onClick={() => {
          setOpen(!open);
          if (open) setSearch('');
        }}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
      >
        <span>
          {label} {selected.length ? `(${selected.length})` : ''}
        </span>
        <ChevronDown className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => { setOpen(false); setSearch(''); }} />
          <div className="absolute left-0 top-full mt-1 z-20 w-full min-w-[200px] bg-white border border-gray-200 rounded-md shadow-lg overflow-hidden">
            <div className="p-2 border-b border-gray-100 sticky top-0 bg-white">
              <input
                type="text"
                placeholder={placeholder}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                className="block w-full px-2 py-1.5 text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
              />
            </div>
            <div className="max-h-52 overflow-y-auto py-1">
              {filteredOptions.length === 0 ? (
                <p className="px-3 py-2 text-sm text-gray-500">No matches</p>
              ) : (
                filteredOptions.map((opt) => (
                  <label
                    key={opt}
                    className="flex items-center px-3 py-1.5 hover:bg-gray-50 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={selected.includes(opt)}
                      onChange={() => onToggle(opt)}
                      className="mr-2 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                    />
                    <span className="text-sm text-gray-700">{formatLabel(opt)}</span>
                  </label>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function NumericRangeInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder?: string;
}) {
  const [inputValue, setInputValue] = useState(value?.toString() ?? '');
  useEffect(() => {
    setInputValue(value?.toString() ?? '');
  }, [value]);
  return (
    <div>
      <label className="block text-xs font-medium text-gray-500 mb-1">{label}</label>
      <input
        type="text"
        inputMode="numeric"
        placeholder={placeholder}
        value={inputValue}
        onChange={(e) => {
          setInputValue(e.target.value);
          onChange(parseNumericInput(e.target.value));
        }}
        className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
      />
    </div>
  );
}

function ToggleFilter({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean | null;
  onChange: (v: boolean | null) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm font-medium text-gray-700">{label}</span>
      <div className="relative">
        <select
          value={value === null ? 'all' : value ? 'yes' : 'no'}
          onChange={(e) => {
            const v = e.target.value;
            onChange(v === 'all' ? null : v === 'yes');
          }}
          className="pl-2 pr-8 py-1 border border-gray-300 rounded text-sm appearance-none min-w-[72px]"
        >
          <option value="all">All</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
        <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
      </div>
    </div>
  );
}

function InvestorCardSkeleton() {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm opacity-60">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Skeleton className="h-8 w-8 rounded-md" />
          <Skeleton className="h-8 w-8 rounded-md" />
        </div>
      </div>
      <div className="mt-3 pt-3 border-t border-gray-100 flex flex-wrap gap-2">
        <Skeleton className="h-5 w-16 rounded" />
        <Skeleton className="h-5 w-20 rounded" />
        <Skeleton className="h-5 w-14 rounded" />
      </div>
    </div>
  );
}

function InvestorResultCard({
  investor,
  pendingAnalyze,
  onView,
  onAnalyze,
  isAnalyzing,
  selected,
  onSelectChange,
  showCheckbox,
}: {
  investor: InvestorSearchResult;
  pendingAnalyze?: { investor_fit: boolean | null; reason: string | null };
  onView: () => void;
  onAnalyze?: (investorId: string) => void;
  isAnalyzing?: boolean;
  selected?: boolean;
  onSelectChange?: (checked: boolean) => void;
  showCheckbox?: boolean;
}) {
  const location = formatHqLocationShort(investor.hq_state, investor.hq_country);
  const thesis = investor.investment_thesis?.trim();

  // Merge ai_metadata with pending analyze result for immediate display
  const aiMeta = investor.ai_metadata ?? {};
  const investorFit =
    pendingAnalyze?.investor_fit !== undefined
      ? pendingAnalyze.investor_fit
      : (aiMeta.investor_fit as boolean | null | undefined);
  const reason =
    pendingAnalyze?.reason ?? (typeof aiMeta.reason === 'string' ? aiMeta.reason : null);
  const hasFitInfo =
    typeof investorFit === 'boolean' || investorFit === null;
  const hasReason = typeof reason === 'string' && reason.trim().length > 0;

  // Expandable thesis text
  const [thesisExpanded, setThesisExpanded] = useState(false);
  const [thesisClamped, setThesisClamped] = useState(false);
  const thesisRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const el = thesisRef.current;
    if (el) {
      setThesisClamped(el.scrollHeight > el.clientHeight + 1);
    }
  }, [thesis]);


  return (
    <div
      className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm cursor-pointer hover:bg-gray-50 hover:border-gray-300 transition-colors"
      onClick={onView}
    >
      <div className="flex items-start justify-between gap-4">
        {showCheckbox && onSelectChange && (
          <div className="flex-shrink-0 pt-0.5" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              checked={selected ?? false}
              onChange={(e) => onSelectChange(e.target.checked)}
              className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-gray-900">{investor.name}</h3>
          {investor.role && <p className="text-sm text-gray-600 mt-0.5">{investor.role}</p>}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {investor.has_personalization && (
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${
                investorFit === true
                  ? 'bg-emerald-100 text-emerald-800'
                  : investorFit === false
                    ? 'bg-red-100 text-red-800'
                    : investorFit === null
                      ? 'bg-amber-100 text-amber-800'
                      : 'bg-gray-100 text-gray-800'
              }`}
            >
              <Check className="w-3 h-3" />
              Reviewed
            </span>
          )}
          {!investor.has_personalization && onAnalyze && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onAnalyze(investor.id);
              }}
              disabled={isAnalyzing}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-700 border border-indigo-600 disabled:opacity-50 flex-shrink-0 shadow-sm"
              title={`Analyze ${investor.name || 'investor'} with AI`}
            >
              {isAnalyzing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Sparkles className="w-3.5 h-3.5" />
              )}
              Analyze with AI
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onView();
            }}
            className="p-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-100 flex-shrink-0"
            title={`View ${investor.name || 'investor'} details`}
          >
            <Eye className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Investment thesis - full width row */}
      {thesis && (
        <div className="mt-2">
          <p
            ref={thesisRef}
            className={`text-sm text-gray-600 leading-relaxed ${thesisExpanded ? '' : 'line-clamp-3'}`}
          >
            {thesis}
          </p>
          {(thesisClamped || thesisExpanded) && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setThesisExpanded((v) => !v);
              }}
              className="text-xs text-indigo-600 hover:text-indigo-800 mt-1 font-medium"
            >
              {thesisExpanded ? 'Show less' : 'Read more'}
            </button>
          )}
        </div>
      )}

      {/* investor_fit and reason - compact display like InvestorDetailsDrawer */}
      {(hasFitInfo || hasReason) && (
        <div className="mt-3 pt-3 border-t border-gray-100 space-y-1.5">
          {hasFitInfo && (
            <div className="flex items-center gap-2">
              <span className="text-base" role="img" aria-label="fit">
                {investorFit === true ? '😊' : investorFit === false ? '😕' : '😐'}
              </span>
              <span
                className={`text-xs font-medium ${
                  investorFit === true
                    ? 'text-emerald-700'
                    : investorFit === false
                      ? 'text-red-700'
                      : investorFit === null
                        ? 'text-amber-700'
                        : 'text-gray-700'
                }`}
              >
                {investorFit === true ? 'Strong Fit' : investorFit === false ? 'Weak Fit' : 'Unclear Fit'}
              </span>
            </div>
          )}
          {hasReason && (
            <div
              className={`p-2 rounded-md border ${
                investorFit === true
                  ? 'bg-emerald-50 border-emerald-100'
                  : investorFit === false
                    ? 'bg-red-50 border-red-100'
                    : investorFit === null
                      ? 'bg-amber-50 border-amber-100'
                      : 'bg-gray-50 border-gray-100'
              }`}
            >
              <p className="text-xs text-gray-800 leading-relaxed">{reason.trim()}</p>
            </div>
          )}
        </div>
      )}

      <div className="mt-3 pt-3 border-t border-gray-100 flex flex-wrap gap-2 items-center">
        {location && <span className="text-sm text-gray-500">{location}</span>}
        {Array.isArray(investor.investment_stages) &&
          investor.investment_stages.slice(0, 3).map((s) => (
            <span
              key={s}
              className="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-800"
            >
              {formatKebabLabel(s)}
            </span>
          ))}
      </div>
    </div>
  );
}
