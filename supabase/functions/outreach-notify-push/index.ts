// F47 — Web Push for reply alerts (reply-notifications-PRD.md §7.2, §9).
//   cron   {mode:"send"}  (x-cron-secret; every 10 s from 077 and nudged by each new alert) claims due pushes from
//                         outreach_push_queue and sends them to each saved browser of the person. TTL 1 hour, high urgency,
//                         Topic = conversation id (collapses pending pushes). 404/410 → that browser is deleted; 429/5xx →
//                         retried with backoff; an alert read before sending is dropped by the claim.
//   user   GET ?action=public_key  (user JWT) → {public_key}: the VAPID key the browser subscribes with. The key pair
//                         is created on first use and kept in Vault (outreach_push_vapid_init).
import { json, serve, requireCron, requireUser, readJson, rpc, rateLimit, log, HttpError, WEB_ORIGIN } from "../_shared/outreach/supabase.ts";
import { generateVapidKeys, sendPush, type PushOutcome, type PushSubscriptionRow, type VapidKeys } from "../_shared/outreach/webpush.ts";

const SUBJECT = Deno.env.get("OUTREACH_VAPID_SUBJECT") ?? WEB_ORIGIN;
const RUN_BUDGET_MS = 45_000;
const CONCURRENCY = 12;

let vapid: Promise<VapidKeys> | null = null;

async function loadVapid(): Promise<VapidKeys> {
  const cur = await rpc<{ public: string | null; private_jwk: string | null }>("push_vapid");
  if (cur?.public && cur?.private_jwk) return { publicKey: cur.public, privateJwk: JSON.parse(cur.private_jwk) };
  const fresh = await generateVapidKeys();
  const saved = await rpc<{ public: string | null; private_jwk: string | null }>("push_vapid_init", { p_public: fresh.publicKey, p_private_jwk: JSON.stringify(fresh.privateJwk) });
  if (!saved?.public || !saved?.private_jwk) throw new Error("E_INTERNAL: VAPID keys could not be stored");
  log({ fn: "notify-push", vapid: saved.public === fresh.publicKey ? "created" : "lost the race, using the stored pair" });
  return { publicKey: saved.public, privateJwk: JSON.parse(saved.private_jwk) };
}
function keys(): Promise<VapidKeys> {
  if (!vapid) vapid = loadVapid().catch((e) => { vapid = null; throw e; });
  return vapid;
}

interface Job { queue_id: number; topic: string; payload: Record<string, unknown>; subs: PushSubscriptionRow[] | null }
interface JobResult { queue_id: number; done: boolean; retry_after_s?: number; gone: string[]; failed: Array<{ id: string; error: string }>; sent: string[] }

async function pool<T, R>(items: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await f(items[k]); }
  }));
  return out;
}

async function runJob(job: Job, k: VapidKeys): Promise<JobResult> {
  const r: JobResult = { queue_id: job.queue_id, done: true, gone: [], failed: [], sent: [] };
  const outcomes = await Promise.all((job.subs ?? []).map(async (s) => [s, await sendPush(s, job.payload, k, SUBJECT, job.topic)] as [PushSubscriptionRow, PushOutcome]));
  let retry = 0;
  for (const [s, o] of outcomes) {
    if (o.kind === "sent") r.sent.push(s.id);
    else if (o.kind === "gone") r.gone.push(s.id);
    else if (o.kind === "retry") { retry = Math.max(retry, o.retryAfterS); r.failed.push({ id: s.id, error: o.error }); }
    else r.failed.push({ id: s.id, error: o.error });
  }
  // retry only when no browser got it and one may still: a push that reached some browser is not sent twice
  if (retry > 0 && r.sent.length === 0) { r.done = false; r.retry_after_s = retry; }
  return r;
}

async function runSend(): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  const k = await keys();
  let jobs = 0, sent = 0, gone = 0, failed = 0, retried = 0;
  while (Date.now() - t0 < RUN_BUDGET_MS) {
    const batch = await rpc<Job[]>("push_claim", { p_limit: 100 });
    if (!batch?.length) break;
    const results = await pool(batch, CONCURRENCY, (j) => runJob(j, k).catch((e) => ({ queue_id: j.queue_id, done: false, retry_after_s: 30, gone: [], failed: [], sent: [], error: String(e) } as JobResult)));
    await rpc("push_result", { p_results: results });
    jobs += batch.length;
    for (const r of results) { sent += r.sent.length; gone += r.gone.length; failed += r.failed.length; if (!r.done) retried++; }
    if (batch.length < 100) break;
  }
  return { jobs, sent, gone, failed, retried, duration_ms: Date.now() - t0 };
}

serve("notify-push", async (req) => {
  if (req.headers.has("x-cron-secret")) {
    requireCron(req);
    const body = await readJson<{ mode?: string }>(req);
    if ((body.mode ?? "send") !== "send") return json({ ok: false, error: `unknown mode ${String(body.mode)}` }, 400);
    const result = await runSend();
    if (Number(result.jobs) > 0) log({ fn: "notify-push", mode: "send", ...result });
    return json({ ok: true, ...result });
  }
  const user = await requireUser(req);
  const url = new URL(req.url);
  const body = req.method === "GET" ? {} : await readJson<{ action?: string }>(req);
  const action = url.searchParams.get("action") ?? (body as { action?: string }).action ?? "public_key";
  if (action !== "public_key") throw new HttpError(400, "E_PAYLOAD_INVALID", "unknown action");
  await rateLimit(`user:${user.id}:push-key`, 60, 3600);
  const k = await keys();
  return json({ ok: true, public_key: k.publicKey }, 200, { "cache-control": "private, max-age=3600" });
});

