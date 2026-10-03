'use client';

/** The card after the walkthrough's last step: book the onboarding call (Calendly, new tab), or keep exploring the demo. */
import { Button } from '@/components/outreach/ui';
import { useAuth } from '@/contexts/AuthContext';
import { onboardingCalendlyUrl } from '@/lib/platform/leads';
import GrowthxLogo from './GrowthxLogo';

export default function DemoFinish({ onClose }: { onClose: () => void }) {
  const { user } = useAuth();
  const book = () => {
    const meta = (user?.user_metadata ?? {}) as { full_name?: string; name?: string };
    window.open(onboardingCalendlyUrl(user?.email ?? null, meta.full_name ?? meta.name ?? null, 'product_tour_finish'), '_blank', 'noopener');
  };
  return (
    <div className="fixed inset-0 z-[65] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="gxdemo-finish-title">
      <div className="absolute inset-0 bg-gray-900/50" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md p-6">
        <GrowthxLogo className="mb-5" />
        <h2 id="gxdemo-finish-title" className="text-lg font-semibold text-gray-900">Ready to build your first campaign?</h2>
        <p className="text-sm text-gray-600 mt-2">Import your prospects and set up your outreach.</p>
        <div className="mt-6 flex flex-col sm:flex-row gap-2">
          <Button onClick={book} data-demo-finish-start>Start</Button>
          <Button variant="ghost" onClick={onClose} data-demo-finish-explore>Keep exploring</Button>
        </div>
      </div>
    </div>
  );
}
