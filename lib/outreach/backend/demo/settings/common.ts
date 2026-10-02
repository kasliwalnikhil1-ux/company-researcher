/**
 * Shared bits of the settings area: role checks the way `outreach_require` does them, the audit log, bigserial ids,
 * seeded secrets, and table hooks that merge with what another area may have registered on the same table.
 */
import { demoError, type Ctx } from '../ctx';
import { tableHooks, type TableHooks } from '../query';
import type { DemoStore, Row } from '../store';
import { DEMO_PREFIX, isDemoPath } from '@/lib/outreach/mode';

export type MinRole = 'owner' | 'manager' | 'member' | 'client_viewer';
const RANK: Record<string, number> = { owner: 0, manager: 1, member: 2, client_viewer: 3 };
export const INACTIVE_PLANS = ['suspended', 'cancelled', 'trial_expired'];

export function memberOf(store: DemoStore, ws: string, userId: string): Row | undefined {
  return store.t('outreach_members').find((m) => m.workspace_id === ws && m.user_id === userId);
}

export function workspaceRow(store: DemoStore, ws: string): Row {
  const w = store.t('outreach_workspaces').find((x) => x.id === ws && !x.deleted_at);
  if (!w) demoError('E_NOT_FOUND', 'workspace');
  return w;
}

/** `outreach_require(ws, min)`: a member with at least `min`; writes refused while the plan is inactive. */
export function requireWs(ctx: Ctx, ws: unknown, min: MinRole, write = true): { ws: string; member: Row; workspace: Row } {
  const id = String(ws ?? '');
  if (!id) demoError('E_PAYLOAD_INVALID', 'workspace required');
  const member = memberOf(ctx.store, id, ctx.userId);
  if (!member) demoError('E_FORBIDDEN', 'not a member of workspace');
  const workspace = workspaceRow(ctx.store, id);
  if (write && INACTIVE_PLANS.includes(workspace.plan)) demoError('E_PLAN_SUSPENDED', 'This workspace is paused because of a billing issue. An owner can fix it on the Billing page.');
  if ((RANK[member.role] ?? 9) > RANK[min]) demoError('E_FORBIDDEN', `${min} required`);
  return { ws: id, member, workspace };
}

/** Next value of a bigserial column. */
export function nextNum(store: DemoStore, table: string): number {
  let max = 0;
  for (const r of store.t(table)) if (typeof r.id === 'number' && r.id > max) max = r.id;
  return max + 1;
}

/** `outreach_audit`: one row in outreach_audit_log. */
export function audit(store: DemoStore, ws: string, actor: string | null, action: string, entity: string | null, entityId: string | null, diff: unknown = null, actorType?: string, at?: string): Row {
  return store.insert('outreach_audit_log', {
    id: nextNum(store, 'outreach_audit_log'), workspace_id: ws, actor, actor_type: actorType ?? (actor ? 'user' : 'system'),
    action, entity, entity_id: entityId, diff, at: at ?? store.nowIso(),
  })[0];
}

/** Seeded hex string (deterministic: same seed, same clicks, same secrets). */
export function hex(store: DemoStore, chars: number): string {
  let s = '';
  while (s.length < chars) s += Math.floor(store.random() * 0x100000000).toString(16).padStart(8, '0');
  return s.slice(0, chars);
}

/** Adds hooks to a table without dropping hooks another area registered on it (insert defaults are chained). */
export function addHooks(table: string, h: TableHooks): void {
  const cur = tableHooks[table] ?? {};
  const merged: TableHooks = { ...cur, ...h };
  if (cur.beforeInsert && h.beforeInsert) {
    const a = cur.beforeInsert, b = h.beforeInsert;
    merged.beforeInsert = (row, store) => b(a(row, store), store);
  }
  if (cur.afterWrite && h.afterWrite) {
    const a = cur.afterWrite, b = h.afterWrite;
    merged.afterWrite = (kind, rows, store) => { a(kind, rows, store); b(kind, rows, store); };
  }
  if (cur.beforeRead && h.beforeRead) {
    const a = cur.beforeRead, b = h.beforeRead;
    merged.beforeRead = (store) => { a(store); b(store); };
  }
  if (cur.readOnly && h.readOnly) merged.readOnly = [...new Set([...cur.readOnly, ...h.readOnly])];
  tableHooks[table] = merged;
}

/** Fills only the keys that are missing (undefined), like column defaults. */
export function defaults(row: Row, d: Row): Row {
  for (const [k, v] of Object.entries(d)) if (row[k] === undefined) row[k] = typeof v === 'function' ? (v as () => unknown)() : v;
  return row;
}

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const lowerTrim = (v: unknown) => String(v ?? '').trim().toLowerCase();

/** A same-app path inside the tour (`/outreach/x` → `/product-tour/x`, under the prefix the visitor arrived on). */
export function tourPath(path: string): string {
  if (path === '/outreach') return DEMO_PREFIX;
  if (path.startsWith('/outreach/') || path.startsWith('/outreach?')) return `${DEMO_PREFIX}${path.slice('/outreach'.length)}`;
  return isDemoPath(path) ? path : `${DEMO_PREFIX}${path.startsWith('/') ? '' : '/'}${path}`;
}

/** The browser origin when there is one (links the visitor can copy). */
export const origin = (): string => (typeof window !== 'undefined' && window.location ? window.location.origin : 'https://app.example.com');
