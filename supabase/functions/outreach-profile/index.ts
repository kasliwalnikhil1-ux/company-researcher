// Profile Studio HTTP surface (PRD §10.2): everything the UI and the MCP need beyond plain RPCs.
//
// Signed-in actions (user JWT; the RPCs run as the member, so roles / client scope / authority / ceilings are enforced in SQL):
//   snapshot          {sender_id}                      read the own profile (selective sections, one profile_view), store a baseline, recompute QA
//   submit            {change_id}                      validate + queue (direct) or send the owner an approval link (propose_only)
//   revert            {change_id}                      build + submit the rollback (fidelity declared in the response)
//   authority_link    {sender_id, field_groups, mode, owner_email?, grant_days?}   signed grant link emailed to the owner
//   ai_draft          {sender_id, field_group, brief}  AI-written headline / About → a DRAFT, never applied
//   bulk_commit       {run_id}                         commit a bulk preview; approval links go out for propose_only senders
//   experiment_start / experiment_conclude {experiment_id, apply_winner?}
// Public actions (no login; the token is the credential; rate-limited per IP):
//   authority_preview / authority_accept {token, decision, field_groups?, mode?}
//   approval_preview / approval_decide   {token, decision}
//   revert_preview / revert_apply        {token}
// Deployed with --no-verify-jwt (public actions + CORS preflight); auth is checked here per action.
import { admin, json, serve, requireUser, readJson, HttpError, audit, rateLimit, rpc as srpc, log } from "../_shared/outreach/supabase.ts";
import { snapshotSender, sendApprovalRequest, sendAuthorityRequest } from "../_shared/outreach/profile.ts";
import { llmCall } from "../_shared/outreach/llm.ts";
import { aiConfigured } from "../_shared/outreach/ai.ts";

type Row = Record<string, any>;
const PUBLIC = new Set(["authority_preview", "authority_accept", "approval_preview", "approval_decide", "revert_preview", "revert_apply"]);
const GROUPS = ["headline", "about", "photo", "cover", "location", "experience", "education", "skills", "custom_link"];

function evidence(req: Request): Row {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;
  return { ip, user_agent: (req.headers.get("user-agent") ?? "").slice(0, 300), signed_at: new Date().toISOString() };
}

/** Call an outreach_* RPC as the signed-in user (RLS + outreach_require). */
async function urpc<T = any>(client: { rpc: (n: string, a: Record<string, unknown>) => any }, name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(`outreach_${name}`, args);
  if (error) throw new Error(error.message);
  return data as T;
}

/** For a change that landed in awaiting_owner: issue the token (service role) and email the owner. The link is returned to the
 *  caller only when email delivery is not configured on this deployment (same rule as reconnect links), and that is audited. */
async function requestApproval(changeId: string, workspaceId: string): Promise<Row> {
  const { data: ch } = await admin.from("outreach_profile_changes").select("*").eq("id", changeId).maybeSingle();
  if (!ch || ch.status !== "awaiting_owner") return { status: ch?.status ?? "missing" };
  const token = await srpc<string>("profile_issue_approval_token", { p_change: changeId });
  const r = await sendApprovalRequest(ch, token);
  const expose = !r.configured || r.recipients.length === 0;
  if (expose) await audit(workspaceId, "profile.approval_link_exposed", "profile_change", changeId, { reason: !r.configured ? "email_not_configured" : "no_owner_email" }, "user");
  return { status: "awaiting_owner", email_sent: r.sent > 0, recipients: r.recipients, link: expose ? r.link : undefined, email_configured: r.configured };
}

const AI_PROFILE_SYSTEM = `You write LinkedIn profile copy for a real person, in their first-person voice, to be reviewed and edited by a human before anything is published.
Rules: no fabricated employers, titles, numbers, clients or credentials — use only facts given. No hashtags, no emojis unless the brief uses them, no buzzword lists.
Headline: under 200 characters, says who they help and how. About: 3 short paragraphs (who you help, how, proof or a concrete example), under 1,800 characters, line breaks between paragraphs, a plain closing line on how to reach them.
Return ONLY a JSON object: {"text": "<the copy>", "facts_used": ["<fact>", ...]}.`;

