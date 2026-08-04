// supabase/functions/capitalxai-mcp/index.ts
//
// Remote MCP server ("Claude connector") for CapitalxAI.
//
//   MCP endpoint:        POST/GET/DELETE  /capitalxai-mcp/mcp        (Streamable HTTP)
//   OAuth metadata:      GET  /capitalxai-mcp/.well-known/oauth-protected-resource
//
// Auth: Supabase Auth OAuth 2.1 access tokens (standard Supabase JWTs).
// Unauthenticated requests receive 401 + WWW-Authenticate pointing at the
// protected-resource metadata, which in turn points MCP clients (claude.ai,
// Claude Code, Claude Desktop) at the project's OAuth 2.1 authorization server
// for discovery + dynamic client registration.
//
// Deploy with verify_jwt DISABLED on purpose: the .well-known document and
// the 401 challenge must be reachable without a token; bearer-token auth is
// enforced in-function for every MCP request per the MCP authorization spec.
//   supabase functions deploy capitalxai-mcp --no-verify-jwt
//
// Read tools (find_investors, list_fundings, get_funding) are available to any
// authenticated user. Write tools (add/update investor, add/update funding) are
// registered only for admin accounts, matching the app's admin gating.

import { McpServer } from "npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "npm:@modelcontextprotocol/sdk@1.25.3/server/webStandardStreamableHttp.js";
import { Hono } from "npm:hono@4.9.7";
import { z } from "npm:zod@4.1.13";
import { createClient } from "npm:@supabase/supabase-js@2.76.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const FUNCTION_BASE = `${SUPABASE_URL}/functions/v1/capitalxai-mcp`;
const RESOURCE_URL = `${FUNCTION_BASE}/mcp`;
const PRM_URL = `${FUNCTION_BASE}/.well-known/oauth-protected-resource`;
const AUTH_SERVER_URL = `${SUPABASE_URL}/auth/v1`;

const APP_NAME = "CapitalxAI";
const APP_URL = "https://app.capitalxai.com";
const APP_LOGO_URL = `${APP_URL}/logo.png`;

// Same admin allowlist as the app (ME Data / Data Pipelines / Add Funding).
const ADMIN_USER_IDS = new Set([
  "2793f3da-9340-44f4-b285-b7836bfb8591",
  "e25d5e21-13fd-46ee-a39a-4c3386b77b65",
]);

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization, content-type, apikey, x-client-info, mcp-session-id, mcp-protocol-version, last-event-id",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
  "access-control-expose-headers": "mcp-session-id, www-authenticate",
};

interface AuthedUser {
  userId: string;
  token: string;
  isAdmin: boolean;
}

