// Custom sending domains (custom-sending-domain-PRD.md §4, §5.4–§5.6, §9): the F56 actions and the F59 worker.
//   create · verify · update (identity, branding) · test · activate · pause · resume · remove · email_records · dmarc
//   verifyTick   every 10 min while a domain is verifying (72 h), then hourly (7 days); after 7 days: failed + email
//   dailyRun     health (bounces, complaints, records), warm-up caps, plan pauses, 30-day removals, retention
//   onDomainEvent  Resend's domain.updated / domain.deleted (§5.4)
import { admin, log, rpc, audit, WEB_ORIGIN, emitEvent } from "./supabase.ts";
import { encrypt } from "./crypto.ts";
import { resendDomains, resendApiKeys, dmarcLookup, normaliseRecords, stateForResendStatus, recordVisible, registrableRoot, ResendError, type DnsRecord } from "./resend_domains.ts";
import { sendEmail, sendTeamEmail, PLATFORM_NAME } from "./email.ts";
import { layout, esc, button, workspaceBranding } from "./notify.ts";

type Row = Record<string, any>;

export class DomainError extends Error { constructor(public code: string, message: string, public status = 409) { super(message); } }

async function load(id: string): Promise<Row> {
  const { data } = await admin.from("outreach_sending_domains").select("*").eq("id", id).maybeSingle();
  if (!data || data.state === "removed") throw new DomainError("E_NOT_FOUND", "domain not found", 404);
  return data;
}

async function patch(id: string, p: Row): Promise<Row> {
  const { data, error } = await admin.from("outreach_sending_domains").update({ ...p, updated_at: new Date().toISOString() }).eq("id", id).select("*").single();
  if (error) throw new DomainError("E_INTERNAL", error.message, 500);
  return data;
}

/** The public shape of a domain row (no key ids). */
export function view(d: Row): Row {
  const { resend_api_key_id: _k, ...rest } = d;
  return { ...rest, from_address: `${d.from_local_part}@${d.domain}` };
}

// ---------------------------------------------------------------------------
// §4.1 step 2: create on Resend + the domain-scoped key
// ---------------------------------------------------------------------------
export async function createDomain(wsId: string, userId: string, input: { domain: string; client_id?: string | null; region?: string | null }): Promise<Row> {
  const domain = String(input.domain ?? "").trim().toLowerCase();
  const check = await rpc<Row>("sending_domain_check", { p_ws: wsId, p_domain: domain, p_client: input.client_id ?? null });
  if (!check?.ok) throw new DomainError("E_PAYLOAD_INVALID", (check?.errors ?? ["Invalid domain"]).join(" "), 400);
  const { data: ws } = await admin.from("outreach_workspaces").select("name, settings").eq("id", wsId).maybeSingle();
  const region = input.region === "us-east-1" || (ws?.settings?.data_region === "us" && !input.region) ? "us-east-1" : "eu-west-1";
  let rd: Row;
  try { rd = await resendDomains.create(domain, region); }
  catch (e) {
    if (e instanceof ResendError && /already exists|already registered/i.test(e.body)) throw new DomainError("E_CONFLICT", "This domain is already registered with our email provider. Contact support.");
    throw new DomainError("E_PROVIDER", `The email provider refused the domain: ${(e as Error).message}`, 502);
  }
  let key: { id: string; token: string };
  try { key = await resendApiKeys.createForDomain(`ws:${wsId}:${domain}`, String(rd.id)); }
  catch (e) { await resendDomains.delete(String(rd.id)).catch(() => null); throw new DomainError("E_PROVIDER", `The email provider could not create the sending key: ${(e as Error).message}`, 502); }
  const { data: row, error } = await admin.from("outreach_sending_domains").insert({
    workspace_id: wsId, client_id: input.client_id ?? null, domain, resend_domain_id: String(rd.id), resend_api_key_id: key.id, region, state: "verifying",
    resend_status: rd.status ?? "not_started", records: normaliseRecords(rd.records), from_name: input.client_id ? (await clientName(input.client_id)) : ws?.name ?? null, created_by: userId,
  }).select("*").single();
  if (error) { await resendApiKeys.delete(key.id).catch(() => null); await resendDomains.delete(String(rd.id)).catch(() => null); throw new DomainError("E_INTERNAL", error.message, 500); }
  await admin.from("outreach_sending_domain_keys").insert({ sending_domain_id: row.id, api_key_enc: await encrypt(key.token) });
  const dm = await dmarcLookup(domain).catch(() => null);
  if (dm) await patch(row.id, { dmarc_found: dm.found });
  await audit(wsId, "sending_domain.created", "sending_domain", row.id, { domain, region, client_id: input.client_id ?? null }, "user");
  await emitEvent(wsId, "sending_domain.created", { id: row.id, domain });
  return view({ ...row, dmarc_found: dm?.found ?? null, warnings: check.warnings ?? [] });
}

