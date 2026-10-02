'use client';

import { createContext, useContext } from 'react';
import type { AiVariable, Graph, Lead, List, OutboundWebhook, Sender, Sequence, Stage, Tag } from '@/lib/outreach/types';

export interface BuilderCtx {
  workspaceId: string;
  sequenceId: string;
  sequence: Sequence;
  graph: Graph;
  readOnly: boolean;
  senders: Sender[];
  poolSenders: Sender[];
  tags: Tag[];
  lists: List[];
  stages: Stage[];
  webhooks: OutboundWebhook[];
  sequences: Sequence[];
  sampleLead: Lead | null;
  customKeys: string[];
  /** The workspace's AI variables (Personalized lines): the "AI fields" of a Condition step and the builder's checks. */
  aiVariables: AiVariable[];
  createTag: (name: string) => Promise<Tag>;
  focusNode: (id: string) => void;
}

export const BuilderContext = createContext<BuilderCtx | null>(null);

export function useBuilder(): BuilderCtx {
  const ctx = useContext(BuilderContext);
  if (!ctx) throw new Error('useBuilder must be used inside the sequence Builder');
  return ctx;
}