async function authenticate(authHeader: string | undefined): Promise<AuthedUser | null> {
  const token = (authHeader ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  try {
    const { data } = await admin.auth.getUser(token);
    if (!data?.user?.id) return null;
    return { userId: data.user.id, token, isAdmin: ADMIN_USER_IDS.has(data.user.id) };
  } catch {
    return null;
  }
}

function unauthorized(): Response {
  return new Response(
    JSON.stringify({
      error: "unauthorized",
      error_description: "A valid bearer token is required to access this MCP server.",
    }),
    {
      status: 401,
      headers: {
        ...CORS_HEADERS,
        "content-type": "application/json",
        "www-authenticate": `Bearer realm="capitalxai-mcp", resource_metadata="${PRM_URL}"`,
      },
    },
  );
}

/** Bare lowercase domain: no protocol, no www., no path (accel.com).
 *  LinkedIn URLs are never domains (mirrors the app's sanitizeInvestorFields Rule 1). */
function cleanDomain(input: string): string | null {
  let s = (input ?? "").trim();
  if (!s) return null;
  if (!s.startsWith("http")) s = "https://" + s;
  try {
    const host = new URL(s).hostname.replace(/^www\./, "");
    if (host.toLowerCase().includes("linkedin.com")) return null;
    return /[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(host) ? host.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** LinkedIn stored as lowercase path only: in/namankas, company/accel, school/stanford. */
function cleanLinkedinPath(input: string): string | null {
  let s = (input ?? "").trim();
  if (!s) return null;
  // Path-only input (in/namankas, company/accel, school/stanford)
  if (/^[a-z]+\/[\w.-]+$/i.test(s)) return s.toLowerCase().replace(/^\/+|\/+$/g, "");
  if (!s.toLowerCase().includes("linkedin.com")) return null;
  if (!s.startsWith("http")) s = "https://" + s;
  try {
    const path = new URL(s).pathname.toLowerCase().replace(/^\/+|\/+$/g, "");
    return path || null;
  } catch {
    return null;
  }
}

/** Parse "[Name](url)", "Name (url)" or plain "Name" into { name, url }. */
function parseNameUrl(s: string): { name: string; url?: string } {
  if (typeof s !== "string") return { name: String(s) };
  const t = s.trim();
  const mdMatch = t.match(/^\[([^\]]+)\]\(([^)]*)\)$/);
  if (mdMatch) return { name: mdMatch[1].trim(), url: mdMatch[2].trim() || undefined };
  const parenMatch = t.match(/^(.+?)\s*\(([^)]+)\)$/);
  if (parenMatch) {
    const name = parenMatch[1].trim();
    const url = parenMatch[2].trim();
    if (name && url) return { name, url };
  }
  return { name: t };
}

function formatDate(iso: string | null | undefined): string {
  if (typeof iso !== "string" || !iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function formatUsd(n: number | null | undefined): string {
  if (typeof n !== "number" || Number.isNaN(n)) return "";
  return `$${n.toLocaleString("en-US")}`;
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const textResult = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const errorResult = (err: unknown): ToolResult => ({
  content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
  isError: true,
});

// ---------------------------------------------------------------------------
// Shared investor field schemas / row builders
// ---------------------------------------------------------------------------

// Optional profile fields shared by add_investor and update_investor.
// Matches the columns the app writes (investor-research + rerun-profile).
const investorProfileShape = {
  investor_type: z
    .array(z.string())
    .optional()
    .describe('Investor categories, e.g. ["VC"], ["Angel"], ["Family Office"], ["Accelerator"].'),
  role: z.string().optional().describe("For people: their role/title, e.g. 'Partner at Accel'."),
  hq_state: z.string().optional().describe("Headquarters state/region, e.g. 'California'."),
  hq_country: z.string().optional().describe("Headquarters country, e.g. 'United States'."),
  tier: z.enum(["A", "B", "C"]).optional().describe("Investor quality tier: A, B, or C."),
  fund_size_usd: z.number().int().nonnegative().optional().describe("Fund size in USD, e.g. 500000000 for $500M."),
  check_size_min_usd: z.number().int().nonnegative().optional().describe("Minimum check size in USD."),
  check_size_max_usd: z.number().int().nonnegative().optional().describe("Maximum check size in USD."),
  investment_stages: z
    .array(z.string())
    .optional()
    .describe('Stages they invest in, e.g. ["Pre-Seed", "Seed", "Series A"].'),
  investment_industries: z.array(z.string()).optional().describe("Industries/sectors they invest in."),
  investment_geographies: z.array(z.string()).optional().describe("Geographies they invest in."),
  investment_thesis: z.string().optional().describe("One-paragraph investment thesis."),
  notable_investments: z
    .array(z.string())
    .optional()
    .describe('Notable portfolio companies as "[Name](url)" strings, e.g. ["[Stripe](stripe.com)"].'),
  coinvestors: z.array(z.string()).optional().describe('Frequent co-investors as "[Name](url)" strings.'),
  work_experience_orgs: z
    .array(z.string())
    .optional()
    .describe('For people: past employers as "[Name](url)" strings.'),
  education_orgs: z
    .array(z.string())
    .optional()
    .describe('For people: schools/universities as "[Name](url)" strings.'),
  leads_round: z.boolean().optional().describe("Whether this investor leads rounds."),
  active: z.boolean().optional().describe("Whether the investor is actively investing."),
  email: z.string().optional().describe("Contact email(s); join multiple with ', '."),
  phone: z.string().optional().describe("Contact phone number."),
  apply_url: z
    .string()
    .optional()
    .describe("Pitch/application submission URL. Omit if it is just the investor's homepage."),
  twitter_url: z.string().optional().describe("Twitter/X profile URL."),
  links: z.array(z.string()).optional().describe('Relevant links as "[title](url)" strings (site subpages, Crunchbase, etc.).'),
  deep_research: z
    .string()
    .optional()
    .describe("Full research write-up (structured sections with source links); stored on the record like the app's deep research."),
};

const INVESTOR_PROFILE_KEYS = Object.keys(investorProfileShape) as Array<keyof typeof investorProfileShape>;

/** Copy provided profile fields (only the ones the caller sent) into a row object. */
function pickProfileFields(input: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const key of INVESTOR_PROFILE_KEYS) {
    if (input[key] !== undefined) row[key] = input[key];
  }
  return row;
}

/** Is this domain / LinkedIn path on the not_an_investor skip-list? */
async function checkNotAnInvestor(domain: string | null, linkedinPath: string | null): Promise<boolean> {
  if (domain) {
    const { data } = await admin.from("not_an_investor").select("id").eq("domain", domain).limit(1).maybeSingle();
    if (data?.id) return true;
  }
  if (linkedinPath) {
    const { data } = await admin
      .from("not_an_investor")
      .select("id")
      .eq("linkedin_url", linkedinPath)
      .limit(1)
      .maybeSingle();
    if (data?.id) return true;
  }
  return false;
}

async function findFirmByDomain(domain: string): Promise<{ id: string; name: string } | null> {
  const clean = cleanDomain(domain);
  if (!clean) return null;
  const { data } = await admin
    .from("investors")
    .select("id, name")
    .eq("domain", clean)
    .eq("type", "firm")
    .limit(1)
    .maybeSingle();
  return data?.id ? { id: data.id, name: data.name } : null;
}

/** Create a person → firm affiliation if it does not already exist. */
async function ensureAffiliation(personId: string, firmId: string): Promise<void> {
  const { data: existing } = await admin
    .from("investor_affiliations")
    .select("id")
    .eq("person_id", personId)
    .eq("firm_id", firmId)
    .maybeSingle();
  if (existing?.id) return;
  const { error } = await admin
    .from("investor_affiliations")
    .insert({ id: crypto.randomUUID(), person_id: personId, firm_id: firmId });
  if (error) throw new Error(`Could not create the person→firm affiliation: ${error.message}`);
}

function investorLine(inv: {
  id: string;
  type: string | null;
  name: string | null;
  domain?: string | null;
  linkedin_url?: string | null;
  role?: string | null;
  tier?: string | null;
  investor_type?: string[] | null;
  hq_country?: string | null;
}): string {
  const parts = [`- [${inv.type ?? "?"}] ${inv.name ?? "Unnamed"} | id: ${inv.id}`];
  if (inv.domain) parts.push(`domain: ${inv.domain}`);
  if (inv.linkedin_url) parts.push(`linkedin: linkedin.com/${inv.linkedin_url}`);
  if (inv.role) parts.push(`role: ${inv.role}`);
  if (inv.tier) parts.push(`tier: ${inv.tier}`);
  if (inv.investor_type?.length) parts.push(inv.investor_type.join(", "));
  if (inv.hq_country) parts.push(inv.hq_country);
  return parts.join(" | ");
}

// ---------------------------------------------------------------------------
// MCP server (stateless: fresh server per request, bound to the caller)
// ---------------------------------------------------------------------------

function buildServer(auth: AuthedUser): McpServer {
  const server = new McpServer({
    name: "capitalxai",
    title: APP_NAME,
    version: "1.0.0",
    websiteUrl: APP_URL,
    icons: [{ src: APP_LOGO_URL, mimeType: "image/png" }],
  } as ConstructorParameters<typeof McpServer>[0]);

  // -------------------------------------------------------------------------
  // Read tools — any authenticated user
  // -------------------------------------------------------------------------

  server.registerTool(
    "find_investors",
    {
      title: "Find investors",
      description:
        "Search the investors database (firms and people). Look up by name, by firm domain, or by LinkedIn URL, " +
        "or list the people linked to a firm with at_firm_domain. " +
        "Returns matches with their ids — use the id (or domain / linkedin_url) with update_investor.",
      inputSchema: {
        query: z.string().optional().describe("Name search (case-insensitive substring), e.g. 'accel' or 'Naval'."),
        domain: z.string().optional().describe("Exact firm domain, e.g. accel.com (protocol/www are stripped automatically)."),
        linkedin_url: z
          .string()
          .optional()
          .describe("LinkedIn URL or path, e.g. linkedin.com/in/namankas or in/namankas."),
        at_firm_domain: z
          .string()
          .optional()
          .describe("List the people affiliated with this firm (firm's domain, e.g. accel.com)."),
        type: z.enum(["firm", "person"]).optional().describe("Only firms or only people."),
        limit: z.number().int().min(1).max(50).optional().describe("Max results. Defaults to 10."),
      },
    },
    async ({ query, domain, linkedin_url, at_firm_domain, type, limit }) => {
      try {
        // Roster mode: list people linked to a firm via investor_affiliations.
        if (at_firm_domain) {
          const firm = await findFirmByDomain(at_firm_domain);
          if (!firm) {
            return textResult(
              `No firm with domain ${cleanDomain(at_firm_domain) ?? at_firm_domain} in the database.` +
                (auth.isAdmin ? " Add it with add_investor first." : ""),
            );
          }
          const { data: affs, error: affErr } = await admin
            .from("investor_affiliations")
            .select("person_id")
            .eq("firm_id", firm.id)
            .limit(200);
          if (affErr) return errorResult(`Could not load affiliations: ${affErr.message}`);
          if (!affs || affs.length === 0) {
            return textResult(
              `Firm "${firm.name}" (id: ${firm.id}) has no people linked yet.` +
                (auth.isAdmin
                  ? " Add people with add_investor (type=person, firm_domain=" +
                    `${cleanDomain(at_firm_domain)}) or link existing ones via update_investor.`
                  : ""),
            );
          }
          const { data: people, error: pplErr } = await admin
            .from("investors")
            .select("id, type, name, domain, linkedin_url, role, tier, investor_type, hq_country")
            .in("id", affs.map((a) => a.person_id))
            .limit(limit ?? 50);
          if (pplErr) return errorResult(`Could not load people: ${pplErr.message}`);
          return textResult(
            `Firm "${firm.name}" (id: ${firm.id}) has ${affs.length} linked person(s):\n` +
              (people ?? []).map(investorLine).join("\n"),
          );
        }

        const cleanedDomain = domain ? cleanDomain(domain) : null;
        if (domain && !cleanedDomain) return errorResult(`"${domain}" does not look like a valid domain.`);
        const linkedinPath = linkedin_url ? cleanLinkedinPath(linkedin_url) : null;
        if (linkedin_url && !linkedinPath) {
          return errorResult(`"${linkedin_url}" does not look like a LinkedIn URL or path.`);
        }

        let q = admin
          .from("investors")
          .select("id, type, name, domain, linkedin_url, role, tier, investor_type, hq_country")
          .limit(limit ?? 10);

        if (cleanedDomain) q = q.eq("domain", cleanedDomain);
        else if (linkedinPath) q = q.eq("linkedin_url", linkedinPath);
        else if (query?.trim()) q = q.ilike("name", `%${query.trim()}%`);
        else return errorResult("Provide at least one of: query, domain, or linkedin_url.");
        if (type) q = q.eq("type", type);

        let { data, error } = await q;
        if (error) return errorResult(`Search failed: ${error.message}`);

        // LinkedIn person URLs often differ only by a trailing numeric suffix
        // (in/anton-generalov vs in/anton-generalov-a2827281): fall back to a
        // username-prefix match, mirroring the app's duplicate check.
        if ((!data || data.length === 0) && linkedinPath?.startsWith("in/")) {
          const username = linkedinPath.replace(/^in\//, "").replace(/-[a-z0-9]+$/i, "");
          if (username) {
            const { data: prefixData } = await admin
              .from("investors")
              .select("id, type, name, domain, linkedin_url, role, tier, investor_type, hq_country")
              .like("linkedin_url", `in/${username}%`)
              .eq("type", "person")
              .limit(limit ?? 10);
            if (prefixData && prefixData.length > 0) data = prefixData;
          }
        }

        if (!data || data.length === 0) {
          // Not in investors — is it on the not-an-investor skip-list?
          if (await checkNotAnInvestor(cleanedDomain, linkedinPath)) {
            return textResult(
              "No matching investor found, and this domain/LinkedIn is marked as NOT an investor " +
                "(previously researched and rejected). Do not add it unless the user explicitly overrides.",
            );
          }
          return textResult(
            "No matching investors found." +
              (auth.isAdmin ? " You can add one with add_investor." : ""),
          );
        }
        return textResult(`Found ${data.length} investor(s):\n${data.map(investorLine).join("\n")}`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "list_fundings",
    {
      title: "List new fundings",
      description:
        "List recently funded companies from the new_fundings table, newest funding date first. " +
        "Optionally filter by company name or domain. Use get_funding for the full detail of one row.",
      inputSchema: {
        search: z.string().optional().describe("Filter by company name or domain (case-insensitive substring)."),
        limit: z.number().int().min(1).max(100).optional().describe("Items per page. Defaults to 20."),
        offset: z.number().int().min(0).optional().describe("Paging offset. Defaults to 0."),
      },
    },
    async ({ search, limit, offset }) => {
      try {
        const pageSize = limit ?? 20;
        const from = offset ?? 0;
        let q = admin
          .from("new_fundings")
          .select("id, name, domain, how_much_funding, funding_date, what_they_do, investors", { count: "exact" })
          .order("funding_date", { ascending: false, nullsFirst: false })
          .range(from, from + pageSize - 1);
        if (search?.trim()) {
          const s = search.trim();
          q = q.or(`name.ilike.%${s}%,domain.ilike.%${s}%`);
        }
        const { data, error, count } = await q;
        if (error) return errorResult(`Could not load fundings: ${error.message}`);
        if (!data || data.length === 0) return textResult("No fundings found for these filters.");

        const lines = data.map((f) => {
          const parts = [`- ${f.name ?? "Unnamed"}${f.domain ? ` (${f.domain})` : ""} | id: ${f.id}`];
          if (typeof f.how_much_funding === "number") parts.push(formatUsd(f.how_much_funding));
          const date = formatDate(f.funding_date);
          if (date) parts.push(date);
          const invCount = Array.isArray(f.investors) ? f.investors.length : 0;
          if (invCount) parts.push(`${invCount} investor(s)`);
          if (f.what_they_do) parts.push(String(f.what_they_do).slice(0, 100));
          return parts.join(" | ");
        });

        const total = count ?? data.length;
        const shownTo = from + data.length;
        const pagingHint = shownTo < total ? `\n\nMore available: call again with offset=${shownTo}.` : "";
        return textResult(`Showing ${from + 1}-${shownTo} of ${total} fundings:\n${lines.join("\n")}${pagingHint}`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_funding",
    {
      title: "Get funding details",
      description:
        "Get the full record of one funding (all fields, including the complete founders and investors lists). " +
        "Look up by funding id or by company domain. Call this before update_funding when you need the current values.",
      inputSchema: {
        funding_id: z.string().optional().describe("The funding row id (from list_fundings)."),
        domain: z.string().optional().describe("Company domain, e.g. acme.com."),
      },
    },
    async ({ funding_id, domain }) => {
      try {
        let q = admin.from("new_fundings").select("*").limit(1);
        if (funding_id) q = q.eq("id", funding_id);
        else if (domain) {
          const clean = cleanDomain(domain);
          if (!clean) return errorResult(`"${domain}" does not look like a valid domain.`);
          q = q.eq("domain", clean);
        } else {
          return errorResult("Provide funding_id or domain.");
        }
        const { data, error } = await q.maybeSingle();
        if (error) return errorResult(`Could not load the funding: ${error.message}`);
        if (!data) return textResult("No funding found for that id/domain.");
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // Write tools — admin accounts only (not registered for other users)
  // -------------------------------------------------------------------------

  if (auth.isAdmin) {
    server.registerTool(
      "add_investor",
      {
        title: "Add investor (admin)",
        description:
          "Add a new investor to the database: a firm (identified by domain) or a person (identified by LinkedIn URL). " +
          "If an investor with the same domain/LinkedIn already exists, nothing is created and the existing id is returned — " +
          "use update_investor for changes. For a person you can pass firm_domain to link them to their firm.",
        inputSchema: {
          type: z.enum(["firm", "person"]).describe("firm = investment firm/fund; person = individual investor/angel."),
          name: z.string().min(1).describe("Clean display name, e.g. 'Accel' or 'Naval Ravikant' (no legal suffixes)."),
          domain: z
            .string()
            .optional()
            .describe("Firm website domain, e.g. accel.com. REQUIRED for type=firm."),
          linkedin_url: z
            .string()
            .optional()
            .describe("LinkedIn URL or path, e.g. linkedin.com/in/naval. REQUIRED for type=person."),
          firm_domain: z
            .string()
            .optional()
            .describe("For people: the domain of the firm they belong to — links the person to that firm."),
          ...investorProfileShape,
        },
      },
      async (input) => {
        try {
          const { type, name, domain, linkedin_url, firm_domain } = input;

          const cleanedDomain = domain ? cleanDomain(domain) : null;
          const linkedinPath = linkedin_url ? cleanLinkedinPath(linkedin_url) : null;

          if (type === "firm" && !cleanedDomain) {
            return errorResult("A firm needs a valid domain (e.g. accel.com).");
          }
          if (type === "person" && !linkedinPath) {
            return errorResult("A person needs a valid LinkedIn URL (e.g. linkedin.com/in/naval).");
          }

          // Duplicate check on both identifiers.
          if (cleanedDomain) {
            const { data } = await admin
              .from("investors")
              .select("id, name, type")
              .eq("domain", cleanedDomain)
              .limit(1)
              .maybeSingle();
            if (data?.id) {
              return textResult(
                `An investor with domain ${cleanedDomain} already exists: "${data.name}" (${data.type}), id: ${data.id}. ` +
                  `Nothing was created — use update_investor to change it.`,
              );
            }
          }
          if (linkedinPath) {
            const { data } = await admin
              .from("investors")
              .select("id, name, type")
              .eq("linkedin_url", linkedinPath)
              .limit(1)
              .maybeSingle();
            if (data?.id) {
              return textResult(
                `An investor with LinkedIn linkedin.com/${linkedinPath} already exists: "${data.name}" (${data.type}), id: ${data.id}. ` +
                  `Nothing was created — use update_investor to change it.`,
              );
            }
          }

          const id = crypto.randomUUID();
          const row: Record<string, unknown> = {
            id,
            type,
            name: name.trim(),
            domain: cleanedDomain,
            linkedin_url: linkedinPath,
            ...pickProfileFields(input as Record<string, unknown>),
          };

          const { error } = await admin.from("investors").insert(row);
          if (error) return errorResult(`Could not add the investor: ${error.message}`);

          const notes: string[] = [`Added ${type} "${name.trim()}" | id: ${id}`];
          if (cleanedDomain) notes.push(`domain: ${cleanedDomain}`);
          if (linkedinPath) notes.push(`linkedin: linkedin.com/${linkedinPath}`);

          // The admin explicitly confirmed this is an investor — clear any stale
          // not-an-investor marking so pipelines don't contradict the new row.
          if (await checkNotAnInvestor(cleanedDomain, linkedinPath)) {
            if (cleanedDomain) await admin.from("not_an_investor").delete().eq("domain", cleanedDomain);
            if (linkedinPath) await admin.from("not_an_investor").delete().eq("linkedin_url", linkedinPath);
            notes.push("note: this identifier was on the not-an-investor list; the stale marking was removed.");
          }

          // Optional person → firm affiliation.
          if (type === "person" && firm_domain) {
            const firm = await findFirmByDomain(firm_domain);
            if (firm) {
              await ensureAffiliation(id, firm.id);
              notes.push(`linked to firm "${firm.name}" (${firm.id})`);
            } else {
              notes.push(
                `note: no firm with domain ${cleanDomain(firm_domain) ?? firm_domain} exists yet — ` +
                  `add it with add_investor (type=firm) first, then update_investor with firm_domain to link them.`,
              );
            }
          }

          return textResult(notes.join("\n"));
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      "update_investor",
      {
        title: "Update investor (admin)",
        description:
          "Update an existing investor (firm or person). Locate it by investor_id, domain, or linkedin_url; " +
          "only the fields you pass are changed. Array fields (stages, industries, notable_investments, ...) replace " +
          "the stored value entirely. Pass firm_domain to link a person to a firm.",
        inputSchema: {
          investor_id: z.string().optional().describe("Investor id (preferred — from find_investors)."),
          domain: z.string().optional().describe("Locate a firm by its domain, e.g. accel.com."),
          linkedin_url: z.string().optional().describe("Locate a person by LinkedIn URL/path."),
          name: z.string().optional().describe("New display name."),
          new_domain: z.string().optional().describe("Change the stored domain (firms)."),
          new_linkedin_url: z.string().optional().describe("Change the stored LinkedIn URL (people)."),
          firm_domain: z
            .string()
            .optional()
            .describe("For people: domain of the firm to link them to (creates the affiliation if missing)."),
          ...investorProfileShape,
        },
      },
      async (input) => {
        try {
          const { investor_id, domain, linkedin_url, name, new_domain, new_linkedin_url, firm_domain } = input;

          // Locate the investor.
          let q = admin.from("investors").select("id, type, name, domain, linkedin_url").limit(1);
          if (investor_id) q = q.eq("id", investor_id);
          else if (domain) {
            const clean = cleanDomain(domain);
            if (!clean) return errorResult(`"${domain}" does not look like a valid domain.`);
            q = q.eq("domain", clean);
          } else if (linkedin_url) {
            const path = cleanLinkedinPath(linkedin_url);
            if (!path) return errorResult(`"${linkedin_url}" does not look like a LinkedIn URL or path.`);
            q = q.eq("linkedin_url", path);
          } else {
            return errorResult("Provide investor_id, domain, or linkedin_url to locate the investor.");
          }
          const { data: existing, error: findErr } = await q.maybeSingle();
          if (findErr) return errorResult(`Lookup failed: ${findErr.message}`);
          if (!existing?.id) {
            return textResult("No matching investor found. Use find_investors to search, or add_investor to create one.");
          }

          // Build the patch from provided fields only.
          const patch: Record<string, unknown> = pickProfileFields(input as Record<string, unknown>);
          if (name !== undefined) patch.name = name.trim();
          if (new_domain !== undefined) {
            const clean = cleanDomain(new_domain);
            if (!clean) return errorResult(`"${new_domain}" does not look like a valid domain.`);
            patch.domain = clean;
          }
          if (new_linkedin_url !== undefined) {
            const path = cleanLinkedinPath(new_linkedin_url);
            if (!path) return errorResult(`"${new_linkedin_url}" does not look like a LinkedIn URL or path.`);
            patch.linkedin_url = path;
          }

          const updatedFields = Object.keys(patch);
          if (updatedFields.length > 0) {
            const { error: updErr } = await admin.from("investors").update(patch).eq("id", existing.id);
            if (updErr) return errorResult(`Could not update the investor: ${updErr.message}`);
          }

          const notes: string[] = [
            updatedFields.length > 0
              ? `Updated "${existing.name}" (${existing.type}, id: ${existing.id}) | fields: ${updatedFields.join(", ")}`
              : `No fields to update for "${existing.name}" (id: ${existing.id}).`,
          ];

          if (firm_domain) {
            if (existing.type !== "person") {
              notes.push("note: firm_domain was ignored because this investor is a firm, not a person.");
            } else {
              const firm = await findFirmByDomain(firm_domain);
              if (firm) {
                await ensureAffiliation(existing.id, firm.id);
                notes.push(`linked to firm "${firm.name}" (${firm.id})`);
              } else {
                notes.push(
                  `note: no firm with domain ${cleanDomain(firm_domain) ?? firm_domain} exists yet — add it first with add_investor.`,
                );
              }
            }
          }

          return textResult(notes.join("\n"));
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      "mark_not_an_investor",
      {
        title: "Mark as not an investor (admin)",
        description:
          "Record that a researched domain/LinkedIn is NOT an investor, so future research skips it " +
          "(mirrors the app's not_an_investor tracking). Use after research clearly shows the entity does not invest capital. " +
          "Does not touch the investors table.",
        inputSchema: {
          domain: z.string().optional().describe("The non-investor's website domain, e.g. acme.com."),
          linkedin_url: z.string().optional().describe("The non-investor's LinkedIn URL or path."),
          reason: z.string().optional().describe("Optional short status note, e.g. 'consulting firm, no investments'."),
        },
      },
      async ({ domain, linkedin_url, reason }) => {
        try {
          const cleanedDomain = domain ? cleanDomain(domain) : null;
          if (domain && !cleanedDomain) return errorResult(`"${domain}" does not look like a valid domain.`);
          const linkedinPath = linkedin_url ? cleanLinkedinPath(linkedin_url) : null;
          if (linkedin_url && !linkedinPath) {
            return errorResult(`"${linkedin_url}" does not look like a LinkedIn URL or path.`);
          }
          if (!cleanedDomain && !linkedinPath) return errorResult("Provide domain or linkedin_url.");

          // Upsert semantics matching the app: find by domain, then linkedin.
          let existingId: string | null = null;
          if (cleanedDomain) {
            const { data } = await admin
              .from("not_an_investor")
              .select("id")
              .eq("domain", cleanedDomain)
              .limit(1)
              .maybeSingle();
            existingId = data?.id ?? null;
          }
          if (!existingId && linkedinPath) {
            const { data } = await admin
              .from("not_an_investor")
              .select("id")
              .eq("linkedin_url", linkedinPath)
              .limit(1)
              .maybeSingle();
            existingId = data?.id ?? null;
          }

          if (existingId) {
            const patch: Record<string, unknown> = { status: reason ?? null };
            if (cleanedDomain) patch.domain = cleanedDomain;
            if (linkedinPath) patch.linkedin_url = linkedinPath;
            const { error } = await admin.from("not_an_investor").update(patch).eq("id", existingId);
            if (error) return errorResult(`Could not update the not-an-investor record: ${error.message}`);
            return textResult(`Already on the not-an-investor list — record updated (id: ${existingId}).`);
          }

          const id = crypto.randomUUID();
          const { error } = await admin.from("not_an_investor").insert({
            id,
            domain: cleanedDomain,
            linkedin_url: linkedinPath,
            status: reason ?? null,
          });
          if (error) return errorResult(`Could not record the non-investor: ${error.message}`);
          return textResult(
            `Marked ${cleanedDomain ?? `linkedin.com/${linkedinPath}`} as not an investor (id: ${id}). ` +
              "Future research will skip it.",
          );
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      "add_funding",
      {
        title: "Add funding (admin)",
        description:
          "Record a new funding round in new_fundings. Upserts by company domain, exactly like the app: " +
          "if a row for that domain already exists it is UPDATED with the provided values, otherwise a new row is created. " +
          "Amounts are plain USD numbers (5000000 for $5M); dates are YYYY-MM-DD; founders/investors are " +
          '"[Name](url)" strings — url is the firm domain for firms and the LinkedIn URL for individuals.',
        inputSchema: {
          name: z.string().min(1).describe("Company name without legal suffixes, e.g. 'Acme'."),
          domain: z.string().optional().describe("Company website domain, e.g. acme.com. Strongly recommended (used for dedupe)."),
          funding_date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
            .optional()
            .describe("Funding announcement date in YYYY-MM-DD."),
          how_much_funding: z.number().int().nonnegative().optional().describe("Round size in USD, e.g. 5000000 for $5M."),
          founders: z
            .array(z.string())
            .optional()
            .describe('Founders as "[Name](linkedin_url)" strings, e.g. ["[Jane Doe](linkedin.com/in/janedoe)"].'),
          investors: z
            .array(z.string())
            .optional()
            .describe('All investors (earliest round first) as "[Name](url)" strings — domain for firms, LinkedIn for people.'),
          what_they_do: z.string().optional().describe("One line: what the company does."),
          usp: z.string().optional().describe("One line: unique selling proposition."),
          founded_in_year: z.number().int().min(1800).max(2100).optional().describe("Year founded, e.g. 2023."),
        },
      },
      async ({ name, domain, funding_date, how_much_funding, founders, investors, what_they_do, usp, founded_in_year }) => {
        try {
          const cleanedDomain = domain ? cleanDomain(domain) : null;
          if (domain && !cleanedDomain) return errorResult(`"${domain}" does not look like a valid domain.`);

          const row: Record<string, unknown> = { name: name.trim() };
          if (cleanedDomain) row.domain = cleanedDomain;
          if (funding_date !== undefined) row.funding_date = funding_date;
          if (how_much_funding !== undefined) row.how_much_funding = how_much_funding;
          if (founders !== undefined) row.founders = founders.map(parseNameUrl);
          if (investors !== undefined) row.investors = investors.map(parseNameUrl);
          if (what_they_do !== undefined) row.what_they_do = what_they_do;
          if (usp !== undefined) row.usp = usp;
          if (founded_in_year !== undefined) row.founded_in_year = founded_in_year;

          let existedBefore = false;
          let data: Record<string, unknown> | null = null;

          if (cleanedDomain) {
            const { data: existing } = await admin
              .from("new_fundings")
              .select("id")
              .eq("domain", cleanedDomain)
              .maybeSingle();
            existedBefore = !!existing?.id;
            const { data: upserted, error } = await admin
              .from("new_fundings")
              .upsert(row, { onConflict: "domain" })
              .select()
              .single();
            if (error) return errorResult(`Could not save the funding: ${error.message}`);
            data = upserted;
          } else {
            const { data: inserted, error } = await admin.from("new_fundings").insert(row).select().single();
            if (error) return errorResult(`Could not save the funding: ${error.message}`);
            data = inserted;
          }

          const amount = formatUsd(how_much_funding);
          return textResult(
            `${existedBefore ? "Updated existing" : "Added"} funding for ${name.trim()}` +
              `${cleanedDomain ? ` (${cleanedDomain})` : ""}${amount ? ` — ${amount}` : ""}` +
              `${funding_date ? ` on ${formatDate(funding_date) || funding_date}` : ""}.\n` +
              `id: ${data?.id}`,
          );
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      "add_fundings_bulk",
      {
        title: "Add fundings in bulk (admin)",
        description:
          "Record many funding rounds in ONE call — same fields and upsert-by-domain behavior as add_funding, applied per row. " +
          "Use when multiple researched rows are ready to write (a prepared batch, or recovery after an auth failure), " +
          "instead of many add_funding calls. Returns a per-row added/updated/error report.",
        inputSchema: {
          fundings: z
            .array(
              z.object({
                name: z.string().min(1).describe("Company name without legal suffixes."),
                domain: z.string().optional().describe("Company domain, e.g. acme.com (used for dedupe)."),
                funding_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional(),
                how_much_funding: z.number().int().nonnegative().optional().describe("Round size in USD."),
                founders: z.array(z.string()).optional().describe('"[Name](linkedin_url)" strings.'),
                investors: z.array(z.string()).optional().describe('"[Name](url)" strings, earliest round first.'),
                what_they_do: z.string().optional(),
                usp: z.string().optional(),
                founded_in_year: z.number().int().min(1800).max(2100).optional(),
              }),
            )
            .min(1)
            .max(50)
            .describe("Up to 50 funding rows."),
        },
      },
      async ({ fundings }) => {
        const lines: string[] = [];
        let added = 0, updated = 0, failed = 0;
        for (const f of fundings) {
          try {
            const cleanedDomain = f.domain ? cleanDomain(f.domain) : null;
            if (f.domain && !cleanedDomain) {
              failed++;
              lines.push(`- ERROR ${f.name}: "${f.domain}" is not a valid domain`);
              continue;
            }
            const row: Record<string, unknown> = { name: f.name.trim() };
            if (cleanedDomain) row.domain = cleanedDomain;
            if (f.funding_date !== undefined) row.funding_date = f.funding_date;
            if (f.how_much_funding !== undefined) row.how_much_funding = f.how_much_funding;
            if (f.founders !== undefined) row.founders = f.founders.map(parseNameUrl);
            if (f.investors !== undefined) row.investors = f.investors.map(parseNameUrl);
            if (f.what_they_do !== undefined) row.what_they_do = f.what_they_do;
            if (f.usp !== undefined) row.usp = f.usp;
            if (f.founded_in_year !== undefined) row.founded_in_year = f.founded_in_year;

            let existedBefore = false;
            if (cleanedDomain) {
              const { data: existing } = await admin
                .from("new_fundings")
                .select("id")
                .eq("domain", cleanedDomain)
                .maybeSingle();
              existedBefore = !!existing?.id;
              const { error } = await admin.from("new_fundings").upsert(row, { onConflict: "domain" });
              if (error) throw new Error(error.message);
            } else {
              const { error } = await admin.from("new_fundings").insert(row);
              if (error) throw new Error(error.message);
            }
            if (existedBefore) { updated++; lines.push(`- updated ${f.name} (${cleanedDomain})`); }
            else { added++; lines.push(`- added ${f.name}${cleanedDomain ? ` (${cleanedDomain})` : ""}`); }
          } catch (err) {
            failed++;
            lines.push(`- ERROR ${f.name}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        return textResult(
          `Bulk write finished: ${added} added, ${updated} updated, ${failed} failed of ${fundings.length}.\n${lines.join("\n")}`,
        );
      },
    );

    server.registerTool(
      "update_funding",
      {
        title: "Update funding (admin)",
        description:
          "Update fields of an existing funding row. Locate it by funding_id or domain; only the fields you pass are changed. " +
          "founders/investors REPLACE the stored lists — call get_funding first and resend the full list when adding or removing one entry.",
        inputSchema: {
          funding_id: z.string().optional().describe("Funding row id (from list_fundings / get_funding)."),
          domain: z.string().optional().describe("Locate by company domain, e.g. acme.com."),
          name: z.string().optional().describe("New company name."),
          new_domain: z.string().optional().describe("Change the stored domain."),
          funding_date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
            .optional()
            .describe("New funding date in YYYY-MM-DD."),
          how_much_funding: z.number().int().nonnegative().optional().describe("New round size in USD."),
          founders: z.array(z.string()).optional().describe('Full replacement founders list as "[Name](url)" strings.'),
          investors: z.array(z.string()).optional().describe('Full replacement investors list as "[Name](url)" strings.'),
          what_they_do: z.string().optional().describe("New one-line description."),
          usp: z.string().optional().describe("New unique selling proposition."),
          founded_in_year: z.number().int().min(1800).max(2100).optional().describe("New founding year."),
        },
      },
      async ({ funding_id, domain, name, new_domain, funding_date, how_much_funding, founders, investors, what_they_do, usp, founded_in_year }) => {
        try {
          let q = admin.from("new_fundings").select("id, name, domain").limit(1);
          if (funding_id) q = q.eq("id", funding_id);
          else if (domain) {
            const clean = cleanDomain(domain);
            if (!clean) return errorResult(`"${domain}" does not look like a valid domain.`);
            q = q.eq("domain", clean);
          } else {
            return errorResult("Provide funding_id or domain to locate the funding.");
          }
          const { data: existing, error: findErr } = await q.maybeSingle();
          if (findErr) return errorResult(`Lookup failed: ${findErr.message}`);
          if (!existing?.id) {
            return textResult("No matching funding found. Use list_fundings to search, or add_funding to create one.");
          }

          const patch: Record<string, unknown> = {};
          if (name !== undefined) patch.name = name.trim();
          if (new_domain !== undefined) {
            const clean = cleanDomain(new_domain);
            if (!clean) return errorResult(`"${new_domain}" does not look like a valid domain.`);
            patch.domain = clean;
          }
          if (funding_date !== undefined) patch.funding_date = funding_date;
          if (how_much_funding !== undefined) patch.how_much_funding = how_much_funding;
          if (founders !== undefined) patch.founders = founders.map(parseNameUrl);
          if (investors !== undefined) patch.investors = investors.map(parseNameUrl);
          if (what_they_do !== undefined) patch.what_they_do = what_they_do;
          if (usp !== undefined) patch.usp = usp;
          if (founded_in_year !== undefined) patch.founded_in_year = founded_in_year;

          const updatedFields = Object.keys(patch);
          if (updatedFields.length === 0) {
            return textResult(`No fields to update for ${existing.name ?? existing.domain} (id: ${existing.id}).`);
          }

          const { error: updErr } = await admin.from("new_fundings").update(patch).eq("id", existing.id);
          if (updErr) return errorResult(`Could not update the funding: ${updErr.message}`);

          return textResult(
            `Updated funding for ${existing.name ?? existing.domain} (id: ${existing.id}) | fields: ${updatedFields.join(", ")}`,
          );
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  }

  return server;
}

// ---------------------------------------------------------------------------
// HTTP routing (paths are prefixed with the function name by the gateway)
// ---------------------------------------------------------------------------

const protectedResourceMetadata = {
  resource: RESOURCE_URL,
  authorization_servers: [AUTH_SERVER_URL],
  bearer_methods_supported: ["header"],
  // No "openid" here on purpose: requesting it makes Supabase mint an OIDC ID
  // token, which requires asymmetric JWT signing keys (ES256/RS256). Until the
  // project migrates off the legacy HS256 secret, openid breaks /oauth/token
  // with "HS256 is not supported for ID token signing".
  scopes_supported: ["email", "profile"],
  resource_name: APP_NAME,
};

const app = new Hono().basePath("/capitalxai-mcp");

app.options("*", () => new Response(null, { status: 204, headers: CORS_HEADERS }));

const prmResponse = () =>
  new Response(JSON.stringify(protectedResourceMetadata), {
    headers: { ...CORS_HEADERS, "content-type": "application/json" },
  });

app.get("/.well-known/oauth-protected-resource", prmResponse);
// Some clients append the resource path when probing (RFC 9728 path-aware form).
app.get("/.well-known/oauth-protected-resource/mcp", prmResponse);
app.get("/mcp/.well-known/oauth-protected-resource", prmResponse);

app.all("/mcp", async (c) => {
  const auth = await authenticate(c.req.header("authorization"));
  if (!auth) return unauthorized();

  const server = buildServer(auth);
  const transport = new WebStandardStreamableHTTPServerTransport();
  await server.connect(transport);
  const response = await transport.handleRequest(c.req.raw);

  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
});

app.get("/", (c) =>
  c.json({
    name: "capitalxai-mcp",
    description: `MCP connector for ${APP_NAME} — manage investors and funding rounds`,
    website: APP_URL,
    icon: APP_LOGO_URL,
    mcp_endpoint: RESOURCE_URL,
    oauth_protected_resource: PRM_URL,
  }),
);

Deno.serve(app.fetch);
