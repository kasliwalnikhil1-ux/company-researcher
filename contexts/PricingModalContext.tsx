'use client';

import React, { createContext, useContext, useState, useCallback } from 'react';
import PricingModal from '@/components/ui/PricingModal';
import ROIModal from '@/components/ui/ROIModal';

interface PricingModalContextValue {
  openPricingModal: () => void;
  closePricingModal: () => void;
  openROIModal: () => void;
  closeROIModal: () => void;
}

const PricingModalContext = createContext<PricingModalContextValue | null>(null);

export function PricingModalProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [isROIOpen, setIsROIOpen] = useState(false);

  const openPricingModal = useCallback(() => {
    setIsOpen(true);
  }, []);

  const closePricingModal = useCallback(() => {
    setIsOpen(false);
  }, []);

  const openROIModal = useCallback(() => {
    setIsROIOpen(true);
  }, []);

  const closeROIModal = useCallback(() => {
    setIsROIOpen(false);
  }, []);

  return (
    <PricingModalContext.Provider value={{ openPricingModal, closePricingModal, openROIModal, closeROIModal }}>
      {children}
      <PricingModal isOpen={isOpen} onClose={closePricingModal} />
      <ROIModal isOpen={isROIOpen} onClose={closeROIModal} />
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
