// Sender lifecycle (sender-lifecycle-PRD.md): the TypeScript half of pause → disable → remove → erase.
// The database functions (migration 096) change the rows; this module does what needs the connector, Storage or email:
//   removeSender      remove_begin → connector DELETE → remove_finish (or leave it pending for the deletion queue)
//   ownerLink         the signed "Disconnect my account" / "Request deletion of my data" link for the sender owner
//   eraseTick         F51: due erasures (Storage objects first, then outreach_sender_erase_execute) and pause auto-resume
//   housekeeping      F52: auto-remove notices + removals, pending-removal retries and alerts, connector reconciliation
import { admin, log, rpc, flag, audit, emitEvent, WEB_ORIGIN } from "./supabase.ts";
import { deleteConnectorAccount, processAccountDeletions } from "./disconnect.ts";
import { unipile, unipileConfigured, UnipileError } from "./unipile.ts";
import { layout, button, esc, workspaceBranding, brandName, ownerLink, ownerLinkPageUrl, ownerDisconnectFooter } from "./notify.ts";
import { sendHolderEmail, sendTeamEmail, sendEmail as queueEmail } from "./email.ts";
export { ownerLink, ownerLinkPageUrl, ownerDisconnectFooter };

type Row = Record<string, any>;
export type RemovedVia = "app" | "owner_link" | "unipile_deleted" | "auto_after_disabled" | "trial_ended" | "workspace_deleted" | "reconcile" | "billing" | "canceled";

const CHANNEL_NAME: Record<string, string> = { LINKEDIN: "LinkedIn", INSTAGRAM: "Instagram", WHATSAPP: "WhatsApp", GMAIL: "Google", OUTLOOK: "Microsoft", IMAP: "the mail server" };

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------
export interface RemoveResult { state: "removed" | "pending" | "already" | "skipped"; sender_id: string; account_id: string | null; account_deleted: boolean; error?: string }

/**
 * Remove a sender (PRD §3.4). Disables it if needed, asks for the removal, deletes the connector account and finishes.
 * When the connector does not confirm, the sender stays disabled with "removal pending" and the deletion queue retries
 * (hourly billing job + nightly housekeeping); the queue calls outreach_sender_remove_finish on success.
 */
export async function removeSender(senderId: string, via: RemovedVia, opts: { reason?: string | null; by?: string | null; skipConnector?: boolean; notifyOwner?: boolean } = {}): Promise<RemoveResult> {
  const r = await rpc<Row>("sender_remove_begin", { p_sender: senderId, p_via: via, p_reason: opts.reason ?? null, p_by: opts.by ?? null });
  if (r?.skipped) return { state: "skipped", sender_id: senderId, account_id: null, account_deleted: false };
  if (r?.already) return { state: "already", sender_id: senderId, account_id: null, account_deleted: true };
  const accountId = (r?.account_id as string | null) ?? null;
  let deleted = !accountId;
  let error: string | undefined;
  if (accountId) {
    if (opts.skipConnector) {
      await rpc("account_deletion_result", { p_account: accountId, p_ok: true });
      deleted = true;
    } else {
      const d = await deleteConnectorAccount(accountId);
      deleted = d.ok; error = d.error;
      // the queue row records the outcome; on success the database finishes the removal in the same call
      await rpc("account_deletion_result", { p_account: accountId, p_ok: d.ok, p_error: d.error ?? null }).catch((e) => log({ fn: "lifecycle", error: String(e) }));
    }
  }
  const { data: s } = await admin.from("outreach_senders").select("id, status, removed_via").eq("id", senderId).maybeSingle();
  const removed = s?.status === "removed";
  if (removed && opts.notifyOwner !== false) await notifyOwnerRemoved(senderId, via, opts.by ?? null).catch((e) => log({ fn: "lifecycle", warn: "owner email failed", error: String(e) }));
  return { state: removed ? "removed" : "pending", sender_id: senderId, account_id: accountId, account_deleted: deleted, error };
}

/** Tell whoever signs in to the account that it was disconnected, with how to end the session on the provider's side (PRD §3.4 step 5).
 *  Skipped when the holder is the member who just removed it. */
