'use client';

// Teammates look like senders everywhere: a round avatar (the LinkedIn photo of a sender they own, else initials)
// beside the name. MemberAvatar for read-only spots, MemberPicker for every "assign to" / "owner" choice.
import { useMemo } from 'react';
import { UserRound } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Member } from '@/lib/outreach/types';
import { useSenders } from '@/lib/outreach/queries';
import { useWorkspaceIdOptional } from '@/contexts/OutreachWorkspaceContext';
import { Avatar, SearchableSelect, type SelectOption } from './ui';
import { memberLabel } from './inbox/hooks';

/** user id → photo of the first sender that teammate owns (shares the cached senders query). */
export function useMemberPhotos(): Map<string, string> {
  const senders = useSenders(useWorkspaceIdOptional());
  return useMemo(() => {
    const map = new Map<string, string>();
    for (const s of senders.data ?? []) if (s.owner_user_id && s.picture_url && !map.has(s.owner_user_id)) map.set(s.owner_user_id, s.picture_url);
    return map;
  }, [senders.data]);
}

/** Nobody / a former member: a dashed circle with a person outline. */
export function UnassignedAvatar({ size = 6, title }: { size?: number; title?: string }) {
  return (
    <span title={title} className={cn(`w-${size} h-${size}`, 'rounded-full border border-dashed border-gray-300 bg-white text-gray-400 flex items-center justify-center flex-shrink-0')}>
      <UserRound className="w-3/5 h-3/5" aria-hidden />
    </span>
  );
}

/** A teammate's round avatar. Pass the member, or a user id + name when only those are known (note authors, version history). */
export function MemberAvatar({ member, userId, name, size = 6 }: { member?: Member | null; userId?: string | null; name?: string | null; size?: number }) {
  const photos = useMemberPhotos();
  const id = member?.user_id ?? userId ?? null;
  const label = name ?? (member ? memberLabel(member) : null);
  if (!id && !label) return <UnassignedAvatar size={size} />;
  return <Avatar src={id ? photos.get(id) : null} name={label} size={size} />;
}

/** Avatar + name in one line, for table cells and "by …" lines. `members` resolves the id; an unknown id reads "Former member". */
export function MemberChip({ userId, members, fallback = 'Unassigned', size = 5, className }: {
  userId: string | null | undefined; members: Member[] | undefined; fallback?: string; size?: number; className?: string;
}) {
  const m = userId ? members?.find((x) => x.user_id === userId) : undefined;
  return (
    <span className={cn('inline-flex items-center gap-1.5 min-w-0 align-middle', className)}>
      {m ? <MemberAvatar member={m} size={size} /> : <UnassignedAvatar size={size} />}
      <span className={cn('truncate', !m && 'text-gray-500')}>{m ? memberLabel(m) : userId ? (members ? 'Former member' : '…') : fallback}</span>
    </span>
  );
}

/** Pick a teammate (searchable, with avatars). '' means unassigned. */
export function MemberPicker({ value, onChange, members, currentUserId, label, emptyLabel = 'Unassigned', allowEmpty = true, size = 'md', disabled, className, 'aria-label': ariaLabel }: {
  value: string | null | undefined; onChange: (userId: string) => void; members: Member[] | undefined; currentUserId?: string | null;
  label?: string; emptyLabel?: string; allowEmpty?: boolean; size?: 'sm' | 'md'; disabled?: boolean; className?: string; 'aria-label'?: string;
}) {
  const photos = useMemberPhotos();
  const av = size === 'sm' ? 4 : 5;
  const options = useMemo<SelectOption[]>(() => {
    const list: SelectOption[] = (members ?? []).map((m) => ({
      value: m.user_id,
      label: `${memberLabel(m)}${m.user_id === currentUserId ? ' (me)' : ''}`,
      keywords: m.email ?? undefined,
      icon: <Avatar src={photos.get(m.user_id)} name={memberLabel(m)} size={av} />,
    }));
    if (value && !list.some((o) => o.value === value)) list.push({ value, label: members ? 'Former member' : '…', icon: <UnassignedAvatar size={av} /> });
    return list;
  }, [members, currentUserId, value, photos, av]);
  return (
    <SearchableSelect label={label} value={value ?? ''} onChange={onChange} options={options} size={size} disabled={disabled} className={className} aria-label={ariaLabel}
      emptyOption={allowEmpty ? emptyLabel : undefined} emptyIcon={<UnassignedAvatar size={av} />} placeholder={allowEmpty ? emptyLabel : 'Choose a teammate'} searchPlaceholder="Search teammates…" />
  );
}
