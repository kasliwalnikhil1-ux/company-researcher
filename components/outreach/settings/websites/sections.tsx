'use client';

// Settings → Websites → {inbox}: one component per §12 section of web-chat-PRD.md. Each section edits a draft copy of its
// part of the settings and saves through outreach_webchat_inbox_update (nested merge, versioned, config_version bump).

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Copy, Plus, RefreshCw, Trash2, Upload } from 'lucide-react';
import { cn } from '@/lib/utils';
import { parseError, rpc } from '@/lib/outreach/api';
import { db } from '@/lib/outreach/backend';
import { useClients, useMembers } from '@/lib/outreach/queries';
import { Badge, Button, Card, Spinner, fmtDate, timeAgo } from '@/components/outreach/ui';
import { CopyButton, CopyField, ConfirmModal, Note, SettingRow, Switch } from '@/components/outreach/settings/shared';
import { WEBSITES_PATH } from './WebsitesFrame';
import { imageHosts, useProductSearch } from '@/lib/outreach/catalogue';
import { ProductImage } from '@/components/outreach/products/ProductCards';
import WidgetPreview from './WidgetPreview';
import CropModal from '@/components/outreach/profile/CropModal';
import { ENDED_BY, fmtCallLength, voiceLanguage, type VoiceReport } from '@/lib/outreach/voice';
import Link from '@/lib/outreach/nav';
import ModeSwitch from '@/components/outreach/ai/hub/ModeSwitch';
import ActivityTable from '@/components/outreach/ai/hub/ActivityTable';
import { MODE_LINE, WEBSITE_WHEN_LABEL, hubHref, websiteHubMode, type HubMode, type WebsiteWhen } from '@/lib/outreach/aiHub';
import {
  CSP_NOTES, HMAC_SAMPLES, WEBCHAT_IMAGE_ACCEPT, avatarUrl, uploadWebchatImage, useWebchatAvatars, INSTALL_GUIDES, OWN_BUTTON_ATTRIBUTES, OWN_BUTTON_SNIPPETS, SOURCE_LABELS, SUPABASE_URL, fmtSeconds, snippetHtml, standaloneUrl, useCampaigns, useCannedResponses, useDeleteCampaign, useDeleteCanned,
  useRegenerateHmac, useRestoreSettings, useSaveCampaign, useSaveCanned, useSetInboxMembers, useSettingsHistory, useUpdateInbox, useWebchatMailboxes, useWebchatReport,
  type BusinessHours, type InboxPatch, type PreChatField, type ProductsReport, type ProductsReportRow, type UrlRule, type WebchatCampaign, type WebchatInbox, type WebchatSettings,
} from '@/lib/outreach/webchat';

export interface SectionProps { inbox: WebchatInbox; ws: string; canEdit: boolean; toast: (m: string, kind?: 'error') => void }

/** A tab stacks several sections, each with its own Save: the page remounts a section on a new config_version only
 *  when it has no unsaved edits or the save was its own, so saving one card never wipes another card's draft. */
export const DraftScope = createContext<{ dirty: (d: boolean) => void; saved: () => void } | null>(null);

/** Draft + save helper shared by the sections. The page remounts a section on a new config_version, so no reset effect. */
export function useDraft<T>(initial: T) {
  const scope = useContext(DraftScope);
  const [draft, setDraft] = useState<T>(initial);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { scope?.dirty(dirty); }, [scope, dirty]);
  const set = (patch: Partial<T> | ((d: T) => T)) => { setDraft((d) => (typeof patch === 'function' ? (patch as (d: T) => T)(d) : { ...d, ...patch })); setDirty(true); };
  return { draft, set, dirty, reset: () => { setDraft(initial); setDirty(false); } };
}

export function SaveBar({ dirty, saving, onSave, onReset, canEdit }: { dirty: boolean; saving: boolean; onSave: () => void; onReset: () => void; canEdit: boolean }) {
  if (!canEdit) return <Note className="mt-4">Only owners and managers can change website settings.</Note>;
  return (
    <div className="flex items-center gap-2 pt-4 mt-4 border-t border-gray-100">
      <Button onClick={onSave} loading={saving} disabled={!dirty}>Save &amp; publish</Button>
      <Button variant="ghost" onClick={onReset} disabled={!dirty}>Discard</Button>
      <span className="text-xs text-gray-500">Changes reach the widget within 5 minutes.</span>
    </div>
  );
}

export function useSaveSettings(p: SectionProps) {
  const upd = useUpdateInbox(p.ws);
  const scope = useContext(DraftScope);
  return {
    saving: upd.isPending,
    save: async (patch: InboxPatch, ok = 'Saved') => { try { await upd.mutateAsync({ id: p.inbox.id, patch }); scope?.saved(); p.toast(ok); return true; } catch (e) { p.toast(parseError(e).message, 'error'); return false; } },
  };
}

export const field = 'w-full text-sm rounded-md border border-gray-300 px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-400';
export const Label = ({ children, hint }: { children: React.ReactNode; hint?: string }) => <label className="block text-xs font-medium text-gray-700 mb-1">{children}{hint && <span className="font-normal text-gray-400"> · {hint}</span>}</label>;
export const Grid = ({ children }: { children: React.ReactNode }) => <div className="grid gap-3 md:grid-cols-2">{children}</div>;

// ---------------------------------------------------------------- General
export function GeneralSection(p: SectionProps) {
  const { draft, set, dirty, reset } = useDraft({ name: p.inbox.name, domains: p.inbox.allowed_domains.join(', '), client_id: p.inbox.client_id ?? '', is_active: p.inbox.is_active, auto: p.inbox.settings.assignment.auto, capacity: p.inbox.settings.assignment.capacity, unassign: p.inbox.settings.assignment.unassign_offline_min, reply_mailbox_id: p.inbox.reply_mailbox_id ?? '' });
  const { save, saving } = useSaveSettings(p);
  const clients = useClients(p.ws);
  const members = useMembers(p.ws);
  const mailboxes = useWebchatMailboxes(p.ws);
  const setMembers = useSetInboxMembers(p.ws);
  const [team, setTeam] = useState<Record<string, { on: boolean; auto: boolean }>>(() => { const m: Record<string, { on: boolean; auto: boolean }> = {}; p.inbox.members.forEach((x) => { m[x.user_id] = { on: true, auto: x.auto_assign }; }); return m; });
  const saveTeam = async () => { try { await setMembers.mutateAsync({ id: p.inbox.id, members: Object.entries(team).filter(([, v]) => v.on).map(([user_id, v]) => ({ user_id, auto_assign: v.auto })) }); p.toast('Collaborators saved'); } catch (e) { p.toast(parseError(e).message, 'error'); } };
  return (
    <div className="space-y-4">
      <Card title="Website">
        <Grid>
          <div><Label>Website name</Label><input className={field} value={draft.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} disabled={!p.canEdit} /></div>
          <div><Label hint="comma-separated; *.example.com for subdomains">Allowed domains</Label><input className={field} value={draft.domains} onChange={(e) => set({ domains: e.target.value })} disabled={!p.canEdit} placeholder="acme.com, *.acme.com" /></div>
          {(clients.data?.length ?? 0) > 0 && <div><Label>Client</Label><select className={field} value={draft.client_id} onChange={(e) => set({ client_id: e.target.value })} disabled={!p.canEdit}><option value="">Whole workspace</option>{clients.data!.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>}
          <div><Label hint="continuity emails go out from it">Reply mailbox</Label><select className={field} value={draft.reply_mailbox_id} onChange={(e) => set({ reply_mailbox_id: e.target.value })} disabled={!p.canEdit}><option value="">Platform sender (no email replies back into the chat)</option>{(mailboxes.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.name || m.email} ({m.provider.toLowerCase()}{m.status !== 'ok' ? `, ${m.status}` : ''})</option>)}</select></div>
        </Grid>
        <div className="mt-3 divide-y divide-gray-100">
          <SettingRow title="Widget on" description="Off hides the widget on every page without deleting anything." control={<Switch checked={draft.is_active} onChange={(v) => set({ is_active: v })} label="Widget on" disabled={!p.canEdit} />} />
          <SettingRow title="Auto-assignment" description="New conversations go round-robin to online collaborators with capacity." control={<Switch checked={draft.auto} onChange={(v) => set({ auto: v })} label="Auto-assignment" disabled={!p.canEdit} />} />
          <div className="py-3 grid gap-3 md:grid-cols-2">
            <div><Label hint="open conversations per agent">Capacity</Label><input type="number" min={1} max={100} className={field} value={draft.capacity} onChange={(e) => set({ capacity: Number(e.target.value) || 1 })} disabled={!p.canEdit} /></div>
            <div><Label hint="0 = never">Unassign when the agent is offline for (min)</Label><input type="number" min={0} max={1440} className={field} value={draft.unassign} onChange={(e) => set({ unassign: Number(e.target.value) || 0 })} disabled={!p.canEdit} /></div>
          </div>
        </div>
        <SaveBar dirty={dirty} saving={saving} canEdit={p.canEdit} onReset={reset} onSave={() => save({ name: draft.name, allowed_domains: draft.domains.split(/[\s,]+/).filter(Boolean), client_id: draft.client_id || null, is_active: draft.is_active, reply_mailbox_id: draft.reply_mailbox_id || null, settings: { assignment: { auto: draft.auto, capacity: draft.capacity, unassign_offline_min: draft.unassign } } })} />
      </Card>
      <Card title="Collaborators" actions={p.canEdit && <Button size="sm" onClick={saveTeam} loading={setMembers.isPending}>Save collaborators</Button>}>
        <p className="text-xs text-gray-500 mb-2">Members who see and answer this website&apos;s conversations. Online = an outreach tab open in the last 10 minutes.</p>
        {members.isLoading && <Spinner />}
        <ul className="divide-y divide-gray-100">
          {(members.data ?? []).filter((m) => m.role !== 'client_viewer').map((m) => {
            const t = team[m.user_id] ?? { on: false, auto: true }; const online = p.inbox.members.find((x) => x.user_id === m.user_id)?.online;
            return (
              <li key={m.user_id} className="py-2 flex items-center gap-3 text-sm">
                <input type="checkbox" checked={t.on} disabled={!p.canEdit} onChange={(e) => setTeam({ ...team, [m.user_id]: { ...t, on: e.target.checked } })} aria-label={`Collaborator ${m.display_name || m.email}`} />
                <span className="flex-1 min-w-0 truncate">{m.display_name || m.email} <span className="text-xs text-gray-400">{m.role}</span></span>
                {online && <Badge tone="green">online</Badge>}
                <label className="text-xs text-gray-600 flex items-center gap-1"><input type="checkbox" checked={t.auto} disabled={!p.canEdit || !t.on} onChange={(e) => setTeam({ ...team, [m.user_id]: { ...t, auto: e.target.checked } })} /> auto-assign</label>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- Appearance
const FONTS = ['Inter', 'system-ui', 'Roboto', 'Open Sans', 'Lato', 'Poppins', 'Montserrat', 'Nunito', 'Georgia', 'Merriweather'];
function contrastRatio(a: string, b: string): number | null {
  const lum = (hex: string) => { const h = hex.replace('#', ''); const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h; if (!/^[0-9a-f]{6}$/i.test(f)) return null; const n = parseInt(f, 16); const [r, g, bl] = [n >> 16 & 255, n >> 8 & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * bl; };
  const la = lum(a), lb = lum(b); if (la == null || lb == null) return null; const [x, y] = la > lb ? [la, lb] : [lb, la]; return (x + 0.05) / (y + 0.05);
}
/** Bot avatar: a built-in one (`preset:<file>`, public/widget/v1/avatars), none (the brand initial) or a link to any image. */
function BotAvatarPicker({ p, value, brand, onChange }: { p: SectionProps; value: string | null; brand: string; onChange: (v: string | null) => void }) {
  const disabled = !p.canEdit;
  const avatars = useWebchatAvatars();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<File | null>(null);
  const upload = async (cropped: File) => {
    try {
      // keep the published avatar and the one on screen: Discard must still find them
      const url = await uploadWebchatImage(p.inbox.workspace_id, p.inbox.id, 'avatar', cropped, [p.inbox.settings.appearance.bot_avatar_url, value]);
      onChange(url); setPending(null); p.toast('Avatar uploaded. Save to publish it.');
    } catch (e) { p.toast(parseError(e).message, 'error'); }
  };
  const preset = /^preset:/i.test(value ?? '') ? value!.slice(7) : null, custom = value && !preset ? value : '';
  const tile = (on: boolean) => cn('w-11 h-11 rounded-full overflow-hidden flex-none ring-2 ring-offset-2 focus:outline-none focus-visible:ring-indigo-500 disabled:cursor-not-allowed', on ? 'ring-indigo-600' : 'ring-transparent hover:ring-gray-300');
  return (
    <div className="mt-3">
      <Label hint="next to the assistant's messages and on voice calls">Bot avatar</Label>
      <div className="flex flex-wrap items-center gap-2.5" role="radiogroup" aria-label="Bot avatar">
        <button type="button" role="radio" aria-checked={!value} disabled={disabled} onClick={() => onChange(null)} className={cn(tile(!value), 'bg-gray-100 text-gray-600 text-sm font-bold flex items-center justify-center')} title="No avatar: the brand initial">{(brand.trim() || 'C').slice(0, 1).toUpperCase()}</button>
        {(avatars.data ?? []).map((x) => (
          <button key={x.file} type="button" role="radio" aria-checked={preset === x.file} aria-label={x.label} title={x.label} disabled={disabled} onClick={() => onChange(`preset:${x.file}`)} className={tile(preset === x.file)}>
            <img src={avatarUrl(`preset:${x.file}`) ?? ''} alt="" className="w-full h-full object-cover" />
          </button>
        ))}
        {custom && avatarUrl(custom) && <span className={tile(true)} title="Your image"><img src={avatarUrl(custom)!} alt="" className="w-full h-full object-cover" /></span>}
        <input ref={fileRef} type="file" accept={WEBCHAT_IMAGE_ACCEPT} hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) setPending(f); }} />
        <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()} disabled={disabled}><Upload className="w-3.5 h-3.5 mr-1" />{custom ? 'Upload a new one' : 'Upload your own'}</Button>
      </div>
      <CropModal file={pending} kind="avatar" onCancel={() => setPending(null)} onConfirm={upload} />
    </div>
  );
}

/** Header logo: upload a picture and crop it to the circle the widget shows it in. Media is uploaded, never linked. */
function LogoPicker({ p, value, brand, onChange }: { p: SectionProps; value: string | null; brand: string; onChange: (v: string | null) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const upload = async (cropped: File) => {
    try {
      // keep the published logo and the one on screen: Discard must still find them
      const url = await uploadWebchatImage(p.inbox.workspace_id, p.inbox.id, 'logo', cropped, [p.inbox.settings.appearance.logo_url, value]);
      onChange(url); setPending(null); setError(null); p.toast('Logo uploaded. Save to publish it.');
    } catch (e) { p.toast(parseError(e).message, 'error'); }
  };
  return (
    <div className="md:col-span-2">
      <Label hint="shown in a circle in the chat header">Logo</Label>
      <div className="flex items-center gap-3">
        <div className={cn('w-11 h-11 rounded-full flex-none overflow-hidden flex items-center justify-center text-gray-600 text-sm font-bold ring-1 ring-gray-200', value && !error ? 'bg-transparent' : 'bg-gray-100')}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {value && !error ? <img src={value} alt="Logo preview" className="w-full h-full object-contain" onError={() => setError(value)} /> : (brand.trim() || 'C').slice(0, 1).toUpperCase()}
        </div>
        <input ref={fileRef} type="file" accept={WEBCHAT_IMAGE_ACCEPT} hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) setPending(f); }} />
        <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()} disabled={!p.canEdit}><Upload className="w-3.5 h-3.5 mr-1" />{value ? 'Upload a new logo' : 'Upload a logo'}</Button>
        {value && <Button size="sm" variant="ghost" onClick={() => { onChange(null); setError(null); }} disabled={!p.canEdit}><Trash2 className="w-3.5 h-3.5 mr-1" />Remove</Button>}
      </div>
      {error && error === value && <p className="text-xs text-amber-700 mt-1">This logo does not load. Upload it again.</p>}
      <CropModal file={pending} kind="logo" onCancel={() => setPending(null)} onConfirm={upload} />
    </div>
  );
}

