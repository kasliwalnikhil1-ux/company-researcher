// Re-login link target (hosted-auth docs, "Reconnecting an account with Hosted Auth Wizard"). Public: deploy with --no-verify-jwt.
//   GET ?s=<sender id>&e=<expiry, unix s>&m=<credentials|browser, optional>&t=<token>
// The re-login email (and "Copy sign-in link" on the sender page) carries this URL instead of a hosted sign-in link, because
// hosted links must stay short-lived. Opening it creates a fresh hosted link for the sender and redirects there; it is safe to
// open more than once (mail scanners open every link): nothing changes until the owner actually signs in.
// The token is HMAC-SHA256(OUTREACH_CRON_SECRET, "relogin:<sender>:<expiry>:<method>") (crypto.ts), valid RELOGIN_URL_TTL_DAYS.
// Invalid / expired link, a sender that is already connected or disabled, or a failure → redirect to the sender page, which
// explains the state and lets a manager create a new link.
import { admin, serve, log, rateLimit, WEB_ORIGIN } from "../_shared/outreach/supabase.ts";
import { verifyReloginToken } from "../_shared/outreach/crypto.ts";
import { reconnectLink } from "../_shared/outreach/inbound.ts";
import { unipileConfigured } from "../_shared/outreach/unipile.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to, "cache-control": "no-store", "x-robots-tag": "noindex" } });

serve("relogin", async (req) => {
  const url = new URL(req.url);
  const sid = (url.searchParams.get("s") ?? "").trim();
  const exp = Number(url.searchParams.get("e"));
  const m = (url.searchParams.get("m") ?? "").trim();
  const token = (url.searchParams.get("t") ?? "").trim();
  const origin = WEB_ORIGIN.replace(/\/$/, "");
  if (!UUID_RE.test(sid)) return redirect(`${origin}/outreach/senders`);
  const senderPage = `${origin}/outreach/senders/${sid}`;
  const method = m === "browser" || m === "credentials" ? m : "";
  if (m !== method || !(await verifyReloginToken(sid, exp, method, token))) {
    log({ fn: "relogin", sender_id: sid, warn: "invalid or expired link" });
    return redirect(`${senderPage}?relogin=expired`);
  }
  const { data: s } = await admin.from("outreach_senders").select("*").eq("id", sid).maybeSingle();
  if (!s || s.deleted_at || s.status === "disabled") return redirect(senderPage);
  if (s.status === "ok" || s.status === "paused") return redirect(`${senderPage}?connected=1`);
  if (!unipileConfigured()) return redirect(`${senderPage}?connected=0`);
  try {
    await rateLimit(`relogin:${sid}`, 20, 3600);
    const link = await reconnectLink(s, method || undefined);
    if (!link) return redirect(`${senderPage}?connected=0`);
    return redirect(link);
  } catch (e) {
    log({ fn: "relogin", sender_id: sid, error: String((e as any)?.message ?? e) });
    return redirect(`${senderPage}?connected=0`);
  }
});
