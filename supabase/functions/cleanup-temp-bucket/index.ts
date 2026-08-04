// supabase/functions/cleanup-temp-bucket/index.ts
//
// Daily janitor for the "temp" storage bucket: deletes every object older
// than MAX_AGE_HOURS (default 24h). Invoked by a pg_cron job once a day
// (see the cron.schedule for "cleanup-temp-bucket-daily"); can also be
// invoked manually.
//
// Deployed with --no-verify-jwt so the pg_cron HTTP call works without a
// user JWT; instead the caller must present the service-role key as the
// bearer token, which is enforced below.
//   supabase functions deploy cleanup-temp-bucket --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.76.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const BUCKET = "temp";
const MAX_AGE_HOURS = Number(Deno.env.get("TEMP_MAX_AGE_HOURS") ?? "24");

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

type FileEntry = { path: string; size: number; createdAt: string };

async function collectFiles(prefix: string, out: FileEntry[]): Promise<void> {
  let offset = 0;
  while (true) {
    const { data, error } = await supabase.storage.from(BUCKET).list(prefix, {
      limit: 1000,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) throw new Error(`list "${prefix}": ${error.message}`);
    for (const item of data ?? []) {
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.id === null) {
        await collectFiles(path, out); // folder
      } else {
        out.push({
          path,
          size: (item.metadata as { size?: number } | null)?.size ?? 0,
          createdAt: item.created_at,
        });
      }
    }
    if ((data?.length ?? 0) < 1000) break;
    offset += 1000;
  }
}

Deno.serve(async (req) => {
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (token !== SERVICE_ROLE_KEY) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const cutoff = Date.now() - MAX_AGE_HOURS * 60 * 60 * 1000;
  const files: FileEntry[] = [];
  await collectFiles("", files);
  const expired = files.filter((f) => new Date(f.createdAt).getTime() < cutoff);

  let deleted = 0;
  for (let i = 0; i < expired.length; i += 100) {
    const batch = expired.slice(i, i + 100).map((f) => f.path);
    const { error } = await supabase.storage.from(BUCKET).remove(batch);
    if (error) {
      return Response.json(
        { error: `delete failed after ${deleted} objects: ${error.message}` },
        { status: 500 },
      );
    }
    deleted += batch.length;
  }

  const freedMb = expired.reduce((s, f) => s + f.size, 0) / 1048576;
  const result = {
    bucket: BUCKET,
    maxAgeHours: MAX_AGE_HOURS,
    scanned: files.length,
    deleted,
    freedMb: Math.round(freedMb * 10) / 10,
    kept: files.length - deleted,
  };
  console.log("cleanup-temp-bucket:", JSON.stringify(result));
  return Response.json(result);
});
