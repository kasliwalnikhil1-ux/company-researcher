// Template rendering: {{first_name|fallback}}, {{company}}, {{custom.x}}, {{sender.first_name}}
// Kept dependency-free so the same code runs in the browser and in Deno (copied to supabase/functions/_shared/outreach/render.ts).

export interface RenderContext {
  lead: Record<string, any>;
  sender?: Record<string, any> | null;
}

const VAR_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*(?:\|\s*([^}]*?))?\s*\}\}/g;

function resolve(path: string, ctx: RenderContext): unknown {
  const parts = path.split('.');
  let cur: any;
  if (parts[0] === 'sender') { cur = ctx.sender ?? {}; parts.shift(); }
  else if (parts[0] === 'custom') { cur = ctx.lead?.custom ?? {}; parts.shift(); }
  else cur = ctx.lead ?? {};
  if (parts.length === 0) return undefined;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  if (cur === undefined && path === 'first_name' && ctx.lead?.full_name) return String(ctx.lead.full_name).split(' ')[0];
  if (cur === undefined && path === 'sender.first_name' && ctx.sender?.display_name) return String(ctx.sender.display_name).split(' ')[0];
  if (cur === undefined && path === 'sender.full_name' && ctx.sender?.display_name) return ctx.sender.display_name;
  return cur;
}

export function renderTemplate(template: string | null | undefined, ctx: RenderContext): string {
  if (!template) return '';
  return template.replace(VAR_RE, (_m, name: string, fallback?: string) => {
    const v = resolve(name, ctx);
    if (v === undefined || v === null || v === '') return (fallback ?? '').trim();
    return String(v);
  });
}

export function templateVariables(template: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(VAR_RE.source, 'g');
  while ((m = re.exec(template))) out.add(m[1]);
  return [...out];
}

export function missingVariables(template: string, ctx: RenderContext): string[] {
  const missing: string[] = [];
  const re = new RegExp(VAR_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(template))) {
    const v = resolve(m[1], ctx);
    if ((v === undefined || v === null || v === '') && !m[2]) missing.push(m[1]);
  }
  return missing;
}
