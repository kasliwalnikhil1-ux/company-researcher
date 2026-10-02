/**
 * Demo edge functions: voice-admin (supabase/functions/outreach-voice-admin). No voice provider: fictional voices,
 * drafts and syncs that succeed locally, a test session that plays the sample call (webchat/voice.ts), scripted checks
 * that pass on a timer, and call recordings as a small generated WAV.
 */
import { demoError, type Ctx, type FnArea, type FnRequest } from '../ctx';
import type { Row } from '../store';
import { T, checkVoice, inboxOr404, settingsOf } from '../webchat/core';
import { faqsFor } from '../webchat/answer';
import { ACCOUNT_VOICES, LIBRARY_VOICES, listVoices, queueSampleSession, sampleReply, sampleTurns, sampleWav, voiceLimits, voicePool } from '../webchat/voice';
import { bindWidgetCtx } from '../webchat/widget';

const iso = (ms = Date.now()) => new Date(ms).toISOString();

function agentRow(ctx: Ctx, inbox: Row, which: 'live' | 'test'): Row {
  const s = ctx.store;
  return s.t(T.voiceAgents).find((a) => a.inbox_id === inbox.id && a.which === which)
    ?? s.insert(T.voiceAgents, { inbox_id: inbox.id, which, workspace_id: inbox.workspace_id, account: 'platform', el_agent_id: null, synced_at: null, sync_error: null, sync_attempts: 0, archived: false, draft: null, draft_at: null })[0];
}

/** "Sync" an agent: in the demo it is whatever the settings say, at once. */
function sync(ctx: Ctx, inbox: Row, which: 'live' | 'test'): Row {
  const st = settingsOf(inbox), a = agentRow(ctx, inbox, which);
  const on = which === 'test' || st.voice?.enabled === true;
  ctx.store.update(T.voiceAgents, a.id, { el_agent_id: on ? `demo-agent-${which}-${inbox.id.slice(0, 8)}` : a.el_agent_id, archived: !on, synced_at: iso(), sync_error: null, sync_attempts: 0, updated_at: iso() });
  return { ok: true, state: on ? 'synced' : 'off', error: null };
}

