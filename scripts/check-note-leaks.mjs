#!/usr/bin/env node
// private-notes-PRD.md §8.4 — build-time guard: no outbound / export / webhook / public-API code may reference the private
// notes table, bucket or RPCs. Notes must only ever be read by code that deliberately joins them (inbox UI, MCP inbox
// tools, the AI context builder, the notes worker). Run: `node scripts/check-note-leaks.mjs` (part of `npm run lint`).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const FN = join(ROOT, "supabase", "functions");

// Directories / files whose code talks to the outside world or measures the conversation.
const FORBIDDEN = [
  "outreach-send-reply", "outreach-edit-message", "outreach-api", "outreach-outbound-webhooks", "outreach-worker-tick", "outreach-worker-planner",
  "outreach-process-inbound", "outreach-unipile-webhook", "outreach-worker-reports", "outreach-crm-sync", "outreach-ai-classify", "outreach-ai-draft",
  "outreach-worker-channels", "outreach-worker-withdraw", "outreach-worker-relations-poll", "outreach-worker-enrich", "outreach-attachment-proxy",
  "outreach-booking-webhook", "outreach-unsubscribe", "outreach-sender-notify",
  "_shared/outreach/reply.ts", "_shared/outreach/unipile.ts", "_shared/outreach/execute.ts", "_shared/outreach/workers.ts", "_shared/outreach/inbound.ts",
  "_shared/outreach/reports_email.ts", "_shared/outreach/render.ts", "_shared/outreach/planner.ts", "_shared/outreach/channel_workers.ts",
  "_shared/outreach/crm", "_shared/outreach/drafts.ts", "_shared/outreach/notify.ts", "_shared/outreach/transcribe.ts",
];
// Identifiers that mean "note data": table, bucket, RPC family, engine field.
const NEEDLES = [/outreach_chat_notes?\b/, /outreach-chat-notes/, /outreach_notes?_[a-z_]+/, /notes_list/, /team_notes/, /teamNotes/, /outreach_chat_note_mentions/, /outreach_notifications\b/];
// The one allowed mention in a forbidden file: the defensive path filter in reply.ts (it names the bucket to refuse it).
const ALLOW = [{ file: "_shared/outreach/reply.ts", pattern: /chat-notes\(\\\/\|\$\)/ }];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx|js|mjs|sql)$/.test(name)) yield p;
  }
}

const hits = [];
for (const target of FORBIDDEN) {
  const p = join(FN, target);
  let files = [];
  try { files = statSync(p).isDirectory() ? [...walk(p)] : [p]; } catch { continue; }
  for (const f of files) {
    const rel = relative(FN, f).replace(/\\/g, "/");
    const lines = readFileSync(f, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const re of NEEDLES) {
        if (!re.test(line)) continue;
        if (ALLOW.some((a) => rel.endsWith(a.file) && a.pattern.test(line))) continue;
        hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 140)}`);
      }
    });
  }
}

if (hits.length) {
  console.error("Private-notes leak check FAILED — note data referenced from an outbound/export/webhook path:\n" + hits.map((h) => "  " + h).join("\n"));
  process.exit(1);
}
console.log(`Private-notes leak check OK (${FORBIDDEN.length} paths scanned).`);
