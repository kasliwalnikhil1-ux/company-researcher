/** Demo seed: AI variables and lines (before the history, so messages use them), needs-you items, knowledge, Q&A, catalogue, scenarios. */
import { fieldsSummary } from '../../../aiFields';
import type { AiField } from '../../../types';
import { personalLine } from '../ai';
import { FERNHILL, productRow } from '../aihub/catalogue';
import { DEMO_MODEL, generateFor } from '../aihub/jobs';
import { AI_IDS } from '../aihub/knowledge';
import { bump, compilePrompt, defaultScenarios, defaultSections, defaultSettings, ensureSeqSettings } from '../aihub/prompt';
import { openRun, updateRun } from '../aihub/replies';
import { engineFor } from '../sim/engine';
import type { DemoStore, Row } from '../store';
import { DEMO_USER_EMAIL, DEMO_WS_ID, MEMBER, SENDER, SEQ, leadId } from './ids';

const D = 86_400_000;
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

const FIT_FIELDS: AiField[] = [
  { key: 'icp_fit', name: 'ICP fit', type: 'choice', options: ['High', 'Medium', 'Low'], description: 'How well the agency matches our ideal customer' },
  { key: 'decision_maker', name: 'Decision maker', type: 'yes_no', description: 'Owner, partner or head of growth' },
  { key: 'team_size', name: 'Team size', type: 'number', description: 'People at the agency, from the profile' },
  { key: 'pain', name: 'Likely pain', type: 'text', max_chars: 120, description: 'The one problem they most likely have with new business' },
];
const PAINS = ['Pipeline depends on referrals', 'Founder does all the selling', 'Long gaps between new clients', 'Outbound feels spammy to them', 'No time for follow-ups'];

function variable(s: DemoStore, id: string, o: Row, now: number): Row {
  return s.insert('outreach_ai_variables', {
    id, workspace_id: DEMO_WS_ID, fallback: '', needs_posts: false, max_chars: 220, mode: 'review', output: 'text', fields: [], builtin: false,
    created_by: MEMBER.maya, created_at: iso(now - 50 * D), updated_at: iso(now - 20 * D), ...o,
  })[0];
}

function value(s: DemoStore, v: Row, lead: string, batch: string, status: string, at: number, extra: Row = {}): Row {
  const g = generateFor(s, v, lead);
  const approved = status === 'approved';
  return s.insert('outreach_ai_values', {
    workspace_id: DEMO_WS_ID, lead_id: lead, variable_id: v.id, batch_id: batch, text: status === 'blank' ? null : g.text, data: g.data, facts: g.facts,
    status, edited: false, model: DEMO_MODEL, error: null, approved_by: approved ? MEMBER.maya : null, approved_at: approved ? iso(at + 2 * H) : null,
    locked_at: null, attempts: 1, generated_at: status === 'blank' ? null : iso(at), created_at: iso(at - 10 * 60_000), updated_at: iso(approved ? at + 2 * H : at), ...extra,
  })[0];
}

function batch(s: DemoStore, v: Row, total: number, status: string, at: number, seq: string | null): Row {
  return s.insert('outreach_ai_batches', { workspace_id: DEMO_WS_ID, variable_id: v.id, sequence_id: seq, requested_by: MEMBER.maya, total, status, hold_enrollments: false, created_at: iso(at), finished_at: iso(at + 20 * 60_000) })[0];
}

/** SaaS leads that have recent posts (what the icebreaker reads). */
function postLeads(s: DemoStore, from: number, to: number): string[] {
  const out: string[] = [];
  for (let i = from; i < to; i++) { const p = s.get('outreach_lead_profiles', leadId(i), 'lead_id'); if (Array.isArray(p?.posts) && p.posts.length) out.push(leadId(i)); }
  return out;
}

