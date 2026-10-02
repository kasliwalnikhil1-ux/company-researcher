/** Knowledge sources, Q&A targets and the fixed ids of the AI seed. */
import { idFrom, type DemoStore, type Row } from '../store';

const SALT_AI = 919;
export const AI_IDS = {
  varIcebreaker: idFrom(1, SALT_AI),
  varFit: idFrom(2, SALT_AI),
  varOpener: idFrom(3, SALT_AI),
  ksSite: idFrom(11, SALT_AI),
  ksDoc: idFrom(12, SALT_AI),
  ksText: idFrom(13, SALT_AI),
  catalogue: idFrom(14, SALT_AI),
  mpSaas: idFrom(21, SALT_AI),
  mpLibrary: idFrom(22, SALT_AI),
  builtinFirst: idFrom(31, SALT_AI),
  builtinCompany: idFrom(32, SALT_AI),
  builtinPosition: idFrom(33, SALT_AI),
};

export const liveInboxes = (store: DemoStore, ws: string): Row[] => store.t('outreach_webchat_inboxes').filter((i) => i.workspace_id === ws && !i.deleted_at);

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
export const inboxKnowledgeIds = (i: Row): string[] => arr(i.settings?.ai?.knowledge_source_ids);
export const inboxCatalogueIds = (i: Row): string[] => arr(i.settings?.ai?.products?.catalogue_ids);

/** `outreach__ks_json` (068). */
export function ksJson(store: DemoStore, s: Row): Row {
  const products = s.kind === 'catalogue' || s.detect_products ? store.t('outreach_products').filter((p) => p.source_id === s.id && !p.deleted_at).length : null;
  let catalogue: Row | null = null;
  if (s.catalogue) {
    const { sync, seeded, ...rest } = s.catalogue;
    void seeded;
    catalogue = { ...rest, syncing: !!sync || (s.kind === 'catalogue' && (s.status === 'pending' || s.status === 'crawling')) };
  }
  const usedBy = store.t('outreach_master_prompts').filter((mp) => (mp.knowledge_source_ids ?? []).includes(s.id)).length
    + liveInboxes(store, s.workspace_id).filter((i) => inboxKnowledgeIds(i).includes(s.id) || inboxCatalogueIds(i).includes(s.id)).length;
  return {
    id: s.id, kind: s.kind, title: s.title, url: s.url ?? null, storage_path: s.storage_path ?? null, content_type: s.content_type ?? null, status: s.status, error: s.error ?? null,
    pages: s.pages ?? 0, chunks: s.chunks ?? 0, crawled_at: s.crawled_at ?? null, refresh_days: s.refresh_days ?? null, created_at: s.created_at, updated_at: s.updated_at,
    detect_products: !!s.detect_products, catalogue, products, used_by: usedBy,
  };
}

/** Where a source is used (`outreach_hub_knowledge` → used_in). */
export function usedIn(store: DemoStore, s: Row): Row[] {
  const out: Row[] = [];
  for (const mp of store.t('outreach_master_prompts')) {
    if (mp.workspace_id !== s.workspace_id || mp.scope !== 'sequence' || !(mp.knowledge_source_ids ?? []).includes(s.id)) continue;
    const q = store.get('outreach_sequences', mp.sequence_id);
    if (q && q.status !== 'archived') out.push({ kind: 'sequence', id: q.id, name: q.name });
  }
  for (const i of liveInboxes(store, s.workspace_id)) if (inboxKnowledgeIds(i).includes(s.id)) out.push({ kind: 'website', id: i.id, name: i.name });
  return out.sort((a, b) => (a.kind === b.kind ? String(a.name).localeCompare(String(b.name)) : a.kind === 'website' ? -1 : 1));
}

export function qaTargets(store: DemoStore, qaId: string): Row[] {
  return store.t('outreach_knowledge_qa_links').filter((k) => k.qa_id === qaId)
    .sort((a, b) => a.target_kind.localeCompare(b.target_kind) || a.target_id.localeCompare(b.target_id))
    .map((k) => ({ kind: k.target_kind, id: k.target_id, name: k.target_kind === 'sequence' ? store.get('outreach_sequences', k.target_id)?.name ?? null : store.get('outreach_webchat_inboxes', k.target_id)?.name ?? null }));
}

/** Normalised question text (the trigram key of the SQL). */
export const normQuestion = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
