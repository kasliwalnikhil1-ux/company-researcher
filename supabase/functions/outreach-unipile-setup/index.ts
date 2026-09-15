// Platform setup (owner): check configuration and register the platform-level Unipile webhooks pointing at outreach-unipile-webhook.
import { admin, json, serve, requireUser, membership, requireRole, readJson, HttpError, FUNCTIONS_BASE, audit } from "../_shared/outreach/supabase.ts";
import { unipile, unipileConfigured, unipileBase } from "../_shared/outreach/unipile.ts";
import { aiConfigured, AI_MODEL } from "../_shared/outreach/ai.ts";

const WEBHOOK_SECRET = Deno.env.get("UNIPILE_WEBHOOK_SECRET") ?? "";
const NAME = "capitalxai-outreach";

serve("unipile-setup", async (req) => {
  const user = await requireUser(req);
  const body = await readJson<{ workspace_id: string; action?: "status" | "register" }>(req);
  const m = await membership(user.id, body.workspace_id ?? "");
  requireRole(m, "owner");
  const status = {
    unipile: unipileConfigured(), unipile_dsn: unipileConfigured() ? unipileBase().replace(/^https?:\/\//, "") : null,
    webhook_secret: !!WEBHOOK_SECRET, cookie_key: !!Deno.env.get("OUTREACH_COOKIE_KEY"), cron_secret: !!Deno.env.get("OUTREACH_CRON_SECRET"),
    ai: aiConfigured(), ai_model: AI_MODEL, resend: !!Deno.env.get("RESEND_API_KEY"), stripe: !!Deno.env.get("STRIPE_SECRET_KEY"), stripe_webhook: !!Deno.env.get("STRIPE_WEBHOOK_SECRET"),
    webhook_url: `${FUNCTIONS_BASE}outreach-unipile-webhook`,
  };
  let webhooks: any[] = [];
  if (unipileConfigured()) {
    try { webhooks = (await unipile.webhooks.list()).items ?? []; } catch (e) { (status as any).unipile_error = String((e as any)?.message ?? e); }
  }
  const ours = webhooks.filter((w) => String(w.request_url ?? "").startsWith(status.webhook_url) || String(w.name ?? "").startsWith(NAME));
  if (body.action === "register") {
    if (!unipileConfigured()) throw new HttpError(503, "E_NOT_CONFIGURED", "Unipile not configured");
    if (!WEBHOOK_SECRET) throw new HttpError(503, "E_NOT_CONFIGURED", "UNIPILE_WEBHOOK_SECRET not set");
    const headers = [{ key: "Content-Type", value: "application/json" }, { key: "Unipile-Auth", value: WEBHOOK_SECRET }];
    const specs: Array<{ source: string; events?: string[] }> = [
      { source: "account_status", events: ["creation_success", "creation_fail", "deleted", "reconnected", "sync_success", "stopped", "ok", "connecting", "error", "credentials", "permissions"] },
      { source: "messaging", events: ["message_received", "message_edited", "message_deleted"] },
      { source: "users", events: ["new_relation"] },
      { source: "email", events: ["mail_received", "mail_sent"] },
      { source: "email_tracking", events: ["mail_opened", "mail_link_clicked"] },
    ];
    const created: string[] = [];
    for (const spec of specs) {
      const existing = ours.find((w) => w.source === spec.source);
      if (existing) continue;
      try {
        const r = await unipile.webhooks.create({ request_url: status.webhook_url, source: spec.source, events: spec.events, name: `${NAME}-${spec.source}`, headers, format: "json" });
        created.push(`${spec.source}:${r.webhook_id}`);
      } catch (e) { created.push(`${spec.source}:ERROR ${String((e as any)?.message ?? e)}`); }
    }
    await audit(body.workspace_id, "platform.webhooks_registered", "platform", null, { created }, "user");
    try { webhooks = (await unipile.webhooks.list()).items ?? []; } catch { /* ignore */ }
    return json({ ok: true, created, webhooks: webhooks.filter((w) => String(w.request_url ?? "").startsWith(status.webhook_url)), status });
  }
  return json({ status, webhooks: ours.map((w) => ({ id: w.id, source: w.source, events: w.events, request_url: w.request_url, enabled: w.enabled })) });
});
