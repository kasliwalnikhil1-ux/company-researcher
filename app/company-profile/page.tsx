'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useOnboarding, OnboardingData } from '@/contexts/OnboardingContext';
import { useAuth } from '@/contexts/AuthContext';
import { formatOnboardingCompanySummary } from '@/lib/utils';
import ProtectedRoute from '@/components/ProtectedRoute';
import MainLayout from '@/components/MainLayout';
import Toast from '@/components/ui/Toast';
import { Building2, Save, X, ChevronDown } from 'lucide-react';

// Same constants as OnboardingFlow
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

export default function CompanyProfilePage() {
  return (
    <ProtectedRoute>
      <MainLayout>
        <div className="flex-1 overflow-auto">
          <CompanyProfileContent />
        </div>
      </MainLayout>
    </ProtectedRoute>
  );
}

function CompanyProfileContent() {
  const { user } = useAuth();
  const { onboarding, updateOnboarding, loading } = useOnboarding();
  const [formData, setFormData] = useState<Partial<OnboardingData>>({});
  const [saving, setSaving] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const [showToast, setShowToast] = useState(false);
  const [sectorSearch, setSectorSearch] = useState('');
  const [countrySearch, setCountrySearch] = useState('');
  const [countryOpen, setCountryOpen] = useState(false);
  const countryDropdownRef = useRef<HTMLDivElement>(null);

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
    }
  }, [onboarding]);

  const hasChanges = useMemo(() => {
    if (!onboarding) return false;
    return JSON.stringify(formData) !== JSON.stringify(onboarding);
  }, [formData, onboarding]);

  const handleSave = async () => {
    if (!user?.id) {
      setToastMessage('You must be logged in to save your profile.');
      setShowToast(true);
      return;
    }

    try {
      setSaving(true);
      await updateOnboarding(formData);
      setToastMessage('Company profile updated successfully!');
      setShowToast(true);
    } catch (error) {
      console.error('Error saving company profile:', error);
      setToastMessage('Failed to save company profile. Please try again.');
      setShowToast(true);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-indigo-500" />
      </div>
    );
  }

  if (!onboarding || !onboarding.completed) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6 text-center">
          <p className="text-yellow-800">
            Please complete the onboarding flow first to view and edit your company profile.
          </p>
        </div>
      </div>
    );
  }

  const filteredSectors = SECTORS.filter(s => 
    s.toLowerCase().includes(sectorSearch.toLowerCase())
  );

  const filteredCountries = COUNTRIES.filter(c => 
    c.toLowerCase().includes(countrySearch.toLowerCase())
  );

  const flowType = onboarding.flowType ?? onboarding.step0?.primaryUse;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-8">
        <div className="p-2 bg-indigo-100 rounded-lg">
          <Building2 className="w-6 h-6 text-indigo-600" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Company Profile</h1>
          <p className="text-sm text-gray-500">
            {flowType === 'b2b' ? 'View and edit your B2B outreach profile' : 'View and edit your company information'}
          </p>
        </div>
      </div>

      {onboarding && (
        <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-lg">
          <h3 className="text-sm font-semibold text-amber-800 mb-2">Company Context</h3>
          <pre className="text-xs text-amber-900 whitespace-pre-wrap font-mono overflow-x-auto max-h-48 overflow-y-auto">
            {formatOnboardingCompanySummary(onboarding) || '(empty)'}
          </pre>
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-lg shadow-sm p-6 space-y-8">
        {flowType === 'b2b' ? (
          <>
            {/* B2B: Founder Identity */}
            {formData.step1 && (
              <section>
                <h2 className="text-lg font-semibold text-gray-900 mb-4">Founder Identity</h2>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">First Name</label>
                    <input
                      type="text"
                      value={formData.step1.firstName || ''}
                      onChange={(e) => setFormData({
                        ...formData,
                        step1: {
                          firstName: e.target.value,
                          lastName: formData.step1?.lastName ?? '',
                          gender: formData.step1?.gender
                        }
                      })}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Last Name</label>
                    <input
                      type="text"
                      value={formData.step1.lastName || ''}
                      onChange={(e) => setFormData({
                        ...formData,
                        step1: {
                          firstName: formData.step1?.firstName ?? '',
                          lastName: e.target.value,
                          gender: formData.step1?.gender
                        }
                      })}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                </div>
                <div className="mt-4">
                  <label className="block text-sm font-medium text-gray-700 mb-2">Gender</label>
                  <select
                    value={formData.step1.gender || ''}
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
              </section>
            )}

            {/* B2B: Founder Details (Your role + Bio) */}
            {(formData.step2 || formData.b2bStep3) && (
              <section>
                <h2 className="text-lg font-semibold text-gray-900 mb-4">Founder Details</h2>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Your role</label>
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
                      rows={4}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      placeholder="Tell us about yourself"
                    />
                  </div>
                </div>
              </section>
            )}

            {/* B2B: Company Overview */}
            {formData.b2bStep3 && (
              <section>
                <h2 className="text-lg font-semibold text-gray-900 mb-4">Company Overview</h2>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Company name</label>
                    <input
                      type="text"
                      value={formData.b2bStep3.companyName || ''}
                      onChange={(e) => setFormData({
                        ...formData,
                        b2bStep3: {
                          ...formData.b2bStep3!,
                          companyName: e.target.value
                        }
                      })}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Website URL (optional)</label>
                    <input
                      type="url"
                      value={formData.b2bStep3.websiteUrl || ''}
                      onChange={(e) => setFormData({
                        ...formData,
                        b2bStep3: {
                          ...formData.b2bStep3!,
                          websiteUrl: e.target.value
                        }
                      })}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      placeholder="https://capitalxai.com"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Company size</label>
                    <select
                      value={formData.b2bStep3.companySize || ''}
                      onChange={(e) => setFormData({
                        ...formData,
                        b2bStep3: {
                          ...formData.b2bStep3!,
                          companySize: e.target.value
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
              </section>
            )}

            {/* B2B: What You Sell */}
            {formData.b2bStep4 && (
              <section>
                <h2 className="text-lg font-semibold text-gray-900 mb-4">What You Sell</h2>
                <textarea
                  value={formData.b2bStep4.productOrService || ''}
                  onChange={(e) => setFormData({
                    ...formData,
                    b2bStep4: { productOrService: e.target.value }
                  })}
                  rows={5}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  placeholder="Describe your product or service..."
                />
              </section>
            )}

            {/* B2B: Core Features */}
            {formData.b2bStep5 && (
              <section>
                <h2 className="text-lg font-semibold text-gray-900 mb-4">Key Features (up to 5)</h2>
                <div className="space-y-3">
                  {(formData.b2bStep5.coreFeatures || []).map((value, index) => (
                    <div key={index} className="flex gap-2 items-center">
                      <input
                        type="text"
                        value={value}
                        onChange={(e) => {
                          const next = [...(formData.b2bStep5?.coreFeatures || [])];
                          next[index] = e.target.value;
                          setFormData({ ...formData, b2bStep5: { coreFeatures: next } });
                        }}
                        className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        placeholder={`Feature ${index + 1}`}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const next = (formData.b2bStep5?.coreFeatures || []).filter((_, i) => i !== index);
                          setFormData({ ...formData, b2bStep5: { coreFeatures: next.length ? next : [''] } });
                        }}
                        className="p-2 text-gray-500 hover:text-red-600 hover:bg-red-50 rounded-lg"
                        aria-label="Remove"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                  {(formData.b2bStep5.coreFeatures?.length ?? 0) < 5 && (
                    <button
                      type="button"
                      onClick={() => {
                        const next = [...(formData.b2bStep5?.coreFeatures || []), ''];
                        setFormData({ ...formData, b2bStep5: { coreFeatures: next } });
                      }}
                      className="w-full py-2.5 border-2 border-dashed border-gray-300 rounded-lg text-gray-600 hover:border-indigo-400 text-sm font-medium"
                    >
                      + Add feature
                    </button>
                  )}
                </div>
              </section>
            )}

            {/* B2B: Unique Selling Points */}
            {formData.b2bStep6 && (
              <section>
                <h2 className="text-lg font-semibold text-gray-900 mb-4">Why You&apos;re Different</h2>
                <div className="flex flex-wrap gap-2 mb-3">
                  {B2B_USP_OPTIONS.map((opt) => {
                    const selected = (formData.b2bStep6?.uniqueSellingPoints || []).includes(opt);
                    return (
                      <button
                        key={opt}
                        type="button"
                        onClick={() => {
                          const current = formData.b2bStep6?.uniqueSellingPoints || [];
                          const next = selected ? current.filter((s) => s !== opt) : [...current, opt];
                          setFormData({ ...formData, b2bStep6: { uniqueSellingPoints: next } });
                        }}
                        className={`px-4 py-2 rounded-lg border-2 text-sm font-medium ${
                          selected ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        {opt}
                      </button>
                    );
                  })}
                </div>
                {(formData.b2bStep6.uniqueSellingPoints || []).length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {formData.b2bStep6.uniqueSellingPoints.map((s) => (
                      <span key={s} className="px-3 py-1 bg-indigo-100 text-indigo-700 rounded-full text-sm">{s}</span>
                    ))}
                  </div>
                )}
              </section>
            )}

            {/* B2B: Target Customer / ICP */}
            {formData.b2bStep7 && (
              <section>
                <h2 className="text-lg font-semibold text-gray-900 mb-4">Target Customer</h2>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Industry</label>
                    <input
                      type="text"
                      value={formData.b2bStep7.industry || ''}
                      onChange={(e) => setFormData({
                        ...formData,
                        b2bStep7: { ...formData.b2bStep7!, industry: e.target.value }
                      })}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      placeholder="e.g. B2B SaaS, Fintech"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Company size</label>
                    <select
                      value={formData.b2bStep7.companySize || ''}
                      onChange={(e) => setFormData({
                        ...formData,
                        b2bStep7: { ...formData.b2bStep7!, companySize: e.target.value }
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
                    <label className="block text-sm font-medium text-gray-700 mb-2">Geography</label>
                    <input
                      type="text"
                      value={formData.b2bStep7.geography || ''}
                      onChange={(e) => setFormData({
                        ...formData,
                        b2bStep7: { ...formData.b2bStep7!, geography: e.target.value }
                      })}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      placeholder="e.g. North America, EMEA"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Buyer role (select one or more)</label>
                    <div className="flex flex-wrap gap-2">
                      {B2B_BUYER_ROLES.map((opt) => {
                        const selected = (formData.b2bStep7?.buyerRole || []).includes(opt.value);
                        return (
                          <button
                            key={opt.value}
                            type="button"
                            onClick={() => {
                              const current = formData.b2bStep7?.buyerRole ?? [];
                              const next = selected ? current.filter((r) => r !== opt.value) : [...current, opt.value];
                              setFormData({ ...formData, b2bStep7: { ...formData.b2bStep7!, buyerRole: next } });
                            }}
                            className={`px-4 py-2 rounded-lg border-2 text-sm font-medium ${
                              selected ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-gray-200 hover:border-gray-300'
                            }`}
                          >
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </section>
            )}

            {/* B2B: Pain Points */}
            {formData.b2bStep8 && (
              <section>
                <h2 className="text-lg font-semibold text-gray-900 mb-4">Problems You Solve</h2>
                <textarea
                  value={formData.b2bStep8.painPoints || ''}
                  onChange={(e) => setFormData({
                    ...formData,
                    b2bStep8: { painPoints: e.target.value }
                  })}
                  rows={5}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  placeholder="What problems does your product solve?"
                />
              </section>
            )}

            {/* B2B: Buying Triggers */}
            {formData.b2bStep9 && (
              <section>
                <h2 className="text-lg font-semibold text-gray-900 mb-4">When Do Customers Usually Buy</h2>
                <textarea
                  value={formData.b2bStep9.buyingTriggers || ''}
                  onChange={(e) => setFormData({
                    ...formData,
                    b2bStep9: { buyingTriggers: e.target.value }
                  })}
                  rows={4}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  placeholder="e.g. Hiring a sales team, Tool replacement"
                />
              </section>
            )}

            {/* B2B: Sales Model */}
            {formData.b2bStep10 && (
              <section>
                <h2 className="text-lg font-semibold text-gray-900 mb-4">Sales Model</h2>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Pricing range</label>
                    <input
                      type="text"
                      value={formData.b2bStep10.pricingRange || ''}
                      onChange={(e) => setFormData({
                        ...formData,
                        b2bStep10: { ...formData.b2bStep10!, pricingRange: e.target.value }
                      })}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      placeholder="e.g. $99–499/mo"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Contract type</label>
                    <input
                      type="text"
                      value={formData.b2bStep10.contractType || ''}
                      onChange={(e) => setFormData({
                        ...formData,
                        b2bStep10: { ...formData.b2bStep10!, contractType: e.target.value }
                      })}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      placeholder="e.g. Monthly, Annual"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Sales motion</label>
                    <div className="flex gap-2 flex-wrap">
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
                            b2bStep10: { ...formData.b2bStep10!, salesMotion: opt.value }
                          })}
                          className={`px-4 py-2 rounded-lg border-2 text-sm font-medium ${
                            formData.b2bStep10?.salesMotion === opt.value
                              ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                              : 'border-gray-200 hover:border-gray-300'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </section>
            )}

            {/* B2B: CTA */}
            {formData.b2bStep11 && (
              <section>
                <h2 className="text-lg font-semibold text-gray-900 mb-4">Primary Call to Action</h2>
                <div className="flex flex-wrap gap-2">
                  {B2B_CTA_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setFormData({
                        ...formData,
                        b2bStep11: { cta: opt.value }
                      })}
                      className={`px-4 py-2 rounded-lg border-2 text-sm font-medium ${
                        formData.b2bStep11?.cta === opt.value
                          ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                          : 'border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </section>
            )}
          </>
        ) : (
          <>
        {/* Step 1: Founder Identity */}
        {formData.step1 && (
          <section>
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Founder Identity</h2>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">First Name</label>
                <input
                  type="text"
                  value={formData.step1.firstName || ''}
                onChange={(e) => setFormData({
                  ...formData,
                  step1: {
                    firstName: e.target.value,
                    lastName: formData.step1?.lastName ?? '',
                    gender: formData.step1?.gender
                  }
                })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Last Name</label>
                <input
                  type="text"
                  value={formData.step1.lastName || ''}
                onChange={(e) => setFormData({
                  ...formData,
                  step1: {
                    firstName: formData.step1?.firstName ?? '',
                    lastName: e.target.value,
                    gender: formData.step1?.gender
                  }
                })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
            </div>
            <div className="mt-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">Gender</label>
              <select
                value={formData.step1.gender || ''}
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
          </section>
        )}

        {/* Step 2: Founder Background */}
        {formData.step2 && (
          <section>
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Founder Background</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Title</label>
                <input
                  type="text"
                  value={formData.step2.title || ''}
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
                  value={formData.step2.bio || ''}
                  onChange={(e) => setFormData({
                    ...formData,
                    step2: {
                      title: formData.step2?.title ?? '',
                      bio: e.target.value
                    }
                  })}
                  rows={4}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  placeholder="Tell us about yourself"
                />
              </div>
            </div>
          </section>
        )}

        {/* Step 3: Fundraising Experience */}
        {formData.step3 && (
          <section>
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Fundraising Experience</h2>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Prior experience raising venture rounds</label>
              <select
                value={formData.step3.experience || ''}
                onChange={(e) => setFormData({
                  ...formData,
                  step3: { experience: e.target.value as any }
                })}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="">Select experience</option>
                <option value="getting_started">Getting Started — First time raising venture capital</option>
                <option value="seasoned">Seasoned — Raised 1–2 venture rounds</option>
                <option value="expert">Expert — Raised 3+ venture rounds</option>
              </select>
            </div>
          </section>
        )}

        {/* Step 4: Capital Raised */}
        {formData.step4 && (
          <section>
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Capital Raised to Date</h2>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Total capital raised</label>
              <select
                value={formData.step4.capitalRaised || ''}
                onChange={(e) => setFormData({
                  ...formData,
                  step4: { capitalRaised: e.target.value as any }
                })}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
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
          </section>
        )}

        {/* Step 5: Company name & Website */}
        {formData.step5 && (
          <section>
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Company Website</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Company name</label>
                <input
                  type="text"
                  value={formData.step5.companyName || ''}
                  onChange={(e) => setFormData({
                    ...formData,
                    step5: { ...formData.step5, companyName: e.target.value, website: formData.step5?.website ?? '' }
                  })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  placeholder="Your company name"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Website</label>
                <input
                  type="url"
                  value={formData.step5.website || ''}
                  onChange={(e) => setFormData({
                    ...formData,
                    step5: { ...formData.step5, companyName: formData.step5?.companyName ?? '', website: e.target.value }
                  })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  placeholder="https://capitalxai.com"
                />
              </div>
            </div>
          </section>
        )}

        {/* Step 6: Company Sector */}
        {formData.step6 && (
          <section>
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Company Sector</h2>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Sector (Multi-select)</label>
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
                      className="px-3 py-1 bg-indigo-100 text-indigo-700 rounded-full text-sm"
                    >
                      {sector}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </section>
        )}

        {/* Step 7: Fundraising Stage */}
        {formData.step7 && (
          <section>
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Upcoming Fundraising Stage</h2>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Round stage</label>
              <select
                value={formData.step7.stage || ''}
                onChange={(e) => setFormData({
                  ...formData,
                  step7: { stage: e.target.value }
                })}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="">Select stage</option>
                {FUNDRAISING_STAGES.map((stage) => (
                  <option key={stage} value={stage}>{stage}</option>
                ))}
              </select>
            </div>
          </section>
        )}

        {/* Step 8: Company HQ */}
        {formData.step8 && (
          <section>
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Company HQ</h2>
            <div ref={countryDropdownRef} className="relative">
              <label className="block text-sm font-medium text-gray-700 mb-2">Country</label>
              <button
                type="button"
                onClick={() => setCountryOpen((o) => !o)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 text-left flex items-center justify-between bg-white"
              >
                <span className={formData.step8.hqCountry ? 'text-gray-900' : 'text-gray-500'}>
                  {formData.step8.hqCountry || 'Search countries...'}
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
          </section>
        )}

        {/* Step 9: Product Description */}
        {formData.step9 && (
          <section>
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Product / Service Description</h2>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">What product or service does your company offer?</label>
              <textarea
                value={formData.step9.productDescription || ''}
                onChange={(e) => setFormData({
                  ...formData,
                  step9: { productDescription: e.target.value }
                })}
                rows={6}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder="Describe your product or service..."
              />
            </div>
          </section>
        )}

        {/* Step 10: Customer Description & Revenue */}
        {formData.step10 && (
          <section>
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Customer Description & Revenue</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Who are your customers?</label>
                <textarea
                  value={formData.step10.customerDescription || ''}
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
                <label className="block text-sm font-medium text-gray-700 mb-2">Is your company currently generating revenue?</label>
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
                    onClick={() => setFormData({
                      ...formData,
                      step10: {
                        customerDescription: formData.step10?.customerDescription ?? '',
                        revenueStatus: 'no',
                        arr: []
                      }
                    })}
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
                <div className="mt-4">
                  <h3 className="text-md font-medium text-gray-900 mb-3">Annual Recurring Revenue (ARR)</h3>
                  {(formData.step10.arr || []).map((entry, index) => (
                    <div key={index} className="flex gap-3 items-end mb-3">
                      <div className="flex-1">
                        <label className="block text-xs text-gray-500 mb-1">Month</label>
                        <select
                          value={entry.month}
                          onChange={(e) => {
                            const updated = [...(formData.step10?.arr || [])];
                            updated[index] = { ...updated[index], month: e.target.value };
                            setFormData({
                              ...formData,
                              step10: {
                                customerDescription: formData.step10?.customerDescription ?? '',
                                revenueStatus: formData.step10?.revenueStatus ?? 'no',
                                arr: updated
                              }
                            });
                          }}
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
                          onChange={(e) => {
                            const updated = [...(formData.step10?.arr || [])];
                            updated[index] = { ...updated[index], year: e.target.value };
                            setFormData({
                              ...formData,
                              step10: {
                                customerDescription: formData.step10?.customerDescription ?? '',
                                revenueStatus: formData.step10?.revenueStatus ?? 'no',
                                arr: updated
                              }
                            });
                          }}
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
                          onChange={(e) => {
                            const updated = [...(formData.step10?.arr || [])];
                            updated[index] = { ...updated[index], amount: e.target.value };
                            setFormData({
                              ...formData,
                              step10: {
                                customerDescription: formData.step10?.customerDescription ?? '',
                                revenueStatus: formData.step10?.revenueStatus ?? 'no',
                                arr: updated
                              }
                            });
                          }}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                          placeholder="100000"
                        />
                      </div>
                      <button
                        onClick={() => {
                          const updated = (formData.step10?.arr || []).filter((_, i) => i !== index);
                          setFormData({
                            ...formData,
                            step10: {
                              customerDescription: formData.step10?.customerDescription ?? '',
                              revenueStatus: formData.step10?.revenueStatus ?? 'no',
                              arr: updated
                            }
                          });
                        }}
                        className="px-3 py-2 text-red-600 hover:bg-red-50 rounded-lg"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={() => {
                      const updated = [...(formData.step10?.arr || []), { month: '', year: '', amount: '' }];
                      setFormData({
                        ...formData,
                        step10: {
                          customerDescription: formData.step10?.customerDescription ?? '',
                          revenueStatus: formData.step10?.revenueStatus ?? 'no',
                          arr: updated
                        }
                      });
                    }}
                    className="px-4 py-2 text-sm text-indigo-600 hover:bg-indigo-50 rounded-lg"
                  >
                    + Add Month
                  </button>
                </div>
              )}
            </div>
          </section>
        )}

        {/* Step 11: Fundraising Timeline & Target Round Size */}
        {formData.step11 && (
          <section>
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Fundraising Timeline & Target Round Size</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">When are you planning to raise your next round?</label>
                <select
                  value={formData.step11.timeline || ''}
                  onChange={(e) => setFormData({
                    ...formData,
                    step11: {
                    timeline: e.target.value as 'near_term' | 'mid_term' | 'later',
                    targetRoundSize: formData.step11?.targetRoundSize ?? 'less_than_500k'
                  }
                  })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="">Select timeline</option>
                  <option value="near_term">Near-term (1–3 months)</option>
                  <option value="mid_term">Mid-term (3–6 months)</option>
                  <option value="later">Later (6+ months)</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">What round size are you looking for?</label>
                <select
                  value={formData.step11.targetRoundSize || ''}
                  onChange={(e) => setFormData({
                    ...formData,
                    step11: {
                    timeline: formData.step11?.timeline ?? 'later',
                    targetRoundSize: e.target.value as 'less_than_500k' | '500k_2m' | '2m_10m' | 'more_than_10m'
                  }
                  })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="">Select round size</option>
                  <option value="less_than_500k">Less than $500K</option>
                  <option value="500k_2m">$500K–$2M</option>
                  <option value="2m_10m">$2M–$10M</option>
                  <option value="more_than_10m">More than $10M</option>
                </select>
              </div>
            </div>
          </section>
        )}

        {/* Step 12: Investor Type Preference */}
        {formData.step12 && (
          <section>
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Investor Type Preference</h2>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Are you looking for a lead investor or follow-on investors?</label>
              <div className="space-y-2">
                {[
                  { value: 'lead', label: 'Lead investors' },
                  { value: 'follow_on', label: 'Follow-on investors' },
                  { value: 'both', label: 'Both' },
                ].map((option) => (
                  <label key={option.value} className="flex items-center">
                    <input
                      type="radio"
                      name="investorType"
                      value={option.value}
                      checked={formData.step12?.investorType === option.value}
                      onChange={(e) => setFormData({
                        ...formData,
                        step12: { investorType: e.target.value as any }
                      })}
                      className="mr-2"
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
            </div>
          </section>
        )}
          </>
        )}

        {/* Save Button */}
        <div className="pt-6 border-t border-gray-200">
          <button
            onClick={handleSave}
            disabled={saving || !hasChanges}
            className="inline-flex items-center gap-2 px-6 py-3 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-white" />
                Saving...
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                Save Changes
              </>
            )}
          </button>
        </div>
      </div>

      <Toast
        message={toastMessage}
        isVisible={showToast}
        onClose={() => setShowToast(false)}
        duration={4000}
      />
    </div>
  );
}
