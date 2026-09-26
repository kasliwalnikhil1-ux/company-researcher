'use client';

// Profile Studio: the sender's Profile tab (PRD §8.1). Side-by-side editor + live preview; per field the current value,
// the proposed value, the character count, the owner's permission and the changes left this period. Nothing here
// auto-saves to LinkedIn: a draft becomes a change only on Submit, and the database decides whether it is queued
// (direct permission) or sent to the owner (proposals).
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bot, ChevronDown, ChevronRight, Lock, RefreshCw, Save, Send, Sparkles, XCircle } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { callFn, parseError, rpc } from '@/lib/outreach/api';
import { reasonText } from '@/lib/outreach/reasons';
import { Badge, Button, Card, Input, Modal, Select, Spinner, Textarea, Toggle, fmtDate, timeAgo } from '@/components/outreach/ui';
import type { Sender } from '@/lib/outreach/types';
import { CUSTOM_LINK_TYPES, FIELD_GROUPS, GROUP_HELP, GROUP_LABELS, LIMITS, PRESENCES, SOURCE_LABELS, STATUS_LABELS, STATUS_TONE, causeText, fieldGroupsOf, profileKeysFor, useProfileOverview, type FieldGroup, type GroupStatus, type PendingChange, type ProfileAssets, type ProfilePayload, type Validation } from '@/lib/outreach/profile';
import { cn } from '@/lib/utils';
import ProfilePreview from './ProfilePreview';
import PhotoEditor from './PhotoEditor';
import QaCard from './QaCard';
import AuthorityCard from './AuthorityCard';
import HistoryList from './HistoryList';

type Notify = (message: string, type?: 'success' | 'error') => void;
interface Draft { payload: ProfilePayload; assets: ProfileAssets; note: string; changeId: string | null }
const EMPTY: Draft = { payload: {}, assets: {}, note: '', changeId: null };

