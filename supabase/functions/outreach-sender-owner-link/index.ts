// F53 — Owner link (sender-lifecycle-PRD.md §4). Public: deploy with --no-verify-jwt, no login.
//   GET  ?t=<token>                         JSON when the request asks for application/json (the web page app/sender-link
//                                           reads it): {valid, purpose, sender, workspace, branding, expires_at}. Any other
//                                           GET redirects to that page. GET never changes anything: mail scanners open links.
//   POST ?t=<token> {action}                action 'disconnect' → Remove with removed_via 'owner_link' (leads exit, the
//                                           connector account is deleted, history stays), managers are told.
//                                           action 'erase_request' → a task for the workspace owner + an email to managers.
//                                           The token is single use: whichever action runs consumes it.
// The token is random (24 bytes), stored as sha256 in outreach_sender_owner_links, bound to one sender, valid 30 days.
import { serve, json, log, rpc, CORS, WEB_ORIGIN } from "../_shared/outreach/supabase.ts";
import { removeSender, notifyManagersOwnerAction, ownerLinkPageUrl } from "../_shared/outreach/lifecycle.ts";

type Row = Record<string, any>;
const TOKEN_RE = /^[0-9a-f]{48}$/i;
const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to, "cache-control": "no-store", "x-robots-tag": "noindex", ...CORS } });

serve("sender-owner-link", async (req) => {
  const url = new URL(req.url);
  const wantsJson = (req.headers.get("accept") ?? "").includes("application/json") || req.method === "POST";
  if (req.method !== "GET" && req.method !== "POST" && req.method !== "HEAD") return json({ ok: false, code: "E_METHOD", error: "method not allowed" }, 405);
  let token = (url.searchParams.get("t") ?? "").trim();
  let action = "";
  if (req.method === "POST") {
    const body = await req.json().catch(() => ({})) as Row;
    token = String(body.t ?? body.token ?? token).trim();
    action = String(body.action ?? "disconnect");
  }
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;
  // abuse guard: a real owner opens one link once
  const allowed = await rpc<boolean>("rate_limit", { p_key: `owner-link:${ip ?? "unknown"}`, p_limit: 30, p_window_secs: 60 }).catch(() => true);
  if (!allowed) return json({ ok: false, code: "E_RATE_LIMITED", error: "too many requests" }, 429);
  if (!TOKEN_RE.test(token)) {
    return wantsJson ? json({ ok: false, valid: false, code: "E_INVALID_LINK", error: "This link is not valid." }, 400) : redirect(`${WEB_ORIGIN.replace(/\/$/, "")}/sender-link`);
  }
  const peek = await rpc<Row>("sender_owner_link_peek", { p_token: token });
  if (req.method !== "POST") {
    if (!wantsJson) return redirect(ownerLinkPageUrl(token));
    if (!peek?.sender) return json({ ok: false, valid: false, code: "E_INVALID_LINK", error: "This link is not valid." }, 400);
    return json({ ok: true, valid: !!peek.valid, used: !!peek.used, expired: !!peek.expired, purpose: peek.purpose, expires_at: peek.expires_at,
      sender: { id: peek.sender.id, name: peek.sender.name, provider: peek.sender.provider, status: peek.sender.status, erase_scheduled_at: peek.sender.erase_scheduled_at },
      workspace: { name: peek.workspace?.name ?? null }, branding: peek.branding ?? {} });
  }
  if (!peek?.sender) return json({ ok: false, code: "E_INVALID_LINK", error: "This link is not valid." }, 400);
  if (!peek.valid) return json({ ok: false, code: peek.used ? "E_LINK_USED" : "E_LINK_EXPIRED", error: peek.used ? "This link was already used." : "This link has expired. Ask the workspace for a new email." }, 410);
  if (action !== "disconnect" && action !== "erase_request") return json({ ok: false, code: "E_PAYLOAD_INVALID", error: "unknown action" }, 400);
  const used = await rpc<Row>("sender_owner_link_use", { p_token: token, p_ip: ip });
  if (!used?.ok) return json({ ok: false, code: "E_LINK_USED", error: "This link was already used." }, 410);
  const senderId = String(used.sender_id);
  if (action === "disconnect") {
    const r = await removeSender(senderId, "owner_link", { reason: "disconnected by the account owner", notifyOwner: false });
    await notifyManagersOwnerAction(senderId, "disconnected").catch((e) => log({ fn: "sender-owner-link", warn: "manager email failed", error: String(e) }));
    return json({ ok: true, action, state: r.state === "pending" ? "removal_pending" : r.state });
  }
  const taskId = await rpc<string>("sender_erase_request_task", { p_sender: senderId, p_source: "owner_link" });
  await notifyManagersOwnerAction(senderId, "erase_requested", taskId).catch((e) => log({ fn: "sender-owner-link", warn: "manager email failed", error: String(e) }));
  return json({ ok: true, action, task_id: taskId });
});
