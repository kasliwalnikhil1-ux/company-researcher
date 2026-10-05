'use client';

// Reply library + conversation branches. Each branch: the step that prompted it → a prospect
// message (fictional samples are marked) → our reply → any further turns.

import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, Copy, Eye, GitBranch, Plus, Search, Trash2 } from 'lucide-react';
import type { Conversation, Turn } from '@/lib/sequence-studio/types';
import { unescapeMd, uid } from '@/lib/sequence-studio/util';
import { stripOuterItalic } from '@/lib/sequence-studio/emailText';
import type { Studio } from './store';
import { blankReply, blankTurn, newConversation } from './mut';
import { TokenTextarea } from './TokenTextarea';
import { TextModeToggle } from './MessageTab';
import { Badge, Btn, Empty, Field, IconBtn, Input, SectionTitle, Seg, Select, cx } from './ui';

export default function RepliesTab({ studio, onPreviewConversation }: { studio: Studio; onPreviewConversation: (c: Conversation) => void }) {
  const { lib, ui, setUi, edit, focusConversation } = studio;
  const [view, setView] = useState<'replies' | 'branches'>('replies');
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  // The editor column is narrow, so the reply list and the open reply take turns (drill-down).
  const [showList, setShowList] = useState(true);
  const filtered = useMemo(() => {
    if (!lib) return [];
    const needle = q.trim().toLowerCase();
    return lib.replies.filter((r) => (!cat || r.categoryId === cat || (cat === '__none' && !r.categoryId)) && (!needle || `${r.title}\n${r.body}\n${r.group}`.toLowerCase().includes(needle)));
  }, [lib, q, cat]);
  if (!lib) return null;
  const ctx = { profile: lib.profiles.find((p) => p.id === lib.activeProfileId), variables: lib.variables };
  const reply = lib.replies.find((r) => r.id === ui.replyId) ?? filtered[0];
  const convsFor = (id: string) => lib.conversations.filter((c) => c.turns.some((t) => t.replyId === id));
  // Editing a reply's text previews a branch that sends it, preferring the sequence already open.
  const showReplyInPreview = (id: string) => {
    const list = convsFor(id);
    const conv = list.find((c) => c.sequenceId === ui.sequenceId) ?? list[0];
    if (conv) focusConversation(conv, conv.turns.find((t) => t.replyId === id)?.id);
  };

  const upReply = (fn: (r: NonNullable<typeof reply>) => void, key?: string) =>
    edit((d) => {
      const r = d.replies.find((x) => x.id === reply?.id);
      if (r) fn(r);
    }, key);
  const upConv = (id: string, fn: (c: Conversation) => void, key?: string) =>
    edit((d) => {
      const c = d.conversations.find((x) => x.id === id);
      if (c) fn(c);
    }, key);

  const categoryName = (id?: string) => lib.categories.find((c) => c.id === id)?.name ?? 'Uncategorised';

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Seg
          label="Replies view"
          value={view}
          onChange={setView}
          options={[
            { value: 'replies', label: `Reply library (${lib.replies.length})` },
            { value: 'branches', label: <span className="inline-flex items-center gap-1"><GitBranch className="h-3.5 w-3.5" />Branch overview</span> },
          ]}
        />
        <div className="ml-auto">
          <TextModeToggle studio={studio} />
        </div>
      </div>

      {view === 'branches' ? (
        <BranchOverview studio={studio} onPreview={onPreviewConversation} />
      ) : (
        <div className="min-h-0">
          {showList || !reply ? (
          <div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-2 h-4 w-4 text-gray-400" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search replies" aria-label="Search replies" className="pl-7" />
            </div>
            <Select aria-label="Filter by category" value={cat} onChange={(e) => setCat(e.target.value)} className="mt-1.5 w-full py-1 text-xs">
              <option value="">All categories</option>
              {lib.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({lib.replies.filter((r) => r.categoryId === c.id).length})
                </option>
              ))}
              <option value="__none">Uncategorised</option>
            </Select>
            <ul className="mt-2 max-h-[60vh] space-y-0.5 overflow-auto pr-1">
              {lib.categories.concat([{ id: '__none', name: 'Uncategorised', description: '', addedByTool: false }]).map((c) => {
                const items = filtered.filter((r) => (c.id === '__none' ? !r.categoryId || !lib.categories.some((x) => x.id === r.categoryId) : r.categoryId === c.id));
                if (!items.length) return null;
                return (
                  <li key={c.id}>
                    <div className="px-1 pb-0.5 pt-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">{c.name}</div>
                    {items.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => {
                          setUi({ replyId: r.id });
                          setShowList(false);
                        }}
                        className={cx('block w-full rounded px-2 py-1 text-left text-[13px] leading-5', r.id === reply?.id ? 'bg-indigo-50 font-medium text-indigo-700' : 'text-gray-800 hover:bg-gray-100')}
                      >
                        {unescapeMd(r.title)}
                        {r.internalNote && <span className={cx('ml-1 text-[10px]', 'text-amber-700')}>· note</span>}
                      </button>
                    ))}
                  </li>
                );
              })}
              {!filtered.length && <li className="px-2 py-3 text-xs text-gray-500">No replies match.</li>}
            </ul>
            <Btn
              size="sm"
              className="mt-2 w-full justify-center"
              onClick={() => {
                const r = blankReply(cat && cat !== '__none' ? cat : undefined);
                edit((d) => void d.replies.push(r));
                setUi({ replyId: r.id });
                setQ('');
                setShowList(false);
              }}
            >
              <Plus className="h-3.5 w-3.5" /> New reply
            </Btn>
          </div>
          ) : (
          <div className="min-w-0">
            {(
              <div className="space-y-3">
                <button type="button" onClick={() => setShowList(true)} className="inline-flex items-center gap-1 text-xs font-medium text-indigo-700 hover:underline">
                  <ChevronLeft className="h-3.5 w-3.5" /> All replies
                </button>
                <div className="flex items-start gap-2">
                  <Field label="Reply title" className="flex-1">
                    <Input value={reply.title} onChange={(e) => upReply((r) => void (r.title = e.target.value), `rt-${reply.id}`)} className="font-semibold" />
                  </Field>
                  <div className="flex items-center pt-5">
                    <IconBtn
                      label="Duplicate reply"
                      onClick={() => {
                        const c = { ...reply, id: uid('rep'), title: `${reply.title} (copy)` };
                        edit((d) => void d.replies.splice(d.replies.findIndex((x) => x.id === reply.id) + 1, 0, c));
                        setUi({ replyId: c.id });
                      }}
                    >
                      <Copy className="h-4 w-4" />
                    </IconBtn>
                    <IconBtn
                      label="Delete reply"
                      onClick={() => {
                        if (!window.confirm(`Delete reply "${unescapeMd(reply.title)}"? Branches using it keep its text as custom text. You can undo this.`)) return;
                        edit((d) => {
                          for (const c of d.conversations)
                            for (const t of c.turns)
                              if (t.replyId === reply.id) {
                                t.text = reply.body;
                                t.custom = true;
                                t.replyId = undefined;
                              }
                          d.replies = d.replies.filter((x) => x.id !== reply.id);
                        });
                        setUi({ replyId: undefined });
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </IconBtn>
                  </div>
                </div>
                <div className="flex flex-wrap gap-3">
                  <Field label={<>Category {reply.categoryIsSuggested && <Badge tone="amber" title="Suggested by the tool from the title">suggested by tool</Badge>}</>}>
                    <Select value={reply.categoryId ?? ''} onChange={(e) => upReply((r) => { r.categoryId = e.target.value || undefined; r.categoryIsSuggested = false; })}>
                      <option value="">Uncategorised</option>
                      {lib.categories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                          {c.addedByTool ? ' (added by tool)' : ''}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Source group">
                    <Input value={reply.group} onChange={(e) => upReply((r) => void (r.group = e.target.value), `rg-${reply.id}`)} className="w-full max-w-[14rem]" />
                  </Field>
                </div>
                {reply.categoryId && <p className="-mt-1 text-xs text-gray-500">{categoryName(reply.categoryId)}: {lib.categories.find((c) => c.id === reply.categoryId)?.description}</p>}
                <Field label="Our response">
                  <div onFocusCapture={() => showReplyInPreview(reply.id)}>
                  <TokenTextarea label="Our response" value={reply.body} ctx={ctx} mode={ui.textMode} minRows={2} onChange={(v) => upReply((r) => void (r.body = v), `rb-${reply.id}`)} />
                  </div>
                </Field>
                <Field label={<span className="text-amber-800">Internal note — never sent, never shown in previews</span>}>
                  <TokenTextarea label="Internal note" tone="note" value={reply.internalNote} ctx={ctx} mode="raw" minRows={1} placeholder="e.g. check the contract matches this" onChange={(v) => upReply((r) => void (r.internalNote = v), `rn-${reply.id}`)} />
                  {reply.internalNote && <span className="mt-0.5 block text-[11px] text-amber-800">Shown to you as: {stripOuterItalic(reply.internalNote)}</span>}
                </Field>

                <SectionTitle
                  actions={
                    <Btn
                      size="sm"
                      tone="ghost"
                      onClick={() => {
                        const seq = lib.sequences.find((s) => s.id === ui.sequenceId) ?? lib.sequences[0];
                        if (!seq?.steps[0]) return;
                        edit((d) => void d.conversations.push(newConversation(d, seq.id, ui.stepId && seq.steps.some((s) => s.id === ui.stepId) ? ui.stepId : seq.steps[0].id, reply)));
                      }}
                    >
                      <Plus className="h-3.5 w-3.5" /> Add branch
                    </Btn>
                  }
                >
                  Conversations using this reply
                </SectionTitle>
                {!convsFor(reply.id).length && <Empty>No conversation uses this reply yet. Add a branch to preview it after any step.</Empty>}
                {convsFor(reply.id).map((c) => (
                  <ConversationEditor key={c.id} studio={studio} conv={c} upConv={upConv} onPreview={() => onPreviewConversation(c)} />
                ))}
              </div>
            )}
          </div>
          )}
        </div>
      )}
    </div>
  );
}

