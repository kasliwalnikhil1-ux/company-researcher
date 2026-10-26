// Sequence stats presentation helpers (sequence-stats-PRD.md §3.5, §6.3). No test framework on purpose:
// `npx tsx lib/outreach/sequenceStats.test.ts` from the repo root.
import assert from 'node:assert/strict';
import {
  acceptedTip, channelStages, cohortText, contactedTip, fmtCohortRange, fmtPct, isSmallBase, periodFromString, periodRange, periodToString,
  positiveTip, progressTip, rateSortValue, repliedOfAcceptedText, repliedOtherChannelText, repliedTip, statsSummary, type SequenceStatsBlock,
} from './sequenceStats';

const row = (over: Partial<SequenceStatsBlock> = {}): SequenceStatsBlock => ({
  contacted: 113, invited: 113, accepted: 38, accepted_rate: 33.6, pending: 41, accepted_early: false,
  accepted_split: { linkedin: { invited: 90, accepted: 30, pending: 35, accepted_rate: 33.3 }, instagram: { invited: 23, accepted: 8, pending: 6, accepted_rate: 34.8 } },
  replied: 9, replied_rate: 8.0, auto_replied: 2, positive: 4, positive_rate: 44.4, meetings: 1, replied_by_channel: { linkedin: 8, email: 1 }, cohort: 113,
  progress: { enrolled: 549, live: 549, done: 3, pct_done: 0.5 }, ops: { queued: 37, actions_sent: 113, failed: 0, failed_leads: 15 },
  channels: [{ channel: 'linkedin', invite_step: true, from_earlier_version: false }], na: {}, cached_at: null, definitions_version: 2, ...over,
});

let n = 0;
const ok = (name: string) => { n++; console.log(`ok   ${name}`); };

// §6.3 exact wording
assert.equal(contactedTip(row()), "113 people got at least one invite, follow or message from this sequence. That's 21% of the 549 enrolled. Visits and likes don't count.");
ok('contacted tooltip');
assert.equal(acceptedTip(row()), '38 of 113 connection requests and follows accepted (34%). 41 still pending. LinkedIn 30 of 90 · Instagram 8 of 23.');
ok('accepted tooltip with the channel split');
assert.equal(acceptedTip(row({ accepted_split: { linkedin: { invited: 113, accepted: 38, pending: 41, accepted_rate: 33.6 } } })), '38 of 113 connection requests accepted (34%). 41 still pending.');
ok('accepted tooltip, LinkedIn only');
assert.equal(acceptedTip(row({ accepted_early: true, accepted_split: {} })), '38 of 113 connection requests accepted (34%). 41 still pending. Most requests are still pending, so this rate will change.');
ok('accepted tooltip, early');
assert.equal(acceptedTip(row({ na: { accepted: "This sequence doesn't send connection requests or follows." } })), "This sequence doesn't send connection requests or follows.");
ok('accepted NA reason wins');
assert.equal(repliedTip(row()), '9 of 113 people contacted replied (8%). Not counted: 2 out-of-office and auto-replies.');
ok('replied tooltip');
assert.equal(repliedTip(row({ auto_replied: 0 })), '9 of 113 people contacted replied (8%).');
ok('replied tooltip without auto-replies');
assert.equal(positiveTip(row()), '4 of 9 replies were interested or asked a question. 1 meeting booked.');
ok('positive tooltip');
assert.equal(progressTip(row()), '549 live · 3 done · 37 actions queued · 113 actions sent');
ok('progress tooltip');
assert.equal(statsSummary(row()), '113 contacted, 38 accepted of 113 invited (34%, 41 pending), 9 replied (8%), 4 positive');
ok('summary sentence (PRD §8)');
assert.equal(repliedOtherChannelText({ whatsapp: 1 }), 'Replied on another channel: 1 (WhatsApp)');
assert.equal(repliedOtherChannelText({ whatsapp: 1, email: 2 }), 'Replied on another channel: 3 (WhatsApp 1, Email 2)');
assert.equal(repliedOtherChannelText({}), null);
ok('replied on another channel line');

