'use client';

import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/utils/supabase/client';

export interface OwnerColors {
  bg: string;
  text: string;
  border: string;
  hex: string;
}

export interface OwnerConfigItem {
  name: string;
  colors: OwnerColors;
}

export type Owner = string;

const OWNER_STORAGE_KEY = 'selected-owner';

const DEFAULT_COLOR_PRESETS: OwnerColors[] = [
  { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200', hex: '#2563eb' },
  { bg: 'bg-purple-50', text: 'text-purple-700', border: 'border-purple-200', hex: '#9333ea' },
  { bg: 'bg-green-50', text: 'text-green-700', border: 'border-green-200', hex: '#16a34a' },
  { bg: 'bg-orange-50', text: 'text-orange-700', border: 'border-orange-200', hex: '#ea580c' },
  { bg: 'bg-pink-50', text: 'text-pink-700', border: 'border-pink-200', hex: '#db2777' },
  { bg: 'bg-cyan-50', text: 'text-cyan-700', border: 'border-cyan-200', hex: '#0891b2' },
];

export const OWNER_PRESET_LABELS = ['Blue', 'Purple', 'Green', 'Orange', 'Pink', 'Cyan'] as const;

type OwnerContextType = {
  selectedOwner: Owner;
  setSelectedOwner: (owner: Owner) => void;
  availableOwners: Owner[];
  ownerColors: Record<string, OwnerColors>;
  ownerConfig: OwnerConfigItem[];
  isLoading: boolean;
  refetchOwners: () => Promise<void>;
};

const OwnerContext = createContext<OwnerContextType | undefined>(undefined);

export const OwnerProvider = ({ children }: { children: React.ReactNode }) => {
  const { user } = useAuth();
  const [ownerConfig, setOwnerConfig] = useState<OwnerConfigItem[]>([]);
  const [selectedOwner, setSelectedOwnerState] = useState<Owner>('');
  const [isLoading, setIsLoading] = useState(true);
  const [isHydrated, setIsHydrated] = useState(false);

  const availableOwners = ownerConfig.map((c) => c.name);
  const ownerColors: Record<string, OwnerColors> = ownerConfig.reduce(
    (acc, c) => {
      acc[c.name] = c.colors;
      return acc;
    },
    {} as Record<string, OwnerColors>
  );

  const fetchOwners = useCallback(async () => {
    if (!user?.id) {
      setOwnerConfig([]);
      setIsLoading(false);
      return;
    }
    try {
      setIsLoading(true);
      const { data, error } = await supabase
        .from('user_settings')
        .select('owners')
        .eq('id', user.id)
        .single();

      if (error && error.code !== 'PGRST116') {
        console.error('Error fetching owners:', error);
        setOwnerConfig([]);
        return;
      }

      let config: OwnerConfigItem[] = [];
      if (data?.owners) {
        const raw = typeof data.owners === 'string' ? JSON.parse(data.owners) : data.owners;
        if (Array.isArray(raw) && raw.length > 0) {
          config = raw.filter(
            (x: unknown): x is OwnerConfigItem =>
              typeof x === 'object' &&
              x !== null &&
              typeof (x as OwnerConfigItem).name === 'string' &&
              typeof (x as OwnerConfigItem).colors === 'object'
          );
        }
      }
      setOwnerConfig(config);
    } finally {
      setIsLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    fetchOwners();
  }, [fetchOwners]);

  // Hydration: load selectedOwner from localStorage and validate against availableOwners
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = localStorage.getItem(OWNER_STORAGE_KEY);
    if (availableOwners.length === 0) {
      setSelectedOwnerState('');
    } else if (stored && availableOwners.includes(stored)) {
      setSelectedOwnerState(stored);
    } else {
      setSelectedOwnerState(availableOwners[0]);
    }
    setIsHydrated(true);
  }, [availableOwners.join(',')]);

  const setSelectedOwner = (owner: Owner) => {
    setSelectedOwnerState(owner);
    if (typeof window !== 'undefined') {
      localStorage.setItem(OWNER_STORAGE_KEY, owner);
    }
  };

  const value: OwnerContextType = {
    selectedOwner,
    setSelectedOwner,
    availableOwners,
    ownerColors,
    ownerConfig,
    isLoading,
    refetchOwners: fetchOwners,
  };

  return (
    <OwnerContext.Provider value={value}>
      {children}
    </OwnerContext.Provider>
  );
};

export const useOwner = () => {
  const context = useContext(OwnerContext);
  if (context === undefined) {
    throw new Error('useOwner must be used within an OwnerProvider');
  }
  return context;
};

// Default color presets for Account page when adding new owners
export const OWNER_COLOR_PRESETS = DEFAULT_COLOR_PRESETS;
