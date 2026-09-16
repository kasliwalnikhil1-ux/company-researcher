// outreach-mcp/steps.ts — compact step list ⇄ canonical sequence graph.
//
// Agents describe a sequence as a short list of steps (PRD §5.3); the server
// compiles it to the graph shape the engine executes (lib/outreach/types.ts:
// {version:1, start, nodes:{id:{id,type,config,delay?,next?,branches?,position}}}).
// Compilation errors are returned as field-level messages, never thrown.

import { McpError } from "./ctx.ts";

export interface Graph { version: 1; start: string; nodes: Record<string, GraphNode> }
export interface GraphNode {
  id: string; type: string; label?: string; config?: Record<string, unknown>;
  delay?: { amount: number; unit: "minutes" | "hours" | "days"; jitter_pct?: number };
  mode?: "auto" | "manual"; next?: string | null; branches?: Record<string, string | null>;
  position: { x: number; y: number };
}
export type Step = Record<string, unknown>;
export interface CompileIssue { step_path: string; field?: string; code: string; message: string }

// step verb → node type
const VERBS: Record<string, string> = {
  visit_profile: "visit_profile", visit: "visit_profile",
  like_post: "like_latest_post", like: "like_latest_post",
  comment_post: "comment_latest_post", comment: "comment_latest_post",
  endorse: "endorse_skills",
  invite: "send_invite", connect: "send_invite",
  wait_connection: "wait_connection",
  withdraw: "withdraw_invite",
  message: "send_message", inmail: "send_inmail", email: "send_email",
  delay: "delay", wait: "delay",
  condition: "condition", if: "condition",
  tag: "add_tag", untag: "remove_tag", list: "change_list", stage: "change_stage",
  webhook: "call_webhook", api: "call_api", send_to_sequence: "send_to_sequence",
  manual_task: "manual_task", task: "manual_task",
  ai_draft: "ai_draft_approval",
  end: "end",
};

const TERMINAL = new Set(["end", "send_to_sequence"]);
export const TEXT_LIMITS = { invite_note: 300, invite_note_free: 200, message: 8000, comment: 1250, inmail_subject: 200, inmail_body: 1900 } as const;

/** "2h" | "3d" | "30m" | "0d" | {amount, unit} → NodeDelay */
export function parseWait(v: unknown): { amount: number; unit: "minutes" | "hours" | "days" } | null {
  if (v == null || v === "") return null;
  if (typeof v === "object") {
    const o = v as { amount?: number; unit?: string };
    if (typeof o.amount === "number" && ["minutes", "hours", "days"].includes(String(o.unit))) return { amount: o.amount, unit: o.unit as "minutes" | "hours" | "days" };
    return null;
  }
  const m = /^\s*(\d+(?:\.\d+)?)\s*([mhd]|min|mins|minutes?|hours?|days?)\s*$/i.exec(String(v));
  if (!m) return null;
  const n = Number(m[1]); const u = m[2].toLowerCase()[0];
  return { amount: n, unit: u === "m" ? "minutes" : u === "h" ? "hours" : "days" };
}

