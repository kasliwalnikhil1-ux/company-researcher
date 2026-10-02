/**
 * Demo edge functions: ai-reply, ai-variables, ai-sequence-qa. Every text comes from the local generator (../ai.ts):
 * sample output, labelled `model: 'demo-sample'`. Nothing is sent to a model.
 */
import { validateGraph } from '../../../graph';
import type { Graph, Provider } from '../../../types';
import { demoError, type Ctx, type FnArea } from '../ctx';
import { DEMO_USER_EMAIL } from '../seed/ids';
import type { DemoStore, Row } from '../store';
import { DEMO_MODEL, generateFor, pump } from '../aihub/jobs';
import { bump, ensureSeqSettings, mpJson } from '../aihub/prompt';
import { attachAi, chatSequence, classify, effective, openRun, planReply, runJson, sendRun, updateRun } from '../aihub/replies';
import { linkedinPool, liveConsent, pendingLink, seqOrThrow, seqRepliesSet } from '../aihub/sequence';

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const DAY = 86_400_000;
const str = (v: unknown) => String(v ?? '').trim();

function st(ctx: Ctx): DemoStore { attachAi(ctx.store); pump(ctx.store); return ctx.store; }

// ---------------------------------------------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------------------------------------------
const ownerIsMe = (s: Row, ctx: Ctx) => s.owner_user_id === ctx.userId || str(s.owner_email).toLowerCase() === DEMO_USER_EMAIL.toLowerCase();

function grant(store: DemoStore, s: Row, ctx: Ctx): Row {
  const cap = store.get('outreach_workspace_reply_settings', s.workspace_id, 'workspace_id')?.max_ai_sends_per_sender_day ?? 25;
  store.update('outreach_ai_reply_consent', (k) => k.sender_id === s.id && !k.revoked_at, { revoked_at: iso(), revoked_reason: 'replaced' });
  return store.insert('outreach_ai_reply_consent', {
    workspace_id: s.workspace_id, sender_id: s.id, master_prompt_id: null, master_prompt_version: null, granted_by_email: DEMO_USER_EMAIL, granted_via: 'owner_is_operator',
    scope: { daily_cap: cap, grant: 'AI may reply as me in the sequences my team turns on.' }, evidence: { user_id: ctx.userId, at: iso() }, granted_at: iso(), expires_at: iso(Date.now() + 365 * DAY),
    revoked_at: null, revoked_reason: null, revoke_token_hash: null,
  })[0];
}
function requestLink(store: DemoStore, s: Row, ctx: Ctx): Row {
  const old = pendingLink(store, s.id);
  if (old) return old;
  const cap = store.get('outreach_workspace_reply_settings', s.workspace_id, 'workspace_id')?.max_ai_sends_per_sender_day ?? 25;
  return store.insert('outreach_ai_reply_consent_links', {
    workspace_id: s.workspace_id, sender_id: s.id, master_prompt_id: null, master_prompt_version: null, email: s.owner_email ?? null, token_hash: `demo-${store.uid()}`,
    scope: { daily_cap: cap }, examples: [], created_by: ctx.userId, expires_at: iso(Date.now() + 7 * DAY), used_at: null, cancelled_at: null,
  })[0];
}
const linkUrl = (l: Row) => `https://example.com/ai-consent/${String(l.id).slice(0, 8)}`;

function consentRequest(store: DemoStore, ctx: Ctx, senderId: string): Row {
  const s = store.get('outreach_senders', senderId);
  if (!s || s.deleted_at) demoError('E_NOT_FOUND', 'sender');
  if (liveConsent(store, s!.id)) return { granted: true, already: true, sender_name: s!.display_name ?? null };
  if (ownerIsMe(s!, ctx)) { grant(store, s!, ctx); return { granted: true, sender_name: s!.display_name ?? null }; }
  const l = requestLink(store, s!, ctx);
  ctx.ui.simulated();
  return { link: linkUrl(l), emailed: !!s!.owner_email, expires_at: l.expires_at, sender_name: s!.display_name ?? null };
}