/** The popup message's picture: uploaded and cropped to the circle it shows in. */
function PopupImagePicker({ p, value, onChange }: { p: SectionProps; value: string | null; onChange: (v: string | null) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<File | null>(null);
  const upload = async (cropped: File) => {
    try {
      const url = await uploadWebchatImage(p.inbox.workspace_id, p.inbox.id, 'popup', cropped, [p.inbox.settings.popup.image_url, value]);
      onChange(url); setPending(null); p.toast('Image uploaded. Save to publish it.');
    } catch (e) { p.toast(parseError(e).message, 'error'); }
  };
  return (
    <div>
      <Label hint="optional; shown in a circle next to the text">Popup image</Label>
      <div className="flex items-center gap-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {value && <img src={value} alt="Popup image preview" className="w-9 h-9 rounded-full object-cover flex-none ring-1 ring-gray-200" />}
        <input ref={fileRef} type="file" accept={WEBCHAT_IMAGE_ACCEPT} hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) setPending(f); }} />
        <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()} disabled={!p.canEdit}><Upload className="w-3.5 h-3.5 mr-1" />{value ? 'Replace' : 'Upload'}</Button>
        {value && <Button size="sm" variant="ghost" onClick={() => onChange(null)} disabled={!p.canEdit}><Trash2 className="w-3.5 h-3.5 mr-1" />Remove</Button>}
      </div>
      <CropModal file={pending} kind="popup" onCancel={() => setPending(null)} onConfirm={upload} />
    </div>
  );
}

export function AppearanceSection(p: SectionProps) {
  const { draft, set, dirty, reset } = useDraft(p.inbox.settings.appearance);
  const { save, saving } = useSaveSettings(p);
  const preview: WebchatSettings = { ...p.inbox.settings, appearance: draft };
  const onWhite = contrastRatio(draft.accent, '#ffffff'), onDark = contrastRatio(draft.accent, '#111827');
  const contrastOk = Math.max(onWhite ?? 0, onDark ?? 0) >= 4.5;
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
      <Card title="Appearance">
        <Grid>
          <div><Label hint="≤ 20 characters">Bot / brand name</Label><input className={field} maxLength={20} value={draft.brand_name} onChange={(e) => set({ brand_name: e.target.value })} disabled={!p.canEdit} /></div>
          <div><Label>Font</Label><select className={field} value={draft.font} onChange={(e) => set({ font: e.target.value })} disabled={!p.canEdit}>{FONTS.map((f) => <option key={f}>{f}</option>)}</select></div>
          <div><Label hint="≤ 50">Welcome heading</Label><input className={field} maxLength={50} value={draft.welcome_title} onChange={(e) => set({ welcome_title: e.target.value })} disabled={!p.canEdit} /></div>
          <div><Label hint="≤ 50">Welcome tagline</Label><input className={field} maxLength={50} value={draft.welcome_tagline} onChange={(e) => set({ welcome_tagline: e.target.value })} disabled={!p.canEdit} /></div>
          <LogoPicker p={p} value={draft.logo_url} brand={draft.brand_name || p.inbox.name} onChange={(v) => set({ logo_url: v })} />
          <div><Label>Accent colour</Label><div className="flex items-center gap-2"><input type="color" value={/^#[0-9a-f]{6}$/i.test(draft.accent) ? draft.accent : '#4f46e5'} onChange={(e) => set({ accent: e.target.value })} disabled={!p.canEdit} className="w-9 h-9 p-0 border rounded" aria-label="Accent colour" /><input className={field} value={draft.accent} onChange={(e) => set({ accent: e.target.value })} disabled={!p.canEdit} /></div>{!contrastOk && <p className="text-xs text-amber-700 mt-1">Contrast below 4.5:1 with both white and dark text — pick a darker or lighter accent (WCAG AA).</p>}</div>
          <div><Label>Widget background</Label><div className="flex items-center gap-2"><input type="color" value={draft.widget_bg} onChange={(e) => set({ widget_bg: e.target.value })} disabled={!p.canEdit} className="w-9 h-9 p-0 border rounded" aria-label="Widget background" /><input className={field} value={draft.widget_bg} onChange={(e) => set({ widget_bg: e.target.value })} disabled={!p.canEdit} /></div></div>
          <div><Label>Chat background</Label><div className="flex items-center gap-2"><input type="color" value={draft.chat_bg} onChange={(e) => set({ chat_bg: e.target.value })} disabled={!p.canEdit} className="w-9 h-9 p-0 border rounded" aria-label="Chat background" /><input className={field} value={draft.chat_bg} onChange={(e) => set({ chat_bg: e.target.value })} disabled={!p.canEdit} /></div></div>
          <div><Label>Theme</Label><select className={field} value={draft.theme} onChange={(e) => set({ theme: e.target.value as 'light' | 'dark' | 'auto' })} disabled={!p.canEdit}><option value="auto">Auto (follows the visitor)</option><option value="light">Light</option><option value="dark">Dark</option></select></div>
          <div><Label>Display mode</Label><select className={field} value={draft.mode} onChange={(e) => set({ mode: e.target.value as WebchatSettings['appearance']['mode'] })} disabled={!p.canEdit}><option value="bubble">Bubble (launcher + popup panel)</option><option value="drawer">Drawer (full-height slide-in)</option><option value="sidebar">Sidebar (pushes the page)</option><option value="modal">Modal (⌘K, hands off to sidebar)</option><option value="inline">Inline (bottom pill)</option><option value="embedded">Embedded (inside a container)</option></select></div>
          <div><Label>Drawer / sidebar side</Label><select className={field} value={draft.drawer_side} onChange={(e) => set({ drawer_side: e.target.value as 'left' | 'right' })} disabled={!p.canEdit}><option value="right">Right</option><option value="left">Left</option></select></div>
          <div><Label hint="320–720">Panel width (px)</Label><input type="number" min={320} max={720} className={field} value={draft.panel_width} onChange={(e) => set({ panel_width: Number(e.target.value) || 384 })} disabled={!p.canEdit} /></div>
          <div><Label>z-index</Label><input type="number" className={field} value={draft.z_index} onChange={(e) => set({ z_index: Number(e.target.value) || 2147483000 })} disabled={!p.canEdit} /></div>
        </Grid>
        <BotAvatarPicker p={p} value={draft.bot_avatar_url} brand={draft.brand_name || p.inbox.name} onChange={(v) => set({ bot_avatar_url: v })} />
        <div className="mt-3"><Label hint="advanced, scoped to the widget; @import and external url() are stripped">Custom CSS</Label><textarea className={cn(field, 'font-mono text-xs')} rows={5} value={draft.custom_css} onChange={(e) => set({ custom_css: e.target.value })} disabled={!p.canEdit} placeholder=".hd { border-radius: 0 }" /></div>
        <SaveBar dirty={dirty} saving={saving} canEdit={p.canEdit} onReset={reset} onSave={() => save({ settings: { appearance: draft } })} />
      </Card>
      <div className="xl:sticky xl:top-4 self-start"><WidgetPreview settings={preview} online={p.inbox.availability.online} brandFallback={p.inbox.name} inboxId={p.inbox.id} /></div>
    </div>
  );
}

// ---------------------------------------------------------------- Launcher & popup
function LauncherDevice({ k, v, dev, canEdit }: { k: 'desktop' | 'mobile'; v: WebchatSettings['launcher']['desktop']; dev: (k: 'desktop' | 'mobile', patch: Partial<WebchatSettings['launcher']['desktop']>) => void; canEdit: boolean }) {
  return (
    <div className="rounded-lg border border-gray-200 p-3 space-y-3">
      <div className="text-sm font-medium text-gray-900 capitalize">{k}</div>
      <Grid>
        <div><Label>Type</Label><select className={field} value={v.type} onChange={(e) => dev(k, { type: e.target.value as 'icon' | 'button' })} disabled={!canEdit}><option value="icon">Icon (round)</option><option value="button">Button (pill with text)</option></select></div>
        <div><Label>Size</Label><select className={field} value={v.size} onChange={(e) => dev(k, { size: e.target.value as 'sm' | 'md' | 'lg' })} disabled={!canEdit}><option value="sm">Small</option><option value="md">Medium</option><option value="lg">Large</option></select></div>
        <div><Label>Position</Label><select className={field} value={v.position} onChange={(e) => dev(k, { position: e.target.value as 'left' | 'right' })} disabled={!canEdit}><option value="right">Right</option><option value="left">Left</option></select></div>
        <div><Label hint="≤ 20">Button text</Label><input className={field} maxLength={20} value={v.text} onChange={(e) => dev(k, { text: e.target.value })} disabled={!canEdit} /></div>
        <div><Label>Bottom margin (px)</Label><input type="number" min={0} max={400} className={field} value={v.margin_bottom} onChange={(e) => dev(k, { margin_bottom: Number(e.target.value) || 0 })} disabled={!canEdit} /></div>
        <div><Label>Side margin (px)</Label><input type="number" min={0} max={400} className={field} value={v.margin_side} onChange={(e) => dev(k, { margin_side: Number(e.target.value) || 0 })} disabled={!canEdit} /></div>
      </Grid>
    </div>
  );
}

