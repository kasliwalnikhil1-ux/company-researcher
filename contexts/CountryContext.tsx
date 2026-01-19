'use client';

import { createContext, useContext, useEffect, useState } from 'react';

// Single source of truth - define country codes here only
const COUNTRY_CONFIG = [
  {
    name: 'Auto' as const,
    code: 'auto' as const,
    flag: '🌐',
  },
  {
    name: 'India' as const,
    code: '+91' as const,
    flag: '🇮🇳',
  },
  {
    name: 'United States' as const,
    code: '+1' as const,
    flag: '🇺🇸',
  },
  {
    name: 'United Kingdom' as const,
    code: '+44' as const,
    flag: '🇬🇧',
  },
  {
    name: 'Australia' as const,
    code: '+61' as const,
    flag: '🇦🇺',
  },
  {
    name: 'Canada' as const,
    code: '+1' as const,
    flag: '🇨🇦',
  },
  {
    name: 'Germany' as const,
    code: '+49' as const,
    flag: '🇩🇪',
  },
  {
    name: 'France' as const,
    code: '+33' as const,
    flag: '🇫🇷',
  },
] as const;

// Extract country names and codes from config
const COUNTRIES = COUNTRY_CONFIG.map(config => config.name) as readonly string[];

// Derive types from the config
export type Country = typeof COUNTRY_CONFIG[number]['name'];
export type CountryCode = typeof COUNTRY_CONFIG[number]['code'];

// Export the countries array
export const AVAILABLE_COUNTRIES: Country[] = COUNTRY_CONFIG.map(config => config.name);

// Storage key for localStorage
const COUNTRY_STORAGE_KEY = 'selected-country';

// Build mappings from config - ensures single source of truth
export const COUNTRY_DATA: Record<Country, {
  code: CountryCode;
  flag: string;
}> = COUNTRY_CONFIG.reduce((acc, config) => {
  acc[config.name] = {
    code: config.code,
    flag: config.flag,
  };
  return acc;
}, {} as Record<Country, { code: CountryCode; flag: string }>);

type CountryContextType = {
  selectedCountry: Country;
  setSelectedCountry: (country: Country) => void;
  availableCountries: Country[];
  getCountryCode: (country: Country) => CountryCode;
  getCountryFlag: (country: Country) => string;
  getEffectiveCountryCode: () => CountryCode;
};

const CountryContext = createContext<CountryContextType | undefined>(undefined);

export const CountryProvider = ({ children }: { children: React.ReactNode }) => {
  // Use Auto as default (first in array)
  const [selectedCountry, setSelectedCountryState] = useState<Country>(AVAILABLE_COUNTRIES[0]);
  const [isHydrated, setIsHydrated] = useState(false);

  // Load from localStorage on mount
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem(COUNTRY_STORAGE_KEY);
      if (stored && AVAILABLE_COUNTRIES.includes(stored as Country)) {
        setSelectedCountryState(stored as Country);
      }
      setIsHydrated(true);
    }
  }, []);

  const setSelectedCountry = (country: Country) => {
    setSelectedCountryState(country);
    if (typeof window !== 'undefined') {
      localStorage.setItem(COUNTRY_STORAGE_KEY, country);
    }
  };

  const getCountryCode = (country: Country): CountryCode => {
    return COUNTRY_DATA[country].code;
  };

  const getCountryFlag = (country: Country): string => {
    return COUNTRY_DATA[country].flag;
  };

  const getEffectiveCountryCode = (): CountryCode => {
    // If "Auto" is selected, default to India (+91) for now
    // This can be enhanced later with actual auto-detection logic
    if (selectedCountry === 'Auto') {
      return '+91';
    }
    return getCountryCode(selectedCountry);
  };

  const value = {
    selectedCountry,
    setSelectedCountry,
    availableCountries: AVAILABLE_COUNTRIES,
    getCountryCode,
    getCountryFlag,
    getEffectiveCountryCode,
  };

  return (
    <CountryContext.Provider value={value}>
      {children}
    </CountryContext.Provider>
  );
};

export const useCountry = () => {
  const context = useContext(CountryContext);
  if (context === undefined) {
    throw new Error('useCountry must be used within a CountryProvider');
  }
  return context;
};