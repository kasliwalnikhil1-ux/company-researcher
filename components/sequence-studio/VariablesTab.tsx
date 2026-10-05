'use client';

// Variables (discovered + declared), their sample values per fictional prospect, fallbacks,
// renaming (updates every reference), and the sample prospects themselves.

import { useState } from 'react';
import { Copy, Plus, Trash2 } from 'lucide-react';
import { ensureDeclared, renameVariable, variableUsage } from '@/lib/sequence-studio/variables';
import { uid } from '@/lib/sequence-studio/util';
import type { Studio } from './store';
import { Badge, Btn, IconBtn, Input, SectionTitle } from './ui';

function RenameInput({ name, onRename }: { name: string; onRename: (to: string) => void }) {
  const [v, setV] = useState(name);
  const commit = () => {
    const to = v.trim();
    if (to && to !== name && !/[{}]/.test(to)) onRename(to);
    else setV(name);
  };
  return (
    <div className="flex items-center font-mono text-xs">
      <span className="text-gray-400">{'{{'}</span>
      <input
        aria-label={`Rename {{${name}}}`}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setV(name);
        }}
        className="w-full min-w-[90px] rounded border border-transparent px-1 py-0.5 hover:border-gray-300 focus:border-indigo-500 focus:outline-none"
        title="Rename: updates every placeholder, sample value and fallback"
      />
      <span className="text-gray-400">{'}}'}</span>
    </div>
  );
}