export function LauncherSection(p: SectionProps) {
  const { draft, set, dirty, reset } = useDraft({ launcher: p.inbox.settings.launcher, popup: p.inbox.settings.popup });
  const { save, saving } = useSaveSettings(p);
  const dev = (k: 'desktop' | 'mobile', patch: Partial<WebchatSettings['launcher']['desktop']>) => set((d) => ({ ...d, launcher: { ...d.launcher, [k]: { ...d.launcher[k], ...patch } } }));
  // "My own buttons" is the launcher's `hide`: nothing shows or opens by itself, the site's own buttons and links open the chat
  const own = !!draft.launcher.hide;
  const setOwn = (v: boolean) => set((d) => ({ ...d, launcher: { ...d.launcher, hide: v } }));
  const how = 'flex items-start gap-2.5 rounded-lg border p-3 text-left';
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
      <Card title="Launcher & popup">
        <fieldset className="mb-4">
          <legend className="mb-2 text-sm font-medium text-gray-900">How visitors open the chat</legend>
          <div className="grid gap-2 md:grid-cols-2">
            <label className={cn(how, p.canEdit && 'cursor-pointer', !own ? 'border-indigo-500 bg-indigo-50/50' : 'border-gray-200')}>
              <input type="radio" name="open-how" className="mt-0.5" checked={!own} onChange={() => setOwn(false)} disabled={!p.canEdit} />
              <span><span className="block text-sm font-medium text-gray-900">Our launcher</span><span className="block text-xs text-gray-500">The floating button in the corner of your site.</span></span>
            </label>
            <label className={cn(how, p.canEdit && 'cursor-pointer', own ? 'border-indigo-500 bg-indigo-50/50' : 'border-gray-200')}>
              <input type="radio" name="open-how" className="mt-0.5" checked={own} onChange={() => setOwn(true)} disabled={!p.canEdit} />
              <span>
                <span className="block text-sm font-medium text-gray-900">My own buttons</span>
                <span className="block text-xs text-gray-500">No floating button. The chat opens only when a visitor clicks a button or link on your site.</span>
                <Link href={`${WEBSITES_PATH}/${p.inbox.id}?tab=install#own-button`} className="mt-1 inline-block text-xs font-medium text-indigo-700 hover:underline">Show me the code</Link>
              </span>
            </label>
          </div>
        </fieldset>
        {own && (
          <div className="mb-4">
            <div className="divide-y divide-gray-100">
              <SettingRow title="Let campaigns open the chat" description="Off: a proactive campaign stays silent, because there is no launcher to show it on. On: it opens the chat with its message."
                control={<Switch checked={!!draft.launcher.campaigns_open} onChange={(v) => set((d) => ({ ...d, launcher: { ...d.launcher, campaigns_open: v } }))} label="Let campaigns open the chat" disabled={!p.canEdit} />} />
            </div>
            <Note className="mt-2">With your own buttons the launcher, the video bubble, the popup message and the unread previews are not shown, and the chat never opens by itself. A reply that arrives while the chat is closed shows on your own badge element (<code>data-growthxai-unread</code>). The launcher settings below apply again when you switch back to our launcher.</Note>
          </div>
        )}
        <div className={cn('space-y-3', own && 'opacity-50')}><LauncherDevice k="desktop" v={draft.launcher.desktop} dev={dev} canEdit={p.canEdit} /><LauncherDevice k="mobile" v={draft.launcher.mobile} dev={dev} canEdit={p.canEdit} /></div>
        <div className="divide-y divide-gray-100 mt-2">
          <SettingRow title="Show unread count" control={<Switch checked={draft.launcher.show_unread_count} onChange={(v) => set((d) => ({ ...d, launcher: { ...d.launcher, show_unread_count: v } }))} label="Show unread count" disabled={!p.canEdit} />} />
          <SettingRow title="Show unread message previews" description="Cards above the launcher when the panel is closed." control={<Switch checked={draft.launcher.show_unread_previews} onChange={(v) => set((d) => ({ ...d, launcher: { ...d.launcher, show_unread_previews: v } }))} label="Show previews" disabled={!p.canEdit} />} />
          <SettingRow title="Online indicator dot" control={<Switch checked={draft.launcher.online_dot} onChange={(v) => set((d) => ({ ...d, launcher: { ...d.launcher, online_dot: v } }))} label="Online dot" disabled={!p.canEdit} />} />
          <SettingRow title="Popup message" description="A nudge above the launcher, once per session, never after the visitor has chatted." control={<Switch checked={draft.popup.enabled} onChange={(v) => set((d) => ({ ...d, popup: { ...d.popup, enabled: v } }))} label="Popup" disabled={!p.canEdit} />} />
        </div>
        {draft.popup.enabled && (
          <Grid>
            <div className="md:col-span-2"><Label hint="≤ 60">Popup text</Label><input className={field} maxLength={60} value={draft.popup.text} onChange={(e) => set((d) => ({ ...d, popup: { ...d.popup, text: e.target.value } }))} disabled={!p.canEdit} /></div>
            <PopupImagePicker p={p} value={draft.popup.image_url} onChange={(v) => set((d) => ({ ...d, popup: { ...d.popup, image_url: v } }))} />
            <div><Label hint="2–5 recommended">Delay (s)</Label><input type="number" min={0} max={120} className={field} value={draft.popup.delay_s} onChange={(e) => set((d) => ({ ...d, popup: { ...d.popup, delay_s: Number(e.target.value) || 0 } }))} disabled={!p.canEdit} /></div>
          </Grid>
        )}
        <SaveBar dirty={dirty} saving={saving} canEdit={p.canEdit} onReset={reset} onSave={() => save({ settings: { launcher: draft.launcher, popup: draft.popup } })} />
      </Card>
      <div className="xl:sticky xl:top-4 self-start"><WidgetPreview settings={{ ...p.inbox.settings, launcher: draft.launcher, popup: draft.popup }} online={p.inbox.availability.online} brandFallback={p.inbox.name} inboxId={p.inbox.id} /></div>
    </div>
  );
}

// ---------------------------------------------------------------- Messages
export function MessagesSection(p: SectionProps) {
  const { draft, set, dirty, reset } = useDraft(p.inbox.settings.messages);
  const { save, saving } = useSaveSettings(p);
  const T = (k: keyof typeof draft, label: string, hint?: string, rows = 2) => <div className="md:col-span-2"><Label hint={hint}>{label}</Label><textarea className={field} rows={rows} value={String(draft[k] ?? '')} onChange={(e) => set({ [k]: e.target.value } as Partial<typeof draft>)} disabled={!p.canEdit} /></div>;
  return (
    <Card title="Messages">
      <div className="divide-y divide-gray-100"><SettingRow title="Greeting" description="Sent as the first bot message when a conversation starts." control={<Switch checked={draft.greeting_enabled} onChange={(v) => set({ greeting_enabled: v })} label="Greeting" disabled={!p.canEdit} />} /></div>
      <Grid>
        {T('greeting', 'Greeting message')}
        <div><Label>Reply-time text</Label><select className={field} value={draft.reply_time} onChange={(e) => set({ reply_time: e.target.value as typeof draft.reply_time })} disabled={!p.canEdit}><option value="minutes">Typically replies in a few minutes</option><option value="hours">Typically replies in a few hours</option><option value="day">Typically replies in a day</option><option value="none">Hidden</option></select></div>
        <div><Label>Composer placeholder</Label><input className={field} value={draft.placeholder} onChange={(e) => set({ placeholder: e.target.value })} disabled={!p.canEdit} placeholder="Ask a question…" /></div>
        {T('available_message', 'Available message', 'shown when online')}
        {T('unavailable_message', 'Unavailable message', 'shown outside business hours or with nobody online')}
        {T('email_capture_prompt', 'Email capture prompt', 'asked once when nobody is online and the visitor is unknown')}
        {T('handoff_message', 'Handoff message', 'when the assistant hands over and someone is online')}
        {T('handoff_offline_message', 'Handoff message (offline)')}
        {T('end_message', 'End-of-chat message', 'with the rating prompt')}
        <div className="md:col-span-2"><Label hint="https; the link in “By chatting with us, you agree to our Privacy Policy”, shown under the chat until the visitor sends their first message. Empty = the platform policy">Privacy policy link</Label><input className={field} type="url" value={draft.privacy_url ?? ''} onChange={(e) => set({ privacy_url: e.target.value.trim() || null })} disabled={!p.canEdit} placeholder="https://your-site.com/privacy" /></div>
        <div className="md:col-span-2"><Label hint="one per line, ≤ 6; shown as chips on the home screen">Quick-reply chips (conversation starters)</Label><textarea className={field} rows={3} value={draft.quick_replies.join('\n')} onChange={(e) => set({ quick_replies: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 6) })} disabled={!p.canEdit} placeholder={'Pricing\nBook a demo\nI need help with my account'} /></div>
      </Grid>
      <SaveBar dirty={dirty} saving={saving} canEdit={p.canEdit} onReset={reset} onSave={() => save({ settings: { messages: draft } })} />
    </Card>
  );
}

