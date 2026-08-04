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
  exits: z
    .array(z.string())
    .optional()
    .describe('Exits (acquisitions/IPOs) from this investor\'s portfolio as "[Company](url)" strings.'),
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
const CLEARABLE_FIELDS = new Set<string>(INVESTOR_PROFILE_KEYS);

/** Copy provided profile fields (only the ones the caller sent) into a row object. */
function pickProfileFields(input: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const key of INVESTOR_PROFILE_KEYS) {
    if (input[key] !== undefined) row[key] = input[key];
  }
  return row;
}

/** Follow HTTP redirects to the canonical domain (tenvc.com → 10vc.com).
 *  Returns the input domain when unreachable or the redirect target is unusable. */
async function resolveDomainRedirect(domain: string): Promise<string> {
  for (const method of ["HEAD", "GET"]) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch(`https://${domain}`, { method, redirect: "follow", signal: ctrl.signal });
      clearTimeout(timer);
      try { await res.body?.cancel(); } catch { /* body may already be consumed */ }
      const finalHost = new URL(res.url).hostname.replace(/^www\./, "").toLowerCase();
      if (
        finalHost && finalHost !== domain &&
        /[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(finalHost) &&
        !finalHost.includes("linkedin.com")
      ) {
        return finalHost;
      }
      return domain;
    } catch {
      // HEAD often blocked — retry with GET; if GET also fails, keep the input.
    }
  }
  return domain;
}

/** Find an investor whose domain OR alt_domains matches (redirect-safe lookup). */
async function findInvestorByAnyDomain(
  domain: string,
  select = "id, name, type, domain",
): Promise<Record<string, unknown> | null> {
  const { data } = await admin
    .from("investors")
    .select(select)
    .or(`domain.eq.${domain},alt_domains.cs.{${domain}}`)
    .limit(1)
    .maybeSingle();
  return (data as Record<string, unknown> | null) ?? null;
}

/** Merge per-field provenance: {field: source_url} in → {field: {source_url, verified_at}} stored. */
function mergeFieldSources(
  existing: unknown,
  sources: Record<string, string> | undefined,
): Record<string, unknown> | undefined {
  if (!sources || Object.keys(sources).length === 0) return undefined;
  const base = existing && typeof existing === "object" ? { ...(existing as Record<string, unknown>) } : {};
  const now = new Date().toISOString();
  for (const [field, url] of Object.entries(sources)) {
    if (typeof url === "string" && url.trim()) base[field] = { source_url: url.trim(), verified_at: now };
  }
  return base;
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
    .or(`domain.eq.${clean},alt_domains.cs.{${clean}}`)
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
  last_researched_at?: string | null;
}): string {
  const parts = [`- [${inv.type ?? "?"}] ${inv.name ?? "Unnamed"} | id: ${inv.id}`];
  if (inv.domain) parts.push(`domain: ${inv.domain}`);
  if (inv.linkedin_url) parts.push(`linkedin: linkedin.com/${inv.linkedin_url}`);
  if (inv.role) parts.push(`role: ${inv.role}`);
  if (inv.tier) parts.push(`tier: ${inv.tier}`);
  if (inv.investor_type?.length) parts.push(inv.investor_type.join(", "));
  if (inv.hq_country) parts.push(inv.hq_country);
  parts.push(`researched: ${formatDate(inv.last_researched_at) || "never/unknown"}`);
  return parts.join(" | ");
}

const INVESTOR_LINE_SELECT = "id, type, name, domain, linkedin_url, role, tier, investor_type, hq_country, last_researched_at";

// ---------------------------------------------------------------------------
// Investor fit analysis (mirrors /api/investor-analyze)
// ---------------------------------------------------------------------------

// Defaults copied from app/personalization/investorAnalyzeDefault.ts — used when
// user_settings.personalization has no override, exactly like the app.
const DEFAULT_INVESTOR_SYSTEM_PROMPT = `You are an investment analysis assistant. Your role is to evaluate <<COMPANY_NAME>>> using only the provided company information and determine whether it is a good fit for investment based on investor criteria.

You must:
- Analyze the business model and industry.
- Decide if the company is fundable by the given investor type.
- Clearly explain the reasoning.
- Generate short, natural sounding outreach personalization lines.
- Avoid hype, buzzwords, or salesy language.
- Keep tone professional, friendly, and human.
- Do not make assumptions beyond the provided data.
- Avoid marketing language or exaggeration.

Your response must strictly follow the JSON structure provided in the user message.
Do not add extra fields.
Do not add explanations outside the JSON.`;

