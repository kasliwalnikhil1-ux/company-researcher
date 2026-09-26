// Profile Studio runtime (linkedin-profile-management-PRD.md §7, §8.4, §10.2): the platform's own snapshot ledger,
// the single PATCH, post-verification, owner notification with a revert link, weekly drift and QA.
//
// Rules this file keeps
//   * Every LinkedIn read here is a metered profile_view: reserve → read → consume, never "call anyway".
//   * Selective sections only (sectionsForGroups); never "*".
//   * The multipart body comes from profile_serialiser.ts and nowhere else.
//   * A 429/500 on the edit endpoint is retried at most once, hours later; a 401 parks the change until a human re-submits.
//   * Post-verify decides applied vs partially_applied; the HTTP status does not.
//   * The owner is emailed after every applied change, with a one-click revert that needs no login.
import { admin, log, rpc, randInt, WEB_ORIGIN, FUNCTIONS_BASE } from "./supabase.ts";
import { unipile, UnipileError } from "./unipile.ts";
import type { ExecResult } from "./execute.ts";
import { encodeProfileEdit, toFormData, describeParts, sectionsForGroups, unwrittenFieldsOf, fidelityOf, ProfileSerialiserError, type ProfilePayload, type FieldGroup } from "./profile_serialiser.ts";
import { tomorrowMorning } from "./enrich.ts";
import { sendEmail, layout, button, esc, workspaceBranding, emailConfigured, type Branding } from "./notify.ts";

type Row = Record<string, any>;
export const PROFILE_ASSETS_BUCKET = "outreach-profile-assets";

// ---------------------------------------------------------------------------
// Snapshot document (normalised from GET /users/{identifier})
// ---------------------------------------------------------------------------
export interface ProfileDoc {
  provider_id: string | null; public_identifier: string | null; first_name: string | null; last_name: string | null;
  headline: string | null; summary: string | null; location: string | null; picture_url: string | null; cover_url: string | null;
  connections_count: number | null; follower_count: number | null; is_premium: boolean | null; is_open_profile: boolean | null;
  experience: Array<{ id: string | null; title: string | null; company: string | null; company_id: string | null; start: string | null; end: string | null; current: boolean; location: string | null; description: string | null; skills: string[] }>;
  education: Array<{ id: string | null; school: string | null; degree: string | null; field: string | null; start: string | null; end: string | null; description: string | null }>;
  skills: Array<{ name: string; endorsements: number | null }>;
  languages: string[]; certifications: Array<{ name: string; issuer: string | null }>; projects: Array<{ name: string }>; websites: string[];
  fetched_sections: string[]; fetched_at: string;
}

const s = (v: unknown, max = 4000): string | null => { const t = String(v ?? "").trim(); return t ? t.slice(0, max) : null; };
const n = (v: unknown): number | null => { const x = Number(v); return v === null || v === undefined || v === "" || !isFinite(x) ? null : Math.trunc(x); };
const dateStr = (v: unknown): string | null => { const t = String(v ?? "").trim(); return t ? t.slice(0, 20) : null; };