export function compileSteps(input: unknown): { graph: Graph | null; errors: CompileIssue[] } {
  const errors: CompileIssue[] = [];
  const steps = Array.isArray(input) ? input : (input as { steps?: unknown })?.steps;
  if (!Array.isArray(steps) || steps.length === 0) return { graph: null, errors: [{ step_path: "steps", code: "E_STEPS_EMPTY", message: "steps must be a non-empty array" }] };

  const nodes: Record<string, GraphNode> = {};
  let counter = 0;
  const END = "end";
  nodes.start = { id: "start", type: "start", position: { x: 80, y: 200 }, next: null };
  nodes[END] = { id: END, type: "end", config: {}, position: { x: 80, y: 600 } };

  const newId = (type: string) => `${type.replace(/^send_|_latest_post$|_skills$|_approval$|_invite$/g, "").replace(/[^a-z_]/g, "") || "n"}_${++counter}`;

  /** Compile a chain; returns the first node id (or `tail` when empty) after wiring the chain's last node to `tail`. */
  function chain(list: unknown[], path: string, x: number, y: number, tail: string): string {
    let first: string | null = null;
    let prevId: string | null = null;
    let cx = x;
    for (let i = 0; i < list.length; i++) {
      const s = list[i] as Step;
      const p = `${path}[${i}]`;
      if (!s || typeof s !== "object") { errors.push({ step_path: p, code: "E_STEP_INVALID", message: "step must be an object with a `do` field" }); continue; }
      const verb = String(s.do ?? s.type ?? "").trim();
      const type = VERBS[verb] ?? (Object.values(VERBS).includes(verb) ? verb : null);
      if (!type) { errors.push({ step_path: p, field: "do", code: "E_UNKNOWN_STEP", message: `unknown step "${verb}". Allowed: ${Object.keys(VERBS).join(", ")}` }); continue; }

      if (type === "end") { if (prevId) nodes[prevId].next = END; return first ?? END; }

      const id = newId(type);
      const node: GraphNode = { id, type, config: {}, position: { x: cx, y } };
      const wait = parseWait(s.wait ?? s.after);
      if ((s.wait ?? s.after) != null && !wait) errors.push({ step_path: p, field: "wait", code: "E_WAIT_INVALID", message: `wait must look like "2h", "3d", "30m"` });

      switch (type) {
        case "visit_profile": node.config = { notify: s.notify !== false }; break;
        case "like_latest_post": node.config = { max_age_days: Number(s.max_age_days ?? 90), reaction: String(s.reaction ?? "like") }; break;
        case "comment_latest_post": {
          const t = String(s.text ?? "");
          if (!t) errors.push({ step_path: p, field: "text", code: "E_TEXT_REQUIRED", message: "comment needs text" });
          if (t.length > TEXT_LIMITS.comment) errors.push({ step_path: p, field: "text", code: "E_TEXT_TOO_LONG", message: `comment exceeds ${TEXT_LIMITS.comment} characters` });
          node.config = { text: t, max_age_days: Number(s.max_age_days ?? 90) }; break;
        }
        case "endorse_skills": node.config = { count: Math.max(1, Math.min(5, Number(s.count ?? 1))) }; break;
        case "send_invite": {
          const note = String(s.note ?? s.text ?? "");
          if (note.length > TEXT_LIMITS.invite_note) errors.push({ step_path: p, field: "note", code: "E_NOTE_TOO_LONG", message: `invite note exceeds ${TEXT_LIMITS.invite_note} characters (200 for free LinkedIn accounts)` });
          node.config = { note, require_note_for_free: !!s.require_note_for_free }; break;
        }
        case "withdraw_invite": node.config = {}; break;
        case "send_message": {
          const t = String(s.text ?? "");
          if (!t) errors.push({ step_path: p, field: "text", code: "E_TEXT_REQUIRED", message: "message needs text" });
          if (t.length > TEXT_LIMITS.message) errors.push({ step_path: p, field: "text", code: "E_TEXT_TOO_LONG", message: `message exceeds ${TEXT_LIMITS.message} characters` });
          node.config = { text: t, send_always: !!s.send_always }; break;
        }
        case "send_inmail": {
          const subject = String(s.subject ?? ""), t = String(s.text ?? "");
          if (!t) errors.push({ step_path: p, field: "text", code: "E_TEXT_REQUIRED", message: "inmail needs text" });
          if (subject.length > TEXT_LIMITS.inmail_subject || t.length > TEXT_LIMITS.inmail_body) errors.push({ step_path: p, code: "E_TEXT_TOO_LONG", message: "InMail subject/body exceed 200/1900 characters" });
          node.config = { subject, text: t, api: String(s.api ?? "classic"), open_profile_only: !!s.open_profile_only }; break;
        }
        case "send_email": {
          const subject = String(s.subject ?? ""), html = String(s.html ?? s.text ?? "").replace(/\n/g, "<br/>");
          if (!subject || !html) errors.push({ step_path: p, code: "E_TEXT_REQUIRED", message: "email needs subject and text/html" });
          node.config = { subject, html, to: String(s.to ?? "any"), thread: String(s.thread ?? "continue"), mailbox_sender_id: s.mailbox_sender_id ?? null, track: s.track !== false }; break;
        }
        case "delay": {
          const d = wait ?? parseWait(s.for) ?? (s.amount != null ? parseWait({ amount: Number(s.amount), unit: String(s.unit ?? "days") }) : null);
          if (!d) errors.push({ step_path: p, field: "wait", code: "E_WAIT_REQUIRED", message: `delay needs wait, e.g. "3d"` });
          node.config = { amount: d?.amount ?? 1, unit: d?.unit ?? "days", jitter_pct: Number(s.jitter_pct ?? 20) }; break;
        }
        case "add_tag": case "remove_tag": node.config = { tag_id: String(s.tag_id ?? "") }; if (!s.tag_id) errors.push({ step_path: p, field: "tag_id", code: "E_CONFIG", message: "tag_id required (see workspace_context)" }); break;
        case "change_list": node.config = { list_id: String(s.list_id ?? "") }; if (!s.list_id) errors.push({ step_path: p, field: "list_id", code: "E_CONFIG", message: "list_id required" }); break;
        case "change_stage": node.config = { stage_id: String(s.stage_id ?? "") }; if (!s.stage_id) errors.push({ step_path: p, field: "stage_id", code: "E_CONFIG", message: "stage_id required" }); break;
        case "call_webhook": node.config = { webhook_id: String(s.webhook_id ?? "") }; break;
        case "call_api": node.config = { method: String(s.method ?? "POST"), url: String(s.url ?? ""), headers: s.headers ?? {}, query: s.query ?? {}, body: s.body ?? "", remove_empty: true }; break;
        case "send_to_sequence": node.config = { sequence_id: String(s.sequence_id ?? "") }; if (!s.sequence_id) errors.push({ step_path: p, field: "sequence_id", code: "E_CONFIG", message: "sequence_id required" }); break;
        case "manual_task": node.config = { title: String(s.title ?? "Manual step"), body: String(s.body ?? "") }; break;
        case "ai_draft_approval": {
          const kind = String(s.kind ?? "message");
          if (!["invite_note", "message", "comment"].includes(kind)) errors.push({ step_path: p, field: "kind", code: "E_CONFIG", message: "kind must be invite_note | message | comment" });
          if (!s.brief) errors.push({ step_path: p, field: "brief", code: "E_CONFIG", message: "ai_draft needs a brief describing what to write" });
          node.config = { kind, brief: String(s.brief ?? "") }; break;
        }
        case "wait_connection": {
          node.config = { window_days: Math.max(1, Math.min(30, Number(s.window_days ?? 14))), subtasks: [] };
          const connected = Array.isArray(s.connected) ? s.connected : [];
          const noConnect = Array.isArray(s.no_connect) ? s.no_connect : [{ do: "withdraw" }, { do: "end" }];
          if (connected.length === 0) errors.push({ step_path: p, field: "connected", code: "E_BRANCH_REQUIRED", message: "wait_connection needs a `connected` branch (steps to run once the invite is accepted)" });
          nodes[id] = node;
          if (prevId) nodes[prevId].next = id;
          if (!first) first = id;
          // steps after wait_connection (if any) are the continuation both branches flow into
          const rest = list.slice(i + 1);
          const cont = rest.length ? chain(rest, `${path}[${i + 1}..]`, cx + 220, y, tail) : tail;
          const c1 = chain(connected, `${p}.connected`, cx + 220, y - 140, cont);
          const c2 = chain(noConnect, `${p}.no_connect`, cx + 220, y + 140, cont);
          node.branches = { connected: c1, no_connect: c2 };
          return first;
        }
        case "condition": {
          const rules = Array.isArray(s.rules) ? s.rules : (s.field ? [{ field: s.field, op: s.op ?? "eq", value: s.value }] : []);
          if (rules.length === 0) errors.push({ step_path: p, code: "E_CONFIG", message: "condition needs rules [{field, op, value}] or field/op/value" });
          node.config = { rules, match: String(s.match ?? "all") };
          nodes[id] = node;
          if (prevId) nodes[prevId].next = id;
          if (!first) first = id;
          const rest = list.slice(i + 1);
          const cont = rest.length ? chain(rest, `${path}[${i + 1}..]`, cx + 220, y, tail) : tail;
          const t = chain(Array.isArray(s.true) ? s.true : [], `${p}.true`, cx + 220, y - 140, cont);
          const f = chain(Array.isArray(s.false) ? s.false : [], `${p}.false`, cx + 220, y + 140, cont);
          node.branches = { true: t, false: f };
          return first;
        }
      }
      if (wait && type !== "delay") node.delay = { ...wait, jitter_pct: 20 };
      // engine: primary exit is `next`; named alternative exits live in `branches`
      if (type === "send_inmail") node.branches = { no_credit: END };
      if (type === "send_email") node.branches = { bounced: END, no_email: END };
      if (type === "call_api") node.branches = { error: END };
      node.next = null;
      nodes[id] = node;
      if (prevId) nodes[prevId].next = id;
      if (!first) first = id;
      prevId = id;
      cx += 220;
      if (TERMINAL.has(type)) return first;
    }
    if (prevId) nodes[prevId].next = tail;
    return first ?? tail;
  }

  nodes.start.next = chain(steps, "steps", 300, 200, END);
  return { graph: errors.length ? null : { version: 1, start: "start", nodes }, errors };
}

