/** The GrowthxAI lockup on the tour's cards, as in the marketing site's header (mark + "GrowthxAI Outreach"). */
export default function GrowthxLogo({ className }: { className?: string }) {
  return (
    <div className={`flex items-center gap-2 ${className ?? ''}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo.png" alt="" width={28} height={28} className="h-7 w-7" />
      <span className="text-base font-bold tracking-tight text-gray-900">GrowthxAI <span className="font-normal text-gray-500">Outreach</span></span>
    </div>
  );
}
