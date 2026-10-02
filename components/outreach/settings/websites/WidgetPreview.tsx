'use client';

// Live preview of the widget (web-chat-PRD.md §12.2): a faithful, static rendering of the launcher + panel from the
// settings draft. Desktop / mobile switch mirrors the launcher's per-device options.

import { useMemo, useState } from 'react';
import { ArrowUp, ExternalLink, MessageSquare, Paperclip, Smile, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { IS_DEMO } from '@/lib/outreach/mode';
import { VIDEO_BUBBLE_DEFAULTS, avatarUrl, flagUrl, mediaUrl, videoClips, videoQuestions, type VideoBubbleSettings, type WebchatSettings } from '@/lib/outreach/webchat';

function contrast(hex: string): string {
  const h = hex.replace('#', ''); const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16); if (Number.isNaN(n)) return '#fff';
  const [r, g, b] = [n >> 16 & 255, n >> 8 & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? '#111827' : '#ffffff';
}
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const hex = (c: string | null | undefined, d: string) => (c && HEX.test(c) ? c : d);
const clamp = (v: number, lo: number, hi: number, d: number) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
const ratioCss = (r: string | undefined, d: string) => { const m = /^(\d{1,2}):(\d{1,2})$/.exec(r ?? ''); return m && +m[1] && +m[2] ? `${m[1]} / ${m[2]}` : d; };

/**
 * The launcher clip as the widget draws it (public/widget/v1/video.js): the bubble, or the expanded view with the questions.
 * In the expanded view a question that has its own clip can be clicked: its clip plays in place, its button dims and its
 * page link shows, as on the site. Clicking it again goes back to the main clip. When the clip that is up exists in more
 * than one language, the strip of flags shows beside it and switches the language of every clip.
 */
export function VideoBubbleFrame({ v, accent, expanded = false, scale = 1, maxWidth = 320, onToggle }: { v: VideoBubbleSettings; accent: string; expanded?: boolean; scale?: number; maxWidth?: number; onToggle?: () => void }) {
  const [ar, setAr] = useState(16 / 9);
  const [picked, setPicked] = useState<number | null>(null);
  const [lang, setLang] = useState<string | null>(null);
  const langs = v.languages ?? [], code = lang && langs.some((l) => l.code === lang) ? lang : langs[0]?.code ?? null;
  const pick = <T extends { lang: string | null }>(list: T[]): T | undefined => list.find((c) => c.lang === code) ?? list[0];
  const mains = videoClips(v.url, v.kind, v.variants, langs), main = pick(mains);
  if (!main) return null;
  const qs = videoQuestions(v.questions).filter((q) => q.text.trim()).slice(0, 6).map((q) => ({ ...q, clips: videoClips(q.video_url, q.video_kind, q.video_variants, langs) }));
  const sel = expanded && picked != null && qs[picked]?.clips.length ? picked : null, answer = sel == null ? null : qs[sel];
  const playing = (answer && pick(answer.clips)) || main, clip = mediaUrl(playing.url)!, clipKind = playing.kind;
  // the strip: only for a clip that exists in more than one language
  const stripList = expanded ? (answer ? answer.clips : mains) : [], anyStrip = mains.length > 1 || qs.some((q) => q.clips.length > 1);
  const circle = v.shape !== 'rounded' && v.shape !== 'square', size = Math.round(clamp(v.size, 64, 240, 120) * scale), focus = `${clamp(v.focus_x, 0, 100, 50)}% ${clamp(v.focus_y, 0, 100, 50)}%`;
  const width = expanded ? Math.min(clamp(v.expanded_width, 280, 720, 420), maxWidth - (anyStrip ? 58 : 0)) : size;
  const xo = expanded ? -10 : circle ? Math.round(size * 0.146) - 12 : -8;
  const below = v.questions_position === 'below', qbg = hex(v.question_bg, '#111827'), qc = hex(v.question_color, '#ffffff');
  const setRatio = (w: number, h: number) => { if (w && h) setAr(Math.max(0.5625, Math.min(1.7778, w / h))); };
  const media = { className: 'block w-full h-full', style: { objectFit: expanded ? 'cover' as const : v.fit, objectPosition: focus, transform: expanded ? undefined : `scale(${clamp(v.zoom, 100, 300, 100) / 100})`, transformOrigin: focus } };
  const questions = (
    <div className="flex flex-wrap gap-1.5" style={below ? { width } : { padding: '26px 10px 10px', background: 'linear-gradient(transparent, rgba(0,0,0,.62))' }}>
      {answer?.link_url && (
        <span className="basis-full min-w-0 flex">
          <a href={answer.link_url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1.5 max-w-full rounded-full bg-white/95 px-3 py-1.5 text-[11.5px] font-semibold text-gray-900 shadow">
            <ExternalLink className="w-3 h-3 flex-none" /><span className="truncate">{answer.link_text || 'Learn more'}</span>
          </a>
        </span>
      )}
      {qs.map((q, i) => {
        const hasClip = q.clips.length > 0;
        return (
          <span key={`${i}:${q.text}`} role={hasClip ? 'button' : undefined} title={hasClip ? (sel === i ? 'Back to the main clip' : 'Play this question\u2019s video') : undefined}
            onClick={hasClip ? (e) => { e.stopPropagation(); setPicked(sel === i ? null : i); } : undefined}
            className={cn('flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold leading-tight shadow transition-opacity', hasClip && 'cursor-pointer')}
            style={{ flex: '1 1 40%', minWidth: 0, background: qbg, opacity: sel === i ? 0.5 : below || sel != null ? 1 : 0.92, color: qc }}>
            <b className="flex-none w-[18px] h-[18px] rounded-full border border-current opacity-80 text-[9px] flex items-center justify-center">{String.fromCharCode(65 + i)}</b><span className="line-clamp-2">{q.text}</span>
          </span>
        );
      })}
      <span className="flex items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold shadow" style={{ flex: '1 1 40%', background: hex(v.cta_bg, accent), color: hex(v.cta_color, '#ffffff') }}><MessageSquare className="w-3.5 h-3.5" />{v.cta_text || 'Chat with us'}</span>
    </div>
  );
  return (
    <div className="relative flex flex-col items-end gap-2">
      <div role={onToggle ? 'button' : undefined} onClick={onToggle} className={cn('relative overflow-hidden bg-gray-900 shadow-lg transition-all', onToggle && !expanded && 'cursor-pointer')}
        style={{ width, aspectRatio: expanded ? (v.expanded_ratio && v.expanded_ratio !== 'auto' ? ratioCss(v.expanded_ratio, '16 / 9') : String(ar)) : circle ? '1 / 1' : ratioCss(v.ratio, '1 / 1'),
          borderRadius: expanded ? 16 : circle ? '50%' : v.shape === 'square' ? 10 : Math.round(size * 0.22), border: expanded ? undefined : `${clamp(v.border_width, 0, 8, 3)}px solid ${hex(v.border_color, '#ffffff')}` }}>
        {clipKind === 'image'
          ? <img key={clip} src={clip} alt="" {...media} onLoad={(e) => setRatio(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} />
          : <video key={clip} src={clip} muted loop autoPlay playsInline preload="metadata" {...media} onLoadedMetadata={(e) => setRatio(e.currentTarget.videoWidth, e.currentTarget.videoHeight)} />}
        {expanded && !below && <div className="absolute inset-x-0 bottom-0">{questions}</div>}
      </div>
      {expanded && below && questions}
      {stripList.length > 1 && (
        <div className="absolute bottom-0 right-full mr-2 flex flex-col items-center gap-1.5 rounded-full bg-gray-900/90 px-1.5 py-2 shadow-lg" role="group" aria-label="Video language">
          {stripList.map((c) => {
            const l = langs.find((x) => x.code === c.lang); if (!l) return null;
            const on = c.lang === playing.lang;
            return (
              <button key={l.code} type="button" title={l.label} aria-label={l.label} aria-pressed={on} onClick={(e) => { e.stopPropagation(); setLang(l.code); }}
                className={cn('flex-none rounded-full overflow-hidden bg-gray-600 text-white text-[9px] font-bold flex items-center justify-center transition-all', on ? 'w-9 h-9 ring-[3px] ring-white' : 'w-6 h-6 opacity-50 hover:opacity-100')}>
                {l.flag ? <img src={flagUrl(l.flag)} alt="" className="w-full h-full" /> : l.code.slice(0, 2).toUpperCase()}
              </button>
            );
          })}
        </div>
      )}
      <span className={cn('absolute rounded-full bg-gray-800 text-white flex items-center justify-center shadow', expanded ? 'w-7 h-7' : 'w-6 h-6')} style={{ top: xo, right: xo }}><X className="w-3 h-3" /></span>
    </div>
  );
}

/**
 * Product tour only: the real widget on a sample page in an iframe, answered in the browser by the demo backend
 * (lib/outreach/backend/demo/webchat/widget.ts installs `window.__growthxaiDemoWidget`). Not rendered on /outreach.
 */
function DemoLiveWidget({ inboxId, mobile }: { inboxId: string; mobile: boolean }) {
  const html = useMemo(() => (window as unknown as { __growthxaiDemoWidget?: { page(id: string): string | null } }).__growthxaiDemoWidget?.page(inboxId) ?? null, [inboxId]);
  if (!html) return <div className="h-[600px] flex items-center justify-center text-sm text-gray-500">The live preview is loading…</div>;
  return <iframe title="Live widget preview" srcDoc={html} className={cn('block h-[600px] border-0 bg-white', mobile ? 'w-[320px] mx-auto' : 'w-full')} />;
}

export default function WidgetPreview({ settings, online = true, brandFallback, inboxId }: { settings: WebchatSettings; online?: boolean; brandFallback?: string; inboxId?: string }) {
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [open, setOpen] = useState(true);
  const [live, setLive] = useState(false);
  const showLive = IS_DEMO && !!inboxId && live;
  const ap = settings.appearance, la = device === 'mobile' ? { ...settings.launcher.desktop, ...settings.launcher.mobile } : settings.launcher.desktop, ms = settings.messages;
  const accent = HEX.test(ap.accent) ? ap.accent : '#4f46e5', on = contrast(accent);
  const dark = ap.theme === 'dark';
  const size = { sm: 44, md: 52, lg: 60 }[la.size] ?? 52;
  const left = la.position === 'left';
  const brand = ap.brand_name || brandFallback || 'Chat';
  const video = { ...VIDEO_BUBBLE_DEFAULTS, ...settings.launcher.video }, hasVideo = video.enabled !== false && !!mediaUrl(video.url);
  const line = dark ? '#1f2937' : '#e5e7eb';
  return (
    <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 text-xs">
        <span className="text-gray-500">Preview</span>
        <div className="flex gap-1">
          {(['desktop', 'mobile'] as const).map((d) => <button key={d} type="button" onClick={() => setDevice(d)} className={cn('px-2 py-0.5 rounded', device === d ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100')}>{d}</button>)}
          {!showLive && <button type="button" onClick={() => setOpen((o) => !o)} className="px-2 py-0.5 rounded text-gray-600 hover:bg-gray-100">{open ? 'closed state' : 'open state'}</button>}
          {IS_DEMO && inboxId && <button type="button" onClick={() => setLive((l) => !l)} className={cn('px-2 py-0.5 rounded', live ? 'bg-indigo-600 text-white' : 'text-indigo-700 hover:bg-indigo-50')} title="Try the real widget with your saved settings">{live ? 'live' : 'try it live'}</button>}
        </div>
      </div>
      {showLive ? <DemoLiveWidget key={`${inboxId}:${device}`} inboxId={inboxId!} mobile={device === 'mobile'} /> : (
      <div className={cn('relative bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] [background-size:16px_16px]', device === 'mobile' ? 'h-[600px] w-[320px] mx-auto' : 'h-[600px]')} style={{ fontFamily: `${ap.font && ap.font !== 'Inter' ? ap.font + ',' : ''}Inter, system-ui, sans-serif` }}>
        {/* launcher */}
        {!(settings.launcher.hide) && !(open && device === 'mobile') && (
          <div className="absolute flex flex-col gap-2 items-end" style={{ bottom: la.margin_bottom, [left ? 'left' : 'right']: la.margin_side, alignItems: left ? 'flex-start' : 'flex-end' }}>
            {settings.popup.enabled && !open && <div className="max-w-[240px] rounded-xl bg-white shadow-lg px-3 py-2 text-[13px] text-gray-800 flex gap-2 items-start">{settings.popup.image_url && <span className="w-8 h-8 rounded-full bg-gray-200 flex-shrink-0" />}<span>{settings.popup.text}</span></div>}
            {hasVideo && !open ? <VideoBubbleFrame v={video} accent={accent} scale={device === 'mobile' ? 0.75 : 1} /> : (
              <div className="relative inline-flex items-center justify-center gap-2 shadow-lg text-[15px] font-semibold" style={{ background: accent, color: on, height: la.type === 'button' && device === 'desktop' ? Math.max(44, size - 8) : size, width: la.type === 'button' && device === 'desktop' ? 'auto' : size, padding: la.type === 'button' && device === 'desktop' ? '0 18px 0 14px' : 0, borderRadius: 999 }}>
                {open ? <span className="text-xl leading-none">×</span> : ap.logo_url ? <img src={ap.logo_url} alt="" className={cn('object-contain', la.type === 'button' && device === 'desktop' ? 'h-7 w-auto max-w-[84px] rounded-md' : 'w-full h-full rounded-full')} /> : <svg viewBox="0 0 24 24" width={Math.round(size * 0.44)} height={Math.round(size * 0.44)} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>}
                {la.type === 'button' && device === 'desktop' && !open && <span>{la.text}</span>}
                {settings.launcher.show_unread_count && !open && <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center ring-2 ring-white">2</span>}
                {settings.launcher.online_dot && online && !open && <span className="absolute bottom-0.5 right-0.5 w-3 h-3 rounded-full bg-emerald-500 ring-2 ring-white" />}
              </div>
            )}
          </div>
        )}
        {/* panel */}
        {open && (
          <div className={cn('absolute flex flex-col overflow-hidden shadow-2xl', device === 'mobile' ? 'inset-0' : 'w-[320px] h-[480px] rounded-2xl')} style={device === 'mobile' ? { background: dark ? '#111827' : ap.widget_bg } : { bottom: la.margin_bottom + size + 12, [left ? 'left' : 'right']: la.margin_side, background: dark ? '#111827' : ap.widget_bg }}>
            <div className="flex items-center gap-2.5 px-4 py-3" style={{ background: accent, color: on }}>
              <div className="w-9 h-9 rounded-full bg-white/25 flex items-center justify-center overflow-hidden font-bold text-sm">{ap.logo_url ? <img src={ap.logo_url} alt="" className="w-full h-full object-contain" /> : brand.slice(0, 1).toUpperCase()}</div>
              <div className="min-w-0"><div className="font-bold text-[15px] leading-tight truncate">{brand}</div><div className="text-[12px] opacity-90 flex items-center gap-1.5"><span className={cn('w-2 h-2 rounded-full', online ? 'bg-emerald-400' : 'bg-gray-300')} />{online ? ({ minutes: 'Replies in a few minutes', hours: 'Replies in a few hours', day: 'Replies within a day', none: 'We are online' } as Record<string, string>)[ms.reply_time] : ms.unavailable_message}</div></div>
            </div>
            <div className="flex-1 min-h-0 p-4 space-y-3 text-[13px]" style={{ background: dark ? '#0b1220' : ap.chat_bg, color: dark ? '#f3f4f6' : '#111827' }}>
              <div><div className="text-[20px] font-bold leading-tight">{ap.welcome_title}</div><div className="opacity-70">{ap.welcome_tagline}</div></div>
              {ms.greeting_enabled && <div className="flex items-end gap-2">{avatarUrl(ap.bot_avatar_url) && <img src={avatarUrl(ap.bot_avatar_url)!} alt="" className="w-7 h-7 rounded-full object-cover flex-none" />}<div className="max-w-[85%] rounded-2xl px-3 py-2" style={{ background: dark ? '#1f2937' : '#fff', border: '1px solid rgba(0,0,0,.06)' }}>{ms.greeting}</div></div>}
              {/* the sent time shows under the last message only (the others reveal it on hover) */}
              <div className="flex flex-col items-end gap-0.5"><div className="max-w-[85%] rounded-2xl px-3 py-2" style={{ background: accent, color: on }}>Hi! I have a question about pricing.</div><div className="text-[10px] opacity-60 mr-1">12:03 {settings.features.read_receipts && '✓'}</div></div>
              {ms.quick_replies?.length > 0 && <div className="flex flex-wrap gap-1.5">{ms.quick_replies.slice(0, 4).map((q) => <span key={q} className="rounded-full px-3 py-1 text-[12px]" style={{ background: dark ? '#1f2937' : '#fff', border: '1px solid rgba(0,0,0,.1)' }}>{q}</span>)}</div>}
            </div>
            {/* composer: one box, the tools inside it */}
            <div className="p-2.5 border-t" style={{ borderColor: line }}>
              <div className="rounded-2xl pl-3 pr-2 pt-2.5 pb-1.5" style={{ background: dark ? '#1f2937' : '#fff', border: `1px solid ${line}`, color: dark ? '#9ca3af' : '#6b7280' }}>
                <div className="text-[13px] truncate">{ms.placeholder}</div>
                <div className="flex items-center gap-2 mt-2 -ml-0.5">
                  {settings.features.file_picker && <Paperclip className="w-4 h-4" />}
                  {settings.features.emoji_picker && <Smile className="w-4 h-4" />}
                  <span className="flex-1" />
                  <span className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: line }}><ArrowUp className="w-4 h-4" /></span>
                </div>
              </div>
            </div>
            {/* footer: fixed colours, not the inbox's */}
            {settings.features.powered_by && <div className="flex items-center justify-center gap-1 text-[10px] font-medium py-1.5 border-t" style={{ background: dark ? '#0b1220' : '#f3f4f6', borderColor: line, color: dark ? '#9ca3af' : '#6b7280' }}>Powered by <img src="/logo.png" alt="" className="w-3 h-3" /><b style={{ color: dark ? '#f3f4f6' : '#111827' }}>GrowthxAI</b></div>}
            <div className="text-center text-[10px] px-3 pt-1 pb-1.5" style={{ background: dark ? '#111827' : '#ffffff', color: dark ? '#9ca3af' : '#6c6f74' }}>By chatting with us, you agree to our <u>Privacy Policy</u></div>
          </div>
        )}
      </div>
      )}
    </div>
  );
}
