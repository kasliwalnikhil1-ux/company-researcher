'use client';

import { useState, useEffect } from 'react';
import { useOnboarding, OnboardingData } from '@/contexts/OnboardingContext';
import { useRouter } from 'next/navigation';
import { Check, ArrowLeft, ArrowRight, X } from 'lucide-react';

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

export default function OnboardingFlow() {
  const { onboarding, updateOnboarding, completeOnboarding, loading } = useOnboarding();
  const router = useRouter();
  const [currentStep, setCurrentStep] = useState(0);
  const [formData, setFormData] = useState<Partial<OnboardingData>>({});
  const [arrEntries, setArrEntries] = useState<Array<{ month: string; year: string; amount: string }>>([]);
  const [sectorSearch, setSectorSearch] = useState('');
  const [countrySearch, setCountrySearch] = useState('');

  useEffect(() => {
    if (onboarding) {
      setFormData(onboarding);
      setArrEntries(onboarding.step10?.arr || []);
      // Determine current step based on completed data
      if (onboarding.completed) {
        // Already completed, shouldn't show
        return;
      }
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
    } else {
      // Onboarding is null, start from step 0
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

  const handleNext = async () => {
    const updates: Partial<OnboardingData> = {};
    
    if (currentStep === 0) {
      updates.step0 = formData.step0;
      updates.flowType = formData.step0?.primaryUse;
    } else if (currentStep === 1) {
      updates.step1 = formData.step1;
    } else if (currentStep === 2) {
      updates.step2 = formData.step2;
    } else if (currentStep === 3) {
      updates.step3 = formData.step3;
    } else if (currentStep === 4) {
      updates.step4 = formData.step4;
    } else if (currentStep === 5) {
      updates.step5 = formData.step5;
    } else if (currentStep === 6) {
      updates.step6 = formData.step6;
    } else if (currentStep === 7) {
      updates.step7 = formData.step7;
    } else if (currentStep === 8) {
      updates.step8 = formData.step8;
    } else if (currentStep === 9) {
      updates.step9 = formData.step9;
    } else if (currentStep === 10) {
      updates.step10 = formData.step10;
    } else if (currentStep === 11) {
      updates.step11 = formData.step11;
    } else if (currentStep === 12) {
      updates.step12 = formData.step12;
    }

    await updateOnboarding(updates);
    if (currentStep < 12) {
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
    if (currentStep === 1) return !!(formData.step1?.firstName && formData.step1?.lastName);
    if (currentStep === 2) return !!(formData.step2?.title && formData.step2?.bio);
    if (currentStep === 3) return !!formData.step3?.experience;
    if (currentStep === 4) return !!formData.step4?.capitalRaised;
    if (currentStep === 5) return !!formData.step5?.website;
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

    // Only show fundraising flow for now (B2B flow can be added later)
    if (formData.step0?.primaryUse !== 'fundraising') {
      return (
        <div className="space-y-6">
          <h2 className="text-2xl font-bold text-gray-900">B2B Outreach Flow</h2>
          <p className="text-gray-600">B2B Outreach onboarding flow will be implemented soon.</p>
        </div>
      );
    }

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

    // Step 5: Company Website
    if (currentStep === 5) {
      return (
        <div className="space-y-6">
          <h2 className="text-2xl font-bold text-gray-900">Company's Website</h2>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Website</label>
            <input
              type="url"
              value={formData.step5?.website || ''}
              onChange={(e) => setFormData({
                ...formData,
                step5: { website: e.target.value }
              })}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="https://example.com"
            />
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
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Country <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={countrySearch}
              onChange={(e) => setCountrySearch(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 mb-3"
              placeholder="Search countries..."
            />
            <select
              value={formData.step8?.hqCountry || ''}
              onChange={(e) => {
                setFormData({
                  ...formData,
                  step8: { hqCountry: e.target.value }
                });
                setCountrySearch('');
              }}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 text-lg"
            >
              <option value="">Select country</option>
              {filteredCountries.map((country) => (
                <option key={country} value={country}>{country}</option>
              ))}
            </select>
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
              className="px-8 py-3 bg-gray-200 text-gray-700 rounded-lg font-medium hover:bg-gray-300 transition-colors"
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
    <div className="fixed inset-0 bg-white z-50 overflow-y-auto">
      <div className="min-h-screen flex flex-col">
        {/* Progress Bar */}
        <div className="w-full bg-gray-200 h-2">
          <div
            className="bg-indigo-600 h-2 transition-all duration-300"
            style={{ width: `${((currentStep + 1) / 14) * 100}%` }}
          />
        </div>

        {/* Content */}
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-2xl w-full">
            <div className="bg-white rounded-lg shadow-lg p-8">
              {renderStep()}
            </div>
          </div>
        </div>

        {/* Navigation */}
        {currentStep < 13 && (
          <div className="border-t border-gray-200 bg-white p-6">
            <div className="max-w-2xl mx-auto flex justify-between items-center">
              <button
                onClick={handleBack}
                disabled={currentStep === 0}
                className="flex items-center gap-2 px-6 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <ArrowLeft className="w-4 h-4" />
                Back
              </button>
              <div className="text-sm text-gray-500">
                Step {currentStep + 1} of 13
              </div>
              <button
                onClick={handleNext}
                disabled={!canProceed()}
                className="flex items-center gap-2 px-6 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {currentStep === 12 ? 'Complete' : 'Next'}
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
