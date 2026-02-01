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
  Search,
  Check,
  Sparkles,
  Loader2,
  Globe,
  CheckCircle2,
  ArrowRight,
  Table,
  List,
  Download,
} from 'lucide-react';
import { formatHqLocationShort, getCountryName } from '@/lib/isoCodes';
import { Skeleton } from '@/components/ui/skeleton';
import { usePricingModal } from '@/contexts/PricingModalContext';
import { fetchInvestorAnalyze } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { useOwner } from '@/contexts/OwnerContext';
import { useOnboarding } from '@/contexts/OnboardingContext';
import { useMessageTemplates } from '@/contexts/MessageTemplatesContext';
import { supabase } from '@/utils/supabase/client';
import { buildEmailComposeUrl, buildEmailBody, type EmailSettings } from '@/lib/emailCompose';
import { generateInvestorMessageTemplates } from '@/lib/messageTemplates';
import { copyToClipboard, extractPhoneNumber } from '@/lib/utils';
import { downloadCsv } from '@/lib/csvExport';

// Filter options - must match what's stored in backend (investor-research API)
const INVESTOR_TYPE_OPTIONS = [
  'Venture Capital',
  'Angel Investor',
  'Family Office',
  'Private Equity',
  'Hedge Fund',
  'Corporate Venture',
  'Accelerator / Incubator',
  'Investment Holding Company',
];

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

// ISO 3166-2: country codes (alpha-2) and common subdivisions
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
  'EU',
  'LATAM',
  'APAC',
  'EMEA',
];

/** Region codes that are not ISO country codes - map to display names */
const GEOGRAPHY_REGION_LABELS: Record<string, string> = {
  EU: 'European Union',
  LATAM: 'Latin America',
  APAC: 'Asia-Pacific',
  EMEA: 'Europe, Middle East & Africa',
};

function formatGeographyLabel(code: string): string {
  const regionLabel = GEOGRAPHY_REGION_LABELS[code];
  if (regionLabel) return regionLabel;
  return getCountryName(code) || code;
}

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
  if (stored.step8?.hqCountry?.trim()) partial.investment_geographies = [stored.step8.hqCountry.trim()];
  if (stored.step11?.lookingToRaiseFrom?.length) partial.investor_type = [...stored.step11.lookingToRaiseFrom];
  if (stored.step12?.investorType) {
    const t = stored.step12.investorType;
    partial.type = t === 'follow_on' ? 'person' : 'firm';
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
  if (filters.investment_geographies?.length) stored.step8 = { hqCountry: filters.investment_geographies[0].trim() };
  stored.step10 = {};
  if (filters.investor_type?.length) stored.step11 = { lookingToRaiseFrom: [...filters.investor_type] };
  stored.step12 = { investorType: filters.type === 'person' ? 'follow_on' : 'both' };
  return stored;
}

const INVESTOR_BASE_COLUMNS = [
  'name',
  'role',
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
  'reason',
  'notes',
];