// ---------------------------------------------------------------------------------------------------------------
// Drafts, simulate, regression
// ---------------------------------------------------------------------------------------------------------------
function lastInbound(store: DemoStore, chatId: string): Row[] {
  const msgs = store.t('outreach_messages').filter((m) => m.chat_id === chatId && !m.deleted_at).sort((a, b) => String(a.sent_at).localeCompare(String(b.sent_at)));
  const out: Row[] = [];
  for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i].direction !== 'in') break; out.unshift(msgs[i]); }
  return out.length ? out : msgs.filter((m) => m.direction === 'in').slice(-1);
}

function variantText(text: string): string {
  return text.replace(/^Thanks( for)?/, 'Appreciate').replace(/Would a quick call later this week work for you\?/, 'Open to a short call this week?').replace(/Happy to show you in 15 minutes this week\?/, 'Want me to walk you through it on a 15-minute call?');
}

function draftOf(store: DemoStore, r: Row, variant = false): Row {
  const j = runJson(store, r)!;
  return {
    run_id: r.id, text: variant && j.draft_text ? variantText(j.draft_text) : j.draft_text, decision: j.decision, stage_before: j.stage_before, stage_after: j.stage_after, move: j.move,
    rule_applied: j.rule_applied, scenario_id: j.scenario_id, scenario_title: j.scenario_title, facts_used: j.facts_used, side_effects: j.side_effects, warnings: j.warnings,
    would_stop: !!j.stop_after_send, stop_rule: j.stop_rule, escalation_reasons: j.escalation_reasons, version: j.master_prompt_version, status: j.status,
    scheduled_send_at: j.scheduled_send_at, trigger: j.trigger, guidance: j.guidance, ...(variant ? { variant: true } : {}),
  };
}

function improve(text: string): string {
  let t = text.replace(/\s+/g, ' ').trim()
    .replace(/\bI hope this (message )?finds you well[.,!]?\s*/gi, '')
    .replace(/\bjust (wanted to|wanted)\b/gi, 'wanted to').replace(/\b(kind of|sort of|basically|actually)\s+/gi, '').replace(/\bI think\s+/gi, '');
  if (!t) return text;
  t = t.charAt(0).toUpperCase() + t.slice(1);
  if (!/[.!?]$/.test(t)) t += '.';
  if (!t.includes('?')) t += ' Would a quick call this week work for you?';
  return t;
}

function simulateThread(store: DemoStore, body: Row): Row {
  const thread: Row[] = Array.isArray(body.thread) ? body.thread : [];
  const seqId = body.sequence_id ?? null;
  const mp = seqId ? store.get('outreach_master_prompts', ensureSeqSettings(store, seqId).master_prompt_id) : undefined;
  const lastUs = thread.map((t) => t.from).lastIndexOf('us');
  const inbound = thread.slice(lastUs + 1).filter((t) => t.from === 'prospect').map((t, i) => ({ id: `sim-${i}`, text: String(t.text ?? ''), intent: null }));
  const state = body.state ?? {};
  const chat: Row = { id: 'simulated', lead_id: null, attendee_name: body.lead?.full_name ?? 'Alex', sender_id: body.sender_id ?? null, conversation_stage: state.stage ?? null, intent: null };
  const t0 = Date.now();
  const p = planReply(store, chat, inbound.length ? inbound : [{ id: 'sim', text: '' }], { mpId: mp?.id ?? null, sequenceId: seqId });
  const text = inbound.map((m) => m.text).join('\n');
  const asked = p.intent === 'question' && !p.facts_used.length ? text.split(/(?<=\?)/).find((x) => x.includes('?'))?.trim() ?? null : null;
  return {
    decision: p.decision, final_decision: p.decision, text: p.text, stage_before: p.stage_before, stage_after: p.stage_after, move: p.move, rule_applied: p.rule_applied,
    side_effects: p.side_effects, facts_used: p.facts_used, confidence: p.confidence, escalation_reasons: p.escalation_reasons,
    validator: { ok: true }, verifier: p.text ? { supported: true, unsupported_claims: [], follows_rule: true, answers_their_questions: !asked, note: 'Sample AI output' } : null,
    classification: [{ intent: p.intent, flags: p.flags, summary: classify(text) === p.intent ? null : p.intent }],
    gates: [{ gate: 'G2', ok: true }, { gate: 'G4', ok: true }, { gate: 'G7', ok: true }, { gate: 'G11', ok: true }, { gate: 'G12', ok: true }],
    redrafted: false, state_after: { stage: p.stage_after, exchanges: Number(state.exchanges ?? 0) + 1, last_move: p.move, ai_replies_count: Number(state.ai_replies_count ?? 0) + (p.decision === 'send' ? 1 : 0) },
    model: DEMO_MODEL, ms: 700 + (Date.now() - t0),
    scenario_id: p.scenario_id, scenario_title: p.scenario_id ? store.get('outreach_master_prompt_scenarios', p.scenario_id)?.title ?? null : null,
    would_stop: p.stop_after_send, stop_rule: p.stop_rule, knowledge_used: [], faqs_used: p.facts_used.map((f) => f.claim), lead_notes_used: false, session: 'normal', unanswered_question: asked,
  };
}

