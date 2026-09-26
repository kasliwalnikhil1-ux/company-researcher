// The "+" picker must follow the branch it sits on: after "Already connected?" → true a message is offered and an invitation is not;
// on the false branch it is the other way round. Instagram and WhatsApp pools follow their own rules and leave LinkedIn pools untouched.
// No test framework on purpose: `npx tsx components/outreach/sequences/allowedNext.test.ts`.
import { allowedNext } from './allowedNext';
import { normalizeNode, validateGraph } from '@/lib/outreach/graph';
import { syncNodeBranches } from '@/lib/outreach/nodes';
import type { Graph, GraphNode } from '@/lib/outreach/types';
const pos = { x: 0, y: 0 };
const LI = ['LINKEDIN'] as const;
const g = { version: 1, start: 'start', nodes: {
  start: { id: 'start', type: 'start', position: pos, next: 'cond' },
  cond: { id: 'cond', type: 'condition', position: pos, config: { rules: [{ field: 'relation', op: 'eq', value: 'first' }], match: 'all' }, branches: { true: 'msg', false: 'inv' } },
  msg: { id: 'msg', type: 'send_message', position: pos, config: { text: 'hi' }, next: 'end1' },
  inv: { id: 'inv', type: 'send_invite', position: pos, config: { note: '' }, next: 'wait' },
  wait: { id: 'wait', type: 'wait_connection', position: pos, config: { window_days: 14 }, branches: { connected: 'msg2', no_connect: 'end2' } },
  msg2: { id: 'msg2', type: 'send_message', position: pos, config: { text: 'hi' }, next: 'end1' },
  end1: { id: 'end1', type: 'end', position: pos }, end2: { id: 'end2', type: 'end', position: pos },
}} as unknown as Graph;
const t = allowedNext(g, 'cond', 'true', [...LI]), f = allowedNext(g, 'cond', 'false', [...LI]);
const afterMsg = allowedNext(g, 'msg', 'next', [...LI]);
const noC = allowedNext(g, 'wait', 'no_connect', [...LI]);
const chk = (name: string, ok: boolean) => { console.log((ok ? '✓ ' : '✗ ') + name); if (!ok) process.exitCode = 1; };
chk('true branch: message allowed', t.send_message === null);
chk('true branch: invite blocked', !!t.send_invite);
chk('true branch: wait blocked', !!t.wait_connection);
chk('true branch: inmail blocked', !!t.send_inmail);
chk('false branch: invite allowed', f.send_invite === null);
chk('false branch: message blocked', !!f.send_message);
chk('false branch: wait blocked until invited', !!f.wait_connection);
chk('after message on true branch: another message allowed', afterMsg.send_message === null && !!afterMsg.send_invite);
chk('no_connect: message blocked', !!noC.send_message);
chk('LinkedIn pool: Instagram / WhatsApp steps greyed with the "add an account" reason', /Instagram account/.test(t.follow ?? '') && /WhatsApp number/.test(t.require_consent ?? '') && !!t.channel_switch);
chk('default pool (none given) behaves like LinkedIn', JSON.stringify(allowedNext(g, 'cond', 'true')) === JSON.stringify(t));
const v = validateGraph(g, { strict: true, poolProviders: [...LI] });
chk('strict validation passes (no E_RELATION_REQUIRED)', !v.errors.some((e) => e.code === 'E_RELATION_REQUIRED'));
chk('LinkedIn pool: no channel errors', !v.errors.some((e) => ['E_NO_CHANNEL_SENDER', 'E_NO_CONSENT_GUARD'].includes(e.code)));
const g2 = { version: 1, start: 'start', nodes: { start: { id: 'start', type: 'start', position: pos, next: 'msg' }, msg: { id: 'msg', type: 'send_message', position: pos, config: { text: 'hi' }, next: 'end1' }, end1: { id: 'end1', type: 'end', position: pos } } } as unknown as Graph;
chk('message with no connection path still rejected', validateGraph(g2, { strict: true }).errors.some((e) => e.code === 'E_RELATION_REQUIRED'));