// ---------------------------------------------------------------- Pre-chat form
export function PreChatSection(p: SectionProps) {
  const { draft, set, dirty, reset } = useDraft(p.inbox.settings.pre_chat);
  const { save, saving } = useSaveSettings(p);
  const setField = (i: number, patch: Partial<PreChatField>) => set((d) => ({ ...d, fields: d.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) }));
  const addField = () => set((d) => ({ ...d, fields: [...d.fields, { key: `custom_${d.fields.length + 1}`, label: 'New field', type: 'text', visible: true, required: false }] }));
  return (
    <Card title="Pre-chat form">
      <div className="divide-y divide-gray-100">
        <SettingRow title="Ask before the first message" description="Skipped when the visitor is already identified through the SDK." control={<Switch checked={draft.enabled} onChange={(v) => set({ enabled: v })} label="Pre-chat form" disabled={!p.canEdit} />} />
      </div>
      <Grid>
        <div className="md:col-span-2"><Label hint="≤ 200">Message above the form</Label><input className={field} maxLength={200} value={draft.message} onChange={(e) => set({ message: e.target.value })} disabled={!p.canEdit} /></div>
        <div><Label>Show</Label><select className={field} value={draft.when} onChange={(e) => set({ when: e.target.value as 'before_first' | 'offline_only' })} disabled={!p.canEdit}><option value="before_first">Before the first message</option><option value="offline_only">Only when nobody is online</option></select></div>
      </Grid>
      <div className="mt-4">
        <div className="flex items-center justify-between mb-2"><Label>Fields</Label>{p.canEdit && <Button size="sm" variant="secondary" onClick={addField}><Plus className="w-3.5 h-3.5 mr-1" />Custom field</Button>}</div>
        <div className="space-y-2">
          {draft.fields.map((f, i) => {
            const std = ['name', 'email', 'phone'].includes(f.key);
            return (
              <div key={i} className="grid gap-2 md:grid-cols-[1fr_1fr_120px_auto_auto_auto] items-end rounded-lg border border-gray-200 p-2">
                <div><Label>Key</Label><input className={field} value={f.key} disabled={!p.canEdit || std} onChange={(e) => setField(i, { key: e.target.value.replace(/[^a-z0-9_]/gi, '_').toLowerCase() })} /></div>
                <div><Label>Label</Label><input className={field} value={f.label} disabled={!p.canEdit} onChange={(e) => setField(i, { label: e.target.value })} /></div>
                <div><Label>Type</Label><select className={field} value={f.type} disabled={!p.canEdit || std} onChange={(e) => setField(i, { type: e.target.value as PreChatField['type'] })}>{['text', 'email', 'phone', 'number', 'list', 'checkbox', 'date', 'url', 'textarea'].map((t) => <option key={t}>{t}</option>)}</select></div>
                <label className="text-xs flex items-center gap-1 pb-2"><input type="checkbox" checked={f.visible} disabled={!p.canEdit} onChange={(e) => setField(i, { visible: e.target.checked })} /> visible</label>
                <label className="text-xs flex items-center gap-1 pb-2"><input type="checkbox" checked={f.required} disabled={!p.canEdit} onChange={(e) => setField(i, { required: e.target.checked })} /> required</label>
                {!std && p.canEdit ? <button type="button" className="text-gray-400 hover:text-red-600 pb-2" aria-label="Remove field" onClick={() => set((d) => ({ ...d, fields: d.fields.filter((_, j) => j !== i) }))}><Trash2 className="w-4 h-4" /></button> : <span />}
                {(f.type === 'list') && <div className="md:col-span-6"><Label hint="one per line">Options</Label><textarea className={field} rows={2} value={(f.options ?? []).join('\n')} disabled={!p.canEdit} onChange={(e) => setField(i, { options: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })} /></div>}
                {!std && f.type !== 'list' && f.type !== 'checkbox' && <div className="md:col-span-3"><Label hint="regex, optional">Validation</Label><input className={field} value={f.pattern ?? ''} disabled={!p.canEdit} onChange={(e) => setField(i, { pattern: e.target.value || undefined })} placeholder="^[A-Z]{2}\d{4}$" /></div>}
                {!std && <div className="md:col-span-3"><Label>Placeholder</Label><input className={field} value={f.placeholder ?? ''} disabled={!p.canEdit} onChange={(e) => setField(i, { placeholder: e.target.value })} /></div>}
              </div>
            );
          })}
        </div>
      </div>
      <div className="mt-4 divide-y divide-gray-100">
        <SettingRow title="Consent checkbox" description="Stored with a timestamp and the text version (GDPR / marketing)." control={<Switch checked={draft.consent.enabled} onChange={(v) => set((d) => ({ ...d, consent: { ...d.consent, enabled: v } }))} label="Consent" disabled={!p.canEdit} />} />
      </div>
      {draft.consent.enabled && (
        <Grid>
          <div><Label>Label</Label><input className={field} value={draft.consent.label} onChange={(e) => set((d) => ({ ...d, consent: { ...d.consent, label: e.target.value } }))} disabled={!p.canEdit} /></div>
          <div><Label>Link (privacy policy)</Label><input className={field} value={draft.consent.link ?? ''} onChange={(e) => set((d) => ({ ...d, consent: { ...d.consent, link: e.target.value || null } }))} disabled={!p.canEdit} /></div>
          <div><Label hint="bump when the wording changes">Text version</Label><input className={field} value={draft.consent.text_version} onChange={(e) => set((d) => ({ ...d, consent: { ...d.consent, text_version: e.target.value } }))} disabled={!p.canEdit} /></div>
        </Grid>
      )}
      <SaveBar dirty={dirty} saving={saving} canEdit={p.canEdit} onReset={reset} onSave={() => save({ settings: { pre_chat: draft } })} />
    </Card>
  );
}

// ---------------------------------------------------------------- Availability
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const DAY_LABEL: Record<string, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
export function AvailabilitySection(p: SectionProps) {
  const init = { bh: { tz: p.inbox.business_hours.tz ?? 'UTC', weekly: p.inbox.business_hours.weekly ?? {}, holidays: p.inbox.business_hours.holidays ?? [] } as Required<BusinessHours>, enabled: !!p.inbox.business_hours.weekly, show_offline: p.inbox.settings.features.show_offline_status, hide_outside: p.inbox.settings.features.hide_outside_hours };
  const { draft, set, dirty, reset } = useDraft(init);
  const { save, saving } = useSaveSettings(p);
  const [tzs] = useState<string[]>(() => { try { return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? ['UTC']; } catch { return ['UTC']; } });
  const setDay = (d: string, iv: Array<[string, string]>) => set((x) => ({ ...x, bh: { ...x.bh, weekly: { ...x.bh.weekly, [d]: iv } } }));
  const av = p.inbox.availability;
  return (
    <Card title="Availability">
      <Note tone={av.online ? 'green' : 'gray'} className="mb-3">Right now: {av.online ? 'online' : 'offline'} · {av.in_hours ? 'inside business hours' : `outside business hours${av.next_open_at ? `, back ${timeAgo(av.next_open_at).replace('ago', '')}` : ''}`} · {av.agents.length} collaborator{av.agents.length === 1 ? '' : 's'} online. Online for the widget = at least one collaborator online and inside hours.</Note>
      <div className="divide-y divide-gray-100">
        <SettingRow title="Business hours" description="Outside hours the widget shows the unavailable message; the assistant can cover after hours (AI agent tab)." control={<Switch checked={draft.enabled} onChange={(v) => set((x) => ({ ...x, enabled: v, bh: { ...x.bh, weekly: v && !Object.keys(x.bh.weekly).length ? Object.fromEntries(DAYS.map((d) => [d, ['sat', 'sun'].includes(d) ? [] : [['09:00', '18:00']]])) : x.bh.weekly } }))} label="Business hours" disabled={!p.canEdit} />} />
      </div>
      {draft.enabled && (
        <div className="space-y-3 mt-2">
          <div className="max-w-xs"><Label>Timezone</Label><select className={field} value={draft.bh.tz} onChange={(e) => set((x) => ({ ...x, bh: { ...x.bh, tz: e.target.value } }))} disabled={!p.canEdit}>{tzs.map((t) => <option key={t}>{t}</option>)}</select></div>
          <div className="space-y-1.5">
            {DAYS.map((d) => {
              const iv = draft.bh.weekly[d] ?? [];
              return (
                <div key={d} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="w-24 text-gray-700">{DAY_LABEL[d]}</span>
                  {iv.length === 0 && <span className="text-xs text-gray-400">Closed</span>}
                  {iv.map((x, i) => <span key={i} className="inline-flex items-center gap-1"><input type="time" className={cn(field, 'w-auto')} value={x[0]} disabled={!p.canEdit} onChange={(e) => setDay(d, iv.map((y, j) => (j === i ? [e.target.value, y[1]] : y)))} /><span className="text-gray-400">–</span><input type="time" className={cn(field, 'w-auto')} value={x[1]} disabled={!p.canEdit} onChange={(e) => setDay(d, iv.map((y, j) => (j === i ? [y[0], e.target.value] : y)))} />{p.canEdit && <button type="button" className="text-gray-400 hover:text-red-600" aria-label="Remove interval" onClick={() => setDay(d, iv.filter((_, j) => j !== i))}>×</button>}</span>)}
                  {p.canEdit && <button type="button" className="text-xs text-indigo-600 hover:underline" onClick={() => setDay(d, [...iv, ['09:00', '18:00']])}>+ interval</button>}
                </div>
              );
            })}
          </div>
          <div><Label hint="YYYY-MM-DD, one per line">Holidays</Label><textarea className={field} rows={3} value={draft.bh.holidays.join('\n')} onChange={(e) => set((x) => ({ ...x, bh: { ...x.bh, holidays: e.target.value.split('\n').map((s) => s.trim()).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)) } }))} disabled={!p.canEdit} /></div>
          <p className="text-xs text-gray-500">Intervals may cross midnight (22:00–02:00). Computed in the timezone above, DST-safe.</p>
        </div>
      )}
      <div className="divide-y divide-gray-100 mt-2">
        <SettingRow title="Show agent offline status" description="Off keeps the header neutral when nobody is online." control={<Switch checked={draft.show_offline} onChange={(v) => set({ show_offline: v })} label="Show offline status" disabled={!p.canEdit} />} />
        <SettingRow title="Hide the widget outside business hours" control={<Switch checked={draft.hide_outside} onChange={(v) => set({ hide_outside: v })} label="Hide outside hours" disabled={!p.canEdit} />} />
      </div>
      <SaveBar dirty={dirty} saving={saving} canEdit={p.canEdit} onReset={reset} onSave={() => save({ business_hours: draft.enabled ? draft.bh : { tz: draft.bh.tz }, settings: { features: { show_offline_status: draft.show_offline, hide_outside_hours: draft.hide_outside } } })} />
    </Card>
  );
}

