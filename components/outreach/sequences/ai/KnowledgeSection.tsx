'use client';

// Knowledge attached to the sequence's prompt (changes doc §9.2): websites, documents, pasted text and Q&A pairs.
// The sources are the workspace's Knowledge library (AI → Knowledge); this section picks the ones this sequence uses.
import { useRef, useState } from 'react';
import Link from '@/lib/outreach/nav';
import { FileText, Globe, HelpCircle, Pencil, Plus, Trash2, Type, X } from 'lucide-react';
import {
  KNOWLEDGE_STATUS_LABEL, uploadKnowledgeFile, useFaqDelete, useFaqSave, useKnowledgeAttach, useKnowledgeDetach, useKnowledgeSourceAdd, useKnowledgeSources,
  type Faq, type KnowledgeRef, type KnowledgeSource,
} from '@/lib/outreach/aiRepliesSequence';
import { KNOWLEDGE_FILE_ACCEPT, hubHref, useQaList } from '@/lib/outreach/aiHub';
import { Badge, Button, ErrorBox, Input, Modal, Spinner, Textarea, fmtDate } from '@/components/outreach/ui';
import { ConfirmModal, Note } from '@/components/outreach/settings/shared';
import { cn } from '@/lib/utils';
import { Section, errText } from './shared';

const STATUS_TONE: Record<KnowledgeRef['status'], 'gray' | 'blue' | 'green' | 'red'> = { pending: 'gray', crawling: 'blue', ready: 'green', error: 'red' };
const KIND_ICON = { website: Globe, document: FileText, text: Type } as const;

function chipLabel(k: KnowledgeRef): string {
  const host = k.kind === 'website' && k.url ? (() => { try { return new URL(k.url!).host.replace(/^www\./, ''); } catch { return k.title; } })() : k.title;
  return k.kind === 'website' && k.pages ? `${host} (${k.pages} ${k.pages === 1 ? 'page' : 'pages'})` : host;
}

export default function KnowledgeSection({ sequenceId, ws, knowledge, faqs, canEdit, notify }: {
  sequenceId: string; ws: string; knowledge: KnowledgeRef[]; faqs: Faq[]; canEdit: boolean; notify: (m: string, t?: 'success' | 'error') => void;
}) {
  const detach = useKnowledgeDetach(sequenceId);
  const [addOpen, setAddOpen] = useState(false);
  const [faqOpen, setFaqOpen] = useState(false);
  const fail = (e: unknown) => notify(errText(e), 'error');

  return (
    <Section title="Knowledge"
      help={<>Sources come from the workspace&rsquo;s Knowledge library and are picked here. Everything the AI finds in them counts as an allowed fact. <Link href={hubHref.knowledge()} className="text-indigo-600 hover:underline whitespace-nowrap">Open Knowledge</Link></>}
      actions={canEdit && <Button size="sm" variant="secondary" onClick={() => setAddOpen(true)}><Plus className="w-3.5 h-3.5" />Add</Button>}>
      <div className="flex flex-wrap items-center gap-2">
        {knowledge.map((k) => {
          const Icon = KIND_ICON[k.kind] ?? FileText;
          return (
            <span key={k.id} className="inline-flex max-w-full items-center gap-1.5 pl-2.5 pr-1 py-1 rounded-full border border-gray-200 bg-gray-50 text-sm text-gray-800" title={k.status === 'error' ? k.error ?? 'Failed' : k.url ?? k.title}>
              <Icon className="w-3.5 h-3.5 flex-shrink-0 text-gray-500" aria-hidden="true" />
              <span className="min-w-0 max-w-[16rem] truncate">{chipLabel(k)}</span>
              <Badge tone={STATUS_TONE[k.status] ?? 'gray'}>{KNOWLEDGE_STATUS_LABEL[k.status] ?? k.status}</Badge>
              {canEdit && <button type="button" aria-label={`Detach ${k.title}`} disabled={detach.isPending} onClick={() => detach.mutate(k.id, { onError: fail })} className="p-0.5 rounded-full text-gray-400 hover:text-red-600 hover:bg-red-50"><X className="w-3.5 h-3.5" /></button>}
            </span>
          );
        })}
        <button type="button" onClick={() => setFaqOpen(true)} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-indigo-200 bg-indigo-50 text-sm text-indigo-900 hover:bg-indigo-100">
          <HelpCircle className="w-3.5 h-3.5" aria-hidden="true" />{faqs.length} Q&amp;A
        </button>
        {knowledge.length === 0 && <span className="text-xs text-gray-500">No sources attached. The AI only uses the facts written in the prompt.</span>}
      </div>
      {knowledge.some((k) => k.status === 'error') && (
        <ul className="text-xs text-red-700 space-y-0.5">
          {knowledge.filter((k) => k.status === 'error').map((k) => <li key={k.id}>{k.title}: {k.error ?? 'could not be read'}</li>)}
        </ul>
      )}
      {addOpen && <AddKnowledgeModal sequenceId={sequenceId} ws={ws} attached={knowledge.map((k) => k.id)} onClose={() => setAddOpen(false)} notify={notify} />}
      {faqOpen && <FaqModal sequenceId={sequenceId} ws={ws} faqs={faqs} canEdit={canEdit} onClose={() => setFaqOpen(false)} notify={notify} />}
    </Section>
  );
}