function ConversationEditor({ studio, conv, upConv, onPreview }: { studio: Studio; conv: Conversation; upConv: (id: string, fn: (c: Conversation) => void, key?: string) => void; onPreview: () => void }) {
  const { lib, edit, ui } = studio;
  if (!lib) return null;
  const ctx = { profile: lib.profiles.find((p) => p.id === lib.activeProfileId), variables: lib.variables };
  const seq = lib.sequences.find((s) => s.id === conv.sequenceId);
  const active = ui.preview.mode === 'conversation' && ui.conversationId === conv.id;
  return (
    <div className={cx('rounded-xl border p-3', active ? 'border-indigo-400 ring-1 ring-indigo-200' : 'border-gray-200')} onFocusCapture={() => studio.focusConversation(conv)}>
      <div className="flex flex-wrap items-center gap-2">
        <Input aria-label="Branch name" value={conv.name} onChange={(e) => upConv(conv.id, (c) => void (c.name = e.target.value), `cn-${conv.id}`)} className="min-w-[140px] flex-1 py-1 text-sm font-medium" />
        <Btn size="sm" tone={active ? 'primary' : 'default'} onClick={onPreview}>
          <Eye className="h-3.5 w-3.5" /> Preview exchange
        </Btn>
        <IconBtn
          label="Delete branch"
          onClick={() => {
            if (window.confirm(`Delete the branch "${conv.name}"? You can undo this.`)) edit((d) => void (d.conversations = d.conversations.filter((x) => x.id !== conv.id)));
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </IconBtn>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-gray-600">Prospect replies after</span>
        <Select
          aria-label="Sequence"
          value={conv.sequenceId}
          onChange={(e) => {
            const s = lib.sequences.find((x) => x.id === e.target.value);
            upConv(conv.id, (c) => {
              c.sequenceId = e.target.value;
              c.afterStepId = s?.steps[0]?.id ?? '';
              c.connectionIsSuggested = false;
            });
          }}
          className="max-w-[200px] py-1 text-xs"
        >
          {lib.sequences.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        <Select aria-label="Step that prompted the reply" value={conv.afterStepId} onChange={(e) => upConv(conv.id, (c) => { c.afterStepId = e.target.value; c.connectionIsSuggested = false; })} className="max-w-[220px] py-1 text-xs">
          {seq?.steps.map((st, i) => (
            <option key={st.id} value={st.id}>
              Step {i + 1}: {st.name}
            </option>
          ))}
        </Select>
        {conv.connectionIsSuggested && <Badge tone="amber" title="The tool picked this step; the source does not say">step suggested by tool</Badge>}
      </div>
      <ol className="mt-3 space-y-2">
        {conv.turns.map((t, k) => (
          <TurnEditor key={t.id} studio={studio} conv={conv} turn={t} index={k} ctx={ctx} upConv={upConv} />
        ))}
      </ol>
      <div className="mt-2 flex flex-wrap gap-2">
        <Btn size="sm" tone="ghost" onClick={() => upConv(conv.id, (c) => void c.turns.push(blankTurn('prospect')))}>
          <Plus className="h-3.5 w-3.5" /> Prospect message
        </Btn>
        <Btn size="sm" tone="ghost" onClick={() => upConv(conv.id, (c) => void c.turns.push(blankTurn('us')))}>
          <Plus className="h-3.5 w-3.5" /> Our response
        </Btn>
        <Btn size="sm" tone="ghost" onClick={() => upConv(conv.id, (c) => void c.turns.push(blankTurn('prospect'), blankTurn('us')))}>
          <Plus className="h-3.5 w-3.5" /> Another exchange
        </Btn>
      </div>
    </div>
  );
}

function TurnEditor({ studio, conv, turn, index, ctx, upConv }: { studio: Studio; conv: Conversation; turn: Turn; index: number; ctx: Parameters<typeof TokenTextarea>[0]['ctx']; upConv: (id: string, fn: (c: Conversation) => void, key?: string) => void }) {
  const { lib, ui, edit } = studio;
  if (!lib) return null;
  const reply = lib.replies.find((r) => r.id === turn.replyId);
  const upTurn = (fn: (t: Turn) => void, key?: string) => upConv(conv.id, (c) => fn(c.turns.find((x) => x.id === turn.id)!), key);
  return (
    <li className={cx('rounded-md border px-2.5 py-2', turn.role === 'prospect' ? 'border-sky-200 bg-sky-50/50' : 'border-gray-200 bg-white')} onFocusCapture={() => studio.focusConversation(conv, turn.id)}>
      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold text-gray-800">{turn.role === 'prospect' ? 'Prospect' : 'Us'}</span>
        {turn.sample && <Badge tone="sky" title="The source has no incoming messages; this one is fictional sample content">fictional sample</Badge>}
        {turn.role === 'us' && (
          <>
            <Select
              aria-label="Our reply"
              value={turn.custom ? '__custom' : turn.replyId ?? '__custom'}
              onChange={(e) =>
                upTurn((t) => {
                  if (e.target.value === '__custom') {
                    t.custom = true;
                    t.text ||= reply?.body ?? '';
                  } else {
                    t.replyId = e.target.value;
                    t.custom = false;
                  }
                })
              }
              className="max-w-[220px] py-0.5 text-xs"
            >
              <option value="__custom">Custom text for this branch</option>
              {lib.replies.map((r) => (
                <option key={r.id} value={r.id}>
                  {unescapeMd(r.title)}
                </option>
              ))}
            </Select>
            {!turn.custom && reply && <span className="text-gray-500">Editing here changes the library reply.</span>}
          </>
        )}
        <div className="ml-auto flex items-center">
          <IconBtn label="Move up" disabled={index === 0} className="h-6 w-6" onClick={() => upConv(conv.id, (c) => void c.turns.splice(index - 1, 0, c.turns.splice(index, 1)[0]))}>
            <ArrowUp className="h-3 w-3" />
          </IconBtn>
          <IconBtn label="Move down" disabled={index === conv.turns.length - 1} className="h-6 w-6" onClick={() => upConv(conv.id, (c) => void c.turns.splice(index + 1, 0, c.turns.splice(index, 1)[0]))}>
            <ArrowDown className="h-3 w-3" />
          </IconBtn>
          <IconBtn label="Remove message" className="h-6 w-6" onClick={() => upConv(conv.id, (c) => void c.turns.splice(index, 1))}>
            <Trash2 className="h-3 w-3" />
          </IconBtn>
        </div>
      </div>
      {turn.role === 'prospect' || turn.custom || !reply ? (
        <TokenTextarea
          label={turn.role === 'prospect' ? 'Prospect message' : 'Our custom response'}
          value={turn.text}
          ctx={ctx}
          mode={ui.textMode}
          minRows={2}
          placeholder={turn.role === 'prospect' ? 'What the prospect writes…' : 'Our response…'}
          onChange={(v) => upTurn((t) => {
            t.text = v;
            t.sample = false;
          }, `turn-${turn.id}`)}
        />
      ) : (
        <TokenTextarea label={`Our response: ${reply.title}`} value={reply.body} ctx={ctx} mode={ui.textMode} minRows={2} onChange={(v) => edit((d) => void (d.replies.find((r) => r.id === reply.id)!.body = v), `rb-${reply.id}`)} />
      )}
    </li>
  );
}

function BranchOverview({ studio, onPreview }: { studio: Studio; onPreview: (c: Conversation) => void }) {
  const { lib, ui, setUi } = studio;
  const [seqId, setSeqId] = useState(ui.sequenceId);
  const [cat, setCat] = useState('');
  if (!lib) return null;
  const seq = lib.sequences.find((s) => s.id === seqId) ?? lib.sequences[0];
  if (!seq) return <Empty>No sequences.</Empty>;
  const convs = lib.conversations.filter((c) => c.sequenceId === seq.id);
  const catOf = (c: Conversation) => lib.replies.find((r) => r.id === c.turns.find((t) => t.role === 'us')?.replyId)?.categoryId;
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
        <Select aria-label="Sequence" value={seq.id} onChange={(e) => setSeqId(e.target.value)} className="py-1 text-xs">
          {lib.sequences.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({lib.conversations.filter((c) => c.sequenceId === s.id).length})
            </option>
          ))}
        </Select>
        <Select aria-label="Category" value={cat} onChange={(e) => setCat(e.target.value)} className="py-1 text-xs">
          <option value="">All categories</option>
          {lib.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <span className="text-xs text-gray-500">Click a branch to open that conversation in the Gmail preview.</span>
      </div>
      <ol className="space-y-3">
        {seq.steps.map((st, i) => {
          const list = convs.filter((c) => c.afterStepId === st.id && (!cat || catOf(c) === cat));
          return (
            <li key={st.id}>
              <div className="flex items-center gap-2 text-sm font-medium text-gray-900">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-indigo-600 text-[11px] text-white">{i + 1}</span>
                {st.name}
                <span className="text-xs font-normal text-gray-500">{list.length} branch{list.length === 1 ? '' : 'es'}</span>
              </div>
              {list.length > 0 && (
                <ul className="ml-2.5 mt-1 border-l border-gray-200 pl-4">
                  {list.map((c) => {
                    const first = c.turns.find((t) => t.role === 'prospect');
                    const ours = c.turns.find((t) => t.role === 'us');
                    const r = lib.replies.find((x) => x.id === ours?.replyId);
                    const active = ui.preview.mode === 'conversation' && ui.conversationId === c.id;
                    return (
                      <li key={c.id}>
                        <button
                          type="button"
                          onClick={() => {
                            onPreview(c);
                            if (r) setUi({ replyId: r.id });
                          }}
                          className={cx('my-0.5 flex w-full flex-wrap items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs', active ? 'bg-indigo-50 ring-1 ring-indigo-300' : 'hover:bg-gray-50')}
                        >
                          <span className="text-sky-800">“{first?.text || '…'}”</span>
                          {first?.sample && <Badge tone="sky">sample</Badge>}
                          <span className="text-gray-400">→</span>
                          <span className="font-medium text-gray-900">{r ? unescapeMd(r.title) : ours?.custom ? 'Custom response' : 'No response yet'}</span>
                          {r?.categoryId && <Badge tone="gray">{lib.categories.find((x) => x.id === r.categoryId)?.name}</Badge>}
                          {c.turns.length > 2 && <span className="text-gray-500">+{c.turns.length - 2} more</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