export async function notifyOwnerRemoved(senderId: string, via: RemovedVia, by: string | null): Promise<void> {
  const { data: s } = await admin.from("outreach_senders").select("id, workspace_id, display_name, provider, status, owner_user_id").eq("id", senderId).maybeSingle();
  if (!s) return;
  if (by && s.owner_user_id === by && via !== "owner_link") return;
  const branding = await workspaceBranding(s.workspace_id);
  const who = by ? (await admin.from("outreach_members").select("display_name, email").eq("workspace_id", s.workspace_id).eq("user_id", by).maybeSingle()).data : null;
  const byName = via === "owner_link" ? "you" : who?.display_name || who?.email || (via === "trial_ended" ? "the end of the trial" : via === "auto_after_disabled" ? "the automatic clean-up (it was disabled for too long)" : via === "unipile_deleted" ? "the connector" : via === "billing" || via === "canceled" ? "billing" : "your workspace");
  const name = esc(s.display_name ?? "your account");
  const how = s.provider === "LINKEDIN"
    ? "LinkedIn may still list our session under <b>Settings &amp; Privacy → Sign in &amp; security → Where you're signed in</b>. You can end it there."
    : s.provider === "WHATSAPP" ? "On the phone with this number, open <b>WhatsApp → Linked devices</b> and log out the device named after this app."
    : s.provider === "INSTAGRAM" ? "In Instagram, open <b>Settings → Accounts Center → Password and security → Where you're logged in</b> and end the session you do not recognise."
    : `Your mailbox stays as it is; the connection from ${esc(brandName(branding))} is gone. You may also remove the app from your account's connected apps.`;
  await sendHolderEmail({ sender_id: s.id, type: "sender_removed_notice", subject: `${String(s.display_name ?? "Your account")} was disconnected from ${brandName(branding)}`,
    body: `<p>Your ${esc(CHANNEL_NAME[String(s.provider)] ?? "account")} account <b>${name}</b> was disconnected from ${esc(brandName(branding))} by ${esc(byName)}.</p>
     <p>Nothing more is sent from it. The stored sign-in was deleted. Conversations that already happened stay in the workspace's records.</p>
     <p>${how}</p>
     <p style="color:#6b7280;font-size:13px">To use this account again, a manager asks you to sign in once more; your history comes back when you do.</p>`,
    action: null, idempotency_key: `sender_removed_notice:${s.id}:${via}:${new Date().toISOString().slice(0, 10)}` });
}

/** An outside holder learns that the workspace connected their account, with the disconnect link (PRD §5.8.1). Once per account. */
export async function notifyConnected(senderId: string, accountId: string | null): Promise<void> {
  const { data: s } = await admin.from("outreach_senders").select("id, workspace_id, display_name, provider, owner_user_id, connected_by").eq("id", senderId).maybeSingle();
  if (!s || s.owner_user_id) return;
  const branding = await workspaceBranding(s.workspace_id);
  const who = s.connected_by ? (await admin.from("outreach_members").select("display_name").eq("workspace_id", s.workspace_id).eq("user_id", s.connected_by).maybeSingle()).data?.display_name : null;
  await sendHolderEmail({ sender_id: s.id, type: "sender_connected_notice", audience: "outside_only",
    subject: `${brandName(branding)} connected your ${CHANNEL_NAME[String(s.provider)] ?? ""} account`,
    body: `<p>${who ? `${esc(who)} at ` : ""}<b>${esc(brandName(branding))}</b> connected your ${esc(CHANNEL_NAME[String(s.provider)] ?? "")} account <b>${esc(s.display_name ?? "")}</b> to ${esc(brandName(branding))}, so they can send messages and read replies on your behalf.</p>
     <p>You are the person this account belongs to. Before the AI answers as you, or your profile is edited, you get a separate email asking for your permission. If the account ever needs signing in again, the sign-in link comes to this address.</p>
     <p>If this is not right, the link at the bottom disconnects the account at once, without logging in.</p>`,
    action: null, idempotency_key: `sender_connected_notice:${s.id}:${accountId ?? "x"}` });
}

