'use client';

import { useAuth } from '@/contexts/AuthContext';
import { useOwner } from '@/contexts/OwnerContext';
import Image from 'next/image';
import { useEffect, useState } from 'react';

const STORAGE_KEY = 'book-demo-button-condensed';

export const CALENDLY_URL = 'https://calendly.com/founders-capitalxai/20min';

export function BookDemoButton() {
  const { user } = useAuth();
  const { isFreePlan, isLoading } = useOwner();
  const [isCondensed, setIsCondensed] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored !== null) {
        setIsCondensed(stored === 'true');
      }
    } catch {
      // ignore
    }
  }, []);

  const setCondensed = (value: boolean) => {
    setIsCondensed(value);
    try {
      localStorage.setItem(STORAGE_KEY, String(value));
    } catch {
      // ignore
    }
  };

  const handleBookDemo = () => {
    window.open(CALENDLY_URL, '_blank');
  };

  if (isLoading || !isFreePlan || !user) {
    return null;
  }

  if (isCondensed) {
    return (
      <div className="fixed bottom-6 right-6 z-40">
        <button
          type="button"
          onClick={() => setCondensed(false)}
          className="relative h-12 w-12 rounded-full overflow-hidden border-2 border-white shrink-0 shadow-lg hover:shadow-xl transition-all duration-200 ring-2 ring-brand-fainter hover:ring-brand-default"
        >
          <Image
            src="/avatar.jpg"
            alt="Avatar"
            fill
            className="object-cover"
            sizes="48px"
          />
        </button>
      </div>
    );
  }

  return (
    <div className="fixed bottom-6 right-6 z-40">
      <div className="relative flex items-center">
        <button
          type="button"
          onClick={handleBookDemo}
          className="flex items-center gap-3 pl-1 pr-4 py-1 rounded-full shadow-lg hover:shadow-xl transition-all duration-200 bg-brand-default hover:bg-brand-dark text-white border-2 border-brand-fainter shrink-0"
        >
          <div className="relative h-12 w-12 rounded-full overflow-hidden border-2 border-white shrink-0">
            <Image
              src="/avatar.jpg"
              alt="Avatar"
              fill
              className="object-cover"
              sizes="48px"
            />
          </div>
          <div className="flex flex-col items-start gap-0.5 text-left">
            <span className="text-xs font-semibold leading-tight">Need help?</span>
            <span className="text-xs font-semibold leading-tight">
              Let us setup the demo for you
            </span>
          </div>
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setCondensed(true);
          }}
          className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-white/90 hover:bg-white text-gray-500 hover:text-gray-700 flex items-center justify-center text-xs font-medium shadow-sm transition-colors"
          aria-label="Condense"
        >
          ×
        </button>
      </div>
    </div>
  );
}
