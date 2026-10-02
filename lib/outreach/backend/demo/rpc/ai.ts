/**
 * Demo handlers: AI hub and AI replies: lines and fields, review, needs-you, knowledge, Q&A, catalogue, scenarios, master prompts, consent.
 * Owns: ai_consent_grant_operator, ai_consent_list, ai_consent_revoke, ai_generate_request, ai_reply_apply_no_reply, ai_reply_cancel, ai_reply_cancel_report, ai_reply_chat_state, ai_reply_graduation, ai_reply_metrics, ai_reply_pool, ai_reply_run_get, ai_reply_runs_list, ai_reply_scenario_delete, ai_reply_scenario_save, ai_reply_scenarios_list, ai_review, ai_review_list, faq_delete, faq_save, hub_catalogue_add, hub_catalogue_products, hub_catalogue_update, hub_knowledge, hub_knowledge_link, hub_line_fields_edit, hub_needs_you_counts, hub_product_search, hub_product_set, hub_qa_delete, hub_qa_list, hub_qa_save, hub_question_answer, hub_question_dismiss, hub_reply_dismiss, hub_setup, hub_variable_set_mode, hub_website_set_mode, knowledge_attach, knowledge_detach, knowledge_source_add, knowledge_source_delete, knowledge_sources_list, lead_notes_get, lead_notes_update, master_prompt_copy, master_prompt_library_delete, master_prompt_library_get, master_prompt_library_list, master_prompt_library_save, master_prompt_template, master_prompt_versions, scenario_delete, scenario_save, scenario_toggle, scenarios_from_text, scenarios_reorder, sequence_ai_replies_get, sequence_ai_summary, unanswered_answer, unanswered_dismiss, unanswered_list, workspace_ai_settings, workspace_reply_settings_get, workspace_reply_settings_set
 */
import { fieldsSummary } from '../../../aiFields';
import type { AiField } from '../../../types';
import { demoError, type Ctx, type RpcArea } from '../ctx';
import { tableHooks } from '../query';
import { simHooks } from '../sim/engine';
import type { DemoStore, Row } from '../store';
import { DEMO_USER_EMAIL } from '../seed/ids';
import { finishBatch, pump, queueCrawl, queueValues, startSync } from '../aihub/jobs';
import { ksJson, liveInboxes, normQuestion, qaTargets, usedIn, inboxCatalogueIds } from '../aihub/knowledge';
import { searchProducts } from '../aihub/catalogue';
import { bump, cards, compilePrompt, defaultSettings, ensureSeqSettings, faqs, knowledgeOf, memberName, mpJson, template } from '../aihub/prompt';
import { applySideEffects, attachAi, chatState, onSimReply, runJson, runListItem, updateRun } from '../aihub/replies';
import { liveConsent, pendingLink, seqOrThrow, seqRepliesGet, seqSummary } from '../aihub/sequence';
import { needsYouRows, outputRows, rebuildNeedsYou, rebuildOutputs } from '../aihub/views';

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const DAY = 86_400_000;

/** Every handler first makes sure the AI watchers run and finishes background work that is due. */
function st(ctx: Ctx): DemoStore {
  attachAi(ctx.store);
  pump(ctx.store);
  return ctx.store;
}
function must<T>(v: T | undefined | null, what = ''): T {
  if (v == null) demoError('E_NOT_FOUND', what || undefined);
  return v as T;
}
const str = (v: unknown) => String(v ?? '').trim();
const ownerIsMe = (s: Row, ctx: Ctx) => s.owner_user_id === ctx.userId || str(s.owner_email).toLowerCase() === DEMO_USER_EMAIL.toLowerCase();

// ---------------------------------------------------------------------------------------------------------------
// Runs / metrics helpers
// ---------------------------------------------------------------------------------------------------------------
function pct(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo));
}
function totals(runs: Row[]): Row {
  const secs = (r: Row, a: string, b: string) => (r.timings?.[a] && r.timings?.[b] ? (Date.parse(r.timings[a]) - Date.parse(r.timings[b])) / 1000 : null);
  const drafted = runs.map((r) => secs(r, 'drafted_at', 'inbound_at')).filter((x): x is number => x != null).sort((a, b) => a - b);
  const sent = runs.filter((r) => r.status === 'sent').map((r) => secs(r, 'sent_at', 'inbound_at')).filter((x): x is number => x != null).sort((a, b) => a - b);
  const human = runs.filter((r) => ['ai_draft_sent', 'ai_edited'].includes(r.sent_origin));
  const auto = runs.filter((r) => r.sent_origin === 'ai_autopilot');
  const held = runs.filter((r) => r.timings?.scheduled_at && ['sent', 'cancelled'].includes(r.status));
  const r3 = (n: number, d: number, k = 3) => (d ? Math.round((n / d) * 10 ** k) / 10 ** k : null);
  return {
    runs: runs.length,
    sent_ai: runs.filter((r) => r.status === 'sent' && r.sent_origin === 'ai_autopilot').length,
    sent_human_draft: runs.filter((r) => r.status === 'sent' && ['ai_draft_sent', 'ai_edited'].includes(r.sent_origin)).length,
    escalated: runs.filter((r) => r.status === 'escalated').length,
    no_reply: runs.filter((r) => r.status === 'no_reply' || (r.status === 'draft_ready' && r.decision === 'no_reply')).length,
    cancelled: runs.filter((r) => r.status === 'cancelled').length,
    expired: runs.filter((r) => r.status === 'expired').length,
    failed: runs.filter((r) => r.status === 'failed').length,
    superseded: runs.filter((r) => r.status === 'superseded').length,
    draft_p50_s: pct(drafted, 0.5), draft_p95_s: pct(drafted, 0.95), send_p50_s: pct(sent, 0.5),
    light_edit_share: r3(human.filter((r) => (r.edit_distance ?? 1) <= 0.15).length, human.length),
    bot_question_rate: r3(auto.filter((r) => r.drew_bot_question).length, auto.length, 4),
    hold_cancel_rate: r3(held.filter((r) => r.sent_origin === 'ai_edited' || (r.status === 'cancelled' && r.cancelled_by)).length, held.length),
  };
}

function graduation(store: DemoStore, mp: Row): Row {
  const ws = store.get('outreach_ai_reply_workspace', mp.workspace_id, 'workspace_id');
  const since = mp.graduated_at ? 1 : mp.substantive_version ?? 1;
  const cutoff = Date.now() - 60 * DAY;
  const sent = store.t('outreach_ai_reply_runs').filter((r) => r.master_prompt_id === mp.id && (r.master_prompt_version ?? 0) >= since && r.status === 'sent'
    && ['ai_draft_sent', 'ai_edited'].includes(r.sent_origin) && Date.parse(r.updated_at) > cutoff);
  const n = sent.length, light = sent.filter((r) => (r.edit_distance ?? 1) <= 0.15).length, facts = sent.filter((r) => r.facts_changed).length;
  const share = n ? Math.round((light / n) * 1000) / 1000 : null;
  const tests = store.t('outreach_ai_reply_scenarios').filter((s) => s.workspace_id === mp.workspace_id && s.master_prompt_id === mp.id);
  const passed = tests.filter((s) => s.passed && (s.last_version ?? 0) >= (mp.substantive_version ?? 1)).length;
  const lastRun = tests.map((s) => s.last_run_at).filter(Boolean).sort().pop() ?? null;
  const missing: string[] = [];
  if (!mp.graduated_at && n < 30) missing.push(`${30 - n} more drafts sent by a person (${n} of 30)`);
  if (n >= (mp.graduated_at ? 10 : 1) && (share ?? 0) < 0.8) missing.push(`${Math.round((share ?? 0) * 100)}% of sent drafts were unedited or lightly edited (80% needed)`);
  if (facts > 0) missing.push(`${facts} sent draft(s) had a price, date or link changed by a person`);
  if (!tests.length) missing.push('Save at least one simulator scenario');
  else if (passed < tests.length) missing.push(`${tests.length - passed} of ${tests.length} simulator scenarios fail or have not run on the current version`);
  return {
    eligible: missing.length === 0, graduated_at: mp.graduated_at ?? null, bypass: !!ws?.graduation_bypass, window_days: 60, since_version: since,
    drafts_sent: n, light_edits: light, light_edit_share: share, facts_changed: facts,
    regression: { total: tests.length, passed, last_run_at: lastRun }, requirements: { min_drafts: 30, min_share: 0.8 }, missing,
  };
}

function scenarioJson(s: Row): Row {
  return { id: s.id, workspace_id: s.workspace_id, master_prompt_id: s.master_prompt_id ?? null, name: s.name, turns: s.turns, expected: s.expected ?? [], last_result: s.last_result ?? null, last_version: s.last_version ?? null, last_run_at: s.last_run_at ?? null, passed: s.passed ?? null, created_at: s.created_at, updated_at: s.updated_at };
}

// ---------------------------------------------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------------------------------------------
function mpOfSequence(store: DemoStore, ctx: Ctx, seqId: string): Row {
  seqOrThrow(store, seqId);
  const srs = ensureSeqSettings(store, seqId, ctx.userId);
  return must(store.get('outreach_master_prompts', srs.master_prompt_id), 'master prompt');
}
const promptVersion = (store: DemoStore, mpId: string) => store.get('outreach_master_prompts', mpId)?.version ?? 1;

function cleanSettings(p: Row | null | undefined): Row {
  const s = { ...defaultSettings(), ...(p ?? {}) };
  if (!Array.isArray(s.stages) || !s.stages.length) s.stages = defaultSettings().stages;
  return s;
}

function librarySave(store: DemoStore, ctx: Ctx, a: Row): Row {
  const name = str(a.p_name);
  if (name.length < 1 || name.length > 80) demoError('E_PAYLOAD_INVALID', 'name is 1–80 characters');
  if (!['guided', 'raw'].includes(a.p_editor_mode)) demoError('E_PAYLOAD_INVALID', 'editor_mode is guided or raw');
  const settings = cleanSettings(a.p_settings);
  const scen: Row[] | null = Array.isArray(a.p_scenarios) ? a.p_scenarios : null;
  const writeCards = (mpId: string) => {
    if (!scen) return;
    store.remove('outreach_master_prompt_scenarios', (c) => c.master_prompt_id === mpId);
    scen.forEach((c, i) => store.insert('outreach_master_prompt_scenarios', {
      master_prompt_id: mpId, position: i + 1, title: str(c.title).slice(0, 80) || 'Situation', when_text: str(c.when_text).slice(0, 500), do_text: str(c.do_text).slice(0, 1500),
      enabled: c.enabled !== false, updated_by: ctx.userId, updated_at: iso(),
    }));
  };
  if (!a.p_id) {
    const body = a.p_editor_mode === 'guided' ? compilePrompt(a.p_sections ?? {}, settings, scen) : str(a.p_body);
    if (body.length < 20) demoError('E_PAYLOAD_INVALID', 'the prompt is too short');
    const mp = store.insert('outreach_master_prompts', {
      workspace_id: a.p_ws ?? ctx.ws, scope: 'library', scope_id: null, sequence_id: null, name, editor_mode: a.p_editor_mode, version: 1, body,
      sections: a.p_editor_mode === 'guided' ? a.p_sections ?? null : null, settings, substantive_version: 1, substantive_at: iso(), graduated_at: null, graduation: null,
      copied_from_prompt_id: null, copied_from_version: null, knowledge_source_ids: [], updated_by: ctx.userId, updated_at: iso(),
    })[0];
    writeCards(mp.id);
    store.insert('outreach_master_prompt_versions', { master_prompt_id: mp.id, version: 1, editor_mode: mp.editor_mode, body, sections: mp.sections, settings, change_kind: 'substantive', note: a.p_note ?? null, created_by: ctx.userId, created_at: iso(), scenarios: cards(store, mp.id), faqs: [] }, { noId: true });
    return mpJson(store, mp)!;
  }
  const mp = store.t('outreach_master_prompts').find((m) => m.id === a.p_id && m.scope === 'library');
  must(mp);
  writeCards(mp!.id);
  store.update('outreach_master_prompts', mp!.id, { name });
  return mpJson(store, bump(store, mp!.id, 'substantive', a.p_note ?? null, { editor_mode: a.p_editor_mode, body: a.p_body, sections: a.p_sections, settings }, ctx.userId))!;
}