// ---------------------------------------------------------------------------
// Readable rendering (for sequence_get and the outreach://sequences/{id} resource)
// ---------------------------------------------------------------------------

// deno-lint-ignore no-explicit-any
export function renderGraph(graph: Graph, stats?: Record<string, any>): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  const nodes = graph.nodes ?? {};
  const desc = (n: GraphNode): string => {
    const c = n.config ?? {};
    const q = (s: unknown, max = 90) => (s ? `"${String(s).replace(/\s+/g, " ").slice(0, max)}${String(s).length > max ? "…" : ""}"` : "");
    switch (n.type) {
      case "send_invite": return `invite${c.note ? ` note ${q(c.note)}` : " (no note)"}`;
      case "send_message": return `message ${q(c.text)}${c.send_always ? " [send_always]" : ""}`;
      case "send_inmail": return `inmail ${q(c.subject, 40)} ${q(c.text)}`;
      case "send_email": return `email ${q(c.subject, 60)}`;
      case "comment_latest_post": return `comment ${q(c.text)}`;
      case "delay": return `delay ${c.amount} ${c.unit}${c.jitter_pct ? ` ±${c.jitter_pct}%` : ""}`;
      case "wait_connection": return `wait for connection (window ${c.window_days ?? 14}d)`;
      case "condition": return `condition ${JSON.stringify(c.rules ?? [])} match=${c.match ?? "all"}`;
      case "ai_draft_approval": return `AI draft (${c.kind}) + human approval — brief ${q(c.brief, 60)}`;
      case "manual_task": return `manual task ${q(c.title, 60)}`;
      case "add_tag": case "remove_tag": return `${n.type} ${c.tag_id}`;
      case "change_stage": return `stage → ${c.stage_id}`;
      case "change_list": return `list → ${c.list_id}`;
      case "send_to_sequence": return `send to sequence ${c.sequence_id}`;
      default: return n.type;
    }
  };
  const walk = (id: string | null | undefined, depth: number, label?: string) => {
    if (!id) { lines.push(`${"  ".repeat(depth)}${label ? label + ": " : ""}(dangling)`); return; }
    const n = nodes[id];
    if (!n) { lines.push(`${"  ".repeat(depth)}${label ? label + ": " : ""}[${id}] MISSING`); return; }
    const pre = "  ".repeat(depth) + (label ? `${label} → ` : "");
    if (seen.has(id)) { lines.push(`${pre}[${id}] (see above)`); return; }
    seen.add(id);
    const st = stats?.[id];
    const stat = st ? `  {sent ${st.sent}, queued ${st.queued}, failed ${st.failed}, skipped ${st.skipped}${st.accepted ? `, accepted ${st.accepted}` : ""}${st.replied ? `, replied ${st.replied}` : ""}}` : "";
    const delay = n.delay ? ` (after ${n.delay.amount} ${n.delay.unit})` : "";
    lines.push(`${pre}[${id}] ${desc(n)}${delay}${stat}`);
    if (n.branches) for (const [b, t] of Object.entries(n.branches)) walk(t, depth + 1, b);
    if (n.next !== undefined && n.type !== "start") walk(n.next, depth, undefined);
    else if (n.type === "start") walk(n.next, depth);
  };
  walk(graph.start, 0);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Built-in templates (compact step lists)