// --- Instagram ---------------------------------------------------------------
const IG = ['INSTAGRAM'] as const;
const igStart = allowedNext(g2, 'start', 'next', [...IG]);
chk('Instagram pool: follow allowed first, invite greyed with the LinkedIn reason', igStart.follow === null && /LinkedIn account/.test(igStart.send_invite ?? ''));
chk('Instagram pool: a message needs no connection', igStart.send_message === null);
chk('Instagram pool: wait for follow-back needs a follow above', /Follow the person first/.test(igStart.wait_follow_back ?? ''));
chk('Instagram pool: WhatsApp steps and switch greyed', !!igStart.check_identifier && !!igStart.require_consent && !!igStart.channel_switch);
const ig = { version: 1, start: 'start', nodes: {
  start: { id: 'start', type: 'start', position: pos, next: 'follow' },
  follow: { id: 'follow', type: 'follow', position: pos, config: {}, next: 'like' },
  like: { id: 'like', type: 'like_recent_posts', position: pos, config: { count: 4, max_age_days: 60 }, next: 'wfb' },
  wfb: { id: 'wfb', type: 'wait_follow_back', position: pos, config: { window_days: 5, poll_budget: 2 }, branches: { followed_back: 'dm', no_follow_back: 'comment' } },
  comment: { id: 'comment', type: 'comment_post', position: pos, config: { text: 'Love this. Book a demo with us!', max_age_days: 60 }, next: 'dm' },
  dm: { id: 'dm', type: 'send_message', position: pos, config: { text: 'hey', new_chat_allowed: true }, next: 'end' },
  end: { id: 'end', type: 'end', position: pos },
}} as unknown as Graph;
const afterFollow = allowedNext(ig, 'follow', 'next', [...IG]);
chk('after follow: wait for follow-back allowed, second follow greyed', afterFollow.wait_follow_back === null && !!afterFollow.follow);
const vig = validateGraph(ig, { strict: true, poolProviders: [...IG] });
chk('Instagram: like count 4 → E_LIKE_COUNT', vig.errors.some((e) => e.code === 'E_LIKE_COUNT' && e.node_id === 'like'));
chk('Instagram: pitch comment → W_IG_COMMENT_PITCH', vig.warnings.some((w) => w.code === 'W_IG_COMMENT_PITCH' && w.node_id === 'comment'));
chk('Instagram: no LinkedIn connection rule, no consent rule', !vig.errors.some((e) => e.code === 'E_RELATION_REQUIRED' || e.code === 'E_NO_CONSENT_GUARD'));
chk('Instagram: follow first → no W_IG_DM_FIRST', !vig.warnings.some((w) => w.code === 'W_IG_DM_FIRST'));
const igDm = { version: 1, start: 'start', nodes: { start: { id: 'start', type: 'start', position: pos, next: 'dm' }, dm: { id: 'dm', type: 'send_message', position: pos, config: { text: 'hey' }, next: 'end' }, end: { id: 'end', type: 'end', position: pos } } } as unknown as Graph;
chk('Instagram: message first → W_IG_DM_FIRST', validateGraph(igDm, { strict: true, poolProviders: [...IG] }).warnings.some((w) => w.code === 'W_IG_DM_FIRST'));
chk('Instagram pool with a LinkedIn step → E_NO_CHANNEL_SENDER asking for a LinkedIn account', validateGraph(g, { strict: true, poolProviders: [...IG] }).errors.some((e) => e.code === 'E_NO_CHANNEL_SENDER' && e.node_id === 'inv' && /LinkedIn account/.test(e.message)));
chk('LinkedIn pool with an Instagram step → E_NO_CHANNEL_SENDER asking for an Instagram account', validateGraph(ig, { strict: true, poolProviders: [...LI] }).errors.some((e) => e.code === 'E_NO_CHANNEL_SENDER' && e.node_id === 'follow' && /Instagram account/.test(e.message)));
const igLong = (() => { const nodes: Record<string, unknown> = { start: { id: 'start', type: 'start', position: pos, next: 'f0' } }; for (let i = 0; i < 11; i++) nodes[`f${i}`] = { id: `f${i}`, type: i % 2 ? 'follow' : 'unfollow', position: pos, config: {}, next: i < 10 ? `f${i + 1}` : 'end' }; nodes.end = { id: 'end', type: 'end', position: pos }; return { version: 1, start: 'start', nodes } as unknown as Graph; })();
chk('Instagram: 11 actions back to back → E_HOURLY_DEMAND', validateGraph(igLong, { poolProviders: [...IG] }).errors.some((e) => e.code === 'E_HOURLY_DEMAND'));