export function normaliseProfile(prof: Row, sections: readonly string[]): ProfileDoc {
  const work: Row[] = Array.isArray(prof?.work_experience) ? prof.work_experience : [];
  const edu: Row[] = Array.isArray(prof?.education) ? prof.education : [];
  const names = (list: unknown): string[] => (Array.isArray(list) ? list : []).map((x: any) => s(typeof x === "string" ? x : x?.name, 120)).filter((x): x is string => !!x);
  return {
    provider_id: s(prof?.provider_id, 200), public_identifier: s(prof?.public_identifier, 200)?.toLowerCase() ?? null,
    first_name: s(prof?.first_name, 100), last_name: s(prof?.last_name, 100),
    headline: s(prof?.headline, 300), summary: sections.includes("about") ? s(prof?.summary, 4000) : (s(prof?.summary, 4000) ?? null),
    location: s(prof?.location, 200),
    picture_url: s(prof?.profile_picture_url_large ?? prof?.profile_picture_url, 1000),
    cover_url: s(prof?.background_picture_url ?? prof?.cover_picture_url ?? prof?.background_image_url, 1000),
    connections_count: n(prof?.connections_count), follower_count: n(prof?.follower_count),
    is_premium: typeof prof?.is_premium === "boolean" ? prof.is_premium : (typeof prof?.premium === "boolean" ? prof.premium : null),
    is_open_profile: typeof prof?.is_open_profile === "boolean" ? prof.is_open_profile : null,
    experience: work.map((w) => ({
      id: s(w.id ?? w.position_id ?? w.experience_id, 100), title: s(w.position ?? w.title, 200), company: s(w.company, 200), company_id: s(w.company_id, 100),
      start: dateStr(w.start), end: dateStr(w.end), current: typeof w.current === "boolean" ? w.current : !w.end && !!w.start,
      location: s(w.location, 200), description: s(w.description, 2000), skills: names(w.skills),
    })).filter((w) => w.company || w.title),
    education: edu.map((e) => ({ id: s(e.id ?? e.education_id, 100), school: s(e.school, 200), degree: s(e.degree, 200), field: s(e.field_of_study, 200), start: dateStr(e.start), end: dateStr(e.end), description: s(e.description, 1000) })).filter((e) => e.school),
    skills: (Array.isArray(prof?.skills) ? prof.skills : []).map((x: any) => ({ name: String(typeof x === "string" ? x : x?.name ?? "").trim().slice(0, 120), endorsements: n(x?.endorsement_count ?? x?.endorsements) })).filter((x: Row) => x.name),
    languages: names(prof?.languages),
    certifications: (Array.isArray(prof?.certifications) ? prof.certifications : []).map((c: any) => ({ name: String(c?.name ?? "").slice(0, 200), issuer: s(c?.organization ?? c?.issuer, 200) })).filter((c: Row) => c.name),
    projects: (Array.isArray(prof?.projects) ? prof.projects : []).map((p: any) => ({ name: String(p?.name ?? "").slice(0, 200) })).filter((p: Row) => p.name),
    websites: (Array.isArray(prof?.websites) ? prof.websites : []).map((w: any) => String(typeof w === "string" ? w : w?.url ?? "").slice(0, 300)).filter(Boolean),
    fetched_sections: [...sections], fetched_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Budgeted own-profile read
// ---------------------------------------------------------------------------
export type ReadResult = { ok: true; doc: ProfileDoc; raw: Row } | { ok: false; reason: "no_budget" | "no_identifier" };

/** Read the sender's own profile with the named sections behind the profile_view budget. */
export async function readOwnProfile(sender: Row, sections: string[]): Promise<ReadResult> {
  const ident = sender.public_identifier ?? sender.provider_user_id;
  if (!ident || !sender.unipile_account_id) return { ok: false, reason: "no_identifier" };
  const day = await rpc<string>("sender_local_date", { p_sender: sender.id, p_at: new Date().toISOString() });
  const reserved = await rpc<boolean>("reserve_budget", { p_sender: sender.id, p_day: day, p_type: "profile_view" }).catch(() => false);
  if (!reserved) return { ok: false, reason: "no_budget" };
  try {
    const raw = await unipile.users.profile(sender.unipile_account_id, ident, { notify: false, linkedin_sections: sections.length ? sections : undefined });
    await rpc("consume_budget", { p_sender: sender.id, p_day: day, p_type: "profile_view" }).catch((e) => log({ fn: "profile", warn: `consume profile_view: ${String(e)}` }));
    return { ok: true, doc: normaliseProfile(raw, sections), raw };
  } catch (e) {
    await rpc("release_budget", { p_sender: sender.id, p_day: day, p_type: "profile_view" }).catch(() => null);
    throw e;
  }
}

/** On-demand / weekly snapshot of a sender (baseline or drift_check). Returns the snapshot id, or null when it could not be read. */
export async function snapshotSender(sender: Row, kind: "baseline" | "drift_check", sections: string[] = ["about", "experience", "education", "skills"]): Promise<{ id: string; doc: ProfileDoc; drift: string[] } | { skipped: string }> {
  const r = await readOwnProfile(sender, sections);
  if (!r.ok) return { skipped: r.reason };
  let drift: string[] = [];
  if (kind === "drift_check") {
    const { data: prev } = await admin.from("outreach_profile_snapshots").select("data").eq("sender_id", sender.id).order("captured_at", { ascending: false }).limit(1).maybeSingle();
    if (prev?.data) drift = diffDocs(prev.data as ProfileDoc, r.doc);
  }
  const id = await rpc<string>("profile_record_snapshot", { p_sender: sender.id, p_kind: kind, p_sections: sections, p_fidelity: "full", p_data: r.doc, p_unwritten: [], p_change: null, p_action: null, p_drift: drift.length ? { changed: drift } : null });
  if (drift.length) {
    await admin.from("outreach_sender_events").insert({ sender_id: sender.id, kind: "profile", data: { drift: true, changed: drift, snapshot_id: id } });
    log({ fn: "profile", sender_id: sender.id, drift });
  }
  // keep the sender card in step with what LinkedIn shows
  const patch: Row = {};
  if (r.doc.picture_url && r.doc.picture_url !== sender.picture_url) patch.picture_url = r.doc.picture_url;
  if (typeof r.doc.connections_count === "number") patch.connections_count = r.doc.connections_count;
  if (Object.keys(patch).length) await admin.from("outreach_senders").update(patch).eq("id", sender.id);
  await rpc("profile_qa_compute", { p_sender: sender.id }).catch((e) => log({ fn: "profile", warn: `qa: ${String(e)}` }));
  return { id, doc: r.doc, drift };
}

/** Which top-level fields differ between two snapshots (external edits). */
export function diffDocs(a: ProfileDoc, b: ProfileDoc): string[] {
  const out: string[] = [];
  const eq = (x: unknown, y: unknown) => String(x ?? "").trim() === String(y ?? "").trim();
  if (!eq(a.headline, b.headline)) out.push("headline");
  if (a.summary != null && b.summary != null && !eq(a.summary, b.summary)) out.push("summary");
  if (!eq(a.location, b.location)) out.push("location");
  if (a.picture_url && b.picture_url && a.picture_url !== b.picture_url) out.push("picture");
  const skillsA = new Set((a.skills ?? []).map((x) => x.name.toLowerCase())), skillsB = new Set((b.skills ?? []).map((x) => x.name.toLowerCase()));
  if (skillsA.size && skillsB.size && (skillsA.size !== skillsB.size || [...skillsA].some((x) => !skillsB.has(x)))) out.push("skills");
  for (const e of b.experience ?? []) {
    const prev = (a.experience ?? []).find((x) => (x.id && x.id === e.id) || (x.company === e.company && x.title === e.title));
    if (prev && !eq(prev.description, e.description) && prev.description != null && e.description != null) { out.push("experience"); break; }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Apply (called by worker-tick for a claimed profile_edit action)
// ---------------------------------------------------------------------------
async function loadAsset(ref: string, kind: "picture" | "cover_picture"): Promise<Blob> {
  if (/^https?:\/\//i.test(ref)) {
    const res = await fetch(ref, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`E_PROFILE_IMAGE_FETCH: ${res.status}`);
    const type = res.headers.get("content-type") ?? "image/jpeg";
    return new File([await res.blob()], `${kind}.${type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg"}`, { type });
  }
  const path = ref.replace(new RegExp(`^/?${PROFILE_ASSETS_BUCKET}/`), "");
  const { data, error } = await admin.storage.from(PROFILE_ASSETS_BUCKET).download(path);
  if (error || !data) throw new Error(`E_PROFILE_IMAGE_FETCH: ${error?.message ?? "missing asset"}`);
  const ext = /\.([a-z0-9]{2,5})$/i.exec(path)?.[1]?.toLowerCase() ?? "jpg";
  return new File([data], `${kind}.${ext}`, { type: data.type || (ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg") });
}

/** change.payload + change.assets → the typed serialiser input. */
export async function buildPayload(change: Row): Promise<ProfilePayload> {
  const p: ProfilePayload = { ...(change.payload ?? {}) };
  const assets: Row = change.assets ?? {};
  if (assets.picture) p.picture = await loadAsset(String(assets.picture), "picture");
  else if (assets.picture_url) p.picture = await loadAsset(String(assets.picture_url), "picture");
  if (assets.cover_picture) p.cover_picture = await loadAsset(String(assets.cover_picture), "cover_picture");
  else if (assets.cover_url) p.cover_picture = await loadAsset(String(assets.cover_url), "cover_picture");
  return p;
}

function classify422(e: UnipileError, payload: ProfilePayload): string {
  const text = `${e.code} ${e.message} ${JSON.stringify(e.body ?? "")}`.toLowerCase();
  if ((payload.picture || payload.cover_picture) && /image|picture|photo|media|dimension|format|size/.test(text)) return "E_PROFILE_IMAGE_REJECTED";
  if (/location|job_title|geo|id/.test(text) && (payload.location || payload.experience)) return "E_PROFILE_ID_UNRESOLVED";
  return `E_PROFILE_REJECTED:${e.code}`;
}

export async function applyProfileChange(action: Row, sender: Row): Promise<ExecResult> {
  const gate = await rpc<Row>("profile_change_for_action", { p_action: action.id });
  const change: Row | undefined = gate?.change;
  if (!gate?.ok) {
    // the change is no longer eligible (authority revoked, ceiling used by another change, cancelled): record and stop
    if (change?.id && change.status === "queued") await admin.from("outreach_profile_changes").update({ status: "draft", action_id: null, scheduled_for: null, error_code: String(gate?.code ?? "E_PROFILE_STATE").slice(0, 120), note: `${change.note ?? ""} [held at execution: ${gate?.detail ?? gate?.code}]`.trim() }).eq("id", change.id);
    return { ok: false, decision: { kind: "cancel", reason: String(gate?.code ?? "profile_not_eligible") }, code: String(gate?.code ?? "E_PROFILE_STATE").slice(0, 120) };
  }
  const groups = (change!.field_groups ?? []) as FieldGroup[];
  const sections = sectionsForGroups(groups);
  const later = (reason: string, code: string): ExecResult => ({ ok: false, decision: { kind: "retry", at: tomorrowMorning(sender.timezone ?? "UTC"), reason }, code });

  // 1. payload first: a serialiser error must never cost a profile read
  let payload: ProfilePayload;
  try { payload = await buildPayload(change!); }
  catch (e) {
    const code = String((e as Error).message ?? e).slice(0, 120);
    await rpc("profile_mark_applied", { p_change: change!.id, p_ok: false, p_error: code, p_verify_after: null });
    return { ok: false, decision: { kind: "cancel", reason: "asset_missing" }, code };
  }
  let parts;
  try { parts = encodeProfileEdit(sender.unipile_account_id, payload, { strict: true }); }
  catch (e) {
    const code = e instanceof ProfileSerialiserError ? e.code : "E_PAYLOAD_INVALID";
    await rpc("profile_mark_applied", { p_change: change!.id, p_ok: false, p_error: `${code}: ${String((e as Error).message).slice(0, 100)}`, p_verify_after: null });
    return { ok: false, decision: { kind: "cancel", reason: code }, code };
  }

  // 2. pre-snapshot (selective sections, one profile_view)
  let pre: ReadResult;
  try { pre = await readOwnProfile(sender, sections); }
  catch (e) {
    if (e instanceof UnipileError && e.status === 401) { await rpc("profile_park_change", { p_change: change!.id, p_error: `401:${e.code}` }); return { ok: false, decision: { kind: "sender_credentials", reason: "profile_pre_read_401" }, code: `401:${e.code}` }; }
    return { ok: false, decision: { kind: "retry", at: new Date(Date.now() + randInt(60, 180) * 60_000), reason: "pre_snapshot_failed" }, code: e instanceof UnipileError ? `${e.status}:${e.code}` : String((e as Error).message).slice(0, 120) };
  }
  if (!pre.ok) {
    if (pre.reason === "no_identifier") { await rpc("profile_mark_applied", { p_change: change!.id, p_ok: false, p_error: "E_PROFILE_ID_UNRESOLVED: the sender has no public identifier", p_verify_after: null }); return { ok: false, decision: { kind: "cancel", reason: "no_identifier" }, code: "E_PROFILE_ID_UNRESOLVED" }; }
    return later("no_profile_view_budget", "E_BUDGET_PROFILE_VIEW");
  }
  const unwritten = unwrittenFieldsOf(payload);
  const readable = Object.keys(change!.payload ?? {}).every((k) => !unwritten.includes(k)) && !(change!.assets?.picture || change!.assets?.picture_url || change!.assets?.cover_picture || change!.assets?.cover_url);
  await rpc("profile_record_snapshot", { p_sender: sender.id, p_kind: "pre_change", p_sections: sections, p_fidelity: readable ? "full" : "partial", p_data: pre.doc, p_unwritten: unwritten, p_change: change!.id, p_action: action.id, p_drift: null });

  // 3. the PATCH
  try {
    const res = await unipile.users.editProfile(sender.unipile_account_id, toFormData(parts));
    log({ fn: "profile", change_id: change!.id, sender_id: sender.id, edited: res?.object ?? null, parts: describeParts(parts).map(([k]) => k) });
    await rpc("profile_mark_applied", { p_change: change!.id, p_ok: true, p_error: null, p_verify_after: new Date(Date.now() + 90_000).toISOString() });
    return { ok: true, response: { change_id: change!.id, field_groups: groups, object: res?.object ?? null } };
  } catch (e) {
    if (!(e instanceof UnipileError)) {
      await rpc("profile_mark_applied", { p_change: change!.id, p_ok: false, p_error: String((e as Error).message).slice(0, 120), p_verify_after: null });
      return { ok: false, decision: { kind: "cancel", reason: "apply_error" }, code: String((e as Error).message).slice(0, 120) };
    }
    const code = `${e.status || "net"}:${e.code}`;
    if (e.status === 401) { await rpc("profile_park_change", { p_change: change!.id, p_error: code }); return { ok: false, decision: { kind: "sender_credentials", reason: "profile_edit_401" }, code }; }
    if (e.status === 429 || e.status >= 500 || e.network) {
      // never hammer an identity endpoint: one retry, hours later, then fail and tell the owner
      if ((action.attempt ?? 1) >= 2) { await rpc("profile_mark_applied", { p_change: change!.id, p_ok: false, p_error: code, p_verify_after: null }); return { ok: false, decision: { kind: "cancel", reason: "profile_edit_retry_exhausted" }, code }; }
      return { ok: false, decision: { kind: "retry", at: new Date(Date.now() + randInt(120, 360) * 60_000), reason: "profile_edit_rate_limited" }, code };
    }
    const mapped = e.status === 422 ? classify422(e, payload) : e.status === 403 ? `E_PROFILE_FORBIDDEN:${e.code}` : `E_PROFILE_REJECTED:${e.code}`;
    await rpc("profile_mark_applied", { p_change: change!.id, p_ok: false, p_error: mapped.slice(0, 120), p_verify_after: null });
    return { ok: false, decision: { kind: "cancel", reason: mapped.split(":")[0] }, code: mapped.slice(0, 120) };
  }
}

// ---------------------------------------------------------------------------
// Post-verify (worker, ≥60 s after apply)
// ---------------------------------------------------------------------------
const norm = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();

/** Compare the intent with what LinkedIn now shows. Unreadable fields count as applied but are listed as written-only. */
export function verifyAgainst(change: Row, pre: ProfileDoc | null, post: ProfileDoc): { applied: string[]; failed: Record<string, string>; written_only: string[] } {
  const applied: string[] = [], written_only: string[] = []; const failed: Record<string, string> = {};
  const p: Row = change.payload ?? {}; const assets: Row = change.assets ?? {};
  if (p.headline !== undefined) (norm(post.headline) === norm(p.headline) ? applied : (failed.headline = "E_PROFILE_NOT_VISIBLE", [])).push("headline");
  if (p.summary !== undefined) (norm(post.summary) === norm(p.summary) ? applied : (failed.summary = "E_PROFILE_NOT_VISIBLE", [])).push("summary");
  if (p.skills !== undefined) {
    const have = new Set((post.skills ?? []).map((x) => x.name.toLowerCase()));
    const missing = (p.skills as string[]).filter((x) => !have.has(String(x).toLowerCase()));
    if (post.skills?.length && missing.length === 0) applied.push("skills"); else if (!post.skills?.length) written_only.push("skills"); else failed.skills = `E_PROFILE_NOT_VISIBLE:${missing.slice(0, 3).join(",")}`;
  }
  if (p.experience !== undefined) {
    const e = p.experience as Row;
    const entry = e.id ? (post.experience ?? []).find((x) => x.id === e.id) : (post.experience ?? []).find((x) => norm(x.company) === norm(e.company) && norm(x.title) === norm(e.role));
    if (!entry) { if (post.experience?.length) failed.experience = "E_PROFILE_NOT_VISIBLE"; else written_only.push("experience"); }
    else if (e.description !== undefined && norm(entry.description) !== norm(e.description)) failed.experience = "E_PROFILE_NOT_VISIBLE:description";
    else applied.push("experience");
  }
  if (p.education !== undefined) {
    const e = p.education as Row;
    const entry = e.id ? (post.education ?? []).find((x) => x.id === e.id) : (post.education ?? []).find((x) => norm(x.school) === norm(e.school));
    if (!entry) { if (post.education?.length) failed.education = "E_PROFILE_NOT_VISIBLE"; else written_only.push("education"); }
    else if (e.description !== undefined && norm(entry.description) !== norm(e.description)) failed.education = "E_PROFILE_NOT_VISIBLE:description";
    else applied.push("education");
  }
  if (p.location !== undefined) { if (pre && norm(pre.location) === norm(post.location)) failed.location = "E_PROFILE_NOT_VISIBLE"; else applied.push("location"); }
  if (assets.picture || assets.picture_url) { if (pre?.picture_url && post.picture_url && pre.picture_url === post.picture_url) failed.picture = "E_PROFILE_NOT_VISIBLE"; else applied.push("picture"); }
  if (assets.cover_picture || assets.cover_url) { if (pre?.cover_url && post.cover_url && pre.cover_url === post.cover_url) failed.cover_picture = "E_PROFILE_NOT_VISIBLE"; else applied.push("cover_picture"); }
  for (const k of ["picture_settings", "cover_picture_settings", "custom_link", "skills_follow"]) if (p[k] !== undefined) { applied.push(k); written_only.push(k); }
  return { applied, failed, written_only };
}

export async function verifyDueChanges(limit = 20): Promise<{ verified: number; deferred: number; errors: number }> {
  const { data: rows } = await admin.from("outreach_profile_changes").select("*").in("status", ["applied", "partially_applied"]).is("verified_at", null).lte("verify_after", new Date().toISOString()).order("verify_after").limit(limit);
  let verified = 0, deferred = 0, errors = 0;
  for (const ch of rows ?? []) {
    try {
      const { data: sender } = await admin.from("outreach_senders").select("*").eq("id", ch.sender_id).maybeSingle();
      if (!sender || sender.status !== "ok") { deferred++; await admin.from("outreach_profile_changes").update({ verify_after: new Date(Date.now() + 3600_000).toISOString() }).eq("id", ch.id); continue; }
      const sections = sectionsForGroups((ch.field_groups ?? []) as FieldGroup[]);
      const r = await readOwnProfile(sender, sections);
      if (!r.ok) { deferred++; await admin.from("outreach_profile_changes").update({ verify_after: new Date(Date.now() + 3600_000).toISOString() }).eq("id", ch.id); continue; }
      const { data: preRow } = ch.pre_snapshot_id ? await admin.from("outreach_profile_snapshots").select("data").eq("id", ch.pre_snapshot_id).maybeSingle() : { data: null };
      const v = verifyAgainst(ch, (preRow?.data as ProfileDoc) ?? null, r.doc);
      const postId = await rpc<string>("profile_record_snapshot", { p_sender: sender.id, p_kind: "post_change", p_sections: sections, p_fidelity: v.written_only.length ? "partial" : "full", p_data: r.doc, p_unwritten: v.written_only, p_change: ch.id, p_action: ch.action_id, p_drift: null });
      await rpc("profile_mark_verified", { p_change: ch.id, p_applied: v.applied, p_failed: v.failed, p_post_snapshot: postId });
      const patch: Row = {};
      if (r.doc.picture_url && r.doc.picture_url !== sender.picture_url) patch.picture_url = r.doc.picture_url;
      if (Object.keys(patch).length) await admin.from("outreach_senders").update(patch).eq("id", sender.id);
      await rpc("profile_qa_compute", { p_sender: sender.id }).catch(() => null);
      verified++;
    } catch (e) {
      errors++;
      log({ fn: "profile-verify", change_id: ch.id, error: String((e as Error).message ?? e) });
      await admin.from("outreach_profile_changes").update({ verify_after: new Date(Date.now() + 2 * 3600_000).toISOString() }).eq("id", ch.id);
    }
  }
  return { verified, deferred, errors };
}

// ---------------------------------------------------------------------------
// Emails: owner notification (always), approval request, authority request
// ---------------------------------------------------------------------------
const GROUP_LABEL: Record<string, string> = { headline: "Headline", summary: "About", picture: "Profile photo", picture_settings: "Photo settings", cover_picture: "Cover image", cover_picture_settings: "Cover settings", location: "Location", experience: "Experience", education: "Education", skills: "Skills", skills_follow: "Follow skills", custom_link: "Custom link" };

function showValue(k: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "<i style=\"color:#888\">(empty)</i>";
  if (k === "picture" || k === "cover_picture") return "<i>image</i>";
  if (k === "experience" || k === "education") { const o = v as Row; return esc([o.role ?? o.title, o.company ?? o.school, o.description].filter(Boolean).join(" · ")).slice(0, 600); }
  if (Array.isArray(v)) return esc(v.map((x) => (typeof x === "string" ? x : x?.name ?? JSON.stringify(x))).join(", ")).slice(0, 600);
  if (typeof v === "object") return esc(JSON.stringify(v)).slice(0, 400);
  return esc(String(v)).replace(/\n/g, "<br>").slice(0, 1200);
}

/** Field-by-field before/after table from the pre snapshot and the payload. */
export function diffTable(change: Row, pre: ProfileDoc | null): string {
  const rows: string[] = [];
  const p: Row = change.payload ?? {}; const assets: Row = change.assets ?? {};
  const beforeOf = (k: string): unknown => {
    if (!pre) return null;
    if (k === "headline") return pre.headline; if (k === "summary") return pre.summary; if (k === "location") return pre.location;
    if (k === "skills") return pre.skills?.map((x) => x.name);
    if (k === "experience") { const e = p.experience as Row; return (pre.experience ?? []).find((x) => e?.id ? x.id === e.id : false) ?? null; }
    if (k === "education") { const e = p.education as Row; return (pre.education ?? []).find((x) => e?.id ? x.id === e.id : false) ?? null; }
    return null;
  };
  for (const k of Object.keys(p)) rows.push(`<tr><td style="padding:6px 8px;border-top:1px solid #eee;white-space:nowrap;vertical-align:top"><b>${esc(GROUP_LABEL[k] ?? k)}</b></td><td style="padding:6px 8px;border-top:1px solid #eee;color:#666;vertical-align:top">${showValue(k, beforeOf(k))}</td><td style="padding:6px 8px;border-top:1px solid #eee;vertical-align:top">${showValue(k, p[k])}</td></tr>`);
  if (assets.picture || assets.picture_url) rows.push(`<tr><td style="padding:6px 8px;border-top:1px solid #eee"><b>Profile photo</b></td><td style="padding:6px 8px;border-top:1px solid #eee;color:#666">${pre?.picture_url ? `<a href="${esc(pre.picture_url)}">previous photo</a>` : "(unknown)"}</td><td style="padding:6px 8px;border-top:1px solid #eee">new photo</td></tr>`);
  if (assets.cover_picture || assets.cover_url) rows.push(`<tr><td style="padding:6px 8px;border-top:1px solid #eee"><b>Cover image</b></td><td style="padding:6px 8px;border-top:1px solid #eee;color:#666">${pre?.cover_url ? `<a href="${esc(pre.cover_url)}">previous cover</a>` : "(unknown)"}</td><td style="padding:6px 8px;border-top:1px solid #eee">new cover</td></tr>`);
  return `<table style="border-collapse:collapse;width:100%;font-size:13px"><thead><tr><th style="text-align:left;padding:6px 8px">Field</th><th style="text-align:left;padding:6px 8px">Before</th><th style="text-align:left;padding:6px 8px">After</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

async function ownerRecipients(sender: Row): Promise<string[]> {
  const out = new Set<string>();
  const ok = (e: unknown): e is string => typeof e === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
  if (ok(sender.owner_email)) out.add(sender.owner_email.toLowerCase());
  if (sender.owner_user_id) { try { const { data } = await admin.auth.admin.getUserById(sender.owner_user_id); if (ok(data?.user?.email)) out.add(data.user.email.toLowerCase()); } catch { /* ignore */ } }
  return [...out];
}

/** PRD §4.3: every applied change emails the owner with the diff, who did it and a 30-day one-click revert. Not suppressible. */
export async function notifyOwnerOfChange(change: Row): Promise<{ recipients: string[]; sent: number; revert_link: string | null }> {
  const { data: sender } = await admin.from("outreach_senders").select("*").eq("id", change.sender_id).maybeSingle();
  if (!sender) return { recipients: [], sent: 0, revert_link: null };
  // Workspace toggle off (the default): the owner-permission model is not in use, so no owner emails either.
  const { data: wsRow } = await admin.from("outreach_workspaces").select("settings").eq("id", sender.workspace_id).maybeSingle();
  if (!(wsRow?.settings?.profile_owner_permission === true)) { await rpc("profile_mark_notified", { p_change: change.id, p_recipients: [] }); return { recipients: [], sent: 0, revert_link: null }; }
  const recipients = await ownerRecipients(sender);
  const branding = await workspaceBranding(sender.workspace_id);
  const { data: preRow } = change.pre_snapshot_id ? await admin.from("outreach_profile_snapshots").select("data").eq("id", change.pre_snapshot_id).maybeSingle() : { data: null };
  const canRevert = change.status === "applied" || change.status === "partially_applied";
  const token = canRevert ? await rpc<string>("profile_issue_revert_token", { p_change: change.id }) : null;
  const link = token ? `${WEB_ORIGIN.replace(/\/$/, "")}/profile-revert/${token}` : null;
  const who = change.source === "rollback" ? "a rollback" : change.source === "experiment" ? "a profile experiment" : change.source === "template" ? "a bulk profile update" : change.approved_by_email ? `${esc(change.approved_by_email)}` : change.requested_by_email ? esc(change.requested_by_email) : "your outreach team";
  const failed = Object.keys(change.failed_fields ?? {}).filter((k) => k !== "_all");
  const statusLine = change.status === "failed" ? `<p style="padding:10px 12px;background:#fef2f2;border-radius:8px"><b>The change could not be applied.</b> ${esc(change.error_code ?? "")} Nothing on your profile was modified.</p>`
    : change.status === "partially_applied" ? `<p style="padding:10px 12px;background:#fffbeb;border-radius:8px"><b>Only part of the change landed.</b> LinkedIn did not accept: ${esc(failed.map((f) => GROUP_LABEL[f] ?? f).join(", "))}. Nothing is retried automatically.</p>` : "";
  const subject = change.status === "failed" ? `A change to your LinkedIn profile failed` : `Your LinkedIn profile was updated (${(change.field_groups ?? []).map((g: string) => GROUP_LABEL[g] ?? g).join(", ")})`;
  const html = layout(change.status === "failed" ? "A profile change failed" : "Your LinkedIn profile was updated",
    `<p>${esc(sender.display_name ?? "Your LinkedIn profile")} was changed by ${who} on ${esc(new Date(change.applied_at ?? Date.now()).toUTCString())}.</p>${statusLine}${diffTable(change, (preRow?.data as ProfileDoc) ?? null)}` +
    (link ? `<p style="margin-top:18px">${button(link, "Revert this change", branding)}</p><p style="font-size:12px;color:#666">The revert link works for 30 days and needs no login. Fields LinkedIn does not report back (photo settings, custom link) are restored to the last value written through the platform.</p>` : "") +
    `<p style="font-size:12px;color:#666;margin-top:14px">You receive this message for every change made to your profile through the platform. It cannot be switched off.</p>`,
    branding, { audience: "team", width: 640 });
  let sent = 0;
  for (const to of recipients) if (await sendEmail(to, subject, html, undefined, { branding })) sent++;
  await rpc("profile_mark_notified", { p_change: change.id, p_recipients: recipients });
  if (!recipients.length) log({ fn: "profile-notify", change_id: change.id, warn: "sender has no owner email; owner notification impossible" });
  return { recipients, sent, revert_link: link };
}

export async function notifyPendingChanges(limit = 30): Promise<{ notified: number; emails: number }> {
  const { data: rows } = await admin.from("outreach_profile_changes").select("*").is("owner_notified_at", null)
    .or("and(status.in.(applied,partially_applied),verified_at.not.is.null),status.eq.failed").order("updated_at").limit(limit);
  let notified = 0, emails = 0;
  for (const ch of rows ?? []) {
    try { const r = await notifyOwnerOfChange(ch); notified++; emails += r.sent; }
    catch (e) { log({ fn: "profile-notify", change_id: ch.id, error: String((e as Error).message ?? e) }); }
  }
  return { notified, emails };
}

/** propose_only: the owner gets the proposal with one-click Apply / Decline. Returns the link (for the UI when email is off). */
export async function sendApprovalRequest(change: Row, token: string): Promise<{ recipients: string[]; sent: number; link: string; configured: boolean }> {
  const { data: sender } = await admin.from("outreach_senders").select("*").eq("id", change.sender_id).maybeSingle();
  const link = `${WEB_ORIGIN.replace(/\/$/, "")}/profile-approve/${token}`;
  if (!sender) return { recipients: [], sent: 0, link, configured: emailConfigured() };
  const recipients = await ownerRecipients(sender);
  const branding = await workspaceBranding(sender.workspace_id);
  const { data: snap } = await admin.from("outreach_profile_snapshots").select("data").eq("sender_id", sender.id).order("captured_at", { ascending: false }).limit(1).maybeSingle();
  const html = layout("A change to your LinkedIn profile is waiting for you",
    `<p>${esc(change.requested_by_email ?? "Your outreach team")} proposes the following change to <b>${esc(sender.display_name ?? "your profile")}</b>. Nothing happens until you apply it.</p>${diffTable(change, (snap?.data as ProfileDoc) ?? null)}<p style="margin-top:18px">${button(link, "Review and apply", branding)}</p><p style="font-size:12px;color:#666">The link works for 14 days, needs no login, and lets you decline instead.</p>`, branding, { audience: "team", width: 640 });
  let sent = 0;
  for (const to of recipients) if (await sendEmail(to, `Approve a change to your LinkedIn profile`, html, undefined, { branding })) sent++;
  return { recipients, sent, link, configured: emailConfigured() };
}

/** Authority request: the owner grants per-field permission through a signed link. */
export async function sendAuthorityRequest(sender: Row, token: string, groups: string[], mode: string, requesterEmail: string | null): Promise<{ recipients: string[]; sent: number; link: string; configured: boolean }> {
  const link = `${WEB_ORIGIN.replace(/\/$/, "")}/profile-authority/${token}`;
  const recipients = await ownerRecipients(sender);
  const branding = await workspaceBranding(sender.workspace_id);
  const labels: Record<string, string> = { headline: "headline", about: "About section", photo: "profile photo", cover: "cover image", location: "location", experience: "experience entries", education: "education entries", skills: "skills", custom_link: "custom link" };
  const html = layout("Permission to edit parts of your LinkedIn profile",
    `<p>${esc(requesterEmail ?? "Your outreach team")} asks for permission to edit these parts of <b>${esc(sender.display_name ?? "your profile")}</b>: <b>${esc(groups.map((g) => labels[g] ?? g).join(", "))}</b>.</p>` +
    `<p>${mode === "direct" ? "With <b>direct</b> permission they can apply changes without asking each time. You are still emailed after every change, with a revert link." : "With <b>proposal</b> permission they can only send you drafts; each one waits for your click before it reaches LinkedIn."}</p>` +
    `<p>You choose which parts to allow, you can narrow the request, and you can revoke it later.</p><p style="margin-top:18px">${button(link, "Review the request", branding)}</p><p style="font-size:12px;color:#666">The link works for 7 days and needs no login.</p>`, branding, { audience: "team" });
  let sent = 0;
  for (const to of recipients) if (await sendEmail(to, `Permission request: your LinkedIn profile`, html, undefined, { branding })) sent++;
  return { recipients, sent, link, configured: emailConfigured() };
}

// ---------------------------------------------------------------------------
// Weekly: drift re-read (senders the studio is used on) + QA recompute for every LinkedIn sender with a snapshot
// ---------------------------------------------------------------------------
export async function weeklyDriftAndQa(maxReads = 60): Promise<{ drift_checked: number; drifted: number; qa: number; skipped: number }> {
  // senders with any grant or applied change, connected, not read in the last 6 days; random order = staggered across runs
  const { data } = await admin.from("outreach_senders").select("*").eq("provider", "LINKEDIN").eq("status", "ok").is("deleted_at", null);
  const { data: withAuth } = await admin.from("outreach_profile_authority").select("sender_id").is("revoked_at", null);
  const { data: withChange } = await admin.from("outreach_profile_changes").select("sender_id").in("status", ["applied", "partially_applied"]);
  const ids = new Set([...(withAuth ?? []).map((x) => x.sender_id), ...(withChange ?? []).map((x) => x.sender_id)]);
  let senders: Row[] = (data ?? []).filter((x) => ids.has(x.id));
  senders = senders.filter((x) => !x.profile_snapshot_at || Date.now() - new Date(x.profile_snapshot_at).getTime() > 6 * 86400_000).sort(() => Math.random() - 0.5).slice(0, maxReads);
  let drift_checked = 0, drifted = 0, skipped = 0;
  for (const sdr of senders) {
    try { const r = await snapshotSender(sdr, "drift_check"); if ("skipped" in r) skipped++; else { drift_checked++; if (r.drift.length) drifted++; } }
    catch (e) { skipped++; log({ fn: "profile-drift", sender_id: sdr.id, error: String((e as Error).message ?? e) }); }
  }
  const { data: withSnap } = await admin.from("outreach_senders").select("id").eq("provider", "LINKEDIN").is("deleted_at", null).not("profile_snapshot_at", "is", null).limit(500);
  let qa = 0;
  for (const x of withSnap ?? []) { try { await rpc("profile_qa_compute", { p_sender: x.id }); qa++; } catch { /* ignore */ } }
  return { drift_checked, drifted, qa, skipped };
}

export const _test = { normaliseProfile, verifyAgainst, diffDocs, diffTable, fidelityOf, FUNCTIONS_BASE };
