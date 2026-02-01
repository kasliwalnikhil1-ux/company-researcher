'use client';

import React from 'react';
import { usePricingModal } from '@/contexts/PricingModalContext';

interface InsufficientCreditsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const InsufficientCreditsModal: React.FC<InsufficientCreditsModalProps> = ({ isOpen, onClose }) => {
  const { openPricingModal } = usePricingModal();

  if (!isOpen) return null;

  const handleBuyCredits = () => {
    onClose();
    openPricingModal();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
        <h2 className="text-xl font-semibold text-gray-900 mb-2">Out of credits</h2>
        <p className="text-gray-600 mb-6">
          You&apos;ve run out of credits. Upgrade your plan or purchase more credits to continue.
        </p>
        <div className="flex gap-3 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-md transition-colors"
          >
            Close
          </button>
          <button
            onClick={handleBuyCredits}
            className="px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 transition-colors"
          >
            Buy credits
          </button>
        </div>
      </div>
    </div>
  );
};

export default InsufficientCreditsModal;
