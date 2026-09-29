'use client';

import { Clock, Linkedin, Mail, Pencil, Phone } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ContactAbout } from '@/lib/crm/types';
import { Badge, Button, fmtTime } from './ui';
import { ContactAboutBlock } from './about';

// One contact: avatar + name/role header, a row of contact details (the contact's own columns), then the `about` profile.
// Company page (with edit) and the standup's expanded meeting row (fewer fields: no phone/timezone there).

const AVATAR_TONES = ['bg-indigo-100 text-indigo-700', 'bg-teal-100 text-teal-700', 'bg-amber-100 text-amber-800', 'bg-rose-100 text-rose-700', 'bg-sky-100 text-sky-700', 'bg-violet-100 text-violet-700', 'bg-emerald-100 text-emerald-700'];
const initials = (name: string) => name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
const toneOf = (name: string) => AVATAR_TONES[[...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % AVATAR_TONES.length];

export function ContactAvatar({ name, className }: { name: string; className?: string }) {
  return <div className={cn('w-9 h-9 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 select-none', toneOf(name), className)} aria-hidden>{initials(name)}</div>;
}

function Meta({ icon: Icon, children, title, href }: { icon: typeof Mail; children: React.ReactNode; title?: string; href?: string }) {
  const body = <><Icon className="w-3 h-3 shrink-0 text-gray-400" /><span className="truncate">{children}</span></>;
  const cls = 'inline-flex items-center gap-1 min-w-0 max-w-full';
  return href
    ? <a href={href} title={title} className={cn(cls, 'hover:text-indigo-600')}>{body}</a>
    : <span title={title} className={cls}>{body}</span>;
}

type ContactLike = { name: string; role?: string | null; email?: string | null; phone?: string | null; linkedin_url?: string | null; timezone?: string | null; is_primary?: boolean; about?: ContactAbout | null };

/** `full` = show the whole profile with no More / +N more toggles (used where the user has already expanded a row). */
export function ContactCard({ contact: ct, onEdit, full, className }: { contact: ContactLike; onEdit?: () => void; full?: boolean; className?: string }) {
  const localTime = ct.timezone ? fmtTime(new Date().toISOString(), ct.timezone) : null;
  const hasMeta = ct.email || ct.phone || ct.timezone;
  return (
    <div className={cn('px-3 py-3 flex gap-3', className)}>
      <ContactAvatar name={ct.name} />
      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-sm font-semibold text-gray-900">{ct.name}</span>
              {ct.is_primary && <Badge tone="green">primary</Badge>}
            </div>
            {ct.role && <div className="text-xs text-gray-500">{ct.role}</div>}
          </div>
          <div className="flex items-center gap-0.5 -mr-1 shrink-0">
            {ct.linkedin_url && (
              <a href={ct.linkedin_url} target="_blank" rel="noreferrer" title="LinkedIn profile" className="p-1.5 rounded-md text-gray-400 hover:text-[#0a66c2] hover:bg-gray-50">
                <Linkedin className="w-3.5 h-3.5" />
              </a>
            )}
            {onEdit && <Button size="xs" variant="ghost" onClick={onEdit} title="Edit contact"><Pencil className="w-3 h-3" /></Button>}
          </div>
        </div>

        {hasMeta && (
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-600">
            {ct.email && <Meta icon={Mail} href={`mailto:${ct.email}`} title={ct.email}>{ct.email}</Meta>}
            {ct.phone && <Meta icon={Phone} href={`tel:${ct.phone.replace(/\s+/g, '')}`}>{ct.phone}</Meta>}
            {ct.timezone && <Meta icon={Clock} title={`${ct.timezone} — their local time`}>{localTime} local time</Meta>}
          </div>
        )}

        <ContactAboutBlock about={ct.about} full={full} className="mt-2.5" />
      </div>
    </div>
  );
}
