// The push half of the sync: integration events → CRM writes. No env and no database imports here:
// the worker passes a store (database) and a session (tokens + refresh), the tests pass fakes.
import { activityTitle, effectiveMapping, leftoverNote, mappingNeedsContext, messageMarker, planEvent, resolveStage, shouldLogSkip, skipDetail, trimText, type IntegrationEvent, type LastLog, type PlannedOp, type StageInfo } from "./mapping.ts";
import { plainError } from "./http.ts";
import { CrmError, type CrmLead, type CrmProvider, type CrmTokens, type FieldMapping, type IntegrationSettings, type ProviderName, type StageMapping } from "./types.ts";

export interface Integration {
  id: string;
  workspace_id: string;
  provider: ProviderName;
  settings: IntegrationSettings;
  field_mapping: FieldMapping;
  stage_mapping: StageMapping;
  last_event_id: number;
}

export interface CrmLink { crm_contact_id: string | null; crm_company_id: string | null; crm_deal_id: string | null; last_synced_at: string | null }

export interface MessageInfo { id: string; direction: "out" | "in"; channel: "linkedin" | "email"; text: string; subject: string | null; at: string; sequence: string | null; step: number | null }

export type LogStatus = "ok" | "skipped" | "error";
export interface LogRow { lead_id: string | null; direction: "push" | "pull"; op: string; status: LogStatus; detail: string }

/** Everything the engine needs from the database, scoped to one integration. */
export interface SyncStore {
  loadLead(leadId: string, withContext: boolean): Promise<CrmLead | null>;
  shouldSync(leadId: string): Promise<boolean>;
  getLink(leadId: string): Promise<CrmLink | null>;
  saveLink(leadId: string, patch: Partial<CrmLink>): Promise<void>;
  lastLog(leadId: string): Promise<LastLog | null>;
  /** newest detail of one op for the lead (stage dedupe) */
  lastDetail(leadId: string, op: string): Promise<string | null>;
  /** true when a row of this op whose detail contains the marker exists for the lead */
  hasMarker(leadId: string, op: string, marker: string): Promise<boolean>;
  log(row: LogRow): Promise<void>;
  resolveMessage(ev: IntegrationEvent): Promise<MessageInfo | null>;
  history(leadId: string, before: string, excludeId: string | null, limit: number): Promise<MessageInfo[]>;
  stage(stageId: string | null, kind?: string): Promise<StageInfo | null>;
}

/** Runs a provider call with valid tokens; refreshes once on a 401 and throws CrmError(kind auth) when that does not help. */
export interface CrmSession { call<T>(fn: (tokens: CrmTokens) => Promise<T>): Promise<T> }

export interface EngineContext { integration: Integration; provider: CrmProvider; store: SyncStore; session: CrmSession; now?: () => Date }

export type EventOutcome = "synced" | "skipped_by_rule" | "ignored" | "failed";
export type StopReason = "auth" | "rate_limit" | "transient" | "time";

export interface BatchResult { lastEventId: number; synced: number; skipped: number; ignored: number; failed: number; stop: StopReason | null; error: string | null }

/** Contacts are refreshed at most this often unless the lead itself changed. */
export const CONTACT_FRESH_MS = 60 * 60_000;
const HISTORY_LIMIT = 15;

const stops = (e: unknown): e is CrmError => e instanceof CrmError && (e.kind === "auth" || e.kind === "rate_limit" || e.kind === "transient");
const label = (p: CrmProvider) => p.label;
const who = (l: CrmLead) => l.full_name ?? ([l.first_name, l.last_name].filter(Boolean).join(" ") || l.email || "lead");

interface RunState { allowed: Map<string, boolean>; ensured: Map<string, boolean> }

export function historyText(messages: MessageInfo[]): string {
  const lines = messages.map((m) => `[${m.at.slice(0, 16).replace("T", " ")}] ${m.direction === "in" ? "Received" : "Sent"} (${m.channel === "email" ? "email" : "LinkedIn"}): ${trimText(m.subject ? `${m.subject} | ${m.text}` : m.text, 400)}`);
  return trimText(lines.join("\n"), 6000);
}