/** Runs before the 60-day history, so sequence messages can render approved AI lines. */
export function seedAiBeforeHistory(s: DemoStore, now: number): void {
  // the three built-ins every workspace has (067); prompts live in code, `prompt` is the description
  const builtins: Array<[string, string, string, string]> = [
    [AI_IDS.builtinFirst, 'contact_first_name', 'Contact first name', 'Their first name as people use it: one word, capitalised, no titles.'],
    [AI_IDS.builtinCompany, 'company_conversation', 'Company name (conversational)', 'The company name as you would say it in a sentence: no Inc., LLC or Ltd.'],
    [AI_IDS.builtinPosition, 'position_conversational', 'Position (conversational)', 'Their job title as you would say it: short, without the department list.'],
  ];
  for (const [id, key, name, prompt] of builtins) variable(s, id, { key, name, prompt, builtin: true, created_at: iso(now - 200 * D), updated_at: iso(now - 200 * D) }, now);

  const ice = variable(s, AI_IDS.varIcebreaker, {
    key: 'icebreaker', name: 'Icebreaker', needs_posts: true, max_chars: 160, fallback: 'I enjoyed reading your recent posts',
    prompt: 'Write one friendly sentence that refers to the lead\'s most recent LinkedIn post: what it was about and one honest reaction. No flattery, no questions, under 25 words.',
  }, now);
  const leads = postLeads(s, 0, 160).slice(0, 80);
  const b = batch(s, ice, leads.length, 'done', now - 57 * D, SEQ.saas);
  leads.forEach((l, k) => {
    const at = now - (57 - Math.floor(k / 2)) * D + (k % 7) * H;
    const line = personalLine(s, l);
    value(s, ice, l, b.id, 'approved', at, { text: line.text.slice(0, 160), facts: line.facts, edited: k % 11 === 3 });
  });
}

const QA: Array<[string, string]> = [
  ['How much does it cost?', 'Plans start at $99 per sender per month, billed monthly. Agencies with five or more senders get volume pricing.'],
  ['Is there a free trial?', 'Yes. You get 14 days free with two senders, no card needed.'],
  ['Does it work with LinkedIn and email together?', 'Yes. One sequence can mix LinkedIn steps and email steps, and every reply lands in the same inbox.'],
  ['How do you keep LinkedIn accounts safe?', 'Each account has daily limits, working hours and a warm-up for new accounts. We never go above LinkedIn\'s own limits.'],
  ['Do you support teams in Europe?', 'Yes. Data is stored in the EU for European workspaces and we sign a DPA on request.'],
  ['Can I white-label it for my clients?', 'Yes. Agencies can add their own logo and domain and give each client a portal.'],
  ['Which CRMs do you integrate with?', 'HubSpot, Pipedrive and Salesforce, plus webhooks and an API for anything else.'],
  ['How long does setup take?', 'Most teams send their first sequence the same day. Connecting a sender takes about two minutes.'],
  ['Can the AI reply for me?', 'Yes. It drafts replies for a person to approve, and after a review period it can send them on its own.'],
  ['Do you write the messages for us?', 'You write the templates; the AI adds one personal line per lead, which you approve before it is sent.'],
  ['What results do teams usually see?', 'Teams like yours usually see 25–40% invitation acceptance and 8–15% replies in the first month.'],
  ['Can I cancel anytime?', 'Yes. Plans are monthly and you can cancel from the billing page.'],
  ['Do you offer onboarding?', 'Every new workspace gets a 30-minute onboarding call and a sequence review.'],
];

const UNANSWERED: Array<[string, number, string]> = [
  ['Do you have a SOC 2 report?', 4, SEQ.saas],
  ['Can it book meetings straight into Outlook calendars?', 3, SEQ.saas],
  ['Does it work with Sales Navigator InMail credits?', 2, SEQ.agencies],
  ['What happens to my data if I cancel?', 2, SEQ.saas],
];

