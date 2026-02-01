'use client';

import React, { createContext, useContext, useState, useCallback } from 'react';
import PricingModal from '@/components/ui/PricingModal';

interface PricingModalContextValue {
  openPricingModal: () => void;
  closePricingModal: () => void;
}

const PricingModalContext = createContext<PricingModalContextValue | null>(null);

export function PricingModalProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);

  const openPricingModal = useCallback(() => {
    setIsOpen(true);
  }, []);

  const closePricingModal = useCallback(() => {
    setIsOpen(false);
  }, []);

  return (
    <PricingModalContext.Provider value={{ openPricingModal, closePricingModal }}>
      {children}
      <PricingModal isOpen={isOpen} onClose={closePricingModal} />
    </PricingModalContext.Provider>
  );
}

export function usePricingModal() {
  const ctx = useContext(PricingModalContext);
  if (!ctx) {
    throw new Error('usePricingModal must be used within PricingModalProvider');
  }
  return ctx;
}
