/**
 * Every edge function of the outreach UI, answered by the demo. Typed `FnHandlers`: a name in contract.names.ts with no
 * handler here is a TypeScript error.
 */
import type { FnHandlers } from '../ctx';
import { leadsFn } from './leads';
import { inboxFn } from './inbox';
import { sendersFn } from './senders';
import { aiFn } from './ai';
import { webchatFn } from './webchat';
import { settingsFn } from './settings';

export const fnHandlers: FnHandlers = {
  ...leadsFn,
  ...inboxFn,
  ...sendersFn,
  ...aiFn,
  ...webchatFn,
  ...settingsFn,
};