const DEFAULT_INVESTOR_USER_MESSAGE_TEMPLATE = `<<<COMPANY_CONTEXT>>>

Investor Profile:
<<<DEEP_RESEARCH>>>

Return the result strictly in the following JSON format:
{
  "investor_fit": true | false | null,
  "reason": "Precise, short, clear explanation of why this company fits or does not fit the investor",
  "personalized_outreach_lines": [
    "I saw you...[additional <12 words, how the company aligns with their interests]..., which is why I'm reaching out to you about <<<COMPANY_NAME>>>.",
    "I believe [additional <12 words, how investor can help]... could greatly benefit us at <<<COMPANY_NAME>>>."
  ],
  "mutual_interests": ["upto 2, optional, precise and accurate, non-generic items such as common place or work, industry, college, etc."]
}

Follow exactly the above sentence structures for personalized_outreach_lines. These are emails openers leading with why them. Be specific and precise.`;

const DEFAULT_INVESTOR_TWITTER_PROMPT = `{name} posted these on Twitter:{allValidTweets}

Write a one-line friendly icebreaker after just reading any one of {first_name}'s tweets. Don't use hashtags. Keep it less than 120 characters. You don't know {first_name} or {first_name}'s skills personally. Do not ask question. Today is {dateString}. No questions. Don't use / (slash), Em Dashes (—), En Dashes (–) , and Hyphens (-)

Reply as a JSON with key:
{
  "twitter_line": "I just read your tweet..."
}`;

/** Look up a user id by login email (service role; the user base is small). */
async function findUserIdByEmail(email: string): Promise<string | null> {
  const target = email.trim().toLowerCase();
  if (!target) return null;
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error || !data?.users?.length) return null;
    const hit = data.users.find((u) => (u.email ?? "").toLowerCase() === target);
    if (hit) return hit.id;
    if (data.users.length < 1000) return null;
  }
  return null;
}

