'use client';

import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { supabase } from '@/utils/supabase/client';
import { useAuth } from './AuthContext';

export interface OnboardingData {
  flowType?: 'fundraising' | 'b2b';
  step0?: {
    primaryUse: 'fundraising' | 'b2b';
  };
  // Fundraising flow steps
  step1?: {
    firstName: string;
    lastName: string;
    gender?: string;
  };
  step2?: {
    title: string;
    bio: string;
  };
  step3?: {
    experience: 'getting_started' | 'seasoned' | 'expert';
  };
  step4?: {
    capitalRaised: 'none' | 'less_than_100k' | '100k_500k' | '500k_2m' | '2m_10m' | 'more_than_10m';
  };
  step5?: {
    companyName?: string;
    website: string;
  };
  step6?: {
    sector: string[];
  };
  step7?: {
    stage: string;
  };
  step8?: {
    hqCountry: string;
  };
  step9?: {
    productDescription: string;
  };
  step10?: {
    customerDescription: string;
    revenueStatus: 'yes' | 'no';
    arr?: Array<{
      month: string;
      year: string;
      amount: string;
    }>;
  };
  step11?: {
    timeline: 'near_term' | 'mid_term' | 'later';
    targetRoundSize: 'less_than_500k' | '500k_2m' | '2m_10m' | 'more_than_10m';
  };
  step12?: {
    investorType: 'lead' | 'follow_on' | 'both';
  };
  // B2B Outreach flow steps (step1, step2 shared with fundraising; b2bStep3+ specific)
  b2bStep3?: {
    companyName: string;
    websiteUrl: string;
    companySize: string;
    yourRole: string;
  };
  b2bStep4?: {
    productOrService: string;
  };
  b2bStep5?: {
    coreFeatures: string[];
  };
  b2bStep6?: {
    uniqueSellingPoints: string[];
  };
  b2bStep7?: {
    industry: string;
    companySize: string;
    geography: string;
    buyerRole: string[];
  };
  b2bStep8?: {
    painPoints: string;
  };
  b2bStep9?: {
    buyingTriggers: string;
  };
  b2bStep10?: {
    pricingRange: string;
    contractType: string;
    salesMotion: 'self_serve' | 'sales_assisted' | 'enterprise';
  };
  b2bStep11?: {
    cta: 'book_demo' | 'request_quote' | 'free_trial' | 'waitlist' | 'contact_sales';
  };
  completed?: boolean;
  completedAt?: string;
}

interface OnboardingContextType {
  onboarding: OnboardingData | null;
  loading: boolean;
  fetchOnboarding: () => Promise<void>;
  updateOnboarding: (data: Partial<OnboardingData>) => Promise<void>;
  completeOnboarding: () => Promise<void>;
}

const OnboardingContext = createContext<OnboardingContextType | undefined>(undefined);

export const OnboardingProvider = ({ children }: { children: React.ReactNode }) => {
  const { user } = useAuth();
  const [onboarding, setOnboarding] = useState<OnboardingData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchOnboarding = useCallback(async () => {
    if (!user?.id) {
      setOnboarding(null);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('user_settings')
        .select('onboarding')
        .eq('id', user.id)
        .single();

      if (error && error.code !== 'PGRST116') {
        console.error('Error fetching onboarding:', error);
        setOnboarding(null);
        return;
      }

      if (!data?.onboarding) {
        setOnboarding(null);
        return;
      }

      const parsed = typeof data.onboarding === 'string' 
        ? JSON.parse(data.onboarding) 
        : data.onboarding;
      
      setOnboarding(parsed);
    } catch (error) {
      console.error('Error in fetchOnboarding:', error);
      setOnboarding(null);
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  const updateOnboarding = useCallback(async (updates: Partial<OnboardingData>) => {
    if (!user?.id) return;

    try {
      // Fetch existing user_settings to preserve other columns
      const { data: existing } = await supabase
        .from('user_settings')
        .select('personalization, owners, email_settings, column_settings')
        .eq('id', user.id)
        .single();

      const updatedOnboarding: OnboardingData = {
        ...(onboarding || {}),
        ...updates,
      };

      const payload = {
        id: user.id,
        personalization: existing?.personalization ?? null,
        owners: existing?.owners ?? null,
        email_settings: existing?.email_settings ?? null,
        column_settings: existing?.column_settings ?? null,
        onboarding: updatedOnboarding,
      };

      const { error } = await supabase
        .from('user_settings')
        .upsert(payload, { onConflict: 'id' });

      if (error) throw error;

      setOnboarding(updatedOnboarding);
    } catch (error) {
      console.error('Error updating onboarding:', error);
      throw error;
    }
  }, [user?.id, onboarding]);

  const completeOnboarding = useCallback(async () => {
    await updateOnboarding({
      completed: true,
      completedAt: new Date().toISOString(),
    });
  }, [updateOnboarding]);

  useEffect(() => {
    fetchOnboarding();
  }, [fetchOnboarding]);

  const value: OnboardingContextType = {
    onboarding,
    loading,
    fetchOnboarding,
    updateOnboarding,
    completeOnboarding,
  };

  return (
    <OnboardingContext.Provider value={value}>
      {children}
    </OnboardingContext.Provider>
  );
};

export const useOnboarding = () => {
  const context = useContext(OnboardingContext);
  if (context === undefined) {
    throw new Error('useOnboarding must be used within an OnboardingProvider');
  }
  return context;
};
