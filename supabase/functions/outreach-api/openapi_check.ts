// Dev check, not part of the deployed function (index.ts never imports it).
// Run from the repo root:  deno run --allow-read supabase/functions/outreach-api/openapi_check.ts
// Verifies docs/outreach/openapi.json is well-formed, that every route registered in routes_*.ts is documented
// (and nothing is documented that does not exist), and that every $ref resolves.

const dir = new URL(".", import.meta.url);
const specUrl = new URL("../../../docs/outreach/openapi.json", dir);
const spec = JSON.parse(await Deno.readTextFile(specUrl));

const implemented = new Set<string>();
for await (const f of Deno.readDir(dir)) {
  if (!/^routes_.*\.ts$/.test(f.name)) continue;
  const src = await Deno.readTextFile(new URL(f.name, dir));
  for (const m of src.matchAll(/app\.(get|post|put|patch|delete)\(\s*"(\/v1\/[^"]+)"/g)) {
    implemented.add(`${m[1].toUpperCase()} ${m[2].replace(/:(\w+)/g, "{$1}")}`);
  }
}

const documented = new Set<string>();
for (const [path, ops] of Object.entries(spec.paths as Record<string, Record<string, unknown>>)) {
  for (const method of Object.keys(ops)) documented.add(`${method.toUpperCase()} ${path}`);
}

const missing = [...implemented].filter((r) => !documented.has(r)).sort();
const extra = [...documented].filter((r) => !implemented.has(r)).sort();

const badRefs: string[] = [];
(function walk(node: unknown) {
  if (Array.isArray(node)) return node.forEach(walk);
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string") {
        const target = v.replace(/^#\//, "").split("/").reduce<unknown>((o, p) => (o as Record<string, unknown> | undefined)?.[p], spec);
        if (target === undefined) badRefs.push(v);
      } else walk(v);
    }
  }
})(spec);

const needSchemas = ["Lead", "Enrollment", "Sequence", "Thread", "Message", "Sender", "Totals", "Funnel", "Error"].filter((s) => !spec.components?.schemas?.[s]);

console.log(`openapi ${spec.openapi} · implemented ${implemented.size} · documented ${documented.size}`);
if (missing.length) console.log("NOT DOCUMENTED:\n  " + missing.join("\n  "));
if (extra.length) console.log("DOCUMENTED BUT NOT IMPLEMENTED:\n  " + extra.join("\n  "));
if (badRefs.length) console.log("BROKEN $ref:\n  " + [...new Set(badRefs)].join("\n  "));
if (needSchemas.length) console.log("MISSING SCHEMAS: " + needSchemas.join(", "));
const okAll = !missing.length && !extra.length && !badRefs.length && !needSchemas.length && spec.components?.securitySchemes?.bearerAuth;
console.log(okAll ? "OK: every implemented route is documented and the spec is consistent." : "FAILED");
if (!okAll) Deno.exit(1);
