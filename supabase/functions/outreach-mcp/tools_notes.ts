// outreach-mcp/tools_notes.ts — private team notes inside inbox conversations (private-notes-PRD.md §12).
// A note never reaches a prospect (own table, no send path), so note_add is a plain write: no confirmation gate.
// Every session here is a signed-in member's OAuth grant (there are no unattended tokens on this connector), so the
// note is stored as author_type 'agent' and shown as "Claude (via <member>)"; mentions are allowed and notify at once.
// Volume guard: 60 notes per hour per member (SQL rate limit in outreach_note_create) on top of the write quota.
import type { McpServer } from "npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js";
import { type Ctx, tool, z, wsParam, resolveWs, urpc, McpError, untrusted, short } from "./ctx.ts";
import { notesFor } from "./tools_inbox.ts";

type Row = Record<string, any>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Members of the chat's workspace by id / email / name (for `mentions` given as names). */
async function resolveMentions(ctx: Ctx, ws: { id: string }, wanted: string[]): Promise<{ tokens: string[]; unknown: string[] }> {
  const members = ((await urpc<Row[]>(ctx, "workspace_members", { p_ws: ws.id }).catch(() => [])) ?? []) as Row[];
  const tokens: string[] = [], unknown: string[] = [];
  for (const w of wanted) {
    const q = String(w ?? "").trim().replace(/^@/, "");
    if (!q) continue;
    const m = members.find((x) => (UUID_RE.test(q) && x.user_id === q) || String(x.email ?? "").toLowerCase() === q.toLowerCase()
      || String(x.display_name ?? "").toLowerCase() === q.toLowerCase());
    if (m) tokens.push(`@[${(m.display_name || m.email || "teammate").replace(/[\[\]]/g, "")}](user:${m.user_id})`);
    else unknown.push(q);
  }
  return { tokens, unknown };
}

export function registerNotes(server: McpServer, ctx: Ctx): void {
  tool(server, ctx, {
    name: "note_add", title: "Add a private note to a conversation", cls: "write", minRole: "client_viewer",
    description: "Leave an internal note on a chat: context for teammates (\"spoke on a call, budget ~4L\"), a question (\"@Naman can you quote?\"), a handoff. The prospect never sees it — notes live outside the message store and no send path reads them. Mentioned teammates get an in-app notification at once (and an email if still unread after their delay). `mentions` takes names, emails or user ids of workspace members who can read the chat; anyone else is dropped and reported. Markdown subset allowed (bold, italic, lists, links). Start the body with #no-ai to keep it out of the AI reply engine's context. Shown in the inbox as \"Claude (via <you>)\".",
    input: {
      chat_id: z.string(), body: z.string().min(1).max(10000),
      mentions: z.array(z.string()).max(20).optional().describe("Teammates to notify: display name, email or user id"),
      visibility: z.enum(["team", "team_and_client"]).optional().describe("team (default) or team_and_client (client viewers of this chat's client can read it too)"),
    },
  }, async (a) => {
    const { data: chat, error } = await ctx.user.from("outreach_chats").select("id, workspace_id").eq("id", a.chat_id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!chat) throw new McpError("E_NOT_FOUND", `chat ${a.chat_id} not found or not visible`);
    const ws = resolveWs(ctx, chat.workspace_id);
    const { tokens, unknown } = a.mentions?.length ? await resolveMentions(ctx, ws, a.mentions) : { tokens: [], unknown: [] };
    // tokens go first so the mention sits at the top of the note; names typed inside the body stay plain text
    const body = [...tokens, a.body.trim()].join(" ").slice(0, 10000);
    const n = await urpc<Row>(ctx, "note_create", { p_chat: chat.id, p_body: body, p_visibility: a.visibility ?? "team", p_attachments: [], p_author_type: "agent" });
    const dropped = ((n?.dropped_mentions ?? []) as Row[]).map((d) => `${d.name} (${d.reason === "no_access" ? "cannot read this conversation" : d.reason === "cap" ? "over the 20-mention cap" : d.reason})`);
    return {
      note_id: n?.id, chat_id: chat.id, visibility: n?.visibility, created_at: n?.created_at, author: n?.author?.name,
      notified: ((n?.mentions ?? []) as Row[]).map((m) => m.name),
      not_notified: [...dropped, ...unknown.map((u) => `${u} (not a member of this workspace)`)].length ? [...dropped, ...unknown.map((u) => `${u} (not a member of this workspace)`)] : undefined,
      next: "Nothing was sent to the prospect. Tell the user who was notified; if someone was not, say why.",
    };
  });

  tool(server, ctx, {
    name: "notes_list", title: "Private notes of a conversation", cls: "read", minRole: "client_viewer",
    description: "Internal team notes on one chat, oldest first (author, time, body with @mentions, visibility). inbox_thread already includes them under `notes`; use this when only the notes are needed. Deleted notes are left out.",
    input: { chat_id: z.string() },
  }, async (a) => ({ chat_id: a.chat_id, notes: await notesFor(ctx, a.chat_id) }));

  tool(server, ctx, {
    name: "mentions_list", title: "Where I was mentioned", cls: "read", minRole: "client_viewer",
    description: "Conversations where a teammate mentioned the connected member in a private note, unread first, then newest: chat, lead, who wrote it, the note snippet, unread count. Use for \"anything waiting on me?\" together with inbox_pending and tasks_list.",
    input: { ...wsParam, unread_only: z.boolean().optional(), limit: z.number().int().min(1).max(200).optional() },
  }, async (a) => {
    const ws = resolveWs(ctx, a.workspace_id);
    const rows = ((await urpc<Row[]>(ctx, "mentions_list", { p_ws: ws.id, p_unread_only: a.unread_only === true, p_limit: a.limit ?? 50 })) ?? []) as Row[];
    return {
      workspace: ws.name, total: rows.length, unread: rows.filter((r) => !r.read_at).length,
      mentions: rows.map((r) => ({
        chat_id: r.chat_id, note_id: r.note_id, at: r.created_at, unread: r.read_at ? undefined : true, unread_in_chat: r.unread_count,
        lead: r.chat?.lead_name ?? r.chat?.attendee_name, company: r.chat?.company, channel: r.chat?.provider, sender: r.chat?.sender_name,
        by: r.author, note: untrusted("team_note", short(String(r.snippet ?? ""), 160), 160),
      })),
      next: "Open a thread with inbox_thread {chat_id} to read the whole note in context. note_mark_read clears a mention once the user has dealt with it.",
    };
  });

  tool(server, ctx, {
    name: "note_mark_read", title: "Mark a mention as read", cls: "write", minRole: "client_viewer",
    description: "Marks the connected member's mention on this note (and its bell notification) as read. Only after the user has actually seen or handled it.",
    input: { note_id: z.string() },
  }, async (a) => {
    const r = await urpc<Row>(ctx, "note_mark_read", { p_note: a.note_id });
    return { note_id: a.note_id, cleared: r };
  });
}
