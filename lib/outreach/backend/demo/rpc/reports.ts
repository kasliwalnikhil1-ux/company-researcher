/**
 * Demo handlers: Dashboard and reports: every number computed from the demo tables.
 * Owns: consent_report, dashboard, metric_definitions, report_blocks, report_channels, report_client, report_clients, report_cost, report_funnel, report_intents, report_overview, report_reply_threads, report_sender, report_senders, report_sequence, report_sequences, save_range
 *
 * Every total is built by reports/facts.ts (outreach__facts + outreach__totals_from), so the dashboard, each report
 * tab, the client portal and the sequence pages agree. Shapes follow migrations/outreach/013_reports.sql and 026.
 */
import { demoError, type Ctx, type RpcArea } from '../ctx';
import { tableHooks } from '../query';
import type { DemoStore, Row } from '../store';
import { dashboard } from '../reports/dashboard';
import {
  addDays, allFacts, asDay, channelOf, daysBetween, dayIn, eachDay, factFilters, grouped, LIVE_ENROLLMENT, MILESTONES, rate, resolveRange,
  RUNNING_ENROLLMENT, threadIntent, totalsFrom, totalsOf, type Totals,
} from '../reports/facts';
import { sequenceReport } from '../reports/sequence';
import { DEMO_USER_ID as DEMO_USER } from '../seed/ids';

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const inWs = (ws: string) => (r: Row) => !r.workspace_id || r.workspace_id === ws;
const zero = () => totalsFrom({});

// ---------------------------------------------------------------------------
// overview (also the client report and the client portal)
// ---------------------------------------------------------------------------
function overview(store: DemoStore, ws: string, client: string | null, pFrom: unknown, pTo: unknown, pFilters: unknown): Row {
  const { from, to, tz } = resolveRange(store, ws, pFrom, pTo, 7);
  const span = daysBetween(from, to) + 1;
  const filters = factFilters(pFilters);
  const pf = addDays(from, -span), pt = addDays(from, -1);
  const byDay = grouped(store, ws, { from, to, client, group: 'day', filters });
  const byChannel = grouped(store, ws, { from, to, client, group: 'channel', filters });
  return {
    period: { from, to, days: span, timezone: tz, previous_from: pf, previous_to: pt },
    totals: totalsOf(store, ws, { from, to, client, filters }),
    previous: totalsOf(store, ws, { from: pf, to: pt, client, filters }),
    by_channel: Object.fromEntries(byChannel),
    series: eachDay(from, to).map((day) => ({ day, ...(byDay.get(day) ?? zero()) })),
  };
}

// ---------------------------------------------------------------------------
// reply threads behind a number
// ---------------------------------------------------------------------------
function replyThreads(store: DemoStore, ws: string, a: Row): Row[] {
  const { from, to, tz } = resolveRange(store, ws, a.p_from, a.p_to, 30);
  const client = str(a.p_client);
  const intent = str(a.p_intent);
  const f = (a.p_filters && typeof a.p_filters === 'object' ? a.p_filters : {}) as Row;
  const chats = new Map(store.t('outreach_chats').map((c) => [c.id, c]));
  const actions = new Map(store.t('outreach_actions').map((x) => [x.id, x]));
  const enr = new Map(store.t('outreach_enrollments').map((e) => [e.id, e]));
  const seqs = new Map(store.t('outreach_sequences').map((q) => [q.id, q]));
  const out: Row[] = [];
  for (const m of store.t('outreach_messages')) {
    if (!m.is_first_reply || !m.replied_to_action_id || (m.workspace_id && m.workspace_id !== ws)) continue;
    const c = chats.get(m.chat_id); const x = actions.get(m.replied_to_action_id);
    if (!c || !x || !m.sent_at) continue;
    const d = dayIn(Date.parse(m.sent_at), tz);
    if (d < from || d > to) continue;
    const e = x.enrollment_id ? enr.get(x.enrollment_id) : undefined;
    const q = e ? seqs.get(e.sequence_id) : undefined;
    const cl = q?.client_id ?? c.client_id ?? null;
    if (client && cl !== client) continue;
    const it = threadIntent(c, m);
    if (intent && it !== intent) continue;
    if (str(f.sequence_id) && e?.sequence_id !== f.sequence_id) continue;
    if (str(f.sender_id) && c.sender_id !== f.sender_id) continue;
    if (str(f.node_id) && x.node_id !== f.node_id) continue;
    if (typeof f.variant_id === 'string' && (x.variant_id ?? '') !== f.variant_id) continue;
    out.push({ chat_id: c.id, lead_id: c.lead_id ?? null, lead_name: c.attendee_name ?? null, sender_id: c.sender_id, intent: it, replied_at: m.sent_at, sequence_id: e?.sequence_id ?? null, node_id: x.node_id ?? null, variant_id: x.variant_id ?? null, preview: String(m.text ?? '').slice(0, 200) });
  }
  out.sort((p, q) => String(q.replied_at).localeCompare(String(p.replied_at)));
  return out.slice(0, 1000);
}