type Tab = 'website' | 'document' | 'text' | 'existing';
const ACCEPT = KNOWLEDGE_FILE_ACCEPT;

function AddKnowledgeModal({ sequenceId, ws, attached, onClose, notify }: { sequenceId: string; ws: string; attached: string[]; onClose: () => void; notify: (m: string, t?: 'success' | 'error') => void }) {
  const add = useKnowledgeSourceAdd(ws);
  const attach = useKnowledgeAttach(sequenceId);
  const [tab, setTab] = useState<Tab>('website');
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [refresh, setRefresh] = useState('');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const existing = useKnowledgeSources(ws, tab === 'existing');

  const canSubmit = tab === 'website' ? /^https?:\/\/[^\s/]+/.test(url.trim()) : tab === 'document' ? !!file : tab === 'text' ? text.trim().length >= 20 : false;

  async function submit() {
    setBusy(true); setError(null);
    try {
      let s: KnowledgeSource;
      if (tab === 'website') {
        const host = (() => { try { return new URL(url.trim()).host; } catch { return url.trim(); } })();
        const days = refresh.trim() ? Number(refresh) : null;
        s = await add.mutateAsync({ kind: 'website', title: title.trim() || host, url: url.trim(), refresh_days: days && Number.isFinite(days) ? days : null });
      } else if (tab === 'document') {
        const path = await uploadKnowledgeFile(ws, sequenceId, file!);
        s = await add.mutateAsync({ kind: 'document', title: title.trim() || file!.name, storage_path: path });
      } else {
        s = await add.mutateAsync({ kind: 'text', title: title.trim() || text.trim().slice(0, 60), text: text.trim() });
      }
      await attach.mutateAsync(s.id);
      notify(tab === 'website' ? 'Website added. Pages are read in the background; the chip shows when it is ready.' : 'Added. It is read in the background and used once it shows Ready.');
      onClose();
    } catch (e) { setError(errText(e)); setBusy(false); }
  }

  async function attachExisting(id: string) {
    setBusy(true); setError(null);
    try { await attach.mutateAsync(id); notify('Attached.'); onClose(); } catch (e) { setError(errText(e)); setBusy(false); }
  }

  const tabs: Array<{ key: Tab; label: string }> = [{ key: 'website', label: 'Website' }, { key: 'document', label: 'Document' }, { key: 'text', label: 'Text' }, { key: 'existing', label: 'Existing' }];

  return (
    <Modal open onClose={onClose} title="Add knowledge" size="md"
      footer={tab === 'existing' ? <Button variant="secondary" onClick={onClose}>Close</Button> : <><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={submit} loading={busy} disabled={!canSubmit}>Add</Button></>}>
      <div className="space-y-4">
        <div role="tablist" className="inline-flex rounded-lg border border-gray-300 p-0.5 bg-gray-50">
          {tabs.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)} className={cn('px-3 py-1 text-sm rounded-md', tab === t.key ? 'bg-white shadow-sm text-gray-900 font-medium' : 'text-gray-600 hover:text-gray-900')}>{t.label}</button>
          ))}
        </div>
        {tab === 'website' && (
          <div className="space-y-3">
            <Input label="Website address" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" autoFocus />
            <Input label="Name (optional)" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Defaults to the site name" />
            <Input type="number" min={1} max={90} label="Read it again every (days, optional)" value={refresh} onChange={(e) => setRefresh(e.target.value)} hint="Up to 60 pages on the same site are read. Leave empty to read it once." />
          </div>
        )}
        {tab === 'document' && (
          <div className="space-y-3">
            <input ref={fileRef} type="file" accept={ACCEPT} className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>Choose a file</Button>
              <span className="text-sm text-gray-700 truncate">{file ? `${file.name} (${Math.round(file.size / 1024)} KB)` : 'No file chosen'}</span>
            </div>
            <Input label="Name (optional)" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Defaults to the file name" />
            <Note>Text, Markdown and HTML files are read. PDF and Word files are not extracted yet: paste their text under &ldquo;Text&rdquo; instead.</Note>
          </div>
        )}
        {tab === 'text' && (
          <div className="space-y-3">
            <Input label="Name" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Rate card" autoFocus />
            <Textarea label="Text" rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the facts, prices, FAQs or product notes the AI may use." hint="At least a few sentences." />
          </div>
        )}
        {tab === 'existing' && (
          <div className="space-y-2">
            <p className="text-xs text-gray-500">Sources already in this workspace. A source can be shared by several sequences.</p>
            {existing.isLoading ? <Spinner /> : existing.isError ? <ErrorBox message={errText(existing.error)} /> : (existing.data ?? []).length === 0 ? (
              <p className="text-sm text-gray-500">Nothing yet.</p>
            ) : (
              <ul className="divide-y divide-gray-100 max-h-72 overflow-y-auto">
                {/* a product catalogue is for websites only (the server refuses to attach one to a sequence) */}
                {(existing.data ?? []).filter((s) => s.kind !== 'catalogue').map((s) => {
                  const on = attached.includes(s.id);
                  return (
                    <li key={s.id} className="flex items-center gap-3 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-gray-900 truncate">{s.title}</div>
                        <div className="text-xs text-gray-500">{s.kind}{s.url ? ` · ${s.url}` : ''} · {KNOWLEDGE_STATUS_LABEL[s.status] ?? s.status}{s.chunks ? ` · ${s.chunks} parts` : ''} · used by {s.used_by}</div>
                      </div>
                      <Button size="sm" variant="secondary" disabled={on || busy} onClick={() => attachExisting(s.id)}>{on ? 'Attached' : 'Attach'}</Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
        {error && <ErrorBox message={error} />}
      </div>
    </Modal>
  );
}

function FaqModal({ sequenceId, ws, faqs, canEdit, onClose, notify }: { sequenceId: string; ws: string; faqs: Faq[]; canEdit: boolean; onClose: () => void; notify: (m: string, t?: 'success' | 'error') => void }) {
  const save = useFaqSave(sequenceId);
  const del = useFaqDelete(sequenceId);
  // shared pairs of the Knowledge library that this sequence also answers from: everywhere, or limited to it (switched-off pairs do not count)
  const library = useQaList(ws);
  const shared = (library.data ?? []).filter((p) => p.owner === 'library' && p.enabled && ((p.targets ?? []).length === 0 || (p.targets ?? []).some((t) => t.kind === 'sequence' && t.id === sequenceId))).length;
  const [editing, setEditing] = useState<{ id: string | null; question: string; answer: string } | null>(null);
  const [toDelete, setToDelete] = useState<Faq | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ok = !!editing && editing.question.trim().length > 0 && editing.question.length <= 500 && editing.answer.trim().length > 0 && editing.answer.length <= 2000;

  async function doSave() {
    if (!editing || !ok) return;
    setError(null);
    try { await save.mutateAsync({ id: editing.id, question: editing.question.trim(), answer: editing.answer.trim() }); setEditing(null); notify(editing.id ? 'Q&A saved.' : 'Q&A added.'); }
    catch (e) { setError(errText(e)); }
  }

  return (
    <Modal open onClose={onClose} title={`Q&A (${faqs.length})`} size="lg" footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      <div className="space-y-3">
        <p className="text-sm text-gray-600">Questions prospects ask and the answer the AI may give. Up to 30 pairs go into every reply; above that the AI looks up the matching ones.</p>
        {shared > 0 && (
          <p className="text-sm text-gray-600">
            {shared} shared {shared === 1 ? 'answer' : 'answers'} from Knowledge also {shared === 1 ? 'applies' : 'apply'} to this sequence. <Link href={hubHref.knowledge('qa')} className="text-indigo-600 hover:underline whitespace-nowrap">Open them in Knowledge</Link>
          </p>
        )}
        {canEdit && !editing && <Button size="sm" variant="secondary" onClick={() => setEditing({ id: null, question: '', answer: '' })}><Plus className="w-3.5 h-3.5" />Add Q&amp;A</Button>}
        {editing && (
          <div className="rounded-lg border border-indigo-200 bg-indigo-50/40 p-3 space-y-2">
            <Input label="Question" value={editing.question} maxLength={500} onChange={(e) => setEditing({ ...editing, question: e.target.value })} autoFocus />
            <Textarea label="Answer" rows={3} maxLength={2000} value={editing.answer} onChange={(e) => setEditing({ ...editing, answer: e.target.value })} />
            {error && <ErrorBox message={error} />}
            <div className="flex gap-2"><Button size="sm" onClick={doSave} loading={save.isPending} disabled={!ok}>Save</Button><Button size="sm" variant="ghost" onClick={() => { setEditing(null); setError(null); }}>Cancel</Button></div>
          </div>
        )}
        {faqs.length === 0 ? <p className="text-sm text-gray-500">No Q&amp;A yet.</p> : (
          <ul className="divide-y divide-gray-100">
            {faqs.map((f) => (
              <li key={f.id} className="py-2.5 flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-gray-900">{f.question}</div>
                  <div className="text-sm text-gray-700 whitespace-pre-wrap mt-0.5">{f.answer}</div>
                  <div className="text-xs text-gray-400 mt-0.5">{f.source === 'unanswered' ? 'From an unanswered question' : f.source === 'import' ? 'Copied' : 'Added by hand'} · {fmtDate(f.created_at, false)}{!f.enabled ? ' · off' : ''}</div>
                </div>
                {canEdit && (
                  <div className="flex items-center gap-0.5 flex-shrink-0">
                    <button type="button" aria-label="Edit" onClick={() => setEditing({ id: f.id, question: f.question, answer: f.answer })} className="p-1.5 rounded text-gray-500 hover:bg-gray-100"><Pencil className="w-4 h-4" /></button>
                    <button type="button" aria-label="Delete" onClick={() => setToDelete(f)} className="p-1.5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50"><Trash2 className="w-4 h-4" /></button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <ConfirmModal open={!!toDelete} onClose={() => setToDelete(null)} loading={del.isPending} title="Delete this Q&A?" confirmLabel="Delete"
        onConfirm={async () => { if (!toDelete) return; try { await del.mutateAsync(toDelete.id); setToDelete(null); } catch (e) { notify(errText(e), 'error'); setToDelete(null); } }}>
        <p>&ldquo;{toDelete?.question}&rdquo; is removed. If it came from an unanswered question, that question opens again.</p>
      </ConfirmModal>
    </Modal>
  );
}
