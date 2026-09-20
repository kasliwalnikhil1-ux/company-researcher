// Items 23 + 20 — DNS checks for white-label portal domains and custom email-tracking domains (cron every 30 minutes).
//
// Portal domains (outreach_workspace_domains, status pending_dns | verifying | failed, added less than 14 days ago):
//   TXT   _outreach-verify.<host>  must equal verification_token
//   CNAME <host>                   must point at cname_target
//   both ok → active (+ verified_at) · TXT only → verifying · otherwise pending_dns with last_error in plain words.
//   After 14 days without success the row becomes `failed` and is no longer checked (remove and add the domain again to retry).
//   OPERATOR STEP: the hostname must also be added to the web app's hosting project (Vercel → Project → Domains) so TLS is issued;
//   `active` here only means the customer's DNS is right.
//
// Tracking domains (outreach_tracking_domains, status pending_dns):
//   CNAME <host> → s1.lnk-fllw.com resolves → awaiting_approval. This worker NEVER sets `active`.
//   OPERATOR STEP: a platform operator asks Unipile support to authorise the domain; once Unipile confirms, the operator runs
//     update outreach_tracking_domains set status = 'active', approved_at = now() where hostname = '<host>';
//   Only then does outreach_tracking_domain_for() hand it to the executor as tracking_options.custom_domain. Until then the default
//   tracking domain is used. If the CNAME disappears while waiting, the row goes back to pending_dns.
import { admin, json, serve, requireCron, readJson, log } from "../_shared/outreach/supabase.ts";

type Row = Record<string, any>;
const DOH = "https://cloudflare-dns.com/dns-query";
const MAX_AGE_DAYS = 14;

interface DnsAnswer { status: number; records: string[]; error?: string }

