/**
 * Demo edge functions: imports-create, exports-create.
 */
import type { FnArea } from '../ctx';
import { demoError } from '../ctx';
import { exportsCreate } from '../leads/exports';
import { importsCreate, snOptions } from '../leads/imports';
import { audit } from '../leads/util';

export const leadsFn = {
  'imports-create': async (req, ctx) => {
    if (req.method === 'GET') {
      if (req.query.get('action') === 'sn_options') return snOptions(ctx, req.query);
      return demoError('E_PAYLOAD_INVALID', 'unknown action');
    }
    const res = await importsCreate(ctx, req.body);
    const job = res.job as { id: string; kind: string; mode: string; enrich: boolean } | undefined;
    if (job) audit(ctx.store, ctx.ws, ctx.userId, 'import.created', 'import_job', job.id, { kind: job.kind, mode: job.mode, enrich: job.enrich, ...(res.estimate as object) });
    return res;
  },
  'exports-create': (req, ctx) => {
    const res = exportsCreate(ctx, req.body);
    audit(ctx.store, ctx.ws, ctx.userId, 'export.created', 'export', String(res.path), { kind: req.body.kind, rows: res.rows, by: ctx.userId, include_notes: req.body.kind === 'messages' && req.body.include_notes === true ? true : undefined });
    return res;
  },
} satisfies FnArea;