/** Whose account → Change (PRD §5.8.1): the old outside address, and a teammate set as holder by someone else. */
export async function notifyHolderChanged(senderId: string, change: Row, byUserId: string): Promise<void> {
  const { data: s } = await admin.from("outreach_senders").select("id, workspace_id, display_name, provider").eq("id", senderId).maybeSingle();
  if (!s) return;
  const branding = await workspaceBranding(s.workspace_id);
  const by = (await admin.from("outreach_members").select("display_name").eq("workspace_id", s.workspace_id).eq("user_id", byUserId).maybeSingle()).data?.display_name ?? "A manager";
  if (change.old_outside_email) {
    await queueEmail({ ...({ __holder: true } as Row), type: "sender_holder_changed", to: String(change.old_outside_email), workspace_id: s.workspace_id, sender_id: s.id, outside_holder: true,
      subject: `You're no longer the contact for ${String(s.display_name ?? "an account")} on ${brandName(branding)}`,
      html: layout(esc(`You're no longer the contact for ${String(s.display_name ?? "an account")}`), `<p>${esc(by)} at ${esc(brandName(branding))} set someone else as the person who signs in to <b>${esc(s.display_name ?? "")}</b>. You will not receive sign-in links or notices about it any more. Any link we sent you earlier no longer works.</p>`, branding, { audience: "client" }),
      idempotency_key: `sender_holder_changed:${s.id}:${change.old_outside_email}:${Date.now()}` });
  }
  if (change.notify_member) {
    await sendHolderEmail({ sender_id: s.id, type: "sender_holder_changed", audience: "members_only", subject: `${by} set you as the person who signs in to ${String(s.display_name ?? "an account")}`,
      body: `<p>${esc(by)} set you as the person who signs in to <b>${esc(s.display_name ?? "")}</b> (${esc(CHANNEL_NAME[String(s.provider)] ?? "")}). Sign-in links and notices about it come to your sign-in email from now on. If that is not right, change it on the sender page.</p>`,
      idempotency_key: `sender_holder_changed:${s.id}:${change.notify_member}:${Date.now()}` });
  }
}

/** Erase scheduled: whoever signs in to the account hears it (PRD §3.5). */
export async function notifyEraseScheduled(senderId: string, at: string): Promise<void> {
  const { data: s } = await admin.from("outreach_senders").select("id, workspace_id, display_name").eq("id", senderId).maybeSingle();
  if (!s) return;
  const branding = await workspaceBranding(s.workspace_id);
  await sendHolderEmail({ sender_id: s.id, type: "sender_erase_notice", subject: `Conversations of ${String(s.display_name ?? "your account")} will be deleted`,
    body: `<p>${esc(brandName(branding))} scheduled the deletion of every conversation and personal record of <b>${esc(s.display_name ?? "")}</b> for ${esc(new Date(at).toUTCString())}. Report numbers stay as counts only.</p><p>After that time it cannot be undone.</p>`,
    action: null, idempotency_key: `sender_erase_notice:${s.id}:${at}` });
}

