'use client';

import { useState } from 'react';
import { HelpCircle, Inbox, LayoutDashboard, BarChart3 } from 'lucide-react';
import { DEFAULT_ACCENT, contrastOn, isHexColor, isHttpsUrl, productName, type Branding } from '@/lib/outreach/branding';

function Logo({ b, size = 28 }: { b: Branding; size?: number }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const accent = isHexColor(b.accent) ? b.accent : DEFAULT_ACCENT;
  const name = productName(b);
  if (isHttpsUrl(b.logo_url) && failedUrl !== b.logo_url) return <img src={b.logo_url} alt="" referrerPolicy="no-referrer" onError={() => setFailedUrl(b.logo_url ?? null)} style={{ height: size, maxWidth: 140 }} className="object-contain" />;
  return <span className="rounded-md text-xs font-semibold flex items-center justify-center" style={{ width: size, height: size, background: accent, color: contrastOn(accent) }}>{name[0]?.toUpperCase()}</span>;
}

/** Live preview of the two places a client sees the brand: the portal header and the header of an email. Nothing here is saved. */
export default function BrandingPreview({ branding, clientName = 'Acme Inc' }: { branding: Branding; clientName?: string }) {
  const accent = isHexColor(branding.accent) ? branding.accent : DEFAULT_ACCENT;
  const on = contrastOn(accent);
  const name = productName(branding);
  const hasHelp = !!(branding.support_email || isHttpsUrl(branding.help_url) || isHttpsUrl(branding.docs_url));
  const fromName = branding.email_from_name || name;
  const fromAddr = branding.email_from_address || (branding.hide_platform_name ? 'reports@your-domain.com' : 'notifications@capitalxai.com');

  return (
    <div className="space-y-5" aria-label="Preview">
      <div>
        <div className="text-xs font-medium text-gray-600 mb-1.5">Client portal</div>
        <div className="border border-gray-200 rounded-lg overflow-hidden bg-gray-50">
          <div className="bg-white border-b border-gray-200 px-3 h-11 flex items-center gap-3">
            <Logo b={branding} size={24} />
            <span className="text-sm font-semibold text-gray-900 truncate max-w-[130px]">{name}</span>
            <span className="flex items-center gap-1 ml-1 text-xs">
              <span className="flex items-center gap-1 px-2 py-1 rounded-md font-medium" style={{ color: accent, background: `${accent}14` }}><LayoutDashboard className="w-3 h-3" /> Dashboard</span>
              <span className="hidden sm:flex items-center gap-1 px-2 py-1 text-gray-500"><Inbox className="w-3 h-3" /> Inbox</span>
              <span className="hidden sm:flex items-center gap-1 px-2 py-1 text-gray-500"><BarChart3 className="w-3 h-3" /> Reports</span>
            </span>
            {hasHelp && <span className="ml-auto flex items-center gap-1 text-xs text-gray-500"><HelpCircle className="w-3 h-3" /> Help</span>}
          </div>
          <div className="p-3">
            <div className="text-sm font-semibold text-gray-900">{clientName}</div>
            <div className="grid grid-cols-3 gap-2 mt-2">{['Invites', 'Replies', 'Meetings'].map((l, i) => <div key={l} className="bg-white border border-gray-200 rounded-lg px-2 py-1.5"><div className="text-[10px] text-gray-500">{l}</div><div className="text-sm font-semibold text-gray-900">{[412, 58, 9][i]}</div></div>)}</div>
            <span className="inline-block mt-3 text-xs font-medium rounded-md px-2.5 py-1" style={{ background: accent, color: on }}>Open inbox</span>
          </div>
        </div>
      </div>

      <div>
        <div className="text-xs font-medium text-gray-600 mb-1.5">Email to a client</div>
        <div className="border border-gray-200 rounded-lg overflow-hidden bg-white">
          <div className="px-3 py-2 border-b border-gray-100 text-xs text-gray-600"><span className="font-medium text-gray-900">{fromName}</span> <span className="text-gray-400">&lt;{fromAddr}&gt;</span><div className="text-gray-900 mt-0.5">Your weekly outreach report</div></div>
          <div className="px-4 py-3" style={{ borderTop: `3px solid ${accent}` }}>
            <div className="flex items-center gap-2"><Logo b={branding} size={22} /><span className="text-sm font-semibold text-gray-900">{name}</span></div>
            <p className="text-xs text-gray-600 mt-2">Hi, here is how {clientName} did last week: 58 replies, 9 meetings booked.</p>
            <span className="inline-block mt-2 text-xs font-medium rounded-md px-2.5 py-1" style={{ background: accent, color: on }}>View the report</span>
            <p className="text-[10px] text-gray-400 mt-3">{branding.support_email ? `Questions? ${branding.support_email}` : 'Questions? Reply to this email.'}{!branding.hide_platform_name && <> · Sent with CapitalxAI Outreach</>}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
