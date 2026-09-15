'use client';

import type { Tag } from '@/lib/outreach/types';
import { cn } from '@/lib/utils';
import { chipStyle } from '../helpers';

export function TagMultiSelect({ tags, value, onChange, label = 'Tags (optional)' }: { tags: Tag[]; value: string[]; onChange: (ids: string[]) => void; label?: string }) {
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  return (
    <div>
      <span className="block text-xs font-medium text-gray-600 mb-1">{label}</span>
      {tags.length === 0 ? <p className="text-xs text-gray-400">No tags yet — create them from the Leads page.</p> : (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>
          {tags.map((t) => {
            const on = value.includes(t.id);
            return (
              <button key={t.id} type="button" aria-pressed={on} onClick={() => toggle(t.id)} className={cn('px-2 py-0.5 rounded-full text-xs font-medium border transition-opacity', on ? 'ring-2 ring-offset-1 ring-indigo-500' : 'opacity-70 hover:opacity-100')} style={chipStyle(t.color)}>{t.name}</button>
            );
          })}
        </div>
      )}
    </div>
  );
}