function GroupHeader({ g, st, open, onToggle, touched, needAuth }: { g: FieldGroup; st: GroupStatus | undefined; open: boolean; onToggle: () => void; touched: boolean; needAuth: boolean }) {
  const a = st?.authority; const c = st?.ceiling;
  return (
    <button type="button" onClick={onToggle} className="w-full flex items-center gap-2 text-left py-2" aria-expanded={open}>
      {open ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
      <span className="font-medium text-gray-900 text-sm">{GROUP_LABELS[g]}</span>
      {touched && <Badge tone="indigo">edited</Badge>}
      <span className="ml-auto flex items-center gap-1.5 flex-wrap justify-end">
        {st?.locked_by && <Badge tone="purple"><Lock className="w-3 h-3 inline mr-0.5" />Experiment</Badge>}
        {needAuth && (a ? <Badge tone={a.mode === 'direct' ? 'green' : 'amber'}>{a.mode === 'direct' ? 'Direct' : 'Proposals'}</Badge> : <Badge tone="red">No permission</Badge>)}
        {c && c.max != null && <span className={cn('text-[11px]', c.remaining === 0 ? 'text-amber-700' : 'text-gray-500')} title={`${c.max} change(s) per ${c.window_days} days`}>{c.remaining === 0 && c.next_at ? `next ${fmtDate(c.next_at, false)}` : `${c.remaining} of ${c.max} left`}</span>}
      </span>
    </button>
  );
}

export default function ProfileStudio({ sender, isManager, canWrite, notify }: { sender: Sender; isManager: boolean; canWrite: boolean; notify: Notify }) {
  const qc = useQueryClient();
  const { workspace } = useWorkspace();
  const ws = workspace?.id ?? sender.workspace_id;
  const ov = useProfileOverview(sender.id);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [open, setOpen] = useState<Record<FieldGroup, boolean>>({ headline: true, about: true, photo: false, cover: false, location: false, experience: false, education: false, skills: false, custom_link: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [previewPhoto, setPreviewPhoto] = useState<string | null>(null);
  const [previewCover, setPreviewCover] = useState<string | null>(null);
  const [ai, setAi] = useState<{ group: 'headline' | 'about'; brief: string } | null>(null);
  const [skillsText, setSkillsText] = useState<string | null>(null);
  const invalidate = () => { for (const k of profileKeysFor(sender.id, ws)) qc.invalidateQueries({ queryKey: k }); };

  const d = ov.data;
  const doc = d?.snapshot?.data ?? null;
  const groupStatus = useMemo(() => new Map((d?.status.groups ?? []).map((g) => [g.group, g])), [d]);
  const touched = fieldGroupsOf(draft.payload, draft.assets);
  const p = draft.payload;
  const setP = (patch: Partial<ProfilePayload>) => setDraft((x) => { const next = { ...x.payload, ...patch }; for (const k of Object.keys(next) as Array<keyof ProfilePayload>) if (next[k] === undefined) delete next[k]; return { ...x, payload: next }; });
  const setA = (patch: Partial<ProfileAssets>) => setDraft((x) => { const next = { ...x.assets, ...patch }; for (const k of Object.keys(next) as Array<keyof ProfileAssets>) if (!next[k]) delete next[k]; return { ...x, assets: next }; });

  const blockers = d?.status.blockers ?? [];
  const cannot = blockers.length > 0;
  const needAuth = d?.status.permission_required === true;
  const mode = useMemo(() => { if (!needAuth) return 'direct'; const m = touched.map((g) => groupStatus.get(g)?.authority?.mode); return m.every((x) => x === 'direct') ? 'direct' : 'propose_only'; }, [touched, groupStatus, needAuth]);
  const missingAuthority = needAuth ? touched.filter((g) => !groupStatus.get(g)?.authority) : [];

  async function refreshSnapshot() {
    setBusy('snapshot');
    try { await callFn('profile', { action: 'snapshot', sender_id: sender.id }); notify('Profile read and scored. One profile view was used.'); invalidate(); }
    catch (e) { notify(parseError(e).message, 'error'); } finally { setBusy(null); }
  }
  async function saveDraft(): Promise<string | null> {
    if (!touched.length) { notify('Nothing to save yet.', 'error'); return null; }
    setBusy('save');
    try {
      const r = draft.changeId
        ? await rpc<{ id: string; validation: Validation }>('profile_update_draft', { p_change: draft.changeId, p_payload: p, p_assets: draft.assets, p_note: draft.note || null })
        : await rpc<{ id: string; validation: Validation }>('profile_draft_change', { p_sender: sender.id, p_payload: p, p_assets: draft.assets, p_source: 'manual', p_template: null, p_experiment: null, p_note: draft.note || null });
      setDraft((x) => ({ ...x, changeId: r.id })); setValidation(r.validation); invalidate();
      return r.id;
    } catch (e) { notify(parseError(e).message, 'error'); return null; } finally { setBusy(null); }
  }
  async function submit() {
    const id = draft.changeId ?? (await saveDraft());
    if (!id) return;
    setBusy('submit');
    try {
      const r = await callFn<{ status: string; scheduled_for?: string; approval?: { email_sent: boolean; link?: string; recipients: string[] } }>('profile', { action: 'submit', change_id: id });
      if (r.status === 'queued') notify(`Scheduled for ${fmtDate(r.scheduled_for)} in the sender's working hours. The owner is emailed after it lands.`);
      else if (r.status === 'awaiting_owner') notify(r.approval?.email_sent ? `Sent to the owner (${r.approval.recipients.join(', ')}) for their approval.` : r.approval?.link ? 'Proposal saved. Email is not set up here: copy the approval link from the pending list and give it to the owner.' : 'Proposal saved, but the owner could not be emailed. Add an owner email to the sender.', r.approval?.email_sent ? 'success' : 'error');
      setDraft(EMPTY); setValidation(null); setSkillsText(null); setPreviewPhoto(null); setPreviewCover(null); invalidate();
    } catch (e) { notify(parseError(e).message, 'error'); } finally { setBusy(null); }
  }
  async function cancelChange(c: PendingChange) {
    try { await rpc('profile_cancel_change', { p_change: c.id, p_reason: 'cancelled in the editor' }); notify('Change cancelled.'); if (draft.changeId === c.id) setDraft(EMPTY); invalidate(); } catch (e) { notify(parseError(e).message, 'error'); }
  }
  function loadDraft(c: PendingChange) {
    setDraft({ payload: c.payload, assets: c.assets ?? {}, note: c.note ?? '', changeId: c.id }); setSkillsText(c.payload.skills?.join(', ') ?? null);
    const groups = fieldGroupsOf(c.payload, c.assets ?? {});
    setOpen((o) => ({ ...o, ...Object.fromEntries(groups.map((g) => [g, true])) }));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  async function aiDraft() {
    if (!ai) return;
    setBusy('ai');
    try {
      const r = await callFn<{ change_id: string; text: string }>('profile', { action: 'ai_draft', sender_id: sender.id, field_group: ai.group, brief: ai.brief });
      setDraft({ payload: ai.group === 'headline' ? { headline: r.text } : { summary: r.text }, assets: {}, note: `AI draft${ai.brief ? `: ${ai.brief.slice(0, 120)}` : ''}`, changeId: r.change_id });
      setOpen((o) => ({ ...o, [ai.group]: true })); setAi(null);
      notify('Draft written. Edit it here; it is never applied on its own.'); invalidate();
    } catch (e) { notify(parseError(e).message, 'error'); } finally { setBusy(null); }
  }

  if (sender.provider !== 'LINKEDIN') return <Card><div className="text-sm text-gray-600">Profile Studio is for LinkedIn accounts. Mailboxes have nothing to edit here.</div></Card>;
  if (ov.isLoading) return <Spinner className="min-h-[30vh]" />;
  if (ov.isError) return <Card><div className="text-sm text-red-700">{(ov.error as Error).message}</div></Card>;
  if (!d) return null;

  const readOnly = !canWrite;
  const expEntries = doc?.experience ?? [];
  const eduEntries = doc?.education ?? [];
  const expHasIds = expEntries.some((e) => e.id);
  const exp = p.experience; const edu = p.education;

  return (
    <div className="space-y-6">
      {/* status strip */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="text-sm text-gray-600">{d.snapshot ? <>Profile last read <b>{timeAgo(d.snapshot.captured_at)}</b>{d.snapshot.fidelity !== 'full' ? ' (partial)' : ''}</> : 'The profile has not been read yet.'}</div>
        {canWrite && <Button size="sm" variant="secondary" onClick={refreshSnapshot} loading={busy === 'snapshot'} disabled={!!busy || sender.status !== 'ok'} title="Read the profile from LinkedIn (uses one profile view) and rescore it"><RefreshCw className="w-3.5 h-3.5" /> Refresh snapshot</Button>}
        {d.experiment && <Badge tone="purple"><Lock className="w-3 h-3 inline mr-1" />In experiment “{d.experiment.name}” ({GROUP_LABELS[d.experiment.field_group]})</Badge>}
        <span className="text-xs text-gray-500 ml-auto">Profile edits this week: {d.status.combined.week.used} of {d.status.combined.week.max} · today&apos;s allowance {d.status.daily_allowance}</span>
      </div>
      {cannot && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">
          <div className="font-medium text-amber-900 flex items-center gap-2"><AlertTriangle className="w-4 h-4" /> This profile cannot be changed right now</div>
          <ul className="mt-2 space-y-1 text-amber-900">{blockers.map((b, i) => <li key={i}><b>{b.detail}.</b> {b.remedy}</li>)}</ul>
          <div className="text-xs text-amber-800 mt-2">You can still prepare drafts; they wait until the account is eligible.</div>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-5 gap-6">
        {/* editor */}
        <div className="xl:col-span-3 space-y-4">
          <Card title="Editor" actions={canWrite ? <div className="flex gap-1.5"><Button size="sm" variant="secondary" onClick={() => setAi({ group: 'headline', brief: '' })} disabled={!!busy}><Sparkles className="w-3.5 h-3.5" /> AI headline</Button><Button size="sm" variant="secondary" onClick={() => setAi({ group: 'about', brief: '' })} disabled={!!busy}><Sparkles className="w-3.5 h-3.5" /> AI About</Button></div> : undefined}>
            <div className="divide-y divide-gray-100">
              {FIELD_GROUPS.map((g) => {
                const st = groupStatus.get(g);
                const isOpen = open[g];
                const locked = !!st?.locked_by;
                const dis = readOnly || locked;
                return (
                  <div key={g}>
                    <GroupHeader g={g} st={st} open={isOpen} onToggle={() => setOpen((o) => ({ ...o, [g]: !o[g] }))} touched={touched.includes(g)} needAuth={needAuth} />
                    {isOpen && (
                      <div className="pb-4 pl-6 space-y-3">
                        <p className="text-xs text-gray-500">{GROUP_HELP[g]}{locked ? ` Locked by the experiment “${st?.locked_by?.name}”.` : ''}</p>
                        {g === 'headline' && (<>
                          <div className="text-xs text-gray-500">Current: <span className="text-gray-800">{doc?.headline ?? '—'}</span></div>
                          <Textarea label="Proposed headline" value={p.headline ?? ''} disabled={dis} counter={{ max: LIMITS.headline, value: (p.headline ?? '').length }} onChange={(e) => setP({ headline: e.target.value === '' ? undefined : e.target.value })} className="min-h-[60px]" placeholder={doc?.headline ?? 'Who you help and how'} />
                          {(p.headline ?? '').length > 120 && <div className="text-[11px] text-amber-700">Over 120 characters: cut in search results. Keep the point in the first 70 for mobile.</div>}
                        </>)}
                        {g === 'about' && (<>
                          <div className="text-xs text-gray-500">Current: <span className="text-gray-800 whitespace-pre-line line-clamp-3">{doc?.summary ?? (d.snapshot?.sections.includes('about') ? '(empty)' : 'not read yet')}</span></div>
                          <Textarea label="Proposed About" value={p.summary ?? ''} disabled={dis} counter={{ max: LIMITS.summary, value: (p.summary ?? '').length }} onChange={(e) => setP({ summary: e.target.value === '' ? undefined : e.target.value })} className="min-h-[180px]" placeholder={doc?.summary ?? 'Three short paragraphs: who you help, how, proof.'} />
                        </>)}
                        {g === 'photo' && <PhotoEditor kind="photo" ws={ws} senderId={sender.id} currentUrl={doc?.picture_url ?? sender.picture_url} assetPath={draft.assets.picture} settings={p.picture_settings} onAsset={(path) => setA({ picture: path })} onSettings={(s) => setP({ picture_settings: s })} onPreviewUrl={setPreviewPhoto} disabled={dis} notify={notify} />}
                        {g === 'cover' && <PhotoEditor kind="cover" ws={ws} senderId={sender.id} currentUrl={doc?.cover_url ?? null} assetPath={draft.assets.cover_picture} settings={p.cover_picture_settings} onAsset={(path) => setA({ cover_picture: path })} onSettings={(s) => setP({ cover_picture_settings: s })} onPreviewUrl={setPreviewCover} disabled={dis} notify={notify} />}
                        {g === 'location' && (<>
                          <div className="text-xs text-gray-500">Current: <span className="text-gray-800">{doc?.location ?? '—'}</span></div>
                          <div className="grid grid-cols-2 gap-3">
                            <Input label="Postal code" value={p.location?.postal_code ?? ''} disabled={dis} onChange={(e) => { const v = e.target.value; const loc = { ...(p.location ?? {}), postal_code: v || undefined }; if (!loc.postal_code) delete loc.postal_code; setP({ location: Object.keys(loc).length ? loc : undefined }); }} />
                            <Input label="LinkedIn location id (optional)" value={p.location?.id ?? ''} disabled={dis} onChange={(e) => { const v = e.target.value; const loc = { ...(p.location ?? {}), id: v || undefined }; if (!loc.id) delete loc.id; setP({ location: Object.keys(loc).length ? loc : undefined }); }} hint="A numeric geo id. The postal code alone is usually enough." />
                          </div>
                        </>)}
                        {g === 'experience' && (<>
                          <Select label="Which position" value={exp ? (exp.id ?? '__new') : ''} disabled={dis} onChange={(e) => { const v = e.target.value; if (!v) setP({ experience: undefined }); else if (v === '__new') setP({ experience: { role: '', company: '' } }); else { const en = expEntries.find((x) => x.id === v); setP({ experience: { id: v, description: en?.description ?? '' } }); } }}>
                            <option value="">— none —</option>
                            {expEntries.filter((e) => e.id).map((e) => <option key={e.id!} value={e.id!}>{e.title} · {e.company}{e.current ? ' (current)' : ''}</option>)}
                            <option value="__new">+ Add a position</option>
                          </Select>
                          {!expHasIds && expEntries.length > 0 && <div className="text-xs text-amber-700">LinkedIn did not report ids for the existing positions, so they cannot be edited from here. You can add a position.</div>}
                          {exp && !exp.id && (
                            <div className="grid grid-cols-2 gap-3">
                              <Input label="Role" value={exp.role ?? ''} disabled={dis} maxLength={LIMITS.role} onChange={(e) => setP({ experience: { ...exp, role: e.target.value } })} />
                              <Input label="Company" value={exp.company ?? ''} disabled={dis} maxLength={LIMITS.company} onChange={(e) => setP({ experience: { ...exp, company: e.target.value } })} />
                              <Input label="Location" value={exp.location ?? ''} disabled={dis} onChange={(e) => setP({ experience: { ...exp, location: e.target.value || undefined } })} />
                              <Select label="Presence" value={exp.presence ?? ''} disabled={dis} onChange={(e) => setP({ experience: { ...exp, presence: (e.target.value || undefined) as typeof exp.presence } })}><option value="">—</option>{PRESENCES.map((x) => <option key={x} value={x}>{x.replace('_', ' ').toLowerCase()}</option>)}</Select>
                              <Input label="Start (YYYY-MM)" value={exp.start_date ? `${exp.start_date.year}-${String(exp.start_date.month ?? 1).padStart(2, '0')}` : ''} disabled={dis} placeholder="2024-03" onChange={(e) => { const m = /^(\d{4})-(\d{1,2})$/.exec(e.target.value); setP({ experience: { ...exp, start_date: m ? { year: Number(m[1]), month: Number(m[2]) } : undefined } }); }} />
                              <div className="col-span-2 text-xs text-amber-700">Adding a position records it on a real person&apos;s work history. Do it only with that person&apos;s confirmation. It cannot be removed through the platform.</div>
                            </div>
                          )}
                          {exp && <Textarea label="Description" value={exp.description ?? ''} disabled={dis} counter={{ max: LIMITS.experience_description, value: (exp.description ?? '').length }} onChange={(e) => setP({ experience: { ...exp, description: e.target.value } })} className="min-h-[110px]" />}
                        </>)}
                        {g === 'education' && (<>
                          <Select label="Which entry" value={edu ? (edu.id ?? '__new') : ''} disabled={dis} onChange={(e) => { const v = e.target.value; if (!v) setP({ education: undefined }); else if (v === '__new') setP({ education: { school: '' } }); else { const en = eduEntries.find((x) => x.id === v); setP({ education: { id: v, description: en?.description ?? '' } }); } }}>
                            <option value="">— none —</option>
                            {eduEntries.filter((e) => e.id).map((e) => <option key={e.id!} value={e.id!}>{e.school}{e.degree ? ` · ${e.degree}` : ''}</option>)}
                            <option value="__new">+ Add an entry</option>
                          </Select>
                          {edu && !edu.id && <div className="grid grid-cols-2 gap-3"><Input label="School" value={edu.school ?? ''} disabled={dis} maxLength={LIMITS.school} onChange={(e) => setP({ education: { ...edu, school: e.target.value } })} /><Input label="Degree" value={edu.degree ?? ''} disabled={dis} onChange={(e) => setP({ education: { ...edu, degree: e.target.value || undefined } })} /><Input label="Field of study" value={edu.field_of_study ?? ''} disabled={dis} onChange={(e) => setP({ education: { ...edu, field_of_study: e.target.value || undefined } })} /></div>}
                          {edu && <Textarea label="Description" value={edu.description ?? ''} disabled={dis} counter={{ max: LIMITS.education_description, value: (edu.description ?? '').length }} onChange={(e) => setP({ education: { ...edu, description: e.target.value } })} />}
                        </>)}
                        {g === 'skills' && (<>
                          <div className="text-xs text-gray-500">Current: <span className="text-gray-800">{doc?.skills?.length ? doc.skills.map((s) => s.name).join(', ') : d.snapshot?.sections.includes('skills') ? '(none)' : 'not read yet'}</span></div>
                          <Textarea label="Skills (comma-separated)" value={skillsText ?? p.skills?.join(', ') ?? ''} disabled={dis} onChange={(e) => { setSkillsText(e.target.value); const list = e.target.value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean).slice(0, 50); setP({ skills: list.length ? list : undefined }); }} className="min-h-[70px]" placeholder={doc?.skills?.map((s) => s.name).join(', ')} hint="Sending a list replaces what LinkedIn shows. Start from the current list." />
                          <Toggle checked={!!p.skills_follow} disabled={dis} onChange={(v) => setP({ skills_follow: v ? true : undefined })} label="Follow these skills (LinkedIn does not report this back)" />
                        </>)}
                        {g === 'custom_link' && (<>
                          <div className="text-xs text-gray-500">Last written through the platform: <span className="text-gray-800">{(d.last_written.custom_link as { url?: string } | undefined)?.url ?? 'nothing yet'}</span></div>
                          <div className="grid grid-cols-3 gap-3">
                            <Select label="Type" value={p.custom_link?.type ?? ''} disabled={dis} onChange={(e) => { const t = e.target.value as (typeof CUSTOM_LINK_TYPES)[number]; setP({ custom_link: t ? { type: t, url: p.custom_link?.url ?? '', display_on: p.custom_link?.display_on } : undefined }); }}><option value="">—</option>{CUSTOM_LINK_TYPES.map((t) => <option key={t} value={t}>{t.charAt(0) + t.slice(1).toLowerCase()}</option>)}</Select>
                            <Input label="URL" value={p.custom_link?.url ?? ''} disabled={dis || !p.custom_link} placeholder="https://" onChange={(e) => p.custom_link && setP({ custom_link: { ...p.custom_link, url: e.target.value } })} className="col-span-2" />
                          </div>
                          {p.custom_link && <Select label="Show" value={p.custom_link.display_on ?? 'PROFILE_ONLY'} disabled={dis} onChange={(e) => setP({ custom_link: { ...p.custom_link!, display_on: e.target.value as 'PROFILE_ONLY' | 'EVERYWHERE' } })}><option value="PROFILE_ONLY">On the profile only</option><option value="EVERYWHERE">Everywhere (posts, comments)</option></Select>}
                        </>)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* submit bar */}
            <div className="mt-4 border-t border-gray-100 pt-4 space-y-3">
              <Textarea label="Note for the owner (optional)" value={draft.note} disabled={readOnly} onChange={(e) => setDraft((x) => ({ ...x, note: e.target.value }))} className="min-h-[50px]" placeholder="Why this change" />
              {touched.length > 0 && (
                <div className="text-xs text-gray-600">
                  Changing <b>{touched.map((g) => GROUP_LABELS[g]).join(', ')}</b>.{' '}
                  {missingAuthority.length ? <span className="text-red-700">No permission for {missingAuthority.map((g) => GROUP_LABELS[g]).join(', ')}: submitting is refused until the owner grants it.</span>
                    : mode === 'direct' ? <span>Direct permission: it will be scheduled in the sender&apos;s working hours (one profile edit per day) and the owner emailed afterwards.</span>
                    : <span className="text-amber-800">Proposal permission: the owner receives it by email and applies it with one click. Nothing changes before that.</span>}
                </div>
              )}
              {validation && !validation.ok && <ul className="text-xs text-red-700 space-y-0.5">{validation.causes.filter((c) => c.blocking).map((c, i) => <li key={i}>{causeText(c)}. {c.remedy}</li>)}</ul>}
              <div className="flex flex-wrap gap-2 items-center">
                <Button variant="secondary" onClick={saveDraft} loading={busy === 'save'} disabled={!!busy || readOnly || !touched.length}><Save className="w-4 h-4" /> Save draft</Button>
                <Button onClick={submit} loading={busy === 'submit'} disabled={!!busy || readOnly || !touched.length || missingAuthority.length > 0}>
                  <Send className="w-4 h-4" /> {mode === 'direct' ? 'Schedule change' : 'Send to owner'}
                </Button>
                {(touched.length > 0 || draft.changeId) && <Button variant="ghost" onClick={() => { setDraft(EMPTY); setValidation(null); setSkillsText(null); setPreviewPhoto(null); setPreviewCover(null); }} disabled={!!busy}><XCircle className="w-4 h-4" /> Discard</Button>}
                {draft.changeId && <span className="text-[11px] text-gray-400">editing a saved draft</span>}
              </div>
            </div>
          </Card>

          {/* pending */}
          <Card title="Pending changes">
            {d.pending.length === 0 ? <div className="text-sm text-gray-500">Nothing pending.</div> : (
              <ul className="divide-y divide-gray-100">
                {d.pending.map((c) => (
                  <li key={c.id} className="py-2.5 flex flex-wrap items-center gap-2 text-sm">
                    <Badge tone={STATUS_TONE[c.status]}>{STATUS_LABELS[c.status]}</Badge>
                    <span className="font-medium text-gray-900">{c.field_groups.map((g) => GROUP_LABELS[g]).join(', ')}</span>
                    <span className="text-xs text-gray-500">{SOURCE_LABELS[c.source] ?? c.source}{c.status === 'queued' && c.scheduled_for ? ` · ${fmtDate(c.scheduled_for)}` : c.status === 'awaiting_owner' ? ' · the owner has the email' : ''}</span>
                    {c.error_code && <span className="text-xs text-amber-700">{reasonText(c.error_code)}</span>}
                    <span className="ml-auto flex gap-1.5">
                      {c.status === 'draft' && canWrite && <Button size="sm" variant="secondary" onClick={() => loadDraft(c)}>Open</Button>}
                      {canWrite && <Button size="sm" variant="ghost" onClick={() => cancelChange(c)}>Cancel</Button>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <HistoryList senderId={sender.id} ws={ws} canWrite={canWrite} notify={notify} />
        </div>

        {/* preview + cards */}
        <div className="xl:col-span-2 space-y-4">
          <div className="xl:sticky xl:top-4 space-y-4">
            <ProfilePreview doc={doc} payload={p} name={sender.display_name ?? ''} pictureUrl={previewPhoto ?? doc?.picture_url ?? sender.picture_url} coverUrl={previewCover ?? doc?.cover_url ?? null} connections={doc?.connections_count ?? sender.connections_count} />
            <QaCard qa={d.qa} snapshotAt={d.snapshot?.captured_at ?? null} />
            {needAuth ? <AuthorityCard senderId={sender.id} ws={ws} ownerEmail={d.sender.owner_email} isManager={isManager} canWrite={canWrite} notify={notify} />
              : <Card title="Owner permission"><p className="text-sm text-gray-600">Off for this workspace: changes are scheduled without the account owner&apos;s sign-off and the owner is not emailed. {isManager ? <>Turn it on in <a href="/outreach/settings/workspace" className="text-indigo-700 underline">Settings, Workspace</a> when senders belong to clients or their employees.</> : 'The workspace owner can turn it on in Settings.'}</p></Card>}
          </div>
        </div>
      </div>

      <Modal open={!!ai} onClose={() => setAi(null)} title={<span className="flex items-center gap-2"><Bot className="w-4 h-4" /> Draft {ai?.group === 'headline' ? 'a headline' : 'an About section'} with AI</span>} size="md"
        footer={<><Button variant="secondary" onClick={() => setAi(null)}>Cancel</Button><Button loading={busy === 'ai'} onClick={aiDraft}><Sparkles className="w-4 h-4" /> Write a draft</Button></>}>
        <div className="space-y-3 text-sm">
          <p className="text-gray-700">The model uses only what is on the profile snapshot and the brief. The result lands here as a draft for you to edit. It is never applied on its own.</p>
          <Textarea label="Brief (optional)" value={ai?.brief ?? ''} onChange={(e) => setAi((x) => (x ? { ...x, brief: e.target.value } : x))} placeholder="Who we help, the offer, the tone. Example: we help fintech CFOs close the books in 3 days; direct, no buzzwords." className="min-h-[90px]" />
          {!d.snapshot && <div className="text-xs text-amber-700">No profile snapshot yet: the draft will be thin. Refresh the snapshot first.</div>}
        </div>
      </Modal>
    </div>
  );
}
