'use client';

// Website agents → {website} → Ask AI buttons (web-chat-buttons-products-changes.md §4). Buttons the widget places
// on the site with no code: one in the header, others next to page elements; Ask AI on selected text; the ⌘K shortcut.
// Saved as settings.ask_buttons / selection_ask / shortcut through outreach_webchat_inbox_update (validated in 068).
import { useState } from 'react';
import { ExternalLink, Plus, Sparkles, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge, Button, Card } from '@/components/outreach/ui';
import { Note, SettingRow, Switch } from '@/components/outreach/settings/shared';
import {
  BUTTON_SHELLS, HEADER_SELECTOR, MAX_ASK_BUTTONS, SELECTION_ASK_DEFAULTS, newAskButton, shortcutOn,
  type AskButton, type ButtonShell, type SelectionAsk, type UrlRule,
} from '@/lib/outreach/webchat';
import { Grid, Label, SaveBar, field, useDraft, useSaveSettings, type SectionProps } from './sections';

const STYLES: Array<{ value: AskButton['style']; label: string }> = [
  { value: 'filled', label: 'Filled (accent colour)' }, { value: 'outline', label: 'Outline' }, { value: 'text', label: 'Text' }, { value: 'match', label: 'Match my site' },
];
const POSITION_LABEL: Record<AskButton['position'], string> = { start: 'start', end: 'end', before: 'before', after: 'after', inside: 'inside (end)' };
const CLICK_LABEL: Record<AskButton['click'], string> = { open: 'Opens the chat', ask: 'Asks a question', prefill: 'Prefills a text' };

/** What is wrong with a button before it can be saved, or null. The server checks the same things. */
function problem(b: AskButton): string | null {
  if (!b.selector.trim()) return 'Enter where the button goes: a CSS selector, like .product-form';
  if (/[<>{}]/.test(b.selector)) return 'The selector cannot contain < > { }';
  if (!b.label.trim()) return 'Give the button a label';
  if (b.click !== 'open' && !(b.text ?? '').trim()) return b.click === 'ask' ? 'Enter the question the button asks' : 'Enter the text the button puts in the message box';
  if (b.url_rules.some((r) => !r.value.trim())) return 'A page rule is empty: fill it in or remove it';
  return null;
}
/** What gets saved: trimmed, and only the fields a button of its kind has. */
function pack(b: AskButton): AskButton {
  const base = { id: b.id, kind: b.kind, selector: b.selector.trim(), position: b.position, label: b.label.trim().slice(0, 30), style: b.style, icon: b.icon, url_rules: b.url_rules.map((r) => ({ ...r, value: r.value.trim() })), enabled: b.enabled, mode: b.mode ?? null };
  return b.kind === 'header' ? { ...base, click: 'open' } : { ...base, click: b.click, text: b.click === 'open' ? null : (b.text ?? '').trim().slice(0, 300), context: b.context ?? 'none' };
}
const pagesText = (rules: UrlRule[]) => (rules.length ? rules.map((r) => `${r.action === 'hide' ? 'not ' : ''}${r.op === 'contains' ? '' : `${r.op.replace('_', ' ')} `}${r.value || '…'}`).join(', ') : 'all pages');

function ButtonPreview({ b, accent }: { b: AskButton; accent: string }) {
  const style: React.CSSProperties = b.style === 'filled' ? { background: accent, color: '#fff' } : b.style === 'outline' ? { color: accent, boxShadow: `inset 0 0 0 1.5px ${accent}` } : b.style === 'text' ? { color: accent, padding: '0 4px' } : {};
  return (
    <span className={cn('inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-sm font-semibold whitespace-nowrap', b.style === 'match' && 'rounded-md border border-dashed border-gray-300 font-normal text-gray-700')} style={style}
      title={b.style === 'match' ? 'Styled by your site’s own button CSS (class growthxai-ask)' : undefined}>
      {b.icon && <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />}{b.label || 'Ask AI'}
    </span>
  );
}

