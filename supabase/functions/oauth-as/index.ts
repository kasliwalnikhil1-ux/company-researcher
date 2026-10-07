// supabase/functions/oauth-as/index.ts
//
// OAuth authorization-server metadata for the MCP connectors. It describes the project's Supabase Auth server — same
// token and registration endpoints, so Supabase still does the login, consent and token issuing — with these changes:
//
//   * scopes_supported has no "openid". ChatGPT requests every OIDC scope the server advertises, and asking for
//     "openid" makes Supabase mint an ID token, which fails while the project signs with the legacy HS256 secret
//     ("HS256 is not supported for ID token signing" on POST /oauth/token). Claude never asks for it.
//   * issuer is this function's URL (RFC 8414 requires it to equal the URL the metadata was fetched from).
//   * Per brand (/oauth-as/capitalxai, /oauth-as/growthxai — see _shared/brands.ts): authorization_endpoint is
//     /oauth-as/<brand>/authorize. It asks Supabase for the authorization request and sends the browser to that
//     brand's web app for sign-in and consent (app.capitalxai.com or app.growthxai.com). Supabase alone always sends it
//     to the project's Site URL, one domain for every connector. The authorization_id is not tied to a domain.
//
// /oauth-as without a brand is the original ChatGPT-only variant (consent on the Site URL); kept for old connections.
// The openid part can go once the project moves to asymmetric JWT signing keys; the brand part stays.
//
// Discovery: a path-bearing issuer is probed at /.well-known/oauth-authorization-server/<path> and
// /.well-known/openid-configuration/<path> on the HOST ROOT (the gateway only routes /functions/v1/*, so those miss),
// then at <issuer>/.well-known/openid-configuration, which is served here.
//
// Deploy with verify_jwt DISABLED (clients fetch this without a token):
//   supabase functions deploy oauth-as --no-verify-jwt --project-ref ktwqkvjuzsunssudqnrt
import { Hono } from "npm:hono@4.9.7";
import { type Brand, BRANDS } from "../_shared/brands.ts";
import { withHealth } from "../_shared/health.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ISSUER = `${SUPABASE_URL}/functions/v1/oauth-as`;
const UPSTREAM = `${SUPABASE_URL}/auth/v1/.well-known/oauth-authorization-server`;
const UPSTREAM_AUTHORIZE = `${SUPABASE_URL}/auth/v1/oauth/authorize`;
const SCOPES = ["email", "profile", "offline_access"];

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
  "access-control-allow-methods": "GET,OPTIONS",
};

let cached: { at: number; doc: Record<string, unknown> } | null = null;

async function upstreamMetadata(): Promise<Record<string, unknown>> {
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.doc;
  const r = await fetch(UPSTREAM);
  if (!r.ok) throw new Error(`upstream metadata ${r.status}`);
  const up = await r.json() as Record<string, unknown>;
  // Everything OIDC is dropped with "openid": no ID tokens, no userinfo, no subject/claims descriptions.
  // deno-lint-ignore no-unused-vars
  const { userinfo_endpoint, id_token_signing_alg_values_supported, subject_types_supported, claims_supported, ...rest } = up;
  const doc = { ...rest, scopes_supported: SCOPES };
  cached = { at: Date.now(), doc };
  return doc;
}

async function metadata(brand: Brand | null): Promise<Record<string, unknown>> {
  const doc = await upstreamMetadata();
  if (!brand) return { ...doc, issuer: ISSUER };
  const issuer = `${ISSUER}/${brand.key}`;
  return { ...doc, issuer, authorization_endpoint: `${issuer}/authorize` };
}

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json", ...extra } });

const serve = async (brand: Brand | null) => {
  try {
    return json(await metadata(brand), 200, { "cache-control": "public, max-age=300" });
  } catch (e) {
    return json({ error: "server_error", error_description: String(e) }, 502);
  }
};

const brandOf = (key: string | undefined): Brand | null => (key === "capitalxai" || key === "growthxai" ? BRANDS[key] : null);

const app = new Hono().basePath("/oauth-as");
app.options("*", () => new Response(null, { status: 204, headers: CORS }));

app.get("/.well-known/openid-configuration", () => serve(null));
app.get("/.well-known/oauth-authorization-server", () => serve(null));
app.get("/", () => serve(null));

for (const path of ["/:brand/.well-known/openid-configuration", "/:brand/.well-known/oauth-authorization-server", "/:brand"]) {
  app.get(path, (c) => {
    const brand = brandOf(c.req.param("brand"));
    return brand ? serve(brand) : json({ error: "not_found" }, 404);
  });
}

// Browser hop: let Supabase validate the request and create the authorization, then open its consent page on the
// brand's app instead of the Site URL. Anything else (errors go back to the client's redirect_uri) passes through.
app.get("/:brand/authorize", async (c) => {
  const brand = brandOf(c.req.param("brand"));
  if (!brand) return json({ error: "not_found" }, 404);

  const upstream = `${UPSTREAM_AUTHORIZE}${new URL(c.req.url).search}`;
  let r: Response;
  try {
    r = await fetch(upstream, { redirect: "manual" });
  } catch (e) {
    return json({ error: "server_error", error_description: String(e) }, 502);
  }

  const location = r.headers.get("location");
  if (r.status >= 300 && r.status < 400 && location) {
    const target = new URL(location, upstream);
    const isConsent = target.pathname.endsWith("/oauth/consent") && target.searchParams.has("authorization_id");
    const to = isConsent ? new URL(`${target.pathname}${target.search}`, brand.appOrigin) : target;
    return new Response(null, { status: 302, headers: { location: to.toString(), "cache-control": "no-store" } });
  }
  return new Response(r.body, {
    status: r.status,
    headers: { "content-type": r.headers.get("content-type") ?? "text/plain", "cache-control": "no-store" },
  });
});

Deno.serve(withHealth("oauth-as", (req) => app.fetch(req)));