export function seedAi(s: DemoStore, now: number): void {
  const ice = s.get('outreach_ai_variables', AI_IDS.varIcebreaker)!;
  // ---- personalized lines: more icebreakers waiting for review, a Fields variable, a one-line opener
  const already = new Set(s.t('outreach_ai_values').filter((v) => v.variable_id === ice.id).map((v) => v.lead_id));
  const more = postLeads(s, 0, 160).filter((l) => !already.has(l)).slice(0, 10);
  const b2 = batch(s, ice, more.length + 2, 'review', now - 2 * D, SEQ.saas);
  more.slice(0, 8).forEach((l, k) => value(s, ice, l, b2.id, 'generated', now - 2 * D + k * 7 * 60_000 + 40 * 60_000));
  more.slice(8, 9).forEach((l) => value(s, ice, l, b2.id, 'skipped', now - 2 * D + H));
  // two leads without posts: nothing to write about
  const noPosts = Array.from({ length: 40 }, (_, i) => leadId(i)).filter((l) => !s.get('outreach_lead_profiles', l, 'lead_id')?.posts?.length).slice(0, 2);
  noPosts.forEach((l) => value(s, ice, l, b2.id, 'blank', now - 2 * D + H));

  const fit = variable(s, AI_IDS.varFit, {
    key: 'fit', name: 'Agency fit', output: 'fields', fields: FIT_FIELDS, fallback: '', max_chars: 220,
    prompt: 'Read the agency owner\'s profile and judge how well the agency fits our ideal customer: a 5–50 person marketing agency that wins clients mostly through referrals.',
    created_at: iso(now - 30 * D), updated_at: iso(now - 9 * D),
  }, now);
  const fb = batch(s, fit, 22, 'review', now - 9 * D, SEQ.agencies);
  for (let k = 0; k < 22; k++) {
    const l = leadId(160 + k * 2);
    const at = now - (9 - Math.floor(k / 3)) * D + (k % 5) * H;
    const status = k >= 18 ? 'generated' : 'approved';
    const g = generateFor(s, fit, l);
    const data = { ...(g.data ?? {}), pain: PAINS[k % PAINS.length], team_size: 5 + ((k * 7) % 45) };
    value(s, fit, l, fb.id, status, k >= 18 ? now - (3 - (k - 18) * 0.5) * H : at, { data, text: fieldsSummary(FIT_FIELDS, data as never) });
  }

  const opener = variable(s, AI_IDS.varOpener, {
    key: 'opener', name: 'Company opener', fallback: 'Your team is doing great work', max_chars: 180,
    prompt: 'Write one short sentence about what the lead\'s company does and why that caught our eye. Use only facts from the profile.',
    created_at: iso(now - 15 * D), updated_at: iso(now - 15 * D),
  }, now);
  const ob = batch(s, opener, 6, 'done', now - 6 * D, null);
  for (let k = 0; k < 6; k++) {
    const l = leadId(290 + k * 3);
    const lead = s.get('outreach_leads', l)!;
    value(s, opener, l, ob.id, 'approved', now - (6 - k) * D + 3 * H, { text: `${lead.company} looks like the kind of practice patients recommend to friends`, facts: [{ label: 'Company', value: lead.company }, { label: 'Industry', value: lead.custom?.industry ?? '' }] });
  }

  // ---- knowledge: three sources and a product catalogue
  const ks = (id: string, o: Row, ageDays: number) => s.insert('outreach_knowledge_sources', {
    id, workspace_id: DEMO_WS_ID, url: null, storage_path: null, content_type: null, text_inline: null, status: 'ready', error: null, pages: 1, chunks: 1,
    crawled_at: iso(now - ageDays * D + H), refresh_days: null, created_by: MEMBER.maya, catalogue: null, detect_products: false, created_at: iso(now - ageDays * D), updated_at: iso(now - ageDays * D + H), ...o,
  })[0];
  ks(AI_IDS.ksSite, { kind: 'website', title: 'northwind.example.com', url: 'https://northwind.example.com', pages: 14, chunks: 52, refresh_days: 7 }, 40);
  ks(AI_IDS.ksDoc, { kind: 'document', title: 'Pricing and plans (2026).md', storage_path: `${DEMO_WS_ID}/library/pricing-and-plans-2026.md`, content_type: 'text/markdown', pages: 1, chunks: 6 }, 25);
  ks(AI_IDS.ksText, { kind: 'text', title: 'Company facts', text_inline: 'Northwind Growth runs LinkedIn and email outreach for B2B teams. Founded 2019. 40+ agency clients. Plans from $99 per sender per month. 14-day free trial. Onboarding call included.', chunks: 1 }, 18);
  const cat = ks(AI_IDS.catalogue, {
    kind: 'catalogue', title: 'Fernhill Studio store', url: 'https://shop.example.com', refresh_days: 1, pages: 2,
    catalogue: { provider: 'shopify', url: 'https://shop.example.com', store: 'Fernhill Studio', currency: 'USD', currency_locked: false, products: FERNHILL.length, synced_at: iso(now - 5 * H), complete: true, warning: null, seeded: true },
  }, 12);
  FERNHILL.forEach((p, i) => s.insert('outreach_products', { ...productRow(cat, p, i), seen_at: iso(now - 5 * H), deleted_at: null, created_at: iso(now - 12 * D), updated_at: iso(now - 5 * H) }));
  const hide = s.t('outreach_products').find((p) => p.handle === 'kids-study-desk');
  if (hide) hide.ai_hidden = true;
  const pin = s.t('outreach_products').find((p) => p.handle === 'oak-standing-desk');
  if (pin) pin.pinned_keywords = ['standing desk', 'desk'];

  // ---- AI replies: library prompt (workspace default), the SaaS sequence on Review with its own prompt
  const sections = { ...defaultSections(), who: 'I\'m {{sender.first_name}} at Northwind Growth. We run LinkedIn and email outreach for B2B teams, so founders get first meetings without hiring SDRs.', facts: '- Plans from $99 per sender per month, 14-day free trial.\n- 40+ agency clients; teams usually see 8–15% replies in the first month.\n- Calendar: https://example.com/book/northwind' };
  const settings = defaultSettings();
  const lib = s.insert('outreach_master_prompts', {
    id: AI_IDS.mpLibrary, workspace_id: DEMO_WS_ID, scope: 'library', scope_id: null, sequence_id: null, name: 'Northwind default', editor_mode: 'guided', version: 1,
    body: compilePrompt(sections, settings, defaultScenarios()), sections, settings, substantive_version: 1, substantive_at: iso(now - 45 * D), graduated_at: null, graduation: null,
    copied_from_prompt_id: null, copied_from_version: null, knowledge_source_ids: [AI_IDS.ksSite], updated_by: MEMBER.maya, created_at: iso(now - 45 * D), updated_at: iso(now - 45 * D),
  })[0];
  defaultScenarios().forEach((c, i) => s.insert('outreach_master_prompt_scenarios', { master_prompt_id: lib.id, position: i + 1, title: c.title, when_text: c.when_text, do_text: c.do_text, enabled: true, updated_by: MEMBER.maya, updated_at: iso(now - 45 * D) }));
  s.insert('outreach_master_prompt_versions', { master_prompt_id: lib.id, version: 1, editor_mode: 'guided', body: lib.body, sections, settings, change_kind: 'substantive', note: 'First version', created_by: MEMBER.maya, created_at: iso(now - 45 * D), scenarios: defaultScenarios(), faqs: [] }, { noId: true });
  s.insert('outreach_workspace_reply_settings', { workspace_id: DEMO_WS_ID, max_ai_sends_per_sender_day: 20, default_prompt_id: lib.id, updated_by: MEMBER.maya, updated_at: iso(now - 45 * D) }, { noId: true });
  s.insert('outreach_ai_reply_workspace', { workspace_id: DEMO_WS_ID, graduation_bypass: false, monthly_limit: 2000, note: null, updated_by: null, updated_at: iso(now - 60 * D) }, { noId: true });

  const srs = ensureSeqSettings(s, SEQ.saas, MEMBER.maya);
  const mp = s.get('outreach_master_prompts', srs.master_prompt_id)!;
  s.update('outreach_master_prompts', mp.id, { id: mp.id, knowledge_source_ids: [AI_IDS.ksSite, AI_IDS.ksDoc], created_at: iso(now - 40 * D), substantive_at: iso(now - 40 * D), updated_at: iso(now - 40 * D) });
  s.update('outreach_master_prompt_versions', (v) => v.master_prompt_id === mp.id, { created_at: iso(now - 40 * D) });
  bump(s, mp.id, 'style', 'Shorter sentences in Style', { sections: { ...mp.sections, style: '- 1–2 short sentences. LinkedIn chat: no subject, no signature.\n- Match their language. No exclamation marks unless they used them.' } }, MEMBER.sam);
  s.update('outreach_master_prompt_versions', (v) => v.master_prompt_id === mp.id && v.version === 2, { created_at: iso(now - 12 * D) });
  s.update('outreach_sequence_reply_settings', (r) => r.sequence_id === SEQ.saas, { mode: 'draft', warmup_remaining: 14, updated_at: iso(now - 40 * D) });
  ensureSeqSettings(s, SEQ.agencies, MEMBER.maya);
  s.update('outreach_sequence_reply_settings', (r) => r.sequence_id === SEQ.agencies, { mode: 'off' });

  // Q&A: shared pairs (one limited to the SaaS sequence) and two on the SaaS prompt itself
  QA.forEach(([q, a], i) => {
    const f = s.insert('outreach_master_prompt_faqs', { master_prompt_id: null, workspace_id: DEMO_WS_ID, question: q, answer: a, source: i === 11 ? 'unanswered' : 'manual', enabled: i !== 12, created_by: MEMBER.maya, created_at: iso(now - (40 - i * 2) * D), updated_at: iso(now - (40 - i * 2) * D) })[0];
    if (i === 6) s.insert('outreach_knowledge_qa_links', { qa_id: f.id, target_kind: 'sequence', target_id: SEQ.saas }, { noId: true });
  });
  s.insert('outreach_master_prompt_faqs', { master_prompt_id: mp.id, workspace_id: DEMO_WS_ID, question: 'Do you work with seed-stage startups?', answer: 'Yes, from about five people up. Most SaaS clients are between seed and Series B.', source: 'manual', enabled: true, created_by: MEMBER.maya, created_at: iso(now - 30 * D), updated_at: iso(now - 30 * D) });
  s.insert('outreach_master_prompt_faqs', { master_prompt_id: mp.id, workspace_id: DEMO_WS_ID, question: 'Can we pause outreach during a launch?', answer: 'Yes. Pause a sequence in one click; leads keep their place and continue when you resume.', source: 'manual', enabled: true, created_by: MEMBER.sam, created_at: iso(now - 20 * D), updated_at: iso(now - 20 * D) });

  // unanswered questions
  UNANSWERED.forEach(([q, n, seq], i) => {
    const seen = Array.from({ length: n }, (_, k) => iso(now - (k * 4 + i + 1) * D));
    s.insert('outreach_ai_unanswered_questions', {
      workspace_id: DEMO_WS_ID, sequence_id: seq, inbox_id: null, master_prompt_id: seq === SEQ.saas ? mp.id : null, canonical: q, norm: q.toLowerCase().replace(/[^a-z0-9 ]+/g, ''),
      examples: seen.map((at, k) => ({ run_id: null, chat_id: null, message_id: null, text: k ? q.replace('?', ', by the way?') : q, at, origin: 'reply' })),
      count_total: n, first_seen_at: seen[seen.length - 1], last_seen_at: seen[0], status: 'open', answered_faq_id: null, dismissed_reason: null, seen_at: seen, origins: ['reply'],
    });
  });

  // consent: Maya approved her own account; Sam was asked
  s.insert('outreach_ai_reply_consent', {
    workspace_id: DEMO_WS_ID, sender_id: SENDER.li_maya, master_prompt_id: null, master_prompt_version: null, granted_by_email: DEMO_USER_EMAIL, granted_via: 'owner_is_operator',
    scope: { daily_cap: 20, grant: 'AI may reply as me in the sequences my team turns on.' }, evidence: { user_id: MEMBER.maya }, granted_at: iso(now - 38 * D), expires_at: iso(now + 327 * D),
    revoked_at: null, revoked_reason: null, revoke_token_hash: null,
  });
  s.insert('outreach_ai_reply_consent_links', {
    workspace_id: DEMO_WS_ID, sender_id: SENDER.li_sam, master_prompt_id: null, master_prompt_version: null, email: 'sam.okafor@example.com', token_hash: 'demo-consent-sam',
    scope: { daily_cap: 20 }, examples: [], created_by: MEMBER.maya, created_at: iso(now - 2 * D), expires_at: iso(now + 5 * D), used_at: null, cancelled_at: null,
  });

  // test conversations for the SaaS prompt
  s.insert('outreach_ai_reply_scenarios', { workspace_id: DEMO_WS_ID, master_prompt_id: mp.id, name: 'Asks for the price', turns: [{ from: 'us', text: 'Hi Alex, thanks for connecting!' }, { from: 'prospect', text: 'Thanks. What does it cost for a team of 5?' }], expected: [{ after_turn: 1, decision: 'send' }], last_result: null, last_version: null, last_run_at: null, passed: null, created_by: MEMBER.maya, created_at: iso(now - 30 * D), updated_at: iso(now - 30 * D) });
  s.insert('outreach_ai_reply_scenarios', { workspace_id: DEMO_WS_ID, master_prompt_id: mp.id, name: 'Not interested', turns: [{ from: 'us', text: 'Hi Sam, worth a quick chat?' }, { from: 'prospect', text: 'Not interested, thank you.' }], expected: [{ after_turn: 1, decision: 'no_reply' }], last_result: null, last_version: null, last_run_at: null, passed: null, created_by: MEMBER.maya, created_at: iso(now - 29 * D), updated_at: iso(now - 29 * D) });

  // ---- runs for the SaaS conversations that already have replies: the latest wait in Needs you, older ones were sent
  const saasLeads = new Set(s.t('outreach_enrollments').filter((e) => e.sequence_id === SEQ.saas).map((e) => e.lead_id));
  const chats = s.t('outreach_chats').filter((c) => c.provider === 'LINKEDIN' && c.lead_id && saasLeads.has(c.lead_id) && s.t('outreach_messages').some((m) => m.chat_id === c.id && m.direction === 'in'));
  for (const c of chats) s.update('outreach_chats', c.id, { reply_sequence_id: SEQ.saas }, { silent: true });
  const lastIn = (c: Row) => s.t('outreach_messages').filter((m) => m.chat_id === c.id && m.direction === 'in').sort((a, b) => String(a.sent_at).localeCompare(String(b.sent_at))).pop()!;
  const ordered = chats.map((c) => ({ c, m: lastIn(c) })).sort((a, b) => String(b.m.sent_at).localeCompare(String(a.m.sent_at)));
  const engine = engineFor(s);
  ordered.forEach(({ c, m }, k) => {
    const chat = s.get('outreach_chats', c.id)!;
    const at = Date.parse(m.sent_at);
    const r = openRun(s, chat, [m], { mode: 'draft', sequenceId: SEQ.saas, at });
    if (k < 3 && chat.last_direction === 'in') return;   // waiting for a person
    if (r.decision !== 'send' || !r.draft_text) { if (r.status === 'draft_ready') updateRun(s, r.id, { status: 'no_reply', dispatched_by: MEMBER.maya, updated_at: iso(at + 2 * H) }); return; }
    const edited = k % 3 === 1;
    const text = edited ? r.draft_text.replace(/\.?$/, '').replace(/ Would a quick call later this week work for you\?$/, '') + ' Free for 15 minutes on Thursday?' : r.draft_text;
    const sentAt = Math.min(now - 10 * 60_000, at + (1 + (k % 4)) * H);
    const msg = engine.appendMessage(s.get('outreach_chats', c.id)!, { direction: 'out', text, at: sentAt, origin: edited ? 'ai_edited' : 'ai_draft_sent', sent_by: MEMBER.maya });
    updateRun(s, r.id, {
      status: 'sent', final_text: text, sent_origin: edited ? 'ai_edited' : 'ai_draft_sent', sent_message_id: msg.id, dispatched_by: MEMBER.maya, edit_distance: edited ? 0.22 : 0, facts_changed: false,
      reply_latency_s: Math.round((sentAt - at) / 1000), timings: { ...(r.timings ?? {}), sent_at: iso(sentAt) }, updated_at: iso(sentAt),
    });
    s.update('outreach_chats', c.id, (x) => ({ ai_replies_count: (x.ai_replies_count ?? 0) + 1, conversation_stage: r.stage_after ?? x.conversation_stage, last_ai_move: r.move }));
  });

  // a lead's key facts, as the reply engine collects them
  const noted = ordered[0]?.c.lead_id;
  if (noted) s.insert('outreach_lead_ai_notes', {
    lead_id: noted, workspace_id: DEMO_WS_ID, summary: 'Reviewing tools for Q1; wants a short call.',
    items: [
      { id: s.uid(), key: 'timeline', text: 'Reviewing tools for Q1', source_message_id: ordered[0].m.id, updated_at: ordered[0].m.sent_at, edited_by: null, locked: false, history: [] },
      { id: s.uid(), key: 'interest', text: 'Asked for a call', source_message_id: ordered[0].m.id, updated_at: ordered[0].m.sent_at, edited_by: null, locked: false, history: [] },
    ], updated_at: ordered[0].m.sent_at,
  }, { noId: true });
}
