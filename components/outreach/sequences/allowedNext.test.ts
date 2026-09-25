// The "+" picker must follow the branch it sits on: after "Already connected?" → true a message is offered and an invitation is not;
// on the false branch it is the other way round. No test framework on purpose: `npx tsx components/outreach/sequences/allowedNext.test.ts`.
import { allowedNext } from './allowedNext';
import { validateGraph } from '@/lib/outreach/graph';
import type { Graph } from '@/lib/outreach/types';
const pos = { x: 0, y: 0 };
const g = { version: 1, start: 'start', nodes: {
  start: { id: 'start', type: 'start', position: pos, next: 'cond' },
  cond: { id: 'cond', type: 'condition', position: pos, config: { rules: [{ field: 'relation', op: 'eq', value: 'first' }], match: 'all' }, branches: { true: 'msg', false: 'inv' } },
  msg: { id: 'msg', type: 'send_message', position: pos, config: { text: 'hi' }, next: 'end1' },
  inv: { id: 'inv', type: 'send_invite', position: pos, config: { note: '' }, next: 'wait' },
  wait: { id: 'wait', type: 'wait_connection', position: pos, config: { window_days: 14 }, branches: { connected: 'msg2', no_connect: 'end2' } },
  msg2: { id: 'msg2', type: 'send_message', position: pos, config: { text: 'hi' }, next: 'end1' },
  end1: { id: 'end1', type: 'end', position: pos }, end2: { id: 'end2', type: 'end', position: pos },
}} as unknown as Graph;
const t = allowedNext(g, 'cond', 'true'), f = allowedNext(g, 'cond', 'false');
const afterMsg = allowedNext(g, 'msg', 'next');
const noC = allowedNext(g, 'wait', 'no_connect');
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
const v = validateGraph(g, { strict: true });
chk('strict validation passes (no E_RELATION_REQUIRED)', !v.errors.some((e) => e.code === 'E_RELATION_REQUIRED'));
const g2 = { version: 1, start: 'start', nodes: { start: { id: 'start', type: 'start', position: pos, next: 'msg' }, msg: { id: 'msg', type: 'send_message', position: pos, config: { text: 'hi' }, next: 'end1' }, end1: { id: 'end1', type: 'end', position: pos } } } as unknown as Graph;
chk('message with no connection path still rejected', validateGraph(g2, { strict: true }).errors.some((e) => e.code === 'E_RELATION_REQUIRED'));
console.log('reasons:', t.send_invite, '|', f.send_message);
