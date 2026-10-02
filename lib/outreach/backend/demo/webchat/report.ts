/**
 * outreach_webchat_report (051 + 068 products block + 069 voice block), computed from the website conversations,
 * messages, AI turns, events and voice calls in the demo store. Nothing is a stored total.
 */
import type { Ctx } from '../ctx';
import type { Row } from '../store';
import { T, agentName } from './core';
import { voiceReport } from './voice';

const pct = (xs: number[], p: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return Math.round((s[lo] + (s[hi] - s[lo]) * (i - lo)) * 10) / 10;
};
const dayStart = (d: string) => Date.parse(`${String(d).slice(0, 10)}T00:00:00.000Z`);

export function webchatReport(ctx: Ctx, inboxId: string | null, from: string, to: string): Row {
  const s = ctx.store;
  const f = dayStart(from), t = dayStart(to) + 86_400_000;
  const inboxes = s.t(T.inboxes).filter((i) => i.workspace_id === ctx.ws && (!inboxId || i.id === inboxId));
  const ids = new Set(inboxes.map((i) => i.id));
  const inRange = (at: unknown) => { const x = Date.parse(String(at ?? '')); return x >= f && x < t; };
  const ch = s.t('outreach_chats').filter((c) => c.provider === 'WEBCHAT' && ids.has(c.webchat_inbox_id) && inRange(c.created_at));
  const msgs = new Map<string, Row[]>();
  for (const m of s.t('outreach_messages')) { if (!m.chat_id) continue; const l = msgs.get(m.chat_id); if (l) l.push(m); else msgs.set(m.chat_id, [m]); }
  const agentMsgs = (id: string) => (msgs.get(id) ?? []).filter((m) => m.direction === 'out' && (m.sender_type === 'agent' || (!m.sender_type && m.origin === 'inbox_user')));
  const firstResponse = (c: Row): number | null => {
    const at = c.first_response_at ?? agentMsgs(c.id).map((m) => m.sent_at).sort()[0];
    return at ? Math.max(0, (Date.parse(at) - Date.parse(c.created_at)) / 1000) : null;
  };
  const fr = ch.map(firstResponse).filter((x): x is number => x != null);
  const res = ch.filter((c) => c.resolved_at).map((c) => Math.max(0, (Date.parse(c.resolved_at) - Date.parse(c.created_at)) / 1000));
  const count = <R,>(rows: R[], key: (r: R) => string) => rows.reduce<Record<string, number>>((m, r) => { const k = key(r); m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const turns = s.t(T.turns).filter((x) => x.workspace_id === ctx.ws && ids.has(x.inbox_id) && inRange(x.created_at));
  const csat = ch.filter((c) => c.csat && c.csat.rating != null);
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);
  const byAgent = new Map<string, number[]>();
  for (const c of csat) if (c.assigned_to) byAgent.set(c.assigned_to, [...(byAgent.get(c.assigned_to) ?? []), Number(c.csat.rating)]);
  const leadIds = new Set(ch.map((c) => c.lead_id).filter(Boolean));
  const stopped = s.t('outreach_enrollments').filter((e) => leadIds.has(e.lead_id) && e.status === 'exited_replied' && inRange(e.exited_by_message_at ?? e.exited_at)).length;
  const unanswered = Object.entries(count(turns.filter((x) => x.confidence === 'low' || x.confidence === 'refused'), (x) => String(x.query ?? '').slice(0, 120))).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([query, n]) => ({ query, n }));
  const byDay = Object.entries(count(ch, (c) => String(c.created_at).slice(0, 10))).sort((a, b) => a[0].localeCompare(b[0])).map(([day, n]) => ({ day, n }));

  // ---- Products (068)
  const visitorIds = new Set(s.t(T.visitors).filter((v) => ids.has(v.inbox_id)).map((v) => v.id));
  const ev = s.t(T.events).filter((e) => ['product:shown', 'product:clicked', 'product:added_to_cart'].includes(e.name) && visitorIds.has(e.visitor_id) && inRange(e.at));
  const shown = ev.filter((e) => e.name === 'product:shown').flatMap((e) => (Array.isArray(e.props?.ids) ? e.props.ids.map(String) : []));
  const rec = turns.flatMap((x) => (Array.isArray(x.products) ? x.products.map(String) : []));
  const clicked = ev.filter((e) => e.name === 'product:clicked' && e.props?.id).map((e) => String(e.props.id));
  const rowsOf = (list: string[]) => Object.entries(count(list, (x) => x)).sort((a, b) => b[1] - a[1]).slice(0, 10).flatMap(([id, n]) => {
    const p = s.get('outreach_products', id);
    return p && p.workspace_id === ctx.ws ? [{ id, n, title: p.title, url: p.url, image: p.image_url ?? null, removed: !!p.deleted_at }] : [];
  });
  const notFound = turns.filter((x) => x.product_search && (!Array.isArray(x.products) || x.products.length === 0) && (x.product_search.shopping === true || ((x.product_search.found ?? 0) === 0 && ('min_price' in x.product_search || 'max_price' in x.product_search))))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 30).map((x) => ({ query: String(x.query ?? '').slice(0, 160), chat_id: x.chat_id ?? null, at: x.created_at }));

  return {
    period: { from: String(from).slice(0, 10), to: String(to).slice(0, 10) },
    conversations: ch.length,
    by_source: count(ch, (c) => c.source ?? 'launcher'),
    resolved: ch.filter((c) => c.status === 'resolved').length,
    ai_resolved: ch.filter((c) => c.status === 'resolved' && c.ai_handled && agentMsgs(c.id).length === 0).length,
    handoffs: ch.filter((c) => c.handed_off_at).length,
    ai_turns: turns.length,
    ai_feedback: { up: turns.filter((x) => x.feedback === 1).length, down: turns.filter((x) => x.feedback === -1).length },
    first_response_median_s: pct(fr, 0.5), first_response_p90_s: pct(fr, 0.9), resolution_median_s: pct(res, 0.5),
    csat: { responses: csat.length, avg: avg(csat.map((c) => Number(c.csat.rating))) },
    csat_by_agent: [...byAgent.entries()].map(([user_id, xs]) => ({ user_id, name: agentName(s, ctx.ws, user_id), avg: avg(xs), n: xs.length })),
    visitor_to_lead: ch.filter((c) => c.lead_id).length,
    sequences_stopped: stopped,
    continuity: { sent: 0, failed: 0 },
    top_unanswered: unanswered,
    products: {
      answers: turns.filter((x) => x.answer != null).length, answers_with_products: turns.filter((x) => Array.isArray(x.products) && x.products.length > 0).length,
      cards_shown: shown.length, clicks: clicked.length, add_to_carts: ev.filter((e) => e.name === 'product:added_to_cart').length,
      top_recommended: rowsOf(rec), top_clicked: rowsOf(clicked), not_found: notFound,
    },
    voice: voiceReport(s, ctx.ws, ids, f, t),
    by_day: byDay,
  };
}