function regression(store: DemoStore, ctx: Ctx, body: Row): Row {
  const mpId = body.master_prompt_id ?? (body.sequence_id ? ensureSeqSettings(store, body.sequence_id, ctx.userId).master_prompt_id : null);
  const mp = mpId ? store.get('outreach_master_prompts', mpId) : undefined;
  const tests = store.t('outreach_ai_reply_scenarios').filter((s) => s.workspace_id === (body.workspace_id ?? ctx.ws) && (s.master_prompt_id ?? null) === (mpId ?? null));
  const results = tests.map((s) => {
    const prev: Row[] = s.last_result?.turns ?? [];
    const turns = ((s.expected ?? []) as Row[]).map((e) => {
      const got = simulateThread(store, { sequence_id: mp?.sequence_id ?? null, thread: (s.turns as Row[]).slice(0, Number(e.after_turn) + 1) });
      const prevText = prev.find((x) => x.after_turn === e.after_turn)?.got?.text ?? null;
      return { after_turn: e.after_turn, expected: { decision: e.decision, stage_after: e.stage_after ?? null }, got: { decision: got.decision, stage_after: got.stage_after, text: got.text }, prev_text: prevText, changed: prevText != null && prevText !== got.text };
    });
    const passed = turns.every((t) => t.expected.decision === t.got.decision && (!t.expected.stage_after || t.expected.stage_after === t.got.stage_after));
    store.update('outreach_ai_reply_scenarios', s.id, { last_result: { turns }, last_version: mp?.version ?? null, last_run_at: iso(), passed, updated_at: iso() });
    return { scenario_id: s.id, name: s.name, passed, turns };
  });
  return { total: results.length, passed: results.filter((r) => r.passed).length, results };
}

