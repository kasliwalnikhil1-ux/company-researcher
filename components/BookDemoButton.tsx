'use client';

import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/utils/supabase/client';
import Image from 'next/image';
import { useState, useEffect } from 'react';

const CALENDLY_URL = 'https://calendly.com/founders-capitalxai/20min';

export function BookDemoButton() {
  const { user } = useAuth();
  const [plan, setPlan] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.id) {
      setLoading(false);
      return;
    }
    const fetchPlan = async () => {
      try {
        const { data } = await supabase
          .from('user_settings')
          .select('plan')
          .eq('id', user.id)
          .single();
        setPlan(data?.plan ?? 'free');
      } catch {
        setPlan('free');
      } finally {
        setLoading(false);
      }
    };
    fetchPlan();
  }, [user?.id]);

  const isFreePlan = plan === 'free';

  if (loading || !isFreePlan || !user) {
    return null;
  }

  const handleBookDemo = () => {
    window.open(CALENDLY_URL, '_blank');
  };

  return (
    <div className="fixed bottom-6 right-6 z-40">
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
    </div>
  );
}