function ButtonEditor({ b, accent, shell, canEdit, onChange, onRemove }: { b: AskButton; accent: string; shell: string; canEdit: boolean; onChange: (patch: Partial<AskButton>) => void; onRemove: () => void }) {
  const header = b.kind === 'header';
  const setRule = (i: number, patch: Partial<UrlRule>) => onChange({ url_rules: b.url_rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const err = problem(b);
  return (
    <div className="rounded-lg border border-indigo-200 bg-indigo-50/40 p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <ButtonPreview b={b} accent={accent} />
        <span className="text-xs text-gray-500">{header ? 'Header button' : 'Next to an element'}</span>
        <label className="ml-auto flex items-center gap-2 text-xs text-gray-600"><Switch checked={b.enabled} onChange={(v) => onChange({ enabled: v })} label="Button on" disabled={!canEdit} /> {b.enabled ? 'On' : 'Off'}</label>
        {canEdit && <button type="button" className="text-gray-400 hover:text-red-600" aria-label={`Remove the button ${b.label}`} onClick={onRemove}><Trash2 className="h-4 w-4" /></button>}
      </div>
      <Grid>
        <div><Label hint={header ? 'a CSS selector; the first one that matches is used' : 'a CSS selector; every match gets a button, 20 at most'}>Where</Label><input aria-label="Where the button goes (CSS selector)" className={cn(field, 'font-mono text-xs')} value={b.selector} maxLength={200} onChange={(e) => onChange({ selector: e.target.value })} disabled={!canEdit} placeholder={header ? HEADER_SELECTOR : '.product-form'} /></div>
        <div><Label>Position</Label>
          <select aria-label="Position" className={field} value={b.position} onChange={(e) => onChange({ position: e.target.value as AskButton['position'] })} disabled={!canEdit}>
            {header ? <><option value="start">Start of that element</option><option value="end">End of that element</option></> : <><option value="before">Before the element</option><option value="after">After the element</option><option value="inside">Inside it, at the end</option></>}
          </select>
        </div>
        <div><Label hint="≤ 30 characters">Label</Label><input aria-label="Button label" className={field} value={b.label} maxLength={30} onChange={(e) => onChange({ label: e.target.value })} disabled={!canEdit} placeholder="Ask AI" /></div>
        <div><Label>Style</Label><select aria-label="Style" className={field} value={b.style} onChange={(e) => onChange({ style: e.target.value as AskButton['style'] })} disabled={!canEdit}>{STYLES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select></div>
        {!header && (
          <div><Label>When clicked</Label>
            <select aria-label="When clicked" className={field} value={b.click} onChange={(e) => onChange({ click: e.target.value as AskButton['click'] })} disabled={!canEdit}>
              <option value="open">Open the chat</option><option value="ask">Ask a question (sent as the visitor)</option><option value="prefill">Prefill a text (the visitor sends it)</option>
            </select>
          </div>
        )}
        {!header && (
          <div><Label hint="background for the AI, never shown to the visitor">Context</Label>
            <select aria-label="Context" className={field} value={b.context ?? 'none'} onChange={(e) => onChange({ context: e.target.value as AskButton['context'] })} disabled={!canEdit}>
              <option value="none">None</option><option value="page">This page</option><option value="product">This product (found automatically)</option>
            </select>
          </div>
        )}
        {!header && b.click !== 'open' && (
          <div className="md:col-span-2"><Label hint="≤ 300 characters">{b.click === 'ask' ? 'Question' : 'Text to prefill'}</Label><input aria-label={b.click === 'ask' ? 'Question' : 'Text to prefill'} className={field} value={b.text ?? ''} maxLength={300} onChange={(e) => onChange({ text: e.target.value })} disabled={!canEdit} placeholder={b.click === 'ask' ? 'Is this good for a wedding?' : "I'd like a quote for "} /></div>
        )}
        <div><Label hint="on a phone the chat is always full screen">Opens in</Label>
          <select aria-label="Opens in" className={field} value={b.mode ?? ''} onChange={(e) => onChange({ mode: (e.target.value || null) as ButtonShell | null })} disabled={!canEdit}>
            <option value="">This website&rsquo;s shell ({shell})</option>
            {BUTTON_SHELLS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>
        <div className="flex items-end pb-1.5"><label className="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" checked={b.icon} onChange={(e) => onChange({ icon: e.target.checked })} disabled={!canEdit} /> Show the sparkle icon</label></div>
      </Grid>
      <div>
        <div className="mb-1 flex items-center justify-between"><Label hint="none = all pages; a “hide” rule always wins">Pages</Label>{canEdit && b.url_rules.length < 20 && <Button size="sm" variant="secondary" onClick={() => onChange({ url_rules: [...b.url_rules, { op: 'contains', value: '', action: 'show' }] })}><Plus className="mr-1 h-3.5 w-3.5" />Rule</Button>}</div>
        <div className="space-y-2">
          {b.url_rules.map((r, i) => (
            <div key={i} className="grid gap-2 md:grid-cols-[110px_130px_1fr_auto]">
              <select className={field} value={r.action} disabled={!canEdit} onChange={(e) => setRule(i, { action: e.target.value as 'show' | 'hide' })} aria-label="Show or hide"><option value="show">Show on</option><option value="hide">Hide on</option></select>
              <select className={field} value={r.op} disabled={!canEdit} onChange={(e) => setRule(i, { op: e.target.value as UrlRule['op'] })} aria-label="How the address is matched"><option value="contains">contains</option><option value="equals">equals</option><option value="starts_with">starts with</option><option value="regex">regex</option></select>
              <input className={field} value={r.value} maxLength={500} disabled={!canEdit} onChange={(e) => setRule(i, { value: e.target.value })} placeholder="/products/" aria-label="Page address" />
              {canEdit && <button type="button" className="text-gray-400 hover:text-red-600" aria-label="Remove rule" onClick={() => onChange({ url_rules: b.url_rules.filter((_, j) => j !== i) })}><Trash2 className="h-4 w-4" /></button>}
            </div>
          ))}
        </div>
      </div>
      {b.style === 'match' && <p className="text-xs text-gray-500">Match my site adds a plain <code>&lt;button class=&quot;growthxai-ask&quot;&gt;</code> with only the label and the icon, so your own button CSS styles it.</p>}
      {b.context === 'product' && !header && <p className="text-xs text-gray-500">On a product page the product is the page itself; in a list of products it is the link inside the element the button sits next to. The assistant then answers about that product and suggests similar or matching ones.</p>}
      {err && <p className="text-xs text-amber-700" role="alert">{err}</p>}
    </div>
  );
}

export default function AskButtonsSection(p: SectionProps) {
  const st = p.inbox.settings;
  const { draft, set, dirty, reset } = useDraft<{ buttons: AskButton[]; selection: SelectionAsk; shortcut: boolean }>({
    buttons: (st.ask_buttons ?? []).map((b) => ({ ...b, url_rules: b.url_rules ?? [], enabled: b.enabled !== false, icon: b.icon !== false, style: b.style ?? 'filled', label: b.label ?? 'Ask AI' })),
    selection: { ...SELECTION_ASK_DEFAULTS, ...(st.selection_ask ?? {}) }, shortcut: shortcutOn(st),
  });
  const { save, saving } = useSaveSettings(p);
  const [open, setOpen] = useState<string | null>(null);
  const accent = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(st.appearance.accent) ? st.appearance.accent : '#4f46e5';
  const full = draft.buttons.length >= MAX_ASK_BUTTONS;
  const firstProblem = draft.buttons.map((b) => ({ b, err: problem(b) })).find((x) => x.err);
  const add = (kind: AskButton['kind']) => { const b = newAskButton(kind, draft.buttons.map((x) => x.id)); set((d) => ({ ...d, buttons: [...d.buttons, b] })); setOpen(b.id); };
  const change = (id: string, patch: Partial<AskButton>) => set((d) => ({ ...d, buttons: d.buttons.map((b) => (b.id === id ? { ...b, ...patch } : b)) }));
  const remove = (id: string) => set((d) => ({ ...d, buttons: d.buttons.filter((b) => b.id !== id) }));
  // "Test on my site": the site with ?gx_debug=1, which outlines every matched target and logs what was placed
  const sites = [...new Set([...Object.keys(p.inbox.installed_origins ?? {}), ...p.inbox.allowed_domains.filter((d) => !d.includes('*') && d !== 'localhost').map((d) => `https://${d}`)])];
  const [site, setSite] = useState(sites[0] ?? '');
  const onSave = () => {
    if (firstProblem) { setOpen(firstProblem.b.id); p.toast(`${firstProblem.b.label || 'A button'}: ${firstProblem.err}`, 'error'); return; }
    // the shortcut is stored only when it differs from what the shell does by itself, so changing the shell later still follows
    const auto = st.appearance.mode === 'modal';
    void save({ settings: { ask_buttons: draft.buttons.map(pack), selection_ask: { enabled: draft.selection.enabled, area: draft.selection.area.trim() || SELECTION_ASK_DEFAULTS.area, label: draft.selection.label.trim() || SELECTION_ASK_DEFAULTS.label }, shortcut: { enabled: draft.shortcut === auto && st.shortcut?.enabled == null ? null : draft.shortcut } } });
  };

  return (
    <div className="space-y-4">
      <Card title="Ask AI buttons" actions={p.canEdit && (
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" disabled={full || draft.buttons.some((b) => b.kind === 'header')} title={draft.buttons.some((b) => b.kind === 'header') ? 'There is already a header button' : undefined} onClick={() => add('header')}><Plus className="mr-1 h-3.5 w-3.5" />Header button</Button>
          <Button size="sm" disabled={full} onClick={() => add('element')}><Plus className="mr-1 h-3.5 w-3.5" />Next to an element</Button>
        </div>
      )}>
        <p className="mb-3 text-xs text-gray-500">Buttons the chat widget places on your site for you. No code on the site: you choose where each one goes and what it does. Up to {MAX_ASK_BUTTONS} per website.</p>
        {draft.buttons.length === 0 && <p className="text-sm text-gray-500">No buttons yet. A <b>header button</b> adds &ldquo;Ask AI&rdquo; to your site&rsquo;s navigation and opens the chat docked at the side. A button <b>next to an element</b> sits by a product form, a pricing table or any other part of a page.</p>}
        <ul className="space-y-2">
          {draft.buttons.map((b) => (
            <li key={b.id}>
              {open === b.id ? (
                <div className="space-y-1.5">
                  <ButtonEditor b={b} accent={accent} shell={st.appearance.mode} canEdit={p.canEdit} onChange={(patch) => change(b.id, patch)} onRemove={() => remove(b.id)} />
                  <div className="text-right"><button type="button" className="text-xs text-indigo-700 hover:underline" onClick={() => setOpen(null)}>Done</button></div>
                </div>
              ) : (
                <button type="button" onClick={() => setOpen(b.id)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-gray-200 px-3 py-2 text-left text-sm hover:border-gray-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
                  <span className="w-36 flex-shrink-0 text-gray-500">{b.kind === 'header' ? 'Header button' : 'Next to an element'}</span>
                  <span className="font-medium text-gray-900">&ldquo;{b.label || 'Ask AI'}&rdquo;</span>
                  <span className="min-w-0 truncate font-mono text-xs text-gray-600" title={b.selector}>{b.selector || 'no selector yet'} · {POSITION_LABEL[b.position]}</span>
                  <span className="text-xs text-gray-500">{CLICK_LABEL[b.kind === 'header' ? 'open' : b.click]} · {pagesText(b.url_rules)}</span>
                  {!b.enabled && <Badge tone="gray">Off</Badge>}
                  {problem(b) && <Badge tone="amber">Incomplete</Badge>}
                  <span className="ml-auto text-xs text-indigo-700">Edit</span>
                </button>
              )}
            </li>
          ))}
        </ul>

        <div className="mt-4 divide-y divide-gray-100 border-t border-gray-100">
          <SettingRow title="Ask AI on selected text" description="When a visitor selects 3 or more words, a small Ask AI chip appears above the selection. A click opens the chat with “Explain this: …” in the message box."
            control={<Switch checked={draft.selection.enabled} onChange={(v) => set((d) => ({ ...d, selection: { ...d.selection, enabled: v } }))} label="Ask AI on selected text" disabled={!p.canEdit} />} />
          {draft.selection.enabled && (
            <div className="grid gap-3 py-3 md:grid-cols-2">
              <div><Label hint="a CSS selector: where a selection counts">Area</Label><input aria-label="Area where a selection counts (CSS selector)" className={cn(field, 'font-mono text-xs')} value={draft.selection.area} maxLength={200} onChange={(e) => set((d) => ({ ...d, selection: { ...d.selection, area: e.target.value } }))} disabled={!p.canEdit} placeholder={SELECTION_ASK_DEFAULTS.area} /></div>
              <div><Label hint="≤ 30 characters">Label</Label><input aria-label="Label of the selection chip" className={field} value={draft.selection.label} maxLength={30} onChange={(e) => set((d) => ({ ...d, selection: { ...d.selection, label: e.target.value } }))} disabled={!p.canEdit} placeholder="Ask AI" /></div>
            </div>
          )}
          <SettingRow title="Keyboard shortcut ⌘K / Ctrl+K" description="Opens and closes the chat in any shell. If your site uses ⌘K itself, your site keeps it."
            control={<Switch checked={draft.shortcut} onChange={(v) => set({ shortcut: v })} label="Keyboard shortcut" disabled={!p.canEdit} />} />
        </div>
        <SaveBar dirty={dirty} saving={saving} canEdit={p.canEdit} onReset={() => { reset(); setOpen(null); }} onSave={onSave} />
      </Card>

      <Card title="Test on my site">
        <p className="mb-2 text-xs text-gray-500">Opens your site with <code>?gx_debug=1</code>: every element a button matched is outlined, and the browser console lists which buttons were placed and which selectors matched nothing. The outline lasts for that browser tab only. Save first: the test shows what is published.</p>
        {sites.length === 0 ? <Note tone="amber">Add your site&rsquo;s domain on the General tab first.</Note> : (
          <div className="flex flex-wrap items-center gap-2">
            {sites.length > 1 && <select className={cn(field, 'w-auto')} value={site} onChange={(e) => setSite(e.target.value)} aria-label="Site to test on">{sites.map((s) => <option key={s} value={s}>{s.replace(/^https?:\/\//, '')}</option>)}</select>}
            <a href={`${site}${site.includes('?') ? '&' : '/?'}gx_debug=1`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"><ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />Test on {site.replace(/^https?:\/\//, '')}</a>
            {dirty && <span className="text-xs text-amber-700">You have unsaved changes.</span>}
          </div>
        )}
      </Card>
    </div>
  );
}