function voiceAdmin(req: FnRequest, ctx: Ctx): unknown {
  bindWidgetCtx(ctx);
  const s = ctx.store, path = req.path.replace(/\/+$/, '') || '/', m = req.method.toUpperCase(), b = req.body ?? {};
  if (m === 'GET' && (path === '/voices' || path === '/voices/library')) return listVoices(s, req.query.get('workspace_id') ?? ctx.ws, req.query, path === '/voices/library');
  if (m === 'POST' && path === '/voices/add') {
    const v = LIBRARY_VOICES.find((x) => x.voice_id === b.voice_id) ?? ACCOUNT_VOICES.find((x) => x.voice_id === b.voice_id);
    if (!v) demoError('E_PAYLOAD_INVALID', 'voice');
    const added = s.meta<Row[]>('webchat:voicesAdded', () => []);
    if (!added.some((x) => x.voice_id === v!.voice_id)) s.setMeta('webchat:voicesAdded', [...added, { ...v!, source: 'account', category: 'professional', public_owner_id: undefined }]);
    return { voice_id: v!.voice_id };
  }
  const ib = /^\/inboxes\/([0-9a-f-]{36})\/voice\/(draft|sync|test-session|test-end|run-checks)$/.exec(path);
  if (ib) {
    const inbox = inboxOr404(ctx, ib[1]), action = ib[2];
    if (m === 'POST' && action === 'draft') {
      const draft = b.draft && typeof b.draft === 'object' ? b.draft : null;
      if (draft) checkVoice(draft);
      const a = agentRow(ctx, inbox, 'test');
      s.update(T.voiceAgents, a.id, { draft, draft_at: iso(), updated_at: iso() });
      return sync(ctx, inbox, 'test');
    }
    if (m === 'POST' && action === 'sync') {
      if (b.clear_draft) s.update(T.voiceAgents, (a) => a.inbox_id === inbox.id && a.which === 'test', { draft: null, draft_at: iso() });
      const r = sync(ctx, inbox, b.which === 'test' ? 'test' : 'live');
      if (b.clear_draft) sync(ctx, inbox, 'test');
      ctx.ui.simulated('Voice agent updated in the demo. Nothing was sent to a voice provider.');
      return r;
    }
    if (m === 'POST' && action === 'test-session') {
      const pool = voicePool(s, inbox.workspace_id);
      if (!pool.ok) demoError('E_VOICE_MINUTES', "this month's voice minutes are used up");
      if (b.draft && typeof b.draft === 'object') { checkVoice(b.draft); s.update(T.voiceAgents, agentRow(ctx, inbox, 'test').id, { draft: b.draft, draft_at: iso() }); }
      sync(ctx, inbox, 'test');
      const lim = voiceLimits(s, inbox.workspace_id);
      const st = settingsOf(inbox);
      const langs = [String(st.voice?.language ?? st.locale?.default ?? 'en').slice(0, 3), ...(st.voice?.languages ?? [])];
      const language = langs.includes(String(b.language)) ? String(b.language) : langs[0];
      // a test call in progress from earlier is closed first, as the real function does
      s.update(T.voiceCalls, (k) => k.inbox_id === inbox.id && k.test && k.started_by === ctx.userId && ['starting', 'in_progress'].includes(k.status), (k) => ({ status: 'ended_unconfirmed', ended_at: iso(), ended_reason: k.ended_reason ?? 'visitor', duration_s: Math.round((Date.now() - Date.parse(k.started_at)) / 1000) }));
      const call = s.insert(T.voiceCalls, { workspace_id: inbox.workspace_id, inbox_id: inbox.id, chat_id: null, visitor_id: null, el_conversation_id: `demo-conv-${s.uid().slice(0, 8)}`, el_agent_id: `demo-agent-test-${inbox.id.slice(0, 8)}`,
        account: 'platform', test: true, status: 'in_progress', started_at: iso(), ended_at: null, ended_reason: null, duration_s: null, language, summary: null, title: null, successful: null, collected: {},
        tool_calls: 0, empty_searches: 0, has_audio: false, handoff_reason: null, max_minutes: lim.max_minutes, agent_turns: 0, page_url: b.page_url ?? null, started_by: ctx.userId, finalized_at: null })[0];
      queueSampleSession(call.id, sampleTurns(s, inbox, language), (text) => sampleReply(s, inbox, text));
      ctx.ui.toast('Sample call: the demo plays a recorded example. No microphone is used and nothing is sent.');
      return { call_id: call.id, conversation_token: `demo-token-${call.id.slice(0, 8)}`, el_conversation_id: call.el_conversation_id, max_minutes: lim.max_minutes, language, languages: langs,
        dynamic_variables: { brand: String(st.appearance?.brand_name ?? inbox.name), page_title: String(b.page_title ?? ''), page_url: String(b.page_url ?? ''), visitor_name: String(b.visitor_name ?? '') || 'not known yet', recent_chat: 'nothing yet', today: new Date().toDateString(), secret__session: 'demo' } };
    }
    if (m === 'POST' && action === 'test-end') {
      s.update(T.voiceCalls, (k) => k.id === b.call_id && k.test && ['starting', 'in_progress'].includes(k.status), (k) => ({ status: 'done', ended_at: iso(), ended_reason: 'visitor', duration_s: Math.max(1, Math.round((Date.now() - Date.parse(k.started_at)) / 1000)), finalized_at: iso() }));
      return { ok: true };
    }
    if (m === 'POST' && action === 'run-checks') {
      const st = settingsOf(inbox), qa = faqsFor(s, inbox)[0];
      const tests = [
        { key: 'question', name: qa ? 'Answers a common question' : 'Answers a factual question' },
        ...(st.ai?.products?.enabled ? [{ key: 'budget', name: 'Suggests a product within a budget' }] : []),
        { key: 'human', name: 'Hands over to a person' },
        { key: 'off_topic', name: 'Stays on topic' },
        ...((st.voice?.languages ?? []).length ? [{ key: 'language', name: 'Switches language' }] : []),
      ].slice(0, 5).map((x, i) => ({ id: `demotest${i + 1}${s.uid().slice(0, 6)}`, ...x }));
      const call = s.insert(T.voiceCalls, { workspace_id: inbox.workspace_id, inbox_id: inbox.id, chat_id: null, visitor_id: null, el_conversation_id: `sim-${s.uid()}`, el_agent_id: 'demo-agent-test', account: 'platform',
        test: true, status: 'failed', started_at: iso(), ended_at: iso(), ended_reason: 'visitor', duration_s: 0, finalized_at: iso(), has_audio: false, collected: {}, max_minutes: 5, agent_turns: 0, started_by: ctx.userId })[0];
      const runId = `demorun${s.uid().replace(/-/g, '').slice(0, 12)}`;
      s.setMeta(`webchat:run:${runId}`, { at: Date.now(), inbox: inbox.id, tests });
      return { run_id: runId, call_id: call.id, tests: tests.map(({ id, key, name }) => ({ id, key, name })) };
    }
    if (m === 'GET' && action === 'run-checks') {
      const run = s.state.meta[`webchat:run:${req.query.get('run') ?? ''}`] as { at: number; tests: Array<{ id: string; key: string; name: string }> } | undefined;
      if (!run) demoError('E_PAYLOAD_INVALID', 'run');
      const st = settingsOf(inbox), brand = String(st.appearance?.brand_name ?? inbox.name), qa = faqsFor(s, inbox)[0];
      const replies: Record<string, string[]> = {
        question: [qa ? qa.answer.split(/(?<=[.!?])\s/).slice(0, 2).join(' ') : `${brand} answers from its notes, and when it is not sure it offers to pass you to the team.`],
        budget: ['A good pick within that budget is in our catalogue. I can put it in the chat with its link.'],
        human: ['Of course. I am passing you to the team now, they will pick this up in the chat.'],
        off_topic: [`I can only help with questions about ${brand}. Is there anything about us I can help with?`],
        language: ['Claro, seguimos en español. ¿En qué puedo ayudarte?'],
      };
      const elapsed = Date.now() - run!.at;
      const results = run!.tests.map((t, i) => ({ test_id: t.id, status: elapsed > 2500 + i * 1800 ? 'passed' : 'pending', why: elapsed > 2500 + i * 1800 ? 'The sample assistant met the success condition (demo check).' : null, replies: elapsed > 2500 + i * 1800 ? replies[t.key] ?? [] : [] }));
      return { finished: results.every((r) => r.status !== 'pending'), results };
    }
  }
  const au = /^\/voice-calls\/([0-9a-f-]{36})\/audio$/.exec(path);
  if (m === 'GET' && au) {
    const call = s.get(T.voiceCalls, au[1]);
    if (call && !call.has_audio) demoError('E_NO_RECORDING', 'This call has no recording.');
    const inbox = (call && s.get(T.inboxes, call.inbox_id)) || s.t(T.inboxes).find((i) => i.workspace_id === ctx.ws && !i.deleted_at);
    if (!inbox) demoError('E_NOT_FOUND', 'call');
    const turns = sampleTurns(s, inbox!, call?.language ?? null);
    return new Response(sampleWav(turns), { status: 200, headers: { 'content-type': 'audio/wav', 'cache-control': 'private, max-age=300' } });
  }
  return demoError('E_NOT_FOUND', `no route ${m} ${path}`);
}

export const webchatFn = {
  'voice-admin': voiceAdmin,
} satisfies FnArea;