// rates
assert.equal(fmtPct(null), 'n/a');
assert.equal(fmtPct(0), '0.0%');
assert.equal(fmtPct(33.33), '33.3%');
ok('rate formatting: null is n/a, never 0%');
assert.equal(isSmallBase(19), true);
assert.equal(isSmallBase(20), false);
assert.equal(rateSortValue(50, 5, 'desc'), -1);
assert.equal(rateSortValue(50, 5, 'asc'), Number.MAX_SAFE_INTEGER);
assert.equal(rateSortValue(50, 50, 'desc'), 50);
ok('small bases sort last in either direction');

// periods
assert.deepEqual(periodRange({ kind: 'all' }, 'UTC'), null);
const r7 = periodRange({ kind: '7d' }, 'UTC')!;
assert.equal(Math.round((Date.parse(r7.to) - Date.parse(r7.from)) / 86400000), 6);
assert.deepEqual(periodRange({ kind: 'custom', from: '2026-10-01', to: '2026-10-26' }, 'UTC'), { from: '2026-10-01', to: '2026-10-26' });
assert.deepEqual(periodFromString(periodToString({ kind: 'custom', from: '2026-10-01', to: '2026-10-26' })), { kind: 'custom', from: '2026-10-01', to: '2026-10-26' });
assert.deepEqual(periodFromString('30d'), { kind: '30d' });
assert.deepEqual(periodFromString('garbage'), { kind: 'all' });
assert.deepEqual(periodFromString('custom:2026-10-26:2026-10-01'), { kind: 'all' });
ok('period model round-trips and rejects bad input');
assert.equal(fmtCohortRange({ from: '2026-10-01', to: '2026-10-26' }), '1–26 Oct');
assert.equal(fmtCohortRange({ from: '2026-09-28', to: '2026-10-26' }), '28 Sep – 26 Oct');
assert.equal(fmtCohortRange({ from: '2025-12-28', to: '2026-01-03' }), '28 Dec 2025 – 3 Jan 2026');
assert.equal(cohortText({ from: '2026-10-01', to: '2026-10-26' }), 'Leads first contacted 1–26 Oct, and what they did after.');
assert.equal(cohortText(null), 'Everyone this sequence ever contacted, and what they did after.');
ok('cohort header text');

// channel blocks
const li = channelStages({ channel: 'linkedin', invite_step: true, from_earlier_version: false, stages: { contacted: 113, invited: 90, accepted: 30, accepted_rate: 33.3, messaged: 31, seen: 22, replied: 7, replied_rate: 6.2, replied_of_accepted: 7, replied_of_accepted_rate: 23.3 } });
assert.deepEqual(li.map((s) => s.label), ['Contacted', 'Invited', 'Accepted', 'Messaged', 'Seen', 'Replied']);
assert.equal(li[4].atLeast, true);
assert.equal(repliedOfAcceptedText({ channel: 'linkedin', invite_step: true, from_earlier_version: false, stages: { replied_of_accepted_rate: 23.3 } }), 'Of people who accepted, 23% replied');
const wa = channelStages({ channel: 'whatsapp', invite_step: false, from_earlier_version: false, stages: { contacted: 6, seen: 5, replied: 3, bounced: 1 } });
assert.deepEqual(wa.map((s) => s.label), ['Contacted', 'Seen', 'Replied', 'Not on WhatsApp']);
assert.equal(wa[3].aside, true);
const em = channelStages({ channel: 'email', invite_step: false, from_earlier_version: false, stages: { contacted: 40, replied: 2, bounced: 3 } });
assert.deepEqual(em.map((s) => s.label), ['Contacted', 'Replied', 'Bounced']);
assert.equal(repliedOfAcceptedText({ channel: 'email', invite_step: false, from_earlier_version: false, stages: {} }), null);
ok('channel blocks show only the stages a channel has');

console.log(`${n} checks passed`);
