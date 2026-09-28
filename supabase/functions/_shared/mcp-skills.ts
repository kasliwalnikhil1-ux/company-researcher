// _shared/mcp-skills.ts — serve a connector's skill (claude-skill/<name>/) from its MCP server, so an assistant that
// does not have the skill installed still gets the playbook:
//
//   read_skill tool        works in every client that calls tools — ChatGPT developer-mode connectors read tools only,
//                          never resources or prompts, so this is the path that matters there
//   skill:// resources     skill://<server>/<skill>/<path>, one per file
//   skills/list, skills/get  the draft MCP Skills extension (SEP-2640) as OpenAI's plugin portal reads it: "Scan Tools"
//                          imports a snapshot of the skill into a plugin submission
//
// The content is <function>/skills.gen.ts, written by scripts/skills-build.py from claude-skill/. Edit the skill there
// and rerun the script; never edit the generated file.
import type { McpServer } from "npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js";
import { ErrorCode, McpError } from "npm:@modelcontextprotocol/sdk@1.25.3/types.js";
import { z } from "npm:zod@4.1.13";

export interface SkillFile { path: string; text: string; digest: string }
export interface SkillBundle { name: string; frontmatter: Record<string, string>; files: SkillFile[] }

const mimeOf = (path: string) => (path.endsWith(".md") ? "text/markdown" : path.endsWith(".py") ? "text/x-python" : path.endsWith(".yaml") ? "application/yaml" : "text/plain");

/** Register one skill on a per-request server. Call before server.connect() (capabilities are fixed at connect). */
export function registerSkill(server: McpServer, serverKey: string, skill: SkillBundle): void {
  const uri = (path: string) => `skill://${serverKey}/${skill.name}/${path}`;
  const entry = () => ({ uri: uri("SKILL.md"), frontmatter: skill.frontmatter, resources: skill.files.map((f) => ({ uri: uri(f.path), digest: f.digest })) });
  const byPath = new Map(skill.files.map((f) => [f.path, f]));
  const docs = skill.files.filter((f) => f.path !== "SKILL.md" && f.path.endsWith(".md")).map((f) => f.path);

  server.registerTool("read_skill", {
    title: "Read the operating manual",
    description:
      `The playbook for this connector: its workflows, the defaults to apply instead of asking questions, the rules the database enforces and how replies should read. ` +
      `Call it once at the start of a conversation with no arguments (returns SKILL.md) unless the "${skill.name}" skill is already loaded in your client, ` +
      `then open a workflow file when SKILL.md points to it (a link like [x.md](x.md) means read_skill(file: "x.md")).` +
      (docs.length ? ` Files: ${docs.join(", ")}.` : ""),
    inputSchema: { file: z.string().max(200).optional().describe(`File inside the skill, e.g. "${docs[0] ?? "SKILL.md"}". Omit for SKILL.md.`) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ file }: { file?: string }) => {
    const path = (file ?? "SKILL.md").replace(/^\.?\//, "").replace(/^skill:\/\/[^/]+\/[^/]+\//, "");
    const f = byPath.get(path);
    if (!f) {
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: true, code: "E_NOT_FOUND", message: `No file "${path}" in the ${skill.name} skill.`, remedy: `Use one of: ${[...byPath.keys()].join(", ")}` }) }] };
    }
    return { content: [{ type: "text" as const, text: f.text }] };
  });

  for (const f of skill.files) {
    server.registerResource(`skill:${skill.name}/${f.path}`, uri(f.path), { title: `${skill.name} skill — ${f.path}`, mimeType: mimeOf(f.path) },
      async (u: URL) => ({ contents: [{ uri: u.href, mimeType: mimeOf(f.path), text: f.text }] }));
  }

  // deno-lint-ignore no-explicit-any
  const inner = (server as any).server;
  inner.registerCapabilities({ extensions: { "io.modelcontextprotocol/skills": {} } });
  inner.setRequestHandler(
    z.object({ method: z.literal("skills/list"), params: z.object({ cursor: z.string().optional() }).passthrough().optional() }),
    async () => ({ skills: [entry()] }),
  );
  inner.setRequestHandler(
    z.object({ method: z.literal("skills/get"), params: z.object({ uri: z.string() }).passthrough() }),
    async (req: { params: { uri: string } }) => {
      if (req.params.uri !== uri("SKILL.md")) throw new McpError(ErrorCode.InvalidParams, `Unknown skill ${req.params.uri}; this server has ${uri("SKILL.md")}`);
      return { skill: entry() };
    },
  );
}