export default function VariablesTab({ studio }: { studio: Studio }) {
  const { lib, edit } = studio;
  const [newName, setNewName] = useState('');
  if (!lib) return null;
  const usage = variableUsage(lib);

  return (
    <div>
      <p className="mb-3 text-sm text-gray-600">
        Placeholders are found automatically anywhere in the library: anything between <code className="rounded bg-gray-100 px-1">{'{{'}</code> and <code className="rounded bg-gray-100 px-1">{'}}'}</code>, including names like <code className="rounded bg-gray-100 px-1">{'{{product/category}}'}</code>. Exports keep the placeholders; sample values are stored separately. A value is used in this order: sample value → fallback → shown as a missing placeholder (never invented).
      </p>
      <div className="overflow-x-auto rounded-xl border border-gray-200">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs text-gray-500">
            <tr>
              <th className="px-2 py-1.5 font-medium">Variable</th>
              <th className="px-2 py-1.5 font-medium">Uses</th>
              {lib.profiles.map((p) => (
                <th key={p.id} className="px-2 py-1.5 font-medium">
                  Sample: {p.label}
                </th>
              ))}
              <th className="px-2 py-1.5 font-medium">Fallback</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {usage.map((u) => {
              const decl = lib.variables.find((v) => v.name === u.name);
              return (
                <tr key={u.name} className="border-t border-gray-100 align-top">
                  <td className="px-2 py-1.5">
                    <RenameInput key={u.name} name={u.name} onRename={(to) => edit((d) => renameVariable(d, u.name, to))} />
                    {!u.declared && <Badge tone="sky">found in text</Badge>}
                  </td>
                  <td className="px-2 py-1.5 text-xs text-gray-600" title={u.places.join('\n')}>
                    {u.count ? u.count : <Badge tone="gray">unused</Badge>}
                  </td>
                  {lib.profiles.map((p) => {
                    const val = p.values[u.name] ?? '';
                    const missing = !val.trim() && !(decl?.fallback ?? '').trim();
                    return (
                      <td key={p.id} className="px-2 py-1.5">
                        <Input
                          aria-label={`Sample value of ${u.name} for ${p.label}`}
                          value={val}
                          placeholder={missing ? 'missing' : 'uses fallback'}
                          onChange={(e) =>
                            edit((d) => {
                              ensureDeclared(d, u.name);
                              d.profiles.find((x) => x.id === p.id)!.values[u.name] = e.target.value;
                            }, `val-${p.id}-${u.name}`)
                          }
                          className={`py-1 text-xs ${missing ? 'border-red-300 bg-red-50 placeholder:text-red-400' : ''}`}
                        />
                        <span className="text-[10px] tabular-nums text-gray-400">{val.length} chars</span>
                      </td>
                    );
                  })}
                  <td className="px-2 py-1.5">
                    <Input
                      aria-label={`Fallback for ${u.name}`}
                      value={decl?.fallback ?? ''}
                      placeholder="none"
                      onChange={(e) => edit((d) => void (ensureDeclared(d, u.name).fallback = e.target.value), `fb-${u.name}`)}
                      className="py-1 text-xs"
                    />
                  </td>
                  <td className="px-1 py-1.5">
                    <IconBtn
                      label={u.count ? 'Variable is used — remove the placeholders first' : 'Delete variable'}
                      disabled={u.count > 0}
                      onClick={() =>
                        edit((d) => {
                          d.variables = d.variables.filter((v) => v.name !== u.name);
                          for (const p of d.profiles) delete p.values[u.name];
                        })
                      }
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </IconBtn>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <form
        className="mt-2 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const n = newName.trim();
          if (!n || /[{}]/.test(n)) return;
          edit((d) => void ensureDeclared(d, n));
          setNewName('');
        }}
      >
        <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="new_variable" aria-label="New variable name" className="max-w-[200px] font-mono text-xs" />
        <Btn size="sm" type="submit">
          <Plus className="h-3.5 w-3.5" /> Add variable
        </Btn>
      </form>

      <SectionTitle
        actions={
          <Btn
            size="sm"
            tone="ghost"
            onClick={() => edit((d) => void d.profiles.push({ id: uid('prof'), label: 'New sample prospect (fictional)', recipientName: 'Sample Prospect', recipientEmail: 'prospect@example.com', values: {} }))}
          >
            <Plus className="h-3.5 w-3.5" /> Add sample prospect
          </Btn>
        }
      >
        Sample prospects (fictional)
      </SectionTitle>
      <p className="mb-2 text-xs text-gray-500">Use the long profile to check how long names, company names and products affect wrapping and truncation. The selected one drives the preview.</p>
      <div className="space-y-2">
        {lib.profiles.map((p) => (
          <div key={p.id} className={`rounded-xl border p-3 ${p.id === lib.activeProfileId ? 'border-indigo-400 ring-1 ring-indigo-200' : 'border-gray-200'}`}>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs font-medium text-gray-700">
                <input type="radio" name="active-profile" checked={p.id === lib.activeProfileId} onChange={() => edit((d) => void (d.activeProfileId = p.id))} /> Use in preview
              </label>
              <Input aria-label="Profile label" value={p.label} onChange={(e) => edit((d) => void (d.profiles.find((x) => x.id === p.id)!.label = e.target.value), `pl-${p.id}`)} className="min-w-[160px] flex-1 py-1 text-sm" />
              <IconBtn label="Duplicate profile" onClick={() => edit((d) => void d.profiles.push({ ...JSON.parse(JSON.stringify(p)), id: uid('prof'), label: `${p.label} (copy)` }))}>
                <Copy className="h-3.5 w-3.5" />
              </IconBtn>
              <IconBtn
                label="Delete profile"
                disabled={lib.profiles.length < 2}
                onClick={() =>
                  edit((d) => {
                    d.profiles = d.profiles.filter((x) => x.id !== p.id);
                    if (d.activeProfileId === p.id) d.activeProfileId = d.profiles[0].id;
                  })
                }
              >
                <Trash2 className="h-3.5 w-3.5" />
              </IconBtn>
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <Input aria-label="Recipient name" value={p.recipientName} placeholder="Recipient name" onChange={(e) => edit((d) => void (d.profiles.find((x) => x.id === p.id)!.recipientName = e.target.value), `pn-${p.id}`)} className="py-1 text-xs" />
              <Input aria-label="Recipient email" value={p.recipientEmail} placeholder="Recipient email" onChange={(e) => edit((d) => void (d.profiles.find((x) => x.id === p.id)!.recipientEmail = e.target.value), `pe-${p.id}`)} className="py-1 text-xs" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
