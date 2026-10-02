/**
 * Every SQL RPC of the outreach UI, answered by the demo. Typed `RpcHandlers`: a name in contract.names.ts with no
 * handler here is a TypeScript error (docs/outreach/PRODUCT-TOUR.md §6).
 */
import type { RpcHandlers } from '../ctx';
import { sequencesRpc, registerSequences } from './sequences';
import { leadsRpc, registerLeads } from './leads';
import { inboxRpc, registerInbox } from './inbox';
import { sendersRpc, registerSenders } from './senders';
import { aiRpc, registerAi } from './ai';
import { webchatRpc, registerWebchat } from './webchat';
import { settingsRpc, registerSettings } from './settings';
import { reportsRpc, registerReports } from './reports';

export const rpcHandlers: RpcHandlers = {
  ...sequencesRpc,
  ...leadsRpc,
  ...inboxRpc,
  ...sendersRpc,
  ...aiRpc,
  ...webchatRpc,
  ...settingsRpc,
  ...reportsRpc,
};

/** Table hooks of every area. */
export function registerAll(): void {
  registerSequences();
  registerLeads();
  registerInbox();
  registerSenders();
  registerAi();
  registerWebchat();
  registerSettings();
  registerReports();
}
