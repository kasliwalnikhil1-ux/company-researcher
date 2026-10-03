'use client';

// AI Website Chatbots → {website} → Voice (web-chat-voice-elevenlabs-PRD.md §3, §4). Visitors can talk to the same
// assistant they type to. Everything is set up here; nobody opens the voice provider.
//
//   draft    every change is kept as the Voice tab's draft and put on the TEST agent a few seconds later, so
//            "Test voice" always speaks with what is on screen. Visitors hear the LIVE agent, which changes on
//            "Save & publish" (settings.voice, versioned like every website setting).
//   shared   brand name, persona, topics, knowledge, Q&A, products and handoff rules are the assistant's (Assistant
//            tab): editing them there updates both.
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from '@/lib/outreach/nav';
import { AlertTriangle, CheckCircle2, Loader2, Mic, MicOff, Pause, Play, RefreshCw, Square, Wrench, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { IS_DEMO } from '@/lib/outreach/mode';
import { parseError } from '@/lib/outreach/api';
import { usePlanFeature } from '@/lib/outreach/billing';
import {
  COLLECT_LABELS, MAX_VOICE_LANGUAGES, VOICE_LABEL_KEYS, VOICE_LANGUAGES, addLibraryVoice, defaultConsent, endTestSession, loadVoiceModule, runVoiceChecks, saveVoiceDraft, startTestSession, syncVoice,
  useInvalidateVoice, useVoiceState, useVoices, voiceCheckResults, voiceLanguage, voiceOf,
  type CheckResult, type CheckRun, type VoiceCollect, type VoiceHandle, type VoiceOption, type VoiceSettings, type VoiceState, type VoiceTab,
} from '@/lib/outreach/voice';
import { Badge, Button, Card, ErrorBox, Modal, Spinner, timeAgo } from '@/components/outreach/ui';
import { Note, SettingRow, Switch } from '@/components/outreach/settings/shared';
import { WEBSITES_PATH } from './WebsitesFrame';
import { Grid, Label, SaveBar, field, useDraft, useSaveSettings, type SectionProps } from './sections';

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const clampN = (v: unknown, lo: number, hi: number, d: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

export default function VoiceSection(p: SectionProps) {
  const state = useVoiceState(p.inbox.id);
  if (state.isLoading) return <Card title="Voice"><Spinner /></Card>;
  if (state.error || !state.data) return <Card title="Voice"><ErrorBox message={state.error ? parseError(state.error).message : 'Voice could not be loaded.'} /></Card>;
  return <VoiceForm {...p} state={state.data} />;
}

function VoiceForm(p: SectionProps & { state: VoiceState }) {
  const s = useVoiceState(p.inbox.id).data ?? p.state;
  const invalidate = useInvalidateVoice(p.inbox.id);
  const published = useMemo(() => voiceOf(p.inbox.settings.voice), [p.inbox.settings.voice]);
  // the draft from an earlier visit comes back (it is what the test agent has): it wins over the published copy
  const { draft, set, dirty, reset } = useDraft<VoiceSettings>(voiceOf({ ...published, ...(p.state.draft ?? {}) }));
  const { save, saving } = useSaveSettings(p);
  const [picker, setPicker] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testSync, setTestSync] = useState<{ state: 'idle' | 'saving' | 'ok' | 'error'; error?: string }>({ state: 'idle' });
  const ownKey = usePlanFeature(p.ws, 'voice_own_key');
  const req = s?.requires;
  const mainLang = draft.language ?? (p.inbox.settings.locale?.default ?? 'en').slice(0, 2);
  const langs = [mainLang, ...draft.languages.filter((l) => l !== mainLang)];
  const pool = s?.pool, maxPlan = s?.limits.max_minutes ?? 30;
  const live = s?.agents.live, test = s?.agents.test;

  // the draft goes to the test agent 3 s after the last change
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!dirty || !p.canEdit) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(async () => {
      setTestSync({ state: 'saving' });
      try { const r = await saveVoiceDraft(p.inbox.id, draft); setTestSync(r.ok ? { state: 'ok' } : { state: 'error', error: r.error ?? 'The test agent could not be updated.' }); invalidate(); }
      catch (e) { setTestSync({ state: 'error', error: parseError(e).message }); }
    }, 3000);
    return () => { if (draftTimer.current) clearTimeout(draftTimer.current); };
  }, [draft, dirty, p.canEdit, p.inbox.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  const publish = async () => {
    const ok = await save({ settings: { voice: { ...draft, language: draft.language, greeting: Object.fromEntries(Object.entries(draft.greeting).filter(([k, v]) => langs.includes(k) && v.trim())) } } }, draft.enabled ? 'Published. Visitors hear the new voice settings within a minute.' : 'Saved. Voice is off for visitors.');
    if (!ok) return;
    try { const r = await syncVoice(p.inbox.id, { clear_draft: true }); if (!r.ok && r.state === 'failed') p.toast(`Saved, but the voice agent could not be updated yet: ${r.error}. It is retried automatically.`, 'error'); }
    catch (e) { p.toast(`Saved, but the voice agent could not be updated yet: ${parseError(e).message}`, 'error'); }
    invalidate();
  };
  const discard = async () => { reset(); try { await saveVoiceDraft(p.inbox.id, null); } catch { /* the next save replaces it */ } invalidate(); setTestSync({ state: 'idle' }); };
  const retry = async () => { try { const r = await syncVoice(p.inbox.id); p.toast(r.ok ? 'The voice agent is up to date.' : `Still failing: ${r.error}`, r.ok ? undefined : 'error'); } catch (e) { p.toast(parseError(e).message, 'error'); } invalidate(); };

  const setLangs = (list: string[]) => set((d) => ({ ...d, languages: list.slice(0, MAX_VOICE_LANGUAGES - 1), auto_language: list.length > 0 ? d.auto_language : d.auto_language }));
  const ui = draft.ui;
  const setUi = (patch: Partial<VoiceSettings['ui']>) => set((d) => ({ ...d, ui: { ...d.ui, ...patch } }));

  return (
    <div className="space-y-4">
      <Card title={<span className="flex items-center gap-2"><Mic className="h-4 w-4" /> Voice</span>}
        actions={<div className="flex items-center gap-3"><Switch checked={draft.enabled} onChange={(v) => set({ enabled: v })} label="Voice on" disabled={!p.canEdit || (!req?.assistant_auto && !draft.enabled)} /></div>}>
        <p className="text-sm text-gray-600">Let visitors talk to your assistant. It uses the same knowledge, Q&amp;A and products as chat, and every call lands in the inbox as a conversation.</p>
        {req && !req.assistant_auto && (
          <Note tone="amber" className="mt-3">
            {req.assistant_mode === 'review'
              ? <>Spoken answers can&rsquo;t wait for approval. Switch the assistant to Auto on the <Link href={`${WEBSITES_PATH}/${p.inbox.id}?tab=ai`} className="underline">AI assistant tab</Link> to use voice.</>
              : <>Voice needs the website assistant on Auto. Turn it on in the <Link href={`${WEBSITES_PATH}/${p.inbox.id}?tab=ai`} className="underline">AI assistant tab</Link>.</>}
          </Note>
        )}
        {req && req.assistant_auto && !req.knowledge && <Note tone="amber" className="mt-3">The assistant has no knowledge source and fewer than 5 Q&amp;A pairs yet, so it will often have to say it is not sure. Add some in the <Link href={`${WEBSITES_PATH}/${p.inbox.id}?tab=ai`} className="underline">AI assistant tab</Link>.</Note>}
        {req && !req.active && <Note tone="amber" className="mt-3">The widget is off for this website (General tab), so nobody can call.</Note>}
        {s && (
          <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-gray-200 px-4 py-3 text-sm">
            <span className="flex items-center gap-1.5">
              {live?.sync_error ? <AlertTriangle className="h-4 w-4 text-amber-600" /> : live?.exists && !live.archived ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <span className="h-2 w-2 rounded-full bg-gray-300" />}
              {live?.sync_error ? <span className="text-amber-800">Live agent not updated: {live.sync_error}</span>
                : live?.exists && !live.archived ? <>Live agent updated {timeAgo(live.synced_at)}</>
                : published.enabled ? 'Live agent being prepared…' : 'Voice is off for visitors'}
              {live?.sync_error && p.canEdit && <Button size="sm" variant="ghost" onClick={retry}><RefreshCw className="mr-1 h-3.5 w-3.5" />Retry</Button>}
            </span>
            <span className="text-gray-500">{s.account === 'own' ? 'On your own voice account' : 'On our voice account'}</span>
            <span className="ml-auto text-gray-700">{pool?.limit == null ? <>Minutes this month: {pool?.used ?? 0} <span className="text-gray-400">(no cap: your own account)</span></> : <>Minutes this month: <b className={cn(pool.used >= pool.limit ? 'text-red-600' : pool.used * 100 >= pool.limit * 80 && 'text-amber-700')}>{pool.used}</b> / {pool.limit}{pool.test_used ? <span className="text-gray-400"> · {pool.test_used} in tests</span> : null}</>}</span>
          </div>
        )}
        {pool && pool.limit === 0 && <Note tone="indigo" className="mt-3">Your plan has no voice minutes included. Voice packs are added by our team: write to us, or connect your own voice account{ownKey.enabled ? ' in AI → Setup' : ` (${ownKey.minPlanLabel} plan)`} for no cap from us.</Note>}
      </Card>

      <Card title="Voice and language">
        <div className="space-y-4">
          <div>
            <Label hint="what visitors hear">Voice</Label>
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1 rounded-md border border-gray-200 px-3 py-2 text-sm">{draft.voice_name ?? (draft.voice_id ? draft.voice_id : <span className="text-gray-500">Our default warm voice for {voiceLanguage(mainLang)}</span>)}</div>
              <Button variant="secondary" onClick={() => setPicker(true)} disabled={!p.canEdit}>Change</Button>
            </div>
          </div>
          <Grid>
            <div>
              <Label hint={`${draft.speed.toFixed(2)}×`}>Speed</Label>
              <input type="range" min={0.7} max={1.2} step={0.05} value={draft.speed} onChange={(e) => set({ speed: Number(e.target.value) })} disabled={!p.canEdit} className="w-full accent-indigo-600" aria-label="Speed" />
              <div className="flex justify-between text-[11px] text-gray-400"><span>0.7 slower</span><span>1.2 faster</span></div>
            </div>
            <div>
              <Label>Delivery</Label>
              <input type="range" min={0} max={1} step={0.05} value={1 - draft.stability} onChange={(e) => set({ stability: Math.round((1 - Number(e.target.value)) * 100) / 100 })} disabled={!p.canEdit} className="w-full accent-indigo-600" aria-label="Steadier or more expressive" />
              <div className="flex justify-between text-[11px] text-gray-400"><span>Steadier</span><span>More expressive</span></div>
            </div>
          </Grid>
          <div>
            <Label hint={`up to ${MAX_VOICE_LANGUAGES}; the first is the main one`}>Languages</Label>
            <div className="flex flex-wrap items-center gap-2">
              <select className={cn(field, 'w-auto')} value={mainLang} aria-label="Main language" disabled={!p.canEdit} onChange={(e) => set((d) => ({ ...d, language: e.target.value, languages: d.languages.filter((l) => l !== e.target.value) }))}>
                {VOICE_LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label} (main)</option>)}
              </select>
              {draft.languages.filter((l) => l !== mainLang).map((l) => (
                <span key={l} className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-1 text-xs">{voiceLanguage(l)}{p.canEdit && <button type="button" aria-label={`Remove ${voiceLanguage(l)}`} onClick={() => setLangs(draft.languages.filter((x) => x !== l))}><X className="h-3 w-3" /></button>}</span>
              ))}
              {p.canEdit && langs.length < MAX_VOICE_LANGUAGES && (
                <select className={cn(field, 'w-auto')} value="" aria-label="Add a language" onChange={(e) => { if (e.target.value) setLangs([...draft.languages, e.target.value]); }}>
                  <option value="">+ Add</option>
                  {VOICE_LANGUAGES.filter((l) => !langs.includes(l.code)).map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
                </select>
              )}
            </div>
            <div className="mt-2 divide-y divide-gray-100">
              {langs.length > 1 && <SettingRow title="Switch when the visitor speaks another language" description="The assistant changes to one of these languages when the visitor uses it." control={<Switch checked={draft.auto_language} onChange={(v) => set({ auto_language: v })} label="Switch language" disabled={!p.canEdit} />} />}
              {mainLang === 'hi' && <SettingRow title="Reply in Hinglish when speaking Hindi" control={<Switch checked={draft.hinglish} onChange={(v) => set({ hinglish: v })} label="Hinglish" disabled={!p.canEdit} />} />}
            </div>
          </div>
          <div>
            <Label hint="up to 300 characters; empty = ours, with your brand name">Greeting</Label>
            <div className="space-y-2">
              {langs.map((l) => (
                <div key={l} className="flex items-start gap-2">
                  {langs.length > 1 && <span className="w-24 flex-shrink-0 pt-1.5 text-xs text-gray-500">{voiceLanguage(l)}</span>}
                  <input className={field} maxLength={300} value={draft.greeting[l] ?? ''} disabled={!p.canEdit} placeholder={`Hi! I'm the ${p.inbox.settings.appearance.brand_name || p.inbox.name} assistant — what can I help you with today?`}
                    onChange={(e) => set((d) => ({ ...d, greeting: { ...d.greeting, [l]: e.target.value } }))} aria-label={`Greeting in ${voiceLanguage(l)}`} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </Card>

      <Card title="How it answers">
        <div className="space-y-4">
          <div>
            <Label hint="persona, topics, knowledge and handoff rules come from the AI assistant tab">Voice-only instructions</Label>
            <textarea className={field} rows={3} maxLength={2000} value={draft.instructions} disabled={!p.canEdit} onChange={(e) => set({ instructions: e.target.value })} placeholder="Keep answers to 2 sentences. Offer to text links instead of reading them." />
            <p className="mt-1 text-xs text-gray-500">Uses the assistant&rsquo;s persona and topics from the <Link href={`${WEBSITES_PATH}/${p.inbox.id}?tab=ai`} className="text-indigo-700 hover:underline">AI assistant tab</Link>. {draft.instructions.length}/2,000</p>
          </div>
          <Grid>
            <div>
              <Label hint={`your plan allows up to ${maxPlan}`}>Longest call (minutes)</Label>
              <input type="number" min={1} max={30} className={field} value={draft.max_minutes} disabled={!p.canEdit} onChange={(e) => set({ max_minutes: Math.round(clampN(e.target.value, 1, 30, 5)) })} />
              {draft.max_minutes > maxPlan && <p className="mt-1 text-xs text-amber-700">Calls stop at {maxPlan} minutes on your plan.</p>}
            </div>
            <div><Label hint="10 to 120">End after this much silence (seconds)</Label><input type="number" min={10} max={120} className={field} value={draft.silence_end_s} disabled={!p.canEdit} onChange={(e) => set({ silence_end_s: Math.round(clampN(e.target.value, 10, 120, 20)) })} /></div>
            <div>
              <Label>Answers</Label>
              <div className="flex gap-4 pt-1 text-sm">
                {(['fast', 'smart'] as const).map((m) => <label key={m} className="flex items-center gap-1.5"><input type="radio" name="voice-model" checked={draft.model === m} disabled={!p.canEdit} onChange={() => set({ model: m })} />{m === 'fast' ? 'Fast' : 'Smartest'}</label>)}
              </div>
              <p className="mt-1 text-xs text-gray-500">{draft.model === 'fast' ? 'Quick replies, best for most websites.' : 'Better with tricky questions; a little slower to answer.'}</p>
            </div>
            <div><Label>Sound while it looks something up</Label><select className={field} value={draft.tool_sound} disabled={!p.canEdit} onChange={(e) => set({ tool_sound: e.target.value as VoiceSettings['tool_sound'] })}><option value="typing">Typing</option><option value="none">None</option></select></div>
          </Grid>
          <div>
            <Label hint="saved on the visitor and the lead after the call">Details to collect</Label>
            <div className="flex flex-wrap gap-4 text-sm">
              {(Object.keys(COLLECT_LABELS) as VoiceCollect[]).map((k) => <label key={k} className="flex items-center gap-1.5"><input type="checkbox" checked={draft.collect.includes(k)} disabled={!p.canEdit} onChange={(e) => set((d) => ({ ...d, collect: e.target.checked ? [...d.collect, k] : d.collect.filter((x) => x !== k) }))} />{COLLECT_LABELS[k]}</label>)}
            </div>
            <p className="mt-1 text-xs text-gray-500">Email addresses are never taken by voice: the assistant shows the email form in the chat.</p>
          </div>
        </div>
      </Card>

      <Card title="Privacy">
        <div className="divide-y divide-gray-100">
          <SettingRow title="Keep call recordings" description="Teammates can play a call from the conversation. Recordings stay with our voice provider and are deleted after the days below; we never store them." control={<Switch checked={draft.record} onChange={(v) => set({ record: v })} label="Keep recordings" disabled={!p.canEdit} />} />
        </div>
        <Grid>
          <div className="mt-3"><Label hint="1 to 365">Keep recordings and the provider&rsquo;s copy for (days)</Label><input type="number" min={1} max={365} className={field} value={draft.retention_days} disabled={!p.canEdit} onChange={(e) => set({ retention_days: Math.round(clampN(e.target.value, 1, 365, 30)) })} /></div>
        </Grid>
        <div className="mt-3">
          <Label hint="shown once per visitor before the first call; 400 characters">Consent text</Label>
          <textarea className={field} rows={2} maxLength={400} value={draft.consent_text ?? ''} disabled={!p.canEdit} placeholder={defaultConsent(draft.record)} onChange={(e) => set({ consent_text: e.target.value.trim() ? e.target.value : null })} />
          <p className="mt-1 text-xs text-gray-500">Empty = ours, in the visitor&rsquo;s language{draft.record ? '' : ' (without "may be recorded", since recording is off)'}. A link to your privacy policy is added below it.</p>
        </div>
      </Card>

      <Card title="Call view">
        <Grid>
          <div><Label hint="40 characters">Start button</Label><input className={field} maxLength={40} value={ui.start_text} disabled={!p.canEdit} onChange={(e) => setUi({ start_text: e.target.value })} /></div>
          <div><Label hint="80 characters">Line under it</Label><input className={field} maxLength={80} value={ui.start_hint} disabled={!p.canEdit} onChange={(e) => setUi({ start_hint: e.target.value })} /></div>
          <div>
            <Label>Orb colours</Label>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs text-gray-600"><input type="color" value={ui.orb_1 && HEX.test(ui.orb_1) ? ui.orb_1 : p.inbox.settings.appearance.accent} disabled={!p.canEdit} onChange={(e) => setUi({ orb_1: e.target.value })} /> Main{!ui.orb_1 && ' (accent)'}</label>
              <label className="flex items-center gap-1.5 text-xs text-gray-600"><input type="color" value={ui.orb_2 && HEX.test(ui.orb_2) ? ui.orb_2 : '#c7a3ff'} disabled={!p.canEdit} onChange={(e) => setUi({ orb_2: e.target.value })} /> Glow</label>
              {ui.orb_1 && p.canEdit && <button type="button" className="text-xs text-indigo-700 hover:underline" onClick={() => setUi({ orb_1: null })}>Use the accent</button>}
            </div>
          </div>
          <div><Label>In the orb</Label><select className={field} value={ui.avatar} disabled={!p.canEdit} onChange={(e) => setUi({ avatar: e.target.value as VoiceSettings['ui']['avatar'] })}><option value="logo">Your logo</option><option value="bot">The assistant&rsquo;s picture</option><option value="none">Nothing</option></select></div>
        </Grid>
        <div className="mt-4">
          <Label hint="empty = ours, in the visitor's language; yours are used for visitors in your main language">Labels</Label>
          <div className="grid gap-2 sm:grid-cols-3">
            {VOICE_LABEL_KEYS.map((k) => <input key={k.key} className={field} maxLength={40} placeholder={k.placeholder} aria-label={k.label} value={ui.labels[k.key] ?? ''} disabled={!p.canEdit} onChange={(e) => setUi({ labels: { ...ui.labels, [k.key]: e.target.value || undefined } })} />)}
          </div>
        </div>
        <div className="mt-3 divide-y divide-gray-100">
          <SettingRow title="Captions on by default" description="Visitors can switch them off; screen readers announce them." control={<Switch checked={ui.captions} onChange={(v) => setUi({ captions: v })} label="Captions" disabled={!p.canEdit} />} />
          <SettingRow title="“Talk to us” on the home screen" control={<Switch checked={ui.show_on.home} onChange={(v) => setUi({ show_on: { ...ui.show_on, home: v } })} label="Home" disabled={!p.canEdit} />} />
          <SettingRow title="Mic in the message box" description="While the box is empty the send button is the mic." control={<Switch checked={ui.show_on.composer} onChange={(v) => setUi({ show_on: { ...ui.show_on, composer: v } })} label="Composer mic" disabled={!p.canEdit} />} />
          <SettingRow title="Voice first" description="The launcher says your start button text and opens straight into a call." control={<Switch checked={ui.show_on.launcher} onChange={(v) => setUi({ show_on: { ...ui.show_on, launcher: v } })} label="Voice first" disabled={!p.canEdit} />} />
        </div>
        <p className="mt-3 text-xs text-gray-500">Your own buttons can start a call too: <code>data-growthxai=&quot;call&quot;</code> or <code>growthxai.call()</code> (Install &amp; security tab).</p>
      </Card>

      {p.canEdit && (
        <div className="sticky bottom-0 z-10 -mx-1 rounded-lg border border-gray-200 bg-white/95 px-4 py-3 shadow-sm backdrop-blur">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => setTesting(true)}><Mic className="mr-1.5 h-4 w-4" />Test voice</Button>
            <span className="text-xs text-gray-500">
              {testSync.state === 'saving' ? <span className="inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" />Updating the test agent…</span>
                : testSync.state === 'error' ? <span className="text-amber-700">Test agent not updated: {testSync.error}</span>
                : dirty ? 'Draft saved for testing. Visitors still hear the published settings.' : test?.draft_at ? `Draft from ${timeAgo(test.draft_at)}` : 'Test voice uses what is on screen.'}
            </span>
          </div>
          <SaveBar dirty={dirty || !!s?.draft} saving={saving} canEdit={p.canEdit} onSave={publish} onReset={discard} />
        </div>
      )}
      {!p.canEdit && <Note>Only owners and managers can change voice settings.</Note>}

      {picker && <VoicePicker ws={p.ws} language={mainLang} current={draft.voice_id} ownAccount={s?.account === 'own'} onClose={() => setPicker(false)} onPick={(v) => { set({ voice_id: v.voice_id, voice_name: v.name }); setPicker(false); }} toast={p.toast} />}
      {testing && <TestPanel inbox={p.inbox.id} draft={draft} languages={langs} domains={p.inbox.allowed_domains} onClose={() => { setTesting(false); invalidate(); }} toast={p.toast} />}
    </div>
  );
}

// ---------------------------------------------------------------- voice picker (§3 "Change")
function VoicePicker({ ws, language, current, ownAccount, onClose, onPick, toast }: { ws: string; language: string; current: string | null; ownAccount: boolean; onClose: () => void; onPick: (v: { voice_id: string; name: string }) => void; toast: SectionProps['toast'] }) {
  const [tab, setTab] = useState<VoiceTab>('recommended');
  const [f, setF] = useState({ language, search: '', gender: '', accent: '' });
  const [q, setQ] = useState('');
  useEffect(() => { const t = setTimeout(() => setF((x) => ({ ...x, search: q.trim() })), 350); return () => clearTimeout(t); }, [q]);
  const list = useVoices(ws, tab, f);
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  useEffect(() => () => { audio.current?.pause(); }, []);
  const play = (v: VoiceOption) => {
    if (!v.preview_url) return;
    if (playing === v.voice_id) { audio.current?.pause(); setPlaying(null); return; }
    audio.current?.pause();
    const a = new Audio(v.preview_url); audio.current = a; setPlaying(v.voice_id);
    a.onended = () => setPlaying(null); a.play().catch(() => setPlaying(null));
  };
  const pick = async (v: VoiceOption) => {
    if (v.source !== 'library') return onPick({ voice_id: v.voice_id, name: v.name });
    setAdding(v.voice_id);
    try { const r = await addLibraryVoice(ws, v); onPick({ voice_id: r.voice_id, name: v.name }); }
    catch (e) { toast(parseError(e).message, 'error'); } finally { setAdding(null); }
  };
  const tabs: Array<[VoiceTab, string]> = [['recommended', 'Recommended'], ['library', 'Library'], ...(ownAccount ? [['mine', 'My voices'] as [VoiceTab, string]] : [])];
  return (
    <Modal open onClose={onClose} title="Pick a voice" size="lg">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {tabs.map(([k, l]) => <button key={k} type="button" onClick={() => setTab(k)} className={cn('rounded-full px-3 py-1 text-sm', tab === k ? 'bg-indigo-50 text-indigo-700 font-medium' : 'bg-gray-100 text-gray-700 hover:bg-gray-200')}>{l}</button>)}
          <input className={cn(field, 'ml-auto w-48')} placeholder="Search voices" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search voices" />
        </div>
        <div className="flex flex-wrap gap-2">
          <select className={cn(field, 'w-auto')} value={f.language} onChange={(e) => setF({ ...f, language: e.target.value })} aria-label="Language"><option value="">Any language</option>{VOICE_LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}</select>
          {tab === 'library' && <>
            <select className={cn(field, 'w-auto')} value={f.gender} onChange={(e) => setF({ ...f, gender: e.target.value })} aria-label="Gender"><option value="">Any gender</option><option value="female">Female</option><option value="male">Male</option><option value="neutral">Neutral</option></select>
            <input className={cn(field, 'w-36')} placeholder="Accent" value={f.accent} onChange={(e) => setF({ ...f, accent: e.target.value.trim() })} aria-label="Accent" />
          </>}
        </div>
        {list.isLoading && <Spinner />}
        {list.error && <ErrorBox message={parseError(list.error).message} />}
        {list.data && list.data.voices.length === 0 && <p className="text-sm text-gray-500">No voice matches. Try another language or search.</p>}
        <ul className="max-h-[420px] divide-y divide-gray-100 overflow-y-auto rounded-lg border border-gray-200">
          {(list.data?.voices ?? []).map((v) => (
            <li key={`${v.source}:${v.voice_id}`} className={cn('flex items-center gap-3 px-3 py-2', current === v.voice_id && 'bg-indigo-50/60')}>
              <button type="button" onClick={() => play(v)} disabled={!v.preview_url} aria-label={playing === v.voice_id ? `Stop ${v.name}` : `Play ${v.name}`} className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-40">{playing === v.voice_id ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}</button>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-gray-900">{v.name}{current === v.voice_id && <Badge tone="indigo" className="ml-2">current</Badge>}</div>
                <div className="truncate text-xs text-gray-500">{[v.description, v.gender, v.accent, v.use_case, v.languages.length ? v.languages.map(voiceLanguage).slice(0, 4).join(', ') : null].filter(Boolean).join(' · ')}</div>
              </div>
              <Button size="sm" variant={current === v.voice_id ? 'ghost' : 'secondary'} loading={adding === v.voice_id} disabled={current === v.voice_id} onClick={() => pick(v)}>{current === v.voice_id ? 'Picked' : 'Use'}</Button>
            </li>
          ))}
        </ul>
        <p className="text-xs text-gray-500">Voices with live moderation are left out: the assistant cannot speak with them.{!ownAccount && ' Your own cloned voices show here once your own voice account is connected (AI → Setup).'}</p>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- test panel (§4)
interface LogRow { at: number; kind: 'you' | 'ai' | 'tool' | 'event'; text: string; ms?: number }
function TestPanel({ inbox, draft, languages, domains, onClose, toast }: { inbox: string; draft: VoiceSettings; languages: string[]; domains: string[]; onClose: () => void; toast: SectionProps['toast'] }) {
  const [phase, setPhase] = useState<'idle' | 'starting' | 'live' | 'ended'>('idle');
  const [mode, setMode] = useState<'listening' | 'speaking'>('listening');
  const [muted, setMuted] = useState(false);
  const [log, setLog] = useState<LogRow[]>([]);
  const [typed, setTyped] = useState('');
  const host = domains.find((d) => d && d !== 'localhost' && !d.startsWith('*.')) ?? 'your-site.com';
  const [page, setPage] = useState(`https://${host}/`);
  const [visitor, setVisitor] = useState('');
  const [lang, setLang] = useState(languages[0]);
  const [secs, setSecs] = useState(0);
  const h = useRef<VoiceHandle | null>(null), call = useRef<string | null>(null), t0 = useRef(0), lastAt = useRef(0), tools = useRef<Record<string, number>>({});
  const [checks, setChecks] = useState<{ run: CheckRun; results: CheckResult[] | null; finished: boolean } | null>(null);
  const [checking, setChecking] = useState(false);
  const add = (r: Omit<LogRow, 'at'>) => setLog((l) => [...l, { ...r, at: t0.current ? (Date.now() - t0.current) / 1000 : 0 }]);
  useEffect(() => { if (phase !== 'live') return; const t = setInterval(() => setSecs(Math.round((Date.now() - t0.current) / 1000)), 1000); return () => clearInterval(t); }, [phase]);
  useEffect(() => () => { void stop(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  async function start() {
    setPhase('starting'); setLog([]); setSecs(0); tools.current = {};
    try {
      // product tour: the test call is a sample recording (no microphone, no voice provider)
      if (!IS_DEMO) await navigator.mediaDevices.getUserMedia({ audio: true }).then((st) => st.getTracks().forEach((t) => t.stop()));
      const [s, mod] = await Promise.all([startTestSession(inbox, { page_url: page, page_title: page.replace(/^https?:\/\/[^/]+/, '') || '/', visitor_name: visitor || undefined, language: lang, draft }), loadVoiceModule()]);
      call.current = s.call_id;
      h.current = await mod.session({
        token: s.conversation_token, language: s.language, variables: s.dynamic_variables,
        clientTools: { switch_to_chat: (p) => { add({ kind: 'tool', text: `switch_to_chat(${p.handoff ? 'handoff' : 'show in chat'}${p.reason ? `, ${p.reason}` : ''}) → ${p.handoff ? 'handed to the team' : 'continues in chat'} (the test call ends)` }); setTimeout(() => void stop(), 2500); return 'ok'; } },
        on: {
          mode: (m) => setMode(m),
          message: (m) => { const now = Date.now(); add({ kind: m.role === 'user' ? 'you' : 'ai', text: m.text, ms: m.role === 'agent' && lastAt.current ? now - lastAt.current : undefined }); if (m.role === 'user') lastAt.current = now; },
          tool: (t) => { tools.current[t.id] = Date.now(); },
          toolResult: (t) => {
            const ms = tools.current[t.id] ? Date.now() - tools.current[t.id] : undefined;
            let summary = t.error ? 'error' : 'done';
            try { const j = t.result ? JSON.parse(t.result) : null; if (j) summary = j.found != null ? `${j.found} result${j.found === 1 ? '' : 's'}${j.products ? `: ${String(j.products).slice(0, 120)}` : ''}` : String(j.result ?? summary).slice(0, 140); } catch { /* not JSON */ }
            add({ kind: 'tool', text: `${t.name} → ${summary}`, ms });
          },
          end: (reason) => { add({ kind: 'event', text: reason === 'agent' ? 'The assistant ended the call' : reason === 'error' ? 'The connection dropped' : 'Call ended' }); setPhase('ended'); h.current = null; if (call.current) void endTestSession(inbox, call.current); },
        },
      });
      t0.current = Date.now(); setPhase('live'); setMode('listening');
    } catch (e) {
      const name = (e as { name?: string })?.name;
      toast(name === 'NotAllowedError' ? 'Allow the microphone for this site to test voice.' : parseError(e).message, 'error');
      setPhase('idle');
    }
  }
  async function stop() {
    const x = h.current; h.current = null;
    if (x) await x.end();
    if (call.current) { await endTestSession(inbox, call.current); call.current = null; }
    setPhase((p) => (p === 'idle' ? p : 'ended'));
  }
  const send = () => { const t = typed.trim(); if (!t || !h.current) return; h.current.text(t); add({ kind: 'you', text: `${t} (typed)` }); lastAt.current = Date.now(); setTyped(''); };
  async function checksRun() {
    setChecking(true);
    try {
      const run = await runVoiceChecks(inbox);
      setChecks({ run, results: null, finished: false });
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, i < 3 ? 3000 : 5000));
        const r = await voiceCheckResults(inbox, run);
        setChecks({ run, results: r.results, finished: r.finished });
        if (r.finished) break;
      }
    } catch (e) { toast(parseError(e).message, 'error'); } finally { setChecking(false); }
  }
  const mm = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" role="dialog" aria-modal="true" aria-label="Test voice">
      <div className="flex h-full w-full max-w-xl flex-col bg-white shadow-xl">
        <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-3">
          <div className="font-semibold text-gray-900">Test voice <span className="font-normal text-gray-500">(draft settings)</span></div>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => { void stop(); setLog([]); setPhase('idle'); setChecks(null); }} disabled={phase === 'starting'}>Reset</Button>
          <button type="button" onClick={() => { void stop(); onClose(); }} aria-label="Close" className="rounded p-1 text-gray-500 hover:bg-gray-100"><X className="h-5 w-5" /></button>
        </div>
        <div className="flex items-center gap-3 border-b border-gray-100 px-4 py-3">
          <span className={cn('flex h-9 w-9 items-center justify-center rounded-full', phase === 'live' ? (mode === 'speaking' ? 'animate-pulse bg-indigo-600 text-white' : 'bg-indigo-100 text-indigo-700') : 'bg-gray-100 text-gray-500')}><Mic className="h-4 w-4" /></span>
          <span className="text-sm font-medium" role="status">{phase === 'starting' ? 'Connecting…' : phase === 'live' ? (muted ? 'Muted' : mode === 'speaking' ? 'Speaking…' : 'Listening…') : phase === 'ended' ? 'Call ended' : 'Not connected'}</span>
          {phase === 'live' && <span className="text-xs tabular-nums text-gray-500">{mm}</span>}
          <div className="ml-auto flex items-center gap-2">
            {phase === 'live' && <Button size="sm" variant="secondary" onClick={() => { setMuted(!muted); h.current?.mute(!muted); }} aria-pressed={muted}>{muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}</Button>}
            {phase === 'live' ? <Button size="sm" className="bg-red-600 hover:bg-red-700" onClick={() => void stop()}><Square className="mr-1 h-3.5 w-3.5" />End</Button>
              : <Button size="sm" onClick={start} loading={phase === 'starting'}><Mic className="mr-1 h-3.5 w-3.5" />{phase === 'ended' ? 'Call again' : 'Start call'}</Button>}
          </div>
        </div>
        {phase === 'idle' && (
          <div className="grid gap-3 border-b border-gray-100 px-4 py-3 sm:grid-cols-3">
            <div className="sm:col-span-3"><Label hint="for product context">Page the visitor is on</Label><input className={field} value={page} onChange={(e) => setPage(e.target.value)} /></div>
            <div><Label>Visitor name</Label><input className={field} value={visitor} onChange={(e) => setVisitor(e.target.value)} placeholder="optional" /></div>
            {languages.length > 1 && <div><Label>Speak in</Label><select className={field} value={lang} onChange={(e) => setLang(e.target.value)}>{languages.map((l) => <option key={l} value={l}>{voiceLanguage(l)}</option>)}</select></div>}
          </div>
        )}
        <div className="flex-1 space-y-1.5 overflow-y-auto px-4 py-3 text-sm" aria-live="polite">
          {log.length === 0 && <p className="text-gray-500">Start a call and talk as a visitor would. Every tool call shows here with what it found and how long it took. Test calls never appear in the inbox; they count toward this month&rsquo;s minutes, marked as tests.</p>}
          {log.map((r, i) => (
            <div key={i} className={cn('grid grid-cols-[52px_1fr_auto] gap-2', r.kind === 'tool' && 'text-xs text-gray-600', r.kind === 'event' && 'text-xs italic text-gray-500')}>
              <span className="text-xs font-medium text-gray-500">{r.kind === 'you' ? 'You' : r.kind === 'ai' ? 'AI' : r.kind === 'tool' ? <Wrench className="h-3.5 w-3.5" /> : ''}</span>
              <span className={cn(r.kind === 'ai' && 'text-gray-900')}>{r.text}</span>
              <span className="text-[11px] tabular-nums text-gray-400">{r.ms != null ? `${(r.ms / 1000).toFixed(1)}s` : `${r.at.toFixed(0)}s`}</span>
            </div>
          ))}
        </div>
        {phase === 'live' && (
          <form className="flex gap-2 border-t border-gray-100 px-4 py-3" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <input className={field} value={typed} onChange={(e) => { setTyped(e.target.value); h.current?.activity(); }} placeholder="Type a message…" aria-label="Type a message into the call" />
            <Button type="submit" disabled={!typed.trim()}>Send</Button>
          </form>
        )}
        <div className="border-t border-gray-200 px-4 py-3">
          <div className="flex items-center gap-2"><span className="text-sm font-medium text-gray-900">Quick checks</span><span className="text-xs text-gray-500">simulated visitors, built from your Q&amp;A</span>
            <Button size="sm" variant="secondary" className="ml-auto" onClick={checksRun} loading={checking} disabled={phase === 'live'}>Run checks</Button></div>
          {checks && (
            <ul className="mt-2 space-y-1.5 text-sm">
              {checks.run.tests.map((t) => {
                const r = checks.results?.find((x) => x.test_id === t.id);
                return (
                  <li key={t.id}>
                    <div className="flex items-center gap-2">{!r || r.status === 'pending' ? <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" /> : r.status === 'passed' ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : <AlertTriangle className="h-3.5 w-3.5 text-red-600" />}<span>{t.name}</span></div>
                    {r && r.status !== 'pending' && (r.why || r.replies.length > 0) && <details className="ml-5 text-xs text-gray-600"><summary className="cursor-pointer">{r.why ?? 'What the assistant said'}</summary>{r.replies.map((x, i) => <p key={i} className="mt-1">AI: {x}</p>)}</details>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