/** Billing day 14 (§5.9.2): each account's holder who is not already a billing recipient. */
export async function notifyRemovalBilling(workspaceId: string, removeAt: string, billingRecipients: string[]): Promise<number> {
  const { data: ws } = await admin.from("outreach_workspaces").select("name").eq("id", workspaceId).maybeSingle();
  const ctx = await rpc<Row>("billing_email_context", { p_ws: workspaceId }).catch(() => null);
  let n = 0;
  const when = new Date(removeAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  for (const s of (ctx?.senders ?? []) as Row[]) {
    const holder = s.holder ?? {};
    if (holder.kind === "none" || !holder.email || billingRecipients.includes(String(holder.email).toLowerCase())) continue;
    const r = await sendHolderEmail({ sender_id: String(s.id), type: "sender_removal_billing_notice", subject: `${String(s.name ?? "Your account")} will be disconnected on ${when}`,
      body: holder.outside
        ? `<p>${esc(ws?.name ?? "The workspace")}'s workspace is paused because of a billing issue. Your ${esc(CHANNEL_NAME[String(s.provider)] ?? "")} account <b>${esc(s.name ?? "")}</b> will be disconnected on <b>${esc(when)}</b> unless that is sorted out. Nothing more is sent from it in the meantime.</p>`
        : `<p>Your ${esc(CHANNEL_NAME[String(s.provider)] ?? "")} account <b>${esc(s.name ?? "")}</b> will be disconnected on <b>${esc(when)}</b> because of a billing issue. Ask ${esc(ctx?.owner_name ?? "the workspace owner")} to update payment.</p>`,
      action: null, idempotency_key: `sender_removal_billing_notice:${s.id}:${removeAt.slice(0, 10)}` });
    if (r.sent) n++;
  }
  return n;
}

/** Reactivation (§5.9.4): a sign-in link for every account removed while suspended; reconnecting restores its history. */
export async function notifyReconnectAfterBilling(workspaceId: string, removed: Row[]): Promise<number> {
  const { data: ws } = await admin.from("outreach_workspaces").select("name").eq("id", workspaceId).maybeSingle();
  let n = 0;
  for (const r of removed) {
    const { data: s } = await admin.from("outreach_senders").select("*").eq("id", r.id).maybeSingle();
    if (!s) continue;
    let link: string | null = null;
    try { const { reconnectLink } = await import("./inbound.ts"); link = await reconnectLink(s as never); } catch (e) { log({ fn: "lifecycle", warn: "reconnect link", sender_id: s.id, error: String(e) }); }
    const x = await sendHolderEmail({ sender_id: s.id, type: "sender_reconnect_after_billing", subject: `Sign in again to ${String(s.display_name ?? "your account")}`,
      body: `<p>${esc(ws?.name ?? "The workspace")} is active again. Your ${esc(CHANNEL_NAME[String(s.provider)] ?? "")} account <b>${esc(s.display_name ?? "")}</b> was disconnected while it was paused; sign in once more and its conversations, history and warm-up come back.</p>${link ? "" : `<p>Open the sender page for a sign-in link.</p>`}`,
      action: link ? { label: "Sign in again", url: link } : null, idempotency_key: `sender_reconnect_after_billing:${s.id}:${new Date().toISOString().slice(0, 10)}` });
    if (x.sent) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// owner links (PRD §4): token + page URL + footer live in notify.ts (every owner email uses them)
// ---------------------------------------------------------------------------
/** Managers learn that the owner disconnected their own account (in-app event + email). */
export async function notifyManagersOwnerAction(senderId: string, action: "disconnected" | "erase_requested", taskId?: string | null): Promise<void> {
  const { data: s } = await admin.from("outreach_senders").select("id, workspace_id, display_name, provider, owner_email").eq("id", senderId).maybeSingle();
  if (!s) return;
  const branding = await workspaceBranding(s.workspace_id);
  const name = esc(s.display_name ?? "A sender");
  const url = `${WEB_ORIGIN}/outreach/senders/${s.id}`;
  const subject = action === "disconnected" ? `${s.display_name ?? "A sender"} disconnected their account` : `${s.display_name ?? "A sender"} asked for their data to be deleted`;
  const body = action === "disconnected"
    ? `<p><b>${name}</b> (${esc(s.owner_email ?? "the account owner")}) used the link in their email to disconnect their ${esc(CHANNEL_NAME[String(s.provider)] ?? "")} account from the workspace.</p><p>Leads in its sequences left them. Conversations and report numbers stay. The account slot is free for another account.</p><p>${button(url, "Open the sender", branding)}</p>`
    : `<p><b>${name}</b> (${esc(s.owner_email ?? "the account owner")}) asked for their conversations and personal data to be deleted.</p><p>A task was created for the workspace owner${taskId ? "" : ""}. The decision is the workspace's: on the sender page, <b>Account → Erase</b> schedules the deletion with a 24-hour window to cancel. Under the GDPR the answer is usually due within one month.</p><p>${button(url, "Open the sender", branding)}</p>`;
  const html = layout(subject, body, branding);
  const r = await sendTeamEmail({ workspace_id: s.workspace_id, type: "sender_owner_action", subject, html, sender_id: s.id, idempotency_key: `sender_owner_action:${s.id}:${action}:${Date.now()}` });
  await emitEvent(s.workspace_id, action === "disconnected" ? "sender.owner_disconnected" : "sender.erase_requested", { id: s.id, by: "owner" });
  await audit(s.workspace_id, `notify.sender_owner_${action}`, "sender", s.id, { recipients: r.recipients });
}

// ---------------------------------------------------------------------------
// F51 — erase tick (every 15 min, dispatched only when there is work)
// ---------------------------------------------------------------------------
async function deleteStoragePaths(paths: Row[]): Promise<{ done: number; left: Row[]; error?: string }> {
  let done = 0; const left: Row[] = []; let error: string | undefined;
  for (const p of paths) {
    const bucket = String(p.bucket ?? "outreach-attachments");
    try {
      if (p.path) {
        const { error: e } = await admin.storage.from(bucket).remove([String(p.path)]);
        if (e && !/not found|does not exist/i.test(e.message)) throw e;
      } else if (p.prefix) {
        // chat avatars live under <ws>/avatars/<chat id>.<ext>: list the folder and remove the matching files
        const prefix = String(p.prefix);
        const dir = prefix.slice(0, prefix.lastIndexOf("/"));
        const base = prefix.slice(prefix.lastIndexOf("/") + 1);
        const { data: list, error: le } = await admin.storage.from(bucket).list(dir, { search: base, limit: 20 });
        if (le) throw le;
        const names = (list ?? []).filter((f: Row) => String(f.name).startsWith(base)).map((f: Row) => `${dir}/${f.name}`);
        if (names.length) { const { error: e } = await admin.storage.from(bucket).remove(names); if (e) throw e; }
      }
      done++;
    } catch (e) { error = String((e as Error)?.message ?? e); left.push(p); }
  }
  return { done, left, error };
}

export async function eraseTick(): Promise<Row> {
  const out: Row = { erased: 0, storage_deleted: 0, waiting: 0, resumed: 0, errors: [] as string[] };
  const due = (await rpc<Row[]>("sender_erase_due", { p_limit: 10 })) ?? [];
  for (const d of due) {
    try {
      // first run: compute what has to go from Storage; later runs: finish what is left on the job row
      let paths: Row[] = Array.isArray(d.storage_paths) ? d.storage_paths : [];
      if (!d.started) paths = (await rpc<Row[]>("sender_erase_storage_paths", { p_sender: d.sender_id })) ?? [];
      const r = await deleteStoragePaths(paths);
      out.storage_deleted += r.done;
      await rpc("sender_erase_progress", { p_sender: d.sender_id, p_storage_paths: r.left, p_done: r.done, p_error: r.error ?? null });
      if (r.left.length) { out.waiting++; log({ fn: "sender-erase", sender_id: d.sender_id, waiting_storage: r.left.length, error: r.error }); continue; }
      const x = await rpc<Row>("sender_erase_execute", { p_sender: d.sender_id });
      out.erased++;
      log({ fn: "sender-erase", sender_id: d.sender_id, erased: x });
    } catch (e) { out.errors.push(`${d.sender_id}: ${String((e as Error)?.message ?? e)}`); log({ fn: "sender-erase", sender_id: d.sender_id, error: String(e) }); }
  }
  // pauses whose auto-resume time has come (PRD §3.2)
  const { data: toResume } = await admin.from("outreach_senders").select("id, workspace_id, display_name").eq("status", "paused").is("deleted_at", null).lte("pause_resume_at", new Date().toISOString()).limit(50);
  for (const s of toResume ?? []) {
    try { await rpc("sender_resume", { p_sender: s.id }); out.resumed++; }
    catch (e) {
      // a billing pause that also had a resume time: clear the time so it is not retried forever
      await admin.from("outreach_senders").update({ pause_resume_at: null }).eq("id", s.id);
      log({ fn: "sender-erase", sender_id: s.id, resume_error: String(e) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// F52 — nightly housekeeping
// ---------------------------------------------------------------------------
async function emailAutoRemoveNotice(s: Row): Promise<void> {
  const branding = await workspaceBranding(s.workspace_id);
  const when = new Date(s.auto_remove_at).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const name = esc(s.display_name ?? "A sender");
  const subject = `${s.display_name ?? "A sender"} will be removed on ${when}`;
  const body = `<p><b>${name}</b> has been disabled since ${esc(new Date(s.disabled_at ?? s.updated_at).toLocaleDateString("en-GB", { day: "numeric", month: "long" }))}. A disabled account still uses one of the paid accounts and still costs the connector fee, so it is removed automatically after ${esc(s.auto_remove_after_days)} days: on <b>${esc(when)}</b>.</p><p>Removing keeps every conversation and report number; it only unlinks the account and frees the slot. To keep it connected, enable it before then.</p>`;
  const html = layout(subject, `${body}<p>${button(`${WEB_ORIGIN}/outreach/senders/${s.id}?tab=Account`, "Open the sender", branding)}</p>`, branding);
  const team = await sendTeamEmail({ workspace_id: s.workspace_id, type: "sender_auto_remove_team", subject, html, sender_id: s.id, idempotency_key: `sender_auto_remove_team:${s.id}:${String(s.auto_remove_at).slice(0, 10)}` });
  const holder = await sendHolderEmail({ sender_id: s.id, type: "sender_auto_remove_notice", subject, body, action: { label: "Open the sender", url: `${WEB_ORIGIN}/outreach/senders/${s.id}?tab=Account` }, idempotency_key: `sender_auto_remove_notice:${s.id}:${String(s.auto_remove_at).slice(0, 10)}` });
  await audit(s.workspace_id, "notify.sender_auto_remove_notice", "sender", s.id, { recipients: [...team.recipients, ...(holder.to ? [holder.to] : [])], auto_remove_at: s.auto_remove_at });
}

async function emailRemovalStuck(s: Row, attempts: number, error: string | null): Promise<void> {
  const branding = await workspaceBranding(s.workspace_id);
  const subject = `Removal of ${s.display_name ?? "a sender"} is waiting on the connector`;
  const html = layout(subject, `<p>You asked to remove <b>${esc(s.display_name ?? "a sender")}</b>, but the connector did not confirm that its account was deleted (${esc(attempts)} attempts${error ? `, last error: ${esc(error.slice(0, 160))}` : ""}).</p><p>The sender stays disabled and sends nothing. We keep retrying every hour; our records only say "removed" once the connector confirms. Nothing to do on your side unless this message repeats tomorrow.</p>`, branding);
  await sendTeamEmail({ workspace_id: s.workspace_id, type: "removal_pending", subject, html, sender_id: s.id, idempotency_key: `removal_pending:${s.id}:${new Date().toISOString().slice(0, 10)}` });
  await admin.from("outreach_sender_events").insert({ sender_id: s.id, kind: "lifecycle", data: { action: "removal_stuck_notice", attempts, error } });
}

/** GET /accounts, paged. Returns null when the listing could not be completed (never act on a partial list). */
async function listAllConnectorAccounts(): Promise<Row[] | null> {
  if (!unipileConfigured()) return null;
  const out: Row[] = [];
  let cursor: string | null | undefined = undefined;
  for (let page = 0; page < 40; page++) {
    try {
      const r = await unipile.accounts.listPage(cursor ?? undefined);
      out.push(...(r.items ?? []));
      cursor = r.cursor ?? null;
      if (!cursor) return out;
    } catch (e) { log({ fn: "sender-housekeeping", warn: "accounts list failed", error: String(e) }); return null; }
  }
  return null;
}

/** PRD §5.7: orphans on the connector; senders whose account the connector no longer lists. Report-only unless the flag sender_reconcile_cleanup is true. */
export async function reconcileConnector(): Promise<Row> {
  const out: Row = { listed: 0, orphans: 0, orphans_deleted: 0, missing: 0, missing_removed: 0, cleanup: false, skipped: null as string | null };
  const accounts = await listAllConnectorAccounts();
  if (!accounts) { out.skipped = "connector list unavailable"; return out; }
  out.listed = accounts.length;
  const cleanup = (await flag("sender_reconcile_cleanup", false)) === true;
  out.cleanup = cleanup;
  const ids = accounts.map((a) => String(a.id));
  const { data: live } = await admin.from("outreach_senders").select("id, unipile_account_id, status, display_name, workspace_id").not("unipile_account_id", "is", null);
  const byAccount = new Map<string, Row>((live ?? []).map((s) => [String(s.unipile_account_id), s]));
  // accounts a sign-in link is still about to bind, or the deletion queue already owns, are not orphans
  const { data: pending } = await admin.from("outreach_account_deletions").select("account_id").is("done_at", null);
  const queued = new Set<string>((pending ?? []).map((p) => String(p.account_id)));
  const dayAgo = Date.now() - 24 * 3600_000;
  for (const a of accounts) {
    const id = String(a.id);
    if (byAccount.has(id) || queued.has(id)) continue;
    const created = a.created_at ? new Date(a.created_at).getTime() : 0;
    if (created && created > dayAgo) continue;                 // a wizard that may still complete
    out.orphans++;
    let action = "reported";
    if (cleanup) {
      const d = await deleteConnectorAccount(id);
      if (d.ok) { action = "deleted"; out.orphans_deleted++; }
    }
    await admin.from("outreach_unipile_reconcile_log").insert({ unipile_account_id: id, finding: "orphan", action, detail: { name: a.name ?? null, type: a.type ?? null, created_at: a.created_at ?? null } });
  }
  const listed = new Set(ids);
  for (const s of live ?? []) {
    if (!["ok", "paused", "disabled", "credentials", "error", "connecting"].includes(String(s.status))) continue;
    if (listed.has(String(s.unipile_account_id))) continue;
    // the list said no: confirm with a direct read before anything is marked (a 404 is the only proof)
    let gone = false;
    try { await unipile.accounts.get(String(s.unipile_account_id)); } catch (e) { gone = e instanceof UnipileError && e.status === 404; }
    if (!gone) continue;
    out.missing++;
    let action = "reported";
    if (cleanup) {
      await removeSender(s.id, "reconcile", { reason: "account missing on the connector", skipConnector: true });
      action = "sender_marked_removed"; out.missing_removed++;
    }
    await admin.from("outreach_unipile_reconcile_log").insert({ unipile_account_id: String(s.unipile_account_id), finding: "missing_in_unipile", action, sender_id: s.id, detail: { status: s.status, name: s.display_name } });
  }
  return out;
}

export async function housekeeping(): Promise<Row> {
  const now = new Date();
  const out: Row = { notices: 0, auto_removed: 0, auto_remove_pending: 0, retries: { deleted: 0, failed: 0 }, stuck_notified: 0, reconcile: null as Row | null, errors: [] as string[] };
  // 1. notices 7 days before the automatic removal (PRD §5.6)
  const { data: soon } = await admin.from("outreach_senders").select("id, workspace_id, display_name, disabled_at, updated_at, auto_remove_at, auto_remove_after_days")
    .eq("status", "disabled").is("deleted_at", null).is("auto_remove_notice_at", null).is("removal_requested_at", null)
    .lte("auto_remove_at", new Date(now.getTime() + 7 * 86400_000).toISOString()).limit(100);
  for (const s of soon ?? []) {
    try { await emailAutoRemoveNotice(s); await admin.from("outreach_senders").update({ auto_remove_notice_at: now.toISOString() }).eq("id", s.id); out.notices++; }
    catch (e) { out.errors.push(`notice ${s.id}: ${String((e as Error)?.message ?? e)}`); }
  }
  // 2. removals past their date
  const { data: due } = await admin.from("outreach_senders").select("id").eq("status", "disabled").is("deleted_at", null).is("removal_requested_at", null).lte("auto_remove_at", now.toISOString()).limit(50);
  for (const s of due ?? []) {
    try { const r = await removeSender(s.id, "auto_after_disabled", { reason: "disabled for the auto-remove period" }); if (r.state === "removed") out.auto_removed++; else out.auto_remove_pending++; }
    catch (e) { out.errors.push(`auto-remove ${s.id}: ${String((e as Error)?.message ?? e)}`); }
  }
  // 3. connector deletes that did not confirm (the hourly billing job also drains this queue)
  const retries = await processAccountDeletions(40);
  out.retries = { deleted: retries.deleted, failed: retries.failed };
  // 4. "removal pending" for more than 6 hours: tell the managers once a day (PRD §3.4 step 3)
  const { data: stuck } = await admin.from("outreach_senders").select("id, workspace_id, display_name, removal_requested_at").not("removal_requested_at", "is", null).is("removed_at", null).is("deleted_at", null)
    .not("unipile_account_id", "is", null).lte("removal_requested_at", new Date(now.getTime() - 6 * 3600_000).toISOString()).limit(50);
  for (const s of stuck ?? []) {
    const { data: recent } = await admin.from("outreach_sender_events").select("id").eq("sender_id", s.id).eq("kind", "lifecycle").eq("data->>action", "removal_stuck_notice").gte("at", new Date(now.getTime() - 23 * 3600_000).toISOString()).limit(1);
    if (recent?.length) continue;
    const { data: q } = await admin.from("outreach_account_deletions").select("attempts, last_error").eq("sender_id", s.id).is("done_at", null).maybeSingle();
    try { await emailRemovalStuck(s, Number(q?.attempts ?? 0), q?.last_error ?? null); out.stuck_notified++; } catch (e) { out.errors.push(`stuck ${s.id}: ${String((e as Error)?.message ?? e)}`); }
  }
  // 5. reconciliation (report-only until the flag is on)
  try { out.reconcile = await reconcileConnector(); } catch (e) { out.errors.push(`reconcile: ${String((e as Error)?.message ?? e)}`); }
  return out;
}
