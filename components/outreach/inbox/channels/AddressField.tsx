'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
export const isEmailAddress = (v: string) => EMAIL_RE.test(v.trim());

/**
 * A mail client's recipient line ("Cc", "Bcc"): typed addresses become chips on Enter, comma, space or blur; pasting a
 * list splits it; Backspace in the empty box removes the last chip. A chip that is not an address is shown in red.
 */
export default function AddressField({ label, value, onChange, autoFocus, onRemoveField }: { label: string; value: string[]; onChange: (v: string[]) => void; autoFocus?: boolean; onRemoveField?: () => void }) {
  const [draft, setDraft] = useState('');
  const commit = (raw: string) => {
    const parts = raw.split(/[\s,;]+/).map((x) => x.trim().replace(/^<|>$/g, '').toLowerCase()).filter(Boolean);
    if (!parts.length) return;
    onChange([...value, ...parts.filter((x) => !value.includes(x))]);
    setDraft('');
  };
  return (
    <div className="flex items-start gap-2 px-3 py-1 border-b border-gray-100 text-sm">
      <span className="w-8 pt-1 text-gray-500 flex-shrink-0">{label}</span>
      <div className="flex flex-wrap items-center gap-1 min-w-0 flex-1">
        {value.map((e) => (
          <span key={e} className={cn('inline-flex items-center gap-1 rounded-full pl-2 pr-1 py-0.5 text-xs border', isEmailAddress(e) ? 'bg-gray-50 border-gray-200 text-gray-800' : 'bg-red-50 border-red-300 text-red-700')} title={isEmailAddress(e) ? e : `${e} is not an email address`}>
            {e}
            <button type="button" onClick={() => onChange(value.filter((x) => x !== e))} className="p-0.5 rounded-full hover:bg-black/10" aria-label={`Remove ${e}`}><X className="w-3 h-3" /></button>
          </span>
        ))}
        <input
          value={draft}
          autoFocus={autoFocus}
          onChange={(e) => { const v = e.target.value; if (/[,;\s]$/.test(v)) commit(v); else setDraft(v); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim()) { e.preventDefault(); commit(draft); }
            else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
          }}
          onBlur={() => commit(draft)}
          onPaste={(e) => { const t = e.clipboardData.getData('text'); if (/[,;\s]/.test(t.trim())) { e.preventDefault(); commit(`${draft}${t}`); } }}
          placeholder={value.length ? '' : 'name@company.com'}
          aria-label={`${label} recipients`}
          className="flex-1 min-w-[140px] py-1 bg-transparent focus:outline-none text-sm"
        />
      </div>
      {onRemoveField && <button type="button" onClick={onRemoveField} className="mt-1 p-0.5 text-gray-400 hover:text-gray-700" aria-label={`Remove ${label}`}><X className="w-3.5 h-3.5" /></button>}
    </div>
  );
}
