/**
 * Background work of the demo AI, on short real-time timers so the screens show progress:
 *   value    write one pending AI line / Fields value (personalLine / fieldValues)
 *   crawl    move a knowledge source pending → crawling → ready
 *   sync     a product catalogue sync (adds products in a few steps)
 *   send     an Auto reply whose hold is over
 * The queue lives in the store's meta (absolute due times), so a reload finishes what was running: anything overdue is
 * done on the next read of an AI table.
 */
import { fieldsSummary } from '../../../aiFields';
import type { AiField } from '../../../types';
import { fieldValues, personalLine } from '../ai';
import type { DemoStore, Row } from '../store';
import { readStored } from '../storage';
import { catalogueProducts, productRow } from './catalogue';

export type Job = { kind: 'value' | 'crawl' | 'sync' | 'send'; id: string; due: number; step?: number };

const QUEUE = 'ai_jobs';
export const DEMO_MODEL = 'demo-sample';
let timer: ReturnType<typeof setTimeout> | null = null;
let timerStore: DemoStore | null = null;
let running = false;

function queue(store: DemoStore): Job[] { return store.meta<Job[]>(QUEUE, () => []); }

export function addJob(store: DemoStore, job: Job): void {
  const q = queue(store);
  q.push(job);
  store.setMeta(QUEUE, q);
  arm(store);
}

function arm(store: DemoStore): void {
  const q = queue(store);
  if (!q.length) return;
  const next = Math.min(...q.map((j) => j.due));
  if (timer && timerStore === store) return;
  timerStore = store;
  timer = setTimeout(() => { timer = null; pump(store); }, Math.max(50, Math.min(5000, next - Date.now())));
}

/** Runs every job that is due, then re-arms the timer for the rest. Safe to call on every read. */
export function pump(store: DemoStore): void {
  if (running) return;
  const q = queue(store);
  if (!q.length) return;
  running = true;
  try {
    const now = Date.now();
    const due = q.filter((j) => j.due <= now);
    if (due.length) {
      store.setMeta(QUEUE, q.filter((j) => j.due > now));
      for (const j of due) {
        try { run(store, j); } catch (e) { console.error('[demo] AI job failed', j, e); }
      }
    }
  } finally { running = false; }
  arm(store);
}

function run(store: DemoStore, j: Job): void {
  if (j.kind === 'value') fillValue(store, j.id);
  else if (j.kind === 'crawl') crawlStep(store, j);
  else if (j.kind === 'sync') syncStep(store, j);
  else if (j.kind === 'send') sendHook?.(store, j.id);
}

/** Set by replies.ts (avoids an import cycle). */
let sendHook: ((store: DemoStore, runId: string) => void) | null = null;
export function setSendHook(fn: (store: DemoStore, runId: string) => void) { sendHook = fn; }

// ---------------------------------------------------------------------------------------------------------------
// AI values
// ---------------------------------------------------------------------------------------------------------------
/** What a variable writes for one lead, without storing it (also the "Try on a lead" preview). */
export function generateFor(store: DemoStore, variable: Row, leadId: string): { text: string | null; data: Row | null; facts: Row[]; blank: boolean } {
  const profile = store.get('outreach_lead_profiles', leadId, 'lead_id');
  if (variable.output === 'fields') {
    const fields = (variable.fields ?? []) as AiField[];
    const data = fieldValues(store, leadId, fields as Array<{ key: string; type: string; options?: string[] }>);
    // a text field gets a believable sentence that fits its limit
    for (const f of fields) if (f.type === 'text') data[f.key] = String(data[f.key] ?? '').slice(0, f.max_chars ?? 200);
    const text = fieldsSummary(fields, data) || null;
    const lead = store.get('outreach_leads', leadId) ?? {};
    const facts = [{ label: 'Title', value: String(lead.title ?? '') }, { label: 'Company', value: String(lead.company ?? '') }];
    if (profile?.connections_count) facts.push({ label: 'Connections', value: String(profile.connections_count) });
    return { text, data, facts, blank: !text };
  }
  const hasPosts = Array.isArray(profile?.posts) && profile.posts.length > 0;
  if (variable.needs_posts && !hasPosts) return { text: null, data: null, facts: [], blank: true };
  const line = personalLine(store, leadId);
  const max = Number(variable.max_chars ?? 220);
  return { text: line.text.slice(0, max), data: null, facts: line.facts, blank: false };
}

