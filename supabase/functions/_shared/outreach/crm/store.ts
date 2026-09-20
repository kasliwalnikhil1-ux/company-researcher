// Database side of the CRM sync (service role): encrypted tokens, the session that refreshes them, links, the sync log.
import { admin, rpc } from "../supabase.ts";
import { decrypt, encrypt } from "../crypto.ts";
import type { CrmLink, CrmSession, Integration, LogRow, MessageInfo, SyncStore } from "./engine.ts";
import type { IntegrationEvent, LastLog, StageInfo } from "./mapping.ts";
import { CrmError, type CrmLead, type CrmProvider, type CrmTokens } from "./types.ts";

// ---------------------------------------------------------------------------
// Tokens: encrypted with crypto.ts, stored only in outreach_integration_secrets
// ---------------------------------------------------------------------------
export async function saveTokens(integrationId: string, tokens: CrmTokens, extra: Record<string, unknown> = {}): Promise<void> {
  const row = {
    integration_id: integrationId,
    access_token_enc: await encrypt(tokens.access_token),
    refresh_token_enc: tokens.refresh_token ? await encrypt(tokens.refresh_token) : null,
    expires_at: tokens.expires_at,
    instance_url: tokens.instance_url,
    updated_at: new Date().toISOString(),
    ...extra,
  };
  const { error } = await admin.from("outreach_integration_secrets").upsert(row, { onConflict: "integration_id" });
  if (error) throw new Error(`could not store CRM tokens: ${error.message}`);
}

export async function loadTokens(integrationId: string): Promise<CrmTokens | null> {
  const { data, error } = await admin.from("outreach_integration_secrets").select("access_token_enc, refresh_token_enc, expires_at, instance_url").eq("integration_id", integrationId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.access_token_enc) return null;
  return {
    access_token: await decrypt(data.access_token_enc),
    refresh_token: data.refresh_token_enc ? await decrypt(data.refresh_token_enc) : null,
    expires_at: data.expires_at ?? null,
    instance_url: data.instance_url ?? null,
  };
}

/** Refreshes shortly before expiry, and once more on a 401. A second 401 (or a dead refresh token) surfaces as CrmError(kind auth). */
export function createSession(integrationId: string, provider: CrmProvider, initial: CrmTokens): CrmSession & { tokens(): CrmTokens } {
  let tokens = initial;
  const refresh = async () => {
    try { tokens = await provider.refresh(tokens); }
    catch (e) {
      if (e instanceof CrmError && (e.kind === "validation" || e.kind === "forbidden")) throw new CrmError(provider.name, "auth", e.status, e.message, e.body);
      throw e;
    }
    await saveTokens(integrationId, tokens);
  };
  return {
    tokens: () => tokens,
    async call<T>(fn: (t: CrmTokens) => Promise<T>): Promise<T> {
      if (tokens.expires_at && new Date(tokens.expires_at).getTime() - Date.now() < 90_000) await refresh();
      try { return await fn(tokens); }
      catch (e) {
        if (!(e instanceof CrmError) || e.kind !== "auth") throw e;
        await refresh();
        return await fn(tokens);
      }
    },
  };
}

export async function markAuthError(integrationId: string, message: string): Promise<void> {
  await admin.from("outreach_integrations").update({ status: "error", last_error: message.slice(0, 500) }).eq("id", integrationId);
}

export async function writeLog(integ: Pick<Integration, "id" | "workspace_id">, row: LogRow): Promise<void> {
  const { error } = await admin.from("outreach_crm_sync_log").insert({ integration_id: integ.id, workspace_id: integ.workspace_id, lead_id: row.lead_id, direction: row.direction, op: row.op, status: row.status, detail: row.detail.slice(0, 500) });
  if (error) console.error("crm sync log", error.message);
}

// ---------------------------------------------------------------------------
// SyncStore for one integration
// ---------------------------------------------------------------------------
const channelOf = (provider: string | null | undefined): "linkedin" | "email" => (provider && provider !== "LINKEDIN" ? "email" : "linkedin");