// ---------------------------------------------------------------------------

export const TEMPLATES: Array<{ key: string; name: string; category: string; description: string; steps: Step[] }> = [
  {
    key: "connect_then_message", name: "Connect, then 2 follow-ups", category: "linkedin",
    description: "Visit → invite with a short note → once accepted: message after 1 day, second message after 4 days. Withdraw if not accepted in 14 days.",
    steps: [
      { do: "visit_profile" },
      { do: "invite", note: "Hi {{first_name|there}} — I follow work in {{company|your space}} and would like to connect." },
      { do: "wait_connection", window_days: 14,
        connected: [
          { do: "message", wait: "1d", text: "Thanks for connecting, {{first_name|there}}. Quick question: how are you handling <problem> at {{company|your company}} today?" },
          { do: "message", wait: "4d", text: "{{first_name|Hi}}, sharing one concrete example in case it is useful: <one-line proof point>. Happy to compare notes if relevant." },
        ],
        no_connect: [{ do: "withdraw" }, { do: "end" }] },
    ],
  },
  {
    key: "warm_then_connect", name: "Warm up, then connect", category: "linkedin",
    description: "Visit → like the latest post → 2 days → invite without a note → once accepted: one message.",
    steps: [
      { do: "visit_profile" },
      { do: "like_post" },
      { do: "delay", wait: "2d" },
      { do: "invite" },
      { do: "wait_connection", window_days: 14,
        connected: [{ do: "message", wait: "2h", text: "Thanks for connecting, {{first_name|there}}. I noticed <specific detail>. Would it be useful to <offer>?" }],
        no_connect: [{ do: "withdraw" }, { do: "end" }] },
    ],
  },
  {
    key: "inmail_two_touch", name: "InMail two-touch", category: "linkedin_premium",
    description: "For Premium/Sales Navigator senders: visit → InMail → 5 days → InMail follow-up. No connection needed.",
    steps: [
      { do: "visit_profile" },
      { do: "inmail", subject: "Quick question about {{company|your team}}", text: "Hi {{first_name|there}}, <one sentence why them>. <one sentence ask>." },
      { do: "inmail", wait: "5d", subject: "Re: Quick question about {{company|your team}}", text: "{{first_name|Hi}}, following up once in case this slipped. <alternative angle>." },
    ],
  },
  {
    key: "ai_personalised_connect", name: "AI-drafted invite with approval", category: "linkedin_ai",
    description: "Visit → AI drafts a personalised invite note from the profile/recent posts → a human approves each one → wait → AI-drafted follow-up with approval.",
    steps: [
      { do: "visit_profile" },
      { do: "ai_draft", kind: "invite_note", brief: "Reference something specific from their profile or a recent post; no pitch; under 200 characters." },
      { do: "wait_connection", window_days: 14,
        connected: [{ do: "ai_draft", kind: "message", wait: "1d", brief: "Thank them for connecting, ask one open question about <problem>. No links, no pitch." }],
        no_connect: [{ do: "withdraw" }, { do: "end" }] },
    ],
  },
  {
    key: "email_three_touch", name: "Email three-touch", category: "email",
    description: "For a connected mailbox: email → 3 days → email → 4 days → email. Bounces exit.",
    steps: [
      { do: "email", subject: "{{first_name|Hi}} — <topic>", text: "Hi {{first_name|there}},\n\n<why them, one line>.\n\n<ask, one line>.\n\n{{sender.first_name}}" },
      { do: "email", wait: "3d", subject: "Re: <topic>", text: "Hi {{first_name|there}}, <proof point>. Worth a short call?" },
      { do: "email", wait: "4d", subject: "Re: <topic>", text: "Closing the loop — if this is not a priority now, no problem. <one-line leave-behind>." },
    ],
  },
];

export function templateByKey(key: string) {
  const t = TEMPLATES.find((x) => x.key === key);
  if (!t) throw new McpError("E_NOT_FOUND", `unknown template "${key}"`, "Call sequence_templates to list the available keys.");
  return t;
}
