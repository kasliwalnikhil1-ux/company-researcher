'use client';

// Knowledge → + Website / + Document. The same fields, limits and wording as "Add knowledge" on a sequence's AI tab
// (components/outreach/sequences/ai/KnowledgeSection.tsx); here the new source is not attached anywhere: the caller
// opens "Use in…" for it next.
import { useRef, useState } from 'react';
import { uploadKnowledgeFile, useKnowledgeSourceAdd, type KnowledgeSource } from '@/lib/outreach/aiRepliesSequence';
import { KNOWLEDGE_FILE_ACCEPT, useInvalidateKnowledge } from '@/lib/outreach/aiHub';
import { Button, ErrorBox, Input, Modal, Textarea } from '@/components/outreach/ui';
import { Note } from '@/components/outreach/settings/shared';
import { errText } from '@/components/outreach/sequences/ai/shared';
import { Tabs } from '@/components/ui/Tabs';
import type { Notify } from './shared';

export interface AddedSource { id: string; title: string }
type AddProps = { ws: string; onClose: () => void; onAdded: (s: AddedSource) => void; notify: Notify };

// uploadKnowledgeFile() takes a folder name inside the bucket where a sequence passes its id
const LIBRARY_FOLDER = 'library';
const TEXT_MAX = 200_000;

export function AddWebsiteModal({ ws, onClose, onAdded, notify }: AddProps) {
  const add = useKnowledgeSourceAdd(ws);
  const invalidate = useInvalidateKnowledge(ws);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [refresh, setRefresh] = useState('');
  const [error, setError] = useState<string | null>(null);

  const days = refresh.trim() ? Number(refresh) : null;
  const daysOk = days === null || (Number.isInteger(days) && days >= 1 && days <= 90);
  const canSubmit = /^https?:\/\/[^\s/]+/.test(url.trim()) && daysOk;

  async function submit() {
    if (!canSubmit) return;
    setError(null);
    try {
      const address = url.trim();
      const host = (() => { try { return new URL(address).host; } catch { return address; } })();
      const name = title.trim() || host;
      const s: KnowledgeSource | null = await add.mutateAsync({ kind: 'website', title: name, url: address, refresh_days: days });
      invalidate();
      notify('Website added. Pages are read in the background; the status shows when it is ready.');
      if (s?.id) onAdded({ id: s.id, title: s.title || name }); else onClose();
    } catch (e) { setError(errText(e)); }
  }

  return (
    <Modal open onClose={onClose} title="Add a website" size="md"
      footer={<><Button variant="secondary" onClick={onClose} disabled={add.isPending}>Cancel</Button><Button onClick={submit} loading={add.isPending} disabled={!canSubmit}>Add</Button></>}>
      <div className="space-y-3">
        <Input label="Website address" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" autoFocus />
        <Input label="Name (optional)" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Defaults to the site name" />
        <Input type="number" min={1} max={90} label="Read it again every (days, optional)" value={refresh} onChange={(e) => setRefresh(e.target.value)}
          hint="Up to 60 pages on the same site are read. Leave empty to read it once." error={daysOk ? undefined : 'A whole number from 1 to 90, or leave it empty.'} />
        {error && <ErrorBox message={error} />}
      </div>
    </Modal>
  );
}

type DocTab = 'file' | 'text';
const DOC_TABS: Array<{ key: DocTab; label: string }> = [{ key: 'file', label: 'Upload a file' }, { key: 'text', label: 'Paste text' }];

export function AddDocumentModal({ ws, onClose, onAdded, notify }: AddProps) {
  const add = useKnowledgeSourceAdd(ws);
  const invalidate = useInvalidateKnowledge(ws);
  const [tab, setTab] = useState<DocTab>('file');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const canSubmit = tab === 'file' ? !!file : text.trim().length >= 20 && text.length <= TEXT_MAX;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true); setError(null);
    try {
      let s: KnowledgeSource | null;
      let name: string;
      if (tab === 'file') {
        name = title.trim() || file!.name;
        const path = await uploadKnowledgeFile(ws, LIBRARY_FOLDER, file!);
        s = await add.mutateAsync({ kind: 'document', title: name, storage_path: path });
      } else {
        name = title.trim() || text.trim().slice(0, 60);
        s = await add.mutateAsync({ kind: 'text', title: name, text: text.trim() });
      }
      invalidate();
      notify('Added. It is read in the background and used once it shows Ready.');
      if (s?.id) onAdded({ id: s.id, title: s.title || name }); else onClose();
    } catch (e) { setError(errText(e)); setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title="Add a document" size="md"
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={submit} loading={busy} disabled={!canSubmit}>Add</Button></>}>
      <div className="space-y-4">
        <Tabs label="How to add the document" value={tab} disabled={busy} onChange={(k) => { setTab(k); setError(null); }}
          items={DOC_TABS.map((t) => ({ value: t.key, label: t.label }))} />
        {tab === 'file' && (
          <div className="space-y-3">
            <input ref={fileRef} type="file" accept={KNOWLEDGE_FILE_ACCEPT} className="hidden" aria-label="File to upload" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()} disabled={busy}>Choose a file</Button>
              <span className="text-sm text-gray-700 truncate">{file ? `${file.name} (${Math.round(file.size / 1024)} KB)` : 'No file chosen'}</span>
            </div>
            <Input label="Name (optional)" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Defaults to the file name" />
            {/* the sequence modal's note, word for word; only the tab it points to has another name here */}
            <Note>Text, Markdown and HTML files are read. PDF and Word files are not extracted yet: paste their text under &ldquo;Paste text&rdquo; instead.</Note>
          </div>
        )}
        {tab === 'text' && (
          <div className="space-y-3">
            <Input label="Name" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Rate card" autoFocus />
            <Textarea label="Text" rows={8} maxLength={TEXT_MAX} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the facts, prices, FAQs or product notes the AI may use." hint="At least a few sentences." />
          </div>
        )}
        {error && <ErrorBox message={error} />}
      </div>
    </Modal>
  );
}
