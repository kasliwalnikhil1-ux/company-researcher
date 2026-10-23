// Platform setup (localhost + platform admin only): check configuration and register the platform-level Unipile webhooks
// pointing at outreach-unipile-webhook. Deployment secrets and connector webhooks are operator concerns, so a workspace
// owner (a customer) is NOT enough: the caller's email must be in OUTREACH_PLATFORM_ADMIN_EMAILS (comma-separated;
// default nkjaipur21@gmail.com) AND the request must come from a localhost origin, i.e. the app running from a local
// checkout. The web app only renders the card on localhost (lib/outreach/platformAdmin.ts); this is the API-side mirror.
import { admin, json, serve, requireUser, membership, requireRole, readJson, HttpError, FUNCTIONS_BASE, audit } from "../_shared/outreach/supabase.ts";
import { unipile, unipileConfigured, unipileBase } from "../_shared/outreach/unipile.ts";
import { aiConfigured, platformAi } from "../_shared/outreach/ai.ts";
import { clearLlmCache, isLlmProvider, LLM_PROVIDERS, type LlmProvider } from "../_shared/outreach/llm.ts";

const MODEL_ID = /^[A-Za-z0-9._:\/-]{2,80}$/;

/**
 * Settings → Admin → AI provider: which platform key answers by default, and the model per provider. Written to the
 * flags `ai_platform_provider` (a provider name, or null = the environment / the first configured provider) and
 * `ai_platform_models` ({provider: model} overrides; an empty value goes back to the env default) and `ai_platform_reply_models`
 * (the same for the model that writes replies to prospects). Every function
 * instance picks the change up within 60 s (llm.ts caches the flags that long).
 */
async function setPlatformAi(input: { provider?: unknown; models?: unknown; reply_models?: unknown }): Promise<void> {
  const rows: Array<{ key: string; value: unknown }> = [];
  if ("provider" in input) {
    const p = input.provider == null || input.provider === "" ? null : String(input.provider).trim().toLowerCase();
    if (p !== null && !isLlmProvider(p)) throw new HttpError(400, "E_PAYLOAD_INVALID", `ai.provider must be one of: ${LLM_PROVIDERS.join(", ")}, or null`);
    rows.push({ key: "ai_platform_provider", value: p });
  }
  for (const [field, flag] of [["models", "ai_platform_models"], ["reply_models", "ai_platform_reply_models"]] as const) {
    const given = input[field];
    if (given === undefined) continue;
    if (!given || typeof given !== "object" || Array.isArray(given)) throw new HttpError(400, "E_PAYLOAD_INVALID", `ai.${field} must be an object of provider → model`);
    const { data } = await admin.from("outreach_flags").select("value").eq("key", flag).maybeSingle();
    const next: Record<string, string> = data?.value && typeof data.value === "object" && !Array.isArray(data.value) ? { ...(data.value as Record<string, string>) } : {};
    for (const [k, v] of Object.entries(given as Record<string, unknown>)) {
      if (!isLlmProvider(k)) throw new HttpError(400, "E_PAYLOAD_INVALID", `ai.${field}: unknown provider ${k}`);
      const m = String(v ?? "").trim();
      if (!m) { delete next[k as LlmProvider]; continue; }
      if (!MODEL_ID.test(m)) throw new HttpError(400, "E_PAYLOAD_INVALID", `ai.${field}.${k}: use the model id exactly as the provider writes it`);
      next[k] = m;
    }
    rows.push({ key: flag, value: next });
  }
  if (!rows.length) throw new HttpError(400, "E_PAYLOAD_INVALID", "ai.provider, ai.models or ai.reply_models required");
  const { error } = await admin.from("outreach_flags").upsert(rows, { onConflict: "key" });
  if (error) throw new HttpError(500, "E_INTERNAL", `could not save the AI settings: ${error.message}`);
  clearLlmCache();
}

const WEBHOOK_SECRET = Deno.env.get("UNIPILE_WEBHOOK_SECRET") ?? "";
const NAME = "capitalxai-outreach";
const PLATFORM_ADMIN_EMAILS = (Deno.env.get("OUTREACH_PLATFORM_ADMIN_EMAILS") ?? "nkjaipur21@gmail.com")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

function isLocalOrigin(req: Request): boolean {
  const src = req.headers.get("origin") || req.headers.get("referer") || "";
  try {
    const h = new URL(src).hostname.toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost");
  } catch { return false; }
}

serve("unipile-setup", async (req) => {
  const user = await requireUser(req);
  const body = await readJson<{ workspace_id: string; action?: "status" | "register" | "set_ai"; ai?: { provider?: unknown; models?: unknown; reply_models?: unknown } }>(req);
  const m = await membership(user.id, body.workspace_id ?? "");
  requireRole(m, "owner");
  if (!user.email || !PLATFORM_ADMIN_EMAILS.includes(user.email.trim().toLowerCase())) throw new HttpError(403, "E_FORBIDDEN", "platform admin required");
  if (!isLocalOrigin(req)) throw new HttpError(403, "E_FORBIDDEN", "platform setup is only available from a local checkout");
  if (body.action === "set_ai") {
    await setPlatformAi(body.ai ?? {});
    await audit(body.workspace_id, "platform.ai_provider_set", "platform", null, body.ai ?? null, "user");
  }
  const ai = await platformAi();
  const status = {
    unipile: unipileConfigured(), unipile_dsn: unipileConfigured() ? unipileBase().replace(/^https?:\/\//, "") : null,
    webhook_secret: !!WEBHOOK_SECRET, cookie_key: !!Deno.env.get("OUTREACH_COOKIE_KEY"), cron_secret: !!Deno.env.get("OUTREACH_CRON_SECRET"),
    ai: aiConfigured(), ai_model: ai.model, ai_provider: ai.provider, ai_source: ai.source, ai_wanted: ai.wanted, ai_fallback_reason: ai.fallback_reason,
    ai_providers: ai.configured, ai_models: ai.models, ai_default_models: ai.default_models, ai_reply_model: ai.reply_model, ai_reply_models: ai.reply_models, ai_default_reply_models: ai.default_reply_models,
    resend: !!Deno.env.get("RESEND_API_KEY"), stripe: !!Deno.env.get("STRIPE_SECRET_KEY"), stripe_webhook: !!Deno.env.get("STRIPE_WEBHOOK_SECRET"),
    webhook_url: `${FUNCTIONS_BASE}outreach-unipile-webhook`,
  };
  if (body.action === "set_ai") return json({ ok: true, status });
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
      { source: "messaging", events: ["message_received", "message_edited", "message_deleted", "message_reaction", "message_read", "message_delivered"] },
      { source: "users", events: ["new_relation"] },
      { source: "email", events: ["mail_received", "mail_sent"] },
      { source: "email_tracking", events: ["mail_opened", "mail_link_clicked"] },
    ];
    const created: string[] = [];
    for (const spec of specs) {
      const existing = ours.find((w) => w.source === spec.source);
      if (existing) {
        // a webhook registered before new events were added (reactions / read receipts) is replaced so it carries them all
        const have: string[] = Array.isArray(existing.events) ? existing.events.map(String) : [];
        const missing = (spec.events ?? []).filter((ev) => !have.includes(ev));
        if (!missing.length || !existing.id) continue;
        try { await unipile.webhooks.delete(String(existing.id)); created.push(`${spec.source}:replaced (added ${missing.join(", ")})`); }
        catch (e) { created.push(`${spec.source}:ERROR replacing ${String((e as any)?.message ?? e)}`); continue; }
      }
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