// ---------------------------------------------------------------------------------------------------------------
// AI variables: preview and routing test
// ---------------------------------------------------------------------------------------------------------------
function routeLeads(store: DemoStore, ctx: Ctx, body: Row): Row {
  let routes: Row[] = Array.isArray(body.routes) ? body.routes.filter((r: Row) => r && str(r.id)).slice(0, 12) : [];
  if (!routes.length) {
    const s = body.sequence_id ? store.get('outreach_sequences', body.sequence_id) : undefined;
    const node = s ? (s.draft_graph?.nodes?.[body.node_id] ?? s.graph?.nodes?.[body.node_id]) : undefined;
    if (!node) demoError('E_NOT_FOUND', 'step not found in this sequence. Save the draft first.');
    if (node.type !== 'ai_route') demoError('E_PAYLOAD_INVALID', 'this step is not an AI routing step');
    routes = node.config?.routes ?? [];
  }
  if (!routes.length) demoError('E_PAYLOAD_INVALID', 'describe at least one branch before testing');
  const ws = body.workspace_id ?? ctx.ws;
  const ids: string[] = Array.isArray(body.lead_ids) ? body.lead_ids.slice(0, 20) : [];
  let leads = store.t('outreach_leads').filter((l) => l.workspace_id === ws && (!ids.length || ids.includes(l.id)));
  if (!ids.length) {
    const n = Math.max(1, Math.min(Number(body.sample ?? 20), 20));
    leads = [...leads].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 120);
    const picked: Row[] = [];
    while (picked.length < n && leads.length) picked.push(leads.splice(store.int(0, leads.length - 1), 1)[0]);
    leads = picked;
  }
  const split: Record<string, number> = Object.fromEntries([...routes.map((r) => [r.id, 0]), ['else', 0]]);
  const results = leads.map((l) => {
    const hay = [l.title, l.company, l.headline, l.custom?.industry, l.custom?.company_size, l.location].join(' ').toLowerCase();
    let best: { id: string; score: number; word: string } | null = null;
    for (const r of routes) {
      const words = `${r.label ?? ''} ${r.description ?? ''}`.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
      const hit = words.filter((w) => hay.includes(w.replace(/s$/, '')));
      if (hit.length && (!best || hit.length > best.score)) best = { id: r.id, score: hit.length, word: hit[0] };
    }
    const branch = best?.id ?? 'else';
    split[branch] = (split[branch] ?? 0) + 1;
    const label = routes.find((r) => r.id === branch)?.label ?? 'None of the branches';
    return {
      lead_id: l.id, name: l.full_name ?? null, company: l.company ?? null, branch,
      reason: best ? `Sample AI output: "${best.word}" in their profile fits ${label}` : 'Sample AI output: nothing in the profile matches a branch',
      facts: [`Title: ${l.title ?? ''}`, `Company: ${l.company ?? ''}`, ...(l.custom?.industry ? [`Industry: ${l.custom.industry}`] : [])],
    };
  });
  return { split, results, failed: [], tested: results.length, not_tested: 0, routes: routes.map((r) => ({ id: r.id, label: r.label ?? r.id })), stored: false };
}

function previewVariable(store: DemoStore, ctx: Ctx, body: Row): Row {
  if (!body.lead_id) demoError('E_PAYLOAD_INVALID', 'workspace_id and lead_id required');
  const saved = body.variable_id ? store.get('outreach_ai_variables', body.variable_id) : undefined;
  if (body.variable_id && !saved) demoError('E_NOT_FOUND', 'variable not found');
  const draft: Row = body.variable && typeof body.variable === 'object' ? body.variable : body;
  const lead = store.get('outreach_leads', body.lead_id);
  if (!lead) demoError('E_NOT_FOUND', 'lead not found');
  const profile = store.get('outreach_lead_profiles', lead!.id, 'lead_id');
  if (saved?.builtin) {
    const src = saved.key === 'contact_first_name' ? [lead!.first_name, lead!.full_name] : saved.key === 'company_conversation' ? [profile?.current_company, lead!.company] : [profile?.current_title, lead!.title];
    const raw = src.map((x) => str(x)).find(Boolean) ?? '';
    const text = saved.key === 'company_conversation' ? raw.replace(/\s+(Inc|LLC|Ltd|GmbH|Co)\.?$/i, '') : saved.key === 'position_conversational' ? raw.replace(/^(Chief Executive Officer)$/i, 'CEO') : raw.split(' ')[0];
    return { lead_id: lead!.id, name: lead!.full_name ?? null, text: text || null, blank: !text, facts: [], fallback: raw, used: text || raw, model: DEMO_MODEL, enriched: !!profile, builtin: true, stored: false };
  }
  const v: Row = { ...(saved ?? { output: 'text', max_chars: 220, needs_posts: false, fallback: '', fields: [] }) };
  if (str(draft.prompt)) v.prompt = draft.prompt;
  if (draft.max_chars != null) v.max_chars = Math.max(20, Math.min(1000, Number(draft.max_chars) || 220));
  if (draft.needs_posts != null) v.needs_posts = !!draft.needs_posts;
  if (typeof draft.fallback === 'string') v.fallback = draft.fallback;
  if (!saved && draft.output != null) v.output = draft.output === 'fields' ? 'fields' : 'text';
  if (v.output === 'fields' && Array.isArray(draft.fields)) v.fields = draft.fields;
  if (!str(v.prompt)) demoError('E_PAYLOAD_INVALID', 'variable_id or prompt required');
  if (v.output === 'fields' && (!Array.isArray(v.fields) || !v.fields.length || v.fields.length > 8)) demoError('E_PAYLOAD_INVALID', 'a Fields variable needs 1 to 8 fields');
  const g = generateFor(store, v, lead!.id);
  const base = { lead_id: lead!.id, name: lead!.full_name ?? null, facts: g.facts, model: DEMO_MODEL, enriched: !!profile, stored: false };
  if (v.output === 'fields') return { ...base, data: g.data, text: g.text, blank: g.blank };
  return { ...base, text: g.text, blank: g.blank, fallback: v.fallback ?? '', used: g.text ?? v.fallback ?? '' };
}

