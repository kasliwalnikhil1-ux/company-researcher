// Item 14 / 26 — workspace keys: the workspace's own LLM key, email-finder keys, email verifier key.
// POST (user JWT, manager): {workspace_id, llm?: {provider, model?, key?} | null, finders?: [{provider, key?}], verifier?: {provider, key?, url?} | null}
//   - a part that is left out is not touched; `llm: null`, `verifier: null` or `key: ""` removes that key
//   - `finders` replaces the whole ordered list; an entry without `key` keeps the key already saved for that provider
//   - `ensure: true` makes sure the secrets row exists (it carries the booking webhook secret) and changes nothing else
//   - an LLM key is proven with one tiny call before it is saved (E_AI_KEY_INVALID carries the provider's own message)
// Errors: HTTP 4xx {code, message, error}, e.g. code E_AI_KEY_INVALID with the provider's message.
// Keys are AES-GCM encrypted (crypto.ts), stored in outreach_workspace_secrets (service only) and never returned: only the last 4 characters.
import { admin, json, serve, requireUser, membership, requireRole, readJson, HttpError, rateLimit, errorResponse } from "../_shared/outreach/supabase.ts";
import { encrypt, decrypt } from "../_shared/outreach/crypto.ts";
import { llmTestKey, clearLlmCache, LLM_PROVIDERS, DEFAULT_MODELS, type LlmProvider } from "../_shared/outreach/llm.ts";

type Row = Record<string, any>;
const FINDERS = ["hunter", "prospeo", "findymail"];
const VERIFIERS = ["zerobounce", "reacher"];

const hint = (key: string) => key.slice(-4);
function cleanKey(value: unknown, what: string): string {
  const key = String(value ?? "").trim();
  if (key.length < 8 || key.length > 400 || /\s/.test(key)) throw new HttpError(400, "E_PAYLOAD_INVALID", `${what}: that does not look like an API key`);
  return key;
}
const pick = (provider: unknown, allowed: string[], what: string): string => {
  const p = String(provider ?? "").trim().toLowerCase();
  if (!allowed.includes(p)) throw new HttpError(400, "E_PAYLOAD_INVALID", `${what} must be one of: ${allowed.join(", ")}`);
  return p;
};

/** What the settings screen may see. Same shape as outreach_workspace_ai_settings, without the booking secret. Never a key. */
function publicView(r: Row): Row {
  return {
    llm_provider: r.llm_key_enc ? r.llm_provider : "platform", llm_model: r.llm_key_enc ? r.llm_model : null, llm_key_hint: r.llm_key_enc ? r.llm_key_hint : null, uses_own_key: !!r.llm_key_enc,
    finders: (Array.isArray(r.finder_keys) ? r.finder_keys : []).map((f: Row) => ({ provider: f.provider, hint: f.hint ?? null })),
    verifier: r.verifier ? { provider: r.verifier.provider, hint: r.verifier.hint ?? null } : null,
  };
}

/** Same mapping as errorResponse(), plus `message` next to `error`: the settings screen reads {code, message}. */
async function withMessage(run: () => Promise<Response>): Promise<Response> {
  try { return await run(); } catch (e) {
    const res = errorResponse(e);
    const b = await res.json();
    return json({ ...b, message: b.error }, res.status);
  }
}