// --- WhatsApp ----------------------------------------------------------------
const WA = ['WHATSAPP'] as const;
const waStart = allowedNext(g2, 'start', 'next', [...WA]);
chk('WhatsApp pool: message greyed until consent is checked', /Check consent/.test(waStart.send_message ?? ''));
chk('WhatsApp pool: check the number and check consent allowed, Instagram steps greyed', waStart.check_identifier === null && waStart.require_consent === null && /Instagram account/.test(waStart.follow ?? ''));
const wa = { version: 1, start: 'start', nodes: {
  start: { id: 'start', type: 'start', position: pos, next: 'consent' },
  consent: { id: 'consent', type: 'require_consent', position: pos, config: { bases: ['imported_attested'] }, branches: { has_consent: 'msg', no_consent: 'end' } },
  msg: { id: 'msg', type: 'send_message', position: pos, config: { text: 'hi', new_chat_allowed: true }, next: 'end' },
  end: { id: 'end', type: 'end', position: pos },
}} as unknown as Graph;
chk('after check consent: message allowed', allowedNext(wa, 'consent', 'has_consent', [...WA]).send_message === null);
const vwa = validateGraph(wa, { strict: true, poolProviders: [...WA] });
chk('WhatsApp: guarded message passes, attested-only basis warns', !vwa.errors.some((e) => e.code === 'E_NO_CONSENT_GUARD') && vwa.warnings.some((w) => w.code === 'W_WA_ATTESTED_ONLY'));
chk('WhatsApp: unguarded message → E_NO_CONSENT_GUARD', validateGraph(g2, { strict: true, poolProviders: [...WA] }).errors.some((e) => e.code === 'E_NO_CONSENT_GUARD'));
chk('WhatsApp: explicit channel on a LinkedIn pool → E_NO_CONSENT_GUARD + E_NO_CHANNEL_SENDER', (() => { const r = validateGraph({ ...g2, nodes: { ...g2.nodes, msg: { ...g2.nodes.msg, config: { text: 'hi', channel: 'WHATSAPP' } } } }, { strict: true, poolProviders: [...LI] }); return r.errors.some((e) => e.code === 'E_NO_CONSENT_GUARD') && r.errors.some((e) => e.code === 'E_NO_CHANNEL_SENDER' && /WhatsApp number/.test(e.message)); })());
chk('WhatsApp: message limit is 4,096', validateGraph({ ...g2, nodes: { ...g2.nodes, msg: { ...g2.nodes.msg, config: { text: 'x'.repeat(5000) } } } }, { strict: true, poolProviders: [...WA] }).errors.some((e) => e.code === 'E_PAYLOAD_INVALID' && /WhatsApp allows 4,096/.test(e.message)));

// --- cross-channel -----------------------------------------------------------
const mixed = ['LINKEDIN', 'WHATSAPP'] as const;
const sw = { version: 1, start: 'start', nodes: {
  start: { id: 'start', type: 'start', position: pos, next: 'inv' },
  inv: { id: 'inv', type: 'send_invite', position: pos, config: { note: '' }, next: 'wait' },
  wait: { id: 'wait', type: 'wait_connection', position: pos, config: { window_days: 14 }, branches: { connected: 'reply', no_connect: 'end' } },
  reply: { id: 'reply', type: 'wait_for_reply', position: pos, config: { window_hours: 96 }, branches: { replied: 'switch', no_reply: 'end' } },
  switch: { id: 'switch', type: 'channel_switch', position: pos, config: { to_channel: 'WHATSAPP', require_identity: true }, branches: { next: 'msg', unavailable: 'end' } },
  msg: { id: 'msg', type: 'send_message', position: pos, config: { text: 'hi' }, next: 'end' },
  end: { id: 'end', type: 'end', position: pos },
}} as unknown as Graph;
chk('two channels in the pool: switch channel allowed', allowedNext(sw, 'wait', 'connected', [...mixed]).channel_switch === null);
const afterSwitch = allowedNext(sw, 'switch', 'next', [...mixed]);
chk('after a switch to WhatsApp: message allowed (the switch checked consent), LinkedIn steps greyed', afterSwitch.send_message === null && /after the switch above/.test(afterSwitch.send_invite ?? ''));
const vsw = validateGraph(sw, { strict: true, poolProviders: [...mixed], channelIndependent: true });
chk('switch: message after it needs no consent step, no identity warning after a reply', !vsw.errors.some((e) => e.code === 'E_NO_CONSENT_GUARD') && !vsw.warnings.some((w) => w.code === 'W_SWITCH_NO_IDENTITY'));
chk('channel-independent continuation on a two-channel pool → W_CHANNEL_INDEPENDENT', vsw.warnings.some((w) => w.code === 'W_CHANNEL_INDEPENDENT'));
chk('one-channel pool: no W_CHANNEL_INDEPENDENT', !validateGraph(g, { strict: true, poolProviders: [...LI], channelIndependent: true }).warnings.some((w) => w.code === 'W_CHANNEL_INDEPENDENT'));

// --- the optional "no chat" exit of a message ---------------------------------
const m0: GraphNode = { id: 'm', type: 'send_message', position: pos, config: { text: 'hi', new_chat_allowed: true }, next: 'end' };
const m1 = syncNodeBranches({ ...m0, config: { ...m0.config, new_chat_allowed: false } });
chk('new chat off: "no chat" exit appears, onward step mirrored into branches.next', JSON.stringify(m1.branches) === JSON.stringify({ next: 'end', no_chat: null }) && m1.next === 'end');
const m2 = normalizeNode({ ...m1, next: 'stale', branches: { next: 'end', no_chat: null } });
chk('normalise: branches.next wins, an unconnected "no chat" exit is dropped', m2.next === 'end' && JSON.stringify(m2.branches) === JSON.stringify({ next: 'end' }));
const m3 = syncNodeBranches({ ...m1, config: { ...m1.config, new_chat_allowed: true } });
chk('new chat back on: single exit, target back in next only', m3.next === 'end' && m3.branches === undefined);
console.log('reasons:', t.send_invite, '|', f.send_message, '|', waStart.send_message);
