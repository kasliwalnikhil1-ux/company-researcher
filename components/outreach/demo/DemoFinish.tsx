'use client';

/** The card after the walkthrough's last step: book the onboarding call (Calendly, new tab), or keep exploring the demo. */
import { useCallback, useEffect } from 'react';
import { Button } from '@/components/outreach/ui';
import { useAuth } from '@/contexts/AuthContext';
import { onboardingCalendlyUrl } from '@/lib/platform/leads';
import { useDemo } from './DemoProvider';
import GrowthxLogo from './GrowthxLogo';
import { TOUR_STEPS, tourKey } from './tour';

export default function DemoFinish({ onClose }: { onClose: () => void }) {
  const { user } = useAuth();
  const { tour } = useDemo();
  const book = useCallback(() => {
    const meta = (user?.user_metadata ?? {}) as { full_name?: string; name?: string };
    window.open(onboardingCalendlyUrl(user?.email ?? null, meta.full_name ?? meta.name ?? null, 'product_tour_finish'), '_blank', 'noopener');
  }, [user]);
  // Enter, → ↓ and Esc keep exploring (the tour is over: it never starts again from step 1), ← ↑ Backspace go back to
  // its last step. Start opens a new tab, so only a click or a tabbed-to Start does that.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = tourKey(e);
      if (!k) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      onClose();
      if (k === 'back') tour.start(TOUR_STEPS.length - 1);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, tour]);
  return (
    <div className="fixed inset-0 z-[65] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="gxdemo-finish-title">
      <div className="absolute inset-0 bg-gray-900/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md p-6">
        <GrowthxLogo className="mb-5" />
        <h2 id="gxdemo-finish-title" className="text-lg font-semibold text-gray-900">Ready to build your first campaign?</h2>
        <p className="text-sm text-gray-600 mt-2">Import your prospects and set up your outreach.</p>
        <div className="mt-6 flex flex-col sm:flex-row gap-2">
          <Button onClick={book} data-demo-finish-start>Start</Button>
          {/* focused, so Enter keeps exploring rather than pressing whatever had focus (the bar's Restart tour) */}
          <Button variant="ghost" onClick={onClose} autoFocus data-demo-finish-explore>Keep exploring</Button>
        </div>
      </div>
    </div>
  );
}