export async function processEvent(ctx: EngineContext, ev: IntegrationEvent, state: RunState = { allowed: new Map(), ensured: new Map() }): Promise<EventOutcome> {
  const { integration: integ, provider, store, session } = ctx;
  const now = ctx.now ?? (() => new Date());
  const plan = planEvent(ev, integ.settings);
  if (!plan.leadId || plan.ops.length === 0) return "ignored";
  const leadId = plan.leadId;

  let allowed = state.allowed.get(leadId);
  if (allowed === undefined) { allowed = await store.shouldSync(leadId); state.allowed.set(leadId, allowed); }
  if (!allowed) {
    if (shouldLogSkip(await store.lastLog(leadId), now())) await store.log({ lead_id: leadId, direction: "push", op: "contact.upsert", status: "skipped", detail: skipDetail(integ.settings.sync_rule) });
    return "skipped_by_rule";
  }

  const mapping = effectiveMapping(integ.provider, integ.field_mapping, integ.settings);
  const lead = await store.loadLead(leadId, mappingNeedsContext(mapping));
  if (!lead) return "ignored";
  const wantsMessage = plan.ops.some((o) => o.op === "log_message");
  const message = wantsMessage ? await store.resolveMessage(ev) : null;
  let link = await store.getLink(leadId);
  let failed = false;

  const run = async (op: PlannedOp): Promise<void> => {
    switch (op.op) {
      case "ensure_contact": {
        const fresh = !!link?.crm_contact_id && !!link.last_synced_at && now().getTime() - new Date(link.last_synced_at).getTime() < CONTACT_FRESH_MS;
        const done = state.ensured.get(leadId);
        if (link?.crm_contact_id && (done === true || (done === false && !op.force) || (fresh && !op.force))) return;
        const firstLink = !link?.crm_contact_id;
        const res = await session.call((t) => provider.upsertContact(t, lead, { mapping, existing: { contactId: link?.crm_contact_id, companyId: link?.crm_company_id }, overwriteExisting: integ.settings.overwrite_existing === true, settings: integ.settings }));
        link = { crm_contact_id: res.contactId, crm_company_id: res.companyId ?? link?.crm_company_id ?? null, crm_deal_id: link?.crm_deal_id ?? null, last_synced_at: now().toISOString() };
        await store.saveLink(leadId, link);
        state.ensured.set(leadId, op.force);
        await store.log({ lead_id: leadId, direction: "push", op: "contact.upsert", status: "ok", detail: `${res.created ? "Created" : firstLink ? "Matched and updated" : "Updated"} ${who(lead)} in ${label(provider)}` });
        if (!firstLink) return;
        // first time this person is in the CRM through us: carry over what has no field, and the conversation so far
        if (Object.keys(res.leftover).length) {
          await session.call((t) => provider.logActivity(t, res.contactId, { note: true, title: "Outreach details", text: leftoverNote(res.leftover), direction: "out", channel: "linkedin", at: now().toISOString() }));
          await store.log({ lead_id: leadId, direction: "push", op: "note.create", status: "ok", detail: `Outreach details added as a note (${Object.keys(res.leftover).join(", ")} have no field in ${label(provider)})` });
        }
        if (integ.settings.log_messages !== false) {
          const past = await store.history(leadId, message?.at ?? ev.at, message?.id ?? null, HISTORY_LIMIT);
          if (past.length) {
            await session.call((t) => provider.logActivity(t, res.contactId, { note: true, title: `Conversation so far (${past.length} message${past.length === 1 ? "" : "s"})`, text: historyText(past), direction: "out", channel: past[0].channel, at: past[past.length - 1].at }));
            await store.log({ lead_id: leadId, direction: "push", op: "note.create", status: "ok", detail: `Conversation so far logged (${past.length} earlier message${past.length === 1 ? "" : "s"})` });
          }
        }
        return;
      }
      case "log_message": {
        if (!message || !link?.crm_contact_id) return;
        const marker = messageMarker(message.id);
        if (await store.hasMarker(leadId, "note.create", marker)) return;
        const activity = { direction: message.direction, channel: message.channel, text: trimText(message.text), subject: message.subject, at: message.at, sequence: message.sequence, step: message.step, dealId: link.crm_deal_id };
        const contactId = link.crm_contact_id;
        await session.call((t) => provider.logActivity(t, contactId, activity));
        await store.log({ lead_id: leadId, direction: "push", op: "note.create", status: "ok", detail: `${activityTitle(activity)} · ${marker}` });
        return;
      }
      case "set_stage": {
        if (!link?.crm_contact_id) return;
        // a workspace without a stage of that kind still gets the mapped move (meeting booked → "meeting")
        const stage = await store.stage(op.stageId, op.kind) ?? (op.kind ? { id: "", name: op.kind[0].toUpperCase() + op.kind.slice(1), kind: op.kind } : null);
        const target = resolveStage(stage, integ.provider, integ.stage_mapping);
        if (!stage || !target) return;
        if (!link.crm_deal_id) delete target.deal;
        if (!target.contact && !target.deal) return;
        const parts = [target.contact ? `person → ${target.contact}` : null, target.deal ? `deal → ${target.deal}` : null].filter(Boolean).join(", ");
        const detail = `Stage "${stage.name}": ${parts}`;
        if (await store.lastDetail(leadId, "stage.update") === detail) return; // lead.updated also fires on list changes
        const ids = { contactId: link.crm_contact_id, dealId: link.crm_deal_id };
        const done = await session.call((t) => provider.setStage(t, ids, target));
        if (done.contact || done.deal) await store.log({ lead_id: leadId, direction: "push", op: "stage.update", status: "ok", detail });
        return;
      }
      case "create_deal": {
        if (!link?.crm_contact_id || link.crm_deal_id) return;
        const stage = integ.settings.deal_stage ?? resolveStage({ id: "", name: "", kind: "interested" }, integ.provider, integ.stage_mapping)?.deal ?? null;
        const name = `${lead.company ? `${lead.company} - ` : ""}${who(lead)} (Outreach)`;
        const contactId = link.crm_contact_id, companyId = link.crm_company_id;
        const res = await session.call((t) => provider.createDeal(t, contactId, { name, stage, pipeline: integ.settings.deal_pipeline ?? null, amount: integ.settings.deal_amount ?? null, companyId }));
        link = { ...link, crm_deal_id: res.dealId };
        await store.saveLink(leadId, { crm_deal_id: res.dealId });
        await store.log({ lead_id: leadId, direction: "push", op: "deal.create", status: "ok", detail: `Deal "${name}" created because the reply was classified interested` });
        return;
      }
      case "note": {
        if (!link?.crm_contact_id) return;
        const marker = `evt:${ev.id}`;
        if (await store.hasMarker(leadId, "note.create", marker)) return;
        const contactId = link.crm_contact_id, dealId = link.crm_deal_id;
        await session.call((t) => provider.logActivity(t, contactId, { note: true, title: op.title, text: op.text, direction: "in", channel: "linkedin", at: ev.at, dealId }));
        await store.log({ lead_id: leadId, direction: "push", op: "note.create", status: "ok", detail: `${op.title} · ${marker}` });
        return;
      }
    }
  };

  const opName: Record<PlannedOp["op"], string> = { ensure_contact: "contact.upsert", log_message: "note.create", set_stage: "stage.update", create_deal: "deal.create", note: "note.create" };
  for (const op of plan.ops) {
    try { await run(op); }
    catch (e) {
      if (stops(e)) throw e; // the batch stops; this event is tried again on the next run
      const unsupported = e instanceof CrmError && e.kind === "unsupported";
      await store.log({ lead_id: leadId, direction: "push", op: opName[op.op], status: unsupported ? "skipped" : "error", detail: unsupported ? (e as CrmError).message : plainError(e) });
      if (!unsupported) failed = true;
      if (op.op === "ensure_contact") break; // nothing else can be written without the contact
    }
  }
  return failed ? "failed" : "synced";
}

/** Oldest first. `lastEventId` only moves past events that were handled, ignored on purpose, or failed for good (logged as error). */
export async function processBatch(ctx: EngineContext, events: IntegrationEvent[], deadline: number): Promise<BatchResult> {
  const out: BatchResult = { lastEventId: ctx.integration.last_event_id, synced: 0, skipped: 0, ignored: 0, failed: 0, stop: null, error: null };
  const state: RunState = { allowed: new Map(), ensured: new Map() };
  for (const ev of events) {
    if (Date.now() > deadline) { out.stop = "time"; break; }
    try {
      const r = await processEvent(ctx, ev, state);
      if (r === "synced") out.synced++; else if (r === "skipped_by_rule") out.skipped++; else if (r === "failed") out.failed++; else out.ignored++;
      out.lastEventId = ev.id;
    } catch (e) {
      if (stops(e)) { out.stop = e.kind as StopReason; out.error = plainError(e); break; }
      // a database hiccup or a bug: do not lose the event, stop and retry next run
      out.stop = "transient"; out.error = String((e as Error)?.message ?? e).slice(0, 300); break;
    }
  }
  return out;
}