async function clientName(clientId: string): Promise<string | null> {
  const { data } = await admin.from("outreach_clients").select("name").eq("id", clientId).maybeSingle();
  return data?.name ?? null;
}

// ---------------------------------------------------------------------------
// §4.1 step 4: verify (Check now, the worker, the webhook)
// ---------------------------------------------------------------------------
export async function refreshDomain(id: string, opts: { verify?: boolean; source?: string } = {}): Promise<Row> {
  const d = await load(id);
  if (!d.resend_domain_id) return view(d);
  if (opts.verify) { try { await resendDomains.verify(d.resend_domain_id); } catch (e) { log({ fn: "sending-domain", warn: "verify call failed", domain: d.domain, error: String(e) }); } }
  let rd: Row;
  try { rd = await resendDomains.get(d.resend_domain_id); }
  catch (e) {
    if (e instanceof ResendError && e.status === 404) return onDomainDeleted(d, "missing on the provider");
    throw e;
  }
  const records = normaliseRecords(rd.records);
  // a provider that appended the domain to the host name shows as "not found" on public DNS; the hint goes on the record
  for (const r of records) if (r.status !== "verified") { const vis = await recordVisible(r).catch(() => null); if (vis === false) (r as Row).hint = "not_found_public_dns"; }
  const identity = !!d.reply_to;
  const before = d.state;
  const state = stateForResendStatus(rd.status, identity, d.state);
  const p: Row = { resend_status: rd.status ?? d.resend_status, records, last_checked_at: new Date().toISOString() };
  if (state === "ready" && before !== "active" && before !== "ready") { p.state = "ready"; p.verified_at = d.verified_at ?? new Date().toISOString(); }
  else if (state === "failed" && before === "active") { p.paused_at = d.paused_at ?? new Date().toISOString(); p.paused_reason = d.paused_reason ?? "dns"; p.paused_detail = missingRecordText(records); }
  else if (state === "failed") { p.state = "failed"; p.failed_at = d.failed_at ?? new Date().toISOString(); }
  else if (state === "active" && before === "active" && d.paused_reason === "dns" && String(rd.status).toLowerCase() === "verified") { /* fixed: the owner presses Resume */ }
  else if (state === "verifying") p.state = before === "setup" ? "verifying" : before;
  const after = await patch(id, p);
  if (p.state === "ready" && before !== "ready") {
    await statusEmail(after, "verified");
    await audit(d.workspace_id, "sending_domain.verified", "sending_domain", id, { domain: d.domain, source: opts.source ?? "check" }, "system");
  } else if ((p.paused_at && !d.paused_at) || (p.state === "failed" && before !== "failed")) {
    await rpc("email_outbox_reroute", { p_domain: id }).catch(() => null);
    await statusEmail(after, p.paused_at ? "paused" : "failed");
    await audit(d.workspace_id, p.paused_at ? "sending_domain.paused" : "sending_domain.failed", "sending_domain", id, { domain: d.domain, reason: p.paused_reason ?? "dns", source: opts.source ?? "check" }, "system");
  }
  return view(after);
}

function missingRecordText(records: DnsRecord[]): string {
  const bad = records.filter((r) => r.status !== "verified").map((r) => `${r.record} (${r.type} ${r.name})`);
  return bad.length ? `Missing or wrong: ${bad.join(", ")}` : "A DNS record is no longer found";
}