const DEFAULT_FILTERS: InvestorSearchFilters = {
  type: 'firm',
  mode: 'global',
  name: '',
  active: null,
  role: null,
  hq_state: null,
  hq_country: null,
  investor_type: [],
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
  const { availableOwners, isFreePlan } = useOwner();
  const { openPricingModal } = usePricingModal();
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
  const [filters, setFilters] = useState<InvestorSearchFilters>(DEFAULT_FILTERS);
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
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);
  const [showCelebration, setShowCelebration] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);
  /** Pending analyze results for immediate card update before refresh completes */
  const [pendingAnalyzeResults, setPendingAnalyzeResults] = useState<
    Record<string, { investor_fit: boolean | null; reason: string | null }>
  >({});
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

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
      const savedClipboard = localStorage.getItem(INVESTORS_CLIPBOARD_COLUMN_KEY);
      if (saved) {
        try {
          const parsed = JSON.parse(saved) as string[];
          if (Array.isArray(parsed) && parsed.length > 0) {
            const savedBase = parsed.filter((c) => !c.startsWith('template_') && c !== savedClipboard);
            const missing = INVESTOR_BASE_COLUMNS.filter((c) => !savedBase.includes(c));
            const currentTemplates = templates.map((t) => `template_${t.id}`);
            let order = [...savedBase, ...missing, ...currentTemplates.filter((tc) => parsed.includes(tc)), ...currentTemplates.filter((tc) => !parsed.includes(tc))];
            if (savedClipboard && order.includes(savedClipboard)) {
              order = [savedClipboard, ...order.filter((c) => c !== savedClipboard)];
            }
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
      return localStorage.getItem(INVESTORS_CLIPBOARD_COLUMN_KEY) || null;
    }
    return null;
  });
  const [clipboardLinkedInColumn, setClipboardLinkedInColumn] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem(INVESTORS_CLIPBOARD_LINKEDIN_COLUMN_KEY) || null;
    }
    return null;
  });
  const [subjectColumn, setSubjectColumn] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem(INVESTORS_SUBJECT_COLUMN_KEY) || null;
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
  const { data, loading, error, hasMore, page, setPage, loadMore, refresh } =
    useInvestorSearch({ filters, pageSize });

  // Fetch investor sets (used in drawer pipeline and reviewed filters)
  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data: sets, error } = await supabase.rpc('get_investor_sets');
      if (mounted && !error && Array.isArray(sets)) {
        setInvestorSets(sets.filter((s): s is string => typeof s === 'string'));
      }
    })();
    return () => { mounted = false; };
  }, []);

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
        (c) => !c.startsWith('template_') && c !== cs.clipboardColumn && c !== cs.clipboardLinkedInColumn
      );
      const missing = INVESTOR_BASE_COLUMNS.filter((c) => !savedBase.includes(c));
      const currentTemplates = getTemplateColumnKeys();
      let order = [...savedBase, ...missing, ...currentTemplates.filter((tc) => cs.columnOrder!.includes(tc)), ...currentTemplates.filter((tc) => !cs.columnOrder!.includes(tc))];
      if (cs.clipboardColumn && order.includes(cs.clipboardColumn)) {
        order = [cs.clipboardColumn, ...order.filter((c) => c !== cs.clipboardColumn)];
      }
      setColumnOrder(order);
    }
    if (Array.isArray(cs.visibleColumns) && cs.visibleColumns.length > 0) {
      const next = new Set(cs.visibleColumns);
      INVESTOR_BASE_COLUMNS.forEach((c) => next.add(c));
      getTemplateColumnKeys().forEach((c) => next.add(c));
      setVisibleColumns(next);
    }
    if (cs.clipboardColumn != null) setClipboardColumn(cs.clipboardColumn);
    if (cs.clipboardLinkedInColumn != null) setClipboardLinkedInColumn(cs.clipboardLinkedInColumn);
    if (cs.subjectColumn != null) setSubjectColumn(cs.subjectColumn);
    if (cs.phoneClickBehavior) setPhoneClickBehavior(cs.phoneClickBehavior);
    setColumnSettingsFromApi(null);
  }, [columnSettingsFromApi, getTemplateColumnKeys]);

  // Sync column order when templates change
  useEffect(() => {
    const currentTemplates = getTemplateColumnKeys();
    setColumnOrder((prev) => {
      const base = prev.filter(
        (c) => !c.startsWith('template_') && c !== clipboardColumn && c !== clipboardLinkedInColumn
      );
      const existingTemplates = prev.filter((c) => c.startsWith('template_'));
      const newTemplates = currentTemplates.filter((tc) => !existingTemplates.includes(tc));
      let order = [...base, ...existingTemplates.filter((tc) => currentTemplates.includes(tc)), ...newTemplates];
      if (clipboardColumn && order.includes(clipboardColumn)) {
        order = [clipboardColumn, ...order.filter((c) => c !== clipboardColumn)];
      }
      return order;
    });
    setVisibleColumns((prev) => {
      const next = new Set(prev);
      currentTemplates.forEach((c) => next.add(c));
      prev.forEach((c) => {
        if (c.startsWith('template_') && !currentTemplates.includes(c)) next.delete(c);
      });
      return next;
    });
  }, [getTemplateColumnKeys, clipboardColumn, clipboardLinkedInColumn]);

  // Auto-assign Clipboard Column ← Sequence 1 (email1), Subject Column ← Subject (subjectline)
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
  }, [templates]);

  // Save view mode to localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('investors-view-mode', viewMode);
    }
  }, [viewMode]);

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
      if (clipboardColumn) localStorage.setItem(INVESTORS_CLIPBOARD_COLUMN_KEY, clipboardColumn);
      else localStorage.removeItem(INVESTORS_CLIPBOARD_COLUMN_KEY);
    }
  }, [clipboardColumn]);
  useEffect(() => {
    if (typeof window !== 'undefined') {
      if (clipboardLinkedInColumn) localStorage.setItem(INVESTORS_CLIPBOARD_LINKEDIN_COLUMN_KEY, clipboardLinkedInColumn);
      else localStorage.removeItem(INVESTORS_CLIPBOARD_LINKEDIN_COLUMN_KEY);
    }
  }, [clipboardLinkedInColumn]);
  useEffect(() => {
    if (typeof window !== 'undefined') {
      if (subjectColumn) localStorage.setItem(INVESTORS_SUBJECT_COLUMN_KEY, subjectColumn);
      else localStorage.removeItem(INVESTORS_SUBJECT_COLUMN_KEY);
    }
  }, [subjectColumn]);
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(INVESTORS_PHONE_CLICK_BEHAVIOR_KEY, phoneClickBehavior);
    }
  }, [phoneClickBehavior]);

  // Reorder columns to put clipboard column first when it changes
  useEffect(() => {
    if (clipboardColumn) {
      setColumnOrder((prev) => {
        if (prev.includes(clipboardColumn) && prev[0] !== clipboardColumn) {
          return [clipboardColumn, ...prev.filter((c) => c !== clipboardColumn)];
        }
        if (!prev.includes(clipboardColumn)) {
          return [clipboardColumn, ...prev];
        }
        return prev;
      });
    }
  }, [clipboardColumn]);

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
          clipboardColumn: clipboardColumn ?? null,
          clipboardLinkedInColumn: clipboardLinkedInColumn ?? null,
          subjectColumn: subjectColumn ?? null,
          phoneClickBehavior,
        },
      },
    };
    const { error } = await supabase.from('user_settings').upsert(payload, { onConflict: 'id' });
    if (error) throw error;
  }, [user?.id, columnOrder, visibleColumns, clipboardColumn, clipboardLinkedInColumn, subjectColumn, phoneClickBehavior]);

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
      setAnalyzingId(investorId);
      const result = await fetchInvestorAnalyze(investorId, onboarding ?? undefined);
      setAnalyzingId(null);
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
          });
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
    [refresh, filters.type, filters.mode, onboarding]
  );

  // Initial load: read from localStorage (client-only, runs once on mount)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const raw = localStorage.getItem(INVESTORS_FILTERS_KEY);
    if (raw && raw !== 'null') {
      try {
        const stored = JSON.parse(raw) as StoredInvestorFilters | null;
        if (stored) {
          const partial = storedToFilters(stored);
          setFilters((prev) => ({ ...prev, ...partial }));
          hasAppliedOnboardingFallback.current = true; // prevent onboarding from overwriting
        }
      } catch {
        // fall through to onboarding fallback
      }
    }
  }, []);

  // Apply onboarding as fallback when localStorage has null or key is absent
  useEffect(() => {
    if (hasAppliedOnboardingFallback.current) return;
    if (typeof window === 'undefined') return;
    const raw = localStorage.getItem(INVESTORS_FILTERS_KEY);
    if (raw && raw !== 'null') return;
    if (!onboarding) return;
    const stored = onboardingToStored(onboarding);
    if (stored) {
      const partial = storedToFilters(stored);
      setFilters((prev) => ({ ...prev, ...partial }));
    }
    hasAppliedOnboardingFallback.current = true;
  }, [onboarding]);

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
  ]);

  const handleClearFilters = useCallback(() => {
    clearedFiltersRef.current = true;
    localStorage.setItem(INVESTORS_FILTERS_KEY, 'null');
    setLocalSearchInput('');
    setFilters(DEFAULT_FILTERS);
  }, []);

  // Debounced search
  useEffect(() => {
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => {
      setFilters((prev) => ({ ...prev, name: localSearchInput.trim() }));
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
      setFilters((prev) => ({ ...prev, name: localSearchInput.trim() }));
    }
  };

  const handleClearSearch = () => {
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
      searchTimeoutRef.current = null;
    }
    setLocalSearchInput('');
    setFilters((prev) => ({ ...prev, name: '' }));
  };

  const updateFilter = useCallback(<K extends keyof InvestorSearchFilters>(
    key: K,
    value: InvestorSearchFilters[K]
  ) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }, []);

  const toggleArrayFilter = useCallback((
    key: 'investor_type' | 'investment_stages' | 'investment_industries' | 'investment_geographies' | 'reviewed_stage' | 'set' | 'owner',
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
      investor_type: 'Investor Type',
      investment_stages: 'Stages',
      investment_industries: 'Industries',
      investment_geographies: 'Geographies',
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
    () => columnOrder.filter((col) => visibleColumns.has(col)),
    [columnOrder, visibleColumns]
  );

  const getMessageForInvestorTemplate = useCallback(
    (investor: InvestorSearchResult, templateId: string, pendingAnalyze?: { investor_fit: boolean | null; reason: string | null }): string => {
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
      const messages = generateInvestorMessageTemplates(investorData, [template.template]);
      return messages.length > 0 ? messages[0] : '';
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
          return Array.isArray(investor.investment_geographies) ? investor.investment_geographies.join(', ') : '-';
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
      const investors = await fetchInvestorsForExport(filters);
      const isPerson = filters.type === 'person';

      const headers: string[] = [
        'Name',
        ...(isPerson ? ['First Name', 'Role', 'Associated Firm Name'] : []),
        'Owner',
        'Stage',
        'Set',
        'LinkedIn URL',
        'Twitter URL',
        'Email 1',
        'Email 2',
        'Phone 1',
        'Phone 2',
        'Investor Fit',
        'Reason',
        'Twitter Line',
        'Line 1',
        'Line 2',
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

        const row: string[] = [
          inv.name ?? '',
          ...(isPerson ? [firstName, inv.role ?? '', inv.associated_firm_name ?? ''] : []),
          inv.owner ?? '',
          inv.stage ?? '',
          inv.set_name ?? '',
          inv.linkedin_url ?? '',
          inv.twitter_url ?? '',
          emails[0] ?? '',
          emails[1] ?? '',
          phones[0] ?? '',
          phones[1] ?? '',
          fitLabel,
          typeof aiMeta.reason === 'string' ? aiMeta.reason : '',
          typeof aiMeta.twitter_line === 'string' ? aiMeta.twitter_line : '',
          typeof aiMeta.line1 === 'string' ? aiMeta.line1 : '',
          typeof aiMeta.line2 === 'string' ? aiMeta.line2 : '',
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

  const buildReportContent = () => {
    const parts: string[] = [];
    if (filters.name) parts.push(`Search: ${filters.name}`);
    if (filters.investment_stages.length) parts.push(`Stage: ${filters.investment_stages.join(', ')}`);
    if (filters.investment_industries.length) parts.push(`Industry: ${filters.investment_industries.join(', ')}`);
    if (filters.investment_geographies.length) parts.push(`Geography: ${filters.investment_geographies.join(', ')}`);
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

  return (
    <div className="p-4 md:p-8 max-w-full mx-auto">
      <div className="mb-4 md:mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <h1 className="text-2xl md:text-3xl font-bold text-gray-900 flex items-center gap-2">
          <Handshake className="w-6 h-6 md:w-8 md:h-8" />
          Investors
        </h1>
        <div className="flex flex-wrap items-center gap-2 self-start">
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
          <button
            onClick={() => setColumnFilterOpen(!columnFilterOpen)}
            className="inline-flex items-center gap-2 px-3 md:px-4 py-2 border border-gray-300 text-xs md:text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
          >
            <Filter className="w-4 h-4" />
            Manage Columns
          </button>
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
          <div className="flex flex-1 gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search by name, domain, or LinkedIn..."
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
            <select
              value={filters.type}
              onChange={(e) => {
                const newType = e.target.value as InvestorTypeFilter;
                setFilters((prev) => ({
                  ...prev,
                  type: newType,
                  role: newType === 'firm' ? null : prev.role,
                }));
              }}
              className="px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 min-w-[120px]"
            >
              <option value="firm">Firm</option>
              <option value="person">Person</option>
            </select>
          </div>
          <button
            onClick={() => setFiltersExpanded(!filtersExpanded)}
            className={`inline-flex items-center gap-2 px-4 py-2 border rounded-md text-sm font-medium ${
              filtersExpanded
                ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                : 'border-gray-300 text-gray-700 bg-white hover:bg-gray-50'
            }`}
          >
            <Filter className="w-4 h-4" />
            Filters
            <ChevronDown className={`w-4 h-4 transition-transform ${filtersExpanded ? 'rotate-180' : ''}`} />
          </button>
        </div>

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
                label="Geographies"
                options={GEOGRAPHY_OPTIONS}
                selected={filters.investment_geographies}
                onToggle={(item) => toggleArrayFilter('investment_geographies', item)}
                formatLabel={formatGeographyLabel}
              />
              {filters.type === 'person' && (
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Role</label>
                  <select
                    value={filters.role ?? ''}
                    onChange={(e) => updateFilter('role', e.target.value || null)}
                    className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                  >
                    <option value="">All roles</option>
                    {ROLE_OPTIONS.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </div>
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
              </div>
              <button
                onClick={handleClearFilters}
                disabled={
                  !filters.investment_industries?.length &&
                  !filters.investment_stages?.length &&
                  !filters.investment_geographies?.length &&
                  !filters.investor_type?.length &&
                  filters.type === 'firm' &&
                  filters.active === null &&
                  filters.leads_round === null &&
                  !filters.role &&
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
          <p className="text-sm md:text-base text-gray-500 mb-4">
            {filters.name || filters.investment_stages.length || filters.investment_industries.length ||
             filters.investment_geographies.length || filters.investor_type.length ||
             filters.reviewed_stage.length || filters.set.length || filters.owner.length || filters.investor_fit.length
              ? 'No investors found matching your filters.'
              : 'No investors found. Try adjusting your search or filters.'}
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
              <div className="overflow-x-auto max-h-[calc(100vh-300px)]">
                <table className="min-w-full divide-y divide-gray-200" style={{ tableLayout: 'fixed', width: '100%' }}>
                  <colgroup>
                    {orderedVisibleColumns.map((col: string) => {
                      const isTemplate = col.startsWith('template_');
                      const isWide = col === 'investment_thesis' || col === 'notes' || col === 'twitter_line' || col === 'line1' || col === 'line2' || col === 'reason' || isTemplate;
                      return <col key={col} style={{ width: isWide ? '280px' : '160px', minWidth: isTemplate ? '200px' : '120px' }} />;
                    })}
                    <col style={{ width: '160px' }} />
                  </colgroup>
                  <thead className="bg-gray-50 sticky top-0 z-10">
                    <tr>
                      {orderedVisibleColumns.map((column: string) => (
                        <th
                          key={column}
                          className="px-3 md:px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                        >
                          {columnLabels[column] ?? column.replace(/_/g, ' ')}
                        </th>
                      ))}
                      <th className="px-3 md:px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
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
                        onClick={(e) => {
                          if (e.ctrlKey || e.metaKey) {
                            setInvestorToView(investor);
                            setDrawerOpen(true);
                          }
                        }}
                      >
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

                          let href: string | null = null;
                          if (isDomainColumn && investor.domain?.trim()) {
                            const d = investor.domain!.trim();
                            href = d.startsWith('http') ? d : `https://${d}`;
                          } else if (isLinkedInColumn && investor.linkedin_url?.trim()) {
                            href = investor.linkedin_url!.trim();
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
                                body = buildEmailBody(clipVal, 'Hi,\n\n', emailSettings);
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

                          return (
                            <td
                              key={columnKey}
                              className={`px-3 md:px-4 py-3 text-sm text-gray-700 truncate max-w-[200px] ${
                                (href || isTemplateColumn) && value !== '-' ? 'cursor-pointer hover:bg-blue-50' : ''
                              }`}
                              title={value}
                              onClick={isTemplateColumn && value !== '-' ? handleTemplateClick : undefined}
                            >
                              {href ? (
                                <a
                                  href={href}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={handleLinkClick}
                                  className="text-indigo-600 hover:underline truncate block"
                                >
                                  {value === '-' ? '' : value}
                                </a>
                              ) : (
                                <span
                                  className={
                                    isInvestorFitColumn && value !== '-'
                                      ? `truncate block font-medium ${
                                          investorFit === true
                                            ? 'text-emerald-700'
                                            : investorFit === false
                                              ? 'text-red-700'
                                              : 'text-amber-700'
                                        }`
                                      : 'truncate block'
                                  }
                                >
                                  {value}
                                </span>
                              )}
                            </td>
                          );
                        })}
                        <td
                          className="px-3 md:px-4 py-3 text-right"
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
                                disabled={analyzingId === investor.id}
                                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-700 border border-indigo-600 disabled:opacity-50"
                                title={`Analyze ${investor.name || 'investor'} with AI`}
                              >
                                {analyzingId === investor.id ? (
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
                isAnalyzing={analyzingId === investor.id}
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
                    <button
                      type="button"
                      onClick={() => openPricingModal()}
                      className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-brand-default hover:bg-brand-dark text-white border-2 border-brand-fainter transition-colors shadow-sm"
                    >
                      Upgrade Plan
                    </button>
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
          const firm = await fetchInvestorById(id, { type: 'firm', mode: filters.mode });
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
        isAnalyzing={investorToView ? analyzingId === investorToView.id : false}
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
        getInvestorCellValue={(inv, col) => getInvestorCellValue(inv as InvestorSearchResult, col, pendingAnalyzeResults[inv.id])}
        columnLabels={columnLabels}
        onCopyToClipboard={(msg) => {
          setToastMessage(msg);
          setToastVisible(true);
        }}
      />

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
}: {
  label: string;
  options: string[];
  selected: string[];
  onToggle: (item: string) => void;
  formatLabel?: (value: string) => string;
}) {
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
                placeholder="Search..."
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
      <select
        value={value === null ? 'all' : value ? 'yes' : 'no'}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === 'all' ? null : v === 'yes');
        }}
        className="px-2 py-1 border border-gray-300 rounded text-sm"
      >
        <option value="all">All</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
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
}: {
  investor: InvestorSearchResult;
  pendingAnalyze?: { investor_fit: boolean | null; reason: string | null };
  onView: () => void;
  onAnalyze?: (investorId: string) => void;
  isAnalyzing?: boolean;
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

  return (
    <div
      className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm cursor-pointer hover:bg-gray-50 hover:border-gray-300 transition-colors"
      onClick={onView}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-gray-900">{investor.name}</h3>
          {investor.role && <p className="text-sm text-gray-600 mt-0.5">{investor.role}</p>}
          {thesis && <p className="text-sm text-gray-600 mt-1 line-clamp-3 leading-relaxed">{thesis}</p>}
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
              <p className="text-xs text-gray-800 line-clamp-2 leading-relaxed">{reason.trim()}</p>
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