// ---------------------------------------------------------------------------------------------------------------
// Sequence QA: the app's own checks plus a few fixed "AI" findings
// ---------------------------------------------------------------------------------------------------------------
const TEXT_KEYS = ['text', 'note', 'html', 'body', 'message'];
function sequenceQa(store: DemoStore, ctx: Ctx, body: Row): Row {
  let graph: Graph | undefined = body.graph, pool: string[] = body.pool ?? [];
  if (body.sequence_id) {
    const s = seqOrThrow(store, body.sequence_id);
    graph = s.graph; pool = s.sender_pool ?? [];
    for (const ids of Object.values(s.sender_pools ?? {}) as string[][]) pool = [...new Set([...pool, ...ids])];
  }
  if (!graph) demoError('E_PAYLOAD_INVALID', 'sequence_id or graph+workspace_id required');
  const senders = store.t('outreach_senders').filter((s) => pool.includes(s.id) && !s.deleted_at);
  const aiVariables = store.t('outreach_ai_variables').filter((v) => v.workspace_id === (body.workspace_id ?? ctx.ws)).map((v) => ({ key: v.key, name: v.name, output: v.output, fields: v.fields, builtin: v.builtin }));
  const stat = validateGraph(graph!, {
    strict: true, hasFreeSender: senders.some((s) => s.provider === 'LINKEDIN' && !s.is_premium), hasMailbox: senders.some((s) => s.provider !== 'LINKEDIN'),
    poolProviders: [...new Set(senders.map((s) => s.provider as Provider))], aiVariables,
  });
  const warnings = [...stat.warnings];
  const nodes = Object.values(graph!.nodes ?? {});
  const textOf = (n: Row) => TEXT_KEYS.map((k) => n.config?.[k]).filter((x) => typeof x === 'string').join(' ');
  for (const n of nodes as Row[]) {
    const t = textOf(n);
    if (!t) continue;
    const plain = t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if ((n.type === 'send_message' || n.type === 'send_email') && plain.length > 600) warnings.push({ node_id: n.id, code: 'W_AI_LONG', message: `"${n.label ?? n.type}" is long for a cold message (${plain.length} characters). Two or three short sentences usually get more replies.` });
    if ((n.type === 'send_message' || n.type === 'send_email') && !/\{\{/.test(t)) warnings.push({ node_id: n.id, code: 'W_AI_GENERIC', message: `"${n.label ?? n.type}" has no personal detail. Add {{first_name}} or an AI line so it does not read like a mass message.` });
    if (/\b(guarantee|100%|free money|act now)\b/i.test(plain)) warnings.push({ node_id: n.id, code: 'W_AI_SPAMMY', message: `"${n.label ?? n.type}" uses words that often land in spam or get ignored.` });
  }
  const followUps = (nodes as Row[]).filter((n) => n.type === 'send_message').length;
  if (followUps >= 2 && !(nodes as Row[]).some((n) => n.type === 'delay' && Number(n.config?.amount ?? 0) >= 2 && n.config?.unit === 'days')) {
    warnings.push({ code: 'W_AI_PACING', message: 'Follow-ups come close together. Leaving two or three days between messages reads as less pushy.' });
  }
  return { errors: stat.errors, warnings, ai_available: true };
}

// ---------------------------------------------------------------------------------------------------------------
export const aiFn = {
  'ai-reply': async (req, ctx) => {
    const store = st(ctx);
    const b = req.body ?? {};
    switch (String(b.action ?? '')) {
      case 'draft_now': {
        const chat = store.get('outreach_chats', b.chat_id);
        if (!chat) demoError('E_NOT_FOUND', 'chat');
        if (!chat!.reply_sequence_id) { const seq = chatSequence(store, chat!); if (seq && store.get('outreach_sequence_reply_settings', seq, 'sequence_id')) store.update('outreach_chats', chat!.id, { reply_sequence_id: seq }); }
        const c = store.get('outreach_chats', chat!.id)!;
        const pending = store.t('outreach_ai_reply_runs').find((r) => r.chat_id === c.id && ['draft_ready', 'scheduled'].includes(r.status));
        const eff = effective(store, c);
        const prompt = { sequence: eff.sequence_name ?? null, version: eff.master_prompt?.version ?? null, fallback: eff.fallback ?? null };
        const n = Math.max(1, Math.min(Number(b.variants ?? 1), 3));
        if (pending && !b.regenerate) {
          return { run_id: pending.id, source: pending.trigger_kind === 'manual' ? 'existing_manual' : 'existing_auto', status: pending.status, prompt, drafts: [draftOf(store, pending), ...(n > 1 ? [draftOf(store, pending, true)] : [])] };
        }
        if (pending) updateRun(store, pending.id, { status: 'cancelled', cancel_reason: 'taken_manual', cancelled_by: ctx.userId });
        const r = openRun(store, c, lastInbound(store, c.id), { mode: 'draft', trigger: 'manual', requestedBy: ctx.userId, guidance: str(b.guidance) || null, sequenceId: c.reply_sequence_id ?? null });
        const warnings = c.reply_sequence_id ? [] : [{ code: eff.fallback === 'template' ? 'template' : 'no_sequence', text: '' }];
        if (warnings.length) updateRun(store, r.id, { warnings });
        const run = store.get('outreach_ai_reply_runs', r.id)!;
        return { run_id: run.id, source: 'new', status: run.status, prompt, drafts: [draftOf(store, run), ...(n > 1 ? [draftOf(store, run, true)] : []), ...(n > 2 ? [{ ...draftOf(store, run, true), text: improve(String(run.draft_text ?? '')) }] : [])] };
      }
      case 'take_manual': {
        const r = store.get('outreach_ai_reply_runs', b.run_id);
        if (!r) demoError('E_NOT_FOUND');
        if (r!.status !== 'scheduled') return { ok: true, status: r!.status, changed: false };
        updateRun(store, r!.id, { status: 'draft_ready', scheduled_send_at: null, timings: { ...(r!.timings ?? {}), warmup: false } });
        return { ok: true, status: 'draft_ready', changed: true };
      }
      case 'compose_assist': {
        const kind = b.kind;
        if (!['improve', 'translate_out', 'translate_in'].includes(kind)) demoError('E_PAYLOAD_INVALID', 'kind is improve, translate_out or translate_in');
        if (kind === 'translate_in') {
          const m = store.get('outreach_messages', b.message_id);
          if (!m) demoError('E_NOT_FOUND', 'message');
          const tr = { lang: 'en', text: m!.text ?? '', at: iso() };
          store.update('outreach_messages', m!.id, { translation: tr });
          return { text: tr.text, language: 'en', warnings: [{ code: 'sample', text: 'Sample AI output: the demo shows the message as it is instead of translating it.' }], cached: false };
        }
        const text = str(b.text);
        if (!text) demoError('E_PAYLOAD_INVALID', 'text required');
        if (kind === 'improve') return { text: improve(text), language: 'en', warnings: [] };
        return { text, language: b.language ?? 'en', warnings: [{ code: 'sample', text: 'Sample AI output: the demo keeps your text as it is instead of translating it.' }] };
      }
      case 'send_now': {
        const r = store.get('outreach_ai_reply_runs', b.run_id);
        if (!r) demoError('E_NOT_FOUND');
        if (!['scheduled', 'draft_ready'].includes(r!.status)) demoError('E_CONFLICT', 'this AI reply already moved on (sent, replaced or cancelled)');
        const msg = sendRun(store, r!.id, { by: ctx.userId, origin: r!.mode === 'autopilot' ? 'ai_autopilot' : 'ai_draft_sent' });
        if (!msg) demoError('E_CONFLICT', 'nothing to send');
        ctx.ui.simulated();
        return { ok: true, status: 'sent', message: msg };
      }
      case 'simulate': return simulateThread(store, b);
      case 'regression_run': return regression(store, ctx, b);
      case 'master_prompt_save': {
        seqOrThrow(store, b.sequence_id);
        const srs = ensureSeqSettings(store, b.sequence_id, ctx.userId);
        const mp = store.get('outreach_master_prompts', srs.master_prompt_id)!;
        if (!['guided', 'raw'].includes(b.editor_mode)) demoError('E_PAYLOAD_INVALID', 'editor_mode is guided or raw');
        let kind = b.change_kind === 'style' ? 'style' : 'substantive';
        if (b.base_version != null && b.base_version !== mp.version) demoError('E_CONFLICT', `someone saved version ${mp.version} while you were editing version ${b.base_version}. Reload to see it`);
        if (b.editor_mode === 'guided' && (!b.sections || typeof b.sections !== 'object')) demoError('E_PAYLOAD_INVALID', 'guided mode needs sections');
        if (mp.editor_mode === 'guided' && b.editor_mode === 'raw') kind = 'substantive';
        const next = bump(store, mp.id, kind as 'style' | 'substantive', b.note ?? null, { editor_mode: b.editor_mode, body: b.body, sections: b.sections, settings: b.settings ?? mp.settings }, ctx.userId);
        const warnings = /## Stop when/i.test(next.body) ? [] : [`No Stop section — the AI will only stop after ${srs.max_ai_replies_per_chat} replies.`];
        const after = store.get('outreach_sequence_reply_settings', b.sequence_id, 'sequence_id')!;
        return { prompt: { ...mpJson(store, next), change_kind: kind, warmup_remaining: after.warmup_remaining, warnings }, warnings };
      }
      case 'ai_replies_set': {
        const settings = seqRepliesSet(store, b.sequence_id, b.patch ?? {}, b.note ?? null, ctx.userId);
        const granted: string[] = [], requested: Row[] = [];
        if (b.patch?.mode === 'autopilot') {
          for (const s of linkedinPool(store, seqOrThrow(store, b.sequence_id))) {
            if (liveConsent(store, s.id)) continue;
            if (ownerIsMe(s, ctx)) { grant(store, s, ctx); granted.push(s.id); }
            else { const l = requestLink(store, s, ctx); requested.push({ sender_id: s.id, sender_name: s.display_name ?? null, emailed: !!s.owner_email, link: linkUrl(l) }); }
          }
          if (requested.length) ctx.ui.simulated();
        }
        return { settings: granted.length || requested.length ? seqRepliesSet(store, b.sequence_id, {}, null, ctx.userId) : settings, consent: { granted, requested } };
      }
      case 'consent_request': return consentRequest(store, ctx, b.sender_id);
      default: demoError('E_PAYLOAD_INVALID', `unknown action ${String(b.action ?? '')}`);
    }
    return null;
  },
  'ai-variables': async (req, ctx) => {
    const store = st(ctx);
    const b = req.body ?? {};
    if (b.action === 'route_test') return routeLeads(store, ctx, b);
    if (b.action === 'preview_variable') return previewVariable(store, ctx, b);
    demoError('E_PAYLOAD_INVALID', 'action must be route_test or preview_variable');
    return null;
  },
  'ai-sequence-qa': async (req, ctx) => sequenceQa(st(ctx), ctx, req.body ?? {}),
} satisfies FnArea;