async function doh(name: string, type: "TXT" | "CNAME" | "A"): Promise<DnsAnswer> {
  try {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`${DOH}?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: "application/dns-json" }, signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) { await res.body?.cancel(); return { status: -1, records: [], error: `resolver answered ${res.status}` }; }
    const data = await res.json();
    const want = type === "TXT" ? 16 : type === "CNAME" ? 5 : 1;
    const records = ((data.Answer ?? []) as Row[]).filter((a) => a.type === want).map((a) => String(a.data ?? ""));
    return { status: Number(data.Status ?? 0), records };
  } catch (e) { return { status: -1, records: [], error: String((e as any)?.message ?? e) }; }
}

const host = (s: string) => s.trim().toLowerCase().replace(/\.$/, "");
/** TXT data arrives quoted and possibly split into several strings: "abc" "def" */
const txtValue = (s: string) => (s.match(/"((?:[^"\\]|\\.)*)"/g) ?? [s]).map((x) => x.replace(/^"|"$/g, "")).join("").trim();

async function checkCname(hostname: string, target: string): Promise<{ ok: boolean; resolverDown: boolean; found: string | null }> {
  const c = await doh(hostname, "CNAME");
  if (c.status === -1) return { ok: false, resolverDown: true, found: null };
  const found = c.records.map(host);
  return { ok: found.includes(host(target)), resolverDown: false, found: found[0] ?? null };
}

async function checkPortalDomain(d: Row): Promise<Row> {
  const now = new Date().toISOString();
  const target = d.cname_target ?? "cname.vercel-dns.com";
  const txt = await doh(`_outreach-verify.${d.hostname}`, "TXT");
  const cname = await checkCname(d.hostname, target);
  if (txt.status === -1 || cname.resolverDown) { log({ fn: "domain-check", hostname: d.hostname, warn: "resolver unavailable", detail: txt.error }); return { id: d.id, hostname: d.hostname, skipped: "resolver unavailable" }; }
  const txtOk = txt.records.map(txtValue).includes(String(d.verification_token));
  let patch: Row;
  if (txtOk && cname.ok) patch = { status: "active", verified_at: d.verified_at ?? now, last_error: null };
  else {
    const problems: string[] = [];
    if (!txtOk) problems.push(txt.records.length
      ? `The TXT record _outreach-verify.${d.hostname} exists but has a different value. It must be exactly ${d.verification_token}.`
      : `No TXT record found at _outreach-verify.${d.hostname}. Add one with the value ${d.verification_token}.`);
    if (!cname.ok) problems.push(cname.found
      ? `${d.hostname} points to ${cname.found}. Change the CNAME so it points to ${target}.`
      : `No CNAME record found for ${d.hostname}. Add a CNAME that points to ${target}. If your DNS provider has a proxy switch (orange cloud), turn it off for this record.`);
    const expired = Date.now() - new Date(d.created_at).getTime() > MAX_AGE_DAYS * 86400_000;
    patch = { status: expired ? "failed" : txtOk ? "verifying" : "pending_dns", last_error: `${problems.join(" ")}${expired ? ` We stopped checking after ${MAX_AGE_DAYS} days. Remove the domain and add it again once DNS is set.` : " DNS changes can take up to an hour to show."}` };
  }
  const { error } = await admin.from("outreach_workspace_domains").update({ ...patch, last_checked_at: now }).eq("id", d.id);
  if (error) log({ fn: "domain-check", hostname: d.hostname, error: error.message });
  if (patch.status === "active" && d.status !== "active") log({ fn: "domain-check", hostname: d.hostname, verified: true, operator_step: "add this hostname to the web app's hosting project so TLS is issued" });
  return { id: d.id, hostname: d.hostname, from: d.status, to: patch.status };
}

async function checkTrackingDomain(d: Row): Promise<Row> {
  const now = new Date().toISOString();
  const target = d.cname_target ?? "s1.lnk-fllw.com";
  const cname = await checkCname(d.hostname, target);
  if (cname.resolverDown) return { id: d.id, hostname: d.hostname, skipped: "resolver unavailable" };
  let patch: Row;
  if (d.status === "pending_dns") {
    patch = cname.ok
      ? { status: "awaiting_approval", note: "DNS is correct. Waiting for the email provider to authorise this domain; the default tracking domain is used until then." }
      : { note: cname.found ? `${d.hostname} points to ${cname.found}. Change the CNAME so it points to ${target}.` : `No CNAME record found for ${d.hostname}. Add a CNAME that points to ${target}. DNS changes can take up to an hour to show.` };
  } else {
    // awaiting_approval: make sure the record is still there; only an operator moves it to active
    patch = cname.ok ? {} : { status: "pending_dns", note: `The CNAME for ${d.hostname} no longer points to ${target}. Put it back to continue.` };
  }
  const { error } = await admin.from("outreach_tracking_domains").update({ ...patch, checked_at: now }).eq("id", d.id);
  if (error) log({ fn: "domain-check", hostname: d.hostname, error: error.message });
  if (patch.status === "awaiting_approval") log({ fn: "domain-check", hostname: d.hostname, workspace: d.workspace_id, operator_step: "ask Unipile support to authorise this tracking domain, then set status = 'active'" });
  return { id: d.id, hostname: d.hostname, from: d.status, to: patch.status ?? d.status };
}

serve("domain-check", async (req) => {
  requireCron(req);
  const body = await readJson<{ domain_id?: string; tracking_domain_id?: string }>(req);
  const since = new Date(Date.now() - (MAX_AGE_DAYS + 1) * 86400_000).toISOString();   // one extra day so the 14-day rows get their `failed` verdict

  let pq = admin.from("outreach_workspace_domains").select("*");
  pq = body.domain_id ? pq.eq("id", body.domain_id) : pq.in("status", ["pending_dns", "verifying", "failed"]).gte("created_at", since);
  const { data: portal } = body.tracking_domain_id ? { data: [] as Row[] } : await pq.order("last_checked_at", { ascending: true, nullsFirst: true }).limit(100);

  let tq = admin.from("outreach_tracking_domains").select("*");
  tq = body.tracking_domain_id ? tq.eq("id", body.tracking_domain_id) : tq.in("status", ["pending_dns", "awaiting_approval"]);
  const { data: tracking } = body.domain_id ? { data: [] as Row[] } : await tq.order("checked_at", { ascending: true, nullsFirst: true }).limit(100);

  const started = Date.now();
  const results: Row[] = [];
  for (const d of portal ?? []) { if (Date.now() - started > 100_000) break; results.push({ kind: "portal", ...(await checkPortalDomain(d)) }); }
  for (const d of tracking ?? []) {
    if (Date.now() - started > 100_000) break;
    // awaiting_approval rows are only re-checked once a day
    if (!body.tracking_domain_id && d.status === "awaiting_approval" && d.checked_at && Date.now() - new Date(d.checked_at).getTime() < 24 * 3600_000) continue;
    results.push({ kind: "tracking", ...(await checkTrackingDomain(d)) });
  }
  return json({ ok: true, checked: results.length, results });
});