export function fillValue(store: DemoStore, valueId: string): void {
  const v = store.get('outreach_ai_values', valueId);
  if (!v || v.status !== 'pending') return;
  const variable = store.get('outreach_ai_variables', v.variable_id);
  if (!variable) return;
  const now = new Date().toISOString();
  if (variable.mode === 'off') {
    store.update('outreach_ai_values', valueId, { status: 'skipped', locked_at: null, updated_at: now });
  } else {
    const g = generateFor(store, variable, v.lead_id);
    store.update('outreach_ai_values', valueId, {
      status: g.blank ? 'blank' : 'generated', text: g.text, data: g.data, facts: g.facts, model: DEMO_MODEL, error: null, attempts: (v.attempts ?? 0) + 1,
      locked_at: null, generated_at: g.blank ? null : now, updated_at: now,
    });
  }
  finishBatch(store, v.batch_id);
}

export function finishBatch(store: DemoStore, batchId: string | null | undefined): void {
  if (!batchId) return;
  const b = store.get('outreach_ai_batches', batchId);
  if (!b || b.status !== 'generating') return;
  const vals = store.t('outreach_ai_values').filter((x) => x.batch_id === batchId);
  if (vals.some((x) => x.status === 'pending')) return;
  const waiting = vals.some((x) => x.status === 'generated');
  store.update('outreach_ai_batches', batchId, { status: waiting ? 'review' : 'done', finished_at: new Date().toISOString() });
}

/** Queues pending values: one every ~350 ms, so the progress bar moves. */
export function queueValues(store: DemoStore, ids: string[], startIn = 900): void {
  const t0 = Date.now() + startIn;
  ids.forEach((id, i) => addJob(store, { kind: 'value', id, due: t0 + i * 350 }));
}

// ---------------------------------------------------------------------------------------------------------------
// Knowledge sources: a fake crawl
// ---------------------------------------------------------------------------------------------------------------
export function queueCrawl(store: DemoStore, sourceId: string): void {
  addJob(store, { kind: 'crawl', id: sourceId, due: Date.now() + 1500, step: 0 });
}

function crawlStep(store: DemoStore, j: Job): void {
  const s = store.get('outreach_knowledge_sources', j.id);
  if (!s) return;
  const now = new Date().toISOString();
  const step = j.step ?? 0;
  if (s.kind === 'website') {
    const total = 6 + (s.title.length % 9);
    if (step < 3) {
      store.update('outreach_knowledge_sources', s.id, { status: 'crawling', pages: Math.round(total * (step + 1) / 4), chunks: Math.round(total * 3.5 * (step + 1) / 4), updated_at: now });
      addJob(store, { kind: 'crawl', id: s.id, due: Date.now() + 1400, step: step + 1 });
      return;
    }
    store.update('outreach_knowledge_sources', s.id, { status: 'ready', pages: total, chunks: Math.round(total * 3.5), crawled_at: now, error: null, updated_at: now });
    if (s.detect_products) startSync(store, s.id, 0);
    return;
  }
  if (step === 0) {
    store.update('outreach_knowledge_sources', s.id, { status: 'crawling', updated_at: now });
    addJob(store, { kind: 'crawl', id: s.id, due: Date.now() + 1600, step: 1 });
    return;
  }
  const finish = (chars: number) => store.update('outreach_knowledge_sources', s.id, {
    status: 'ready', pages: 1, chunks: Math.max(1, Math.ceil(chars / 1200)), crawled_at: new Date().toISOString(), error: null, updated_at: new Date().toISOString(),
  });
  if (s.kind === 'text') { finish(String(s.text_inline ?? '').length); return; }
  const blob = s.storage_path ? readStored('outreach-knowledge', s.storage_path) : null;
  if (!blob) { finish(4800); return; }
  void blob.text().then((t) => finish(t.length), () => finish(4800));
}

// ---------------------------------------------------------------------------------------------------------------
// Product catalogues: a fake sync
// ---------------------------------------------------------------------------------------------------------------
export function startSync(store: DemoStore, sourceId: string, delay = 1500): void {
  const s = store.get('outreach_knowledge_sources', sourceId);
  if (!s) return;
  store.update('outreach_knowledge_sources', sourceId, {
    status: s.kind === 'catalogue' ? 'crawling' : s.status,
    catalogue: { ...(s.catalogue ?? { provider: 'crawl' }), sync: { started_at: new Date().toISOString(), page: 0, seen: 0, rejected: 0 } },
    updated_at: new Date().toISOString(),
  });
  addJob(store, { kind: 'sync', id: sourceId, due: Date.now() + delay, step: 0 });
}

