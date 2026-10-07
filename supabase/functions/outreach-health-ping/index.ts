// F50 health-ping (health-page-PRD.md §11): public, no login. Answers `ok` when ops.health_run() ran in the last
// 15 minutes, otherwise `stale` (503). Nothing else is returned, so an outside uptime monitor can be pointed at it.
import { serve, admin } from "../_shared/outreach/supabase.ts";

serve("outreach-health-ping", async (req) => {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("stale", { status: 405, headers: { "content-type": "text/plain" } });
  let body = "stale";
  try {
    const { data, error } = await admin.rpc("outreach_ops_health_ping");
    if (!error && data === "ok") body = "ok";
  } catch { /* stale */ }
  return new Response(body, { status: body === "ok" ? 200 : 503, headers: { "content-type": "text/plain", "cache-control": "no-store" } });
});
