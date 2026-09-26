'use client';

// LinkedIn-accurate preview of the profile with the draft merged over the snapshot. Desktop and mobile widths, because
// headlines and the About section truncate differently (PRD §8.1). Filters and sliders are CSS approximations.
import { useState } from 'react';
import { Monitor, Smartphone } from 'lucide-react';
import { cn } from '@/lib/utils';
import { FILTER_CSS, TRUNCATION, type PictureSettings, type ProfileDoc, type ProfilePayload } from '@/lib/outreach/profile';

function filterStyle(s?: PictureSettings): string {
  if (!s) return '';
  const parts = [s.filter ? FILTER_CSS[s.filter] : ''];
  if (typeof s.brightness === 'number') parts.push(`brightness(${1 + s.brightness / 100})`);
  if (typeof s.contrast === 'number') parts.push(`contrast(${1 + s.contrast / 100})`);
  if (typeof s.saturation === 'number') parts.push(`saturate(${1 + s.saturation / 100})`);
  return parts.filter(Boolean).join(' ');
}

export default function ProfilePreview({ doc, payload, name, pictureUrl, coverUrl, connections }: {
  doc: ProfileDoc | null; payload: ProfilePayload; name: string; pictureUrl: string | null; coverUrl: string | null; connections: number | null;
}) {
  const [mode, setMode] = useState<'desktop' | 'mobile'>('desktop');
  const [aboutOpen, setAboutOpen] = useState(false);
  const mobile = mode === 'mobile';
  const headline = payload.headline ?? doc?.headline ?? '';
  const about = payload.summary ?? doc?.summary ?? '';
  const cut = mobile ? TRUNCATION.mobile : TRUNCATION.search;
  const headlineShown = headline.length > cut ? `${headline.slice(0, cut - 1)}…` : headline;
  const skills = payload.skills ?? doc?.skills?.map((s) => s.name) ?? [];
  const experience = (doc?.experience ?? []).map((e) => (payload.experience?.id && payload.experience.id === e.id ? { ...e, description: payload.experience.description ?? e.description, title: payload.experience.role ?? e.title, location: payload.experience.location ?? e.location } : e));
  const addedExperience = payload.experience && !payload.experience.id ? [{ id: null, title: payload.experience.role ?? '', company: payload.experience.company ?? '', description: payload.experience.description ?? null, current: true, location: payload.experience.location ?? null, start: null, end: null, company_id: null, skills: [] }] : [];
  const aboutLines = about.split('\n');
  const aboutShort = about.length > 300 && !aboutOpen ? `${about.slice(0, 300).trimEnd()}…` : about;
  const link = payload.custom_link;
  const vignette = payload.picture_settings?.vignette;

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-medium text-gray-600">Preview · what a prospect sees</div>
        <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5" role="tablist" aria-label="Preview width">
          <button role="tab" aria-selected={!mobile} onClick={() => setMode('desktop')} className={cn('px-2 py-1 text-xs rounded-md inline-flex items-center gap-1', !mobile ? 'bg-indigo-50 text-indigo-700' : 'text-gray-600')}><Monitor className="w-3.5 h-3.5" /> Desktop</button>
          <button role="tab" aria-selected={mobile} onClick={() => setMode('mobile')} className={cn('px-2 py-1 text-xs rounded-md inline-flex items-center gap-1', mobile ? 'bg-indigo-50 text-indigo-700' : 'text-gray-600')}><Smartphone className="w-3.5 h-3.5" /> Mobile</button>
        </div>
      </div>
      <div className={cn('mx-auto rounded-xl border border-gray-200 bg-white overflow-hidden shadow-sm', mobile ? 'max-w-[360px]' : 'max-w-[680px]')}>
        <div className={cn('bg-gradient-to-r from-slate-200 to-slate-300', mobile ? 'h-16' : 'h-28')} style={{ backgroundImage: coverUrl ? `url(${coverUrl})` : undefined, backgroundSize: 'cover', backgroundPosition: 'center', filter: filterStyle(payload.cover_picture_settings) || undefined }} aria-label={coverUrl ? 'Cover image' : 'No cover image'} />
        <div className={cn('px-5 pb-5', mobile ? 'px-4' : '')}>
          <div className="relative">
            <div className={cn('rounded-full border-4 border-white bg-gray-100 overflow-hidden -mt-10 relative', mobile ? 'w-20 h-20 -mt-8' : 'w-28 h-28')}>
              {pictureUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={pictureUrl} alt="" className="w-full h-full object-cover" style={{ filter: filterStyle(payload.picture_settings) || undefined }} />
              ) : <div className="w-full h-full flex items-center justify-center text-2xl text-gray-400">{name.slice(0, 1)}</div>}
              {typeof vignette === 'number' && vignette > 0 && <div className="absolute inset-0 rounded-full pointer-events-none" style={{ boxShadow: `inset 0 0 ${vignette}px rgba(0,0,0,${Math.min(0.8, vignette / 120)})` }} />}
            </div>
          </div>
          <div className={cn('font-semibold text-gray-900 mt-2', mobile ? 'text-base' : 'text-xl')}>{name || 'Sender'}</div>
          <div className={cn('text-gray-800 mt-0.5', mobile ? 'text-sm' : 'text-base')} title={headline}>{headlineShown || <span className="text-gray-400 italic">No headline</span>}</div>
          {headline.length > cut && <div className="text-[11px] text-amber-700 mt-0.5">Cut at {cut} characters here. The full headline shows only on the profile page.</div>}
          <div className="text-xs text-gray-500 mt-1">{(payload.location?.postal_code ? `Postal code ${payload.location.postal_code}` : doc?.location) || 'No location'}{connections != null ? ` · ${connections >= 500 ? '500+' : connections} connections` : ''}</div>
          {link?.url && <a href={link.url} className="text-xs text-indigo-700 font-medium mt-1 inline-block" onClick={(e) => e.preventDefault()}>{link.url.replace(/^https?:\/\//, '').slice(0, 40)}</a>}

          <div className="mt-5">
            <div className="font-semibold text-gray-900 text-sm">About</div>
            {about ? (
              <div className="text-sm text-gray-700 mt-1 whitespace-pre-line">{aboutShort}{about.length > 300 && <button className="text-gray-500 hover:text-gray-900 ml-1 text-xs" onClick={() => setAboutOpen((v) => !v)}>{aboutOpen ? 'see less' : '…see more'}</button>}</div>
            ) : <div className="text-sm text-gray-400 italic mt-1">Empty. Prospects who click through find nothing here.</div>}
            {about.length > 300 && aboutLines.length === 1 && <div className="text-[11px] text-amber-700 mt-1">One block of text. Line breaks make it readable.</div>}
          </div>

          {(experience.length > 0 || addedExperience.length > 0) && (
            <div className="mt-5">
              <div className="font-semibold text-gray-900 text-sm">Experience</div>
              <ul className="mt-1 space-y-3">
                {[...addedExperience, ...experience].slice(0, mobile ? 2 : 4).map((e, i) => (
                  <li key={e.id ?? `new-${i}`} className={cn('text-sm', !e.id && addedExperience.length && i === 0 && 'bg-indigo-50/60 rounded-lg p-2 -m-2')}>
                    <div className="font-medium text-gray-900">{e.title}{!e.id && addedExperience.length && i === 0 ? <span className="ml-2 text-[10px] uppercase text-indigo-700">new</span> : null}</div>
                    <div className="text-gray-600 text-xs">{e.company}{e.current ? ' · Present' : ''}{e.location ? ` · ${e.location}` : ''}</div>
                    {e.description ? <div className="text-gray-700 text-xs mt-1 whitespace-pre-line line-clamp-3">{e.description}</div> : <div className="text-gray-400 text-xs italic mt-1">No description</div>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {skills.length > 0 && (
            <div className="mt-5">
              <div className="font-semibold text-gray-900 text-sm">Skills</div>
              <div className="flex flex-wrap gap-1.5 mt-1">{skills.slice(0, mobile ? 4 : 8).map((s) => <span key={s} className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-800">{s}</span>)}{skills.length > (mobile ? 4 : 8) && <span className="text-xs text-gray-500">+{skills.length - (mobile ? 4 : 8)}</span>}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
