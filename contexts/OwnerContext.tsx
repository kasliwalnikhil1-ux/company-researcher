'use client';

import { createContext, useContext, useEffect, useState } from 'react';

// Single source of truth - define owners and their colors here only
const OWNER_CONFIG = [
  {
    name: 'Deepak' as const,
    colors: {
      bg: 'bg-blue-50',
      text: 'text-blue-700',
      border: 'border-blue-200',
      hex: '#2563eb', // blue-600
    },
  },
  {
    name: 'Naman' as const,
    colors: {
      bg: 'bg-purple-50',
      text: 'text-purple-700',
      border: 'border-purple-200',
      hex: '#9333ea', // purple-600
    },
  },
  {
    name: 'Ram' as const,
    colors: {
      bg: 'bg-green-50',
      text: 'text-green-700',
      border: 'border-green-200',
      hex: '#16a34a', // green-600
    },
  },
  {
    name: 'Harshit' as const,
    colors: {
      bg: 'bg-orange-50',
      text: 'text-orange-700',
      border: 'border-orange-200',
      hex: '#ea580c', // orange-600
    },
  },
] as const;

// Extract owners array from config
const OWNERS = OWNER_CONFIG.map(config => config.name) as readonly string[];

// Derive type from the config
export type Owner = typeof OWNER_CONFIG[number]['name'];

// Export the owners array
export const AVAILABLE_OWNERS: Owner[] = OWNER_CONFIG.map(config => config.name);

const OWNER_STORAGE_KEY = 'selected-owner';

// Build color mapping from config - ensures single source of truth
export const OWNER_COLORS: Record<Owner, { 
  bg: string; 
  text: string; 
  border: string; 
  hex: string; 
}> = OWNER_CONFIG.reduce((acc, config) => {
  acc[config.name] = config.colors;
  return acc;
}, {} as Record<Owner, { bg: string; text: string; border: string; hex: string }>);

type OwnerContextType = {
  selectedOwner: Owner;
  setSelectedOwner: (owner: Owner) => void;
  availableOwners: Owner[];
};

const OwnerContext = createContext<OwnerContextType | undefined>(undefined);

export const OwnerProvider = ({ children }: { children: React.ReactNode }) => {
  // Use first available owner as default instead of hardcoding
  const [selectedOwner, setSelectedOwnerState] = useState<Owner>(AVAILABLE_OWNERS[0]);
  const [isHydrated, setIsHydrated] = useState(false);

  // Load from localStorage on mount
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem(OWNER_STORAGE_KEY);
      if (stored && AVAILABLE_OWNERS.includes(stored as Owner)) {
        setSelectedOwnerState(stored as Owner);
      }
      setIsHydrated(true);
    }
  }, []);

  const setSelectedOwner = (owner: Owner) => {
    setSelectedOwnerState(owner);
    if (typeof window !== 'undefined') {
      localStorage.setItem(OWNER_STORAGE_KEY, owner);
    }
  };

  const value = {
    selectedOwner,
    setSelectedOwner,
    availableOwners: AVAILABLE_OWNERS,
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