// ---------------------------------------------------------------------------
// §4.1 steps 5–7: identity, test, turn on
// ---------------------------------------------------------------------------
export async function updateIdentity(id: string, userId: string, input: Row): Promise<Row> {
  const d = await load(id);
  const p: Row = {};
  if (input.from_name !== undefined) p.from_name = String(input.from_name ?? "").replace(/["<>\r\n]/g, "").trim().slice(0, 80) || null;
  if (input.from_local_part !== undefined) {
    const lp = String(input.from_local_part ?? "").trim().toLowerCase();
    if (!/^[a-z0-9._-]{1,64}$/.test(lp)) throw new DomainError("E_PAYLOAD_INVALID", "The part before @ may only use letters, numbers, dots, dashes and underscores", 400);
    p.from_local_part = lp;
  }
  if (input.reply_to !== undefined) {
    const rt = String(input.reply_to ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rt)) throw new DomainError("E_PAYLOAD_INVALID", "Reply-to must be a real address you read", 400);
    p.reply_to = rt;
  }
  if (input.branding !== undefined && input.branding && typeof input.branding === "object") {
    const b = input.branding as Row;
    p.branding = { ...(d.branding ?? {}), ...(b.logo_path !== undefined ? { logo_path: b.logo_path || null } : {}), ...(b.accent !== undefined ? { accent: /^#[0-9a-fA-F]{6}$/.test(String(b.accent ?? "")) ? b.accent : null } : {}), ...(b.footer !== undefined ? { footer: String(b.footer ?? "").slice(0, 300) || null } : {}) };
  }
  const after = await patch(id, p);
  await audit(d.workspace_id, "sending_domain.updated", "sending_domain", id, p, "user");
  void userId;
  return view(after);
}

export async function sendTest(id: string, to: string, userId: string): Promise<Row> {
  const d = await load(id);
  if (!d.reply_to) throw new DomainError("E_CONFLICT", "Set the reply-to address first");
  if (d.state !== "ready" && d.state !== "active") throw new DomainError("E_CONFLICT", "The domain is not verified yet");
  const branding = await workspaceBranding(d.workspace_id);
  const html = layout("Test email from your sending domain", `<p>This is a test from <b>${esc(d.from_local_part)}@${esc(d.domain)}</b>. If you are reading it, the domain works.</p><p>Replies go to ${esc(d.reply_to)}.</p>`, branding, { audience: "client" });
  // a direct send with this domain's key, whatever the state (ready is enough for a test)
  const { data: k } = await admin.from("outreach_sending_domain_keys").select("api_key_enc").eq("sending_domain_id", id).maybeSingle();
  if (!k) throw new DomainError("E_CONFLICT", "The sending key is missing; remove the domain and add it again");
  const r = await sendEmail({ type: "sending_domain_test", to, subject: `Test from ${d.domain}`, html, workspace_id: d.workspace_id, client_id: d.client_id, direct: true, idempotency_key: `sending_domain_test:${id}:${Date.now()}`, data: { by: userId } });
  await audit(d.workspace_id, "sending_domain.test", "sending_domain", id, { to, status: r.status, from: r.from, fell_back: r.fell_back }, "user");
  return { ok: r.status === "sent", outbox_id: r.outbox_id, from: r.from, fell_back: r.fell_back, error: r.reason ?? null };
}

export async function activate(id: string, userId: string): Promise<Row> {
  const d = await load(id);
  if (d.state !== "ready") throw new DomainError("E_CONFLICT", d.state === "active" ? "The domain is already on" : "Verify the DNS records first");
  if (!d.reply_to) throw new DomainError("E_CONFLICT", "Set the reply-to address first");
  const after = await patch(id, { state: "active", activated_at: new Date().toISOString(), warmup_started_at: d.warmup_started_at ?? new Date().toISOString(), daily_cap: 50, paused_at: null, paused_reason: null, paused_detail: null });
  await audit(d.workspace_id, "sending_domain.activated", "sending_domain", id, { domain: d.domain }, "user");
  await emitEvent(d.workspace_id, "sending_domain.activated", { id, domain: d.domain });
  void userId;
  return view(after);
}

export async function pause(id: string, userId: string, note?: string): Promise<Row> {
  const d = await load(id);
  const after = await patch(id, { paused_at: new Date().toISOString(), paused_reason: "manual", paused_detail: note?.slice(0, 300) ?? null });
  await rpc("email_outbox_reroute", { p_domain: id }).catch(() => null);
  await audit(d.workspace_id, "sending_domain.paused", "sending_domain", id, { reason: "manual", by: userId }, "user");
  return view(after);
}

/** Resume after the cause is fixed (§5.5): a DNS pause re-verifies first; a revoked key gets a new key; bounces / complaints need a note. */
export async function resume(id: string, userId: string, note?: string): Promise<Row> {
  let d = await load(id);
  if (!d.paused_at) return view(d);
  if (d.paused_reason === "plan") throw new DomainError("E_PLAN_REQUIRED", "The plan does not include a sending domain", 402);
  if (d.paused_reason === "dns" || d.paused_reason === "send_error") {
    d = await load((await refreshDomain(id, { verify: true, source: "resume" })).id);
    if (String(d.resend_status).toLowerCase() !== "verified") throw new DomainError("E_CONFLICT", `The DNS records are still not verified (${d.resend_status}). Fix them, then resume.`);
    if (d.paused_reason === "send_error" && /key|unauthor|restricted/i.test(String(d.paused_detail ?? ""))) {
      // the key was revoked on the provider: make a new one
      const key = await resendApiKeys.createForDomain(`ws:${d.workspace_id}:${d.domain}:${Date.now()}`, String(d.resend_domain_id));
      await admin.from("outreach_sending_domain_keys").upsert({ sending_domain_id: id, api_key_enc: await encrypt(key.token), created_at: new Date().toISOString() });
      if (d.resend_api_key_id) await resendApiKeys.delete(d.resend_api_key_id).catch(() => null);
      await patch(id, { resend_api_key_id: key.id });
    }
  } else if ((d.paused_reason === "bounces" || d.paused_reason === "complaints") && !String(note ?? "").trim()) {
    throw new DomainError("E_PAYLOAD_INVALID", "Say what was fixed before resuming after bounces or complaints", 400);
  }
  const after = await patch(id, { paused_at: null, paused_reason: null, paused_detail: null, state: d.state === "failed" ? "active" : d.state });
  await audit(d.workspace_id, "sending_domain.resumed", "sending_domain", id, { was: d.paused_reason, note: note ?? null, by: userId }, "user");
  return view(after);
}

export async function removeDomain(id: string, userId: string | null, reason = "removed by the customer"): Promise<Row> {
  const d = await load(id);
  if (d.resend_api_key_id) await resendApiKeys.delete(d.resend_api_key_id).catch((e) => log({ fn: "sending-domain", warn: "key delete", error: String(e) }));
  if (d.resend_domain_id) await resendDomains.delete(d.resend_domain_id).catch((e) => log({ fn: "sending-domain", warn: "domain delete", error: String(e) }));
  await admin.from("outreach_sending_domain_keys").delete().eq("sending_domain_id", id);
  const after = await patch(id, { state: "removed", removed_at: new Date().toISOString(), paused_at: null, paused_reason: null });
  await rpc("email_outbox_reroute", { p_domain: id }).catch(() => null);
  await audit(d.workspace_id, "sending_domain.removed", "sending_domain", id, { domain: d.domain, reason, by: userId }, userId ? "user" : "system");
  await emitEvent(d.workspace_id, "sending_domain.removed", { id, domain: d.domain });
  return view(after);
}

/** domain.deleted from Resend (deleted outside the app): row removed, owners told (§9). */
export async function onDomainDeleted(d: Row, how: string): Promise<Row> {
  await admin.from("outreach_sending_domain_keys").delete().eq("sending_domain_id", d.id);
  const after = await patch(d.id, { state: "removed", removed_at: new Date().toISOString() });
  await rpc("email_outbox_reroute", { p_domain: d.id }).catch(() => null);
  await statusEmail(after, "deleted");
  await audit(d.workspace_id, "sending_domain.removed", "sending_domain", d.id, { domain: d.domain, reason: how }, "system");
  return view(after);
}

/** Resend domain webhooks (§5.4). */
export async function onDomainEvent(type: string, payload: Row): Promise<Row> {
  const resendId = String(payload?.id ?? payload?.domain_id ?? "");
  if (!resendId) return { ok: false, reason: "no id" };
  const { data: d } = await admin.from("outreach_sending_domains").select("*").eq("resend_domain_id", resendId).neq("state", "removed").maybeSingle();
  if (!d) return { ok: false, reason: "unknown domain" };
  if (type === "domain.deleted") return { ok: true, domain: await onDomainDeleted(d, "deleted on the provider") };
  return { ok: true, domain: await refreshDomain(d.id, { source: "webhook" }) };
}

// ---------------------------------------------------------------------------
// §4.1 step 3: the records emailed to an IT person; §4.2 DMARC
// ---------------------------------------------------------------------------
export async function emailRecords(id: string, to: string, userId: string): Promise<Row> {
  const d = await load(id);
  const branding = await workspaceBranding(d.workspace_id);
  const rows = ((d.records ?? []) as DnsRecord[]).map((r) => `<tr><td style="padding:6px 8px;border-top:1px solid #eee">${esc(r.record)}</td><td style="padding:6px 8px;border-top:1px solid #eee">${esc(r.type)}</td><td style="padding:6px 8px;border-top:1px solid #eee;font-family:monospace;font-size:12px">${esc(r.name)}</td><td style="padding:6px 8px;border-top:1px solid #eee;font-family:monospace;font-size:12px;word-break:break-all">${esc(r.value)}</td><td style="padding:6px 8px;border-top:1px solid #eee">${r.priority ?? ""}</td></tr>`).join("");
  const html = layout(`DNS records for ${esc(d.domain)}`, `<p>Please add these records to the DNS of <b>${esc(d.domain)}</b> so ${esc(branding.workspace_name ?? "our")} notification emails can be sent from it.</p>
    <table style="border-collapse:collapse;width:100%;font-size:13px"><thead><tr><th style="text-align:left;padding:6px 8px">Record</th><th style="text-align:left;padding:6px 8px">Type</th><th style="text-align:left;padding:6px 8px">Host</th><th style="text-align:left;padding:6px 8px">Value</th><th style="text-align:left;padding:6px 8px">Priority</th></tr></thead><tbody>${rows}</tbody></table>
    <p style="font-size:12px;color:#666;margin-top:12px">Most common mistake: some providers add the domain to the host name automatically, which gives <code>send.${esc(d.domain)}.${esc(d.domain)}</code>. If your provider does that, enter only the part before <code>.${esc(registrableRoot(d.domain))}</code>.</p>
    <p style="font-size:12px;color:#666">Gmail and Yahoo also expect a DMARC record on <code>_dmarc.${esc(registrableRoot(d.domain))}</code> (a TXT with <code>v=DMARC1; p=none</code> is enough to start).</p>`, branding, { audience: "team", width: 720 });
  const r = await sendEmail({ type: "sending_domain_records", to, subject: `DNS records for ${d.domain}`, html, workspace_id: d.workspace_id, idempotency_key: `sending_domain_records:${id}:${to}:${Date.now()}`, data: { by: userId } });
  await audit(d.workspace_id, "sending_domain.records_emailed", "sending_domain", id, { to }, "user");
  return { ok: r.status !== "failed" && r.status !== "skipped" };
}

export async function checkDmarc(id: string): Promise<Row> {
  const d = await load(id);
  const dm = await dmarcLookup(d.domain);
  await patch(id, { dmarc_found: dm.found });
  return { ...dm, root: registrableRoot(d.domain) };
}

async function statusEmail(d: Row, what: "verified" | "paused" | "failed" | "deleted"): Promise<void> {
  const branding = await workspaceBranding(d.workspace_id);
  const url = `${WEB_ORIGIN}/outreach/settings/email-sending`;
  const subject = what === "verified" ? `${d.domain} is verified` : what === "paused" ? `Emails from ${d.domain} are paused` : what === "failed" ? `${d.domain} could not be verified` : `${d.domain} was removed`;
  const body = what === "verified" ? `<p>The DNS records of <b>${esc(d.domain)}</b> are verified. Fill in the sender identity and press <b>Turn on</b> to send from it.</p>`
    : what === "paused" ? `<p>A DNS record of <b>${esc(d.domain)}</b> is no longer found (${esc(d.paused_detail ?? "")}). Emails go from ${PLATFORM_NAME} until it is fixed; nothing is lost. Add the record back, press <b>Check now</b>, then <b>Resume</b>.</p>`
    : what === "failed" ? `<p>After 7 days the DNS records of <b>${esc(d.domain)}</b> are still not found. Emails keep going from ${PLATFORM_NAME}. Add the records (or ask your IT person) and press <b>Check now</b>.</p>`
    : `<p><b>${esc(d.domain)}</b> was deleted from the email provider outside the app. Emails go from ${PLATFORM_NAME} from now on. Add the domain again if that was a mistake.</p>`;
  const html = layout(esc(subject), `${body}<p style="margin-top:18px">${button(url, "Open Email sending", branding)}</p>`, branding);
  const to = what === "failed" && d.created_by ? { user_ids: [String(d.created_by)] } : { roles: ["owner" as const, "manager" as const] };
  await sendTeamEmail({ workspace_id: d.workspace_id, type: "sending_domain_status", subject, html, idempotency_key: `sending_domain_status:${d.id}:${what}:${new Date().toISOString().slice(0, 10)}`, ...to });
}

// ---------------------------------------------------------------------------
// F59
// ---------------------------------------------------------------------------
export async function verifyTick(): Promise<Row> {
  const out: Row = { checked: 0, verified: 0, failed: 0 };
  const { data: rows } = await admin.from("outreach_sending_domains").select("id, state, created_at, domain, created_by, workspace_id").in("state", ["setup", "verifying"]).not("resend_domain_id", "is", null).limit(50);
  for (const d of rows ?? []) {
    try {
      const ageH = (Date.now() - new Date(d.created_at).getTime()) / 3600_000;
      if (ageH > 24 * 7) {
        const after = await patch(d.id, { state: "failed", failed_at: new Date().toISOString(), last_checked_at: new Date().toISOString() });
        await statusEmail(after, "failed"); out.failed++;
        await audit(d.workspace_id, "sending_domain.failed", "sending_domain", d.id, { domain: d.domain, reason: "7 days unverified" }, "system");
        continue;
      }
      const r = await refreshDomain(d.id, { verify: true, source: "worker" });
      out.checked++; if (r.state === "ready") out.verified++;
    } catch (e) { log({ fn: "sending-domains", domain: d.domain, error: String((e as Error)?.message ?? e) }); }
  }
  return out;
}

export async function dailyRun(): Promise<Row> {
  const out: Row = {};
  out.health = await rpc<Row[]>("sending_domains_health").catch((e) => { log({ fn: "sending-domains", error: String(e) }); return []; });
  for (const h of (out.health ?? []) as Row[]) {
    const d = await load(String(h.id)).catch(() => null);
    if (d) { await rpc("email_outbox_reroute", { p_domain: d.id }).catch(() => null); await statusEmail({ ...d, paused_detail: h.detail }, "paused"); }
  }
  // records still there? (an active domain whose DNS went away)
  const { data: active } = await admin.from("outreach_sending_domains").select("id, domain").eq("state", "active").is("paused_at", null).limit(100);
  out.rechecked = 0;
  for (const d of active ?? []) { try { await refreshDomain(d.id, { verify: true, source: "nightly" }); out.rechecked++; } catch (e) { log({ fn: "sending-domains", domain: d.domain, error: String(e) }); } }
  // DMARC warning stays a warning: refresh the flag
  for (const d of active ?? []) { try { const dm = await dmarcLookup(d.domain); await patch(d.id, { dmarc_found: dm.found }); } catch { /* next time */ } }
  out.plan = await rpc<Row>("sending_domains_plan_sync").catch(() => null);
  // rows the plan sync (or a purge) marked removed while the provider still has them
  const { data: gone } = await admin.from("outreach_sending_domains").select("id, resend_domain_id, resend_api_key_id, workspace_id, domain").eq("state", "removed").not("resend_domain_id", "is", null).limit(50);
  out.provider_deleted = 0;
  for (const d of gone ?? []) {
    try {
      if (d.resend_api_key_id) await resendApiKeys.delete(d.resend_api_key_id).catch(() => null);
      await resendDomains.delete(d.resend_domain_id);
      await admin.from("outreach_sending_domains").update({ resend_domain_id: null, resend_api_key_id: null }).eq("id", d.id);
      await admin.from("outreach_sending_domain_keys").delete().eq("sending_domain_id", d.id);
      out.provider_deleted++;
    } catch (e) { log({ fn: "sending-domains", domain: d.domain, warn: "provider delete", error: String(e) }); }
  }
  out.retention = await rpc<Row>("email_retention").catch(() => null);
  return out;
}