serve("profile", async (req) => {
  const body = await readJson<Row>(req);
  const action = String(body.action ?? "");
  const ev = evidence(req);

  // ---------------------------------------------------------------- public (owner, no login)
  if (PUBLIC.has(action)) {
    const token = String(body.token ?? "").trim();
    if (!/^[0-9a-f]{48}$/i.test(token)) throw new HttpError(400, "E_INVALID_LINK", "This link is not valid.");
    await rateLimit(`profile-public:${ev.ip ?? "anon"}`, 60, 600);
    if (action === "authority_preview" || action === "authority_accept") {
      const link = await srpc<Row | null>("profile_authority_link_by_token", { p_token: token });
      if (!link) throw new HttpError(404, "E_INVALID_LINK", "This link is not valid or was already used.");
      if (action === "authority_preview") return json({ link });
      const decision = body.decision === "decline" ? "decline" : "accept";
      const groups = Array.isArray(body.field_groups) ? body.field_groups.filter((g: unknown) => GROUPS.includes(String(g))) : null;
      const r = await srpc<Row>("profile_authority_accept", { p_token: token, p_decision: decision, p_groups: groups && groups.length ? groups : null, p_mode: body.mode === "propose_only" || body.mode === "direct" ? body.mode : null, p_evidence: ev });
      return json({ ok: true, ...r });
    }
    if (action === "approval_preview" || action === "approval_decide") {
      const ch = await srpc<Row | null>("profile_change_by_approval_token", { p_token: token });
      if (!ch?.id) throw new HttpError(404, "E_INVALID_LINK", "This link is not valid or was already used.");
      const { data: sender } = await admin.from("outreach_senders").select("id, display_name, picture_url, public_identifier, owner_email, workspace_id").eq("id", ch.sender_id).maybeSingle();
      const { data: snap } = await admin.from("outreach_profile_snapshots").select("data").eq("sender_id", ch.sender_id).order("captured_at", { ascending: false }).limit(1).maybeSingle();
      if (action === "approval_preview") return json({ change: { id: ch.id, status: ch.status, field_groups: ch.field_groups, payload: ch.payload, assets: ch.assets, requested_by_email: ch.requested_by_email, note: ch.note, expires_at: ch.approval_expires_at }, sender, before: snap?.data ?? null });
      const decision = body.decision === "decline" ? "decline" : "apply";
      const r = await srpc<Row>("profile_owner_decide", { p_change: ch.id, p_decision: decision, p_email: sender?.owner_email ?? "owner", p_evidence: ev });
      return json({ ok: true, ...r });
    }
    // revert
    const ch = await srpc<Row | null>("profile_change_by_revert_token", { p_token: token });
    if (!ch?.id) throw new HttpError(404, "E_INVALID_LINK", "This link is not valid or has expired.");
    if (ch.revert_expires_at && new Date(ch.revert_expires_at).getTime() < Date.now()) throw new HttpError(410, "E_INVALID_LINK", "This revert link has expired (30 days).");
    const { data: sender } = await admin.from("outreach_senders").select("id, display_name, picture_url, public_identifier, owner_email, workspace_id").eq("id", ch.sender_id).maybeSingle();
    if (action === "revert_preview") {
      let build: Row | null = null;
      try { build = await srpc<Row>("profile_revert_build", { p_change: ch.id }); } catch (e) { build = { possible: false, error: String((e as Error).message) }; }
      return json({ change: { id: ch.id, status: ch.status, field_groups: ch.field_groups, payload: ch.payload, applied_at: ch.applied_at, reverted_at: ch.reverted_at }, sender, build });
    }
    const r = await srpc<Row>("profile_revert", { p_change: ch.id, p_by_email: sender?.owner_email ?? "owner" });
    await admin.from("outreach_profile_changes").update({ revert_token_hash: null }).eq("id", ch.id);
    return json({ ok: true, ...r });
  }

  // ---------------------------------------------------------------- signed in
  const user = await requireUser(req);
  const c = user.client;
  switch (action) {
    case "snapshot": {
      const { data: s } = await admin.from("outreach_senders").select("*").eq("id", String(body.sender_id ?? "")).maybeSingle();
      if (!s) throw new HttpError(404, "E_NOT_FOUND");
      await urpc(c, "profile_why_not", { p_sender: s.id });   // membership + client scope check as the user
      if (s.provider !== "LINKEDIN") throw new HttpError(400, "E_PROFILE_PROVIDER", "Profile snapshots are for LinkedIn accounts");
      if (s.status !== "ok") throw new HttpError(400, "E_PROFILE_SENDER_NOT_OK", "The account must be connected");
      await rateLimit(`profile-snapshot:${s.id}`, 3, 3600);
      const r = await snapshotSender(s, "baseline");
      if ("skipped" in r) throw new HttpError(429, r.skipped === "no_budget" ? "E_BUDGET_PROFILE_VIEW" : "E_PROFILE_ID_UNRESOLVED", r.skipped === "no_budget" ? "No profile-view allowance left today; try tomorrow." : "The account has no public identifier yet; refresh the profile first.");
      await audit(s.workspace_id, "profile.snapshot", "sender", s.id, { snapshot_id: r.id, drift: r.drift }, "user");
      return json({ ok: true, snapshot_id: r.id, data: r.doc, overview: await urpc(c, "profile_overview", { p_sender: s.id }) });
    }
    case "submit": {
      const r = await urpc<Row>(c, "profile_submit_change", { p_change: String(body.change_id ?? "") });
      if (r.status === "awaiting_owner") {
        const { data: ch } = await admin.from("outreach_profile_changes").select("workspace_id").eq("id", r.id).maybeSingle();
        return json({ ok: true, ...r, approval: await requestApproval(r.id, ch?.workspace_id ?? "") });
      }
      return json({ ok: true, ...r });
    }
    case "revert": {
      const r = await urpc<Row>(c, "profile_revert", { p_change: String(body.change_id ?? ""), p_by_email: null });
      if (r.status === "awaiting_owner") { const { data: ch } = await admin.from("outreach_profile_changes").select("workspace_id").eq("id", r.id).maybeSingle(); return json({ ok: true, ...r, approval: await requestApproval(r.id, ch?.workspace_id ?? "") }); }
      return json({ ok: true, ...r });
    }
    case "authority_link": {
      const groups = (Array.isArray(body.field_groups) ? body.field_groups : []).filter((g: unknown) => GROUPS.includes(String(g)));
      const r = await urpc<Row>(c, "profile_authority_link_create", { p_sender: String(body.sender_id ?? ""), p_groups: groups, p_mode: body.mode === "direct" ? "direct" : "propose_only", p_owner_email: body.owner_email ?? null, p_grant_days: body.grant_days ?? null });
      const { data: s } = await admin.from("outreach_senders").select("*").eq("id", String(body.sender_id)).maybeSingle();
      const mail = await sendAuthorityRequest(s!, r.token, groups, body.mode === "direct" ? "direct" : "propose_only", user.email);
      const expose = !mail.configured || mail.recipients.length === 0;
      if (expose) await audit(s!.workspace_id, "profile.authority_link_exposed", "sender", s!.id, { reason: !mail.configured ? "email_not_configured" : "no_owner_email" }, "user");
      return json({ ok: true, link_id: r.link_id, owner_email: r.owner_email, expires_at: r.expires_at, email_sent: mail.sent > 0, email_configured: mail.configured, link: expose ? mail.link : undefined });
    }
    case "ai_draft": {
      // PRD §8.5: always a draft, never applied, never in direct mode from here. Not offered to unattended callers (there are none).
      const senderId = String(body.sender_id ?? ""); const group = String(body.field_group ?? "");
      if (group !== "headline" && group !== "about") throw new HttpError(400, "E_PAYLOAD_INVALID", "AI drafting covers the headline and the About section");
      const overview = await urpc<Row>(c, "profile_overview", { p_sender: senderId });
      const { data: s } = await admin.from("outreach_senders").select("id, workspace_id, display_name, client_id").eq("id", senderId).maybeSingle();
      if (!s) throw new HttpError(404, "E_NOT_FOUND");
      if (!aiConfigured(s.workspace_id)) throw new HttpError(503, "E_AI_UNAVAILABLE", "AI is not configured for this workspace");
      await rateLimit(`profile-ai:${user.id}`, 20, 3600);
      const snap: Row = overview?.snapshot?.data ?? {};
      const { data: ws } = await admin.from("outreach_workspaces").select("name, settings").eq("id", s.workspace_id).maybeSingle();
      const { data: client } = s.client_id ? await admin.from("outreach_clients").select("name, settings").eq("id", s.client_id).maybeSingle() : { data: null };
      const facts = {
        name: s.display_name, current_headline: snap.headline ?? null, current_about: snap.summary ?? null, location: snap.location ?? null,
        experience: (snap.experience ?? []).slice(0, 5).map((e: Row) => ({ title: e.title, company: e.company, current: e.current, description: e.description })),
        skills: (snap.skills ?? []).slice(0, 15).map((x: Row) => x.name), education: (snap.education ?? []).slice(0, 3),
        positioning: client?.settings?.positioning ?? ws?.settings?.positioning ?? null, offer: client?.settings?.offer ?? ws?.settings?.offer ?? null, client: client?.name ?? null,
      };
      const brief = String(body.brief ?? "").slice(0, 2000);
      const raw = await llmCall({ workspaceId: s.workspace_id, purpose: `profile_draft_${group}`, system: AI_PROFILE_SYSTEM, user: `Field: ${group === "headline" ? "headline" : "About section"}.\n\nBrief from the operator:\n${brief || "(none)"}\n\nFacts about the person (use only these):\n${JSON.stringify(facts)}`, maxTokens: 3072, temperature: 0.7, json: true });
      let text = "";
      let factsUsed: string[] = [];
      try { const j = JSON.parse(raw.replace(/```(?:json)?/g, "").trim()); text = String(j.text ?? "").trim(); factsUsed = Array.isArray(j.facts_used) ? j.facts_used.map(String) : []; } catch { text = raw.trim(); }
      if (!text) throw new HttpError(502, "E_AI_UNAVAILABLE", "The model returned no text");
      if (group === "headline") text = text.replace(/\s+/g, " ").slice(0, 220); else text = text.slice(0, 2600);
      const payload = group === "headline" ? { headline: text } : { summary: text };
      const draft = await urpc<Row>(c, "profile_draft_change", { p_sender: senderId, p_payload: payload, p_assets: {}, p_source: "ai_draft", p_template: null, p_experiment: null, p_note: `AI draft. ${brief ? `Brief: ${brief.slice(0, 200)}` : ""}` });
      await audit(s.workspace_id, "profile.ai_draft", "profile_change", draft.id, { field_group: group, facts_used: factsUsed }, "user");
      return json({ ok: true, change_id: draft.id, text, facts_used: factsUsed, validation: draft.validation, note: "This is a draft for a human to edit. It is never applied on its own." });
    }
    case "bulk_commit": {
      const r = await urpc<Row>(c, "profile_bulk_commit", { p_run: String(body.run_id ?? "") });
      const approvals: Row[] = [];
      for (const d of (r.details ?? []) as Row[]) if (d.status === "awaiting_owner" && d.change_id) { const { data: ch } = await admin.from("outreach_profile_changes").select("workspace_id").eq("id", d.change_id).maybeSingle(); approvals.push({ change_id: d.change_id, sender_id: d.sender_id, ...(await requestApproval(d.change_id, ch?.workspace_id ?? "")) }); }
      return json({ ok: true, ...r, approvals });
    }
    case "experiment_start":
    case "experiment_conclude": {
      const r = action === "experiment_start" ? await urpc<Row>(c, "profile_experiment_start", { p_id: String(body.experiment_id ?? "") }) : await urpc<Row>(c, "profile_experiment_conclude", { p_id: String(body.experiment_id ?? ""), p_apply_winner: !!body.apply_winner });
      const details: Row[] = action === "experiment_start" ? (r.details ?? []) : (r.applied?.details ?? []);
      const approvals: Row[] = [];
      for (const d of details) if (d.status === "awaiting_owner" && d.change_id) { const { data: ch } = await admin.from("outreach_profile_changes").select("workspace_id").eq("id", d.change_id).maybeSingle(); approvals.push({ change_id: d.change_id, sender_id: d.sender_id, ...(await requestApproval(d.change_id, ch?.workspace_id ?? "")) }); }
      return json({ ok: true, ...r, approvals });
    }
    default:
      log({ fn: "profile", warn: `unknown action ${action}` });
      throw new HttpError(400, "E_PAYLOAD_INVALID", `unknown action ${action}`);
  }
});
