'use client';

import { useState, useEffect, useRef } from 'react';
import { useOnboarding, OnboardingData } from '@/contexts/OnboardingContext';
import { useRouter } from 'next/navigation';
import { Check, ArrowLeft, ArrowRight, X, ChevronDown } from 'lucide-react';
import { Sparkles } from '@/components/ui/Sparkles';

// Comprehensive country list
const COUNTRIES = [
  'United States', 'United Kingdom', 'Canada', 'Australia', 'Germany', 'France', 'India',
  'Japan', 'China', 'Brazil', 'Mexico', 'Spain', 'Italy', 'Netherlands', 'Sweden',
  'Switzerland', 'Singapore', 'South Korea', 'Israel', 'United Arab Emirates', 'Saudi Arabia',
  'South Africa', 'Argentina', 'Chile', 'Colombia', 'Poland', 'Portugal', 'Belgium',
  'Austria', 'Norway', 'Denmark', 'Finland', 'Ireland', 'New Zealand', 'Taiwan',
  'Hong Kong', 'Thailand', 'Malaysia', 'Indonesia', 'Philippines', 'Vietnam',
  'Turkey', 'Egypt', 'Nigeria', 'Kenya', 'Ghana', 'Morocco', 'Tunisia', 'Algeria',
  'Czech Republic', 'Hungary', 'Romania', 'Greece', 'Croatia', 'Bulgaria', 'Slovakia',
  'Slovenia', 'Estonia', 'Latvia', 'Lithuania', 'Luxembourg', 'Iceland', 'Malta',
  'Cyprus', 'Monaco', 'Liechtenstein', 'Andorra', 'San Marino', 'Vatican City',
  'Russia', 'Ukraine', 'Belarus', 'Kazakhstan', 'Uzbekistan', 'Azerbaijan', 'Georgia',
  'Armenia', 'Moldova', 'Serbia', 'Montenegro', 'Bosnia and Herzegovina', 'Macedonia',
  'Albania', 'Kosovo', 'Iraq', 'Iran', 'Jordan', 'Lebanon', 'Syria', 'Yemen',
  'Oman', 'Kuwait', 'Qatar', 'Bahrain', 'Afghanistan', 'Pakistan', 'Bangladesh',
  'Sri Lanka', 'Nepal', 'Bhutan', 'Myanmar', 'Cambodia', 'Laos', 'Mongolia',
  'North Korea', 'Brunei', 'East Timor', 'Papua New Guinea', 'Fiji', 'Samoa',
  'Tonga', 'Vanuatu', 'Solomon Islands', 'Palau', 'Micronesia', 'Marshall Islands',
  'Nauru', 'Kiribati', 'Tuvalu', 'Maldives', 'Seychelles', 'Mauritius', 'Madagascar',
  'Mozambique', 'Tanzania', 'Uganda', 'Ethiopia', 'Sudan', 'Angola', 'Zambia',
  'Zimbabwe', 'Botswana', 'Namibia', 'Lesotho', 'Swaziland', 'Malawi', 'Rwanda',
  'Burundi', 'Djibouti', 'Eritrea', 'Somalia', 'Libya', 'Mauritania', 'Mali',
  'Burkina Faso', 'Niger', 'Chad', 'Central African Republic', 'Cameroon', 'Gabon',
  'Equatorial Guinea', 'Republic of the Congo', 'Democratic Republic of the Congo',
  'Guinea', 'Guinea-Bissau', 'Sierra Leone', 'Liberia', 'Ivory Coast', 'Togo',
  'Benin', 'Senegal', 'Gambia', 'Cape Verde', 'São Tomé and Príncipe', 'Comoros',
  'Ecuador', 'Peru', 'Bolivia', 'Paraguay', 'Uruguay', 'Venezuela', 'Guyana',
  'Suriname', 'French Guiana', 'Panama', 'Costa Rica', 'Nicaragua', 'Honduras',
  'El Salvador', 'Guatemala', 'Belize', 'Jamaica', 'Haiti', 'Dominican Republic',
  'Cuba', 'Trinidad and Tobago', 'Barbados', 'Bahamas', 'Dominica', 'Saint Lucia',
  'Saint Vincent and the Grenadines', 'Grenada', 'Antigua and Barbuda',
  'Saint Kitts and Nevis', 'Cayman Islands', 'Bermuda', 'Aruba', 'Curaçao',
  'Greenland', 'Faroe Islands', 'Svalbard', 'Falkland Islands', 'French Polynesia',
  'New Caledonia', 'Guam', 'Northern Mariana Islands', 'American Samoa', 'Puerto Rico',
  'U.S. Virgin Islands', 'British Virgin Islands', 'Anguilla', 'Montserrat',
  'Turks and Caicos Islands', 'Gibraltar', 'Jersey', 'Guernsey', 'Isle of Man',
  'Åland Islands', 'Sint Maarten', 'Bonaire', 'Saba', 'Sint Eustatius',
].sort();

const FUNDRAISING_STAGES = [
  'Pre-Seed', 'Seed', 'Series A', 'Series B', 'Series C', 'Series D', 'Series E+', 'Bridge', 'Convertible Note'
];

const SECTORS = [
  'B2B', 'B2C', 'Marketplace', 'SaaS', 'Fintech', 'Healthtech', 'Edtech', 'E-commerce',
  'AI/ML', 'Blockchain/Crypto', 'Gaming', 'Media/Entertainment', 'Real Estate', 'Transportation',
  'Food & Beverage', 'Fashion', 'Travel', 'Energy', 'Manufacturing', 'Agriculture',
  'Construction', 'Legal', 'HR/Recruiting', 'Marketing/Advertising', 'Security', 'IoT',
  'Robotics', 'Biotech', 'Pharma', 'Telecom', 'Hardware', 'Other'
];

const B2B_COMPANY_SIZES = ['1–10', '11–50', '51–200', '201–500', '501–1000', '1000+'];
const B2B_USP_OPTIONS = ['Faster to deploy', 'Lower cost', 'Better UX', 'More accurate results', 'Better support', 'Easier integration', 'Industry-specific', 'Scalable', 'Secure'];
const B2B_CTA_OPTIONS = [
  { value: 'book_demo' as const, label: 'Book a demo' },
  { value: 'request_quote' as const, label: 'Request a quote' },
  { value: 'free_trial' as const, label: 'Start free trial' },
  { value: 'waitlist' as const, label: 'Join waitlist' },
  { value: 'contact_sales' as const, label: 'Contact sales' },
];

const B2B_BUYER_ROLES: { value: string; label: string }[] = [
  { value: 'owner', label: 'Owner' },
  { value: 'founder', label: 'Founder' },
  { value: 'c_suite', label: 'C-Suite' },
  { value: 'partner', label: 'Partner' },
  { value: 'vp', label: 'VP' },
  { value: 'head', label: 'Head' },
  { value: 'director', label: 'Director' },
  { value: 'manager', label: 'Manager' },
  { value: 'senior', label: 'Senior' },
  { value: 'entry', label: 'Entry' },
  { value: 'intern', label: 'Intern' },
];

