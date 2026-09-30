// Private notes (private-notes-PRD.md) — worker jobs behind outreach-notes-worker.
//   emails  (every minute)  F45: mentions still unread after the person's delay → one email per person per conversation
//   purge   (daily)         F46: bodies + attachments of notes deleted more than 30 days ago
// Nothing here reads outreach_messages except the small "last 3 messages" context block for the email, and nothing here
// ever sends anything to a prospect. Note text is only ever addressed to the mentioned teammate's own email.
import { admin, log, rpc, WEB_ORIGIN } from "./supabase.ts";
import { button, esc, layout, sendEmail, workspaceBranding, emailConfigured } from "./notify.ts";

type Row = Record<string, any>;

export const NOTES_BUCKET = "outreach-chat-notes";

const fmtWhen = (iso: string | null | undefined): string => {
  if (!iso) return "";
  try { return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); } catch { return ""; }
};

/** Markdown-ish note text → safe inline HTML (bold / italic / code / links / line breaks). Escapes first, formats after. */
export function noteHtml(text: string): string {
  let h = esc(text);
  h = h.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  h = h.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  h = h.replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, "$1<b>$2</b>");
  h = h.replace(/(^|[^\w_])_([^_\n]+)_(?![\w_])/g, "$1<i>$2</i>");
  h = h.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  h = h.replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2">$2</a>');
  h = h.replace(/(^|\s)(@[\p{L}\p{N}][\p{L}\p{N} .'-]{0,60}?)(?=[,.;:!?]?(\s|$))/gu, "$1<b>$2</b>");
  return h.replace(/\n/g, "<br>");
}

/** F45: email the mentions that are still unread past the recipient's delay. Batches several notes of one conversation. */
export async function runMentionEmails(): Promise<Record<string, unknown>> {
  const due = (await rpc<Row[]>("note_mentions_due", { p_limit: 300 })) ?? [];
  if (!due.length) return { due: 0, emails: 0 };
  if (!emailConfigured()) {
    // no Resend key: mark them so the queue never grows; the in-app notification already happened
    const n = await rpc<number>("note_mentions_mark_emailed", { p_pairs: due.map((d) => ({ note_id: d.note_id, user_id: d.user_id })) });
    log({ fn: "notes-worker", skipped: "RESEND_API_KEY unset", marked: n });
    return { due: due.length, emails: 0, skipped: "email not configured" };
  }
  // group per recipient + conversation
  const groups = new Map<string, Row[]>();
  for (const d of due) { const k = `${d.user_id}:${d.chat_id}`; groups.set(k, [...(groups.get(k) ?? []), d]); }
  let emails = 0, failed = 0;
  const done: Array<{ note_id: string; user_id: string }> = [];
  const brandingCache = new Map<string, Awaited<ReturnType<typeof workspaceBranding>>>();
  for (const items of groups.values()) {
    const first = items[0];
    if (!first.email) { done.push(...items.map((i) => ({ note_id: i.note_id, user_id: i.user_id }))); continue; }
    let branding = brandingCache.get(first.workspace_id);
    if (!branding) { branding = await workspaceBranding(first.workspace_id); brandingCache.set(first.workspace_id, branding); }
    const context = (await rpc<Row[]>("note_email_context", { p_chat: first.chat_id, p_n: 3 }).catch(() => [])) ?? [];
    const open = `${WEB_ORIGIN}/outreach/inbox/${first.chat_id}?note=${items[items.length - 1].note_id}`;
    const notesHtml = items.map((i) => `
      <div style="border-left:3px solid #f59e0b;background:#fffbeb;padding:10px 12px;margin:10px 0;border-radius:6px">
        <div style="font-size:12px;color:#92400e;margin-bottom:4px">🔒 Private note · ${esc(i.author)} · ${esc(fmtWhen(i.created_at))}</div>
        <div style="font-size:14px;line-height:1.5;color:#1f2937">${noteHtml(String(i.body ?? ""))}</div>
      </div>`).join("");
    const ctxHtml = context.length
      ? `<p style="margin-top:16px;font-size:12px;color:#6b7280">Last messages in the conversation</p>${context.map((m) => `<div style="font-size:13px;color:#374151;margin:4px 0"><b>${m.from === "them" ? esc(first.chat_title.replace(/\s*\(.*\)$/, "")) : "You"}:</b> ${esc(String(m.text ?? ""))}</div>`).join("")}`
      : "";
    const subject = items.length === 1 ? `${first.author} mentioned you in ${first.chat_title}` : `${items.length} mentions in ${first.chat_title}`;
    const html = layout(esc(subject),
      `<p>${esc(first.author)}${items.length > 1 ? " and others" : ""} mentioned you in an internal note on <b>${esc(first.chat_title)}</b>. The note is only visible to your team, never to the prospect.</p>
       ${notesHtml}${ctxHtml}
       <p style="margin-top:18px">${button(open, "Open in inbox", branding)}</p>
       <p style="font-size:12px;color:#9ca3af;margin-top:14px">You get this email because the mention was still unread after your delay. Change it under Settings → Notifications.</p>`,
      branding, { audience: "team" });
    const ok = await sendEmail(first.email, subject, html, undefined, { branding });
    if (ok) emails++; else failed++;
    // a failed send is not retried forever: the in-app notification stands, and the mention is marked to keep the queue bounded
    done.push(...items.map((i) => ({ note_id: i.note_id, user_id: i.user_id })));
  }
  const marked = done.length ? await rpc<number>("note_mentions_mark_emailed", { p_pairs: done }) : 0;
  return { due: due.length, groups: groups.size, emails, failed, marked };
}

/** F46: purge deleted notes older than 30 days and remove their files from the private bucket. */
export async function runNotesPurge(): Promise<Record<string, unknown>> {
  const paths = ((await rpc<string[]>("notes_purge")) ?? []).filter((p) => typeof p === "string" && p.length > 0);
  let removed = 0, errors = 0;
  for (let i = 0; i < paths.length; i += 100) {
    const slice = paths.slice(i, i + 100);
    const { error } = await admin.storage.from(NOTES_BUCKET).remove(slice);
    if (error) { errors++; log({ fn: "notes-worker", warn: `purge remove: ${error.message}` }); } else removed += slice.length;
  }
  return { purged_paths: paths.length, removed, errors };
}