// ---------------------------------------------------------------------------------------------------------------
// Q&A and unanswered questions
// ---------------------------------------------------------------------------------------------------------------
function qaList(store: DemoStore, ws: string): Row[] {
  const rows: Row[] = [];
  for (const f of store.t('outreach_master_prompt_faqs')) {
    if (!f.master_prompt_id) {
      if (f.workspace_id !== ws) continue;
      rows.push({ f, targets: qaTargets(store, f.id), owner: 'library' });
    } else {
      const mp = store.get('outreach_master_prompts', f.master_prompt_id);
      const q = mp?.sequence_id ? store.get('outreach_sequences', mp.sequence_id) : undefined;
      if (!mp || mp.workspace_id !== ws || mp.scope !== 'sequence' || !q || q.status === 'archived') continue;
      rows.push({ f, targets: [{ kind: 'sequence', id: q.id, name: q.name }], owner: 'sequence' });
    }
  }
  return rows.sort((a, b) => String(b.f.created_at).localeCompare(String(a.f.created_at))).map(({ f, targets, owner }) => ({
    id: f.id, question: f.question, answer: f.answer, enabled: f.enabled !== false, source: f.source ?? 'manual', created_at: f.created_at, updated_at: f.updated_at ?? f.created_at, owner, targets,
  }));
}

function checkTargets(store: DemoStore, ws: string, targets: unknown): Row[] | null {
  if (targets == null) return null;
  if (!Array.isArray(targets) || targets.length > 50) demoError('E_PAYLOAD_INVALID', 'targets is a list of up to 50 sequences and websites');
  for (const t of targets as Row[]) {
    if (t.kind === 'sequence') { const q = store.get('outreach_sequences', t.id); if (!q || q.workspace_id !== ws) demoError('E_NOT_FOUND', 'sequence'); }
    else if (t.kind === 'website') { const w = store.get('outreach_webchat_inboxes', t.id); if (!w || w.deleted_at) demoError('E_NOT_FOUND', 'website'); }
    else demoError('E_PAYLOAD_INVALID', 'a target is a sequence or a website');
  }
  return targets as Row[];
}
function setTargets(store: DemoStore, qaId: string, targets: Row[] | null): void {
  if (targets == null) return;
  store.remove('outreach_knowledge_qa_links', (k) => k.qa_id === qaId);
  for (const t of targets) store.insert('outreach_knowledge_qa_links', { qa_id: qaId, target_kind: t.kind, target_id: t.id }, { noId: true });
}

