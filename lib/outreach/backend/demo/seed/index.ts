/**
 * Builds the demo's starting data. A fixed random seed and dates relative to "now": the same build every time, and
 * charts always look current. Order matters: the core rows first, then data the history needs (approved AI lines),
 * then the 60-day history, then each area's own rows (which may refer to conversations the history created).
 */
import { DemoStore, SEED_VERSION, type DemoState } from '../store';
import { seedAi, seedAiBeforeHistory } from './ai';
import { seedHistory, seedLeads, seedReference, seedSenders, seedSequences, seedTaxonomy, seedWorkspace } from './core';
import { seedFaces } from './faces';
import { seedInbox } from './inbox';
import { seedLeads as seedLeadExtras } from './leads';
import { seedReports } from './reports';
import { seedSenders as seedSenderExtras } from './senders';
import { seedSent } from './sent';
import { seedSequences as seedSequenceExtras } from './sequences';
import { seedSettings } from './settings';
import { seedWebchat } from './webchat';

export const RNG_SEED = 20261002;

export function buildSeed(): DemoState {
  const state: DemoState = { v: SEED_VERSION, tables: {}, simOffsetMs: 0, rng: RNG_SEED, seq: 0, meta: {}, builtAt: Date.now() };
  const s = new DemoStore(state);
  s.persistent = false;
  const now = Date.now();
  seedWorkspace(s, now);
  seedReference(s);
  seedSenders(s, now);
  seedTaxonomy(s, now);
  seedLeads(s, now);
  seedSequences(s, now);
  seedAiBeforeHistory(s, now);
  seedHistory(s, now);
  seedSequenceExtras(s, now);
  seedLeadExtras(s, now);
  seedSenderExtras(s, now);
  seedAi(s, now);
  seedWebchat(s, now);
  seedInbox(s, now);
  seedSent(s, now);
  seedSettings(s, now);
  seedReports(s, now);
  seedFaces(s);
  return s.state;
}
