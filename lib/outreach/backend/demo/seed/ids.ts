/**
 * Fixed ids of the demo workspace. Relative imports only (the demo check runs some demo modules in Node).
 * Generated rows (leads, chats …) use `idFrom(n, SALT.x)` so their ids are known without building the seed.
 */
import { idFrom } from '../store';

export { DEMO_WS_ID, DEMO_USER_ID, DEMO_USER_EMAIL, DEMO_USER_NAME } from '../../../demoIds';

const fixed = (prefix: string, n: number) => `00000000-0000-4000-8000-${prefix}${String(n).padStart(12 - prefix.length, '0')}`;

export const MEMBER = {
  maya: '00000000-0000-4000-8000-00000000d001',
  sam: fixed('d0', 2),
  priya: fixed('d0', 3),
  leo: fixed('d0', 4),
};

export const CLIENT = { lumen: fixed('c1', 1), orchard: fixed('c1', 2), bluecairn: fixed('c1', 3) };

export const SENDER = {
  li_maya: fixed('5e', 1),
  li_sam: fixed('5e', 2),
  li_priya_warm: fixed('5e', 3),
  li_reconnect: fixed('5e', 4),
  li_paused: fixed('5e', 5),
  gmail: fixed('5e', 6),
  outlook: fixed('5e', 7),
  whatsapp: fixed('5e', 8),
  instagram: fixed('5e', 9),
  // more LinkedIn accounts the team runs (5e…10 is the webchat sender below)
  li_jess: fixed('5e', 11),
  li_ravi: fixed('5e', 12),
  li_hannah: fixed('5e', 13),
  li_vikram: fixed('5e', 14),
  li_marta: fixed('5e', 15),
};

export const SEQ = {
  saas: fixed('5a', 1),        // running, LinkedIn, the tour's sample sequence
  agencies: fixed('5a', 2),    // running, LinkedIn → email (multichannel)
  dental: fixed('5a', 3),      // running, client sequence
  revive: fixed('5a', 4),      // paused
  webinar: fixed('5a', 5),     // finished
  draft: fixed('5a', 6),       // draft
};

/** The demo website (web chat inbox) and the synthetic WEBCHAT sender its conversations belong to. */
export const WEBCHAT = { inbox: fixed('3b', 1), sender: fixed('5e', 10) };

export const LIST = { founders: fixed('1a', 1), agencies: fixed('1a', 2), dental: fixed('1a', 3), events: fixed('1a', 4) };
export const TAG = { hot: fixed('7a', 1), decision_maker: fixed('7a', 2), event_2026: fixed('7a', 3), partner: fixed('7a', 4), do_later: fixed('7a', 5) };
export const STAGE = { new: fixed('57', 1), contacted: fixed('57', 2), connected: fixed('57', 3), replied: fixed('57', 4), interested: fixed('57', 5), meeting: fixed('57', 6), won: fixed('57', 7), lost: fixed('57', 8) };

/** Salts for generated ids. */
export const SALT = { lead: 101, chat: 202, message: 303, enrollment: 404, action: 505, task: 606 };

export const leadId = (i: number) => idFrom(i + 1, SALT.lead);

/** Ids the route manifest and the checks open (the first rows of each kind). */
export const SAMPLE = {
  leadId: leadId(0),
  sequenceId: SEQ.saas,
  senderId: SENDER.li_maya,
  clientId: CLIENT.lumen,
};
