'use client';

// Settings → Websites → {inbox} → Video bubble: a GIF / video as the launcher instead of the chat icon
// (settings.launcher.video, migration 053). A click on the bubble expands it with suggested questions and a
// "Chat with us" button. A question can carry its own answer clip and a page link (migration 062). The clips can come
// in several languages, switched by the visitor on a strip of flags (migration 065). The widget side is
// public/widget/v1/video.js; with no clip set the normal launcher shows.

import { useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2, Upload } from 'lucide-react';
import { cn } from '@/lib/utils';
import { parseError } from '@/lib/outreach/api';
import { Button, Card } from '@/components/outreach/ui';
import { Note, SettingRow, Switch } from '@/components/outreach/settings/shared';
import { MAX_VIDEO_LANGUAGES, VIDEO_BUBBLE_DEFAULTS, VIDEO_LANGUAGES, WEBCHAT_MEDIA_ACCEPT, WEBCHAT_MEDIA_MAX_MB, flagUrl, mediaKind, mediaUrl, orderVideoClips, packVideoBubble, uploadWebchatMedia, useWebchatPresets, videoQuestions, type VideoBubbleSettings, type VideoClip, type VideoLanguage, type VideoQuestion } from '@/lib/outreach/webchat';
import { VideoBubbleFrame } from './WidgetPreview';
import { Grid, Label, SaveBar, field, useDraft, useSaveSettings, type SectionProps } from './sections';

const HEX6 = /^#[0-9a-f]{6}$/i;
const MAX_QUESTIONS = 6;
const HTTPS = /^https:\/\/[^\s"<>]+$/i;

function Color({ label, hint, value, fallback, onChange, disabled }: { label: string; hint?: string; value: string | null; fallback: string; onChange: (v: string | null) => void; disabled: boolean }) {
  return (
    <div>
      <Label hint={hint}>{label}</Label>
      <div className="flex items-center gap-2">
        <input type="color" value={HEX6.test(value ?? '') ? value! : fallback} onChange={(e) => onChange(e.target.value)} disabled={disabled} className="w-9 h-9 p-0 border rounded" aria-label={label} />
        <input className={field} value={value ?? ''} placeholder={fallback} onChange={(e) => onChange(e.target.value.trim() || null)} disabled={disabled} />
      </div>
    </div>
  );
}

function Range({ label, hint, value, min, max, step = 1, unit = '', onChange, disabled }: { label: string; hint?: string; value: number; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void; disabled: boolean }) {
  return (
    <div>
      <Label hint={hint}>{label}</Label>
      <div className="flex items-center gap-3">
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} disabled={disabled} className="flex-1 accent-indigo-600" aria-label={label} />
        <span className="w-14 text-right text-xs tabular-nums text-gray-600">{value}{unit}</span>
      </div>
    </div>
  );
}

/** File name of an uploaded / linked clip, without the upload timestamp prefix. */
function clipName(url: string): string {
  const name = (url.split('?')[0].split('/').pop() ?? '').replace(/^\d{13}-/, '');
  try { return decodeURIComponent(name) || url; } catch { return name || url; }
}

function Thumb({ url, kind, className }: { url: string; kind: 'video' | 'image'; className?: string }) {
  const src = mediaUrl(url); if (!src) return null;
  return kind === 'image' ? <img src={src} alt="" className={cn('object-cover bg-gray-900', className)} /> : <video src={src} muted loop playsInline preload="metadata" className={cn('object-cover bg-gray-900', className)} onMouseEnter={(e) => { e.currentTarget.play().catch(() => {}); }} onMouseLeave={(e) => e.currentTarget.pause()} />;
}

type Clip = { url: string; kind: 'video' | 'image' };

function Flag({ lang, className }: { lang: VideoLanguage; className?: string }) {
  return lang.flag
    ? <img src={flagUrl(lang.flag)} alt="" className={cn('rounded-full bg-gray-200 flex-none', className)} />
    : <span className={cn('rounded-full bg-gray-700 text-white text-[9px] font-bold flex items-center justify-center flex-none', className)}>{lang.code.slice(0, 2).toUpperCase()}</span>;
}

