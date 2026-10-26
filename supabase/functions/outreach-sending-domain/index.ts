// F56 — Sending domain setup (custom-sending-domain-PRD.md §4, §8.1). Owner and managers, Scale and Enterprise.
//   POST {workspace_id, action, ...}
//     list                                    the workspace's domains (and its clients') + the plan's allowance
//     check {domain, client_id?}              the checks before anything is created, with warnings
//     create {domain, client_id?, region?}    Resend domain + domain-scoped key; returns the DNS records
//     verify {id}                             "Check now"
//     update {id, from_name?, from_local_part?, reply_to?, branding?}
//     test {id, to?}                          a direct send from the domain to the current user
//     activate {id} · pause {id, note?} · resume {id, note?} · remove {id}
//     email_records {id, to}                  the DNS records emailed to an IT person
//     dmarc {id}                              the DMARC lookup
//     types                                   which emails use the domain / always come from the platform
import { json, serve, requireUser, membership, requireRole, readJson, HttpError, rateLimit } from "../_shared/outreach/supabase.ts";
import { createDomain, refreshDomain, updateIdentity, sendTest, activate, pause, resume, removeDomain, emailRecords, checkDmarc, DomainError } from "../_shared/outreach/sending_domains.ts";

type Row = Record<string, any>;

async function userRpc<T = unknown>(user: { client: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> } }, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await user.client.rpc(fn, args);
  if (error) {
    const m = /^(E_[A-Z_]+):?\s*(.*)$/s.exec(error.message.trim());
    if (m) throw new HttpError(m[1] === "E_FORBIDDEN" ? 403 : m[1] === "E_NOT_FOUND" ? 404 : m[1] === "E_PLAN_REQUIRED" ? 402 : 409, m[1], m[2] || undefined);
    throw new Error(error.message);
  }
  return data as T;
}

serve("sending-domain", async (req) => {
  const user = await requireUser(req);
  const body = await readJson<Row>(req);
  const wsId = String(body.workspace_id ?? "");
  const action = String(body.action ?? "");
  if (!wsId || !action) throw new HttpError(400, "E_PAYLOAD_INVALID", "workspace_id and action required");
  const m = await membership(user.id, wsId);
  requireRole(m, action === "list" || action === "types" ? "member" : "manager");
  await rateLimit(`user:${user.id}:sending-domain`, 60, 60);
  const owned = async (id: string): Promise<void> => {
    const list = await userRpc<Row>(user, "outreach_sending_domains", { p_ws: wsId });
    if (!(list?.domains ?? []).some((d: Row) => d.id === id)) throw new HttpError(404, "E_NOT_FOUND", "domain not found in this workspace");
  };
  try {
    switch (action) {
      case "list": return json(await userRpc<Row>(user, "outreach_sending_domains", { p_ws: wsId, p_client: body.client_id ?? null }));
      case "types": return json(await userRpc<Row>(user, "outreach_email_types_by_rule", {}));
      case "check": return json(await userRpc<Row>(user, "outreach_sending_domain_check", { p_ws: wsId, p_domain: String(body.domain ?? ""), p_client: body.client_id ?? null }));
      case "create": return json(await createDomain(wsId, user.id, { domain: String(body.domain ?? ""), client_id: body.client_id ?? null, region: body.region ?? null }), 201);
      case "verify": await owned(String(body.id)); return json(await refreshDomain(String(body.id), { verify: true, source: "check_now" }));
      case "update": await owned(String(body.id)); return json(await updateIdentity(String(body.id), user.id, body));
      case "test": {
        await owned(String(body.id));
        const to = String(body.to ?? user.email ?? "").trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new HttpError(400, "E_PAYLOAD_INVALID", "a valid address is needed for the test");
        return json(await sendTest(String(body.id), to, user.id));
      }
      case "activate": await owned(String(body.id)); return json(await activate(String(body.id), user.id));
      case "pause": await owned(String(body.id)); return json(await pause(String(body.id), user.id, body.note));
      case "resume": await owned(String(body.id)); return json(await resume(String(body.id), user.id, body.note));
      case "remove": await owned(String(body.id)); return json(await removeDomain(String(body.id), user.id));
      case "email_records": {
        await owned(String(body.id));
        const to = String(body.to ?? "").trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new HttpError(400, "E_PAYLOAD_INVALID", "enter the IT person's email");
        return json(await emailRecords(String(body.id), to, user.id));
      }
      case "dmarc": await owned(String(body.id)); return json(await checkDmarc(String(body.id)));
      default: throw new HttpError(400, "E_PAYLOAD_INVALID", `unknown action ${action}`);
    }
  } catch (e) {
    if (e instanceof DomainError) throw new HttpError(e.status, e.code, e.message);
    throw e;
  }
});
