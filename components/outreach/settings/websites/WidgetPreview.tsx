'use client';

// Live preview of the widget (web-chat-PRD.md §12.2): a faithful, static rendering of the launcher + panel from the
// settings draft. Desktop / mobile switch mirrors the launcher's per-device options.

import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { WebchatSettings } from '@/lib/outreach/webchat';

function contrast(hex: string): string {
  const h = hex.replace('#', ''); const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16); if (Number.isNaN(n)) return '#fff';
  const [r, g, b] = [n >> 16 & 255, n >> 8 & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? '#111827' : '#ffffff';
}

export default function WidgetPreview({ settings, online = true, brandFallback }: { settings: WebchatSettings; online?: boolean; brandFallback?: string }) {
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [open, setOpen] = useState(true);
  const ap = settings.appearance, la = device === 'mobile' ? { ...settings.launcher.desktop, ...settings.launcher.mobile } : settings.launcher.desktop, ms = settings.messages;
  const accent = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(ap.accent) ? ap.accent : '#4f46e5', on = contrast(accent);
  const dark = ap.theme === 'dark';
  const size = { sm: 44, md: 52, lg: 60 }[la.size] ?? 52;
  const left = la.position === 'left';
  const brand = ap.brand_name || brandFallback || 'Chat';
  return (
    <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 text-xs">
        <span className="text-gray-500">Preview</span>
        <div className="flex gap-1">
          {(['desktop', 'mobile'] as const).map((d) => <button key={d} type="button" onClick={() => setDevice(d)} className={cn('px-2 py-0.5 rounded', device === d ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100')}>{d}</button>)}
          <button type="button" onClick={() => setOpen((o) => !o)} className="px-2 py-0.5 rounded text-gray-600 hover:bg-gray-100">{open ? 'closed state' : 'open state'}</button>
        </div>
      </div>
      <div className={cn('relative bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] [background-size:16px_16px]', device === 'mobile' ? 'h-[560px] w-[320px] mx-auto' : 'h-[560px]')} style={{ fontFamily: `${ap.font && ap.font !== 'Inter' ? ap.font + ',' : ''}Inter, system-ui, sans-serif` }}>
        {/* launcher */}
        {!(settings.launcher.hide) && !(open && device === 'mobile') && (
          <div className="absolute flex flex-col gap-2 items-end" style={{ bottom: la.margin_bottom, [left ? 'left' : 'right']: la.margin_side, alignItems: left ? 'flex-start' : 'flex-end' }}>
            {settings.popup.enabled && !open && <div className="max-w-[240px] rounded-xl bg-white shadow-lg px-3 py-2 text-[13px] text-gray-800 flex gap-2 items-start">{settings.popup.image_url && <span className="w-8 h-8 rounded-full bg-gray-200 flex-shrink-0" />}<span>{settings.popup.text}</span></div>}
            <div className="relative inline-flex items-center justify-center gap-2 shadow-lg text-[15px] font-semibold" style={{ background: accent, color: on, height: la.type === 'button' && device === 'desktop' ? Math.max(44, size - 8) : size, width: la.type === 'button' && device === 'desktop' ? 'auto' : size, padding: la.type === 'button' && device === 'desktop' ? '0 18px 0 14px' : 0, borderRadius: 999 }}>
              {open ? <span className="text-xl leading-none">×</span> : <svg viewBox="0 0 24 24" width={Math.round(size * 0.44)} height={Math.round(size * 0.44)} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>}
              {la.type === 'button' && device === 'desktop' && !open && <span>{la.text}</span>}
              {settings.launcher.show_unread_count && !open && <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center ring-2 ring-white">2</span>}
              {settings.launcher.online_dot && online && !open && <span className="absolute bottom-0.5 right-0.5 w-3 h-3 rounded-full bg-emerald-500 ring-2 ring-white" />}
            </div>
          </div>
        )}
        {/* panel */}
        {open && (
          <div className={cn('absolute flex flex-col overflow-hidden shadow-2xl', device === 'mobile' ? 'inset-0' : 'w-[320px] h-[440px] rounded-2xl')} style={device === 'mobile' ? { background: dark ? '#111827' : ap.widget_bg } : { bottom: la.margin_bottom + size + 12, [left ? 'left' : 'right']: la.margin_side, background: dark ? '#111827' : ap.widget_bg }}>
            <div className="flex items-center gap-2.5 px-4 py-3" style={{ background: accent, color: on }}>
              <div className="w-9 h-9 rounded-full bg-white/25 flex items-center justify-center overflow-hidden font-bold text-sm">{ap.logo_url ? <img src={ap.logo_url} alt="" className="w-full h-full object-cover" /> : brand.slice(0, 1).toUpperCase()}</div>
              <div className="min-w-0"><div className="font-bold text-[15px] leading-tight truncate">{brand}</div><div className="text-[12px] opacity-90 flex items-center gap-1.5"><span className={cn('w-2 h-2 rounded-full', online ? 'bg-emerald-400' : 'bg-gray-300')} />{online ? ({ minutes: 'Typically replies in a few minutes', hours: 'Typically replies in a few hours', day: 'Typically replies in a day', none: 'We are online' } as Record<string, string>)[ms.reply_time] : ms.unavailable_message}</div></div>
            </div>
            <div className="flex-1 p-4 space-y-3 text-[13px]" style={{ background: dark ? '#0b1220' : ap.chat_bg, color: dark ? '#f3f4f6' : '#111827' }}>
              <div><div className="text-[20px] font-bold leading-tight">{ap.welcome_title}</div><div className="opacity-70">{ap.welcome_tagline}</div></div>
              {ms.greeting_enabled && <div className="max-w-[85%] rounded-2xl px-3 py-2" style={{ background: dark ? '#1f2937' : '#fff', border: '1px solid rgba(0,0,0,.06)' }}>{ms.greeting}</div>}
              <div className="flex justify-end"><div className="max-w-[85%] rounded-2xl px-3 py-2" style={{ background: accent, color: on }}>Hi! I have a question about pricing.</div></div>
              {ms.quick_replies?.length > 0 && <div className="flex flex-wrap gap-1.5">{ms.quick_replies.slice(0, 4).map((q) => <span key={q} className="rounded-full px-3 py-1 text-[12px]" style={{ background: dark ? '#1f2937' : '#fff', border: '1px solid rgba(0,0,0,.1)' }}>{q}</span>)}</div>}
            </div>
            <div className="px-3 py-2 flex items-center gap-2 border-t" style={{ borderColor: dark ? '#1f2937' : '#e5e7eb' }}>
              <div className="flex-1 rounded-xl px-3 py-2 text-[13px] opacity-60" style={{ background: dark ? '#1f2937' : '#fff', border: '1px solid rgba(0,0,0,.1)', color: dark ? '#e5e7eb' : '#374151' }}>{ms.placeholder}</div>
              <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: accent, color: on }}>➤</div>
            </div>
            {settings.features.powered_by && <div className="text-center text-[10px] py-1 opacity-60" style={{ color: dark ? '#e5e7eb' : '#6b7280' }}>Powered by GrowthxAI</div>}
          </div>
        )}
      </div>
    </div>
  );
}
