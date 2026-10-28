// crm-mcp/tools_research.ts — prospect-research memory: what earlier runs already decided about an email or a
// domain, and the "what changed" report of a run (migrations/crm/006_research.sql). The prospect-research skill
// calls research_lookup before it researches anyone and save_research_report after it has written the CRM; the
// app shows the rows on CRM → Calendar (Research tab, and inside each event whose guests were researched).
import type { McpServer } from "npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js";
import { type Ctx, tool, z, rpc } from "./ctx.ts";

const KIND = z.enum(["company", "contact", "meeting"]);
const VERDICT = z.enum(["confirmed", "work_email", "unconfirmed", "shared_inbox", "filtered"]);
const ACTION = z.enum(["created", "updated", "skipped", "not_added"]);

export function registerResearch(server: McpServer, ctx: Ctx): void {
  tool(server, ctx, {
    name: "research_lookup", title: "What the CRM already knows about these emails / domains", cls: "read",
    description: "Call this BEFORE researching anyone (prospect-research skill, step 3) with every outside email and company domain of the run. Per email: the CRM contact if there is one (name, role, company, company_domain, profile = full | partial | none), the last research row for that email (when, verdict, action, best match, reason) and a suggestion — skip (reuse what is here: a full profile, or a verdict from the last 30 days such as unconfirmed / shared_inbox / work_email) or run (research it) — with the reason. Per domain: the company, its profile state, its contacts, the last research row, suggestion. A free-mail address already in the CRM is tied to its company here (a gmail that is a brand's inbox resolves to that brand), so the company is not researched again. The user saying \"refresh\" overrides a skip.",
    input: {
      emails: z.array(z.string().max(200)).max(100).optional().describe("Outside attendees' emails (internal ones already filtered out)"),
      domains: z.array(z.string().max(200)).max(100).optional().describe("Company domains from the work emails / the invite (free-mail domains are ignored by the caller)"),
    },
  }, async (a) => rpc(ctx, "research_lookup", { p_emails: a.emails ?? [], p_domains: a.domains ?? [] }));

  tool(server, ctx, {
    name: "save_research_report", title: "Save a prospect-research run's report", cls: "write",
    description: "After the CRM writes of a prospect-research run, store its report: one item per company, contact and meeting the run looked at, with the fixed vocabulary — kind company | contact | meeting; verdict (identity) confirmed | work_email (company proven by the email, profile unconfirmed) | unconfirmed (nothing ties the email to a page) | shared_inbox (a brand/team inbox, not a person) | filtered (internal/personal, not researched), null for meetings; action created | updated | skipped (existed, nothing to change) | not_added (nothing written; for meetings: booked = created, moved = updated, already on file = skipped). needs_review + review_reason + best_match_url for anything a human should confirm. researched=false for a row carried forward from an earlier run. detail = the 'What changed' cell in plain words. The team reads these on CRM → Calendar → Research and inside each event.",
    input: {
      source: z.string().max(300).optional().describe("One line: what was researched, e.g. \"3 emails pasted\" or \"today's meetings (4)\""),
      note: z.string().max(1000).optional().describe("The report's closing line: counts, meetings booked, anything that could not run (e.g. the Google check)"),
      items: z.array(z.object({
        kind: KIND, label: z.string().min(1).max(200).describe("As shown in the report: \"HiSO (hiso.ca)\", \"Maria Matar\", \"Monday review\""),
        email: z.string().max(200).optional(), domain: z.string().max(200).optional(),
        company_id: z.string().uuid().optional(), contact_id: z.string().uuid().optional(), meeting_id: z.string().uuid().optional(),
        verdict: VERDICT.nullable().optional(), action: ACTION,
        needs_review: z.boolean().optional(), researched: z.boolean().optional(),
        detail: z.string().max(2000).optional(), review_reason: z.string().max(600).optional(), best_match_url: z.string().max(500).optional(),
      })).min(1).max(200),
    },
  }, async (a) => rpc(ctx, "research_save", { p: a }));

  tool(server, ctx, {
    name: "research_runs", title: "Past prospect-research runs", cls: "read",
    description: "The last research runs with their report rows (newest first) — \"what did the research find yesterday?\", \"who still needs review?\". needs_review=true returns only runs/rows that need a human look.",
    input: { limit: z.number().int().min(1).max(50).optional(), needs_review: z.boolean().optional() },
  }, async (a) => rpc(ctx, "research_runs_list", { p_limit: a.limit ?? 10, p_needs_review: a.needs_review ?? false }));
}