export function createStore(integ: Integration): SyncStore {
  const stageCache = new Map<string, StageInfo | null>();
  const attributionCache = new Map<string, Map<string, { sequence: string | null; step: number | null }>>();

  async function attribution(chatId: string, messageId: string): Promise<{ sequence: string | null; step: number | null }> {
    let byMessage = attributionCache.get(chatId);
    if (!byMessage) {
      byMessage = new Map();
      try {
        const rows = await rpc<any[]>("thread_attribution", { p_chat: chatId });
        for (const r of rows ?? []) byMessage.set(r.message_id, { sequence: r.kind === "automated" || r.kind === "inbound" ? r.sequence_name ?? null : null, step: r.step_number ?? null });
      } catch { /* attribution is a nicety: log the message without it */ }
      attributionCache.set(chatId, byMessage);
    }
    return byMessage.get(messageId) ?? { sequence: null, step: null };
  }

  function toInfo(m: any, chat: any, attr: { sequence: string | null; step: number | null }): MessageInfo {
    return { id: m.id, direction: m.direction === "in" ? "in" : "out", channel: channelOf(chat?.provider), text: m.text ?? "", subject: channelOf(chat?.provider) === "email" ? chat?.subject ?? null : null, at: m.sent_at, sequence: attr.sequence, step: attr.step };
  }

  return {
    async loadLead(leadId, withContext): Promise<CrmLead | null> {
      const { data: l } = await admin.from("outreach_leads").select("id, workspace_id, first_name, last_name, full_name, email_work, email_personal, title, company, profile_url, public_identifier, phone, location, headline, custom, stage_id").eq("id", leadId).maybeSingle();
      if (!l || l.workspace_id !== integ.workspace_id) return null;
      const stage = l.stage_id ? await this.stage(l.stage_id) : null;
      const lead: CrmLead = {
        id: l.id, first_name: l.first_name, last_name: l.last_name, full_name: l.full_name,
        email: l.email_work ?? l.email_personal ?? null, email_work: l.email_work ?? null, email_personal: l.email_personal ?? null,
        title: l.title, company: l.company, phone: l.phone ?? null, location: l.location, headline: l.headline,
        linkedin_url: l.profile_url ?? (l.public_identifier ? `https://www.linkedin.com/in/${l.public_identifier}` : null),
        stage: stage?.name ?? null, custom: l.custom ?? {},
      };
      if (withContext) {
        const { data: chat } = await admin.from("outreach_chats").select("intent").eq("lead_id", leadId).neq("intent", "unclassified").order("last_message_at", { ascending: false }).limit(1).maybeSingle();
        const { data: enr } = await admin.from("outreach_enrollments").select("outreach_sequences(name), outreach_senders(display_name)").eq("lead_id", leadId).order("created_at", { ascending: false }).limit(1).maybeSingle();
        lead.last_intent = chat?.intent ? String(chat.intent).replace(/_/g, " ") : null;
        lead.sequence_name = (enr as any)?.outreach_sequences?.name ?? null;
        lead.sender_name = (enr as any)?.outreach_senders?.display_name ?? null;
      }
      return lead;
    },

    shouldSync: (leadId) => rpc<boolean>("crm_should_sync", { p_integration: integ.id, p_lead: leadId }).then((v) => v === true),

    async getLink(leadId): Promise<CrmLink | null> {
      const { data } = await admin.from("outreach_crm_links").select("crm_contact_id, crm_company_id, crm_deal_id, last_synced_at").eq("integration_id", integ.id).eq("lead_id", leadId).maybeSingle();
      return (data as CrmLink | null) ?? null;
    },

    async saveLink(leadId, patch) {
      const { data: existing } = await admin.from("outreach_crm_links").select("lead_id").eq("integration_id", integ.id).eq("lead_id", leadId).maybeSingle();
      const { error } = existing
        ? await admin.from("outreach_crm_links").update(patch).eq("integration_id", integ.id).eq("lead_id", leadId)
        : await admin.from("outreach_crm_links").insert({ integration_id: integ.id, lead_id: leadId, ...patch });
      if (error) throw new Error(`could not store the CRM link: ${error.message}`);
    },

    async lastLog(leadId): Promise<LastLog | null> {
      const { data } = await admin.from("outreach_crm_sync_log").select("status, at").eq("integration_id", integ.id).eq("lead_id", leadId).order("at", { ascending: false }).limit(1).maybeSingle();
      return (data as LastLog | null) ?? null;
    },

    async lastDetail(leadId, op) {
      const { data } = await admin.from("outreach_crm_sync_log").select("detail").eq("integration_id", integ.id).eq("lead_id", leadId).eq("op", op).eq("status", "ok").order("at", { ascending: false }).limit(1).maybeSingle();
      return data?.detail ?? null;
    },

    async hasMarker(leadId, op, marker) {
      const { count } = await admin.from("outreach_crm_sync_log").select("id", { count: "exact", head: true }).eq("integration_id", integ.id).eq("lead_id", leadId).eq("op", op).eq("status", "ok").like("detail", `%${marker}%`);
      return (count ?? 0) > 0;
    },

    log: (row) => writeLog(integ, row),

    async resolveMessage(ev: IntegrationEvent): Promise<MessageInfo | null> {
      const p = ev.payload ?? {};
      const slack = new Date(new Date(ev.at).getTime() + 120_000).toISOString();
      let m: any = null;
      if (p.id) {
        m = (await admin.from("outreach_messages").select("id, chat_id, direction, text, sent_at").eq("id", p.id).is("deleted_at", null).maybeSingle()).data;
      } else {
        // the executor's events carry no message id: take the newest outbound message of that thread at the time of the event
        let chatIds: string[] = p.chat_id ? [p.chat_id] : [];
        if (!chatIds.length && p.lead_id && p.sender_id) {
          const { data: chats } = await admin.from("outreach_chats").select("id").eq("lead_id", p.lead_id).eq("sender_id", p.sender_id);
          chatIds = (chats ?? []).map((c: any) => c.id);
        }
        if (!chatIds.length) return null;
        m = (await admin.from("outreach_messages").select("id, chat_id, direction, text, sent_at").in("chat_id", chatIds).eq("direction", "out").is("deleted_at", null).lte("sent_at", slack).order("sent_at", { ascending: false }).limit(1).maybeSingle()).data;
      }
      if (!m) return null;
      const { data: chat } = await admin.from("outreach_chats").select("provider, subject").eq("id", m.chat_id).maybeSingle();
      return toInfo(m, chat, await attribution(m.chat_id, m.id));
    },

    async history(leadId, before, excludeId, limit) {
      const { data: chats } = await admin.from("outreach_chats").select("id, provider, subject").eq("lead_id", leadId).eq("workspace_id", integ.workspace_id);
      if (!chats?.length) return [];
      const byId = new Map(chats.map((c: any) => [c.id, c]));
      let query = admin.from("outreach_messages").select("id, chat_id, direction, text, sent_at").in("chat_id", [...byId.keys()]).is("deleted_at", null).lte("sent_at", before).order("sent_at", { ascending: false }).limit(limit + 1);
      if (excludeId) query = query.neq("id", excludeId);
      const { data } = await query;
      return (data ?? []).slice(0, limit).reverse().map((m: any) => toInfo(m, byId.get(m.chat_id), { sequence: null, step: null }));
    },

    async stage(stageId, kind) {
      const key = stageId ?? `kind:${kind}`;
      if (stageCache.has(key)) return stageCache.get(key) ?? null;
      let q = admin.from("outreach_stages").select("id, name, kind").eq("workspace_id", integ.workspace_id);
      q = stageId ? q.eq("id", stageId) : q.eq("kind", kind ?? "");
      const { data } = await q.order("position", { ascending: true }).limit(1).maybeSingle();
      const info = data ? { id: data.id, name: data.name, kind: data.kind ?? null } as StageInfo : null;
      stageCache.set(key, info);
      return info;
    },
  };
}
