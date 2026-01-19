'use client';

import { createContext, useContext, useEffect, useState } from 'react';

export type Owner = 'Aarushi' | 'Naman' | 'Ram' | 'Harshit';

const OWNER_STORAGE_KEY = 'selected-owner';

// Color mapping for each owner
export const OWNER_COLORS: Record<Owner, { bg: string; text: string; border: string }> = {
  Aarushi: {
    bg: 'bg-blue-50',
    text: 'text-blue-700',
    border: 'border-blue-200',
  },
  Naman: {
    bg: 'bg-purple-50',
    text: 'text-purple-700',
    border: 'border-purple-200',
  },
  Ram: {
    bg: 'bg-green-50',
    text: 'text-green-700',
    border: 'border-green-200',
  },
  Harshit: {
    bg: 'bg-orange-50',
    text: 'text-orange-700',
    border: 'border-orange-200',
  },
};

type OwnerContextType = {
  selectedOwner: Owner;
  setSelectedOwner: (owner: Owner) => void;
  availableOwners: Owner[];
};

const OwnerContext = createContext<OwnerContextType | undefined>(undefined);

export const OwnerProvider = ({ children }: { children: React.ReactNode }) => {
  const [selectedOwner, setSelectedOwnerState] = useState<Owner>('Aarushi');
  const [isHydrated, setIsHydrated] = useState(false);

  // Available owners list
  const availableOwners: Owner[] = ['Aarushi', 'Naman', 'Ram', 'Harshit'];

  // Load from localStorage on mount
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem(OWNER_STORAGE_KEY);
      if (stored && availableOwners.includes(stored as Owner)) {
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
    availableOwners,
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