// ---------------------------------------------------------------------------
// funnel (cohort of leads enrolled in the period)
// ---------------------------------------------------------------------------
const FUNNEL = ['enrolled', 'invited', 'accepted', 'messaged', 'replied', 'interested', 'meeting', 'won'] as const;
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) / 2;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
function funnel(store: DemoStore, ws: string, a: Row): Row {
  const { from, to, tz } = resolveRange(store, ws, a.p_from, a.p_to, 30);
  allFacts(store, ws); // milestones are written lazily with the facts
  const client = str(a.p_client);
  const f = (a.p_filters && typeof a.p_filters === 'object' ? a.p_filters : {}) as Row;
  const seqs = new Map(store.t('outreach_sequences').map((q) => [q.id, q]));
  const leads = new Map(store.t('outreach_leads').map((l) => [l.id, l]));
  const tagged = str(f.tag_id) ? new Set(store.t('outreach_lead_tags').filter((t) => t.tag_id === f.tag_id).map((t) => t.lead_id)) : null;
  const cohort = store.t('outreach_enrollments').filter((e) => {
    if (e.workspace_id && e.workspace_id !== ws) return false;
    const q = seqs.get(e.sequence_id); const l = leads.get(e.lead_id);
    if (!q || !l || !e.created_at) return false;
    const d = dayIn(Date.parse(e.created_at), tz);
    if (d < from || d > to) return false;
    if (client && q.client_id !== client) return false;
    if (str(f.sequence_id) && e.sequence_id !== f.sequence_id) return false;
    if (str(f.sender_id) && e.sender_id !== f.sender_id) return false;
    if (str(f.list_id) && l.list_id !== f.list_id) return false;
    if (tagged && !tagged.has(l.id)) return false;
    return true;
  });
  const ids = new Set(cohort.map((e) => e.id));
  const acts = new Map<string, Row[]>();
  for (const x of store.t('outreach_actions')) if (ids.has(x.enrollment_id) && x.status === 'sent') { const l = acts.get(x.enrollment_id); if (l) l.push(x); else acts.set(x.enrollment_id, [x]); }
  const replyAt = new Map<string, string>();
  for (const m of store.t('outreach_messages')) if (m.is_first_reply && m.replied_to_action_id) replyAt.set(m.replied_to_action_id, replyAt.has(m.replied_to_action_id) && replyAt.get(m.replied_to_action_id)! < m.sent_at ? replyAt.get(m.replied_to_action_id)! : m.sent_at);
  const states = new Map(store.t('outreach_lead_sender_state').map((s) => [`${s.lead_id}|${s.sender_id}`, s]));
  const ms = new Map<string, Row[]>();
  for (const m of store.t(MILESTONES)) { const l = ms.get(m.lead_id); if (l) l.push(m); else ms.set(m.lead_id, [m]); }
  const minIso = (xs: Array<string | null | undefined>) => xs.filter((x): x is string => !!x).sort()[0] ?? null;
  const st = cohort.map((e) => {
    const list = acts.get(e.id) ?? [];
    const acc = states.get(`${e.lead_id}|${e.sender_id}`)?.invite_accepted_at;
    const mile = (k: string) => minIso((ms.get(e.lead_id) ?? []).filter((m) => m.kind === k && m.at >= e.created_at).map((m) => m.at));
    return {
      enrolled: e.created_at as string,
      invited: minIso(list.filter((x) => x.action_type === 'invite').map((x) => x.executed_at)),
      accepted: acc && acc >= e.created_at ? acc as string : null,
      messaged: minIso(list.filter((x) => ['message', 'inmail', 'email'].includes(x.action_type)).map((x) => x.executed_at)),
      replied: minIso(list.map((x) => replyAt.get(x.id))),
      interested: mile('interested'), meeting: mile('meeting'), won: mile('won'),
    } as Record<(typeof FUNNEL)[number], string | null>;
  });
  const h = (b: string | null, a0: string | null) => (b && a0 ? (Date.parse(b) - Date.parse(a0)) / 3_600_000 : null);
  const interval = (s: (typeof st)[number], k: (typeof FUNNEL)[number]): number | null => {
    switch (k) {
      case 'invited': return h(s.invited, s.enrolled);
      case 'accepted': return h(s.accepted, s.invited);
      case 'messaged': return h(s.messaged, s.accepted ?? s.enrolled);
      case 'replied': return h(s.replied, s.messaged ?? s.invited);
      case 'interested': return h(s.interested, s.replied);
      case 'meeting': return h(s.meeting, s.interested ?? s.replied);
      case 'won': return h(s.won, s.meeting ?? s.interested);
      default: return null;
    }
  };
  const counts = FUNNEL.map((k, i) => ({ pos: i + 1, stage: k, n: k === 'enrolled' ? st.length : st.filter((s) => s[k]).length, med: median(st.map((s) => interval(s, k)).filter((x): x is number => x != null)) }));
  return {
    period: { from, to, timezone: tz }, cohort: cohort.length,
    stages: counts.map((c) => {
      const prev = [...counts].reverse().find((p) => p.pos < c.pos && p.n > 0);
      return {
        stage: c.stage, count: c.n, pct_of_enrolled: rate(c.n, counts[0].n), pct_of_previous: prev ? rate(c.n, prev.n) : null,
        median_hours_from_previous: c.pos > 1 && c.med != null && c.med >= 0 ? Math.round(c.med * 10) / 10 : null,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// intents (Replies tab)
// ---------------------------------------------------------------------------
function intents(store: DemoStore, ws: string, a: Row): Row {
  const { from, to, tz } = resolveRange(store, ws, a.p_from, a.p_to, 30);
  const client = str(a.p_client);
  const filters = factFilters(a.p_filters);
  const p = String(a.p_group ?? 'day');
  const gk = p === 'step' || p === 'node' ? 'node' : (['sequence', 'sender', 'variant', 'channel'].includes(p) ? p : 'day') as 'node' | 'sequence' | 'sender' | 'variant' | 'channel' | 'day';
  const tot = totalsOf(store, ws, { from, to, client, filters });
  const seqs = new Map(store.t('outreach_sequences').map((q) => [q.id, q]));
  const senders = new Map(store.t('outreach_senders').map((s) => [s.id, s]));
  const nodeLabel = (seqId: string, nodeId: string) => { const q = seqs.get(seqId); return q ? `${q.name} · ${q.graph?.nodes?.[nodeId]?.label || nodeId}` : null; };
  const rows = [...grouped(store, ws, { from, to, client, group: gk, filters })]
    .filter(([, t]) => t.replies > 0 || gk === 'day')
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([key, t]) => {
      const [s1, s2, s3] = key.split('|');
      const label = gk === 'sequence' ? seqs.get(key)?.name ?? null : gk === 'sender' ? senders.get(key)?.display_name ?? null
        : gk === 'node' ? nodeLabel(s1, s2) : gk === 'variant' ? (nodeLabel(s1, s2) == null ? null : `${nodeLabel(s1, s2)} · ${s3 || 'no variant'}`) : key;
      return {
        key, label, sequence_id: gk === 'node' || gk === 'variant' ? s1 : gk === 'sequence' ? key : null, node_id: gk === 'node' || gk === 'variant' ? s2 : null,
        variant_id: gk === 'variant' ? (s3 ?? '') : null, replies: t.replies, touches: t.touches, reply_rate: t.reply_rate, intents: t.intents,
        positive_reply_rate: t.positive_reply_rate, negative_reply_rate: t.negative_reply_rate,
      };
    });
  return {
    period: { from, to, timezone: tz }, group: gk, replies: tot.replies, touches: tot.touches, reply_rate: tot.reply_rate,
    positive_reply_rate: tot.positive_reply_rate, negative_reply_rate: tot.negative_reply_rate, intents: tot.intents, rows,
  };
}

// ---------------------------------------------------------------------------
// one sender
// ---------------------------------------------------------------------------
const REASONS: Array<[RegExp, string]> = [
  [/^(E_LEAD_SUPPRESSED|suppressed|do_not_contact|unsubscribed)$/, 'The lead is on a do-not-contact list'],
  [/^(E_REPLIED|replied)$/, 'The lead replied, so the sequence stopped'],
  [/^(E_NO_CONSENT|no_consent)$/, 'No recorded consent for WhatsApp, so no new chat was started'],
  [/^(E_NO_IDENTITY|no_identity)$/, 'The lead has no handle or number on file for this channel'],
  [/^(E_IDENTIFIER_INVALID|not_on_whatsapp)$/, 'The number is not on WhatsApp'],
  [/^E_RELATION_REQUIRED$|no_connection_with_recipient/, 'Not connected yet, so a message could not be sent'],
  [/^E_PAYLOAD_INVALID$|payload_invalid/, 'The step had no usable text for this lead'],
  [/^E_NO_EMAIL$/, 'No email address on file'],
  [/^(email_bounced|bounced)$|recipient_rejected/, 'The email address bounced'],
  [/already_connected|^E_ALREADY_CONNECTED$/, 'Already connected, so the invitation was skipped'],
  [/already_invited_recently|cannot_resend|^invitation_pending$/, 'An invitation is already pending or was sent recently'],
  [/^network_timeout_max$|^net:/, 'Could not reach the provider after three tries'],
  [/^401:|^E_SENDER_NOT_OK$/, 'The sender was disconnected'],
  [/^403:/, 'The provider restricted the sender for this action'],
  [/^429:/, 'The provider rate-limited the sender'],
  [/^blocked$/, 'The lead blocked this account'],
];
function reasonText(code: string | null | undefined, decision?: string | null): string {
  if (!code) return decision ? String(decision).replace(/_/g, ' ') : 'Unknown reason';
  for (const [re, t] of REASONS) if (re.test(code)) return t;
  return code.replace(/_/g, ' ');
}

function senderReport(store: DemoStore, ws: string, s: Row, pFrom: unknown, pTo: unknown): Row {
  const { from, to, tz } = resolveRange(store, ws, pFrom, pTo, 30);
  const filters = { sender_id: s.id };
  const series = [...grouped(store, ws, { from, to, group: 'day', filters })].sort(([x], [y]) => x.localeCompare(y)).map(([day, t]) => ({ day, ...t }));
  const inRange = (iso: string) => { const d = dayIn(Date.parse(iso), tz); return d >= from && d <= to; };
  const events = store.t('outreach_sender_events').filter((e) => e.sender_id === s.id && e.at);
  const failures: Record<string, number> = {};
  for (const x of store.t('outreach_actions')) {
    if (x.sender_id !== s.id || x.status !== 'failed' || !x.executed_at || !inRange(x.executed_at)) continue;
    const r = reasonText(x.error_code, x.decision);
    failures[r] = (failures[r] ?? 0) + 1;
  }
  return {
    sender: { id: s.id, name: s.display_name ?? null, status: s.status, health: s.health_score ?? 0, level: s.warmup_level ?? 1 },
    period: { from, to, timezone: tz }, totals: totalsOf(store, ws, { from, to, filters }), series,
    health_trend: events.filter((e) => e.kind === 'health' && inRange(e.at)).sort((x, y) => String(x.at).localeCompare(String(y.at))).map((e) => ({ at: e.at, score: e.data?.to == null ? null : Number(e.data.to) })),
    restrictions: events
      .filter((e) => ['reject', 'checkpoint', 'status'].includes(e.kind) && dayIn(Date.parse(e.at), tz) >= from
        && (e.kind !== 'status' || ['credentials', 'error', 'paused'].includes(e.data?.to) || (e.data && 'paused_until' in e.data)))
      .sort((x, y) => String(y.at).localeCompare(String(x.at))).slice(0, 50).map((e) => ({ at: e.at, kind: e.kind, data: e.data ?? {} })),
    failures_by_reason: failures,
  };
}

// ---------------------------------------------------------------------------
// cost
// ---------------------------------------------------------------------------
function cost(store: DemoStore, ws: string, a: Row): Row {
  const { from, to, tz } = resolveRange(store, ws, a.p_from, a.p_to, 30);
  const client = str(a.p_client);
  const settings = store.get('outreach_workspaces', ws)?.settings ?? {};
  const defRaw = settings.sender_monthly_cost;
  const def = defRaw === '' || defRaw == null || isNaN(Number(defRaw)) ? null : Number(defRaw);
  const tot = totalsOf(store, ws, { from, to, client });
  const day = (iso: string | null | undefined) => (iso ? dayIn(Date.parse(iso), tz) : null);
  const per: Row[] = [];
  let senders = 0, missing = 0, sum: number | null = null;
  for (const s of store.t('outreach_senders').filter(inWs(ws))) {
    if (s.status === 'disabled' || (client && s.client_id !== client)) continue;
    const start = day(s.connected_at ?? s.created_at);
    if (!start || start > to) continue;
    const end = day(s.deleted_at) ?? to;
    const days = Math.max(daysBetween(start > from ? start : from, end < to ? end : to) + 1, 0);
    if (days <= 0) continue;
    const mcRaw = s.monthly_cost;
    const mc = mcRaw === '' || mcRaw == null || isNaN(Number(mcRaw)) ? def : Number(mcRaw);
    senders++;
    if (mc == null) missing++;
    else sum = (sum ?? 0) + (mc * days) / 30;
    per.push({ sender_id: s.id, name: s.display_name ?? null, monthly_cost: mc, days, cost: mc == null ? null : Math.round((mc * days / 30) * 100) / 100 });
  }
  const c = sum == null ? null : Math.round(sum * 100) / 100;
  const per1 = (n: number) => (sum != null && n > 0 ? Math.round((sum / n) * 100) / 100 : null);
  return {
    period: { from, to, timezone: tz }, currency: typeof settings.currency === 'string' && settings.currency ? settings.currency : 'USD',
    default_sender_monthly_cost: def, senders, senders_without_cost: missing, cost: c, per_sender: per,
    replies: tot.replies, interested: tot.interested, meetings: tot.meetings, won: tot.won,
    cost_per_reply: per1(tot.replies), cost_per_interested: per1(tot.interested), cost_per_meeting: per1(tot.meetings),
    won_value: tot.won_value > 0 ? tot.won_value : null,
    return_multiple: sum != null && sum > 0 && tot.won_value > 0 ? Math.round((tot.won_value / sum) * 10) / 10 : null,
    note: sum == null ? 'Set a monthly cost per sender (Settings → Workspace, or on each sender) to see cost per reply.'
      : tot.won_value === 0 ? 'Return is shown once deals carry a value (the Won stage value, or a deal_value field on the lead).' : null,
  };
}

// ---------------------------------------------------------------------------
// channels, blocks, consent (026)
// ---------------------------------------------------------------------------
const CHANNEL_ORDER: Record<string, number> = { linkedin: 1, instagram: 2, whatsapp: 3 };
function channels(store: DemoStore, ws: string, a: Row): Row {
  const { from, to, tz } = resolveRange(store, ws, a.p_from, a.p_to, 30);
  const client = str(a.p_client);
  const count = new Map<string, number>();
  for (const s of store.t('outreach_senders').filter(inWs(ws))) {
    if (s.deleted_at || (client && s.client_id !== client)) continue;
    const ch = channelOf(s.provider);
    count.set(ch, (count.get(ch) ?? 0) + 1);
  }
  const g = grouped(store, ws, { from, to, client, group: 'channel' });
  const all = new Set([...count.keys(), ...g.keys()]);
  const rows = [...all].map((channel) => {
    const t: Totals = g.get(channel) ?? zero();
    const actions = t.invites + t.new_chats + t.messages + t.inmails + t.emails + t.likes + t.comments + t.follows;
    return { channel, senders: count.get(channel) ?? 0, actions, new_chats: t.new_chats, replies: t.replies, replies_per_100_actions: rate(t.replies, actions), interested: t.interested, blocks: t.blocks, reply_rate: t.reply_rate };
  }).sort((x, y) => (CHANNEL_ORDER[x.channel] ?? 4) - (CHANNEL_ORDER[y.channel] ?? 4));
  return { period: { from, to, timezone: tz }, rows };
}

function blocks(store: DemoStore, ws: string, a: Row): Row {
  const { from, to, tz } = resolveRange(store, ws, a.p_from, a.p_to, 30);
  const client = str(a.p_client); const sender = str(a.p_sender);
  const senders = new Map(store.t('outreach_senders').filter(inWs(ws)).map((s) => [s.id, s]));
  const leads = new Map(store.t('outreach_leads').map((l) => [l.id, l]));
  const ev = store.t('outreach_sender_events').filter((e) => {
    const s = senders.get(e.sender_id);
    if (!s || e.kind !== 'block' || !e.at) return false;
    const d = dayIn(Date.parse(e.at), tz);
    return d >= from && d <= to && (!client || s.client_id === client) && (!sender || e.sender_id === sender);
  }).sort((x, y) => String(y.at).localeCompare(String(x.at)));
  const rows = ev.map((e) => {
    const s = senders.get(e.sender_id)!;
    const lid = str(e.data?.lead_id);
    return { at: e.at, sender_id: e.sender_id, sender_name: s.display_name ?? null, provider: s.provider, lead_id: lid, lead_name: lid ? leads.get(lid)?.full_name ?? null : null, code: e.data?.code ?? null, preceding: Array.isArray(e.data?.preceding) ? e.data.preceding : [] };
  });
  const by = new Map<string, Row>();
  for (const r of rows) { const x = by.get(r.sender_id) ?? { sender_id: r.sender_id, name: r.sender_name, blocks: 0 }; x.blocks++; by.set(r.sender_id, x); }
  return { period: { from, to, timezone: tz }, rows, by_sender: [...by.values()].sort((x, y) => y.blocks - x.blocks) };
}

function consent(store: DemoStore, ws: string, a: Row): Row {
  const { from, to, tz } = resolveRange(store, ws, a.p_from, a.p_to, 30);
  const client = str(a.p_client);
  const senders = new Map(store.t('outreach_senders').map((s) => [s.id, s]));
  const leads = new Map(store.t('outreach_leads').map((l) => [l.id, l]));
  const first = new Map<string, Row>();
  for (const x of store.t('outreach_actions')) {
    if ((x.workspace_id && x.workspace_id !== ws) || x.action_type !== 'new_chat' || x.status !== 'sent' || !x.executed_at) continue;
    const s = senders.get(x.sender_id); const l = leads.get(x.lead_id);
    if (!s || !l || s.provider !== 'WHATSAPP') continue;
    const d = dayIn(Date.parse(x.executed_at), tz);
    if (d < from || d > to || (client && (l.client_id ?? s.client_id) !== client)) continue;
    const cur = first.get(x.lead_id);
    if (!cur || x.executed_at < cur.executed_at) first.set(x.lead_id, x);
  }
  const members = new Map(store.t('outreach_members').map((m) => [m.user_id, m]));
  const consents = store.t('outreach_lead_consent').filter((c) => c.channel === 'WHATSAPP');
  const rows = [...first.values()].map((x) => {
    const cs = consents.filter((c) => c.lead_id === x.lead_id).sort((p, q) => Number(!p.revoked_at) === Number(!q.revoked_at) ? String(q.obtained_at).localeCompare(String(p.obtained_at)) : (q.revoked_at ? -1 : 1))[0];
    return {
      lead_id: x.lead_id, lead_name: leads.get(x.lead_id)?.full_name ?? null, basis: cs?.basis ?? 'none', obtained_at: cs?.obtained_at ?? null, evidence: cs?.evidence ?? null,
      attested_by_email: cs?.attested_by ? members.get(cs.attested_by)?.email ?? null : null, first_new_chat_at: x.executed_at, sender_name: senders.get(x.sender_id)?.display_name ?? null,
    };
  }).sort((p, q) => String(q.first_new_chat_at).localeCompare(String(p.first_new_chat_at)));
  const by: Record<string, { leads: number; share_pct: number | null }> = {};
  for (const r of rows) by[r.basis] = { leads: (by[r.basis]?.leads ?? 0) + 1, share_pct: null };
  for (const k of Object.keys(by)) by[k].share_pct = rate(by[k].leads, rows.length);
  const ia = by.imported_attested?.share_pct ?? 0;
  return { period: { from, to, timezone: tz }, contacted: rows.length, by_basis: by, imported_attested_share_pct: ia, alert: ia > 30, rows };
}

// ---------------------------------------------------------------------------
// metric definitions (026)
// ---------------------------------------------------------------------------
const METRIC_DEFINITIONS: Record<string, string> = {
  day: 'A calendar day in the workspace timezone (Settings → Workspace). Ranges include both end dates.',
  invites: 'Connection requests LinkedIn accepted for delivery in the period.',
  accepted: 'Invitations accepted in the period, whenever they were sent. Attributed to the step and variant that sent the invitation.',
  acceptance_rate: 'Accepted ÷ invites sent, both in the period.',
  touches: 'Messages + InMails + emails + new chats + invitations that carried a note. The denominator of every reply rate.',
  new_chats: 'Conversations the platform started with someone it had no chat with yet, on any channel. WhatsApp and Instagram watch this number closely.',
  replies: 'Threads in which the lead answered an automated step for the first time in the period. One lead answering three times is one reply. Replies to a teammate\'s manual message are conversation, not replies.',
  reply_rate: 'Replies ÷ touches.',
  replies_per_100_actions: 'Replies ÷ every metered outbound action (invites, new chats, messages, InMails, emails, likes, comments, follows) × 100. Compares channels with very different volumes.',
  interested: 'Replies whose thread is currently classified "interested" (AI classification, or your override).',
  positive_reply_rate: 'Interested replies ÷ replies, leaving out-of-office auto-replies out of the denominator.',
  negative_reply_rate: 'Not-interested replies ÷ replies, leaving out-of-office auto-replies out of the denominator.',
  blocks: 'Times a person blocked the sender or a chat went one-way after our first message (detected by the executor and the block worker). Each one lowers the sender\'s level.',
  'consent basis': 'Why we may message this person on WhatsApp: they wrote first (inbound), opted in on a form, are an existing customer, replied on LinkedIn, shared their number, or an operator attested consent at import (the weakest basis, shown in amber).',
  meetings: 'Leads that reached a Meeting stage or booked through the booking link in the period. Counted once per lead.',
  won: 'Leads that reached a Won stage in the period. Counted once per lead.',
  cost_per_reply: 'Sender cost for the period ÷ replies. Sender cost = monthly cost × days in period ÷ 30 for every sender that was connected.',
  funnel: 'Follows the leads ENROLLED in the period through every later stage, whenever that stage happened.',
  headroom: 'Share of the invitation cap a sender did not use over the last 30 days.',
};

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------
const wsOf = (a: Row, ctx: Ctx) => str(a.p_ws) ?? ctx.ws;

export const reportsRpc = {
  consent_report: (a, ctx) => consent(ctx.store, wsOf(a, ctx), a),

  dashboard: (a, ctx) => dashboard(ctx.store, wsOf(a, ctx)),

  metric_definitions: () => ({ ...METRIC_DEFINITIONS }),

  report_blocks: (a, ctx) => blocks(ctx.store, wsOf(a, ctx), a),

  report_channels: (a, ctx) => channels(ctx.store, wsOf(a, ctx), a),

  report_client: (a, ctx) => {
    const c = ctx.store.get('outreach_clients', str(a.p_client));
    if (!c) demoError('E_NOT_FOUND');
    const ws = c.workspace_id ?? ctx.ws;
    const o = overview(ctx.store, ws, c.id, a.p_from, a.p_to, {});
    const senders = ctx.store.t('outreach_senders').filter((s) => s.client_id === c.id && !s.deleted_at)
      .sort((x, y) => String(x.display_name ?? '').localeCompare(String(y.display_name ?? '')))
      .map((s) => ({ id: s.id, name: s.display_name ?? null, status: s.status, health: s.health_score ?? 0 }));
    const seqIds = new Set(ctx.store.t('outreach_sequences').filter((q) => q.client_id === c.id).map((q) => q.id));
    return {
      ...o, client: { id: c.id, name: c.name },
      leads: ctx.store.t('outreach_leads').filter((l) => l.client_id === c.id).length,
      senders,
      live_enrollments: ctx.store.t('outreach_enrollments').filter((e) => seqIds.has(e.sequence_id) && RUNNING_ENROLLMENT.includes(e.status)).length,
    };
  },

  report_clients: (a, ctx) => {
    const s = ctx.store; const ws = wsOf(a, ctx);
    const { from, to } = resolveRange(s, ws, a.p_from, a.p_to, 30);
    const g = grouped(s, ws, { from, to, group: 'client' });
    const seqClient = new Map(s.t('outreach_sequences').map((q) => [q.id, q.client_id]));
    return s.t('outreach_clients').filter(inWs(ws)).sort((x, y) => String(x.name).localeCompare(String(y.name))).map((c) => ({
      client_id: c.id, name: c.name,
      senders: s.t('outreach_senders').filter((x) => x.client_id === c.id && !x.deleted_at).length,
      leads: s.t('outreach_leads').filter((l) => l.client_id === c.id).length,
      live: s.t('outreach_enrollments').filter((e) => seqClient.get(e.sequence_id) === c.id && RUNNING_ENROLLMENT.includes(e.status)).length,
      totals: g.get(c.id) ?? zero(),
    }));
  },

  report_cost: (a, ctx) => cost(ctx.store, wsOf(a, ctx), a),

  report_funnel: (a, ctx) => funnel(ctx.store, wsOf(a, ctx), a),

  report_intents: (a, ctx) => intents(ctx.store, wsOf(a, ctx), a),

  report_overview: (a, ctx) => overview(ctx.store, wsOf(a, ctx), str(a.p_client), a.p_from, a.p_to, a.p_filters),

  report_reply_threads: (a, ctx) => replyThreads(ctx.store, wsOf(a, ctx), a),

  report_sender: (a, ctx) => {
    const s = ctx.store.get('outreach_senders', str(a.p_sender));
    if (!s) demoError('E_NOT_FOUND');
    return senderReport(ctx.store, s.workspace_id ?? ctx.ws, s, a.p_from, a.p_to);
  },

  report_senders: (a, ctx) => {
    const s = ctx.store; const ws = wsOf(a, ctx); const client = str(a.p_client);
    const { from, to } = resolveRange(s, ws, a.p_from, a.p_to, 30);
    const g = grouped(s, ws, { from, to, client, group: 'sender' });
    return s.t('outreach_senders').filter((x) => inWs(ws)(x) && !x.deleted_at && (!client || x.client_id === client)).map((x) => ({
      sender_id: x.id, name: x.display_name ?? null, provider: x.provider, status: x.status, client_id: x.client_id ?? null, health: x.health_score ?? 0,
      level: x.warmup_level ?? 1, paused_until: x.paused_until ?? null, invite_blocked_until: x.invite_blocked_until ?? null, running_dry: !!x.running_dry_at,
      totals: g.get(x.id) ?? zero(),
    })).sort((p, q) => q.totals.replies - p.totals.replies || String(p.name ?? '').localeCompare(String(q.name ?? '')));
  },

  report_sequence: (a, ctx) => {
    const q = ctx.store.get('outreach_sequences', str(a.p_sequence));
    if (!q) demoError('E_NOT_FOUND');
    const ws = q.workspace_id ?? ctx.ws;
    const { from, to, tz } = resolveRange(ctx.store, ws, a.p_from, a.p_to, 30);
    return sequenceReport(ctx.store, ws, q, from, to, tz);
  },

  report_sequences: (a, ctx) => {
    const s = ctx.store; const ws = wsOf(a, ctx); const client = str(a.p_client);
    const { from, to } = resolveRange(s, ws, a.p_from, a.p_to, 30);
    const g = grouped(s, ws, { from, to, client, group: 'sequence' });
    const enr = s.t('outreach_enrollments');
    return s.t('outreach_sequences').filter((q) => inWs(ws)(q) && q.status !== 'archived' && (!client || q.client_id === client)).map((q) => {
      const graph = JSON.stringify(q.graph ?? {});
      return {
        sequence_id: q.id, name: q.name, status: q.status, client_id: q.client_id ?? null, stalled: !!q.stalled_at, stalled_reason: q.stalled_reason ?? null,
        live: enr.filter((e) => e.sequence_id === q.id && LIVE_ENROLLMENT.includes(e.status)).length,
        failed_leads: enr.filter((e) => e.sequence_id === q.id && e.status === 'failed').length,
        has_ab_test: graph.includes('"variants"') || graph.includes('"ab_split"'),
        totals: g.get(q.id) ?? zero(),
      };
    }).sort((p, q) => q.totals.replies - p.totals.replies || String(p.name).localeCompare(String(q.name)));
  },

  save_range: (a, ctx) => {
    const ws = wsOf(a, ctx);
    const preset = str(a.p_preset);
    const from = asDay(a.p_from); const to = asDay(a.p_to);
    if (!preset && (!from || !to)) demoError('E_PAYLOAD_INVALID', 'preset or from/to required');
    const name = String(a.p_name ?? '').trim().slice(0, 60);
    if (!name) demoError('E_PAYLOAD_INVALID', 'name required');
    const row = ctx.store.insert('outreach_saved_ranges', { workspace_id: ws, user_id: ctx.userId, name, preset, from_date: from, to_date: to })[0];
    return row.id;
  },
} satisfies RpcArea;

/** Table hooks (insert defaults, side effects) for this area's tables. Called once at boot. */
export function registerReports(): void {
  tableHooks.outreach_saved_ranges = {
    ...(tableHooks.outreach_saved_ranges ?? {}),
    beforeInsert: (row) => ({ preset: null, from_date: null, to_date: null, ...row, user_id: row.user_id ?? DEMO_USER, name: String(row.name ?? '').slice(0, 60) }),
    readOnly: ['user_id', 'workspace_id'],
  };
  tableHooks.outreach_report_schedules = {
    ...(tableHooks.outreach_report_schedules ?? {}),
    beforeInsert: (row, store) => {
      const r: Row = {
        client_id: null, cadence: 'weekly', recipients: [], include_client_viewers: false, active: true, last_sent_at: null, created_by: DEMO_USER, ...row,
      };
      if (!['digest', 'client_report', 'sender_report'].includes(r.kind)) demoError('E_PAYLOAD_INVALID', 'kind must be digest, client_report or sender_report');
      if (!['weekly', 'monthly'].includes(r.cadence)) demoError('E_PAYLOAD_INVALID', 'cadence must be weekly or monthly');
      r.recipients = Array.isArray(r.recipients) ? r.recipients.map((e: unknown) => String(e).trim().toLowerCase()).filter(Boolean) : [];
      // unique (workspace, client, kind), like outreach_report_schedules_uq
      if (store.t('outreach_report_schedules').some((x) => x.workspace_id === r.workspace_id && (x.client_id ?? null) === (r.client_id ?? null) && x.kind === r.kind)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint "outreach_report_schedules_uq"'), { code: '23505' });
      }
      return r;
    },
    readOnly: ['workspace_id', 'kind', 'created_by'],
  };
}