/** Locate one investor row by id, domain, or LinkedIn URL/path. */
async function findInvestorRow(
  select: string,
  investor_id?: string,
  domain?: string,
  linkedin_url?: string,
): Promise<{ row: Record<string, unknown> | null; error: string | null }> {
  let q = admin.from("investors").select(select).limit(1);
  if (investor_id) q = q.eq("id", investor_id);
  else if (domain) {
    const clean = cleanDomain(domain);
    if (!clean) return { row: null, error: `"${domain}" does not look like a valid domain.` };
    q = q.eq("domain", clean);
  } else if (linkedin_url) {
    const path = cleanLinkedinPath(linkedin_url);
    if (!path) return { row: null, error: `"${linkedin_url}" does not look like a LinkedIn URL or path.` };
    q = q.eq("linkedin_url", path);
  } else {
    return { row: null, error: "Provide investor_id, domain, or linkedin_url." };
  }
  const { data, error } = await q.maybeSingle();
  if (error) return { row: null, error: error.message };
  return { row: (data as Record<string, unknown> | null) ?? null, error: null };
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
        investor_type: z
          .array(z.string())
          .optional()
          .describe('Filter: investor categories, e.g. ["Venture Capital", "Angel Investor"].'),
        stages: z
          .array(z.string())
          .optional()
          .describe('Filter: investment stage slugs, e.g. ["pre-seed", "seed", "series-a"].'),
        industries: z.array(z.string()).optional().describe('Filter: industry slugs, e.g. ["saas", "fintech"].'),
        geographies: z
          .array(z.string())
          .optional()
          .describe('Filter: geography ISO codes or regions, e.g. ["US", "IN", "APAC"].'),
        tier: z.enum(["A", "B", "C"]).optional().describe("Filter: investor tier."),
        has_deep_research: z
          .boolean()
          .optional()
          .describe("Filter: true = only investors with research data (required for fit analysis)."),
        stale_older_than_days: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Filter: only investors last researched more than N days ago (or never) — for refresh sweeps."),
        limit: z.number().int().min(1).max(50).optional().describe("Max results. Defaults to 10."),
      },
    },
    async ({ query, domain, linkedin_url, at_firm_domain, type, investor_type, stages, industries, geographies, tier, has_deep_research, stale_older_than_days, limit }) => {
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
            .select(INVESTOR_LINE_SELECT)
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
          .select(INVESTOR_LINE_SELECT)
          .limit(limit ?? 10);

        const hasFilters = !!(
          investor_type?.length || stages?.length || industries?.length ||
          geographies?.length || tier || has_deep_research !== undefined || stale_older_than_days !== undefined
        );
        // Domain lookups also match alt_domains, so records survive domain changes/redirects.
        if (cleanedDomain) q = q.or(`domain.eq.${cleanedDomain},alt_domains.cs.{${cleanedDomain}}`);
        else if (linkedinPath) q = q.eq("linkedin_url", linkedinPath);
        else if (query?.trim()) q = q.ilike("name", `%${query.trim()}%`);
        else if (!hasFilters) {
          return errorResult("Provide a query, domain, linkedin_url, at_firm_domain, or at least one filter.");
        }
        if (type) q = q.eq("type", type);
        if (investor_type?.length) q = q.overlaps("investor_type", investor_type);
        if (stages?.length) q = q.overlaps("investment_stages", stages);
        if (industries?.length) q = q.overlaps("investment_industries", industries);
        if (geographies?.length) q = q.overlaps("investment_geographies", geographies);
        if (tier) q = q.eq("tier", tier);
        if (has_deep_research === true) q = q.not("deep_research", "is", null);
        if (has_deep_research === false) q = q.is("deep_research", null);
        if (stale_older_than_days !== undefined) {
          const cutoff = new Date(Date.now() - stale_older_than_days * 24 * 60 * 60 * 1000).toISOString();
          q = q.or(`last_researched_at.is.null,last_researched_at.lt.${cutoff}`);
        }

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
              .select(INVESTOR_LINE_SELECT)
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
  // Fit analysis tools — all users (own account); admins may target any user
  // -------------------------------------------------------------------------

  // Only admins get the user_email parameter — other users never see it exists.
  const targetUserParam = auth.isAdmin
    ? {
        user_email: z
          .string()
          .optional()
          .describe("Admin only: act on this user's account (their login email). Omit for your own account."),
      }
    : {};

  async function resolveTargetUser(
    user_email: string | undefined,
  ): Promise<{ userId: string; label: string } | { error: string }> {
    if (!user_email || !auth.isAdmin) return { userId: auth.userId, label: "your account" };
    const id = await findUserIdByEmail(user_email);
    if (!id) return { error: `No user found with email ${user_email}.` };
    return { userId: id, label: user_email };
  }

  server.registerTool(
    "get_investor",
    {
      title: "Get investor details",
      description:
        "Get one investor's full record (all profile fields including deep_research — the research text that " +
        "fit analysis is based on). Look up by investor id, firm domain, or LinkedIn URL.",
      inputSchema: {
        investor_id: z.string().optional().describe("Investor id (from find_investors)."),
        domain: z.string().optional().describe("Firm domain, e.g. accel.com."),
        linkedin_url: z.string().optional().describe("Person's LinkedIn URL or path."),
      },
    },
    async ({ investor_id, domain, linkedin_url }) => {
      try {
        const { row, error } = await findInvestorRow("*", investor_id, domain, linkedin_url);
        if (error) return errorResult(error);
        if (!row) return textResult("No matching investor found. Use find_investors to search.");
        return textResult(JSON.stringify(row, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_analysis_context",
    {
      title: "Get fit-analysis context",
      description:
        "Fetch everything needed to run an investor fit analysis (the app's 'Analyze with AI'): the account's " +
        "company name, onboarding/company data, plan, and the exact prompt templates to use (the account's custom " +
        "templates when set, otherwise the app defaults). Call this ONCE before analyzing a batch of investors.",
      inputSchema: { ...targetUserParam },
    },
    async (input) => {
      try {
        const target = await resolveTargetUser((input as { user_email?: string }).user_email);
        if ("error" in target) return errorResult(target.error);

        const { data: settings, error } = await admin
          .from("user_settings")
          .select("onboarding, personalization, plan")
          .eq("id", target.userId)
          .maybeSingle();
        if (error) return errorResult(`Could not load account settings: ${error.message}`);
        if (!settings) return errorResult("No account settings found for that user.");

        let personalization = settings.personalization as Record<string, unknown> | string | null;
        if (typeof personalization === "string") {
          try {
            personalization = JSON.parse(personalization);
          } catch {
            personalization = null;
          }
        }
        const p = (personalization ?? {}) as Record<string, Record<string, unknown>>;

        const onboarding = (settings.onboarding ?? null) as Record<string, Record<string, unknown>> | null;
        const primaryUse = (onboarding?.flowType ?? onboarding?.step0?.primaryUse) as string | undefined;
        const companyName =
          (primaryUse === "b2b"
            ? (onboarding?.b2bStep3?.companyName as string | undefined)?.trim()
            : (onboarding?.step5?.companyName as string | undefined)?.trim()) || "the company";

        const invOverride = p.investorAnalyze ?? {};
        const systemTemplate =
          typeof invOverride.systemPrompt === "string" ? invOverride.systemPrompt : DEFAULT_INVESTOR_SYSTEM_PROMPT;
        const userTemplate =
          typeof invOverride.userMessage === "string" && invOverride.userMessage.includes("<<<DEEP_RESEARCH>>>")
            ? invOverride.userMessage
            : DEFAULT_INVESTOR_USER_MESSAGE_TEMPLATE;
        const twitterTemplate =
          typeof p.investorTwitter?.prompt === "string" ? p.investorTwitter.prompt : DEFAULT_INVESTOR_TWITTER_PROMPT;

        return textResult(
          JSON.stringify(
            {
              target: target.label,
              company_name: companyName,
              plan: settings.plan ?? "free",
              onboarding,
              templates: {
                system_prompt: systemTemplate,
                user_message: userTemplate,
                twitter_icebreaker: twitterTemplate,
              },
              placeholder_notes:
                "Replace <<COMPANY_NAME>>> in system_prompt and <<<COMPANY_NAME>>> in user_message with company_name; " +
                "<<<COMPANY_CONTEXT>>> with a company summary built strictly from the onboarding data; " +
                "<<<DEEP_RESEARCH>>> with the investor's deep_research text (from get_investor).",
            },
            null,
            2,
          ),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "list_analyzed_investors",
    {
      title: "List already-analyzed investors",
      description:
        "List the investors that already have a saved fit analysis for an account (so batch runs can skip them). " +
        "Returns investor id/name/identifier, the stored fit verdict, and when it was analyzed. " +
        "Re-analyzing an investor overwrites its stored result.",
      inputSchema: {
        ...targetUserParam,
        fit: z
          .enum(["true", "false", "null"])
          .optional()
          .describe("Only analyses with this fit verdict (true / false / null=undetermined). Omit for all."),
        limit: z.number().int().min(1).max(200).optional().describe("Max results. Defaults to 100."),
        offset: z.number().int().min(0).optional().describe("Paging offset. Defaults to 0."),
      },
    },
    async (input) => {
      try {
        const { fit, limit, offset } = input as { user_email?: string; fit?: string; limit?: number; offset?: number };
        const target = await resolveTargetUser(input.user_email as string | undefined);
        if ("error" in target) return errorResult(target.error);

        const from = offset ?? 0;
        const pageSize = limit ?? 100;
        const { data: rows, error, count } = await admin
          .from("investor_personalization")
          .select("investor_id, ai_metadata, updated_at", { count: "exact" })
          .eq("user_id", target.userId)
          .not("ai_metadata", "is", null)
          .order("updated_at", { ascending: false })
          .range(from, from + pageSize - 1);
        if (error) return errorResult(`Could not load analyses: ${error.message}`);

        let entries = (rows ?? []).map((r) => ({
          investor_id: r.investor_id as string,
          fit: (r.ai_metadata as Record<string, unknown> | null)?.investor_fit ?? null,
          updated_at: r.updated_at as string | null,
        }));
        if (fit !== undefined) {
          const want = fit === "true" ? true : fit === "false" ? false : null;
          entries = entries.filter((e) => e.fit === want);
        }
        if (entries.length === 0) {
          return textResult(`No ${fit !== undefined ? `fit=${fit} ` : ""}analyses saved yet for ${target.label}.`);
        }

        const { data: investors } = await admin
          .from("investors")
          .select("id, name, type, domain, linkedin_url")
          .in("id", entries.map((e) => e.investor_id));
        const byId = new Map((investors ?? []).map((i) => [i.id as string, i]));

        const lines = entries.map((e) => {
          const inv = byId.get(e.investor_id);
          const ident = inv?.domain ?? (inv?.linkedin_url ? `linkedin.com/${inv.linkedin_url}` : "");
          const fitLabel = e.fit === true ? "fit" : e.fit === false ? "not-fit" : "undetermined";
          return `- ${inv?.name ?? e.investor_id}${ident ? ` (${ident})` : ""} | ${fitLabel} | analyzed ${formatDate(e.updated_at) || "unknown"} | id: ${e.investor_id}`;
        });
        const total = count ?? entries.length;
        const pagingHint = from + (rows?.length ?? 0) < total ? `\n\nMore available: offset=${from + (rows?.length ?? 0)}.` : "";
        return textResult(
          `${entries.length} analyzed investor(s) for ${target.label}${fit !== undefined ? ` (fit=${fit})` : ""}:\n${lines.join("\n")}${pagingHint}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "save_investor_analysis",
    {
      title: "Save investor fit analysis",
      description:
        "Save an investor fit analysis result to an account's personalization (what the app's 'Analyze with AI' " +
        "button stores). Locate the investor by id, domain, or LinkedIn URL. Only saves for the analyzed account; " +
        "the shared investor record is not modified.",
      inputSchema: {
        investor_id: z.string().optional().describe("Investor id (preferred)."),
        domain: z.string().optional().describe("Firm domain, e.g. accel.com."),
        linkedin_url: z.string().optional().describe("Person's LinkedIn URL or path."),
        ...targetUserParam,
        investor_fit: z
          .boolean()
          .nullable()
          .describe("true = good fit, false = not a fit, null = could not determine."),
        reason: z.string().optional().describe("Precise, short explanation of why it fits or not."),
        line1: z
          .string()
          .optional()
          .describe('Outreach line 1: "I saw you..., which is why I\'m reaching out to you about <company>."'),
        line2: z
          .string()
          .optional()
          .describe('Outreach line 2: "I believe ... could greatly benefit us at <company>."'),
        mutual_interests: z
          .array(z.string())
          .max(2)
          .optional()
          .describe("Up to 2 precise, non-generic mutual interests (common place, work, industry, college)."),
        twitter_line: z
          .string()
          .max(120)
          .optional()
          .describe("Optional Twitter icebreaker (<120 chars, no hashtags/questions/dashes); only when fit is true."),
      },
    },
    async (input) => {
      try {
        const { investor_id, domain, linkedin_url, investor_fit, reason, line1, line2, mutual_interests, twitter_line } =
          input as {
            investor_id?: string; domain?: string; linkedin_url?: string; user_email?: string;
            investor_fit: boolean | null; reason?: string; line1?: string; line2?: string;
            mutual_interests?: string[]; twitter_line?: string;
          };
        const target = await resolveTargetUser(input.user_email as string | undefined);
        if ("error" in target) return errorResult(target.error);

        const { row, error } = await findInvestorRow("id, name", investor_id, domain, linkedin_url);
        if (error) return errorResult(error);
        if (!row) return textResult("No matching investor found — check the id/domain/LinkedIn.");

        // Same ai_metadata shape as the app's /api/investor-analyze route.
        const newAiMetadata: Record<string, unknown> = {
          investor_fit: investor_fit ?? null,
          reason: reason ?? null,
          line1: line1 ?? "",
          line2: line2 ?? "",
          mutual_interests: mutual_interests ?? [],
          ...(twitter_line ? { twitter_line: twitter_line.slice(0, 120) } : {}),
        };

        const { error: rpcError } = await admin.rpc("upsert_investor_ai_metadata", {
          p_user_id: target.userId,
          p_investor_id: row.id,
          new_ai_metadata: newAiMetadata,
        });
        if (rpcError) return errorResult(`Could not save the analysis: ${rpcError.message}`);

        return textResult(
          `Saved analysis for ${row.name} to ${target.label}: ` +
            `fit=${investor_fit === null ? "undetermined" : investor_fit}` +
            (reason ? ` | ${reason.slice(0, 140)}` : ""),
        );
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
          firm_domains: z
            .array(z.string())
            .optional()
            .describe("For people with multiple firms: domains of ALL firms they belong to (each gets an affiliation)."),
          sources: z
            .record(z.string(), z.string())
            .optional()
            .describe('Per-field provenance: {"fund_size_usd": "https://source-url", ...} — stored with verified_at timestamps.'),
          mark_researched: z
            .boolean()
            .optional()
            .describe("Set true after a full research pass to stamp last_researched_at (automatic when deep_research is provided)."),
          ...investorProfileShape,
        },
      },
      async (input) => {
        try {
          const { type, name, domain, linkedin_url, firm_domain, firm_domains, sources, mark_researched } = input;

          let cleanedDomain = domain ? cleanDomain(domain) : null;
          const linkedinPath = linkedin_url ? cleanLinkedinPath(linkedin_url) : null;

          if (type === "firm" && !cleanedDomain) {
            return errorResult("A firm needs a valid domain (e.g. accel.com).");
          }
          if (type === "person" && !linkedinPath) {
            return errorResult("A person needs a valid LinkedIn URL (e.g. linkedin.com/in/naval).");
          }

          // Resolve redirects so the canonical domain is the key (tenvc.com → 10vc.com);
          // the original goes into alt_domains so old references still resolve.
          const altDomains: string[] = [];
          if (cleanedDomain) {
            const resolved = await resolveDomainRedirect(cleanedDomain);
            if (resolved !== cleanedDomain) {
              altDomains.push(cleanedDomain);
              cleanedDomain = resolved;
            }
          }

          // Duplicate check on both identifiers (domain check covers alt_domains too).
          for (const d of [cleanedDomain, ...altDomains]) {
            if (!d) continue;
            const existing = await findInvestorByAnyDomain(d);
            if (existing?.id) {
              return textResult(
                `An investor with domain ${d} already exists: "${existing.name}" (${existing.type}), id: ${existing.id}. ` +
                  `Nothing was created — use update_investor to change it, or merge_investors if this is a duplicate.`,
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
          if (altDomains.length) row.alt_domains = altDomains;
          const fieldSources = mergeFieldSources(null, sources);
          if (fieldSources) row.field_sources = fieldSources;
          if (mark_researched || row.deep_research) row.last_researched_at = new Date().toISOString();

          const { error } = await admin.from("investors").insert(row);
          if (error) return errorResult(`Could not add the investor: ${error.message}`);

          const notes: string[] = [`Added ${type} "${name.trim()}" | id: ${id}`];
          if (cleanedDomain) notes.push(`domain: ${cleanedDomain}`);
          if (altDomains.length) notes.push(`redirect detected — alt_domains: ${altDomains.join(", ")}`);
          if (linkedinPath) notes.push(`linkedin: linkedin.com/${linkedinPath}`);

          // The admin explicitly confirmed this is an investor — clear any stale
          // not-an-investor marking so pipelines don't contradict the new row.
          if (await checkNotAnInvestor(cleanedDomain, linkedinPath)) {
            if (cleanedDomain) await admin.from("not_an_investor").delete().eq("domain", cleanedDomain);
            if (linkedinPath) await admin.from("not_an_investor").delete().eq("linkedin_url", linkedinPath);
            notes.push("note: this identifier was on the not-an-investor list; the stale marking was removed.");
          }

          // Optional person → firm affiliations (a person can belong to several firms).
          if (type === "person") {
            const allFirmDomains = [...new Set([firm_domain, ...(firm_domains ?? [])].filter((d): d is string => !!d))];
            for (const fd of allFirmDomains) {
              const firm = await findFirmByDomain(fd);
              if (firm) {
                await ensureAffiliation(id, firm.id);
                notes.push(`linked to firm "${firm.name}" (${firm.id})`);
              } else {
                notes.push(
                  `note: no firm with domain ${cleanDomain(fd) ?? fd} exists yet — ` +
                    `add it with add_investor (type=firm) first, then update_investor with firm_domain to link them.`,
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
          firm_domains: z
            .array(z.string())
            .optional()
            .describe("For people with multiple firms: domains of ALL firms to link (each gets an affiliation; existing links are kept)."),
          clear_fields: z
            .array(z.string())
            .optional()
            .describe('Field names to CLEAR (set to null), e.g. ["twitter_url", "apply_url"]. Profile fields only — not name/domain/linkedin/type.'),
          sources: z
            .record(z.string(), z.string())
            .optional()
            .describe('Per-field provenance: {"fund_size_usd": "https://source-url", ...} — merged into stored field_sources with verified_at timestamps.'),
          mark_researched: z
            .boolean()
            .optional()
            .describe("Set true after a full research/refresh pass to stamp last_researched_at (automatic when deep_research is updated)."),
          ...investorProfileShape,
        },
      },
      async (input) => {
        try {
          const { investor_id, domain, linkedin_url, name, new_domain, new_linkedin_url, firm_domain, firm_domains, clear_fields, sources, mark_researched } = input;

          // Locate the investor (domain locator also matches alt_domains).
          let q = admin.from("investors").select("id, type, name, domain, linkedin_url, alt_domains, field_sources").limit(1);
          if (investor_id) q = q.eq("id", investor_id);
          else if (domain) {
            const clean = cleanDomain(domain);
            if (!clean) return errorResult(`"${domain}" does not look like a valid domain.`);
            q = q.or(`domain.eq.${clean},alt_domains.cs.{${clean}}`);
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
          const notes: string[] = [];

          if (name !== undefined) patch.name = name.trim();
          if (new_domain !== undefined) {
            let clean = cleanDomain(new_domain);
            if (!clean) return errorResult(`"${new_domain}" does not look like a valid domain.`);
            const resolved = await resolveDomainRedirect(clean);
            const alts = new Set<string>((existing.alt_domains as string[] | null) ?? []);
            if (resolved !== clean) {
              alts.add(clean);
              clean = resolved;
            }
            // Collision check: no OTHER record may own this domain.
            const collision = await findInvestorByAnyDomain(clean);
            if (collision?.id && collision.id !== existing.id) {
              return errorResult(
                `Domain ${clean} already belongs to "${collision.name}" (id: ${collision.id}). ` +
                  `If these are duplicates, use merge_investors instead of renaming.`,
              );
            }
            // Keep the old domain reachable as an alias.
            if (existing.domain && existing.domain !== clean) alts.add(existing.domain as string);
            alts.delete(clean);
            patch.domain = clean;
            if (alts.size) patch.alt_domains = [...alts];
          }
          if (new_linkedin_url !== undefined) {
            const path = cleanLinkedinPath(new_linkedin_url);
            if (!path) return errorResult(`"${new_linkedin_url}" does not look like a LinkedIn URL or path.`);
            const { data: liCollision } = await admin
              .from("investors")
              .select("id, name")
              .eq("linkedin_url", path)
              .neq("id", existing.id)
              .limit(1)
              .maybeSingle();
            if (liCollision?.id) {
              return errorResult(
                `LinkedIn linkedin.com/${path} already belongs to "${liCollision.name}" (id: ${liCollision.id}). ` +
                  `If these are duplicates, use merge_investors instead.`,
              );
            }
            patch.linkedin_url = path;
          }

          // Explicit field clearing (profile fields only).
          if (clear_fields?.length) {
            const invalid = clear_fields.filter((f) => !CLEARABLE_FIELDS.has(f));
            if (invalid.length) {
              return errorResult(`Cannot clear: ${invalid.join(", ")}. Clearable fields: ${[...CLEARABLE_FIELDS].join(", ")}.`);
            }
            for (const f of clear_fields) patch[f] = null;
          }

          const mergedSources = mergeFieldSources(existing.field_sources, sources as Record<string, string> | undefined);
          if (mergedSources) patch.field_sources = mergedSources;
          if (mark_researched || patch.deep_research) patch.last_researched_at = new Date().toISOString();

          const updatedFields = Object.keys(patch);
          if (updatedFields.length > 0) {
            const { error: updErr } = await admin.from("investors").update(patch).eq("id", existing.id);
            if (updErr) return errorResult(`Could not update the investor: ${updErr.message}`);
          }

          notes.unshift(
            updatedFields.length > 0
              ? `Updated "${existing.name}" (${existing.type}, id: ${existing.id}) | fields: ${updatedFields.join(", ")}`
              : `No fields to update for "${existing.name}" (id: ${existing.id}).`,
          );

          const allFirmDomains = [...new Set([firm_domain, ...(firm_domains ?? [])].filter((d): d is string => !!d))];
          if (allFirmDomains.length) {
            if (existing.type !== "person") {
              notes.push("note: firm_domain(s) ignored because this investor is a firm, not a person.");
            } else {
              for (const fd of allFirmDomains) {
                const firm = await findFirmByDomain(fd);
                if (firm) {
                  await ensureAffiliation(existing.id, firm.id);
                  notes.push(`linked to firm "${firm.name}" (${firm.id})`);
                } else {
                  notes.push(
                    `note: no firm with domain ${cleanDomain(fd) ?? fd} exists yet — add it first with add_investor.`,
                  );
                }
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
      "merge_investors",
      {
        title: "Merge duplicate investors (admin)",
        description:
          "Merge two investor records that are the same entity: the KEEP record gains any fields it was missing " +
          "from the DROP record, the drop record's domain becomes an alt_domain, affiliations and per-user " +
          "personalization are re-pointed, and the drop record is deleted. Keep the record with the better/canonical " +
          "identity (usually the one whose domain the website actually resolves to).",
        inputSchema: {
          keep_id: z.string().describe("Investor id of the record to KEEP."),
          drop_id: z.string().describe("Investor id of the duplicate to merge into keep and DELETE."),
        },
      },
      async ({ keep_id, drop_id }) => {
        try {
          if (keep_id === drop_id) return errorResult("keep_id and drop_id are the same record.");
          const { data: keep } = await admin.from("investors").select("*").eq("id", keep_id).maybeSingle();
          const { data: drop } = await admin.from("investors").select("*").eq("id", drop_id).maybeSingle();
          if (!keep) return errorResult(`No investor with id ${keep_id}.`);
          if (!drop) return errorResult(`No investor with id ${drop_id}.`);

          // Fill keep's empty fields from drop; never overwrite keep's data.
          const SKIP = new Set(["id", "created_at", "updated_at", "domain", "linkedin_url", "alt_domains", "type", "name"]);
          const patch: Record<string, unknown> = {};
          const filled: string[] = [];
          for (const [col, dropVal] of Object.entries(drop)) {
            if (SKIP.has(col) || dropVal === null || dropVal === undefined) continue;
            const keepVal = (keep as Record<string, unknown>)[col];
            const keepEmpty = keepVal === null || keepVal === undefined ||
              (Array.isArray(keepVal) && keepVal.length === 0) ||
              (typeof keepVal === "string" && !keepVal.trim());
            if (keepEmpty) {
              patch[col] = dropVal;
              filled.push(col);
            }
          }
          if (!keep.linkedin_url && drop.linkedin_url) {
            patch.linkedin_url = drop.linkedin_url;
            filled.push("linkedin_url");
          }
          // Drop's domain(s) become aliases of keep (or its primary domain if keep had none).
          const alts = new Set<string>([...((keep.alt_domains as string[] | null) ?? []), ...((drop.alt_domains as string[] | null) ?? [])]);
          if (drop.domain) {
            if (!keep.domain) {
              patch.domain = drop.domain;
              filled.push("domain");
            } else if (drop.domain !== keep.domain) {
              alts.add(drop.domain as string);
            }
          }
          alts.delete((patch.domain as string) ?? (keep.domain as string) ?? "");
          if (alts.size) patch.alt_domains = [...alts];

          // Re-point affiliations (skip ones that would duplicate an existing link).
          let affMoved = 0;
          for (const side of ["person_id", "firm_id"] as const) {
            const other = side === "person_id" ? "firm_id" : "person_id";
            const { data: affs } = await admin.from("investor_affiliations").select(`id, ${other}`).eq(side, drop_id);
            for (const aff of (affs ?? []) as Array<Record<string, string>>) {
              const { data: dup } = await admin
                .from("investor_affiliations")
                .select("id")
                .eq(side, keep_id)
                .eq(other, aff[other])
                .maybeSingle();
              if (dup?.id || aff[other] === keep_id) {
                await admin.from("investor_affiliations").delete().eq("id", aff.id);
              } else {
                await admin.from("investor_affiliations").update({ [side]: keep_id }).eq("id", aff.id);
                affMoved++;
              }
            }
          }

          // Re-point per-user personalization; a user who has BOTH keeps the keep-side row.
          const { data: dropPers } = await admin
            .from("investor_personalization")
            .select("id, user_id")
            .eq("investor_id", drop_id);
          let persMoved = 0, persDropped = 0;
          for (const p of dropPers ?? []) {
            const { data: dup } = await admin
              .from("investor_personalization")
              .select("id")
              .eq("investor_id", keep_id)
              .eq("user_id", p.user_id)
              .maybeSingle();
            if (dup?.id) {
              await admin.from("investor_personalization").delete().eq("id", p.id);
              persDropped++;
            } else {
              await admin.from("investor_personalization").update({ investor_id: keep_id }).eq("id", p.id);
              persMoved++;
            }
          }

          if (Object.keys(patch).length) {
            const { error: updErr } = await admin.from("investors").update(patch).eq("id", keep_id);
            if (updErr) return errorResult(`Merge failed while updating the keep record: ${updErr.message}`);
          }
          const { error: delErr } = await admin.from("investors").delete().eq("id", drop_id);
          if (delErr) return errorResult(`Merged data but could not delete the duplicate: ${delErr.message}`);

          return textResult(
            `Merged "${drop.name}" (${drop_id}) into "${keep.name}" (${keep_id}) and deleted the duplicate.\n` +
              `- fields filled from duplicate: ${filled.length ? filled.join(", ") : "none"}\n` +
              `- alt_domains now: ${(patch.alt_domains as string[] | undefined)?.join(", ") ?? ((keep.alt_domains as string[] | null)?.join(", ") || "none")}\n` +
              `- affiliations re-pointed: ${affMoved} | personalization rows re-pointed: ${persMoved} (deduped: ${persDropped})`,
          );
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      "delete_investor",
      {
        title: "Delete investor (admin)",
        description:
          "Permanently delete an investor record plus its affiliations and per-user personalization. " +
          "DESTRUCTIVE and irreversible — for duplicates prefer merge_investors, which preserves data. " +
          "Requires the exact investor id.",
        inputSchema: {
          investor_id: z.string().describe("The exact investor id to delete (from find_investors)."),
        },
      },
      async ({ investor_id }) => {
        try {
          const { data: inv } = await admin
            .from("investors")
            .select("id, name, type, domain, linkedin_url")
            .eq("id", investor_id)
            .maybeSingle();
          if (!inv) return errorResult(`No investor with id ${investor_id}.`);

          const { count: affCount } = await admin
            .from("investor_affiliations")
            .select("id", { count: "exact", head: true })
            .or(`person_id.eq.${investor_id},firm_id.eq.${investor_id}`);
          const { count: persCount } = await admin
            .from("investor_personalization")
            .select("id", { count: "exact", head: true })
            .eq("investor_id", investor_id);

          await admin.from("investor_affiliations").delete().or(`person_id.eq.${investor_id},firm_id.eq.${investor_id}`);
          await admin.from("investor_personalization").delete().eq("investor_id", investor_id);
          const { error } = await admin.from("investors").delete().eq("id", investor_id);
          if (error) return errorResult(`Could not delete the investor: ${error.message}`);

          return textResult(
            `Deleted ${inv.type} "${inv.name}" (${inv.domain ?? inv.linkedin_url ?? investor_id}) — ` +
              `removed ${affCount ?? 0} affiliation(s) and ${persCount ?? 0} personalization row(s).`,
          );
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
