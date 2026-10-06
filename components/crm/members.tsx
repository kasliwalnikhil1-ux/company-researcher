'use client';

// Teammates in the CRM: a round initials avatar (same tone everywhere for the same person) beside the name, and a
// searchable picker with those avatars for every "Owner" / "By" / "Who" choice.
import { useMemo } from 'react';
import { UserRound } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useCrm } from '@/contexts/CrmContext';
import type { Member } from '@/lib/crm/types';
import { SearchableSelect, type SelectOption } from '@/components/outreach/ui';

const TONES = ['bg-indigo-100 text-indigo-700', 'bg-emerald-100 text-emerald-700', 'bg-amber-100 text-amber-800', 'bg-pink-100 text-pink-700', 'bg-sky-100 text-sky-700', 'bg-purple-100 text-purple-700'];
const SIZES = { xs: 'w-[18px] h-[18px] text-[8px]', sm: 'w-5 h-5 text-[8px]', md: 'w-6 h-6 text-[10px]', lg: 'w-8 h-8 text-[11px]' } as const;
export type AvatarSize = keyof typeof SIZES;

export const initials = (name: string) => { const p = name.trim().split(/[\s._@-]+/).filter(Boolean); return ((p.length > 1 ? p[0][0] + p[1][0] : name.trim().slice(0, 2)) || '?').toUpperCase(); };
const tone = (key: string) => TONES[[...key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % TONES.length];

/** The member behind an id, or behind a display name when a report only carries the name. */
function useMember(userId: string | null | undefined, name: string | null | undefined): Member | undefined {
  const { members } = useCrm();
  return useMemo(() => {
    const byId = userId ? members.find((m) => m.user_id === userId) : undefined;
    if (byId) return byId;
    const n = name?.trim().toLowerCase();
    return n ? members.find((m) => m.display_name.trim().toLowerCase() === n) : undefined;
  }, [members, userId, name]);
}

function Circle({ label, toneKey, inactive, size, title }: { label: string; toneKey: string; inactive?: boolean; size: AvatarSize; title?: string }) {
  return <span title={title} className={cn('rounded-full inline-flex items-center justify-center font-semibold flex-shrink-0 leading-none', SIZES[size], inactive ? 'bg-gray-100 text-gray-400' : tone(toneKey))}>{initials(label)}</span>;
}

/** Nobody (no owner): a dashed circle with a person outline. */
export function NoMemberAvatar({ size = 'md' }: { size?: AvatarSize }) {
  return <span className={cn('rounded-full border border-dashed border-gray-300 bg-white text-gray-400 inline-flex items-center justify-center flex-shrink-0', SIZES[size])}><UserRound className="w-3/5 h-3/5" aria-hidden /></span>;
}

/** A teammate's round avatar, from their id or (for report rows) their name. */
export function MemberAvatar({ userId, name, size = 'md', title }: { userId?: string | null; name?: string | null; size?: AvatarSize; title?: string }) {
  const m = useMember(userId, name);
  const label = m?.display_name ?? name ?? null;
  if (!label) return <NoMemberAvatar size={size} />;
  return <Circle label={label} toneKey={m?.user_id ?? label} inactive={m ? !m.is_active : false} size={size} title={title} />;
}

/** Avatar + name in one line. Shows `empty` when there is no owner. */
export function MemberName({ userId, name, size = 'sm', empty = '—', className }: { userId?: string | null; name?: string | null; size?: AvatarSize; empty?: string; className?: string }) {
  const m = useMember(userId, name);
  const label = m?.display_name ?? name ?? null;
  if (!label) return <span className={className}>{empty}</span>;
  return <span className={cn('inline-flex items-center gap-1.5 min-w-0 align-middle', className)}><MemberAvatar userId={m?.user_id} name={label} size={size} /><span className="truncate">{label}</span></span>;
}

/** Pick a teammate (searchable, with avatars). Active members by default; `emptyLabel` adds an "anyone / nobody" first row whose value is ''. */
export function MemberSelect({ label, value, onChange, members, emptyLabel, className, 'aria-label': ariaLabel }: {
  label?: string; value: string; onChange: (userId: string) => void; members?: Member[]; emptyLabel?: string; className?: string; 'aria-label'?: string;
}) {
  const { activeMembers, members: everyone, me } = useCrm();
  const base = members ?? activeMembers;
  // a deactivated teammate who is still the current value stays listed (greyed) instead of showing a raw id
  const list = useMemo(() => { const cur = value && !base.some((m) => m.user_id === value) ? everyone.find((m) => m.user_id === value) : undefined; return cur ? [...base, cur] : base; }, [base, everyone, value]);
  const options = useMemo<SelectOption[]>(() => list.map((m) => ({
    value: m.user_id,
    label: `${m.display_name}${m.user_id === me?.user_id ? ' (me)' : ''}`,
    keywords: m.email ?? undefined,
    icon: <Circle label={m.display_name} toneKey={m.user_id} inactive={!m.is_active} size="sm" />,
  })), [list, me?.user_id]);
  return (
    <SearchableSelect label={label} value={value} onChange={onChange} options={options} emptyOption={emptyLabel} emptyIcon={<NoMemberAvatar size="sm" />}
      placeholder={emptyLabel ?? 'Choose a teammate'} searchPlaceholder="Search teammates…" aria-label={ariaLabel ?? label} className={className}
      triggerClassName="px-2.5 py-1.5 rounded-md" />
  );
}
