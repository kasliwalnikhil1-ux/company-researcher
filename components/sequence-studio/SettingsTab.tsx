'use client';

import { Plus, Trash2 } from 'lucide-react';
import { uid } from '@/lib/sequence-studio/util';
import type { Studio } from './store';
import { TokenTextarea } from './TokenTextarea';
import { Btn, Field, IconBtn, Input, SectionTitle, Seg, Toggle, ToolDefault } from './ui';

export default function SettingsTab({ studio }: { studio: Studio }) {
  const { lib, edit, resetToSource } = studio;
  if (!lib) return null;
  const ctx = { profile: lib.profiles.find((p) => p.id === lib.activeProfileId), variables: lib.variables };
  const s = lib.settings;
  return (
    <div>
      <Field label="Library title">
        <Input value={lib.title} onChange={(e) => edit((d) => void (d.title = e.target.value), 'title')} />
      </Field>

      <SectionTitle>Sender</SectionTitle>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label={<>Name {lib.senderIsDefault && <ToolDefault what="sample sender — edit" />}</>}>
          <Input value={lib.sender.name} onChange={(e) => edit((d) => { d.sender.name = e.target.value; d.senderIsDefault = false; }, 'sender-name')} />
        </Field>
        <Field label="Email address">
          <Input value={lib.sender.email} onChange={(e) => edit((d) => { d.sender.email = e.target.value; d.senderIsDefault = false; }, 'sender-email')} />
        </Field>
      </div>
      <Field className="mt-2" label={<>Signature {lib.signatureIsDefault && <ToolDefault what="added by tool — not in source" />}</>} hint="Added under every step that has “Add signature” on, and under our replies. Line breaks are kept.">
        <TokenTextarea label="Signature" value={lib.signature} ctx={ctx} mode="raw" minRows={2} onChange={(v) => edit((d) => { d.signature = v; d.signatureIsDefault = false; }, 'signature')} />
      </Field>
      <p className="mt-1 text-xs text-gray-500">Recipient names and addresses belong to each sample prospect (Variables tab).</p>

      <SectionTitle>Sending simulation</SectionTitle>
      <div className="space-y-3">
        <div>
          <Toggle checked={s.stopOnReply} onChange={(v) => edit((d) => void (d.settings.stopOnReply = v))} label="Stop follow-ups when the prospect replies" />
          <span className="mt-1 block pl-11 text-xs text-gray-500">On by default. Off: remaining steps keep sending on schedule after a reply (shown in reply previews).</span>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="First step sent at">
            <Input type="datetime-local" value={s.startAt} onChange={(e) => edit((d) => void (d.settings.startAt = e.target.value), 'start')} />
          </Field>
          <Field label="Prospect replies after (hours)">
            <Input type="number" min={0} value={s.replyAfterHours} onChange={(e) => edit((d) => void (d.settings.replyAfterHours = Math.max(0, Number(e.target.value) || 0)), 'rah')} />
          </Field>
          <Field label="We answer after (hours)">
            <Input type="number" min={0} value={s.answerAfterHours} onChange={(e) => edit((d) => void (d.settings.answerAfterHours = Math.max(0, Number(e.target.value) || 0)), 'aah')} />
          </Field>
        </div>
        <Field label="How the body is delivered" hint={s.bodyFormat === 'html' ? 'HTML: Markdown is rendered — **bold**, [links](…), lists; escapes like \\$ show as $.' : 'Plain text: delivered as typed. Line breaks stay where you put them, **asterisks** stay visible, only backslash escapes are removed. Gmail still makes URLs clickable.'}>
          <Seg
            label="Body format"
            value={s.bodyFormat}
            onChange={(v) => edit((d) => void (d.settings.bodyFormat = v))}
            options={[
              { value: 'html', label: 'HTML (rendered Markdown)' },
              { value: 'plain', label: 'Plain text' },
            ]}
          />
        </Field>
      </div>

      <SectionTitle
        actions={
          <Btn size="sm" tone="ghost" onClick={() => edit((d) => void d.categories.push({ id: uid('cat'), name: 'New category', description: '', addedByTool: false }))}>
            <Plus className="h-3.5 w-3.5" /> Add category
          </Btn>
        }
      >
        Reply categories
      </SectionTitle>
      <ul className="space-y-1.5">
        {lib.categories.map((c) => (
          <li key={c.id} className="flex items-start gap-2">
            <Input aria-label="Category name" value={c.name} onChange={(e) => edit((d) => void (d.categories.find((x) => x.id === c.id)!.name = e.target.value), `cat-${c.id}`)} className="w-44 py-1 text-sm" />
            <Input aria-label="Category description" value={c.description} onChange={(e) => edit((d) => void (d.categories.find((x) => x.id === c.id)!.description = e.target.value), `catd-${c.id}`)} className="flex-1 py-1 text-xs" />
            {c.addedByTool && <ToolDefault what="added by tool" />}
            <IconBtn
              label="Delete category"
              onClick={() => {
                if (window.confirm(`Delete category "${c.name}"? Its replies become uncategorised. You can undo this.`))
                  edit((d) => {
                    d.categories = d.categories.filter((x) => x.id !== c.id);
                    for (const r of d.replies) if (r.categoryId === c.id) r.categoryId = undefined;
                  });
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </IconBtn>
          </li>
        ))}
      </ul>

      <SectionTitle>Markdown format</SectionTitle>
      <div className="space-y-1 text-xs leading-5 text-gray-600">
        <p>
          Exports are readable Markdown. JSON front matter (valid YAML) holds the sender, signature, settings, variables with fallbacks, the fictional sample prospects and categories. The body has
          <b> Guidance</b>, <b>Sequences</b> (steps, subject variants, versions), the <b>Reply library</b> (with internal notes) and <b>Conversations</b> (reply branches).
        </p>
        <p>
          Each item has a heading plus an invisible <code className="rounded bg-gray-100 px-1">{'<!-- studio:… -->'}</code> comment with its ids and settings. Its text sits verbatim between <code className="rounded bg-gray-100 px-1">{'<!-- studio:text … -->'}</code> markers, so placeholders, <code>\$</code>, hard line breaks and links are kept exactly. Italic summary lines are regenerated on export and ignored on import. Text added outside the markers is kept as an “unmapped” block on import, never dropped.
        </p>
        <p>Other Markdown files are imported heuristically, and you review the proposed structure before anything is applied.</p>
      </div>

      <SectionTitle>Saved work</SectionTitle>
      <p className="mb-2 text-xs text-gray-600">Your edits are saved in this browser only (local storage), with undo/redo for this session. Nothing is uploaded or sent.</p>
      <Btn
        tone="danger"
        onClick={() => {
          if (window.confirm(`Replace the whole library with a fresh import of ${lib.sourceFileName || 'the source file'}? You can undo this.`)) resetToSource();
        }}
      >
        Reset to the original source file
      </Btn>
    </div>
  );
}