// ---------------------------------------------------------------- Features + CSAT + Email
const FEATURES: Array<[keyof WebchatSettings['features'], string, string?]> = [
  ['file_picker', 'File picker', 'Images, PDF, office documents, text and CSV up to 10 MB. Executables are always blocked.'], ['emoji_picker', 'Emoji picker'], ['restart', 'Restart conversation button'],
  ['end_conversation', 'End conversation button', 'The visitor can resolve the conversation and rate it.'], ['allow_after_resolved', 'Allow messages after resolved', 'On: a message reopens the conversation. Off: it starts a new one.'],
  ['single_conversation', 'Lock to a single conversation', 'No conversation list; the visitor always continues the same thread.'], ['sounds', 'Sounds', 'A soft chime when a reply arrives while the tab is hidden.'], ['read_receipts', 'Read receipts', '✓✓ once an agent has seen the message.'],
  ['show_agent_names', 'Show agent names and avatars'], ['transcript', 'Transcript by email'], ['email_capture', 'Email capture when nobody is online'], ['markdown', 'Render markdown in agent and assistant messages'], ['powered_by', '"Powered by" strip', 'Its own band under the chat, in fixed colours.'],
];
export function FeaturesSection(p: SectionProps) {
  const { draft, set, dirty, reset } = useDraft({ features: p.inbox.settings.features, csat: p.inbox.settings.csat, continuity: p.inbox.settings.continuity });
  const { save, saving } = useSaveSettings(p);
  return (
    <div className="space-y-4">
      <Card title="Features">
        <div className="divide-y divide-gray-100">
          {FEATURES.map(([k, t, d]) => <SettingRow key={k} title={t} description={d} control={<Switch checked={!!draft.features[k]} onChange={(v) => set((x) => ({ ...x, features: { ...x.features, [k]: v } }))} label={t} disabled={!p.canEdit} />} />)}
        </div>
        <SaveBar dirty={dirty} saving={saving} canEdit={p.canEdit} onReset={reset} onSave={() => save({ settings: { features: draft.features, csat: draft.csat, continuity: draft.continuity } })} />
      </Card>
      <Card title="Customer satisfaction (CSAT)">
        <div className="divide-y divide-gray-100">
          <SettingRow title="Ask for a rating when a conversation is resolved" control={<Switch checked={draft.csat.enabled} onChange={(v) => set((x) => ({ ...x, csat: { ...x.csat, enabled: v } }))} label="CSAT" disabled={!p.canEdit} />} />
          <div className="py-3 grid gap-3 md:grid-cols-2">
            <div><Label>Scale</Label><select className={field} value={draft.csat.scale} onChange={(e) => set((x) => ({ ...x, csat: { ...x.csat, scale: e.target.value as 'emoji' | 'thumbs' } }))} disabled={!p.canEdit}><option value="emoji">5-point emoji</option><option value="thumbs">Thumbs up / down</option></select></div>
          </div>
          <SettingRow title="Ask for a comment" control={<Switch checked={draft.csat.ask_comment} onChange={(v) => set((x) => ({ ...x, csat: { ...x.csat, ask_comment: v } }))} label="Ask for a comment" disabled={!p.canEdit} />} />
          <SettingRow title="Send by email when the visitor has left" control={<Switch checked={draft.csat.by_email} onChange={(v) => set((x) => ({ ...x, csat: { ...x.csat, by_email: v } }))} label="CSAT by email" disabled={!p.canEdit} />} />
        </div>
      </Card>
      <Card title="Email continuity">
        <p className="text-xs text-gray-500 mb-2">When the visitor has left the site, replies are emailed as one digest per conversation from the reply mailbox (General tab). Their email reply lands back in the same conversation.</p>
        <div className="divide-y divide-gray-100">
          <SettingRow title="Enable continuity emails" control={<Switch checked={draft.continuity.enabled} onChange={(v) => set((x) => ({ ...x, continuity: { ...x.continuity, enabled: v } }))} label="Continuity" disabled={!p.canEdit} />} />
          <div className="py-3 grid gap-3 md:grid-cols-2">
            <div><Label hint="3–30">Send after the visitor has been away for (min)</Label><input type="number" min={3} max={30} className={field} value={draft.continuity.inactivity_min} onChange={(e) => set((x) => ({ ...x, continuity: { ...x.continuity, inactivity_min: Math.min(30, Math.max(3, Number(e.target.value) || 5)) } }))} disabled={!p.canEdit} /></div>
            <div><Label hint="at most one email per window">Digest window (min)</Label><input type="number" min={5} max={120} className={field} value={draft.continuity.digest_window_min} onChange={(e) => set((x) => ({ ...x, continuity: { ...x.continuity, digest_window_min: Math.max(5, Number(e.target.value) || 15) } }))} disabled={!p.canEdit} /></div>
          </div>
          <SettingRow title="Include the transcript when resolved" control={<Switch checked={draft.continuity.include_transcript_on_resolve} onChange={(v) => set((x) => ({ ...x, continuity: { ...x.continuity, include_transcript_on_resolve: v } }))} label="Transcript on resolve" disabled={!p.canEdit} />} />
        </div>
        {!p.inbox.reply_mailbox_id && <Note tone="amber" className="mt-2">No reply mailbox is set. Digests go out from the platform sender when it is configured, and visitors cannot reply by email into the chat. Pick a connected mailbox on the General tab.</Note>}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- Website agent
// Off · Review · Auto, the same switch as every AI feature (AI hub). Stored as before: Off = ai_enabled false,
// Review = ai.mode 'review', Auto · Always = 'first', Auto · Outside business hours = 'offline_only'.
export function AiSection(p: SectionProps & { between?: React.ReactNode }) {
  const { draft, set, dirty, reset } = useDraft({ enabled: p.inbox.ai_enabled, ai: p.inbox.settings.ai });
  const { save, saving } = useSaveSettings(p);
  const sources = useQuery({ queryKey: ['outreach', p.ws, 'knowledge-sources'], queryFn: () => rpc<Array<{ id: string; title: string; kind: string; status: string; chunks: number; url: string | null }>>('knowledge_sources_list', { p_ws: p.ws }) });
  const toggleSrc = (id: string) => set((x) => ({ ...x, ai: { ...x.ai, knowledge_source_ids: x.ai.knowledge_source_ids.includes(id) ? x.ai.knowledge_source_ids.filter((s) => s !== id) : [...x.ai.knowledge_source_ids, id] } }));
  const hub = websiteHubMode({ ai_enabled: draft.enabled, mode: draft.ai.mode });
  const setMode = (m: HubMode) => set((x) => (m === 'off' ? { ...x, enabled: false }
    : { ...x, enabled: true, ai: { ...x.ai, mode: m === 'review' ? 'review' : hub.when === 'outside_hours' ? 'offline_only' : 'first' } }));
  const setWhen = (w: WebsiteWhen) => set((x) => ({ ...x, ai: { ...x.ai, mode: w === 'outside_hours' ? 'offline_only' : 'first' } }));
  return (
    <div className="space-y-4">
      <Card title="Website agent">
        <div className="flex flex-wrap items-start gap-x-8 gap-y-3 pb-4 mb-4 border-b border-gray-100">
          <ModeSwitch label="Website agent mode" value={hub.mode} onChange={setMode} lines={MODE_LINE.website} disabled={!p.canEdit} />
          {hub.mode === 'auto' && (
            <div>
              <Label hint="also covers times when nobody on your team is online">When</Label>
              <select className={field} aria-label="When the assistant answers" value={hub.when} onChange={(e) => setWhen(e.target.value as WebsiteWhen)} disabled={!p.canEdit}>
                <option value="always">{WEBSITE_WHEN_LABEL.always}</option><option value="outside_hours">{WEBSITE_WHEN_LABEL.outside_hours}</option>
              </select>
            </div>
          )}
          {hub.mode === 'review' && (
            <div>
              <Label hint="then the visitor gets your offline message">A suggestion waits (minutes)</Label>
              <input type="number" min={1} max={240} className={field} aria-label="Minutes a suggestion waits for an agent" value={draft.ai.review_timeout_min ?? 10}
                onChange={(e) => set((x) => ({ ...x, ai: { ...x.ai, review_timeout_min: Math.min(240, Math.max(1, Math.round(Number(e.target.value)) || 10)) } }))} disabled={!p.canEdit} />
            </div>
          )}
        </div>
        <p className="text-xs text-gray-500 mb-3">
          {hub.mode === 'review'
            ? 'In Review the suggestion appears in the reply box of the chat and in AI → Needs you. The AI never sends it. Each suggestion uses one AI action from the workspace allowance.'
            : 'The assistant answers from your knowledge sources, the shared Q&A and the page the visitor is on. Each answer uses one AI action from the workspace allowance; when the allowance is used up the widget quietly becomes live chat.'}
        </p>
        <Grid>
          <div><Label hint="protects the allowance">Answers per visitor per hour</Label><input type="number" min={1} max={200} className={field} value={draft.ai.hourly_cap_per_visitor} onChange={(e) => set((x) => ({ ...x, ai: { ...x.ai, hourly_cap_per_visitor: Number(e.target.value) || 30 } }))} disabled={!p.canEdit} /></div>
          <div className="md:col-span-2"><Label hint="tone, name, what to say about pricing, links to include">Persona / brand instructions</Label><textarea className={field} rows={4} value={draft.ai.persona} onChange={(e) => set((x) => ({ ...x, ai: { ...x.ai, persona: e.target.value } }))} disabled={!p.canEdit} placeholder="You are Acme's assistant. Friendly, concise. Never quote enterprise pricing; offer a call instead." /></div>
          <div className="md:col-span-2"><Label hint="optional; anything else is politely declined">Allowed topics</Label><input className={field} value={draft.ai.allowed_topics} onChange={(e) => set((x) => ({ ...x, ai: { ...x.ai, allowed_topics: e.target.value } }))} disabled={!p.canEdit} placeholder="Acme products, pricing, onboarding, billing" /></div>
        </Grid>
        <div className="mt-4">
          <Label hint="websites and documents from AI → Knowledge">Knowledge sources</Label>
          {sources.isLoading && <Spinner />}
          {sources.data?.length === 0 && <p className="text-xs text-gray-500">No knowledge sources yet. Add a website or a document in <Link href={hubHref.knowledge()} className="text-indigo-700 hover:underline">AI → Knowledge</Link>, then pick it here.</p>}
          <ul className="space-y-1">
            {/* a product catalogue is not a text to answer from: it is picked in the Products card below */}
            {(sources.data ?? []).filter((s) => s.kind !== 'catalogue').map((s) => <li key={s.id}><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.ai.knowledge_source_ids.includes(s.id)} disabled={!p.canEdit} onChange={() => toggleSrc(s.id)} /><span className="truncate">{s.title}</span><span className="text-xs text-gray-400">{s.kind} · {s.status} · {s.chunks} chunks</span></label></li>)}
          </ul>
          {(sources.data?.length ?? 0) > 0 && <p className="text-xs text-gray-500 mt-2">Shared Q&amp;A pairs are used too, unless a pair is limited to other places. Sources and Q&amp;A are managed in <Link href={hubHref.knowledge()} className="text-indigo-700 hover:underline">AI → Knowledge</Link>.</p>}
        </div>
        {hub.mode !== 'auto' && <p className="text-xs text-gray-500 mt-4">The hand-off rules below apply when the assistant is on Auto.</p>}
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <div className="md:col-span-2"><Label hint="one per line; a message containing one hands off to a person">Handoff keywords</Label><textarea className={field} rows={3} value={draft.ai.handoff.keywords.join('\n')} onChange={(e) => set((x) => ({ ...x, ai: { ...x.ai, handoff: { ...x.ai.handoff, keywords: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) } } }))} disabled={!p.canEdit} /></div>
          <div><Label>Hand off after N assistant turns</Label><input type="number" min={1} max={50} className={field} value={draft.ai.handoff.max_turns} onChange={(e) => set((x) => ({ ...x, ai: { ...x.ai, handoff: { ...x.ai.handoff, max_turns: Number(e.target.value) || 6 } } }))} disabled={!p.canEdit} /></div>
          <div><Label>Hand off after N low-confidence answers in a row</Label><input type="number" min={1} max={10} className={field} value={draft.ai.handoff.low_confidence_streak} onChange={(e) => set((x) => ({ ...x, ai: { ...x.ai, handoff: { ...x.ai.handoff, low_confidence_streak: Number(e.target.value) || 2 } } }))} disabled={!p.canEdit} /></div>
        </div>
        <div className="divide-y divide-gray-100 mt-2">
          <SettingRow title="Hand leads in an active sequence straight to a person" control={<Switch checked={draft.ai.handoff.leads_in_sequence} onChange={(v) => set((x) => ({ ...x, ai: { ...x.ai, handoff: { ...x.ai.handoff, leads_in_sequence: v } } }))} label="Leads to a person" disabled={!p.canEdit} />} />
          <SettingRow title="Show sources under answers" control={<Switch checked={draft.ai.show_sources} onChange={(v) => set((x) => ({ ...x, ai: { ...x.ai, show_sources: v } }))} label="Show sources" disabled={!p.canEdit} />} />
        </div>
        {/* the product settings have their own card and their own save: they are left out of this one */}
        <SaveBar dirty={dirty} saving={saving} canEdit={p.canEdit} onReset={reset} onSave={() => { const { products: _products, ...ai } = draft.ai; void _products; return save({ ai_enabled: draft.enabled, settings: { ai } }); }} />
      </Card>
      {p.between}
      {/* What the assistant wrote for this website: the Activity table, pre-filtered (it replaced "Recent answers"). */}
      <Card title="What the assistant wrote" actions={<Link href={hubHref.activity({ feature: 'website', where: p.inbox.id })} className="text-xs font-medium text-indigo-700 hover:underline">Open in Activity</Link>}>
        <p className="text-xs text-gray-500 mb-3">Answers sent to visitors and suggestions written for your agents. Questions the assistant could not answer wait in <Link href={hubHref.needsYou({ type: 'question', where: p.inbox.id, mine: false })} className="text-indigo-700 hover:underline">AI → Needs you</Link>. Test the assistant on the Install &amp; security tab (demo page).</p>
        <ActivityTable ws={p.ws} fixed={{ feature: 'website', where: p.inbox.id }} pageSize={20} emptyText="The assistant has not written anything for this website in this period." />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- Targeting & campaigns
export function TargetingSection(p: SectionProps) {
  const { draft, set, dirty, reset } = useDraft(p.inbox.settings.targeting);
  const { save, saving } = useSaveSettings(p);
  const setRule = (i: number, patch: Partial<UrlRule>) => set((d) => ({ ...d, url_rules: d.url_rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const camps = useCampaigns(p.inbox.id);
  const saveC = useSaveCampaign(p.inbox.id);
  const delC = useDeleteCampaign(p.inbox.id);
  const [edit, setEdit] = useState<Partial<WebchatCampaign> | null>(null);
  const submitC = async () => { if (!edit) return; try { await saveC.mutateAsync({ id: edit.id ?? null, row: edit }); setEdit(null); p.toast('Campaign saved'); } catch (e) { p.toast(parseError(e).message, 'error'); } };
  return (
    <div className="space-y-4">
      <Card title="Targeting">
        <div className="flex items-center justify-between mb-2"><Label>URL rules</Label>{p.canEdit && <Button size="sm" variant="secondary" onClick={() => set((d) => ({ ...d, url_rules: [...d.url_rules, { op: 'contains', value: '', action: 'hide' }] }))}><Plus className="w-3.5 h-3.5 mr-1" />Rule</Button>}</div>
        <p className="text-xs text-gray-500 mb-2">With any &quot;show&quot; rule, the widget appears only on matching pages; &quot;hide&quot; rules always win.</p>
        <div className="space-y-2">
          {draft.url_rules.map((r, i) => <div key={i} className="grid gap-2 md:grid-cols-[110px_130px_1fr_auto]"><select className={field} value={r.action} disabled={!p.canEdit} onChange={(e) => setRule(i, { action: e.target.value as 'show' | 'hide' })}><option value="show">Show on</option><option value="hide">Hide on</option></select><select className={field} value={r.op} disabled={!p.canEdit} onChange={(e) => setRule(i, { op: e.target.value as UrlRule['op'] })}><option value="contains">contains</option><option value="equals">equals</option><option value="starts_with">starts with</option><option value="regex">regex</option></select><input className={field} value={r.value} disabled={!p.canEdit} onChange={(e) => setRule(i, { value: e.target.value })} placeholder="/pricing" />{p.canEdit && <button type="button" className="text-gray-400 hover:text-red-600" aria-label="Remove rule" onClick={() => set((d) => ({ ...d, url_rules: d.url_rules.filter((_, j) => j !== i) }))}><Trash2 className="w-4 h-4" /></button>}</div>)}
        </div>
        <div className="divide-y divide-gray-100 mt-3">
          <SettingRow title="Hide on mobile" control={<Switch checked={draft.hide_mobile} onChange={(v) => set({ hide_mobile: v })} label="Hide on mobile" disabled={!p.canEdit} />} />
          <SettingRow title="Hide on desktop" control={<Switch checked={draft.hide_desktop} onChange={(v) => set({ hide_desktop: v })} label="Hide on desktop" disabled={!p.canEdit} />} />
          <SettingRow title="Show only to identified visitors" description="After setUser() — e.g. inside your app." control={<Switch checked={draft.identified_only} onChange={(v) => set({ identified_only: v })} label="Identified only" disabled={!p.canEdit} />} />
        </div>
        <Grid>
          <div><Label hint="ISO codes, comma-separated; empty = everywhere">Countries include</Label><input className={field} value={draft.countries_include.join(', ')} disabled={!p.canEdit} onChange={(e) => set({ countries_include: e.target.value.split(/[\s,]+/).map((s) => s.toUpperCase()).filter(Boolean) })} placeholder="IN, US" /></div>
          <div><Label hint="server-side: messages from these are dropped">Countries exclude</Label><input className={field} value={draft.countries_exclude.join(', ')} disabled={!p.canEdit} onChange={(e) => set({ countries_exclude: e.target.value.split(/[\s,]+/).map((s) => s.toUpperCase()).filter(Boolean) })} /></div>
        </Grid>
        <SaveBar dirty={dirty} saving={saving} canEdit={p.canEdit} onReset={reset} onSave={() => save({ settings: { targeting: draft } })} />
      </Card>
      <Card title="Proactive campaigns" actions={p.canEdit && <Button size="sm" onClick={() => setEdit({ title: '', message: '', sender_kind: 'bot', quick_replies: [], rules: { url_rules: [], time_on_page_s: 10, visitor: 'all', business_hours_only: false }, frequency: 'once', display: 'popup', enabled: true })}><Plus className="w-3.5 h-3.5 mr-1" />Campaign</Button>}>
        {camps.isLoading && <Spinner />}
        {camps.data?.length === 0 && !edit && <p className="text-sm text-gray-500">A campaign nudges visitors who match a URL after N seconds on the page, once per visitor, per session or on every visit.</p>}
        <ul className="divide-y divide-gray-100 text-sm">
          {(camps.data ?? []).map((c) => <li key={c.id} className="py-2 flex items-center gap-3"><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className="font-medium text-gray-900">{c.title}</span>{!c.enabled && <Badge tone="gray">off</Badge>}<Badge tone="gray">{c.frequency}</Badge><Badge tone="gray">{c.display}</Badge></div><div className="text-xs text-gray-500 truncate">{c.message}</div><div className="text-xs text-gray-400">{(c.rules.url_rules ?? []).map((r) => `${r.op} ${r.value}`).join(', ') || 'every page'} · after {c.rules.time_on_page_s ?? 0}s · shown {c.shown} · clicked {c.clicked} · started {c.started}</div></div>{p.canEdit && <><Button size="sm" variant="secondary" onClick={() => setEdit(c)}>Edit</Button><button type="button" className="text-gray-400 hover:text-red-600" aria-label="Delete campaign" onClick={() => delC.mutate(c.id)}><Trash2 className="w-4 h-4" /></button></>}</li>)}
        </ul>
        {edit && (
          <div className="mt-3 rounded-lg border border-indigo-200 bg-indigo-50/40 p-3 space-y-3">
            <Grid>
              <div><Label>Title (internal)</Label><input className={field} value={edit.title ?? ''} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></div>
              <div><Label>From</Label><select className={field} value={edit.sender_kind} onChange={(e) => setEdit({ ...edit, sender_kind: e.target.value as 'bot' | 'agent' })}><option value="bot">The assistant / brand</option><option value="agent">An agent</option></select></div>
              <div className="md:col-span-2"><Label hint="≤ 1000">Message</Label><textarea className={field} rows={2} value={edit.message ?? ''} onChange={(e) => setEdit({ ...edit, message: e.target.value })} /></div>
              <div className="md:col-span-2"><Label hint="comma-separated">Quick replies</Label><input className={field} value={(edit.quick_replies ?? []).join(', ')} onChange={(e) => setEdit({ ...edit, quick_replies: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} /></div>
              <div><Label hint="contains match; empty = every page">URL contains</Label><input className={field} value={edit.rules?.url_rules?.[0]?.value ?? ''} onChange={(e) => setEdit({ ...edit, rules: { ...edit.rules, url_rules: e.target.value ? [{ op: 'contains', value: e.target.value, action: 'show' }] : [] } })} placeholder="/pricing" /></div>
              <div><Label>Seconds on page</Label><input type="number" min={0} className={field} value={edit.rules?.time_on_page_s ?? 0} onChange={(e) => setEdit({ ...edit, rules: { ...edit.rules, time_on_page_s: Number(e.target.value) || 0 } })} /></div>
              <div><Label>Visitors</Label><select className={field} value={edit.rules?.visitor ?? 'all'} onChange={(e) => setEdit({ ...edit, rules: { ...edit.rules, visitor: e.target.value as 'all' | 'new' | 'returning' | 'identified' } })}><option value="all">Everyone</option><option value="new">First visit</option><option value="returning">Returning</option><option value="identified">Identified only</option></select></div>
              <div><Label>Frequency</Label><select className={field} value={edit.frequency} onChange={(e) => setEdit({ ...edit, frequency: e.target.value as 'once' | 'session' | 'every' })}><option value="once">Once per visitor</option><option value="session">Once per session</option><option value="every">Every visit</option></select></div>
              <div><Label>Display</Label><select className={field} value={edit.display} onChange={(e) => setEdit({ ...edit, display: e.target.value as 'popup' | 'open' })}><option value="popup">Preview above the launcher</option><option value="open">Open the panel</option></select></div>
              <div className="flex items-end gap-3 pb-1"><label className="text-sm flex items-center gap-2"><input type="checkbox" checked={!!edit.rules?.business_hours_only} onChange={(e) => setEdit({ ...edit, rules: { ...edit.rules, business_hours_only: e.target.checked } })} /> business hours only</label><label className="text-sm flex items-center gap-2"><input type="checkbox" checked={edit.enabled !== false} onChange={(e) => setEdit({ ...edit, enabled: e.target.checked })} /> enabled</label></div>
            </Grid>
            <div className="flex gap-2"><Button size="sm" onClick={submitC} loading={saveC.isPending} disabled={!edit.title?.trim() || !edit.message?.trim()}>Save campaign</Button><Button size="sm" variant="ghost" onClick={() => setEdit(null)}>Cancel</Button></div>
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- Security
export function SecuritySection(p: SectionProps) {
  const { draft, set, dirty, reset } = useDraft({ sec: p.inbox.settings.security, enforce: p.inbox.enforce_identity });
  const { save, saving } = useSaveSettings(p);
  const regen = useRegenerateHmac(p.ws);
  const [confirm, setConfirm] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [lang, setLang] = useState(0);
  const blocks = useQuery({ queryKey: ['outreach', 'webchat', 'inbox', p.inbox.id, 'blocks'], queryFn: async () => { const { data } = await db.from('outreach_webchat_blocks').select('*').eq('inbox_id', p.inbox.id).order('created_at', { ascending: false }); return (data ?? []) as Array<{ kind: string; value: string; note: string | null; created_at: string }>; } });
  const [blockKind, setBlockKind] = useState<'country' | 'ip_hash'>('country');
  const [blockValue, setBlockValue] = useState('');
  const addBlock = async () => { try { await rpc('webchat_block', { p_inbox: p.inbox.id, p_kind: blockKind, p_value: blockValue.trim(), p_note: null }); setBlockValue(''); blocks.refetch(); } catch (e) { p.toast(parseError(e).message, 'error'); } };
  const rmBlock = async (kind: string, value: string) => { try { await rpc('webchat_unblock', { p_inbox: p.inbox.id, p_kind: kind, p_value: value }); blocks.refetch(); } catch (e) { p.toast(parseError(e).message, 'error'); } };
  const rl = draft.sec.rate_limits;
  const setRl = (k: keyof typeof rl, v: number) => set((d) => ({ ...d, sec: { ...d.sec, rate_limits: { ...d.sec.rate_limits, [k]: v } } }));
  return (
    <div className="space-y-4">
      <Card title="Identity validation">
        <p className="text-xs text-gray-500 mb-2">Your server signs the user id with the secret below (HMAC-SHA256, hex) and passes it to <code>setUser</code> as <code>identifier_hash</code>. With enforcement on, an unsigned <code>setUser</code> is rejected and the visitor stays anonymous, so nobody can read another user&apos;s history by typing their id.</p>
        <div className="divide-y divide-gray-100"><SettingRow title="Enforce identity validation" control={<Switch checked={draft.enforce} onChange={(v) => set({ enforce: v })} label="Enforce identity validation" disabled={!p.canEdit} />} /></div>
        {p.inbox.hmac_token ? (
          <div className="space-y-2 mt-2">
            <div className="flex items-end gap-2"><div className="flex-1"><CopyField label="HMAC secret" value={reveal ? p.inbox.hmac_token : '•'.repeat(24)} secret /></div><Button size="sm" variant="secondary" onClick={() => setReveal((r) => !r)}>{reveal ? 'Hide' : 'Reveal'}</Button>{p.canEdit && <Button size="sm" variant="danger" onClick={() => setConfirm(true)}><RefreshCw className="w-3.5 h-3.5 mr-1" />Regenerate</Button>}</div>
            <div className="flex gap-1 flex-wrap">{HMAC_SAMPLES.map((s, i) => <button key={s.label} type="button" onClick={() => setLang(i)} className={cn('text-xs px-2 py-1 rounded', lang === i ? 'bg-indigo-50 text-indigo-700 font-medium' : 'bg-gray-100 text-gray-700')}>{s.label}</button>)}</div>
            <pre className="text-xs bg-gray-900 text-gray-100 rounded-lg p-3 overflow-x-auto">{HMAC_SAMPLES[lang].code(reveal ? p.inbox.hmac_token : '<HMAC_SECRET>')}</pre>
          </div>
        ) : <Note>Only owners and managers can see the secret.</Note>}
        <ConfirmModal open={confirm} onClose={() => setConfirm(false)} loading={regen.isPending} title="Regenerate the HMAC secret?" confirmLabel="Regenerate" onConfirm={async () => { try { await regen.mutateAsync(p.inbox.id); setConfirm(false); p.toast('Secret regenerated'); } catch (e) { p.toast(parseError(e).message, 'error'); } }}><p>Every hash your server computes with the old secret stops validating. Signed-in sessions keep working until their token expires. Update your server first.</p></ConfirmModal>
      </Card>
      <Card title="Abuse controls">
        <div className="grid gap-3 md:grid-cols-3">
          {([['visitor_10s', 'Per visitor / 10 s'], ['visitor_1h', 'Per visitor / hour'], ['ip_1m', 'Per IP / minute'], ['ip_1h', 'Per IP / hour'], ['inbox_1m', 'Per website / minute']] as const).map(([k, l]) => <div key={k}><Label>{l}</Label><input type="number" min={1} className={field} value={rl[k]} disabled={!p.canEdit} onChange={(e) => setRl(k, Number(e.target.value) || 1)} /></div>)}
          <div><Label hint="≤ 10">Attachment limit (MB)</Label><input type="number" min={1} max={10} className={field} value={draft.sec.attachments.max_mb} disabled={!p.canEdit} onChange={(e) => set((d) => ({ ...d, sec: { ...d.sec, attachments: { ...d.sec.attachments, max_mb: Math.min(10, Number(e.target.value) || 10) } } }))} /></div>
        </div>
        <div className="divide-y divide-gray-100 mt-2">
          <SettingRow title="Allow .zip attachments" control={<Switch checked={draft.sec.attachments.allow_zip} onChange={(v) => set((d) => ({ ...d, sec: { ...d.sec, attachments: { ...d.sec.attachments, allow_zip: v } } }))} label="Allow zip" disabled={!p.canEdit} />} />
          <SettingRow title="Cloudflare Turnstile on the first message" description="Cloudflare's mostly invisible bot check runs before a conversation starts. Leave the site key blank to use the platform's widget; if your site sets a CSP, see Content-Security-Policy above." control={<Switch checked={draft.sec.turnstile_enabled} onChange={(v) => set((d) => ({ ...d, sec: { ...d.sec, turnstile_enabled: v } }))} label="Turnstile" disabled={!p.canEdit} />} />
          {draft.sec.turnstile_enabled && <div className="py-2"><Label hint="optional">Turnstile site key</Label><input className={field} placeholder="Platform widget key" value={draft.sec.turnstile_site_key ?? ''} disabled={!p.canEdit} onChange={(e) => set((d) => ({ ...d, sec: { ...d.sec, turnstile_site_key: e.target.value || null } }))} /></div>}
          <SettingRow title="Wait for cookie consent" description="Nothing is stored until your site calls growthxai.consent(true)." control={<Switch checked={draft.sec.consent_mode} onChange={(v) => set((d) => ({ ...d, sec: { ...d.sec, consent_mode: v } }))} label="Consent mode" disabled={!p.canEdit} />} />
          <SettingRow title="Allow localhost" description="For local development and the demo page." control={<Switch checked={draft.sec.allow_localhost} onChange={(v) => set((d) => ({ ...d, sec: { ...d.sec, allow_localhost: v } }))} label="Allow localhost" disabled={!p.canEdit} />} />
        </div>
        <SaveBar dirty={dirty} saving={saving} canEdit={p.canEdit} onReset={reset} onSave={() => save({ enforce_identity: draft.enforce, settings: { security: draft.sec } })} />
      </Card>
      <Card title="Block list">
        <p className="text-xs text-gray-500 mb-2">Blocked visitors are silenced from the contact panel in the inbox. Countries and IP hashes are added here; blocked messages are dropped silently and logged.</p>
        {p.canEdit && <div className="flex gap-2 mb-2"><select className={cn(field, 'w-auto')} value={blockKind} onChange={(e) => setBlockKind(e.target.value as 'country' | 'ip_hash')}><option value="country">Country (ISO)</option><option value="ip_hash">IP hash</option></select><input className={field} value={blockValue} onChange={(e) => setBlockValue(e.target.value)} placeholder={blockKind === 'country' ? 'RU' : 'sha256 from the visitor panel'} /><Button size="sm" onClick={addBlock} disabled={!blockValue.trim()}>Block</Button></div>}
        <ul className="divide-y divide-gray-100 text-sm">{(blocks.data ?? []).map((b) => <li key={b.kind + b.value} className="py-1.5 flex items-center gap-2"><Badge tone="gray">{b.kind}</Badge><span className="font-mono text-xs truncate flex-1">{b.value}</span><span className="text-xs text-gray-400">{timeAgo(b.created_at)}</span>{p.canEdit && <button type="button" className="text-xs text-gray-500 hover:text-red-600" onClick={() => rmBlock(b.kind, b.value)}>Unblock</button>}</li>)}{blocks.data?.length === 0 && <li className="py-1.5 text-gray-500">Nothing blocked.</li>}</ul>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- Installation
export function InstallSection(p: SectionProps) {
  const [guide, setGuide] = useState('html');
  const seen = Object.entries(p.inbox.installed_origins ?? {}).sort((a, b) => (a[1] < b[1] ? 1 : -1));
  const g = INSTALL_GUIDES.find((x) => x.key === guide) ?? INSTALL_GUIDES[0];
  const apiHost = SUPABASE_URL;
  const [copied, setCopied] = useState(false);
  // "Show me the code" under Launcher & popup links here
  useEffect(() => { if (window.location.hash === '#own-button') document.getElementById('own-button')?.scrollIntoView({ block: 'start' }); }, []);
  // product pictures on the cards come from the catalogue's own image hosts: a site with a CSP has to allow them
  const recommends = (p.inbox.settings.ai.products?.catalogue_ids?.length ?? 0) > 0;
  const sample = useProductSearch(p.ws, p.inbox.id, '', recommends);
  const productHosts = recommends ? imageHosts((sample.data ?? []).map((x) => x.image)) : [];
  return (
    <div className="space-y-4">
      <Card title="Install">
        <div className="flex gap-1 flex-wrap mb-3">{INSTALL_GUIDES.map((x) => <button key={x.key} type="button" onClick={() => setGuide(x.key)} className={cn('text-xs px-2.5 py-1 rounded-full', guide === x.key ? 'bg-indigo-50 text-indigo-700 font-medium' : 'bg-gray-100 text-gray-700 hover:bg-gray-200')}>{x.label}</button>)}</div>
        <div className="relative"><pre className="text-xs bg-gray-900 text-gray-100 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap">{g.body(p.inbox.website_token)}</pre><button type="button" className="absolute top-2 right-2 text-xs bg-white/10 hover:bg-white/20 text-white rounded px-2 py-1 inline-flex items-center gap-1" onClick={async () => { try { await navigator.clipboard.writeText(snippetHtml(p.inbox.website_token)); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ } }}>{copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}{copied ? 'Copied' : 'Copy snippet'}</button></div>
        <div className="mt-3 text-sm">
          {seen.length ? <div className="text-emerald-700">Seen on {seen.slice(0, 3).map(([o, at]) => <span key={o} className="mr-2"><b>{o.replace(/^https?:\/\//, '')}</b> {timeAgo(at)}</span>)}</div> : <div className="text-amber-700">Not seen on any site yet. Reload a page with the snippet installed and this updates within a minute.</div>}
        </div>
      </Card>
      <div id="own-button" className="scroll-mt-4">
        <Card title="Use your own button">
          <p className="text-xs text-gray-500 mb-3">Any element of your site can open the chat: add an attribute, no JavaScript needed. Buttons added later by your site (single-page apps, popups, carts) work too. To have nothing but your own buttons, choose <Link href={`${WEBSITES_PATH}/${p.inbox.id}?tab=design#launcher`} className="text-indigo-700 hover:underline">My own buttons</Link> under Launcher &amp; popup on the Design tab.</p>
          <div className="space-y-2">
            {OWN_BUTTON_SNIPPETS.map((s) => (
              <div key={s.key}>
                <div className="mb-1 flex items-center justify-between gap-2"><span className="text-xs font-medium text-gray-700">{s.label}</span><CopyButton value={s.code} /></div>
                <pre className="text-xs bg-gray-900 text-gray-100 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap">{s.code}</pre>
              </div>
            ))}
          </div>
          <table className="mt-4 w-full text-xs">
            <thead><tr className="text-left text-gray-500"><th className="py-1 pr-3 font-medium">Attribute</th><th className="py-1 font-medium">What a click does</th></tr></thead>
            <tbody className="divide-y divide-gray-100">{OWN_BUTTON_ATTRIBUTES.map(([a, d]) => <tr key={a}><td className="py-1.5 pr-3 align-top whitespace-nowrap"><code>{a}</code></td><td className="py-1.5 text-gray-600">{d}</td></tr>)}</tbody>
          </table>
          <ul className="mt-3 list-disc pl-5 text-xs text-gray-500 space-y-1">
            <li><b>Webflow / Framer:</b> add the attribute under the element&rsquo;s Custom attributes (name <code>data-growthxai</code>, value <code>open</code>).</li>
            <li>While the chat is open, <code>&lt;html&gt;</code> has the class <code>growthxai-open</code>, and every <code>open</code> / <code>toggle</code> element has <code>aria-expanded=&quot;true&quot;</code>, so you can style both states.</li>
            <li>If your own click handler calls <code>preventDefault()</code>, yours wins and the chat stays closed.</li>
            <li>A <code>?gx_q=</code> link only fills the message box. It never sends a message for the visitor.</li>
          </ul>
        </Card>
      </div>
      <Card title="Standalone page">
        <p className="text-xs text-gray-500 mb-2">A hosted full-page chat for link-in-bio, email signatures and the &quot;continue the chat&quot; link in continuity emails.</p>
        <CopyField value={standaloneUrl(p.inbox.website_token)} />
        <p className="text-xs text-gray-500 mt-2">Test locally with the demo page: <code>/widget/v1/demo.html?token={p.inbox.website_token}&amp;api={encodeURIComponent(`${apiHost}/functions/v1/outreach-webchat`)}</code> (allow localhost under Security first).</p>
      </Card>
      <Card title="Content-Security-Policy">
        <p className="text-xs text-gray-500 mb-2">If your site sets a CSP, allow:</p>
        <pre className="text-xs bg-gray-50 border border-gray-200 rounded-lg p-3 overflow-x-auto">{CSP_NOTES(apiHost, typeof window === 'undefined' ? '' : window.location.origin, !!p.inbox.settings?.security?.turnstile_enabled, !!(p.inbox.settings?.launcher?.video?.enabled !== false && p.inbox.settings?.launcher?.video?.url), productHosts, !!p.inbox.settings?.voice?.enabled, /^preset:/i.test(p.inbox.settings?.appearance?.bot_avatar_url ?? '')).join('\n')}</pre>
      </Card>
      <Card title="SDK">
        <p className="text-xs text-gray-500">Global <code>window.growthxai</code> (alias <code>window.kaptured</code>), ready event <code>growthxai:ready</code>.</p>
        <pre className="text-xs bg-gray-50 border border-gray-200 rounded-lg p-3 overflow-x-auto mt-2">{`growthxai.open({ mode }) / close() / toggle()   growthxai.setMode('drawer')
growthxai.ask('Do you ship to Dubai?', { context, mode, prefill, label })
growthxai.call()                                (a voice call with the assistant, when Voice is on)
growthxai.send('Hi!')                           growthxai.setUser('u-42', { email, name, identifier_hash })
growthxai.setCustomAttributes({ plan: 'pro' })  growthxai.setLabel('pricing-page')
growthxai.setLocale('es')                       growthxai.setColorScheme('dark')
growthxai.trackEvent('signup_clicked', {...})   growthxai.reset() / destroy()
growthxai.on('message', cb)   events: ready, opened, closed, message, message:sent, conversation:started,
                                      conversation:resolved, unread, csat:submitted, identified, handoff, error,
                                      trigger { kind, text? }  (fired before the chat opens: button, ask, input, link,
                                      header_button, element_button, selection, shortcut),
                                      product:shown { ids }, product:clicked { id, action }, product:added_to_cart { id, variant_id },
                                      video:opened, video:closed, video:question, video:dismissed,
                                      voice:started { call_id }, voice:ended { call_id, duration_s, reason },
                                      voice:switched { handoff }, voice:error { code }`}</pre>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- Canned responses
export function CannedSection(p: SectionProps) {
  const q = useCannedResponses(p.ws);
  const save = useSaveCanned(p.ws);
  const del = useDeleteCanned(p.ws);
  const [edit, setEdit] = useState<{ id: string | null; short_code: string; content: string; personal: boolean } | null>(null);
  const submit = async () => { if (!edit) return; try { await save.mutateAsync(edit); setEdit(null); p.toast('Saved'); } catch (e) { p.toast(parseError(e).message, 'error'); } };
  return (
    <Card title="Canned responses" actions={<Button size="sm" onClick={() => setEdit({ id: null, short_code: '', content: '', personal: false })}><Plus className="w-3.5 h-3.5 mr-1" />New</Button>}>
      <p className="text-xs text-gray-500 mb-2">Type <code>/shortcut</code> in the reply box and it expands on send. Variables: <code>{'{{contact.name}}'}</code>, <code>{'{{contact.first_name}}'}</code>, <code>{'{{agent.name}}'}</code>. Shared responses are for the whole workspace; personal ones only for you.</p>
      {q.isLoading && <Spinner />}
      <ul className="divide-y divide-gray-100 text-sm">
        {(q.data ?? []).map((c) => <li key={c.id} className="py-2 flex items-start gap-3"><span className="font-mono text-indigo-700 w-28 flex-shrink-0">/{c.short_code}</span><span className="flex-1 min-w-0 text-gray-700 whitespace-pre-wrap">{c.content}</span>{c.owner_id && <Badge tone="gray">personal</Badge>}<Button size="sm" variant="ghost" onClick={() => setEdit({ id: c.id, short_code: c.short_code, content: c.content, personal: !!c.owner_id })}>Edit</Button><button type="button" className="text-gray-400 hover:text-red-600" aria-label="Delete" onClick={() => del.mutate(c.id)}><Trash2 className="w-4 h-4" /></button></li>)}
        {q.data?.length === 0 && !edit && <li className="py-2 text-gray-500">None yet.</li>}
      </ul>
      {edit && (
        <div className="mt-3 rounded-lg border border-indigo-200 bg-indigo-50/40 p-3 space-y-2">
          <Grid><div><Label hint="letters, digits, - and _">Shortcut</Label><input className={field} value={edit.short_code} onChange={(e) => setEdit({ ...edit, short_code: e.target.value })} placeholder="hi" /></div><label className="text-sm flex items-end gap-2 pb-2"><input type="checkbox" checked={edit.personal} onChange={(e) => setEdit({ ...edit, personal: e.target.checked })} /> personal (only me)</label></Grid>
          <div><Label>Content</Label><textarea className={field} rows={3} value={edit.content} onChange={(e) => setEdit({ ...edit, content: e.target.value })} placeholder="Hi {{contact.first_name}}, {{agent.name}} here — happy to help." /></div>
          <div className="flex gap-2"><Button size="sm" onClick={submit} loading={save.isPending} disabled={!edit.short_code.trim() || !edit.content.trim()}>Save</Button><Button size="sm" variant="ghost" onClick={() => setEdit(null)}>Cancel</Button></div>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- Reports + history
function iso(d: Date) { return d.toISOString().slice(0, 10); }
function rangeFor(days: number) { const now = Date.now(); return { days, to: iso(new Date(now)), from: iso(new Date(now - (days - 1) * 86400000)) }; }
const S = ({ l, v, h }: { l: string; v: React.ReactNode; h?: string }) => <div className="rounded-lg border border-gray-200 p-3"><div className="text-xl font-semibold text-gray-900 tabular-nums">{v}</div><div className="text-xs text-gray-500">{l}</div>{h && <div className="text-[11px] text-gray-400">{h}</div>}</div>;
export function ReportsSection(p: SectionProps) {
  const [range, setRange] = useState(() => rangeFor(30));
  const r = useWebchatReport(p.ws, p.inbox.id, range.from, range.to);
  const d = r.data;
  return (
    <Card title="Reports" actions={<select className={cn(field, 'w-auto')} value={range.days} onChange={(e) => setRange(rangeFor(Number(e.target.value)))}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option></select>}>
      {r.isLoading && <Spinner />}
      {d && (
        <div className="space-y-4">
          <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
            <S l="Conversations" v={d.conversations} h={Object.entries(d.by_source).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${SOURCE_LABELS[k] ?? k} ${v}`).join(' · ')} />
            <S l="Resolved" v={d.resolved} h={`${d.ai_resolved} by the assistant alone`} />
            <S l="First response (median / p90)" v={`${fmtSeconds(d.first_response_median_s)} / ${fmtSeconds(d.first_response_p90_s)}`} />
            <S l="Resolution time (median)" v={fmtSeconds(d.resolution_median_s)} />
            <S l="CSAT" v={d.csat.avg != null ? `${d.csat.avg} / 5` : '—'} h={`${d.csat.responses} responses`} />
            <S l="AI answers" v={d.ai_turns} h={`👍 ${d.ai_feedback.up} · 👎 ${d.ai_feedback.down} · ${d.handoffs} handoffs`} />
            <S l="Visitors → leads" v={d.visitor_to_lead} h={`${d.sequences_stopped} sequences stopped by a chat`} />
            <S l="Continuity emails" v={d.continuity.sent} h={d.continuity.failed ? `${d.continuity.failed} failed` : undefined} />
          </div>
          {Object.keys(d.by_source).length > 1 && (
            <div><Label hint="how the conversation was opened">Conversations by source</Label>
              <ul className="text-sm grid gap-x-6 sm:grid-cols-2">{Object.entries(d.by_source).sort((a, b) => b[1] - a[1]).map(([k, v]) => <li key={k} className="py-0.5 flex justify-between gap-3"><span className="truncate">{SOURCE_LABELS[k] ?? k}</span><span className="text-gray-500 tabular-nums">{v}</span></li>)}</ul>
            </div>
          )}
          {d.products && (d.products.answers_with_products > 0 || d.products.cards_shown > 0 || d.products.not_found.length > 0) && <ProductsReportBlock r={d.products} />}
          {d.voice && (d.voice.calls > 0 || !!p.inbox.settings.voice?.enabled) && <VoiceReportBlock r={d.voice} />}
          {d.csat_by_agent.length > 0 && <div><Label>CSAT by agent</Label><ul className="text-sm">{d.csat_by_agent.map((a) => <li key={a.user_id}>{a.name}: {a.avg} / 5 ({a.n})</li>)}</ul></div>}
          {d.top_unanswered.length > 0 && <div><Label hint="candidates for new FAQ entries">Top unanswered questions</Label><ul className="text-sm divide-y divide-gray-100">{d.top_unanswered.map((u) => <li key={u.query} className="py-1 flex justify-between gap-3"><span className="truncate">{u.query}</span><span className="text-gray-400">{u.n}</span></li>)}</ul></div>}
          {d.by_day.length > 0 && <div><Label>Conversations per day</Label><div className="flex items-end gap-0.5 h-16">{d.by_day.map((x) => { const max = Math.max(...d.by_day.map((y) => y.n)); return <div key={x.day} title={`${x.day}: ${x.n}`} className="flex-1 bg-indigo-500/80 rounded-sm" style={{ height: `${Math.max(4, (x.n / max) * 100)}%` }} />; })}</div></div>}
        </div>
      )}
    </Card>
  );
}

/** Reports → Voice (069): calls, how they ended, what was asked, what it cost. */
function VoiceReportBlock({ r }: { r: VoiceReport }) {
  const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—');
  const rows = (o: Record<string, number>, label: (k: string) => string) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => <li key={k} className="py-0.5 flex justify-between gap-3"><span className="truncate">{label(k)}</span><span className="text-gray-500 tabular-nums">{v} · {pct(v, r.calls)}</span></li>);
  return (
    <div className="rounded-lg border border-gray-200 p-3 space-y-3">
      <div className="text-sm font-medium text-gray-900">Voice</div>
      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
        <S l="Calls" v={r.calls} h={r.per_100_visitors != null ? `${r.per_100_visitors} per 100 visitors` : undefined} />
        <S l="Minutes" v={r.minutes} h={r.avg_seconds != null ? `average ${fmtCallLength(r.avg_seconds)}` : undefined} />
        <S l="Resolved" v={pct(r.resolved, r.judged)} h={`${r.judged} calls judged after the call`} />
        <S l="Phone numbers collected" v={r.with_phone} h={`${r.with_name} names · ${r.leads} leads`} />
      </div>
      <div className="text-xs text-gray-600">This month: {r.pool.used}{r.pool.limit != null ? ` of ${r.pool.limit}` : ''} minutes{r.pool.test_used ? ` (${r.pool.test_used} in tests)` : ''}{r.cost_usd != null ? ` · $${Number(r.cost_usd).toFixed(2)} billed to your own voice account in this period` : ''}.</div>
      {r.calls > 0 && (
        <div className="grid gap-4 md:grid-cols-3">
          <div><Label>How calls ended</Label><ul className="text-sm">{rows(r.ended_by, (k) => ENDED_BY[k] ?? k)}</ul></div>
          <div><Label hint={`${pct(r.switched, r.calls)} went on in chat`}>Handed to the team</Label><ul className="text-sm">{Object.keys(r.handoff_reasons).length ? rows(r.handoff_reasons, (k) => k.replace(/_/g, ' ')) : <li className="text-gray-500">None</li>}</ul></div>
          <div><Label>Languages</Label><ul className="text-sm">{rows(r.languages, (k) => voiceLanguage(k))}</ul></div>
        </div>
      )}
      {(r.top_questions.length > 0 || r.unanswered.length > 0) && (
        <div className="grid gap-4 md:grid-cols-2">
          {r.top_questions.length > 0 && <div><Label>Asked by voice</Label><ul className="text-sm divide-y divide-gray-100">{r.top_questions.slice(0, 8).map((x) => <li key={x.query} className="py-1 flex justify-between gap-3"><span className="truncate">{x.query}</span><span className="text-gray-400">{x.n}</span></li>)}</ul></div>}
          {r.unanswered.length > 0 && <div><Label hint="add a Q&A or a source for these">Not answered by voice</Label><ul className="text-sm divide-y divide-gray-100">{r.unanswered.slice(0, 8).map((x) => <li key={x.query} className="py-1 flex justify-between gap-3"><span className="truncate">{x.query}</span><span className="text-gray-400">{x.n}</span></li>)}</ul></div>}
        </div>
      )}
    </div>
  );
}

function ProductsReportList({ title, rows }: { title: string; rows: ProductsReportRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="min-w-0"><Label>{title}</Label>
      <ul className="text-sm divide-y divide-gray-100">{rows.slice(0, 5).map((x) => (
        <li key={x.id} className="py-1.5 flex items-center gap-2">
          <ProductImage src={x.image} title={x.title} className="h-8 w-8 flex-shrink-0 rounded text-xs" />
          <a href={x.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate hover:text-indigo-700 hover:underline" title={x.title}>{x.title}</a>
          {x.removed && <Badge tone="gray">no longer sold</Badge>}
          <span className="text-gray-500 tabular-nums">{x.n}</span>
        </li>))}</ul>
    </div>
  );
}
/** Reports → Products: what the assistant recommended, what visitors did with it, and what they asked for that was not found. */
function ProductsReportBlock({ r }: { r: ProductsReport }) {
  const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—');
  return (
    <div className="rounded-lg border border-gray-200 p-3 space-y-3">
      <div className="text-sm font-medium text-gray-900">Products</div>
      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
        <S l="Answers with products" v={r.answers_with_products} h={`${pct(r.answers_with_products, r.answers)} of AI answers`} />
        <S l="Cards shown" v={r.cards_shown} />
        <S l="Clicks" v={r.clicks} h={`${pct(r.clicks, r.cards_shown)} click rate`} />
        <S l="Add-to-carts" v={r.add_to_carts} />
      </div>
      <div className="grid gap-4 md:grid-cols-2"><ProductsReportList title="Top recommended" rows={r.top_recommended} /><ProductsReportList title="Top clicked" rows={r.top_clicked} /></div>
      {r.not_found.length > 0 && (
        <div><Label hint="add the product, or a Q&A that says what you offer instead">Asked for, not found</Label>
          <ul className="text-sm divide-y divide-gray-100">{r.not_found.slice(0, 10).map((x, i) => (
            <li key={i} className="py-1 flex items-center justify-between gap-3"><span className="truncate" title={x.query}>{x.query}</span>
              <span className="flex flex-shrink-0 items-center gap-3 text-xs text-gray-400">{timeAgo(x.at)}{x.chat_id && <Link href={`/outreach/inbox/${x.chat_id}`} className="text-indigo-700 hover:underline">Open chat</Link>}</span>
            </li>))}</ul>
        </div>
      )}
    </div>
  );
}

export function HistorySection(p: SectionProps) {
  const h = useSettingsHistory(p.inbox.id);
  const restore = useRestoreSettings(p.ws);
  return (
    <Card title="Settings history">
      <p className="text-xs text-gray-500 mb-2">Every save is a version (current: v{p.inbox.config_version}). Restoring creates a new version.</p>
      {h.isLoading && <Spinner />}
      <ul className="divide-y divide-gray-100 text-sm">
        {(h.data ?? []).map((v) => <li key={v.version} className="py-2 flex items-center gap-3"><span className="font-mono text-xs w-10">v{v.version}</span><span className="flex-1 min-w-0 truncate text-gray-600">{Object.keys(v.diff ?? {}).join(', ') || '—'}</span><span className="text-xs text-gray-400">{v.by ?? 'system'} · {fmtDate(v.at)}</span>{p.canEdit && v.version !== p.inbox.config_version && <Button size="sm" variant="secondary" loading={restore.isPending} onClick={() => restore.mutate({ id: p.inbox.id, version: v.version }, { onSuccess: () => p.toast(`Restored v${v.version}`), onError: (e) => p.toast(parseError(e).message, 'error') })}>Restore</Button>}</li>)}
      </ul>
    </Card>
  );
}