function unansweredJson(u: Row): Row {
  const since = Date.now() - 30 * DAY;
  return {
    id: u.id, canonical: u.canonical, count_total: u.count_total, count_30d: (u.seen_at ?? []).filter((t: string) => Date.parse(t) > since).length,
    first_seen_at: u.first_seen_at, last_seen_at: u.last_seen_at, status: u.status,
    examples: [...(u.examples ?? [])].sort((a: Row, b: Row) => String(b.at).localeCompare(String(a.at))).slice(0, 3),
    answered_faq_id: u.answered_faq_id ?? null, dismissed_reason: u.dismissed_reason ?? null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Website inbox settings (the webchat area owns the inbox; the hub changes two of its settings)
// ---------------------------------------------------------------------------------------------------------------
function patchInbox(store: DemoStore, inboxId: string, patch: { ai_enabled?: boolean; ai?: Row; products?: Row }): Row {
  const i = must(store.get('outreach_webchat_inboxes', inboxId), 'website');
  const settings = { ...(i.settings ?? {}) };
  const ai = { ...(settings.ai ?? {}), ...(patch.ai ?? {}) };
  if (patch.products) ai.products = { ...(settings.ai?.products ?? {}), ...patch.products };
  settings.ai = ai;
  return store.update('outreach_webchat_inboxes', inboxId, { settings, ...(patch.ai_enabled != null ? { ai_enabled: patch.ai_enabled } : {}), updated_at: iso() })[0];
}

function wrsGet(store: DemoStore, ws: string): Row {
  const w = store.get('outreach_workspace_reply_settings', ws, 'workspace_id');
  return { workspace_id: ws, max_ai_sends_per_sender_day: w?.max_ai_sends_per_sender_day ?? 25, default_prompt_id: w?.default_prompt_id ?? null, default_prompt_name: w?.default_prompt_id ? store.get('outreach_master_prompts', w.default_prompt_id)?.name ?? null : null, updated_at: w?.updated_at ?? null };
}

// ---------------------------------------------------------------------------------------------------------------
export const aiRpc = {
  // ---- consent -------------------------------------------------------------------------------------------------
  ai_consent_grant_operator: (a, ctx) => {
    const store = st(ctx);
    const s = store.get('outreach_senders', a.p_sender);
    if (!s || s.deleted_at) demoError('E_NOT_FOUND');
    if (!ownerIsMe(s!, ctx)) demoError('E_FORBIDDEN', 'only the owner of this LinkedIn account can approve AI replies here. Send them the approval link instead');
    const cap = store.get('outreach_workspace_reply_settings', s!.workspace_id, 'workspace_id')?.max_ai_sends_per_sender_day ?? 25;
    store.update('outreach_ai_reply_consent', (k) => k.sender_id === s!.id && !k.revoked_at, { revoked_at: iso(), revoked_reason: 'replaced' });
    const k = store.insert('outreach_ai_reply_consent', {
      workspace_id: s!.workspace_id, sender_id: s!.id, master_prompt_id: null, master_prompt_version: null, granted_by_email: DEMO_USER_EMAIL, granted_via: 'owner_is_operator',
      scope: { daily_cap: cap, grant: 'AI may reply as me in the sequences my team turns on.' }, evidence: { user_id: ctx.userId, at: iso() }, granted_at: iso(), expires_at: iso(Date.now() + 365 * DAY),
      revoked_at: null, revoked_reason: null, revoke_token_hash: null,
    })[0];
    store.update('outreach_ai_reply_consent_links', (l) => l.sender_id === s!.id && !l.used_at && !l.cancelled_at, { cancelled_at: iso() });
    return { id: k.id, sender_id: s!.id, granted_via: 'owner_is_operator' };
  },
  ai_consent_list: (a, ctx) => {
    const store = st(ctx);
    const ws = a.p_ws ?? ctx.ws;
    const week = Date.now() - 7 * DAY;
    return store.t('outreach_senders').filter((s) => s.workspace_id === ws && !s.deleted_at && s.provider === 'LINKEDIN')
      .sort((x, y) => String(x.display_name).localeCompare(String(y.display_name))).map((s) => {
        const k = store.t('outreach_ai_reply_consent').filter((x) => x.sender_id === s.id && !x.revoked_at).sort((x, y) => String(y.granted_at).localeCompare(String(x.granted_at)))[0];
        const pl = pendingLink(store, s.id);
        const onAuto = store.t('outreach_sequence_reply_settings').filter((r) => r.workspace_id === ws && r.mode === 'autopilot').map((r) => store.get('outreach_sequences', r.sequence_id))
          .filter((q): q is Row => !!q && q.status !== 'archived' && ((q.sender_pool ?? []).includes(s.id) || JSON.stringify(q.sender_pools ?? {}).includes(s.id)))
          .sort((x, y) => String(x.name).localeCompare(String(y.name))).map((q) => ({ id: q.id, name: q.name }));
        return {
          sender_id: s.id, sender_name: s.display_name ?? null, provider: s.provider, owner_email: s.owner_email ?? null, owner_is_me: ownerIsMe(s, ctx),
          consent: k ? { id: k.id, valid: Date.parse(k.expires_at) > Date.now(), granted_via: k.granted_via, granted_by_email: k.granted_by_email, granted_at: k.granted_at, expires_at: k.expires_at, scope: k.scope ?? null } : null,
          pending_link: pl ? { id: pl.id, email: pl.email ?? null, created_at: pl.created_at, expires_at: pl.expires_at } : null,
          sequences_on_auto: onAuto,
          ai_sent_7d: store.t('outreach_ai_reply_runs').filter((r) => r.sender_id === s.id && r.status === 'sent' && r.sent_origin === 'ai_autopilot' && Date.parse(r.updated_at) > week).length,
        };
      });
  },
  ai_consent_revoke: (a, ctx) => {
    const store = st(ctx);
    const k = must(store.get('outreach_ai_reply_consent', a.p_consent));
    store.update('outreach_ai_reply_consent', k.id, { revoked_at: iso(), revoked_reason: str(a.p_reason) || 'revoked_by_manager' });
    // Auto replies of this sender that wait for their hold become drafts again
    for (const r of store.t('outreach_ai_reply_runs').filter((x) => x.sender_id === k.sender_id && x.status === 'scheduled')) updateRun(store, r.id, { status: 'draft_ready', scheduled_send_at: null });
    return null;
  },

  // ---- personalized lines ------------------------------------------------------------------------------------------
  ai_generate_request: (a, ctx) => {
    const store = st(ctx);
    const ws = a.p_ws ?? ctx.ws;
    const v = store.t('outreach_ai_variables').find((x) => x.id === a.p_variable && x.workspace_id === ws);
    if (!v) demoError('E_NOT_FOUND', 'variable');
    if (v!.mode === 'off') demoError('E_AI_VARIABLE_OFF', `"${v!.name}" is switched off. Switch it to Review to write lines`);
    const ids: string[] = [...new Set((a.p_lead_ids ?? []) as string[])];
    if (!ids.length) demoError('E_PAYLOAD_INVALID', 'lead_ids required');
    if (ids.length > 2000) demoError('E_TOO_MANY', 'max 2000 leads per batch');
    const batch = store.insert('outreach_ai_batches', { workspace_id: ws, variable_id: v!.id, sequence_id: a.p_sequence ?? null, requested_by: ctx.userId, total: 0, status: 'generating', hold_enrollments: false, finished_at: null })[0];
    const leadSet = new Set(store.t('outreach_leads').filter((l) => l.workspace_id === ws && ids.includes(l.id)).map((l) => l.id));
    const queued: string[] = [];
    let kept = 0;
    for (const leadId of ids) {
      if (!leadSet.has(leadId)) continue;
      const cur = store.t('outreach_ai_values').find((x) => x.lead_id === leadId && x.variable_id === v!.id);
      const reset = { batch_id: batch.id, status: 'pending', attempts: 0, text: null, data: null, facts: [], error: null, edited: false, approved_by: null, approved_at: null, locked_at: null, generated_at: null, updated_at: iso() };
      if (!cur) queued.push(store.insert('outreach_ai_values', { workspace_id: ws, lead_id: leadId, variable_id: v!.id, model: null, ...reset })[0].id);
      else if (a.p_regenerate || ['failed', 'blank', 'skipped', 'pending'].includes(cur.status)) { store.update('outreach_ai_values', cur.id, reset); queued.push(cur.id); }
      else kept++;
    }
    store.update('outreach_ai_batches', batch.id, { total: queued.length, status: queued.length ? 'generating' : 'done', finished_at: queued.length ? null : iso() });
    queueValues(store, queued);
    return { batch_id: batch.id, to_generate: queued.length, kept_existing: kept, note: 'Lines are generated ahead of time and wait in the review table. Only approved lines are ever sent; everything else uses the fallback.' };
  },
  ai_review: (a, ctx) => {
    const store = st(ctx);
    const action = a.p_action;
    if (!['approve', 'skip', 'edit', 'regenerate'].includes(action)) demoError('E_PAYLOAD_INVALID', 'action must be approve, skip, edit or regenerate');
    const ids: string[] = a.p_value_ids ?? [];
    if (!ids.length) return { updated: 0 };
    if (ids.length > 2000) demoError('E_TOO_MANY', 'max 2000 per request');
    if (action === 'edit' && (ids.length !== 1 || !str(a.p_text))) demoError('E_PAYLOAD_INVALID', 'edit takes one id and a text');
    let n = 0;
    const batches = new Set<string>();
    const regen: string[] = [];
    for (const id of ids) {
      const x = store.get('outreach_ai_values', id);
      if (!x) continue;
      const v = store.get('outreach_ai_variables', x.variable_id);
      if (action === 'approve') {
        if (!['generated', 'approved', 'skipped'].includes(x.status) || !str(x.text)) continue;
        store.update('outreach_ai_values', id, { status: 'approved', approved_by: ctx.userId, approved_at: iso(), updated_at: iso() });
      } else if (action === 'edit') {
        if (v?.output === 'fields') demoError('E_PAYLOAD_INVALID', 'this variable writes fields; edit them with hub_line_fields_edit');
        const lim = Math.max(v?.max_chars ?? 220, 20) * 2;
        if (String(a.p_text).length > lim) demoError('E_PAYLOAD_INVALID', `text exceeds ${lim} characters`);
        store.update('outreach_ai_values', id, { text: str(a.p_text), edited: true, status: 'approved', approved_by: ctx.userId, approved_at: iso(), updated_at: iso() });
      } else if (action === 'skip') {
        store.update('outreach_ai_values', id, { status: 'skipped', approved_by: null, approved_at: null, updated_at: iso() });
      } else {
        if (v?.mode === 'off') demoError('E_AI_VARIABLE_OFF', `"${v.name}" is switched off. Switch it to Review to write lines`);
        store.update('outreach_ai_values', id, { status: 'pending', attempts: 0, text: null, data: null, facts: [], error: null, edited: false, approved_by: null, approved_at: null, locked_at: null, updated_at: iso() });
        if (x.batch_id) store.update('outreach_ai_batches', x.batch_id, { status: 'generating', finished_at: null });
        regen.push(id);
      }
      n++;
      if (x.batch_id) batches.add(x.batch_id);
    }
    for (const b of batches) {
      const row = store.get('outreach_ai_batches', b);
      if (row?.status === 'review' && !store.t('outreach_ai_values').some((y) => y.batch_id === b && ['generated', 'pending'].includes(y.status))) store.update('outreach_ai_batches', b, { status: 'done' });
    }
    if (regen.length) queueValues(store, regen, 600);
    return { updated: n, action };
  },
  ai_review_list: (a, ctx) => {
    const store = st(ctx);
    const ws = a.p_ws ?? ctx.ws;
    const status = a.p_status ?? 'generated';
    const vars = new Map(store.t('outreach_ai_variables').map((v) => [v.id, v]));
    const rows = store.t('outreach_ai_values').filter((x) => x.workspace_id === ws && (!a.p_batch || x.batch_id === a.p_batch) && (status === 'all' || x.status === status) && vars.has(x.variable_id))
      .sort((x, y) => String(y.updated_at).localeCompare(String(x.updated_at)) || String(x.id).localeCompare(String(y.id)));
    const lim = Math.min(Number(a.p_limit ?? 100), 500), off = Number(a.p_offset ?? 0);
    return rows.slice(off, off + lim).map((x) => {
      const l = store.get('outreach_leads', x.lead_id) ?? {};
      const v = vars.get(x.variable_id)!;
      return { value_id: x.id, lead_id: x.lead_id, lead_name: l.full_name ?? null, company: l.company ?? null, title: l.title ?? l.headline ?? null, variable_key: v.key, variable_name: v.name, body: x.text ?? null, facts: x.facts ?? [], status: x.status, edited: !!x.edited, fallback: v.fallback ?? '', updated_at: x.updated_at, total: rows.length };
    });
  },
  hub_line_fields_edit: (a, ctx) => {
    const store = st(ctx);
    const x = must(store.get('outreach_ai_values', a.p_value));
    const av = must(store.get('outreach_ai_variables', x.variable_id));
    if (av.output !== 'fields') demoError('E_PAYLOAD_INVALID', 'this variable writes one line; edit it with ai_review(edit)');
    if (!a.p_data || typeof a.p_data !== 'object' || Array.isArray(a.p_data)) demoError('E_PAYLOAD_INVALID', 'data is an object of field values');
    const fields = (av.fields ?? []) as AiField[];
    const clean: Row = {};
    for (const f of fields) {
      const raw = a.p_data[f.key];
      if (raw == null || raw === '') { clean[f.key] = null; continue; }
      if (f.type === 'number') { const n = Number(raw); if (!Number.isFinite(n)) demoError('E_PAYLOAD_INVALID', `"${f.name}" needs a number`); clean[f.key] = n; }
      else if (f.type === 'yes_no') { if (typeof raw !== 'boolean') demoError('E_PAYLOAD_INVALID', `"${f.name}" is yes or no`); clean[f.key] = raw; }
      else if (f.type === 'choice') { if (!(f.options ?? []).includes(String(raw))) demoError('E_PAYLOAD_INVALID', `"${f.name}" must be one of: ${(f.options ?? []).join(', ')}`); clean[f.key] = String(raw); }
      else { const t = String(raw).trim(); if (t.length > (f.max_chars ?? 200)) demoError('E_PAYLOAD_INVALID', `"${f.name}" is longer than ${f.max_chars ?? 200} characters`); clean[f.key] = t; }
    }
    const summary = fieldsSummary(fields, clean as never);
    if (!summary) demoError('E_PAYLOAD_INVALID', 'fill at least one field, or skip this lead');
    store.update('outreach_ai_values', x.id, { data: clean, text: summary, edited: true, status: 'approved', error: null, locked_at: null, approved_by: ctx.userId, approved_at: iso(), updated_at: iso() });
    if (x.batch_id) {
      const b = store.get('outreach_ai_batches', x.batch_id);
      if (b?.status === 'review' && !store.t('outreach_ai_values').some((y) => y.batch_id === x.batch_id && ['generated', 'pending'].includes(y.status))) store.update('outreach_ai_batches', x.batch_id, { status: 'done' });
    }
    return { updated: 1, data: clean, text: summary };
  },
  hub_variable_set_mode: (a, ctx) => {
    const store = st(ctx);
    const v = must(store.get('outreach_ai_variables', a.p_variable), 'variable');
    if (a.p_mode === 'auto') demoError('E_PAYLOAD_INVALID', 'Auto is not available for Personalized lines yet: a person approves every line. Use off or review');
    if (!['off', 'review'].includes(a.p_mode)) demoError('E_PAYLOAD_INVALID', 'mode is off or review');
    const was = v.mode ?? 'review';
    if (was !== a.p_mode) {
      store.update('outreach_ai_variables', v.id, { mode: a.p_mode, updated_at: iso() });
      if (a.p_mode === 'off') {
        store.update('outreach_ai_values', (x) => x.variable_id === v.id && x.status === 'pending', { status: 'skipped', locked_at: null, updated_at: iso() });
        for (const b of store.t('outreach_ai_batches').filter((x) => x.variable_id === v.id && x.status === 'generating')) {
          store.update('outreach_ai_batches', b.id, { status: store.t('outreach_ai_values').some((y) => y.batch_id === b.id && y.status === 'generated') ? 'review' : 'done', finished_at: iso() });
        }
      }
    }
    return { id: v.id, key: v.key, name: v.name, mode: a.p_mode, was };
  },

  // ---- AI replies: runs ---------------------------------------------------------------------------------------
  ai_reply_apply_no_reply: (a, ctx) => {
    const store = st(ctx);
    const r = must(store.get('outreach_ai_reply_runs', a.p_run));
    if (r.status !== 'draft_ready' || r.decision !== 'no_reply') demoError('E_CONFLICT', 'this is not a pending "no reply" suggestion');
    const u = updateRun(store, r.id, { status: 'no_reply', dispatched_by: ctx.userId })!;
    applySideEffects(store, u);
    return runJson(store, u);
  },
  ai_reply_cancel: (a, ctx) => {
    const store = st(ctx);
    const r = must(store.get('outreach_ai_reply_runs', a.p_run));
    if (!['wrong_facts', 'wrong_tone', 'too_early_to_pitch', 'shouldnt_reply', 'answer_myself', 'other', 'dismissed'].includes(a.p_reason)) demoError('E_PAYLOAD_INVALID', 'unknown cancel reason');
    if (r.status === 'scheduled' && a.p_reason === 'dismissed') demoError('E_PAYLOAD_INVALID', 'say why you are cancelling a scheduled reply');
    if (!['debouncing', 'drafting', 'draft_ready', 'scheduled'].includes(r.status)) demoError('E_CONFLICT', 'this AI reply already moved on (sent, replaced or cancelled)');
    return runJson(store, updateRun(store, r.id, { status: 'cancelled', cancel_reason: a.p_reason, cancel_note: a.p_note ? String(a.p_note).slice(0, 500) : null, cancelled_by: ctx.userId }));
  },
  hub_reply_dismiss: (a, ctx) => {
    const store = st(ctx);
    const r = must(store.get('outreach_ai_reply_runs', a.p_run));
    if (r.status === 'scheduled') demoError('E_PAYLOAD_INVALID', 'say why you are cancelling a scheduled reply');
    if (!['draft_ready', 'escalated'].includes(r.status)) demoError('E_CONFLICT', 'this reply was already handled');
    const u = updateRun(store, r.id, { status: 'cancelled', cancel_reason: 'dismissed', cancelled_by: ctx.userId })!;
    return { id: u.id, status: u.status };
  },
  ai_reply_cancel_report: (a, ctx) => {
    const store = st(ctx);
    const days = Math.max(1, Math.min(Number(a.p_days ?? 30), 365));
    const since = Date.now() - days * DAY;
    const groups = new Map<string, Row>();
    for (const r of store.t('outreach_ai_reply_runs')) {
      if (r.workspace_id !== (a.p_ws ?? ctx.ws) || Date.parse(r.updated_at) <= since) continue;
      if (!((r.status === 'cancelled' && r.cancelled_by && r.cancel_reason !== 'dismissed') || r.sent_origin === 'ai_edited')) continue;
      const reason = r.cancel_reason ?? 'edited';
      const k = `${r.rule_applied ?? ''}|${reason}`;
      const g = groups.get(k) ?? { rule_applied: r.rule_applied ?? null, reason, n: 0, runs: [] as Row[] };
      g.n++; g.runs.push(r);
      groups.set(k, g);
    }
    return [...groups.values()].sort((x, y) => y.n - x.n).map((g) => ({ rule_applied: g.rule_applied, reason: g.reason, n: g.n, run_ids: g.runs.sort((x: Row, y: Row) => String(y.updated_at).localeCompare(String(x.updated_at))).slice(0, 20).map((r: Row) => r.id) }));
  },
  ai_reply_chat_state: (a, ctx) => chatState(st(ctx), a.p_chat),
  ai_reply_graduation: (a, ctx) => {
    const store = st(ctx);
    const mp = store.t('outreach_master_prompts').find((m) => m.id === a.p_mp && m.workspace_id === (a.p_ws ?? ctx.ws));
    return graduation(store, must(mp));
  },
  ai_reply_metrics: (a, ctx) => {
    const store = st(ctx);
    const ws = a.p_ws ?? ctx.ws;
    const from = Date.parse(`${a.p_from}T00:00:00Z`), to = Date.parse(`${a.p_to}T00:00:00Z`);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > 366 * DAY) demoError('E_PAYLOAD_INVALID', 'pick a range of up to a year');
    const t0 = from - 12 * 3_600_000, t1 = to + DAY + 12 * 3_600_000;   // the workspace's own days, roughly: a day either side of UTC
    const runs = store.t('outreach_ai_reply_runs').filter((r) => r.workspace_id === ws && Date.parse(r.created_at) >= t0 && Date.parse(r.created_at) < t1);
    const group = a.p_group ?? 'none';
    let groups: Row[] = [];
    if (group !== 'none') {
      if (!['sequence', 'sender', 'stage', 'master_prompt', 'client', 'trigger', 'scenario'].includes(group)) demoError('E_PAYLOAD_INVALID', 'group by sequence, sender, stage, master_prompt, client, trigger or scenario');
      const keyOf = (r: Row): [string | null, string | null] => {
        switch (group) {
          case 'sequence': return [r.sequence_id, store.get('outreach_sequences', r.sequence_id)?.name ?? null];
          case 'sender': return [r.sender_id, store.get('outreach_senders', r.sender_id)?.display_name ?? null];
          case 'stage': return [r.stage_after, r.stage_after];
          case 'trigger': return [r.trigger_kind, r.trigger_kind];
          case 'scenario': return [r.scenario_id, store.get('outreach_master_prompt_scenarios', r.scenario_id)?.title ?? null];
          case 'master_prompt': { const mp = store.get('outreach_master_prompts', r.master_prompt_id); return [r.master_prompt_id, mp ? `${mp.scope === 'sequence' ? store.get('outreach_sequences', mp.sequence_id)?.name ?? 'Sequence' : mp.name ?? 'Library'} v${r.master_prompt_version}` : null]; }
          default: return [r.client_id, store.get('outreach_clients', r.client_id)?.name ?? null];
        }
      };
      const m = new Map<string, { label: string | null; runs: Row[] }>();
      for (const r of runs) { const [k, label] = keyOf(r); const key = String(k ?? ''); const g = m.get(key) ?? { label, runs: [] }; g.runs.push(r); m.set(key, g); }
      groups = [...m.entries()].map(([key, g]) => ({ ...totals(g.runs), key: key || null, label: g.label ?? 'None' }) as Row).sort((x, y) => Number(y.runs) - Number(x.runs));
    }
    const handed = store.t('outreach_chats').filter((c) => c.workspace_id === ws && c.ai_handed_off_at && Date.parse(c.ai_handed_off_at) >= t0 && Date.parse(c.ai_handed_off_at) < t1);
    const count = (xs: Array<string | null | undefined>) => { const m = new Map<string, number>(); for (const x of xs) if (x) m.set(x, (m.get(x) ?? 0) + 1); return [...m.entries()].sort((p, q) => q[1] - p[1]).map(([reason, n]) => ({ reason, n })); };
    return {
      totals: totals(runs), groups, handed_off: handed.length, handoff_reasons: count(handed.map((c) => c.ai_handoff_reason)),
      escalation_reasons: count(runs.filter((r) => ['escalated', 'draft_ready'].includes(r.status)).flatMap((r) => r.escalation_reasons ?? [])),
      cancel_reasons: count(runs.filter((r) => r.status === 'cancelled').map((r) => r.cancel_reason)),
    };
  },
  ai_reply_pool: (a, ctx) => {
    const store = st(ctx);
    const ws = a.p_ws ?? ctx.ws;
    const month = new Date(); month.setUTCDate(1); month.setUTCHours(0, 0, 0, 0);
    const own = store.t('outreach_workspace_secrets').some((s) => s.workspace_id === ws && (s.llm_key_enc || s.uses_own_key || s.llm_key_hint));
    const used = store.t('outreach_ai_reply_runs').filter((r) => r.workspace_id === ws && Date.parse(r.created_at) >= month.getTime() && r.draft_text).length
      + store.t('outreach_webchat_ai_turns').filter((t) => t.workspace_id === ws && Date.parse(t.created_at) >= month.getTime()).length
      + store.t('outreach_ai_values').filter((v) => v.workspace_id === ws && v.generated_at && Date.parse(v.generated_at) >= month.getTime()).length;
    const lim = store.get('outreach_ai_reply_workspace', ws, 'workspace_id')?.monthly_limit ?? 2000;
    return { month: new Date().toISOString().slice(0, 7), used, limit: own ? null : lim, own_key: own, ok: own || used < lim };
  },
  ai_reply_run_get: (a, ctx) => {
    const store = st(ctx);
    const r = must(store.get('outreach_ai_reply_runs', a.p_run));
    const v = store.t('outreach_master_prompt_versions').find((x) => x.master_prompt_id === r.master_prompt_id && x.version === r.master_prompt_version);
    const inbound = (r.inbound_message_ids ?? []).map((id: string) => store.get('outreach_messages', id)).filter(Boolean) as Row[];
    return {
      ...runListItem(store, r), inbound_text: inbound.map((m) => m.text ?? '[attachment]').join('\n') || null, context: r.context ?? null, policy_snapshot: r.policy_snapshot ?? null,
      master_prompt: v ? { id: v.master_prompt_id, version: v.version, body: v.body, editor_mode: v.editor_mode } : null, error: r.error ?? null, model: r.model ?? null,
      edit_distance: r.edit_distance ?? null, facts_changed: r.facts_changed ?? null, sent_message_id: r.sent_message_id ?? null,
    };
  },
  ai_reply_runs_list: (a, ctx) => {
    const store = st(ctx);
    const f: Row = a.p_filters ?? {};
    const lim = Math.max(1, Math.min(Number(a.p_limit ?? 50), 200));
    const has = (k: string) => f[k] != null && f[k] !== '';
    const rows = store.t('outreach_ai_reply_runs').filter((r) => r.workspace_id === (a.p_ws ?? ctx.ws) && store.get('outreach_chats', r.chat_id)
      && (!a.p_before || r.created_at < a.p_before)
      && (!Array.isArray(f.status) || !f.status.length || f.status.includes(r.status))
      && (!has('decision') || r.decision === f.decision) && (!has('mode') || r.mode === f.mode) && (!has('trigger') || r.trigger_kind === f.trigger)
      && (!has('sequence_id') || r.sequence_id === f.sequence_id) && (!has('sender_id') || r.sender_id === f.sender_id) && (!has('chat_id') || r.chat_id === f.chat_id)
      && (!has('stage') || r.stage_after === f.stage || r.stage_before === f.stage)
      && (!has('reason') || (r.escalation_reasons ?? []).includes(f.reason) || (r.gate_failures ?? []).includes(f.reason) || r.cancel_reason === f.reason)
      && (!has('since') || Date.parse(r.created_at) >= Date.parse(f.since)))
      .sort((x, y) => String(y.created_at).localeCompare(String(x.created_at))).slice(0, lim);
    return { items: rows.map((r) => runListItem(store, r)), next_before: rows.length === lim ? rows[rows.length - 1].created_at : null };
  },

  // ---- test conversations (regression set) ----------------------------------------------------------------------
  ai_reply_scenario_delete: (a, ctx) => { const store = st(ctx); must(store.get('outreach_ai_reply_scenarios', a.p_id)); store.remove('outreach_ai_reply_scenarios', a.p_id); return null; },
  ai_reply_scenario_save: (a, ctx) => {
    const store = st(ctx);
    const ws = a.p_ws ?? ctx.ws;
    if (a.p_mp && !store.t('outreach_master_prompts').some((m) => m.id === a.p_mp && m.workspace_id === ws)) demoError('E_NOT_FOUND', 'master prompt not found');
    const turns = a.p_turns;
    if (!Array.isArray(turns) || !turns.length || turns.length > 30 || turns.some((t: Row) => !['prospect', 'us'].includes(t?.from) || !str(t?.text) || String(t.text).length > 4000)) demoError('E_PAYLOAD_INVALID', 'turns are 1–30 lines of {from: prospect|us, text}');
    if (a.p_expected != null && (!Array.isArray(a.p_expected) || a.p_expected.some((e: Row) => !['send', 'escalate', 'no_reply'].includes(e?.decision) || e?.after_turn == null))) demoError('E_PAYLOAD_INVALID', 'expected is [{after_turn, decision: send|escalate|no_reply, stage_after?}]');
    const name = str(a.p_name).slice(0, 120);
    if (!name) demoError('E_PAYLOAD_INVALID', 'name is 1–120 characters');
    if (!a.p_id) return scenarioJson(store.insert('outreach_ai_reply_scenarios', { workspace_id: ws, master_prompt_id: a.p_mp ?? null, name, turns, expected: a.p_expected ?? [], last_result: null, last_version: null, last_run_at: null, passed: null, created_by: ctx.userId, updated_at: iso() })[0]);
    must(store.get('outreach_ai_reply_scenarios', a.p_id));
    return scenarioJson(store.update('outreach_ai_reply_scenarios', a.p_id, { master_prompt_id: a.p_mp ?? null, name, turns, expected: a.p_expected ?? [], passed: null, last_result: null, last_version: null, updated_at: iso() })[0]);
  },
  ai_reply_scenarios_list: (a, ctx) => {
    const store = st(ctx);
    return store.t('outreach_ai_reply_scenarios').filter((s) => s.workspace_id === (a.p_ws ?? ctx.ws) && (s.master_prompt_id ?? null) === (a.p_mp ?? null))
      .sort((x, y) => String(x.created_at).localeCompare(String(y.created_at))).map(scenarioJson);
  },

  // ---- sequence prompt: scenarios (situation cards) -----------------------------------------------------------------
  scenario_save: (a, ctx) => {
    const store = st(ctx);
    const mp = mpOfSequence(store, ctx, a.p_sequence);
    const title = str(a.p_title), when = str(a.p_when), todo = str(a.p_do);
    if (!title || title.length > 80 || !when || when.length > 500 || !todo || todo.length > 1500) demoError('E_PAYLOAD_INVALID', 'title up to 80, when up to 500, do up to 1500 characters, none empty');
    let id = a.p_id;
    if (!id) {
      const pos = Math.max(0, ...store.t('outreach_master_prompt_scenarios').filter((c) => c.master_prompt_id === mp.id).map((c) => c.position)) + 1;
      id = store.insert('outreach_master_prompt_scenarios', { master_prompt_id: mp.id, position: pos, title, when_text: when, do_text: todo, enabled: a.p_enabled !== false, updated_by: ctx.userId, updated_at: iso() })[0].id;
    } else {
      const c = store.get('outreach_master_prompt_scenarios', id);
      if (!c || c.master_prompt_id !== mp.id) demoError('E_NOT_FOUND');
      store.update('outreach_master_prompt_scenarios', id, { title, when_text: when, do_text: todo, enabled: a.p_enabled ?? c!.enabled, updated_by: ctx.userId, updated_at: iso() });
    }
    bump(store, mp.id, 'substantive', `Scenario "${title.slice(0, 60)}" ${a.p_id ? 'edited' : 'added'}`, {}, ctx.userId);
    return { id, scenarios: cards(store, mp.id), version: promptVersion(store, mp.id) };
  },
  scenario_toggle: (a, ctx) => {
    const store = st(ctx);
    const c = must(store.get('outreach_master_prompt_scenarios', a.p_id));
    store.update('outreach_master_prompt_scenarios', c.id, { enabled: !!a.p_enabled, updated_by: ctx.userId, updated_at: iso() });
    bump(store, c.master_prompt_id, 'substantive', `Scenario "${String(c.title).slice(0, 60)}" ${a.p_enabled ? 'on' : 'off'}`, {}, ctx.userId);
    return { scenarios: cards(store, c.master_prompt_id), version: promptVersion(store, c.master_prompt_id) };
  },
  scenario_delete: (a, ctx) => {
    const store = st(ctx);
    const c = must(store.get('outreach_master_prompt_scenarios', a.p_id));
    store.remove('outreach_master_prompt_scenarios', c.id);
    bump(store, c.master_prompt_id, 'substantive', `Scenario "${String(c.title).slice(0, 60)}" removed`, {}, ctx.userId);
    return { scenarios: cards(store, c.master_prompt_id), version: promptVersion(store, c.master_prompt_id) };
  },
  scenarios_reorder: (a, ctx) => {
    const store = st(ctx);
    const mp = mpOfSequence(store, ctx, a.p_sequence);
    ((a.p_ids ?? []) as string[]).forEach((id, i) => store.update('outreach_master_prompt_scenarios', (c) => c.id === id && c.master_prompt_id === mp.id, { position: i + 1, updated_at: iso() }));
    bump(store, mp.id, 'substantive', 'Scenarios reordered', {}, ctx.userId);
    return { scenarios: cards(store, mp.id), version: promptVersion(store, mp.id) };
  },
  scenarios_from_text: (a) => {
    const out: Row[] = [];
    for (let ln of String(a.p_text ?? '').split('\n')) {
      ln = ln.replace(/^\s*[-*•]\s*/, '').trim();
      if (!ln) continue;
      const parts = ln.split(/\s*(?:→|->|=>)\s*/);
      if (parts.length < 2) continue;
      const w = parts[0].trim(), d = parts.slice(1).join(' → ').trim();
      if (!w || !d) continue;
      let t = w.replace(/^(they|when they|if they|the prospect)\s+/i, '');
      t = t.split(',')[0].split(' / ')[0].trim().slice(0, 80);
      t = t.charAt(0).toUpperCase() + t.slice(1);
      out.push({ title: t || 'Situation', when_text: w.slice(0, 500), do_text: d.slice(0, 1500), enabled: true });
    }
    return out;
  },

  // ---- sequence prompt: Q&A ---------------------------------------------------------------------------------------
  faq_save: (a, ctx) => {
    const store = st(ctx);
    const mp = mpOfSequence(store, ctx, a.p_sequence);
    const q = str(a.p_question), ans = str(a.p_answer);
    if (!q || q.length > 500 || !ans || ans.length > 2000) demoError('E_PAYLOAD_INVALID', 'question up to 500 and answer up to 2000 characters, neither empty');
    let id = a.p_id;
    if (!id) id = store.insert('outreach_master_prompt_faqs', { master_prompt_id: mp.id, workspace_id: mp.workspace_id, question: q, answer: ans, source: 'manual', enabled: a.p_enabled !== false, created_by: ctx.userId, updated_at: iso() })[0].id;
    else {
      const f = store.get('outreach_master_prompt_faqs', id);
      if (!f || f.master_prompt_id !== mp.id) demoError('E_NOT_FOUND');
      store.update('outreach_master_prompt_faqs', id, { question: q, answer: ans, enabled: a.p_enabled ?? f!.enabled, updated_at: iso() });
    }
    bump(store, mp.id, 'substantive', `Q&A ${a.p_id ? 'edited' : 'added'}`, {}, ctx.userId);
    return { id, faqs: faqs(store, mp.id) };
  },
  faq_delete: (a, ctx) => {
    const store = st(ctx);
    const f = must(store.get('outreach_master_prompt_faqs', a.p_id));
    store.remove('outreach_master_prompt_faqs', f.id);
    store.remove('outreach_knowledge_qa_links', (k) => k.qa_id === f.id);
    store.update('outreach_ai_unanswered_questions', (u) => u.answered_faq_id === f.id, { status: 'open', answered_faq_id: null });
    if (!f.master_prompt_id) return { faqs: [] };
    bump(store, f.master_prompt_id, 'substantive', 'Q&A removed', {}, ctx.userId);
    return { faqs: faqs(store, f.master_prompt_id) };
  },

  // ---- hub: counts, setup, Q&A, questions ----------------------------------------------------------------------------
  hub_needs_you_counts: (a, ctx) => {
    const store = st(ctx);
    const mine = a.p_mine !== false;
    const out: Row = { total: 0, reply: 0, line: 0, draft: 0, website: 0, question: 0, profile: 0 };
    for (const n of needsYouRows(store)) {
      if (n.workspace_id !== (a.p_ws ?? ctx.ws)) continue;
      if (mine && n.assignee_id && n.assignee_id !== ctx.userId) continue;
      out.total++; out[n.type]++;
    }
    return out;
  },
  hub_setup: (a, ctx) => {
    const store = st(ctx);
    const ws = a.p_ws ?? ctx.ws;
    const week = Date.now() - 7 * DAY;
    const written: Row = {};
    for (const o of outputRows(store)) if (o.workspace_id === ws && Date.parse(o.created_at) >= week) written[o.feature] = (written[o.feature] ?? 0) + 1;
    const waiting = new Map<string, number>();
    for (const n of needsYouRows(store)) if (n.workspace_id === ws) { const k = `${n.type}:${n.where_id ?? ''}`; waiting.set(k, (waiting.get(k) ?? 0) + 1); }
    return {
      written_7d: written,
      sequences: store.t('outreach_sequences').filter((q) => q.workspace_id === ws && q.status !== 'archived').sort((x, y) => String(x.name).localeCompare(String(y.name))).map((q) => {
        const s = store.get('outreach_sequence_reply_settings', q.id, 'sequence_id');
        return { id: q.id, name: q.name, status: q.status, mode: s?.mode ?? 'draft', warmup_remaining: s?.warmup_remaining ?? null, downgraded_at: s?.downgraded_at ?? null, downgrade_reason: s?.downgrade_reason ?? null, waiting: waiting.get(`reply:${q.id}`) ?? 0 };
      }),
      variables: store.t('outreach_ai_variables').filter((v) => v.workspace_id === ws && !v.builtin).sort((x, y) => String(x.name).localeCompare(String(y.name))).map((v) => ({
        id: v.id, key: v.key, name: v.name, mode: v.mode ?? 'review', needs_posts: !!v.needs_posts, output: v.output ?? 'text', waiting: waiting.get(`line:${v.id}`) ?? 0,
        approved: store.t('outreach_ai_values').filter((x) => x.variable_id === v.id && x.status === 'approved').length,
      })),
      websites: liveInboxes(store, ws).sort((x, y) => String(x.created_at).localeCompare(String(y.created_at))).map((i) => ({
        id: i.id, name: i.name, is_active: i.is_active !== false, ai_enabled: !!i.ai_enabled, mode: i.settings?.ai?.mode ?? 'off',
        review_timeout_min: Number(i.settings?.ai?.review_timeout_min ?? 10) || 10, waiting: waiting.get(`website:${i.id}`) ?? 0,
      })),
      drafts: { open: store.t('outreach_tasks').filter((t) => t.workspace_id === ws && t.kind === 'review_ai_draft' && !t.completed_at).length },
      profile: { open: store.t('outreach_profile_changes').filter((p) => p.workspace_id === ws && p.source === 'ai_draft' && p.status === 'draft').length },
      questions_open: store.t('outreach_ai_unanswered_questions').filter((u) => u.workspace_id === ws && u.status === 'open').length,
    };
  },
  hub_qa_list: (a, ctx) => qaList(st(ctx), a.p_ws ?? ctx.ws),
  hub_qa_save: (a, ctx) => {
    const store = st(ctx);
    const ws = a.p_ws ?? ctx.ws;
    const q = str(a.p_question), ans = str(a.p_answer);
    if (!q || q.length > 500 || !ans || ans.length > 2000) demoError('E_PAYLOAD_INVALID', 'question up to 500 and answer up to 2000 characters, neither empty');
    const targets = checkTargets(store, ws, a.p_targets);
    let id: string;
    if (!a.p_id) {
      if (store.t('outreach_master_prompt_faqs').filter((f) => f.workspace_id === ws && !f.master_prompt_id).length >= 500) demoError('E_PAYLOAD_INVALID', 'up to 500 shared Q&A pairs per workspace');
      id = store.insert('outreach_master_prompt_faqs', { master_prompt_id: null, workspace_id: ws, question: q, answer: ans, source: 'manual', enabled: a.p_enabled !== false, created_by: ctx.userId, updated_at: iso() })[0].id;
    } else {
      const f = must(store.get('outreach_master_prompt_faqs', a.p_id));
      id = f.id;
      if (f.master_prompt_id) {
        const mp = must(store.get('outreach_master_prompts', f.master_prompt_id));
        const same = targets == null || (targets.length === 1 && targets[0].kind === 'sequence' && targets[0].id === mp.sequence_id);
        if (same) {
          store.update('outreach_master_prompt_faqs', id, { question: q, answer: ans, enabled: a.p_enabled ?? f.enabled, updated_at: iso() });
          bump(store, mp.id, 'substantive', 'Q&A edited', {}, ctx.userId);
          return { id, owner: 'sequence' };
        }
        store.update('outreach_master_prompt_faqs', id, { master_prompt_id: null, workspace_id: ws, question: q, answer: ans, enabled: a.p_enabled ?? f.enabled, updated_at: iso() });
        bump(store, mp.id, 'substantive', 'Q&A moved to the shared library', {}, ctx.userId);
      } else {
        store.update('outreach_master_prompt_faqs', id, { question: q, answer: ans, enabled: a.p_enabled ?? f.enabled, updated_at: iso() });
      }
    }
    setTargets(store, id, targets);
    return { id, owner: 'library', targets: qaTargets(store, id) };
  },
  hub_qa_delete: (a, ctx) => {
    const store = st(ctx);
    const f = must(store.get('outreach_master_prompt_faqs', a.p_id));
    store.remove('outreach_master_prompt_faqs', f.id);
    store.remove('outreach_knowledge_qa_links', (k) => k.qa_id === f.id);
    store.update('outreach_ai_unanswered_questions', (u) => u.answered_faq_id === f.id, { status: 'open', answered_faq_id: null });
    if (f.master_prompt_id) {
      bump(store, f.master_prompt_id, 'substantive', 'Q&A removed', {}, ctx.userId);
      return { faqs: faqs(store, f.master_prompt_id), ok: true };
    }
    return { ok: true };
  },
  hub_question_answer: (a, ctx) => {
    const store = st(ctx);
    const u = must(store.get('outreach_ai_unanswered_questions', a.p_group));
    if (u.status !== 'open') demoError('E_CONFLICT', 'this question was already handled');
    const ans = str(a.p_answer);
    if (ans.length < 2 || ans.length > 2000) demoError('E_PAYLOAD_INVALID', 'write the answer (up to 2000 characters)');
    const targets = checkTargets(store, u.workspace_id, a.p_targets);
    const f = store.insert('outreach_master_prompt_faqs', { master_prompt_id: null, workspace_id: u.workspace_id, question: String(u.canonical).slice(0, 500), answer: ans, source: 'unanswered', enabled: true, created_by: ctx.userId, updated_at: iso() })[0];
    setTargets(store, f.id, targets);
    store.update('outreach_ai_unanswered_questions', u.id, { status: 'answered', answered_faq_id: f.id });
    return { group_id: u.id, qa_id: f.id };
  },
  hub_question_dismiss: (a, ctx) => {
    const store = st(ctx);
    const u = must(store.get('outreach_ai_unanswered_questions', a.p_group));
    if (u.status !== 'open') demoError('E_CONFLICT', 'this question was already handled');
    store.update('outreach_ai_unanswered_questions', u.id, { status: 'dismissed', dismissed_reason: a.p_reason ? String(a.p_reason).slice(0, 300) : null });
    return { ok: true, group_id: u.id };
  },
  unanswered_list: (a, ctx) => {
    const store = st(ctx);
    seqOrThrow(store, a.p_sequence);
    const status = a.p_status ?? 'open';
    return store.t('outreach_ai_unanswered_questions').filter((u) => u.sequence_id === a.p_sequence && (status === 'all' || u.status === status)).map(unansweredJson)
      .sort((x, y) => y.count_30d - x.count_30d || String(y.last_seen_at).localeCompare(String(x.last_seen_at)));
  },
  unanswered_answer: (a, ctx) => {
    const store = st(ctx);
    const u = must(store.get('outreach_ai_unanswered_questions', a.p_group));
    if (!u.sequence_id) demoError('E_PAYLOAD_INVALID', 'this question came from a website: answer it in AI → Needs you');
    const mp = mpOfSequence(store, ctx, u.sequence_id);
    const ans = str(a.p_answer);
    if (ans.length < 2) demoError('E_PAYLOAD_INVALID', 'write the answer');
    const f = store.insert('outreach_master_prompt_faqs', { master_prompt_id: mp.id, workspace_id: mp.workspace_id, question: String(u.canonical).slice(0, 500), answer: ans.slice(0, 2000), source: 'unanswered', enabled: true, created_by: ctx.userId, updated_at: iso() })[0];
    store.update('outreach_ai_unanswered_questions', u.id, { status: 'answered', answered_faq_id: f.id });
    bump(store, mp.id, 'substantive', `Answer added for "${String(u.canonical).slice(0, 60)}"`, {}, ctx.userId);
    return { faq_id: f.id, group_id: u.id, faqs: faqs(store, mp.id) };
  },
  unanswered_dismiss: (a, ctx) => {
    const store = st(ctx);
    const u = must(store.get('outreach_ai_unanswered_questions', a.p_group));
    store.update('outreach_ai_unanswered_questions', u.id, { status: 'dismissed', dismissed_reason: a.p_reason ? String(a.p_reason).slice(0, 300) : null });
    return { ok: true };
  },

  // ---- knowledge ----------------------------------------------------------------------------------------------------
  hub_knowledge: (a, ctx) => {
    const store = st(ctx);
    const ws = a.p_ws ?? ctx.ws;
    const sources = store.t('outreach_knowledge_sources').filter((s) => s.workspace_id === ws).sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)))
      .map((s) => ({ ...ksJson(store, s), used_in: usedIn(store, s) }));
    return {
      sources, qa_total: qaList(store, ws).length,
      questions_open: store.t('outreach_ai_unanswered_questions').filter((u) => u.workspace_id === ws && u.status === 'open').length,
      targets: {
        sequences: store.t('outreach_sequences').filter((q) => q.workspace_id === ws && q.status !== 'archived').sort((x, y) => String(x.name).localeCompare(String(y.name))).map((q) => ({ id: q.id, name: q.name, status: q.status })),
        websites: liveInboxes(store, ws).sort((x, y) => String(x.name).localeCompare(String(y.name))).map((i) => ({ id: i.id, name: i.name })),
      },
    };
  },
  hub_knowledge_link: (a, ctx) => {
    const store = st(ctx);
    const s = must(store.get('outreach_knowledge_sources', a.p_source), 'knowledge source');
    const on = a.p_on !== false;
    if (a.p_kind === 'sequence') {
      if (s.kind === 'catalogue') demoError('E_PAYLOAD_INVALID', 'a product catalogue is used by websites, not by sequences');
      const mp = mpOfSequence(store, ctx, a.p_target);
      const ids: string[] = mp.knowledge_source_ids ?? [];
      if (on && !ids.includes(s.id)) { store.update('outreach_master_prompts', mp.id, { knowledge_source_ids: [...ids, s.id] }); bump(store, mp.id, 'substantive', `Knowledge "${String(s.title).slice(0, 60)}" attached`, {}, ctx.userId); }
      if (!on && ids.includes(s.id)) { store.update('outreach_master_prompts', mp.id, { knowledge_source_ids: ids.filter((x) => x !== s.id) }); bump(store, mp.id, 'substantive', 'Knowledge source detached', {}, ctx.userId); }
    } else if (a.p_kind === 'website') {
      const i = must(store.get('outreach_webchat_inboxes', a.p_target), 'website');
      if (s.kind === 'catalogue') {
        const ids = inboxCatalogueIds(i).filter((x) => x !== s.id);
        patchInbox(store, i.id, { products: { catalogue_ids: on ? [...ids, s.id] : ids } });
      } else {
        const ids = ((i.settings?.ai?.knowledge_source_ids ?? []) as string[]).filter((x) => x !== s.id);
        patchInbox(store, i.id, { ai: { knowledge_source_ids: on ? [...ids, s.id] : ids } });
      }
    } else demoError('E_PAYLOAD_INVALID', 'attach a source to a sequence or a website');
    return { ok: true, source_id: s.id, kind: a.p_kind, target_id: a.p_target, on };
  },
  knowledge_sources_list: (a, ctx) => {
    const store = st(ctx);
    return store.t('outreach_knowledge_sources').filter((s) => s.workspace_id === (a.p_ws ?? ctx.ws)).sort((x, y) => String(y.created_at).localeCompare(String(x.created_at))).map((s) => ksJson(store, s));
  },
  knowledge_source_add: (a, ctx) => {
    const store = st(ctx);
    const ws = a.p_ws ?? ctx.ws;
    const kind = a.p_kind;
    if (!['website', 'document', 'text'].includes(kind)) demoError('E_PAYLOAD_INVALID', 'kind is website, document or text');
    if (kind === 'website' && !/^https?:\/\/[^\s/]+/.test(str(a.p_url))) demoError('E_PAYLOAD_INVALID', 'a website needs an http(s) URL');
    if (kind === 'document' && !str(a.p_storage_path).startsWith(`${ws}/`)) demoError('E_PAYLOAD_INVALID', 'upload the file to the knowledge bucket under this workspace first');
    if (kind === 'text' && str(a.p_text).length < 20) demoError('E_PAYLOAD_INVALID', 'paste at least a few sentences');
    if (store.t('outreach_knowledge_sources').filter((s) => s.workspace_id === ws).length >= 50) demoError('E_PAYLOAD_INVALID', 'up to 50 knowledge sources per workspace');
    const title = str(a.p_title);
    if (!title || title.length > 200) demoError('E_PAYLOAD_INVALID', 'title 1–200 characters, text up to 200,000 characters, refresh 1–90 days');
    const p = str(a.p_storage_path);
    const ct = !p ? null : /\.pdf$/i.test(p) ? 'application/pdf' : /\.docx$/i.test(p) ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : /\.(md|markdown)$/i.test(p) ? 'text/markdown' : /\.html?$/i.test(p) ? 'text/html' : 'text/plain';
    const s = store.insert('outreach_knowledge_sources', {
      workspace_id: ws, kind, title, url: kind === 'website' ? str(a.p_url) : null, storage_path: kind === 'document' ? p : null, content_type: ct,
      text_inline: kind === 'text' ? String(a.p_text) : null, status: 'pending', error: null, pages: 0, chunks: 0, crawled_at: null,
      refresh_days: kind === 'website' ? a.p_refresh_days ?? null : null, created_by: ctx.userId, catalogue: null, detect_products: false, updated_at: iso(),
    })[0];
    queueCrawl(store, s.id);
    return ksJson(store, s);
  },
  knowledge_source_delete: (a, ctx) => {
    const store = st(ctx);
    const s = must(store.get('outreach_knowledge_sources', a.p_id));
    for (const mp of store.t('outreach_master_prompts').filter((m) => (m.knowledge_source_ids ?? []).includes(s.id))) {
      store.update('outreach_master_prompts', mp.id, { knowledge_source_ids: mp.knowledge_source_ids.filter((x: string) => x !== s.id) });
      bump(store, mp.id, 'substantive', `Knowledge source "${String(s.title).slice(0, 60)}" removed`, {}, ctx.userId);
    }
    for (const i of liveInboxes(store, s.workspace_id)) {
      const k: string[] = i.settings?.ai?.knowledge_source_ids ?? [];
      if (k.includes(s.id)) patchInbox(store, i.id, { ai: { knowledge_source_ids: k.filter((x) => x !== s.id) } });
      const c = inboxCatalogueIds(i);
      if (c.includes(s.id)) patchInbox(store, i.id, { products: { catalogue_ids: c.filter((x) => x !== s.id) } });
    }
    store.remove('outreach_products', (p) => p.source_id === s.id);
    store.remove('outreach_knowledge_sources', s.id);
    return null;
  },
  knowledge_attach: (a, ctx) => {
    const store = st(ctx);
    const mp = mpOfSequence(store, ctx, a.p_sequence);
    const s = store.t('outreach_knowledge_sources').find((x) => x.id === a.p_source && x.workspace_id === mp.workspace_id);
    if (!s) demoError('E_NOT_FOUND', 'knowledge source');
    if (!(mp.knowledge_source_ids ?? []).includes(s!.id)) {
      store.update('outreach_master_prompts', mp.id, { knowledge_source_ids: [...(mp.knowledge_source_ids ?? []), s!.id] });
      bump(store, mp.id, 'substantive', `Knowledge "${String(s!.title).slice(0, 60)}" attached`, {}, ctx.userId);
    }
    return { knowledge: knowledgeOf(store, store.get('outreach_master_prompts', mp.id)!) };
  },
  knowledge_detach: (a, ctx) => {
    const store = st(ctx);
    const mp = mpOfSequence(store, ctx, a.p_sequence);
    if ((mp.knowledge_source_ids ?? []).includes(a.p_source)) {
      store.update('outreach_master_prompts', mp.id, { knowledge_source_ids: mp.knowledge_source_ids.filter((x: string) => x !== a.p_source) });
      bump(store, mp.id, 'substantive', 'Knowledge source detached', {}, ctx.userId);
    }
    return { knowledge: knowledgeOf(store, store.get('outreach_master_prompts', mp.id)!) };
  },

  // ---- catalogue ----------------------------------------------------------------------------------------------------
  hub_catalogue_add: (a, ctx) => {
    const store = st(ctx);
    const ws = a.p_ws ?? ctx.ws;
    const provider = a.p_provider;
    if (!['shopify', 'woocommerce', 'feed', 'csv'].includes(provider)) demoError('E_PAYLOAD_INVALID', 'the source is a Shopify store, a WooCommerce store, a product feed or a CSV file');
    const cur = str(a.p_currency).toUpperCase() || null;
    if (cur && !/^[A-Z]{3}$/.test(cur)) demoError('E_PAYLOAD_INVALID', 'the currency is a three-letter code, like USD or INR');
    let u = str(a.p_url);
    if (provider === 'csv') {
      if (!str(a.p_storage_path).startsWith(`${ws}/`) || str(a.p_storage_path).includes('..')) demoError('E_PAYLOAD_INVALID', 'upload the CSV file first');
      u = '';
    } else {
      if (!/^https?:\/\//i.test(u) && /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}(\/.*)?$/i.test(u)) u = `https://${u}`;
      if (!/^https?:\/\/[^\s/?#:"<>]+\.[a-z]{2,}(:[0-9]{2,5})?([/?#][^\s"<>]*)?$/i.test(u) || u.length > 1000) demoError('E_PAYLOAD_INVALID', 'enter the address of the store or the feed (https://…)');
      if (provider === 'shopify') u = u.replace(/^(https?:\/\/[^/?#]+).*$/, '$1');
      else if (provider === 'woocommerce') u = u.replace(/[?#].*$/, '').replace(/\/+$/, '');
    }
    if (store.t('outreach_knowledge_sources').filter((s) => s.workspace_id === ws).length >= 50) demoError('E_PAYLOAD_INVALID', 'up to 50 knowledge sources per workspace');
    const title = (str(a.p_title) || u.replace(/^https?:\/\/(www\.)?/i, '').replace(/[/?#].*$/, '') || 'Product catalogue').slice(0, 200);
    const s = store.insert('outreach_knowledge_sources', {
      workspace_id: ws, kind: 'catalogue', title, url: u || null, storage_path: provider === 'csv' ? a.p_storage_path : null, content_type: provider === 'csv' ? 'text/csv' : null,
      text_inline: null, status: 'pending', error: null, pages: 0, chunks: 0, crawled_at: null, refresh_days: provider === 'csv' ? null : 1, created_by: ctx.userId,
      catalogue: { provider, ...(u ? { url: u } : {}), ...(cur ? { currency: cur } : {}), currency_locked: !!cur, products: 0 }, detect_products: false, updated_at: iso(),
    })[0];
    startSync(store, s.id);
    return ksJson(store, store.get('outreach_knowledge_sources', s.id)!);
  },
  hub_catalogue_update: (a, ctx) => {
    const store = st(ctx);
    const s = must(store.get('outreach_knowledge_sources', a.p_source));
    const p: Row = a.p_patch ?? {};
    if (s.kind === 'website') {
      if (typeof p.detect_products !== 'boolean') demoError('E_PAYLOAD_INVALID', 'a website source takes detect_products (true or false)');
      if (p.detect_products !== !!s.detect_products) {
        if (p.detect_products) { store.update('outreach_knowledge_sources', s.id, { detect_products: true, status: 'pending', updated_at: iso() }); queueCrawl(store, s.id); }
        else {
          store.update('outreach_products', (x) => x.source_id === s.id && !x.deleted_at, { deleted_at: iso(), updated_at: iso() });
          store.update('outreach_knowledge_sources', s.id, { detect_products: false, catalogue: null, updated_at: iso() });
        }
      }
      return ksJson(store, store.get('outreach_knowledge_sources', s.id)!);
    }
    if (s.kind !== 'catalogue') demoError('E_PAYLOAD_INVALID', 'not a product catalogue');
    const patch: Row = { updated_at: iso() };
    let cat = { ...(s.catalogue ?? {}) };
    let resync = false;
    if ('title' in p) { const t = str(p.title); if (!t || t.length > 200) demoError('E_PAYLOAD_INVALID', 'title 1–200 characters'); patch.title = t; }
    if ('currency' in p) {
      const c = str(p.currency).toUpperCase() || null;
      if (c && !/^[A-Z]{3}$/.test(c)) demoError('E_PAYLOAD_INVALID', 'the currency is a three-letter code, like USD or INR');
      if (!c) { cat.currency_locked = false; resync = true; }
      else { cat = { ...cat, currency: c, currency_locked: true }; store.update('outreach_products', (x) => x.source_id === s.id && x.currency !== c, { currency: c, updated_at: iso() }); }
    }
    if ('refresh_days' in p) {
      if (p.refresh_days == null) patch.refresh_days = null;
      else {
        const d = Number(p.refresh_days);
        if (!Number.isInteger(d) || d < 1 || d > 90) demoError('E_PAYLOAD_INVALID', 'refresh every 1 to 90 days');
        if (cat.provider === 'csv') demoError('E_PAYLOAD_INVALID', 'a CSV catalogue changes when you upload a new file');
        patch.refresh_days = d;
      }
    }
    if ('storage_path' in p) {
      if (cat.provider !== 'csv') demoError('E_PAYLOAD_INVALID', 'only a CSV catalogue takes a file');
      if (!str(p.storage_path).startsWith(`${s.workspace_id}/`)) demoError('E_PAYLOAD_INVALID', 'upload the CSV file first');
      patch.storage_path = p.storage_path; resync = true;
    }
    if (p.sync === true) resync = true;
    delete cat.sync;
    patch.catalogue = cat;
    if (resync) { patch.status = 'pending'; patch.error = null; }
    store.update('outreach_knowledge_sources', s.id, patch);
    if (resync) startSync(store, s.id, 900);
    return ksJson(store, store.get('outreach_knowledge_sources', s.id)!);
  },
  hub_catalogue_products: (a, ctx) => {
    const store = st(ctx);
    const s = must(store.get('outreach_knowledge_sources', a.p_source));
    if (s.kind !== 'catalogue' && !s.detect_products) demoError('E_PAYLOAD_INVALID', 'not a product catalogue');
    const q = str(a.p_query).toLowerCase();
    const lim = Math.max(1, Math.min(Number(a.p_limit ?? 50), 200)), off = Math.max(0, Number(a.p_offset ?? 0));
    const all = store.t('outreach_products').filter((p) => p.source_id === s.id && !p.deleted_at);
    const match = all.filter((p) => !q || [p.title, p.handle, p.sku, p.product_type, p.vendor].some((x) => String(x ?? '').toLowerCase().includes(q)))
      .sort((x, y) => String(x.title).localeCompare(String(y.title)) || String(x.id).localeCompare(String(y.id)));
    return {
      source: ksJson(store, s), total: match.length, hidden: all.filter((p) => p.ai_hidden).length,
      products: match.slice(off, off + lim).map((x) => ({
        id: x.id, title: x.title, url: x.url, image: x.image_url ?? null, price: x.price ?? null, compare_at: x.compare_at_price != null && x.compare_at_price > x.price ? x.compare_at_price : null,
        currency: x.currency ?? null, available: !!x.available, product_type: x.product_type ?? null, vendor: x.vendor ?? null, sku: x.sku ?? null, handle: x.handle ?? null,
        variants: (x.variants ?? []).length, seen_at: x.seen_at, ai_hidden: !!x.ai_hidden, pinned_keywords: [...(x.pinned_keywords ?? [])],
      })),
    };
  },
  hub_product_set: (a, ctx) => {
    const store = st(ctx);
    const p = store.get('outreach_products', a.p_id);
    if (!p || p.deleted_at) demoError('E_NOT_FOUND');
    let kw: string[] | null = null;
    if (Array.isArray(a.p_pinned_keywords)) {
      kw = [...new Set((a.p_pinned_keywords as string[]).map((k) => String(k).trim().toLowerCase()).filter(Boolean))];
      if (kw.length > 10 || kw.some((k) => k.length > 40)) demoError('E_PAYLOAD_INVALID', 'up to 10 keywords of 40 characters');
    }
    const u = store.update('outreach_products', p!.id, { ai_hidden: a.p_ai_hidden ?? p!.ai_hidden, pinned_keywords: kw ?? p!.pinned_keywords, updated_at: iso() })[0];
    return { id: u.id, ai_hidden: !!u.ai_hidden, pinned_keywords: [...u.pinned_keywords] };
  },
  hub_product_search: (a, ctx) => {
    const store = st(ctx);
    const ws = a.p_ws ?? ctx.ws;
    const productSources = store.t('outreach_knowledge_sources').filter((s) => s.workspace_id === ws && (s.kind === 'catalogue' || s.detect_products)).map((s) => s.id);
    let src: string[] = [];
    if (a.p_inbox) {
      const i = must(store.get('outreach_webchat_inboxes', a.p_inbox));
      src = inboxCatalogueIds(i).filter((id) => productSources.includes(id));
    }
    if (a.p_source) { if (!productSources.includes(a.p_source)) demoError('E_NOT_FOUND', 'catalogue'); src = [a.p_source]; }
    else if (!src.length) src = productSources;
    return searchProducts(store, src, a.p_query ?? null, { maxPrice: a.p_max_price ?? null, limit: Math.max(1, Math.min(Number(a.p_limit ?? 20), 50)), includeHidden: true });
  },

  // ---- website modes -------------------------------------------------------------------------------------------------
  hub_website_set_mode: (a, ctx) => {
    const store = st(ctx);
    const i = store.get('outreach_webchat_inboxes', a.p_inbox);
    if (!i || i.deleted_at) demoError('E_NOT_FOUND');
    if (!['off', 'review', 'auto'].includes(a.p_mode)) demoError('E_PAYLOAD_INVALID', 'mode is off, review or auto');
    if (a.p_when != null && !['always', 'outside_hours'].includes(a.p_when)) demoError('E_PAYLOAD_INVALID', 'when is always or outside_hours');
    if (a.p_review_timeout_min != null && (a.p_review_timeout_min < 1 || a.p_review_timeout_min > 240)) demoError('E_PAYLOAD_INVALID', 'the review timeout is 1 to 240 minutes');
    const cur = i!.settings?.ai?.mode ?? 'off';
    const ai: Row = {};
    if (a.p_review_timeout_min != null) ai.review_timeout_min = Number(a.p_review_timeout_min);
    let enabled: boolean;
    if (a.p_mode === 'off') enabled = false;
    else if (a.p_mode === 'review') { enabled = true; ai.mode = 'review'; }
    else { enabled = true; ai.mode = (a.p_when ?? (cur === 'offline_only' ? 'outside_hours' : 'always')) === 'outside_hours' ? 'offline_only' : 'first'; }
    return patchInbox(store, i!.id, { ai_enabled: enabled, ai });
  },

  // ---- lead notes ----------------------------------------------------------------------------------------------------
  lead_notes_get: (a, ctx) => {
    const store = st(ctx);
    must(store.get('outreach_leads', a.p_lead));
    const n = store.get('outreach_lead_ai_notes', a.p_lead, 'lead_id');
    return { lead_id: a.p_lead, summary: n?.summary ?? null, items: n?.items ?? [], updated_at: n?.updated_at ?? null };
  },
  lead_notes_update: (a, ctx) => {
    const store = st(ctx);
    const l = must(store.get('outreach_leads', a.p_lead));
    if (!Array.isArray(a.p_items) || a.p_items.length > 20) demoError('E_PAYLOAD_INVALID', 'items is a list of up to 20 notes');
    const keys = ['budget', 'timeline', 'current_solution', 'pain', 'objection', 'decision_maker', 'interest', 'other'];
    const n = store.get('outreach_lead_ai_notes', l.id, 'lead_id') ?? store.insert('outreach_lead_ai_notes', { lead_id: l.id, workspace_id: l.workspace_id, summary: null, items: [], updated_at: iso() }, { noId: true })[0];
    const out: Row[] = [];
    for (const it of a.p_items as Row[]) {
      const text = str(it?.text);
      if (!text) continue;
      const key = keys.includes(it.key) ? it.key : 'other';
      const old = (n.items ?? []).find((x: Row) => x.id === it.id);
      if (old && old.text === text && old.key === key) { out.push(old); continue; }
      out.push({ id: it.id || ctx.store.uid(), key, text: text.slice(0, 300), source_message_id: old?.source_message_id ?? null, updated_at: iso(), edited_by: ctx.userId, locked: true, history: old ? [...(old.history ?? []), { text: old.text, at: old.updated_at }] : [] });
    }
    store.update('outreach_lead_ai_notes', (r) => r.lead_id === l.id, { items: out, updated_at: iso() });
    const cur = store.get('outreach_lead_ai_notes', l.id, 'lead_id')!;
    return { lead_id: l.id, summary: cur.summary ?? null, items: cur.items, updated_at: cur.updated_at };
  },

  // ---- prompts -------------------------------------------------------------------------------------------------------
  master_prompt_copy: (a, ctx) => {
    const store = st(ctx);
    const mp = mpOfSequence(store, ctx, a.p_sequence);
    let src: Row | undefined;
    if (a.p_from_sequence) { seqOrThrow(store, a.p_from_sequence); src = store.t('outreach_master_prompts').find((m) => m.scope === 'sequence' && m.sequence_id === a.p_from_sequence); }
    else if (a.p_from_library) src = store.t('outreach_master_prompts').find((m) => m.id === a.p_from_library && m.scope === 'library');
    else demoError('E_PAYLOAD_INVALID', 'give a sequence or a library prompt to copy from');
    if (!src) demoError('E_NOT_FOUND', 'nothing to copy from');
    if (src!.id === mp.id) demoError('E_PAYLOAD_INVALID', 'that is this sequence\'s own prompt');
    store.remove('outreach_master_prompt_scenarios', (c) => c.master_prompt_id === mp.id);
    for (const c of store.t('outreach_master_prompt_scenarios').filter((x) => x.master_prompt_id === src!.id)) store.insert('outreach_master_prompt_scenarios', { master_prompt_id: mp.id, position: c.position, title: c.title, when_text: c.when_text, do_text: c.do_text, enabled: c.enabled, updated_by: ctx.userId, updated_at: iso() });
    store.remove('outreach_master_prompt_faqs', (f) => f.master_prompt_id === mp.id);
    for (const f of store.t('outreach_master_prompt_faqs').filter((x) => x.master_prompt_id === src!.id)) store.insert('outreach_master_prompt_faqs', { master_prompt_id: mp.id, workspace_id: mp.workspace_id, question: f.question, answer: f.answer, source: 'import', enabled: f.enabled, created_by: ctx.userId, updated_at: iso() });
    const nv = mp.version + 1;
    store.update('outreach_master_prompts', mp.id, {
      editor_mode: src!.editor_mode, version: nv, body: src!.body, sections: src!.sections, settings: src!.settings, substantive_version: nv, substantive_at: iso(),
      copied_from_prompt_id: src!.id, copied_from_version: src!.version, knowledge_source_ids: [...(src!.knowledge_source_ids ?? [])], updated_by: ctx.userId, updated_at: iso(),
    });
    const from = src!.scope === 'sequence' ? `sequence "${store.get('outreach_sequences', src!.sequence_id)?.name ?? '?'}"` : `library prompt "${src!.name ?? '?'}"`;
    store.insert('outreach_master_prompt_versions', { master_prompt_id: mp.id, version: nv, editor_mode: src!.editor_mode, body: src!.body, sections: src!.sections, settings: src!.settings, change_kind: 'substantive', note: `Copied from ${from} v${src!.version}`, created_by: ctx.userId, created_at: iso(), scenarios: cards(store, mp.id), faqs: faqs(store, mp.id) }, { noId: true });
    return { ...mpJson(store, store.get('outreach_master_prompts', mp.id)), change_kind: 'substantive' };
  },
  master_prompt_versions: (a, ctx) => {
    const store = st(ctx);
    const mp = must(store.get('outreach_master_prompts', a.p_mp));
    return store.t('outreach_master_prompt_versions').filter((v) => v.master_prompt_id === mp.id).sort((x, y) => y.version - x.version).map((v) => ({
      version: v.version, change_kind: v.change_kind, note: v.note ?? null, editor_mode: v.editor_mode, body: v.body, sections: v.sections ?? null,
      settings: { ...defaultSettings(), ...(v.settings ?? {}) }, scenarios: v.scenarios ?? [], faqs: v.faqs ?? [], created_at: v.created_at, created_by_name: memberName(store, v.created_by),
    }));
  },
  master_prompt_library_list: (a, ctx) => {
    const store = st(ctx);
    const ws = a.p_ws ?? ctx.ws;
    const dflt = store.get('outreach_workspace_reply_settings', ws, 'workspace_id')?.default_prompt_id ?? null;
    return store.t('outreach_master_prompts').filter((m) => m.workspace_id === ws && m.scope === 'library').sort((x, y) => String(x.name).localeCompare(String(y.name))).map((m) => ({
      id: m.id, name: m.name, version: m.version, editor_mode: m.editor_mode, updated_at: m.updated_at, is_default: m.id === dflt,
      used_by: store.t('outreach_master_prompts').filter((x) => x.copied_from_prompt_id === m.id && x.scope === 'sequence').length,
    }));
  },
  master_prompt_library_get: (a, ctx) => {
    const store = st(ctx);
    return mpJson(store, must(store.t('outreach_master_prompts').find((m) => m.id === a.p_id && m.scope === 'library')));
  },
  master_prompt_library_save: (a, ctx) => librarySave(st(ctx), ctx, a),
  master_prompt_library_delete: (a, ctx) => {
    const store = st(ctx);
    const mp = must(store.t('outreach_master_prompts').find((m) => m.id === a.p_id && m.scope === 'library'));
    store.update('outreach_workspace_reply_settings', (w) => w.default_prompt_id === mp.id, { default_prompt_id: null, updated_at: iso() });
    store.remove('outreach_master_prompt_scenarios', (c) => c.master_prompt_id === mp.id);
    store.remove('outreach_master_prompt_faqs', (f) => f.master_prompt_id === mp.id);
    store.remove('outreach_master_prompt_versions', (v) => v.master_prompt_id === mp.id);
    store.update('outreach_master_prompts', (m) => m.copied_from_prompt_id === mp.id, { copied_from_prompt_id: null });
    store.remove('outreach_master_prompts', mp.id);
    return null;
  },
  master_prompt_template: () => { const t = template(); return { editor_mode: 'guided', body: t.body, sections: t.sections, settings: t.settings, scenarios: t.scenarios }; },

  // ---- sequence card -------------------------------------------------------------------------------------------------
  sequence_ai_replies_get: (a, ctx) => seqRepliesGet(st(ctx), a.p_sequence, ctx.userId),
  sequence_ai_summary: (a, ctx) => seqSummary(st(ctx), a.p_sequence),

  // ---- workspace settings --------------------------------------------------------------------------------------------
  workspace_ai_settings: (a, ctx) => {
    const store = st(ctx);
    const r = store.t('outreach_workspace_secrets').find((s) => s.workspace_id === (a.p_ws ?? ctx.ws));
    return {
      llm_provider: r?.llm_provider ?? 'platform', llm_model: r?.llm_model ?? null, llm_key_hint: r?.llm_key_hint ?? null, uses_own_key: !!(r?.llm_key_enc || r?.uses_own_key),
      finders: ((r?.finder_keys ?? []) as Row[]).map((x) => ({ provider: x.provider, hint: x.hint })),
      verifier: r?.verifier ? { provider: r.verifier.provider, hint: r.verifier.hint } : null,
      booking_webhook_secret: r?.booking_secret ?? 'demo-booking-secret',
    };
  },
  workspace_reply_settings_get: (a, ctx) => wrsGet(st(ctx), a.p_ws ?? ctx.ws),
  workspace_reply_settings_set: (a, ctx) => {
    const store = st(ctx);
    const ws = a.p_ws ?? ctx.ws;
    const p: Row = a.p_patch ?? {};
    const bad = Object.keys(p).filter((k) => !['max_ai_sends_per_sender_day', 'default_prompt_id'].includes(k));
    if (bad.length) demoError('E_PAYLOAD_INVALID', `unknown field(s) ${bad.join(', ')}`);
    if (p.default_prompt_id && !store.t('outreach_master_prompts').some((m) => m.id === p.default_prompt_id && m.workspace_id === ws && m.scope === 'library')) demoError('E_PAYLOAD_INVALID', 'default prompt must be a library prompt of this workspace');
    if ('max_ai_sends_per_sender_day' in p) { const n = Number(p.max_ai_sends_per_sender_day); if (!Number.isInteger(n) || n < 1 || n > 40) demoError('E_PAYLOAD_INVALID', 'the cap is 1–40 AI sends a day per sender'); }
    const cur = store.get('outreach_workspace_reply_settings', ws, 'workspace_id') ?? store.insert('outreach_workspace_reply_settings', { workspace_id: ws, max_ai_sends_per_sender_day: 25, default_prompt_id: null, updated_by: null, updated_at: iso() }, { noId: true })[0];
    store.update('outreach_workspace_reply_settings', (r) => r === cur, {
      ...('max_ai_sends_per_sender_day' in p ? { max_ai_sends_per_sender_day: Number(p.max_ai_sends_per_sender_day) } : {}),
      ...('default_prompt_id' in p ? { default_prompt_id: p.default_prompt_id || null } : {}), updated_by: ctx.userId, updated_at: iso(),
    });
    return wrsGet(store, ws);
  },
} satisfies RpcArea;

/** Table hooks (insert defaults, side effects) for this area's tables. Called once at boot. */
let registered = false;
export function registerAi(): void {
  // Activity and Needs you are views: rebuilt from their tables when read
  const views = (rebuild: (s: DemoStore) => void) => (s: DemoStore) => { attachAi(s); pump(s); rebuild(s); };
  tableHooks.outreach_ai_needs_you = { ...(tableHooks.outreach_ai_needs_you ?? {}), beforeRead: views(rebuildNeedsYou) };
  tableHooks.outreach_ai_outputs = { ...(tableHooks.outreach_ai_outputs ?? {}), beforeRead: views(rebuildOutputs) };
  // background work (lines being written, crawls, syncs) finishes on the next read after a reload
  for (const t of ['outreach_ai_values', 'outreach_ai_batches', 'outreach_webchat_ai_suggestions']) {
    const prev = tableHooks[t]?.beforeRead;
    tableHooks[t] = { ...(tableHooks[t] ?? {}), beforeRead: (s) => { attachAi(s); pump(s); prev?.(s); } };
  }
  // a variable created from the form (db.from insert) gets the columns' defaults
  tableHooks.outreach_ai_variables = {
    ...(tableHooks.outreach_ai_variables ?? {}),
    beforeInsert: (row) => {
      if (!/^[a-z][a-z0-9_]{1,39}$/.test(String(row.key ?? ''))) throw Object.assign(new Error('E_PAYLOAD_INVALID: the key starts with a letter and uses 2 to 40 lowercase letters, digits or underscores'), { code: 'E_PAYLOAD_INVALID' });
      return { fallback: '', needs_posts: false, max_chars: 220, mode: 'review', output: 'text', fields: [], builtin: false, updated_at: new Date().toISOString(), ...row };
    },
    readOnly: ['output', 'builtin'],
    afterWrite: (kind, rows, s) => {
      if (kind !== 'delete') return;
      const ids = new Set(rows.map((r) => r.id));
      s.remove('outreach_ai_values', (v) => ids.has(v.variable_id));
      s.remove('outreach_ai_batches', (b) => ids.has(b.variable_id));
    },
  };
  if (registered) return;
  registered = true;
  simHooks.onReply.push((store, info) => onSimReply(store, info));
  void finishBatch;
}
