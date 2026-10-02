// Public, read-only endpoints for the marketing website (pricing-billing-PRD.md §10.6). No auth; cached for 5 minutes.
//   GET /outreach-public/pricing            the price book and feature matrix quotes are made from (so the site and the app can't drift)
//   GET /outreach-public/early-supporters   { claimed, tiers, current } for the early-supporter ladder
// Deploy with --no-verify-jwt.
import { admin, CORS, HttpError, json, serve } from "../_shared/outreach/supabase.ts";
import { PRICE_BOOK } from "../_shared/outreach/pricing.ts";

const CACHE = { "cache-control": "public, max-age=300, s-maxage=300" };

serve("public", async (req) => {
  if (req.method !== "GET") throw new HttpError(405, "E_PAYLOAD_INVALID", "GET only");
  const path = new URL(req.url).pathname.replace(/\/+$/, "").split("/").pop() ?? "";

  if (path === "pricing") {
    // the stored rows are what the billing functions use; the JSON carries the names, highlights and period labels the site shows
    const { data, error } = await admin.rpc("outreach_pricing_public");
    if (error) throw new HttpError(500, "E_INTERNAL", error.message);
    return json({ ...data, book: PRICE_BOOK }, 200, CACHE);
  }

  if (path === "early-supporters") {
    const { data, error } = await admin.rpc("outreach_early_supporters_public");
    if (error) throw new HttpError(500, "E_INTERNAL", error.message);
    const claimed = Number(data?.claimed ?? 0);
    let start = 0, current: Record<string, unknown> | null = null;
    const tiers = ((data?.tiers ?? []) as Array<{ tier: number; spots: number; discount: number }>).map((t) => {
      const taken = Math.min(Math.max(claimed - start, 0), t.spots);
      const row = { tier: t.tier, spots: t.spots, discount: Number(t.discount), taken, left: t.spots - taken, status: taken >= t.spots ? "gone" : current ? "next" : "open" };
      if (row.status === "open") current = row;
      start += t.spots;
      return row;
    });
    return json({ claimed, tiers, current }, 200, CACHE);
  }

  return json({ error: "not found", endpoints: ["pricing", "early-supporters"] }, 404, CORS);
});