serve("workspace-secrets", (req) => withMessage(async () => {
  if (req.method !== "POST") throw new HttpError(405, "E_PAYLOAD_INVALID", "POST only");
  const user = await requireUser(req);
  const body = await readJson<Row>(req);
  const ws = String(body.workspace_id ?? "");
  if (!ws) throw new HttpError(400, "E_PAYLOAD_INVALID", "workspace_id required");
  const m = await membership(user.id, ws); requireRole(m, "manager");
  await rateLimit("workspace_secrets:" + user.id, 30, 3600);   // every LLM save makes a provider call

  const { data: existing, error: readErr } = await admin.from("outreach_workspace_secrets").select("llm_provider, llm_model, llm_key_enc, llm_key_hint, finder_keys, verifier").eq("workspace_id", ws).maybeSingle();
  if (readErr) throw new HttpError(500, "E_INTERNAL", readErr.message);
  const next: Row = { llm_provider: existing?.llm_provider ?? null, llm_model: existing?.llm_model ?? null, llm_key_enc: existing?.llm_key_enc ?? null, llm_key_hint: existing?.llm_key_hint ?? null, finder_keys: Array.isArray(existing?.finder_keys) ? existing!.finder_keys : [], verifier: existing?.verifier ?? null };
  const changed: Row = {};

  // ---- LLM -------------------------------------------------------------
  if (body.llm !== undefined) {
    const llm = body.llm as Row | null;
    if (llm === null || llm.key === "") {
      Object.assign(next, { llm_provider: null, llm_model: null, llm_key_enc: null, llm_key_hint: null });
      changed.llm = { removed: !!existing?.llm_key_enc };
    } else {
      const provider = pick(llm.provider, LLM_PROVIDERS, "llm.provider") as LlmProvider;
      const model = String(llm.model ?? "").trim().slice(0, 100) || DEFAULT_MODELS[provider];
      if (!/^[A-Za-z0-9._:\/-]+$/.test(model)) throw new HttpError(400, "E_PAYLOAD_INVALID", "llm.model has characters a model id cannot contain");
      let key: string;
      if (llm.key === undefined || llm.key === null) {
        // model change only: keep the saved key, which must belong to the same provider
        if (!existing?.llm_key_enc || existing.llm_provider !== provider) throw new HttpError(400, "E_PAYLOAD_INVALID", "llm.key required");
        try { key = await decrypt(existing.llm_key_enc); } catch { throw new HttpError(400, "E_AI_KEY_INVALID", "The saved key cannot be read any more. Enter the key again."); }
      } else key = cleanKey(llm.key, "llm.key");
      await llmTestKey({ provider, model, key });   // throws E_AI_KEY_INVALID (provider's message) or E_AI_UNAVAILABLE
      Object.assign(next, { llm_provider: provider, llm_model: model, llm_key_enc: await encrypt(key), llm_key_hint: hint(key) });
      changed.llm = { provider, model, key_hint: hint(key) };
    }
  }

  // ---- email finders (ordered: tried first to last) ---------------------
  if (body.finders !== undefined) {
    if (!Array.isArray(body.finders) || body.finders.length > FINDERS.length) throw new HttpError(400, "E_PAYLOAD_INVALID", `finders must be a list of at most ${FINDERS.length} providers`);
    const saved = new Map<string, Row>((next.finder_keys as Row[]).map((f) => [String(f.provider), f]));
    const list: Row[] = [];
    for (const f of body.finders as Row[]) {
      const provider = pick(f?.provider, FINDERS, "finders[].provider");
      if (list.some((x) => x.provider === provider)) throw new HttpError(400, "E_PAYLOAD_INVALID", `${provider} is listed twice`);
      if (f.key === "") continue;                                  // removed
      if (f.key === undefined || f.key === null) {                 // kept (re-ordered)
        const old = saved.get(provider);
        if (!old?.key_enc) throw new HttpError(400, "E_PAYLOAD_INVALID", `finders: a key is required for ${provider}`);
        list.push({ provider, key_enc: old.key_enc, hint: old.hint ?? null });
      } else {
        const key = cleanKey(f.key, `finders: ${provider}`);
        list.push({ provider, key_enc: await encrypt(key), hint: hint(key) });
      }
    }
    next.finder_keys = list;
    changed.finders = list.map((f) => ({ provider: f.provider, key_hint: f.hint }));
  }

  // ---- email verifier ---------------------------------------------------
  if (body.verifier !== undefined) {
    const v = body.verifier as Row | null;
    if (v === null || v.key === "") {
      next.verifier = null;
      changed.verifier = { removed: !!existing?.verifier };
    } else {
      const provider = pick(v.provider, VERIFIERS, "verifier.provider");
      let url: string | null = null;
      if (v.url != null && String(v.url).trim()) {                 // self-hosted Reacher
        if (provider !== "reacher") throw new HttpError(400, "E_PAYLOAD_INVALID", "verifier.url is only for a self-hosted Reacher");
        try { const u = new URL(String(v.url).trim()); if (u.protocol !== "https:") throw new Error(); url = u.origin + u.pathname.replace(/\/+$/, ""); } catch { throw new HttpError(400, "E_PAYLOAD_INVALID", "verifier.url must be an https address"); }
      }
      const old = existing?.verifier as Row | null;
      let keyEnc: string, keyHint: string | null;
      if (v.key === undefined || v.key === null) {
        if (!old?.key_enc || old.provider !== provider) throw new HttpError(400, "E_PAYLOAD_INVALID", "verifier.key required");
        keyEnc = old.key_enc; keyHint = old.hint ?? null;
      } else { const key = cleanKey(v.key, "verifier.key"); keyEnc = await encrypt(key); keyHint = hint(key); }
      next.verifier = { provider, key_enc: keyEnc, hint: keyHint, ...(url ? { url } : {}) };
      changed.verifier = { provider, key_hint: keyHint, ...(url ? { url } : {}) };
    }
  }

  if (!Object.keys(changed).length) {
    if (body.ensure && !existing) {
      const { error: insErr } = await admin.from("outreach_workspace_secrets").upsert({ workspace_id: ws }, { onConflict: "workspace_id", ignoreDuplicates: true });
      if (insErr) throw new HttpError(500, "E_INTERNAL", insErr.message);
    }
    return json({ ok: true, changed: false, settings: publicView(next) });
  }

  const { error: upErr } = await admin.from("outreach_workspace_secrets").upsert({ workspace_id: ws, ...next, updated_at: new Date().toISOString() }, { onConflict: "workspace_id" });
  if (upErr) throw new HttpError(500, "E_INTERNAL", upErr.message);
  clearLlmCache(ws);   // this instance switches at once; other warm instances follow within 60 s

  // The audit entry names providers, models and the last 4 characters. Never a key.
  try { await admin.from("outreach_audit_log").insert({ workspace_id: ws, actor: user.id, actor_type: "user", action: "workspace.ai_settings", entity: "workspace", entity_id: ws, diff: changed }); } catch { /* ignore */ }

  return json({ ok: true, changed: true, settings: publicView(next) });
}));