export default function OnboardingFlow() {
  const { onboarding, updateOnboarding, completeOnboarding, loading } = useOnboarding();
  const router = useRouter();
  const [currentStep, setCurrentStep] = useState(0);
  const [formData, setFormData] = useState<Partial<OnboardingData>>({});
  const [arrEntries, setArrEntries] = useState<Array<{ month: string; year: string; amount: string }>>([]);
  const [sectorSearch, setSectorSearch] = useState('');
  const [countrySearch, setCountrySearch] = useState('');
  const [countryOpen, setCountryOpen] = useState(false);
  const countryDropdownRef = useRef<HTMLDivElement>(null);
  const [enrichLoading, setEnrichLoading] = useState(false);
  const [enrichError, setEnrichError] = useState<string | null>(null);
  const [lastEnrichedUrl, setLastEnrichedUrl] = useState<string | null>(null);
  const [lastEnrichedFlowType, setLastEnrichedFlowType] = useState<'b2b' | 'fundraising' | null>(null);
  const initialStepSyncedRef = useRef(false);

  useEffect(() => {
    if (!countryOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (countryDropdownRef.current && !countryDropdownRef.current.contains(e.target as Node)) {
        setCountryOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [countryOpen]);

  useEffect(() => {
    if (onboarding) {
      setFormData(onboarding);
      setArrEntries(onboarding.step10?.arr || []);
      // Only derive currentStep from saved data on initial load (so Back/Next control step during session)
      if (!initialStepSyncedRef.current) {
        initialStepSyncedRef.current = true;
        if (onboarding.completed) {
          return;
        }
        if (onboarding.step0?.primaryUse === 'b2b') {
          if (onboarding.b2bStep11) setCurrentStep(12);
          else if (onboarding.b2bStep10) setCurrentStep(11);
          else if (onboarding.b2bStep9) setCurrentStep(10);
          else if (onboarding.b2bStep8) setCurrentStep(9);
          else if (onboarding.b2bStep7) setCurrentStep(8);
          else if (onboarding.b2bStep6) setCurrentStep(7);
          else if (onboarding.b2bStep5) setCurrentStep(6);
          else if (onboarding.b2bStep4) setCurrentStep(5);
          else if (onboarding.b2bStep3) setCurrentStep(4);
          else if (onboarding.step2) setCurrentStep(3);
          else if (onboarding.step1) setCurrentStep(2);
          else if (onboarding.step0) setCurrentStep(1);
          else setCurrentStep(0);
        } else {
          if (onboarding.step12) setCurrentStep(13);
          else if (onboarding.step11) setCurrentStep(12);
          else if (onboarding.step10) setCurrentStep(11);
          else if (onboarding.step9) setCurrentStep(10);
          else if (onboarding.step8) setCurrentStep(9);
          else if (onboarding.step7) setCurrentStep(8);
          else if (onboarding.step6) setCurrentStep(7);
          else if (onboarding.step5) setCurrentStep(6);
          else if (onboarding.step4) setCurrentStep(5);
          else if (onboarding.step3) setCurrentStep(4);
          else if (onboarding.step2) setCurrentStep(3);
          else if (onboarding.step1) setCurrentStep(2);
          else if (onboarding.step0) setCurrentStep(1);
          else setCurrentStep(0);
        }
      }
    } else {
      initialStepSyncedRef.current = false;
      setFormData({});
      setArrEntries([]);
      setCurrentStep(0);
    }
  }, [onboarding]);

  // Sync arrEntries when step10 changes
  useEffect(() => {
    if (currentStep === 10 && formData.step10?.arr) {
      setArrEntries(formData.step10.arr);
    } else if (currentStep !== 10) {
      // Clear arrEntries when not on step 10
      setArrEntries([]);
    }
  }, [currentStep, formData.step10?.arr]);

  // Clear search fields when changing steps
  useEffect(() => {
    if (currentStep !== 6) {
      setSectorSearch('');
    }
    if (currentStep !== 8) {
      setCountrySearch('');
    }
  }, [currentStep]);

  if (loading) {
    return (
      <div className="fixed inset-0 bg-white z-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-indigo-500" />
      </div>
    );
  }

  const isB2B = formData.step0?.primaryUse === 'b2b';
  const b2bTotalSteps = 13;
  const fundraisingTotalSteps = 14;

  const isValidUrl = (url: string): boolean => {
    const u = url.trim();
    if (!u) return false;
    try {
      new URL(u.startsWith('http') ? u : `https://${u}`);
      return true;
    } catch {
      return false;
    }
  };

  // Clean URL to just domain.com (like CompanyResearchHome)
  const toDomainOnly = (url: string): string | null => {
    if (!url?.trim()) return null;
    try {
      let u = url.trim();
      if (!u.startsWith('http://') && !u.startsWith('https://')) u = 'https://' + u;
      const hostname = new URL(u).hostname;
      return hostname || null;
    } catch {
      return null;
    }
  };

  const normalizeUrlForCompare = (url: string): string => {
    const u = url.trim();
    const withProtocol = u.startsWith('http') ? u : `https://${u}`;
    try {
      const urlObj = new URL(withProtocol);
      return `${urlObj.protocol}//${urlObj.hostname}`.toLowerCase();
    } catch {
      return withProtocol.toLowerCase();
    }
  };

  const fetchAndPrefillFromWebsite = async (websiteUrl: string, flowType: 'b2b' | 'fundraising'): Promise<Partial<OnboardingData> | null> => {
    if (!isValidUrl(websiteUrl)) return null;
    setEnrichError(null);
    try {
      const res = await fetch('/api/onboarding-enrich', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ websiteurl: websiteUrl.trim(), flowType }),
      });
      const data = await res.json();
      if (!res.ok) {
        setEnrichError(data?.details || data?.error || 'Failed to fetch company info');
        return null;
      }
      if (flowType === 'b2b') {
        const features = Array.isArray(data.features) ? data.features.filter((f: unknown) => typeof f === 'string').slice(0, 5) : [];
        const whyDifferent = Array.isArray(data.why_different) ? data.why_different.filter((w: unknown) => typeof w === 'string') : [];
        const industry = typeof data.industry === 'string' ? data.industry : '';
        const buyerRoleValues = ['owner', 'founder', 'c_suite', 'partner', 'vp', 'head', 'director', 'manager', 'senior', 'entry', 'intern'];
        const buyerRole = Array.isArray(data.buyer_role) ? data.buyer_role.filter((r: unknown) => typeof r === 'string' && buyerRoleValues.includes(r)) : [];
        const problemsYouSolve = typeof data.problems_you_solve === 'string' ? data.problems_you_solve : '';
        const whenCustomersBuy = typeof data.when_customers_buy === 'string' ? data.when_customers_buy : '';
        const productOrService = typeof data.product_or_service === 'string' ? data.product_or_service : '';
        const prefill: Partial<OnboardingData> = {};
        if (productOrService) prefill.b2bStep4 = { productOrService };
        if (features.length > 0) prefill.b2bStep5 = { coreFeatures: features };
        if (whyDifferent.length > 0) prefill.b2bStep6 = { uniqueSellingPoints: whyDifferent };
        if (industry || buyerRole.length > 0) (prefill as Record<string, unknown>).b2bStep7 = { industry, buyerRole: buyerRole.length > 0 ? buyerRole : [] };
        if (problemsYouSolve) prefill.b2bStep8 = { painPoints: problemsYouSolve };
        if (whenCustomersBuy) prefill.b2bStep9 = { buyingTriggers: whenCustomersBuy };
        return prefill;
      } else {
        const sectorList = Array.isArray(data.sector) ? data.sector : [];
        const sector = sectorList.filter((s: string) => SECTORS.includes(s));
        const productDescription = typeof data.product_description === 'string' ? data.product_description : '';
        const whoAreYourCustomers = typeof data.who_are_your_customers === 'string' ? data.who_are_your_customers : '';
        const prefill: Partial<OnboardingData> = {};
        if (sector.length > 0) prefill.step6 = { sector };
        if (productDescription) prefill.step9 = { productDescription };
        if (whoAreYourCustomers) prefill.step10 = { customerDescription: whoAreYourCustomers, revenueStatus: 'no' as const, arr: [] };
        return prefill;
      }
    } catch (e) {
      setEnrichError(e instanceof Error ? e.message : 'Failed to fetch company info');
      return null;
    }
  };

  const mergePrefillInto = (existing: Partial<OnboardingData>, prefill: Partial<OnboardingData>): Partial<OnboardingData> => {
    const result = { ...existing };
    for (const k of Object.keys(prefill) as (keyof OnboardingData)[]) {
      const v = prefill[k];
      if (v != null && typeof v === 'object' && !Array.isArray(v)) {
        (result as Record<string, unknown>)[k] = { ...((result[k] as object) || {}), ...(v as object) };
      } else {
        (result as Record<string, unknown>)[k] = v;
      }
    }
    return result;
  };

  const handleNext = async () => {
    const isWebsiteStepB2B = isB2B && currentStep === 3;
    const isWebsiteStepFundraising = !isB2B && currentStep === 5;
    const isWebsiteStep = isWebsiteStepB2B || isWebsiteStepFundraising;

    const websiteUrl = isWebsiteStepB2B ? formData.b2bStep3?.websiteUrl?.trim() : isWebsiteStepFundraising ? formData.step5?.website?.trim() : '';
    const flowTypeForEnrich: 'b2b' | 'fundraising' = isB2B ? 'b2b' : 'fundraising';
    const normalizedUrl = websiteUrl ? normalizeUrlForCompare(websiteUrl) : '';

    let prefillApplied: Partial<OnboardingData> | null = null;
    if (isWebsiteStep && websiteUrl && isValidUrl(websiteUrl)) {
      const alreadyEnriched = lastEnrichedUrl === normalizedUrl && lastEnrichedFlowType === flowTypeForEnrich;
      if (!alreadyEnriched) {
        setEnrichLoading(true);
        setEnrichError(null);
        const prefillUpdates = await fetchAndPrefillFromWebsite(websiteUrl, flowTypeForEnrich);
        setEnrichLoading(false);
        if (prefillUpdates) {
          setLastEnrichedUrl(normalizedUrl);
          setLastEnrichedFlowType(flowTypeForEnrich);
          setFormData((prev) => mergePrefillInto(prev, prefillUpdates));
          prefillApplied = prefillUpdates;
        }
        // When enrich fails, continue without prefilling and still advance to next step
      }
    }

    const updates: Partial<OnboardingData> = {};

    if (isB2B) {
      if (currentStep === 0) {
        updates.step0 = formData.step0;
        updates.flowType = formData.step0?.primaryUse;
      } else if (currentStep === 1) updates.step1 = formData.step1;
      else if (currentStep === 2) {
        updates.step2 = formData.step2;
        updates.b2bStep3 = formData.b2bStep3; // persist yourRole (collected on this step)
      } else if (currentStep === 3) updates.b2bStep3 = formData.b2bStep3;
      else if (currentStep === 4) updates.b2bStep4 = formData.b2bStep4;
      else if (currentStep === 5) updates.b2bStep5 = formData.b2bStep5;
      else if (currentStep === 6) updates.b2bStep6 = formData.b2bStep6;
      else if (currentStep === 7) updates.b2bStep7 = formData.b2bStep7;
      else if (currentStep === 8) updates.b2bStep8 = formData.b2bStep8;
      else if (currentStep === 9) updates.b2bStep9 = formData.b2bStep9;
      else if (currentStep === 10) updates.b2bStep10 = formData.b2bStep10;
      else if (currentStep === 11) updates.b2bStep11 = formData.b2bStep11;
    } else {
      if (currentStep === 0) {
        updates.step0 = formData.step0;
        updates.flowType = formData.step0?.primaryUse;
      } else if (currentStep === 1) updates.step1 = formData.step1;
      else if (currentStep === 2) updates.step2 = formData.step2;
      else if (currentStep === 3) updates.step3 = formData.step3;
      else if (currentStep === 4) updates.step4 = formData.step4;
      else if (currentStep === 5) updates.step5 = formData.step5;
      else if (currentStep === 6) updates.step6 = formData.step6;
      else if (currentStep === 7) updates.step7 = formData.step7;
      else if (currentStep === 8) updates.step8 = formData.step8;
      else if (currentStep === 9) updates.step9 = formData.step9;
      else if (currentStep === 10) updates.step10 = formData.step10;
      else if (currentStep === 11) updates.step11 = formData.step11;
      else if (currentStep === 12) updates.step12 = formData.step12;
    }

    const updatesToSave = prefillApplied ? mergePrefillInto(updates, prefillApplied) : updates;
    await updateOnboarding(updatesToSave);
    const maxStep = isB2B ? 12 : 13;
    if (currentStep < maxStep) {
      setCurrentStep(currentStep + 1);
    } else {
      await completeOnboarding();
    }
  };

  const handleBack = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    }
  };

  const canProceed = () => {
    if (currentStep === 0) return !!formData.step0?.primaryUse;
    if (isB2B) {
      if (currentStep === 1) return !!(formData.step1?.firstName && formData.step1?.lastName);
      if (currentStep === 2) return !!formData.step2?.bio?.trim() && !!formData.b2bStep3?.yourRole?.trim();
      if (currentStep === 3) {
        const step3 = formData.b2bStep3;
        const hasRequired = !!(step3?.companyName?.trim() && step3?.companySize && step3?.yourRole?.trim());
        const url = step3?.websiteUrl?.trim();
        const urlValid = !url || (() => { try { new URL(url.startsWith('http') ? url : `https://${url}`); return true; } catch { return false; } })();
        return hasRequired && urlValid; // yourRole collected in Step 2
      }
      if (currentStep === 4) return !!formData.b2bStep4?.productOrService?.trim();
      if (currentStep === 5) return true;
      if (currentStep === 6) return true;
      if (currentStep === 7) return !!(formData.b2bStep7?.industry?.trim() && formData.b2bStep7?.companySize && formData.b2bStep7?.geography?.trim() && (formData.b2bStep7?.buyerRole?.length ?? 0) > 0);
      if (currentStep === 8) return !!formData.b2bStep8?.painPoints?.trim();
      if (currentStep === 9) return true;
      if (currentStep === 10) return !!(formData.b2bStep10?.pricingRange?.trim() && formData.b2bStep10?.contractType?.trim() && formData.b2bStep10?.salesMotion);
      if (currentStep === 11) return !!formData.b2bStep11?.cta;
      if (currentStep === 12) return true;
      return false;
    }
    if (currentStep === 1) return !!(formData.step1?.firstName && formData.step1?.lastName);
    if (currentStep === 2) return !!(formData.step2?.title && formData.step2?.bio);
    if (currentStep === 3) return !!formData.step3?.experience;
    if (currentStep === 4) return !!formData.step4?.capitalRaised;
    if (currentStep === 5) {
      const nameOk = !!formData.step5?.companyName?.trim();
      const url = formData.step5?.website?.trim();
      const urlValid = !url || (() => { try { new URL(url.startsWith('http') ? url : `https://${url}`); return true; } catch { return false; } })();
      return nameOk && urlValid;
    }
    if (currentStep === 6) return !!(formData.step6?.sector && formData.step6.sector.length > 0);
    if (currentStep === 7) return !!formData.step7?.stage;
    if (currentStep === 8) return !!formData.step8?.hqCountry;
    if (currentStep === 9) return !!formData.step9?.productDescription;
    if (currentStep === 10) return !!(formData.step10?.customerDescription && formData.step10?.revenueStatus);
    if (currentStep === 11) return !!(formData.step11?.timeline && formData.step11?.targetRoundSize);
    if (currentStep === 12) return !!formData.step12?.investorType;
    return false;
  };

  const renderStep = () => {
    // Step 0: Primary Use
    if (currentStep === 0) {
      return (
        <div className="space-y-6">
          <h2 className="text-2xl font-bold text-gray-900">How will you primarily use the platform?</h2>
          <div className="space-y-4">
            <button
              onClick={() => setFormData({
                ...formData,
                step0: { primaryUse: 'fundraising' }
              })}
              className={`w-full p-6 text-left border-2 rounded-lg transition-all ${
                formData.step0?.primaryUse === 'fundraising'
                  ? 'border-indigo-500 bg-indigo-50'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <div className="font-semibold text-gray-900">Fundraising</div>
              <div className="text-sm text-gray-600 mt-1">Investor discovery, outreach, and deal management</div>
            </button>
            <button
              onClick={() => setFormData({
                ...formData,
                step0: { primaryUse: 'b2b' }
              })}
              className={`w-full p-6 text-left border-2 rounded-lg transition-all ${
                formData.step0?.primaryUse === 'b2b'
                  ? 'border-indigo-500 bg-indigo-50'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <div className="font-semibold text-gray-900">B2B Outreach</div>
              <div className="text-sm text-gray-600 mt-1">Lead generation, prospecting, and sales outreach</div>
            </button>
          </div>
        </div>
      );
    }

    // ——— B2B Outreach flow ———
    if (formData.step0?.primaryUse === 'b2b') {
      // B2B Step 1: Founder Identity
      if (currentStep === 1) {
        return (
          <div className="space-y-6">
            <h2 className="text-2xl font-bold text-gray-900">What&apos;s your name?</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  First name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={formData.step1?.firstName || ''}
                  onChange={(e) => setFormData({
                    ...formData,
                    step1: {
                      firstName: e.target.value,
                      lastName: formData.step1?.lastName ?? '',
                      gender: formData.step1?.gender
                    }
                  })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  placeholder="Enter your first name"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Last name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={formData.step1?.lastName || ''}
                  onChange={(e) => setFormData({
                    ...formData,
                    step1: {
                      firstName: formData.step1?.firstName ?? '',
                      lastName: e.target.value,
                      gender: formData.step1?.gender
                    }
                  })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  placeholder="Enter your last name"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Gender</label>
                <select
                  value={formData.step1?.gender || ''}
                  onChange={(e) => setFormData({
                    ...formData,
                    step1: {
                      firstName: formData.step1?.firstName ?? '',
                      lastName: formData.step1?.lastName ?? '',
                      gender: e.target.value
                    }
                  })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="">Select gender</option>
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                  <option value="non-binary">Non-binary</option>
                  <option value="prefer-not-to-say">Prefer not to say</option>
                </select>
              </div>
            </div>
          </div>
        );
      }

      // B2B Step 2: Founder Background
      if (currentStep === 2) {
        return (
          <div className="space-y-6">
            <h2 className="text-2xl font-bold text-gray-900">Founder Details</h2>
            <p className="text-gray-600">Tell us about yourself</p>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Your role <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={formData.b2bStep3?.yourRole || ''}
                  onChange={(e) => setFormData({
                    ...formData,
                    b2bStep3: {
                      companyName: formData.b2bStep3?.companyName ?? '',
                      websiteUrl: formData.b2bStep3?.websiteUrl ?? '',
                      companySize: formData.b2bStep3?.companySize ?? '',
                      yourRole: e.target.value
                    }
                  })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  placeholder="e.g. CEO, Founder, Sales Lead"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Bio <span className="text-red-500">*</span>
                </label>
                <textarea
                  value={formData.step2?.bio || ''}
                  onChange={(e) => setFormData({
                    ...formData,
                    step2: {
                      title: formData.step2?.title ?? '',
                      bio: e.target.value
                    }
                  })}
                  rows={5}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  placeholder="Multi-line bio for sales context, founder-led outreach, and personalization"
                />
                <p className="text-sm text-gray-500 mt-2">
                  Used for: Sales context, Founder led outreach, Personalization tokens
                </p>
              </div>
            </div>
          </div>
        );
      }

      // B2B Step 3: Company Information
      if (currentStep === 3) {
        return (
          <div className="space-y-6">
            <h2 className="text-2xl font-bold text-gray-900">Company Overview</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Company name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={formData.b2bStep3?.companyName || ''}
                  onChange={(e) => setFormData({
                    ...formData,
                    b2bStep3: {
                      companyName: e.target.value,
                      websiteUrl: formData.b2bStep3?.websiteUrl ?? '',
                      companySize: formData.b2bStep3?.companySize ?? '',
                      yourRole: formData.b2bStep3?.yourRole ?? ''
                    }
                  })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  placeholder="Your company name"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Website URL <span className="text-gray-400 font-normal">(optional, must be valid URL)</span>
                </label>
                <input
                  type="url"
                  value={formData.b2bStep3?.websiteUrl || ''}
                  onChange={(e) => setFormData({
                    ...formData,
                    b2bStep3: {
                      companyName: formData.b2bStep3?.companyName ?? '',
                      websiteUrl: e.target.value,
                      companySize: formData.b2bStep3?.companySize ?? '',
                      yourRole: formData.b2bStep3?.yourRole ?? ''
                    }
                  })}
                  onBlur={() => {
                    const raw = formData.b2bStep3?.websiteUrl?.trim();
                    if (!raw) return;
                    if (!isValidUrl(raw)) return;
                    const domain = toDomainOnly(raw);
                    if (domain) {
                      setFormData({
                        ...formData,
                        b2bStep3: {
                          companyName: formData.b2bStep3?.companyName ?? '',
                          websiteUrl: domain,
                          companySize: formData.b2bStep3?.companySize ?? '',
                          yourRole: formData.b2bStep3?.yourRole ?? ''
                        }
                      });
                    }
                  }}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  placeholder="capitalxai.com"
                />
                {formData.b2bStep3?.websiteUrl?.trim() && (() => {
                  const u = formData.b2bStep3!.websiteUrl!.trim();
                  let valid = false;
                  try { new URL(u.startsWith('http') ? u : `https://${u}`); valid = true; } catch { /* invalid */ }
                  return !valid ? <p className="text-sm text-red-600 mt-1">Please enter a valid URL (e.g. https://capitalxai.com)</p> : null;
                })()}
                {enrichLoading && currentStep === 3 && <p className="text-sm text-indigo-600 mt-1">Fetching company info…</p>}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Company size <span className="text-red-500">*</span>
                </label>
                <select
                  value={formData.b2bStep3?.companySize || ''}
                  onChange={(e) => setFormData({
                    ...formData,
                    b2bStep3: {
                      companyName: formData.b2bStep3?.companyName ?? '',
                      websiteUrl: formData.b2bStep3?.websiteUrl ?? '',
                      companySize: e.target.value,
                      yourRole: formData.b2bStep3?.yourRole ?? ''
                    }
                  })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="">Select size</option>
                  {B2B_COMPANY_SIZES.map((size) => (
                    <option key={size} value={size}>{size} employees</option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        );
      }

      // B2B Step 4: Product or Service
      if (currentStep === 4) {
        return (
          <div className="space-y-6">
            <h2 className="text-2xl font-bold text-gray-900">What You Sell</h2>
            <p className="text-gray-600">What product or service does your company offer?</p>
            <div>
              <textarea
                value={formData.b2bStep4?.productOrService || ''}
                onChange={(e) => setFormData({
                  ...formData,
                  b2bStep4: { productOrService: e.target.value }
                })}
                rows={6}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder="Describe your product or service..."
              />
              <p className="text-sm text-gray-500 mt-2">
                Used for: Outreach messaging, Prospect relevance, ICP alignment
              </p>
            </div>
          </div>
        );
      }

      // B2B Step 5: Core Features (list, up to 5; one empty row by default)
      if (currentStep === 5) {
        const raw = formData.b2bStep5?.coreFeatures;
        const features: string[] = Array.isArray(raw)
          ? raw.slice(0, 5)
          : [];
        const displayFeatures = features.length === 0 ? [''] : features;
        const setFeatures = (next: string[]) =>
          setFormData({ ...formData, b2bStep5: { coreFeatures: next } });

        const addFeature = () => {
          if (displayFeatures.length >= 5) return;
          setFeatures([...displayFeatures, '']);
        };
        const removeFeature = (index: number) => {
          const next = displayFeatures.filter((_, i) => i !== index);
          setFeatures(next.length === 0 ? [''] : next);
        };
        const updateFeature = (index: number, value: string) => {
          const next = [...displayFeatures];
          next[index] = value;
          setFeatures(next);
        };

        return (
          <div className="space-y-6">
            <h2 className="text-2xl font-bold text-gray-900">Key Features</h2>
            <p className="text-gray-600">What are the main features of your product or service?</p>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Features (optional, up to 5)
              </label>
              <div className="space-y-3">
                {displayFeatures.map((value, index) => (
                  <div key={index} className="flex gap-2 items-center">
                    <input
                      type="text"
                      value={value}
                      onChange={(e) => updateFeature(index, e.target.value)}
                      className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      placeholder={`Feature ${index + 1}`}
                    />
                    <button
                      type="button"
                      onClick={() => removeFeature(index)}
                      className="p-2 text-gray-500 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                      aria-label="Remove feature"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
                {displayFeatures.length < 5 && (
                  <button
                    type="button"
                    onClick={addFeature}
                    className="w-full py-2.5 border-2 border-dashed border-gray-300 rounded-lg text-gray-600 hover:border-indigo-400 hover:text-indigo-600 transition-colors text-sm font-medium"
                  >
                    + Add feature
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      }

      // B2B Step 6: Unique Selling Points
      if (currentStep === 6) {
        const usps = formData.b2bStep6?.uniqueSellingPoints || [];
        return (
          <div className="space-y-6">
            <h2 className="text-2xl font-bold text-gray-900">Why You&apos;re Different</h2>
            <p className="text-gray-600">What makes your product stand out?</p>
            <p className="text-sm text-gray-500">Examples: Faster to deploy, Lower cost, Better UX, More accurate results</p>
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {B2B_USP_OPTIONS.map((option) => {
                  const selected = usps.includes(option);
                  return (
                    <button
                      key={option}
                      type="button"
                      onClick={() => {
                        const updated = selected ? usps.filter((s) => s !== option) : [...usps, option];
                        setFormData({ ...formData, b2bStep6: { uniqueSellingPoints: updated } });
                      }}
                      className={`px-4 py-2 rounded-lg border-2 text-sm font-medium transition-all ${
                        selected ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-gray-200 text-gray-700 hover:border-gray-300'
                      }`}
                    >
                      {option}
                    </button>
                  );
                })}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Add more (optional)</label>
                <input
                  type="text"
                  placeholder="Type and press Enter to add"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      const input = (e.target as HTMLInputElement).value.trim();
                      if (input && !usps.includes(input)) {
                        setFormData({
                          ...formData,
                          b2bStep6: { uniqueSellingPoints: [...usps, input] }
                        });
                        (e.target as HTMLInputElement).value = '';
                      }
                    }
                  }}
                />
              </div>
              {usps.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {usps.map((s) => (
                    <span
                      key={s}
                      className="px-3 py-1 bg-indigo-100 text-indigo-700 rounded-full text-sm flex items-center gap-2 inline-flex"
                    >
                      {s}
                      <button
                        type="button"
                        onClick={() => setFormData({
                          ...formData,
                          b2bStep6: { uniqueSellingPoints: usps.filter((x) => x !== s) }
                        })}
                        className="hover:text-indigo-900"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      }

      // B2B Step 7: Ideal Customer Profile
      if (currentStep === 7) {
        const rawBuyerRole = formData.b2bStep7?.buyerRole as string | string[] | undefined;
        const buyerRoles: string[] = Array.isArray(rawBuyerRole)
          ? rawBuyerRole
          : typeof rawBuyerRole === 'string' && rawBuyerRole.trim()
            ? [rawBuyerRole.trim()]
            : [];

        return (
          <div className="space-y-6">
            <h2 className="text-2xl font-bold text-gray-900">Target Customer</h2>
            <p className="text-sm text-gray-500">
              Example: &quot;B2B SaaS companies with 20–200 employees, targeting founders or sales leaders&quot;
            </p>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Industry <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={formData.b2bStep7?.industry || ''}
                  onChange={(e) => setFormData({
                    ...formData,
                    b2bStep7: {
                      industry: e.target.value,
                      companySize: formData.b2bStep7?.companySize ?? '',
                      geography: formData.b2bStep7?.geography ?? '',
                      buyerRole: buyerRoles,
                    }
                  })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  placeholder="e.g. B2B SaaS, Fintech"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Company size <span className="text-red-500">*</span>
                </label>
                <select
                  value={formData.b2bStep7?.companySize || ''}
                  onChange={(e) => setFormData({
                    ...formData,
                    b2bStep7: {
                      industry: formData.b2bStep7?.industry ?? '',
                      companySize: e.target.value,
                      geography: formData.b2bStep7?.geography ?? '',
                      buyerRole: buyerRoles,
                    }
                  })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="">Select size</option>
                  {B2B_COMPANY_SIZES.map((size) => (
                    <option key={size} value={size}>{size} employees</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Geography <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={formData.b2bStep7?.geography || ''}
                  onChange={(e) => setFormData({
                    ...formData,
                    b2bStep7: {
                      industry: formData.b2bStep7?.industry ?? '',
                      companySize: formData.b2bStep7?.companySize ?? '',
                      geography: e.target.value,
                      buyerRole: buyerRoles,
                    }
                  })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  placeholder="e.g. North America, EMEA, Global"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Buyer role <span className="text-red-500">*</span> (select one or more)
                </label>
                <div className="flex flex-wrap gap-2">
                  {B2B_BUYER_ROLES.map((opt) => {
                    const selected = buyerRoles.includes(opt.value);
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => {
                          const next = selected
                            ? buyerRoles.filter((r) => r !== opt.value)
                            : [...buyerRoles, opt.value];
                          setFormData({
                            ...formData,
                            b2bStep7: {
                              industry: formData.b2bStep7?.industry ?? '',
                              companySize: formData.b2bStep7?.companySize ?? '',
                              geography: formData.b2bStep7?.geography ?? '',
                              buyerRole: next,
                            },
                          });
                        }}
                        className={`px-4 py-2 rounded-lg border-2 text-sm font-medium transition-all ${
                          selected ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-gray-200 text-gray-700 hover:border-gray-300'
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        );
      }

      // B2B Step 8: Customer Pain Points
      if (currentStep === 8) {
        return (
          <div className="space-y-6">
            <h2 className="text-2xl font-bold text-gray-900">Problems You Solve</h2>
            <p className="text-gray-600">What problems does your product solve?</p>
            <div>
              <textarea
                value={formData.b2bStep8?.painPoints || ''}
                onChange={(e) => setFormData({
                  ...formData,
                  b2bStep8: { painPoints: e.target.value }
                })}
                rows={6}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder="Describe the pain points your product addresses..."
              />
              <p className="text-sm text-gray-500 mt-2">
                Used for: Cold email copy, LinkedIn outreach, Sales scripts
              </p>
            </div>
          </div>
        );
      }

      // B2B Step 9: Buying Triggers
      if (currentStep === 9) {
        return (
          <div className="space-y-6">
            <h2 className="text-2xl font-bold text-gray-900">When Do Customers Usually Buy</h2>
            <p className="text-gray-600">Examples: Hiring a sales team, Scaling revenue, Tool replacement, Inefficient workflows</p>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Buying triggers (optional)</label>
              <textarea
                value={formData.b2bStep9?.buyingTriggers || ''}
                onChange={(e) => setFormData({
                  ...formData,
                  b2bStep9: { buyingTriggers: e.target.value }
                })}
                rows={4}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder="When do prospects typically decide to buy?"
              />
            </div>
          </div>
        );
      }

      // B2B Step 10: Pricing & Sales Motion
      if (currentStep === 10) {
        return (
          <div className="space-y-6">
            <h2 className="text-2xl font-bold text-gray-900">Sales Model</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Pricing range <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={formData.b2bStep10?.pricingRange || ''}
                  onChange={(e) => setFormData({
                    ...formData,
                    b2bStep10: {
                      pricingRange: e.target.value,
                      contractType: formData.b2bStep10?.contractType ?? '',
                      salesMotion: formData.b2bStep10?.salesMotion ?? 'self_serve'
                    }
                  })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  placeholder="e.g. $99–499/mo, $10K–50K/year"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Contract type <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={formData.b2bStep10?.contractType || ''}
                  onChange={(e) => setFormData({
                    ...formData,
                    b2bStep10: {
                      pricingRange: formData.b2bStep10?.pricingRange ?? '',
                      contractType: e.target.value,
                      salesMotion: formData.b2bStep10?.salesMotion ?? 'self_serve'
                    }
                  })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  placeholder="e.g. Monthly, Annual, Per-seat"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Sales motion <span className="text-red-500">*</span>
                </label>
                <div className="space-y-2">
                  {[
                    { value: 'self_serve' as const, label: 'Self-serve' },
                    { value: 'sales_assisted' as const, label: 'Sales-assisted' },
                    { value: 'enterprise' as const, label: 'Enterprise' },
                  ].map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setFormData({
                        ...formData,
                        b2bStep10: {
                          pricingRange: formData.b2bStep10?.pricingRange ?? '',
                          contractType: formData.b2bStep10?.contractType ?? '',
                          salesMotion: opt.value
                        }
                      })}
                      className={`w-full p-4 text-left border-2 rounded-lg transition-all ${
                        formData.b2bStep10?.salesMotion === opt.value
                          ? 'border-indigo-500 bg-indigo-50'
                          : 'border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        );
      }

      // B2B Step 11: CTA Selection
      if (currentStep === 11) {
        return (
          <div className="space-y-6">
            <h2 className="text-2xl font-bold text-gray-900">What Do You Want Prospects To Do?</h2>
            <p className="text-gray-600">Choose your primary call to action</p>
            <div className="space-y-3">
              {B2B_CTA_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setFormData({
                    ...formData,
                    b2bStep11: { cta: opt.value }
                  })}
                  className={`w-full p-4 text-left border-2 rounded-lg transition-all ${
                    formData.b2bStep11?.cta === opt.value
                      ? 'border-indigo-500 bg-indigo-50'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        );
      }

      // B2B Final Screen
      if (currentStep === 12) {
        return (
          <div className="space-y-6 text-center">
            <div className="flex justify-center">
              <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center">
                <Check className="w-8 h-8 text-green-600" />
              </div>
            </div>
            <h2 className="text-3xl font-bold text-gray-900">You&apos;re Ready to Launch</h2>
            <p className="text-lg text-gray-600 max-w-2xl mx-auto">
              Your company profile is complete. We&apos;ll use your website, ICP, and value proposition to generate high-quality B2B outreach.
            </p>
            <div className="flex gap-4 justify-center pt-4">
              <button
                onClick={async () => {
                  await completeOnboarding();
                  router.push('/');
                }}
                className="px-8 py-3 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 transition-colors"
              >
                Launch Outreach
              </button>
              <button
                onClick={handleBack}
                disabled={enrichLoading}
                className="px-8 py-3 bg-gray-200 text-gray-700 rounded-lg font-medium hover:bg-gray-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Back
              </button>
            </div>
          </div>
        );
      }
    }

    // ——— Fundraising flow ———
    // Step 1: Founder Identity
    if (currentStep === 1) {
      return (
        <div className="space-y-6">
          <h2 className="text-2xl font-bold text-gray-900">What's your name?</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                First name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={formData.step1?.firstName || ''}
                onChange={(e) => setFormData({
                  ...formData,
                  step1: {
                    firstName: e.target.value,
                    lastName: formData.step1?.lastName ?? '',
                    gender: formData.step1?.gender
                  }
                })}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder="Enter your first name"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Last name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={formData.step1?.lastName || ''}
                onChange={(e) => setFormData({
                  ...formData,
                  step1: {
                    firstName: formData.step1?.firstName ?? '',
                    lastName: e.target.value,
                    gender: formData.step1?.gender
                  }
                })}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder="Enter your last name"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Gender</label>
              <select
                value={formData.step1?.gender || ''}
                onChange={(e) => setFormData({
                  ...formData,
                  step1: {
                    firstName: formData.step1?.firstName ?? '',
                    lastName: formData.step1?.lastName ?? '',
                    gender: e.target.value
                  }
                })}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="">Select gender</option>
                <option value="male">Male</option>
                <option value="female">Female</option>
                <option value="non-binary">Non-binary</option>
                <option value="prefer-not-to-say">Prefer not to say</option>
              </select>
            </div>
          </div>
        </div>
      );
    }

    // Step 2: Founder Background
    if (currentStep === 2) {
      return (
        <div className="space-y-6">
          <h2 className="text-2xl font-bold text-gray-900">Founder Details</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Title</label>
              <input
                type="text"
                value={formData.step2?.title || ''}
                onChange={(e) => setFormData({
                  ...formData,
                  step2: {
                    title: e.target.value,
                    bio: formData.step2?.bio ?? ''
                  }
                })}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder="e.g. CEO, Founder"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Bio</label>
              <textarea
                value={formData.step2?.bio || ''}
                onChange={(e) => setFormData({
                  ...formData,
                  step2: {
                    title: formData.step2?.title ?? '',
                    bio: e.target.value
                  }
                })}
                rows={5}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder="Tell us about yourself"
              />
            </div>
          </div>
        </div>
      );
    }

    // Step 3: Fundraising Experience
    if (currentStep === 3) {
      return (
        <div className="space-y-6">
          <h2 className="text-2xl font-bold text-gray-900">Which best describes your prior experience raising venture rounds?</h2>
          <div className="space-y-4">
            {[
              { value: 'getting_started', label: 'Getting Started', desc: 'First time raising venture capital' },
              { value: 'seasoned', label: 'Seasoned', desc: 'Raised 1–2 venture rounds' },
              { value: 'expert', label: 'Expert', desc: 'Raised 3+ venture rounds' },
            ].map((option) => (
              <button
                key={option.value}
                onClick={() => setFormData({
                  ...formData,
                  step3: { experience: option.value as any }
                })}
                className={`w-full p-6 text-left border-2 rounded-lg transition-all ${
                  formData.step3?.experience === option.value
                    ? 'border-indigo-500 bg-indigo-50'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <div className="font-semibold text-gray-900">{option.label}</div>
                <div className="text-sm text-gray-600 mt-1">{option.desc}</div>
              </button>
            ))}
          </div>
        </div>
      );
    }

    // Step 4: Capital Raised to Date
    if (currentStep === 4) {
      return (
        <div className="space-y-6">
          <h2 className="text-2xl font-bold text-gray-900">What is your total capital raised to date?</h2>
          <select
            value={formData.step4?.capitalRaised || ''}
            onChange={(e) => setFormData({
              ...formData,
              step4: { capitalRaised: e.target.value as any }
            })}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 text-lg"
          >
            <option value="">Select amount</option>
            <option value="none">No amount raised</option>
            <option value="less_than_100k">Less than $100K</option>
            <option value="100k_500k">$100K–$500K</option>
            <option value="500k_2m">$500K–$2M</option>
            <option value="2m_10m">$2M–$10M</option>
            <option value="more_than_10m">More than $10M</option>
          </select>
        </div>
      );
    }

    // Step 5: Company name & Website
    if (currentStep === 5) {
      return (
        <div className="space-y-6">
          <h2 className="text-2xl font-bold text-gray-900">Company's Website</h2>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Company name <span className="text-red-500">*</span></label>
            <input
              type="text"
              value={formData.step5?.companyName || ''}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  step5: { ...formData.step5, companyName: e.target.value, website: formData.step5?.website ?? '' }
                })
              }
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="Your company name"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Website <span className="text-gray-400 font-normal">(optional, must be valid URL)</span>
            </label>
            <input
              type="url"
              value={formData.step5?.website || ''}
              onChange={(e) => setFormData({
                ...formData,
                step5: { ...formData.step5, companyName: formData.step5?.companyName ?? '', website: e.target.value }
              })}
              onBlur={() => {
                const raw = formData.step5?.website?.trim();
                if (!raw) return;
                if (!isValidUrl(raw)) return;
                const domain = toDomainOnly(raw);
                if (domain) {
                  setFormData({
                    ...formData,
                    step5: { ...formData.step5, companyName: formData.step5?.companyName ?? '', website: domain }
                  });
                }
              }}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="capitalxai.com"
            />
            {formData.step5?.website?.trim() && (() => {
              const u = formData.step5!.website!.trim();
              let valid = false;
              try { new URL(u.startsWith('http') ? u : `https://${u}`); valid = true; } catch { /* invalid */ }
              return !valid ? <p className="text-sm text-red-600 mt-1">Please enter a valid URL (e.g. https://capitalxai.com)</p> : null;
            })()}
            {enrichLoading && currentStep === 5 && <p className="text-sm text-indigo-600 mt-1">Fetching company info…</p>}
          </div>
        </div>
      );
    }

    // Step 6: Company Sector
    if (currentStep === 6) {
      const filteredSectors = SECTORS.filter(s => 
        s.toLowerCase().includes(sectorSearch.toLowerCase())
      );

      return (
        <div className="space-y-6">
          <h2 className="text-2xl font-bold text-gray-900">Select your company's sector</h2>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Sector <span className="text-red-500">*</span> (Multi-select)
            </label>
            <input
              type="text"
              value={sectorSearch}
              onChange={(e) => setSectorSearch(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 mb-3"
              placeholder="Search sectors..."
            />
            <div className="border border-gray-300 rounded-lg max-h-60 overflow-y-auto p-2">
              {filteredSectors.map((sector) => {
                const isSelected = formData.step6?.sector?.includes(sector);
                return (
                  <label
                    key={sector}
                    className="flex items-center p-2 hover:bg-gray-50 rounded cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={(e) => {
                        const current = formData.step6?.sector || [];
                        const updated = e.target.checked
                          ? [...current, sector]
                          : current.filter(s => s !== sector);
                        setFormData({
                          ...formData,
                          step6: { sector: updated }
                        });
                      }}
                      className="mr-3"
                    />
                    <span>{sector}</span>
                  </label>
                );
              })}
            </div>
            {formData.step6?.sector && formData.step6.sector.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {formData.step6.sector.map((sector) => (
                  <span
                    key={sector}
                    className="px-3 py-1 bg-indigo-100 text-indigo-700 rounded-full text-sm flex items-center gap-2"
                  >
                    {sector}
                    <button
                      onClick={() => {
                        const updated = formData.step6?.sector?.filter(s => s !== sector) || [];
                        setFormData({
                          ...formData,
                          step6: { sector: updated }
                        });
                      }}
                      className="hover:text-indigo-900"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      );
    }

    // Step 7: Upcoming Fundraising Stage
    if (currentStep === 7) {
      return (
        <div className="space-y-6">
          <h2 className="text-2xl font-bold text-gray-900">Upcoming round stage</h2>
          <select
            value={formData.step7?.stage || ''}
            onChange={(e) => setFormData({
              ...formData,
              step7: { stage: e.target.value }
            })}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 text-lg"
          >
            <option value="">Select stage</option>
            {FUNDRAISING_STAGES.map((stage) => (
              <option key={stage} value={stage}>{stage}</option>
            ))}
          </select>
        </div>
      );
    }

    // Step 8: Company HQ
    if (currentStep === 8) {
      const filteredCountries = COUNTRIES.filter(c =>
        c.toLowerCase().includes(countrySearch.toLowerCase())
      );

      return (
        <div className="space-y-6">
          <h2 className="text-2xl font-bold text-gray-900">Select company's HQ country</h2>
          <div ref={countryDropdownRef} className="relative">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Country <span className="text-red-500">*</span>
            </label>
            <button
              type="button"
              onClick={() => setCountryOpen((o) => !o)}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 text-left flex items-center justify-between text-lg bg-white"
            >
              <span className={formData.step8?.hqCountry ? 'text-gray-900' : 'text-gray-500'}>
                {formData.step8?.hqCountry || 'Search countries...'}
              </span>
              <ChevronDown className={`w-5 h-5 text-gray-400 shrink-0 transition-transform ${countryOpen ? 'rotate-180' : ''}`} />
            </button>
            {countryOpen && (
              <div className="absolute z-10 mt-1 w-full bg-white border border-gray-300 rounded-lg shadow-lg overflow-hidden">
                <div className="p-2 border-b border-gray-100 bg-gray-50/50 sticky top-0">
                  <input
                    type="text"
                    value={countrySearch}
                    onChange={(e) => setCountrySearch(e.target.value)}
                    placeholder="Search countries..."
                    className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                    autoFocus
                  />
                </div>
                <div className="max-h-60 overflow-y-auto py-1">
                  {filteredCountries.length === 0 ? (
                    <div className="px-4 py-3 text-sm text-gray-500">No countries match</div>
                  ) : (
                    filteredCountries.map((country) => (
                      <button
                        key={country}
                        type="button"
                        onClick={() => {
                          setFormData({
                            ...formData,
                            step8: { hqCountry: country }
                          });
                          setCountrySearch('');
                          setCountryOpen(false);
                        }}
                        className={`w-full px-4 py-2.5 text-left text-sm hover:bg-indigo-50 transition-colors ${formData.step8?.hqCountry === country ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-gray-900'}`}
                      >
                        {country}
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      );
    }

    // Step 9: Product/Service Description
    if (currentStep === 9) {
      return (
        <div className="space-y-6">
          <h2 className="text-2xl font-bold text-gray-900">What product or service does your company offer?</h2>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Description <span className="text-red-500">*</span>
            </label>
            <textarea
              value={formData.step9?.productDescription || ''}
              onChange={(e) => setFormData({
                ...formData,
                step9: { productDescription: e.target.value }
              })}
              rows={6}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="Describe your product or service..."
            />
            <p className="text-sm text-gray-500 mt-2">
              Used for: Investor matching, Pitch context, Outreach personalization
            </p>
          </div>
        </div>
      );
    }

    // Step 10: Customer Description & Revenue Status
    if (currentStep === 10) {
      const addArrEntry = () => {
        const updated = [...arrEntries, { month: '', year: '', amount: '' }];
        setArrEntries(updated);
        setFormData({
          ...formData,
          step10: {
            customerDescription: formData.step10?.customerDescription ?? '',
            revenueStatus: formData.step10?.revenueStatus ?? 'no',
            arr: updated
          }
        });
      };

      const removeArrEntry = (index: number) => {
        const updated = arrEntries.filter((_, i) => i !== index);
        setArrEntries(updated);
        setFormData({
          ...formData,
          step10: {
            customerDescription: formData.step10?.customerDescription ?? '',
            revenueStatus: formData.step10?.revenueStatus ?? 'no',
            arr: updated
          }
        });
      };

      const updateArrEntry = (index: number, field: 'month' | 'year' | 'amount', value: string) => {
        const updated = [...arrEntries];
        updated[index] = { ...updated[index], [field]: value };
        setArrEntries(updated);
        setFormData({
          ...formData,
          step10: {
            customerDescription: formData.step10?.customerDescription ?? '',
            revenueStatus: formData.step10?.revenueStatus ?? 'no',
            arr: updated
          }
        });
      };

      return (
        <div className="space-y-6">
          <div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">Who are your customers?</h2>
            <textarea
              value={formData.step10?.customerDescription || ''}
              onChange={(e) => setFormData({
                ...formData,
                step10: {
                  customerDescription: e.target.value,
                  revenueStatus: formData.step10?.revenueStatus ?? 'no',
                  arr: formData.step10?.arr
                }
              })}
              rows={4}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="Describe your target customers..."
            />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-gray-900 mb-4">Is your company currently generating revenue?</h2>
            <div className="flex gap-4">
              <button
                onClick={() => setFormData({
                  ...formData,
                  step10: {
                    customerDescription: formData.step10?.customerDescription ?? '',
                    revenueStatus: 'yes',
                    arr: formData.step10?.arr
                  }
                })}
                className={`flex-1 px-6 py-3 border-2 rounded-lg font-medium transition-all ${
                  formData.step10?.revenueStatus === 'yes'
                    ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                    : 'border-gray-200 text-gray-700 hover:border-gray-300'
                }`}
              >
                Yes
              </button>
              <button
                onClick={() => {
                  const cleared: Array<{ month: string; year: string; amount: string }> = [];
                  setArrEntries(cleared);
                  setFormData({
                    ...formData,
                    step10: {
                      customerDescription: formData.step10?.customerDescription ?? '',
                      revenueStatus: 'no',
                      arr: cleared
                    }
                  });
                }}
                className={`flex-1 px-6 py-3 border-2 rounded-lg font-medium transition-all ${
                  formData.step10?.revenueStatus === 'no'
                    ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                    : 'border-gray-200 text-gray-700 hover:border-gray-300'
                }`}
              >
                No
              </button>
            </div>
          </div>
          {formData.step10?.revenueStatus === 'yes' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold text-gray-900">Annual Recurring Revenue (ARR)</h3>
                <button
                  onClick={addArrEntry}
                  className="px-4 py-2 text-sm text-indigo-600 hover:bg-indigo-50 rounded-lg"
                >
                  + Add Month
                </button>
              </div>
              {arrEntries.map((entry, index) => (
                <div key={index} className="flex gap-3 items-end">
                  <div className="flex-1">
                    <label className="block text-xs text-gray-500 mb-1">Month</label>
                    <select
                      value={entry.month}
                      onChange={(e) => updateArrEntry(index, 'month', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                    >
                      <option value="">Select month</option>
                      {['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].map(m => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex-1">
                    <label className="block text-xs text-gray-500 mb-1">Year</label>
                    <input
                      type="number"
                      value={entry.year}
                      onChange={(e) => updateArrEntry(index, 'year', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                      placeholder="2024"
                      min="2000"
                      max="2100"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="block text-xs text-gray-500 mb-1">ARR ($)</label>
                    <input
                      type="text"
                      value={entry.amount}
                      onChange={(e) => updateArrEntry(index, 'amount', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                      placeholder="100000"
                    />
                  </div>
                  <button
                    onClick={() => removeArrEntry(index)}
                    className="px-3 py-2 text-red-600 hover:bg-red-50 rounded-lg"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ))}
              <button
                onClick={() => {
                  const cleared: Array<{ month: string; year: string; amount: string }> = [];
                  setArrEntries(cleared);
                  setFormData({
                    ...formData,
                    step10: {
                      customerDescription: formData.step10?.customerDescription ?? '',
                      revenueStatus: formData.step10?.revenueStatus ?? 'no',
                      arr: cleared
                    }
                  });
                }}
                className="text-sm text-gray-600 hover:text-gray-800"
              >
                Skip for now
              </button>
            </div>
          )}
        </div>
      );
    }

    // Step 11: Fundraising Timeline & Target Round Size
    if (currentStep === 11) {
      return (
        <div className="space-y-6">
          <div>
            <h2 className="text-2xl font-bold text-gray-900 mb-4">When are you planning to raise your next round?</h2>
            <select
              value={formData.step11?.timeline || ''}
              onChange={(e) => setFormData({
                ...formData,
                step11: {
                  timeline: e.target.value as 'near_term' | 'mid_term' | 'later',
                  targetRoundSize: formData.step11?.targetRoundSize ?? 'less_than_500k'
                }
              })}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 text-lg"
            >
              <option value="">Select timeline</option>
              <option value="near_term">Near-term (1–3 months)</option>
              <option value="mid_term">Mid-term (3–6 months)</option>
              <option value="later">Later (6+ months)</option>
            </select>
          </div>
          <div>
            <h2 className="text-2xl font-bold text-gray-900 mb-4">What round size are you looking for?</h2>
            <select
              value={formData.step11?.targetRoundSize || ''}
              onChange={(e) => setFormData({
                ...formData,
                step11: {
                  timeline: formData.step11?.timeline ?? 'later',
                  targetRoundSize: e.target.value as 'less_than_500k' | '500k_2m' | '2m_10m' | 'more_than_10m'
                }
              })}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 text-lg"
            >
              <option value="">Select round size</option>
              <option value="less_than_500k">Less than $500K</option>
              <option value="500k_2m">$500K–$2M</option>
              <option value="2m_10m">$2M–$10M</option>
              <option value="more_than_10m">More than $10M</option>
            </select>
          </div>
        </div>
      );
    }

    // Step 12: Investor Type Preference
    if (currentStep === 12) {
      return (
        <div className="space-y-6">
          <h2 className="text-2xl font-bold text-gray-900">Are you looking for a lead investor or follow-on investors?</h2>
          <div className="space-y-4">
            {[
              { value: 'lead', label: 'Lead investors' },
              { value: 'follow_on', label: 'Follow-on investors' },
              { value: 'both', label: 'Both' },
            ].map((option) => (
              <button
                key={option.value}
                onClick={() => setFormData({
                  ...formData,
                  step12: { investorType: option.value as any }
                })}
                className={`w-full p-6 text-left border-2 rounded-lg transition-all ${
                  formData.step12?.investorType === option.value
                    ? 'border-indigo-500 bg-indigo-50'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <div className="font-semibold text-gray-900">{option.label}</div>
              </button>
            ))}
          </div>
        </div>
      );
    }

    // Step 13: Completion
    if (currentStep === 13) {
      return (
        <div className="space-y-6 text-center">
          <div className="flex justify-center">
            <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center">
              <Check className="w-8 h-8 text-green-600" />
            </div>
          </div>
          <h2 className="text-3xl font-bold text-gray-900">Welcome to CapitalxAI!</h2>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto">
            CapitalxAI's high-precision software enables founders to bring efficiency and intelligence to their fundraising process.
          </p>
          <div className="flex gap-4 justify-center pt-4">
            <button
              onClick={async () => {
                await completeOnboarding();
                router.push('/');
              }}
              className="px-8 py-3 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 transition-colors"
            >
              Launch Platform
            </button>
            <button
              onClick={handleBack}
              disabled={enrichLoading}
              className="px-8 py-3 bg-gray-200 text-gray-700 rounded-lg font-medium hover:bg-gray-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Back
            </button>
          </div>
        </div>
      );
    }

    return null;
  };

  return (
    <div className="fixed inset-0 bg-white z-50 overflow-y-auto relative">
      {/* Sparkles layer — strictly behind all UI */}
      <div className="absolute inset-0 z-0 overflow-hidden pointer-events-none hidden md:block">
        <Sparkles count={100} sizeRange={{ min: 6, max: 14 }} className="inset-0" />
      </div>
      <div className="min-h-screen flex flex-col relative z-10">
        {/* Progress Bar */}
        <div className="relative z-10 w-full bg-gray-200 h-2">
          <div
            className="bg-indigo-600 h-2 transition-all duration-300"
            style={{
              width: `${((currentStep + 1) / (isB2B ? b2bTotalSteps : fundraisingTotalSteps)) * 100}%`,
            }}
          />
        </div>

        {/* Content */}
        <div className="relative z-10 flex-1 flex items-center justify-center p-6">
          <div className="max-w-2xl w-full">
            <div className="relative z-10 bg-white rounded-lg shadow-lg p-8">
              {renderStep()}
            </div>
          </div>
        </div>

        {/* Navigation */}
        {((isB2B && currentStep < 12) || (!isB2B && currentStep < 13)) && (
          <div className="relative z-10 border-t border-gray-200 bg-white p-6">
            <div className="max-w-2xl mx-auto flex justify-between items-center">
              <button
                onClick={handleBack}
                disabled={currentStep === 0 || enrichLoading}
                className="flex items-center gap-2 px-6 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <ArrowLeft className="w-4 h-4" />
                Back
              </button>
              <div className="text-sm text-gray-500">
                Step {currentStep + 1} of {isB2B ? b2bTotalSteps : fundraisingTotalSteps}
              </div>
              <button
                onClick={handleNext}
                disabled={!canProceed() || enrichLoading}
                className="flex items-center gap-2 px-6 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isB2B ? (currentStep === 11 ? 'Complete' : 'Next') : (currentStep === 12 ? 'Complete' : 'Next')}
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