function syncStep(store: DemoStore, j: Job): void {
  const s = store.get('outreach_knowledge_sources', j.id);
  if (!s) return;
  const step = j.step ?? 0;
  const provider = s.catalogue?.provider ?? 'crawl';
  if (provider === 'csv' && s.storage_path && step === 0) {
    const blob = readStored('outreach-knowledge', s.storage_path);
    if (blob) {
      void blob.text().then((t) => { csvImport(store, s, t); }, () => syncFinish(store, s.id, 'The file could not be read. Upload it again.'));
      return;
    }
  }
  const list = catalogueProducts(store, s);
  const per = Math.ceil(list.length / 3);
  const now = new Date().toISOString();
  const cur = s.catalogue?.currency_locked ? s.catalogue.currency : null;
  for (const p of list.slice(step * per, (step + 1) * per)) {
    store.upsert('outreach_products', { ...productRow(s, p), ...(cur ? { currency: cur } : {}), seen_at: now, deleted_at: null, updated_at: now }, ['source_id', 'external_id']);
  }
  if (step < 2) {
    store.update('outreach_knowledge_sources', s.id, (r) => ({ catalogue: { ...(r.catalogue ?? {}), sync: { ...(r.catalogue?.sync ?? {}), page: step + 1, seen: Math.min(list.length, (step + 1) * per) } }, updated_at: now }));
    addJob(store, { kind: 'sync', id: s.id, due: Date.now() + 1300, step: step + 1 });
    return;
  }
  syncFinish(store, s.id, null);
}

function syncFinish(store: DemoStore, sourceId: string, error: string | null): void {
  const now = new Date().toISOString();
  const n = store.t('outreach_products').filter((p) => p.source_id === sourceId && !p.deleted_at).length;
  store.update('outreach_knowledge_sources', sourceId, (r) => {
    const { sync: _sync, ...cat } = r.catalogue ?? {};
    void _sync;
    const currency = cat.currency_locked ? cat.currency : (store.t('outreach_products').find((p) => p.source_id === sourceId)?.currency ?? cat.currency ?? null);
    return {
      status: error ? 'error' : 'ready', error, crawled_at: error ? r.crawled_at : now, updated_at: now, pages: r.kind === 'catalogue' ? Math.max(1, Math.ceil(n / 25)) : r.pages,
      catalogue: { ...cat, provider: cat.provider ?? 'crawl', currency, products: n, synced_at: error ? cat.synced_at ?? null : now, complete: !error, last_error: error, last_error_at: error ? now : null },
    };
  });
}

function csvImport(store: DemoStore, s: Row, text: string): void {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const sep = lines[0]?.includes('\t') ? '\t' : ',';
  const split = (l: string) => { const out: string[] = []; let cur = '', q = false; for (const c of l) { if (c === '"') { q = !q; continue; } if (c === sep && !q) { out.push(cur); cur = ''; continue; } cur += c; } out.push(cur); return out.map((x) => x.trim()); };
  const head = split(lines[0] ?? '').map((h) => h.toLowerCase());
  const col = (row: string[], name: string) => { const i = head.indexOf(name); return i >= 0 ? row[i] ?? '' : ''; };
  const now = new Date().toISOString();
  let n = 0;
  for (const l of lines.slice(1, 2001)) {
    const r = split(l);
    const title = col(r, 'title');
    const link = col(r, 'link');
    if (!title || !link) continue;
    const price = Number(col(r, 'sale_price') || col(r, 'price'));
    const compare = col(r, 'sale_price') ? Number(col(r, 'price')) : null;
    store.upsert('outreach_products', {
      workspace_id: s.workspace_id, source_id: s.id, external_id: col(r, 'id') || link, handle: null, sku: col(r, 'id') || null, url: link, title,
      description: col(r, 'description').slice(0, 2000) || null, vendor: col(r, 'brand') || null, product_type: col(r, 'product_type') || null,
      tags: col(r, 'tags').split(',').map((t) => t.trim()).filter(Boolean), options: {}, price: Number.isFinite(price) && price > 0 ? price : null,
      compare_at_price: compare && Number.isFinite(compare) ? compare : null, currency: s.catalogue?.currency_locked ? s.catalogue.currency : (col(r, 'currency') || s.catalogue?.currency || null),
      available: !/out/i.test(col(r, 'availability')), image_url: col(r, 'image_link') || null, images: [], variants: [], pinned_keywords: [], ai_hidden: false,
      seen_at: now, deleted_at: null, updated_at: now,
    }, ['source_id', 'external_id']);
    n++;
  }
  syncFinish(store, s.id, n ? null : 'No products found. The file needs at least the columns title and link.');
}