/** One clip slot: the clip that is there (thumb, name, Remove), or the two ways to add one (upload, paste a link). */
function ClipSlot({ clip, what, canEdit, uploading, toast, onSet, onUpload }: {
  clip: Clip | null; what: string; canEdit: boolean; uploading: boolean; toast: SectionProps['toast']; onSet: (clip: Clip | null) => void; onUpload: (file: File | undefined) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [link, setLink] = useState('');
  const applyLink = () => {
    const u = link.trim();
    if (!HTTPS.test(u)) { toast('Paste an https link to an MP4, WebM, GIF or WebP file.', 'error'); return; }
    onSet({ url: u, kind: mediaKind(u) }); setLink('');
  };
  if (clip && mediaUrl(clip.url)) return (
    <div className="flex items-center gap-2">
      <Thumb url={clip.url} kind={clip.kind} className="w-11 h-11 rounded-md flex-none" />
      <span className="min-w-0 flex-1 text-xs text-gray-700 truncate" title={clipName(clip.url)}>{clipName(clip.url)}</span>
      {canEdit && <Button size="sm" variant="ghost" className="text-red-600" onClick={() => onSet(null)} aria-label={`Remove ${what}`}><Trash2 className="w-3.5 h-3.5 mr-1" />Remove</Button>}
    </div>
  );
  if (!canEdit) return <p className="text-xs text-gray-500">No video.</p>;
  return (
    <div className="space-y-2">
      <input ref={fileRef} type="file" accept={WEBCHAT_MEDIA_ACCEPT} hidden onChange={(e) => { onUpload(e.target.files?.[0]); e.target.value = ''; }} />
      <Button size="sm" variant="secondary" loading={uploading} onClick={() => fileRef.current?.click()} aria-label={`Upload ${what}`}><Upload className="w-3.5 h-3.5 mr-1" />Upload a video</Button>
      <div className="flex items-center gap-2">
        <input className={cn(field, 'flex-1 min-w-0')} value={link} onChange={(e) => setLink(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') applyLink(); }} placeholder="or paste a video link" aria-label={`Link to ${what}`} />
        <Button size="sm" variant="ghost" onClick={applyLink} disabled={!link.trim()}>Use link</Button>
      </div>
    </div>
  );
}

/** The same clip in each language: one slot per language, in the order of the strip. */
function LangClips({ langs, clips, what, canEdit, busy, busyKey, toast, onSet, onUpload }: {
  langs: VideoLanguage[]; clips: VideoClip[]; what: string; canEdit: boolean; busy: string | null; busyKey: string; toast: SectionProps['toast'];
  onSet: (lang: string, clip: Clip | null) => void; onUpload: (lang: string, file: File | undefined) => void;
}) {
  return (
    <ul className="space-y-3">
      {langs.map((l, i) => {
        const c = clips.find((x) => x.lang === l.code) ?? null, name = l.label.trim() || l.code;
        return (
          <li key={l.code} className="flex items-start gap-2">
            <Flag lang={l} className="w-6 h-6 mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-gray-700 mb-1">{name}{i === 0 && <span className="font-normal text-gray-400"> · default</span>}</div>
              <ClipSlot clip={c} what={`${what} in ${name}`} canEdit={canEdit} uploading={busy === `${busyKey}:${l.code}`} toast={toast} onSet={(clip) => onSet(l.code, clip)} onUpload={(file) => onUpload(l.code, file)} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** One suggested question: its text, the clip that answers it (one per language when languages are set) and the page it links to. */
function QuestionRow({ i, count, q, langs, canEdit, busy, toast, onChange, onMove, onDelete, onUpload }: {
  i: number; count: number; q: VideoQuestion; langs: VideoLanguage[]; canEdit: boolean; busy: string | null; toast: SectionProps['toast'];
  onChange: (patch: Partial<VideoQuestion>) => void; onMove: (d: -1 | 1) => void; onDelete: () => void; onUpload: (lang: string | null, file: File | undefined) => void;
}) {
  const off = !canEdit, n = i + 1, badLink = !!q.link_url?.trim() && !HTTPS.test(q.link_url.trim());
  const setVariant = (lang: string, clip: Clip | null) => onChange({ video_variants: [...(q.video_variants ?? []).filter((x) => x.lang !== lang), ...(clip ? [{ lang, ...clip }] : [])] });
  return (
    <li className="rounded-lg border border-gray-200 p-3">
      <div className="flex items-center gap-2">
        <span className="flex-none w-6 h-6 rounded-full border border-gray-300 text-[11px] font-semibold text-gray-600 flex items-center justify-center">{String.fromCharCode(65 + i)}</span>
        <input className={field} value={q.text} maxLength={120} onChange={(e) => onChange({ text: e.target.value })} disabled={off} placeholder="What does it cost?" aria-label={`Question ${n}`} />
        {canEdit && <>
          <button type="button" onClick={() => onMove(-1)} disabled={i === 0} className="p-1.5 rounded text-gray-500 hover:bg-gray-100 disabled:opacity-30" aria-label={`Move question ${n} up`}><ArrowUp className="w-4 h-4" /></button>
          <button type="button" onClick={() => onMove(1)} disabled={i === count - 1} className="p-1.5 rounded text-gray-500 hover:bg-gray-100 disabled:opacity-30" aria-label={`Move question ${n} down`}><ArrowDown className="w-4 h-4" /></button>
          <button type="button" onClick={onDelete} className="p-1.5 rounded text-red-600 hover:bg-red-50" aria-label={`Delete question ${n}`}><Trash2 className="w-4 h-4" /></button>
        </>}
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2 sm:pl-8">
        <div className="min-w-0">
          <Label hint="plays when the question is clicked">Answer video</Label>
          {langs.length > 0
            ? <LangClips langs={langs} clips={q.video_variants ?? []} what={`the video of question ${n}`} canEdit={canEdit} busy={busy} busyKey={`q${i}`} toast={toast} onSet={setVariant} onUpload={onUpload} />
            : <ClipSlot clip={q.video_url ? { url: q.video_url, kind: q.video_kind ?? mediaKind(q.video_url) } : null} what={`the video of question ${n}`} canEdit={canEdit} uploading={busy === `q${i}`} toast={toast}
                onSet={(clip) => onChange(clip ? { video_url: clip.url, video_kind: clip.kind } : { video_url: null })} onUpload={(file) => onUpload(null, file)} />}
        </div>
        <div className="min-w-0">
          <Label hint="opens in a new tab">Page link</Label>
          <input className={cn(field, badLink && 'border-red-400')} type="url" value={q.link_url ?? ''} maxLength={1000} onChange={(e) => onChange({ link_url: e.target.value })} disabled={off} placeholder="https://yoursite.com/pricing" aria-label={`Page link of question ${n}`} aria-invalid={badLink} />
          {badLink && <p className="mt-1 text-xs text-red-600">Use a full https:// address.</p>}
          <input className={cn(field, 'mt-2')} value={q.link_text ?? ''} maxLength={40} onChange={(e) => onChange({ link_text: e.target.value })} disabled={off || !q.link_url?.trim()} placeholder="Link text (Learn more)" aria-label={`Link text of question ${n}`} />
        </div>
      </div>
    </li>
  );
}

export default function VideoBubbleSection(p: SectionProps) {
  const saved = p.inbox.settings.launcher.video;
  const { draft, set, dirty, reset } = useDraft<VideoBubbleSettings>({ ...VIDEO_BUBBLE_DEFAULTS, ...saved, questions: videoQuestions(saved?.questions) });
  const { save, saving } = useSaveSettings(p);
  const presets = useWebchatPresets();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);   // the slot an upload is running for: main:<lang>, q<n>, q<n>:<lang>
  const [link, setLink] = useState('');
  const [view, setView] = useState<'bubble' | 'expanded'>('bubble');
  const off = !p.canEdit, accent = p.inbox.settings.appearance.accent;
  const langs = draft.languages ?? [];
  const q = videoQuestions(draft.questions);
  const packed = packVideoBubble({ ...draft, questions: q }, MAX_QUESTIONS);   // what Save sends, and what the preview draws
  const hasClip = !!mediaUrl(packed.url), preset = /^preset:/i.exec(packed.url ?? '') ? packed.url!.slice(7) : null;
  const circle = draft.shape === 'circle';
  // every clip the published settings or this draft point at: an upload tidies the folder but must leave these
  const clips = () => [saved, draft].flatMap((v) => (v ? [v.url, ...(v.variants ?? []).map((x) => x.url), ...videoQuestions(v.questions).flatMap((x) => [x.video_url, ...(x.video_variants ?? []).map((y) => y.url)])] : []));

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const r = await uploadWebchatMedia(p.inbox.workspace_id, p.inbox.id, file, clips());
      set({ url: r.url, kind: r.kind, enabled: true });
      p.toast('Clip uploaded. Save to publish it.');
    } catch (e) { p.toast(parseError(e).message, 'error'); }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = ''; }
  };
  const applyLink = () => {
    const u = link.trim();
    if (!/^https:\/\/\S+$/i.test(u)) { p.toast('Paste an https link to an MP4, WebM, GIF or WebP file.', 'error'); return; }
    set({ url: u, kind: mediaKind(u), enabled: true }); setLink('');
  };
  const setQ = (i: number, patch: Partial<VideoQuestion>) => set((d) => ({ ...d, questions: videoQuestions(d.questions).map((x, k) => (k === i ? { ...x, ...patch } : x)) }));
  const move = (i: number, d: -1 | 1) => { const j = i + d; if (j < 0 || j >= q.length) return; const n = [...q]; [n[i], n[j]] = [n[j], n[i]]; set({ questions: n }); };
  // the main clip in one language
  const setVariant = (lang: string, clip: Clip | null) => set((d) => ({ ...d, enabled: clip ? true : d.enabled, variants: [...(d.variants ?? []).filter((x) => x.lang !== lang), ...(clip ? [{ lang, ...clip }] : [])] }));
  const setQVariant = (i: number, lang: string, clip: Clip | null) => set((d) => ({ ...d, questions: videoQuestions(d.questions).map((x, k) => (k === i ? { ...x, video_variants: [...(x.video_variants ?? []).filter((y) => y.lang !== lang), ...(clip ? [{ lang, ...clip }] : [])] } : x)) }));
  const uploadTo = async (key: string, file: File | undefined, apply: (clip: Clip) => void) => {
    if (!file) return;
    setBusy(key);
    try {
      const r = await uploadWebchatMedia(p.inbox.workspace_id, p.inbox.id, file, clips());
      apply(r);
      p.toast('Video uploaded. Save to publish it.');
    } catch (e) { p.toast(parseError(e).message, 'error'); }
    finally { setBusy(null); }
  };
  // Languages. With none, every step has one clip (url / video_url). With the first language added, the clips that are
  // there become that language's; with the last one removed, each step keeps one clip (that language's, else another).
  const setLangs = (next: VideoLanguage[]) => set((d) => {
    const prev = d.languages ?? [], qs = videoQuestions(d.questions);
    if (!prev.length && next.length) {
      const l = next[0].code;
      return { ...d, languages: next, variants: d.url ? [{ lang: l, url: d.url, kind: d.kind }] : [], questions: qs.map((x) => (x.video_url ? { ...x, video_variants: [{ lang: l, url: x.video_url, kind: x.video_kind ?? mediaKind(x.video_url) }] } : x)) };
    }
    if (prev.length && !next.length) {
      // the clip of the last language left, else any clip the step still has
      const keep = (list?: VideoClip[]) => orderVideoClips(list, prev)[0] ?? (list ?? []).find((x) => !!mediaUrl(x.url));
      const m = keep(d.variants);
      return { ...d, languages: [], variants: [], url: m?.url ?? null, kind: m?.kind ?? d.kind, questions: qs.map((x) => { const c = keep(x.video_variants); return { ...x, video_variants: [], video_url: c?.url ?? null, video_kind: c?.kind ?? x.video_kind }; }) };
    }
    return { ...d, languages: next };
  });
  const moveLang = (i: number, d: -1 | 1) => { const j = i + d; if (j < 0 || j >= langs.length) return; const n = [...langs]; [n[i], n[j]] = [n[j], n[i]]; setLangs(n); };
  const onSave = () => {
    const bad = q.findIndex((x) => x.text.trim() && !!x.link_url?.trim() && !HTTPS.test(x.link_url.trim()));
    if (bad >= 0) { p.toast(`Question ${String.fromCharCode(65 + bad)}: the page link must be a full https:// address.`, 'error'); return; }
    const lost = q.findIndex((x) => !x.text.trim() && (x.video_url || x.video_variants?.length || x.link_url?.trim()));
    if (lost >= 0) { p.toast(`Question ${String.fromCharCode(65 + lost)} has a video or a link but no text. Add the question, or delete the row.`, 'error'); return; }
    return save({ settings: { launcher: { video: { ...packed, cta_text: draft.cta_text.trim() || VIDEO_BUBBLE_DEFAULTS.cta_text } } } });
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
      <div className="space-y-4 min-w-0">
        <Card title="Video bubble">
          <div className="divide-y divide-gray-100">
            <SettingRow title="Show a GIF or video instead of the launcher icon" description="Visitors see the clip in a small floating bubble. Clicking it opens a larger view with your suggested questions. With no clip set, the normal launcher shows." control={<Switch checked={draft.enabled} onChange={(v) => set({ enabled: v })} label="Video bubble" disabled={off} />} />
          </div>
          <div className="mt-3">
            <div className="flex items-center justify-between gap-2">
              <Label hint="optional">Languages</Label>
              {p.canEdit && langs.length < MAX_VIDEO_LANGUAGES && (
                <select className={cn(field, 'w-auto mb-1')} value="" onChange={(e) => { const l = VIDEO_LANGUAGES.find((x) => x.code === e.target.value); if (l) setLangs([...langs, { ...l }]); }} aria-label="Add a language">
                  <option value="">Add a language…</option>
                  {VIDEO_LANGUAGES.filter((x) => !langs.some((l) => l.code === x.code)).map((x) => <option key={x.code} value={x.code}>{x.label}</option>)}
                </select>
              )}
            </div>
            {langs.length > 0 && (
              <ul className="space-y-1.5 mb-1.5">
                {langs.map((l, i) => (
                  <li key={l.code} className="flex items-center gap-2">
                    <Flag lang={l} className="w-6 h-6" />
                    <input className={cn(field, 'flex-1 min-w-0')} value={l.label} maxLength={40} onChange={(e) => set({ languages: langs.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)) })} disabled={off} aria-label={`Name of language ${i + 1}`} />
                    {i === 0 && <span className="text-[11px] text-gray-500 whitespace-nowrap">default</span>}
                    {p.canEdit && <>
                      <button type="button" onClick={() => moveLang(i, -1)} disabled={i === 0} className="p-1.5 rounded text-gray-500 hover:bg-gray-100 disabled:opacity-30" aria-label={`Move language ${i + 1} up`}><ArrowUp className="w-4 h-4" /></button>
                      <button type="button" onClick={() => moveLang(i, 1)} disabled={i === langs.length - 1} className="p-1.5 rounded text-gray-500 hover:bg-gray-100 disabled:opacity-30" aria-label={`Move language ${i + 1} down`}><ArrowDown className="w-4 h-4" /></button>
                      <button type="button" onClick={() => setLangs(langs.filter((_, k) => k !== i))} className="p-1.5 rounded text-red-600 hover:bg-red-50" aria-label={`Remove language ${i + 1}`}><Trash2 className="w-4 h-4" /></button>
                    </>}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-gray-500">Add the same videos in more than one language (UK English, Australian English, Hindi…). Visitors get a strip of flags next to the expanded video and switch with one click; their choice is remembered. The strip shows only for a video that exists in more than one language. Before a visitor chooses, their browser&apos;s language decides; the first language here is the fallback.</p>
          </div>
          <div className="mt-3 rounded-lg border border-gray-200 p-3">
            {langs.length > 0 ? (
              <LangClips langs={langs} clips={draft.variants ?? []} what="the main video" canEdit={p.canEdit} busy={busy} busyKey="main" toast={p.toast}
                onSet={setVariant} onUpload={(lang, file) => uploadTo(`main:${lang}`, file, (c) => setVariant(lang, c))} />
            ) : <>
            {hasClip ? (
              <div className="flex items-center gap-3">
                <Thumb url={draft.url!} kind={draft.kind} className="w-16 h-16 rounded-lg flex-none" />
                <div className="min-w-0 flex-1 text-sm">
                  <div className="font-medium text-gray-900 truncate">{preset ? `Built-in clip: ${presets.data?.find((x) => x.file === preset)?.label ?? preset}` : clipName(draft.url!)}</div>
                  <div className="text-xs text-gray-500">{draft.kind === 'image' ? 'GIF / image' : 'Video'}{draft.url !== (saved?.url ?? null) && ' · not saved yet'}</div>
                </div>
                {p.canEdit && <Button size="sm" variant="ghost" className="text-red-600" onClick={() => set({ url: null })}><Trash2 className="w-3.5 h-3.5 mr-1" />Remove</Button>}
              </div>
            ) : <p className="text-sm text-gray-500">No clip yet. The widget shows the normal launcher until you add one.</p>}
            {p.canEdit && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input ref={fileRef} type="file" accept={WEBCHAT_MEDIA_ACCEPT} hidden onChange={(e) => upload(e.target.files?.[0])} />
                <Button size="sm" variant="secondary" loading={uploading} onClick={() => fileRef.current?.click()}><Upload className="w-3.5 h-3.5 mr-1" />{hasClip ? 'Upload another' : 'Upload a GIF or video'}</Button>
                <span className="text-xs text-gray-400">or</span>
                <input className={cn(field, 'flex-1 min-w-[180px]')} value={link} onChange={(e) => setLink(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') applyLink(); }} placeholder="https://…/clip.mp4" aria-label="Link to a clip" />
                <Button size="sm" variant="ghost" onClick={applyLink} disabled={!link.trim()}>Use link</Button>
              </div>
            )}
            </>}
            <p className="mt-2 text-xs text-gray-500">MP4 or WebM video, GIF or WebP, up to {WEBCHAT_MEDIA_MAX_MB} MB. It loads on every page, so keep it short and light: 5–15 seconds, under 5 MB. A question&apos;s answer video loads only when that question is clicked.</p>
          </div>
          {(presets.data?.length ?? 0) > 0 && (
            <div className="mt-3">
              <Label hint="hover to play">Built-in clips</Label>
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                {presets.data!.map((x) => (
                  <button key={x.file} type="button" disabled={off} onClick={() => (langs.length ? setVariant(langs[0].code, { url: `preset:${x.file}`, kind: x.kind }) : set({ url: `preset:${x.file}`, kind: x.kind, enabled: true }))} title={x.label}
                    className={cn('group relative rounded-lg overflow-hidden border-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500', preset === x.file ? 'border-indigo-600' : 'border-transparent hover:border-gray-300')}>
                    <Thumb url={`preset:${x.file}`} kind={x.kind} className="w-full aspect-square" />
                    <span className="absolute inset-x-0 bottom-0 bg-black/55 text-white text-[11px] px-1.5 py-0.5 truncate">{x.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {p.inbox.settings.launcher.hide && <Note tone="amber" className="mt-3">The launcher is hidden (Launcher &amp; popup tab), so the bubble is hidden too.</Note>}
        </Card>

        <Card title="Bubble">
          <Grid>
            <div><Label>Shape</Label><select className={field} value={draft.shape} onChange={(e) => set({ shape: e.target.value as VideoBubbleSettings['shape'] })} disabled={off}><option value="circle">Circle</option><option value="rounded">Rounded</option><option value="square">Square</option></select></div>
            <div><Label hint={circle ? 'a circle is always 1:1' : 'width : height'}>Proportions</Label><select className={field} value={circle ? '1:1' : draft.ratio} onChange={(e) => set({ ratio: e.target.value })} disabled={off || circle}><option value="1:1">1:1 square</option><option value="4:5">4:5 portrait</option><option value="3:4">3:4 portrait</option><option value="9:16">9:16 tall</option><option value="4:3">4:3 landscape</option><option value="16:9">16:9 wide</option></select></div>
            <Range label="Size" hint="width on desktop; phones get 75%" value={draft.size} min={64} max={240} step={4} unit="px" onChange={(v) => set({ size: v })} disabled={off} />
            <div><Label hint="the clip is never stretched">Fit</Label><select className={field} value={draft.fit} onChange={(e) => set({ fit: e.target.value as 'cover' | 'contain' })} disabled={off}><option value="cover">Fill the bubble (crop the edges)</option><option value="contain">Show the whole clip (bars at the sides)</option></select></div>
            <Range label="Zoom" value={draft.zoom} min={100} max={300} step={5} unit="%" onChange={(v) => set({ zoom: v })} disabled={off} />
            <div />
            <Range label="Focus, left to right" hint="which part stays in view" value={draft.focus_x} min={0} max={100} unit="%" onChange={(v) => set({ focus_x: v })} disabled={off} />
            <Range label="Focus, top to bottom" value={draft.focus_y} min={0} max={100} unit="%" onChange={(v) => set({ focus_y: v })} disabled={off} />
            <Color label="Border colour" value={draft.border_color} fallback="#ffffff" onChange={(v) => set({ border_color: v ?? '#ffffff' })} disabled={off} />
            <Range label="Border width" value={draft.border_width} min={0} max={8} unit="px" onChange={(v) => set({ border_width: v })} disabled={off} />
          </Grid>
          <p className="mt-3 text-xs text-gray-500">Position and margins follow the launcher (Launcher &amp; popup tab). The X on the bubble hides it for the rest of the visit and brings the normal launcher back; the visitor can get it back with &ldquo;Watch video&rdquo; in the chat menu.</p>
        </Card>

        <Card title="Expanded view">
          <Grid>
            <Range label="Width" hint="shrinks to fit small screens" value={draft.expanded_width} min={280} max={720} step={10} unit="px" onChange={(v) => set({ expanded_width: v })} disabled={off} />
            <div><Label>Proportions</Label><select className={field} value={draft.expanded_ratio} onChange={(e) => set({ expanded_ratio: e.target.value })} disabled={off}><option value="auto">Same as the clip</option><option value="16:9">16:9 wide</option><option value="4:3">4:3 landscape</option><option value="1:1">1:1 square</option><option value="3:4">3:4 portrait</option><option value="9:16">9:16 tall</option></select></div>
            <div><Label>Suggested questions sit</Label><select className={field} value={draft.questions_position} onChange={(e) => set({ questions_position: e.target.value as 'over' | 'below' })} disabled={off}><option value="over">Over the clip, at the bottom</option><option value="below">Below the clip</option></select></div>
          </Grid>
          <div className="divide-y divide-gray-100 mt-1">
            <SettingRow title="Play with sound when expanded" description="The bubble itself is always muted. Videos get replay, progress and mute controls; a GIF has none." control={<Switch checked={draft.sound} onChange={(v) => set({ sound: v })} label="Sound when expanded" disabled={off} />} />
          </div>
        </Card>

        <Card title="Suggested questions" actions={p.canEdit && <Button size="sm" variant="secondary" disabled={q.length >= MAX_QUESTIONS} onClick={() => set({ questions: [...q, { text: '' }] })}><Plus className="w-3.5 h-3.5 mr-1" />Question</Button>}>
          <p className="text-xs text-gray-500 mb-2">Shown in this order in the expanded view, up to {MAX_QUESTIONS}. All of them stay on screen the whole time.</p>
          <ul className="text-xs text-gray-500 mb-3 list-disc pl-4 space-y-0.5">
            <li><b className="font-medium text-gray-700">With an answer video:</b> a click plays that video in place of the main clip. The question&apos;s button dims while its video plays; the others stay bright and clickable.</li>
            <li><b className="font-medium text-gray-700">With a page link:</b> a link button appears with the answer and opens the page in a new tab. With a link and no video, the click opens the page directly.</li>
            <li><b className="font-medium text-gray-700">With neither:</b> the click opens the chat and sends the question as the visitor&apos;s first message.</li>
          </ul>
          {q.length === 0 && <p className="text-sm text-gray-500 py-2">No questions yet. The expanded view shows only the button below.</p>}
          <ul className="space-y-2">
            {q.map((x, i) => (
              <QuestionRow key={i} i={i} count={q.length} q={x} langs={langs} canEdit={p.canEdit} busy={busy} toast={p.toast}
                onChange={(patch) => setQ(i, patch)} onMove={(d) => move(i, d)} onDelete={() => set({ questions: q.filter((_, k) => k !== i) })}
                onUpload={(lang, file) => (lang ? uploadTo(`q${i}:${lang}`, file, (c) => setQVariant(i, lang, c)) : uploadTo(`q${i}`, file, (c) => setQ(i, { video_url: c.url, video_kind: c.kind })))} />
            ))}
          </ul>
          <div className="mt-4"><Grid>
            <div><Label hint="≤ 40; opens the normal chat">Button text</Label><input className={field} maxLength={40} value={draft.cta_text} onChange={(e) => set({ cta_text: e.target.value })} disabled={off} placeholder="Chat with us" /></div>
            <div />
            <Color label="Question background" value={draft.question_bg} fallback="#111827" onChange={(v) => set({ question_bg: v ?? '#111827' })} disabled={off} />
            <Color label="Question text" value={draft.question_color} fallback="#ffffff" onChange={(v) => set({ question_color: v ?? '#ffffff' })} disabled={off} />
            <Color label="Button background" hint="empty = accent colour" value={draft.cta_bg} fallback={HEX6.test(accent) ? accent : '#4f46e5'} onChange={(v) => set({ cta_bg: v })} disabled={off} />
            <Color label="Button text" value={draft.cta_color} fallback="#ffffff" onChange={(v) => set({ cta_color: v ?? '#ffffff' })} disabled={off} />
          </Grid></div>
          <SaveBar dirty={dirty} saving={saving} canEdit={p.canEdit} onReset={reset} onSave={onSave} />
        </Card>
      </div>

      <div className="xl:sticky xl:top-4 self-start rounded-xl border border-gray-200 bg-white overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 text-xs">
          <span className="text-gray-500">Preview</span>
          <div className="flex gap-1">{(['bubble', 'expanded'] as const).map((v) => <button key={v} type="button" onClick={() => setView(v)} className={cn('px-2 py-0.5 rounded', view === v ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-gray-600 hover:bg-gray-100')}>{v}</button>)}</div>
        </div>
        <div className="relative h-[520px] bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] [background-size:16px_16px]">
          {hasClip && draft.enabled
            ? <div className="absolute bottom-5 right-5"><VideoBubbleFrame v={packed} accent={HEX6.test(accent) ? accent : '#4f46e5'} expanded={view === 'expanded'} maxWidth={318} onToggle={() => setView((v) => (v === 'bubble' ? 'expanded' : 'bubble'))} /></div>
            : <p className="absolute inset-0 flex items-center justify-center px-8 text-center text-sm text-gray-400">{hasClip ? 'The bubble is switched off. Visitors see the normal launcher.' : 'Add a clip to see the bubble here.'}</p>}
        </div>
      </div>
    </div>
  );
}
