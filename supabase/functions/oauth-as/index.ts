// supabase/functions/oauth-as/index.ts
//
// OAuth authorization-server metadata for ChatGPT's connector URLs (…-mcp/mcp-chatgpt). It describes the project's
// Supabase Auth server EXACTLY as it is — same authorize, token and registration endpoints, so Supabase still does the
// login, consent and token issuing — with two differences:
//
//   * scopes_supported has no "openid". ChatGPT requests every OIDC scope the server advertises, and asking for
//     "openid" makes Supabase mint an ID token, which fails while the project signs with the legacy HS256 secret
//     ("HS256 is not supported for ID token signing" on POST /oauth/token). Claude never asks for it.
//   * issuer is this function's URL (RFC 8414 requires it to equal the URL the metadata was fetched from).
//
// Claude's connector URLs (…-mcp/mcp) keep pointing at Supabase directly and are untouched by this function.
// Remove it (and the mcp-chatgpt aliases) once the project moves to asymmetric JWT signing keys.
//
// Discovery: a path-bearing issuer is probed at /.well-known/oauth-authorization-server/<path> and
// /.well-known/openid-configuration/<path> on the HOST ROOT (the gateway only routes /functions/v1/*, so those miss),
// then at <issuer>/.well-known/openid-configuration, which is served here.
//
// Deploy with verify_jwt DISABLED (clients fetch this without a token):
//   supabase functions deploy oauth-as --no-verify-jwt --project-ref ktwqkvjuzsunssudqnrt
import { Hono } from "npm:hono@4.9.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ISSUER = `${SUPABASE_URL}/functions/v1/oauth-as`;
const UPSTREAM = `${SUPABASE_URL}/auth/v1/.well-known/oauth-authorization-server`;
const SCOPES = ["email", "profile", "offline_access"];

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
  "access-control-allow-methods": "GET,OPTIONS",
};

let cached: { at: number; doc: Record<string, unknown> } | null = null;

async function metadata(): Promise<Record<string, unknown>> {
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.doc;
  const r = await fetch(UPSTREAM);
  if (!r.ok) throw new Error(`upstream metadata ${r.status}`);
  const up = await r.json() as Record<string, unknown>;
  // Everything OIDC is dropped with "openid": no ID tokens, no userinfo, no subject/claims descriptions.
  // deno-lint-ignore no-unused-vars
  const { userinfo_endpoint, id_token_signing_alg_values_supported, subject_types_supported, claims_supported, ...rest } = up;
  const doc = { ...rest, issuer: ISSUER, scopes_supported: SCOPES };
  cached = { at: Date.now(), doc };
  return doc;
}

const app = new Hono().basePath("/oauth-as");
app.options("*", () => new Response(null, { status: 204, headers: CORS }));

const serve = async () => {
  try {
    return new Response(JSON.stringify(await metadata()), { headers: { ...CORS, "content-type": "application/json", "cache-control": "public, max-age=300" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: "server_error", error_description: String(e) }), { status: 502, headers: { ...CORS, "content-type": "application/json" } });
  }
};
app.get("/.well-known/openid-configuration", serve);
app.get("/.well-known/oauth-authorization-server", serve);
app.get("/", serve);

Deno.serve(app.fetch);
