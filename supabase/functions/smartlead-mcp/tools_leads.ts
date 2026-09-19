// smartlead-mcp/tools_leads.ts — campaign leads, adding leads, and the cross-channel view (LinkedIn state from Supabase + email state from Smartlead).
import type { McpServer } from "npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js";
import { type Ctx, type Row, tool, z, McpError, campaignId, confirmParam, rawParam, gate, isEmail, mapPool, trim, untrusted, log } from "./ctx.ts";
import { sl, body, rowsOf, pick, totalOf, fetchCampaign, isLive, isSafeToEdit, categoryMap, normaliseHistory } from "./smartlead.ts";

const leadInput = z.object({
  email: z.string(),
  first_name: z.string().max(100).optional(), last_name: z.string().max(100).optional(), company_name: z.string().max(200).optional(),
  phone_number: z.string().max(50).optional(), website: z.string().max(300).optional(), location: z.string().max(200).optional(),
  linkedin_profile: z.string().max(300).optional(), company_url: z.string().max(300).optional(),
  custom_fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("Free key/value pairs usable as {{variables}} in the copy (≤20 keys)"),
});

export function registerLeads(server: McpServer, ctx: Ctx): void {
  tool(server, ctx, {
    name: "list_campaign_leads", title: "Leads in a campaign", cls: "read",
    description: "Leads of one campaign and where each stands: status (STARTED = waiting for step 1, INPROGRESS, COMPLETED, PAUSED, STOPPED, BLOCKED), category, when added. One page at a time (limit ≤ 100, default 25; offset for more) — never walk a whole campaign into context; use get_campaign_analytics for totals. Filters: status, category (id or name).",
    input: { campaign_id: campaignId, status: z.enum(["STARTED", "INPROGRESS", "COMPLETED", "PAUSED", "STOPPED", "BLOCKED"]).optional(), category: z.union([z.string(), z.number()]).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional(), ...rawParam },
  }, async (a) => {
    const cats = await categoryMap();
    let catId: number | undefined;
    if (a.category !== undefined) {
      catId = typeof a.category === "number" || /^\d+$/.test(String(a.category)) ? Number(a.category) : [...cats.entries()].find(([, n]) => n.toLowerCase() === String(a.category).trim().toLowerCase())?.[0];
      if (catId === undefined) throw new McpError("E_NOT_FOUND", `no lead category "${a.category}" (list_lead_categories)`);
    }
    const limit = a.limit ?? 25, offset = a.offset ?? 0;
    const r = await sl("GET", `/campaigns/${a.campaign_id}/leads`, { query: { offset, limit, status: a.status, lead_category_id: catId } });
    const rows = rowsOf(r, "leads").map((x) => {
      const l = (x.lead ?? x) as Row, cid = pick(x, "lead_category_id", "lead.lead_category_id");
      return { lead_id: pick(l, "id", "lead_id"), lead_map_id: pick(x, "campaign_lead_map_id"), email: l.email, name: [l.first_name, l.last_name].filter(Boolean).join(" ") || undefined, company: pick(l, "company_name"), status: pick(x, "status", "lead_status"), category: cid != null ? cats.get(Number(cid)) ?? cid : undefined, added: String(pick(x, "created_at") ?? "").slice(0, 10) || undefined, unsubscribed: l.is_unsubscribed || undefined };
    });
    return { campaign_id: a.campaign_id, offset, limit, returned: rows.length, total: totalOf(r), next_offset: rows.length === limit ? offset + limit : undefined, leads: rows, raw: a.raw ? trim(rowsOf(r, "leads").slice(0, 1)) : undefined };
  });

  tool(server, ctx, {
    name: "add_leads_to_campaign", title: "Add leads to a campaign", cls: "gated",
    description: `Add up to 400 leads to a campaign. Smartlead's block list, unsubscribe list, community bounce list and cross-campaign duplicate check ALWAYS apply — this tool has no way to override them, and you must not try (e.g. by altering an address).
ADDING TO A LIVE CAMPAIGN IS A SEND: a lead added to an ACTIVE campaign gets cold-emailed at the next sending window with no further approval. So: DRAFTED / PAUSED / STOPPED campaign → runs directly. ACTIVE campaign → confirmation-gated: the first call returns an effect_summary (count, campaign name, first addresses) + confirmation_token; call again with the same arguments + token after an explicit yes.
The result lists what Smartlead skipped and why (duplicates, blocked, unsubscribed, invalid, bounced) — report those, do not swallow them. Lead sourcing/enrichment is out of scope: only add lists the human supplied.`,
    input: { campaign_id: campaignId, leads: z.array(leadInput).min(1).max(400), ...confirmParam },
  }, async (a) => {
    const seen = new Set<string>(), invalid: string[] = [], dupes: string[] = [], list: Row[] = [];
    for (const l of a.leads) {
      const email = String(l.email ?? "").trim().toLowerCase();
      if (!isEmail(email)) { invalid.push(String(l.email)); continue; }
      if (seen.has(email)) { dupes.push(email); continue; }
      if (l.custom_fields && Object.keys(l.custom_fields).length > 20) throw new McpError("E_PAYLOAD_INVALID", `${email}: more than 20 custom_fields`);
      seen.add(email);
      list.push({ ...l, email });
    }
    if (list.length === 0) throw new McpError("E_PAYLOAD_INVALID", "no valid email addresses in leads", undefined, { invalid });
    const c = await fetchCampaign(a.campaign_id);
    const live = !isSafeToEdit(c.status); // anything we do not positively know to be idle is treated as sending
    if (live) {
      const summary = `ADD ${list.length} LEAD(S) TO A LIVE CAMPAIGN — "${c.name}" (#${a.campaign_id}), status ${c.status}.\nThese people will be COLD-EMAILED at the next sending window, with no further approval.\nFirst addresses: ${list.slice(0, 8).map((l) => l.email).join(", ")}${list.length > 8 ? `, … (+${list.length - 8})` : ""}${invalid.length ? `\nIgnored as invalid: ${invalid.length}` : ""}${dupes.length ? `\nDuplicates inside this list dropped: ${dupes.length}` : ""}\nBlock / unsubscribe / bounce lists still apply.`;
      const g = await gate(ctx, "add_leads_to_campaign", a, summary);
      if (!g.proceed) return g.result;
    }
    const r = await sl("POST", `/campaigns/${a.campaign_id}/leads`, {
      body: { lead_list: list, settings: { ignore_global_block_list: false, ignore_unsubscribe_list: false, ignore_community_bounce_list: false, ignore_duplicate_leads_in_other_campaign: false, return_lead_ids: true } },
      timeoutMs: 60_000,
    });
    const b = (body(r) ?? {}) as Row;
    const added = Number(pick(b, "added_count", "upload_count", "uploaded_count") ?? NaN);
    log({ fn: "smartlead-mcp", event: "add_leads", user: ctx.userId, campaign: a.campaign_id, submitted: list.length, added, live });
    return {
      campaign_id: a.campaign_id, campaign: c.name, campaign_status: c.status, will_be_emailed: isLive(c.status) ? "yes — at the next sending window" : "not until a human starts/resumes the campaign",
      submitted: list.length, added: Number.isFinite(added) ? added : undefined,
      skipped: { count: pick(b, "skipped_count"), duplicates: pick(b, "duplicate_count", "already_added_to_campaign"), blocked: pick(b, "block_count", "blocked_count"), unsubscribed: pick(b, "unsubscribed_leads", "unsubscribed_count"), invalid_emails: pick(b, "invalid_email_count"), bounced: pick(b, "bounce_count"), leads: trim(pick(b, "skipped_leads", "invalid_emails"), 50, 200) },
      dropped_before_upload: invalid.length || dupes.length ? { invalid, duplicates_in_list: dupes } : undefined,
      lead_ids: trim(pick(b, "lead_ids", "emailToLeadIdMap"), 400, 100),
      smartlead_message: pick(b, "message", "error"),
    };
  });

  tool(server, ctx, {
    name: "prospect_cross_channel", title: "One prospect across LinkedIn + email", cls: "read",
    description: "For one named prospect: LinkedIn state from the outreach platform in Supabase (connection status per sender, live sequences, last touch in/out, chat intent) next to email state from Smartlead (campaigns, status, category, last sent / last reply, unsubscribed) — so the same person is not hit on two channels on the same day. Pass email (best) or name. Returns `same_day_risk` when both channels touched, or are about to touch, the person today. LinkedIn rows come through your own outreach-workspace permissions.",
    input: { email: z.string().optional(), name: z.string().min(3).max(120).optional().describe("Full or partial name — used to find the person on the LinkedIn side when no email is known") },
  }, async (a) => {
    if (!a.email && !a.name) throw new McpError("E_PAYLOAD_INVALID", "pass email or name");
    if (a.email && !isEmail(a.email)) throw new McpError("E_PAYLOAD_INVALID", "email is not valid");
    const email = a.email?.trim().toLowerCase();

    // --- LinkedIn side (Supabase, RLS as the caller)
    let liNote: string | undefined, liLeads: Row[] = [];
    try {
      let q = ctx.user.from("outreach_leads").select("*").limit(5);
      q = email ? q.or(`email_work.eq.${email},email_personal.eq.${email}`) : q.ilike("full_name", `%${a.name!.replace(/[%_,()]/g, " ").trim()}%`);
      const { data, error } = await q;
      if (error) liNote = `outreach platform not readable: ${error.message}`; else liLeads = (data ?? []) as Row[];
    } catch (e) { liNote = `outreach platform not readable: ${e instanceof Error ? e.message : String(e)}`; }
    const linkedin = await mapPool(liLeads, 3, async (l) => {
      const [{ data: states }, { data: enr }, { data: chats }] = await Promise.all([
        ctx.user.from("outreach_lead_sender_state").select("sender_id, relation, invite_sent_at, invite_accepted_at, replied, last_outbound_at, last_inbound_at, outreach_senders(display_name)").eq("lead_id", l.id),
        ctx.user.from("outreach_enrollments").select("id, status, wait_until, created_at, outreach_sequences(name)").eq("lead_id", l.id).order("created_at", { ascending: false }).limit(5),
        ctx.user.from("outreach_chats").select("id, provider, intent, unread, last_message_at, last_message_preview").eq("lead_id", l.id).order("last_message_at", { ascending: false }).limit(3),
      ]);
      return {
        lead_id: l.id, name: l.full_name ?? [l.first_name, l.last_name].filter(Boolean).join(" "), company: l.company, title: l.title, profile: l.public_identifier ? `linkedin.com/in/${l.public_identifier}` : undefined, email_work: l.email_work, email_personal: l.email_personal, unsubscribed: l.unsubscribed || undefined,
        relations: (states ?? []).map((s: Row) => ({ sender: s.outreach_senders?.display_name ?? s.sender_id, relation: s.relation, invite_sent_at: s.invite_sent_at, accepted_at: s.invite_accepted_at, replied: s.replied || undefined, last_outbound_at: s.last_outbound_at, last_inbound_at: s.last_inbound_at })),
        enrollments: (enr ?? []).map((e: Row) => ({ sequence: e.outreach_sequences?.name, status: e.status, next_action_after: e.wait_until, since: String(e.created_at ?? "").slice(0, 10) })),
        chats: (chats ?? []).map((c: Row) => ({ provider: c.provider, intent: c.intent, unread: c.unread || undefined, last_at: c.last_message_at, preview: untrusted("linkedin_message", c.last_message_preview, 200) })),
      };
    });

    // --- Email side (Smartlead) — by the given email, else by the emails found on the LinkedIn lead
    const emails = [...new Set([email, ...liLeads.flatMap((l) => [l.email_work, l.email_personal])].filter(Boolean).map((e) => String(e).toLowerCase()))].slice(0, 3);
    const cats = await categoryMap();
    const smartlead = await mapPool(emails, 2, async (e) => {
      try {
        const lead = body(await sl("GET", "/leads/", { query: { email: e } })) as Row | null;
        const id = Number(pick(lead, "id", "lead_id"));
        if (!lead || !Number.isFinite(id) || !id) return { email: e, found: false };
        const camps = ((pick(lead, "lead_campaign_data") ?? []) as Row[]).slice(0, 4);
        const campaigns = await mapPool(camps, 2, async (cd) => {
          const cid = Number(pick(cd, "campaign_id"));
          const [c, h] = await Promise.all([fetchCampaign(cid).catch(() => ({} as Row)), sl("GET", `/campaigns/${cid}/leads/${id}/message-history`).then(normaliseHistory).catch(() => ({ messages: [] }))]);
          const lastOut = [...h.messages].reverse().find((m) => m.direction === "outbound"), lastIn = [...h.messages].reverse().find((m) => m.direction === "inbound");
          const catId = pick(cd, "lead_category_id");
          return { campaign_id: cid, campaign: pick(cd, "campaign_name") ?? c.name, campaign_status: c.status, lead_status: pick(cd, "lead_status", "status"), category: catId != null ? cats.get(Number(catId)) ?? catId : undefined, emails_sent: h.messages.filter((m) => m.direction === "outbound").length, last_sent_at: lastOut?.time, last_step: lastOut?.seq_number, last_reply_at: lastIn?.time };
        });
        return { email: e, found: true, lead_id: id, name: [lead.first_name, lead.last_name].filter(Boolean).join(" ") || undefined, company: lead.company_name, unsubscribed: lead.is_unsubscribed || undefined, campaigns };
      } catch (err) {
        if (err instanceof McpError && err.code === "E_NOT_FOUND") return { email: e, found: false };
        return { email: e, error: err instanceof Error ? err.message : String(err) };
      }
    });

    // --- same-day collision
    const today = new Date().toISOString().slice(0, 10), isToday = (t?: string | null) => !!t && String(t).slice(0, 10) === today;
    const liToday = linkedin.some((l) => l.relations.some((r: Row) => isToday(r.last_outbound_at) || isToday(r.invite_sent_at)));
    const liPending = linkedin.some((l) => l.enrollments.some((e: Row) => /active|running|live|in_progress/i.test(String(e.status)) && (!e.next_action_after || isToday(e.next_action_after))));
    const emToday = smartlead.some((s: Row) => (s.campaigns ?? []).some((c: Row) => isToday(c.last_sent_at)));
    const emPending = smartlead.some((s: Row) => (s.campaigns ?? []).some((c: Row) => isLive(c.campaign_status) && /STARTED|INPROGRESS/i.test(String(c.lead_status ?? ""))));
    const risk = (liToday && (emToday || emPending)) || (emToday && liPending) ? `touched on ${[liToday && "LinkedIn", emToday && "email"].filter(Boolean).join(" and ")} today${emPending && !emToday ? "; an ACTIVE email campaign may also send today" : ""}${liPending && !liToday ? "; a LinkedIn sequence may also act today" : ""} — hold one channel (pause_lead here, or pause the LinkedIn enrolment in the outreach connector)` : undefined;

    return {
      query: { email, name: a.name }, same_day_risk: risk,
      linkedin: linkedin.length ? linkedin : undefined, linkedin_note: liNote ?? (linkedin.length ? undefined : "not found on the LinkedIn outreach platform (in the workspaces you can see)"),
      email: smartlead.length ? smartlead : undefined, email_note: emails.length === 0 ? "no email address known for this person, so Smartlead could not be checked — pass email" : undefined,
    };
  });
}
