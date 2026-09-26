// Profile Studio — the ONLY module that builds the multipart body for `PATCH /api/v1/users/me/edit` (PRD §7.4).
//
// Why a dedicated serialiser: the endpoint takes multipart/form-data with bracket notation
// (`experience[seniority[start_date[month]]]`), repeated keys for arrays (`skills` once per value) and binary parts for
// pictures. A silently wrong key writes garbage into a real person's work history, so:
//   * the input is a typed model (ProfilePayload) — nothing else is accepted;
//   * strict mode throws on any key outside the known field set (a typo never becomes a silent no-op);
//   * `notify_network` is hardcoded to false and `open_to_work` is rejected outright (PRD §5.3, §5.4);
//   * `encodeProfileEdit()` returns the flat [name, value] pairs in a stable order, so golden-file tests can assert
//     the exact body; `toFormData()` turns them into the FormData the HTTP client sends.
//
// Field reference (Unipile "Edit own profile", 28 Aug 2026): see linkedin-profile-management-PRD.md §1.1.

export type FieldGroup = "headline" | "about" | "photo" | "cover" | "location" | "experience" | "education" | "skills" | "custom_link";
export const FIELD_GROUPS: readonly FieldGroup[] = ["headline", "about", "photo", "cover", "location", "experience", "education", "skills", "custom_link"] as const;

export const PICTURE_FILTERS = ["ORIGINAL", "STUDIO", "SPOTLIGHT", "PRIME", "CLASSIC", "EDGE", "LUMINATE"] as const;
export type PictureFilter = (typeof PICTURE_FILTERS)[number];
export const PRESENCES = ["ON_SITE", "HYBRID", "REMOTE"] as const;
export const EMPLOYMENT_TYPES = ["FULL_TIME", "PART_TIME", "SELF_EMPLOYED", "FREELANCE", "CONTRACT", "INTERNSHIP", "APPRENTICESHIP", "SEASONAL"] as const;
export const CUSTOM_LINK_TYPES = ["STORE", "WEBSITE", "PORTFOLIO", "BLOG", "NEWSLETTER"] as const;
export const CUSTOM_LINK_DISPLAY = ["PROFILE_ONLY", "EVERYWHERE"] as const;
export const ATTACHMENT_TYPES = ["link", "media"] as const;

/** LinkedIn's own limits (characters). Enforced by the validator before anything is queued. */
export const LIMITS = { headline: 220, summary: 2600, experience_description: 2000, education_description: 1000, role: 100, company: 100, school: 100, degree: 100, field_of_study: 100, skill: 80, custom_link_url: 250 } as const;

export interface PictureSettings {
  filter?: PictureFilter;
  layout?: { topLeft?: XY; topRight?: XY; bottomLeft?: XY; bottomRight?: XY };
  contrast?: number; brightness?: number; saturation?: number; vignette?: number;
}
export interface XY { x: number; y: number }
export interface MonthYear { month?: number; year: number }
export interface Attachment { type: (typeof ATTACHMENT_TYPES)[number]; title?: string; description?: string; url?: string; file?: Blob; thumbnail?: Blob }

export interface ExperienceInput {
  id?: string;                      // edit an existing entry
  role?: string; company?: string;  // create a new one (both required when no id)
  company_id?: string;
  employment_type?: (typeof EMPLOYMENT_TYPES)[number];
  location?: string;
  presence?: (typeof PRESENCES)[number];
  description?: string;
  source_of_hire?: string;
  start_date?: MonthYear; end_date?: MonthYear;
  skills?: string[];
  attachment?: Attachment;
}
export interface EducationInput {
  id?: string; school?: string;
  degree?: string; field_of_study?: string; grade?: string; activities?: string; description?: string;
  start_date?: MonthYear; end_date?: MonthYear;
  skills?: string[];
  attachment?: Attachment;
}
export interface CustomLinkInput { type: (typeof CUSTOM_LINK_TYPES)[number]; url: string; display_on?: (typeof CUSTOM_LINK_DISPLAY)[number] }

/** The typed model. Binary parts are Blobs (Files keep their name). */
export interface ProfilePayload {
  headline?: string;
  summary?: string;
  picture?: Blob; picture_settings?: PictureSettings;
  cover_picture?: Blob; cover_picture_settings?: PictureSettings;
  location?: { id?: string; postal_code?: string };
  experience?: ExperienceInput;
  education?: EducationInput;
  skills?: string[]; skills_follow?: boolean;
  custom_link?: CustomLinkInput;
}

/** Every key a payload object may carry, per level. Anything else is a hard error in strict mode. */
const TOP_KEYS = new Set(["headline", "summary", "picture", "picture_settings", "cover_picture", "cover_picture_settings", "location", "experience", "education", "skills", "skills_follow", "custom_link"]);
const SETTINGS_KEYS = new Set(["filter", "layout", "contrast", "brightness", "saturation", "vignette"]);
const LAYOUT_KEYS = new Set(["topLeft", "topRight", "bottomLeft", "bottomRight"]);
const LOCATION_KEYS = new Set(["id", "postal_code"]);
const EXPERIENCE_KEYS = new Set(["id", "role", "company", "company_id", "employment_type", "location", "presence", "description", "source_of_hire", "start_date", "end_date", "skills", "attachment"]);
const EDUCATION_KEYS = new Set(["id", "school", "degree", "field_of_study", "grade", "activities", "description", "start_date", "end_date", "skills", "attachment"]);
const ATTACHMENT_KEYS = new Set(["type", "title", "description", "url", "file", "thumbnail"]);
const LINK_KEYS = new Set(["type", "url", "display_on"]);
const DATE_KEYS = new Set(["month", "year"]);
/** Keys the platform refuses to write, whoever asks (PRD §4.4, §5.3, §5.4). */
const FORBIDDEN_KEYS = new Set(["open_to_work", "notify_network", "first_name", "last_name", "pronouns", "public_identifier"]);

export class ProfileSerialiserError extends Error {
  code: string; path: string;
  constructor(code: string, path: string, message: string) { super(`${code}: ${message} (at ${path})`); this.code = code; this.path = path; }
}

export type Part = [name: string, value: string | Blob];

function checkKeys(obj: object, allowed: Set<string>, path: string, strict: boolean): void {
  for (const k of Object.keys(obj)) {
    if (FORBIDDEN_KEYS.has(k)) throw new ProfileSerialiserError("E_PROFILE_FIELD_FORBIDDEN", `${path}.${k}`, `${k} is never written by the platform`);
    if (!allowed.has(k)) {
      if (strict) throw new ProfileSerialiserError("E_PROFILE_FIELD_UNKNOWN", `${path}.${k}`, `unknown field ${k}`);
    }
  }
}

const isBlob = (v: unknown): v is Blob => typeof Blob !== "undefined" && v instanceof Blob;

function str(v: unknown, path: string, max?: number): string {
  if (typeof v !== "string") throw new ProfileSerialiserError("E_PROFILE_FIELD_TYPE", path, "expected a string");
  if (max !== undefined && v.length > max) throw new ProfileSerialiserError("E_PROFILE_FIELD_TOO_LONG", path, `longer than ${max} characters`);
  return v;
}
function num(v: unknown, path: string, lo: number, hi: number): string {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ProfileSerialiserError("E_PROFILE_FIELD_TYPE", path, "expected a number");
  if (v < lo || v > hi) throw new ProfileSerialiserError("E_PROFILE_FIELD_RANGE", path, `must be between ${lo} and ${hi}`);
  return String(v);
}
function oneOf(v: unknown, path: string, opts: readonly string[]): string {
  if (typeof v !== "string" || !opts.includes(v)) throw new ProfileSerialiserError("E_PROFILE_FIELD_ENUM", path, `must be one of ${opts.join(", ")}`);
  return v;
}

function encodeSettings(out: Part[], prefix: string, s: PictureSettings, path: string, strict: boolean): void {
  checkKeys(s, SETTINGS_KEYS, path, strict);
  if (s.filter !== undefined) out.push([`${prefix}[filter]`, oneOf(s.filter, `${path}.filter`, PICTURE_FILTERS)]);
  if (s.layout !== undefined) {
    checkKeys(s.layout, LAYOUT_KEYS, `${path}.layout`, strict);
    for (const corner of ["topLeft", "topRight", "bottomLeft", "bottomRight"] as const) {
      const c = s.layout[corner];
      if (!c) continue;
      out.push([`${prefix}[layout][${corner}][x]`, num(c.x, `${path}.layout.${corner}.x`, 0, 1)]);
      out.push([`${prefix}[layout][${corner}][y]`, num(c.y, `${path}.layout.${corner}.y`, 0, 1)]);
    }
  }
  for (const k of ["contrast", "brightness", "saturation", "vignette"] as const) {
    if (s[k] !== undefined) out.push([`${prefix}[${k}]`, num(s[k], `${path}.${k}`, -100, 100)]);
  }
}

function encodeDate(out: Part[], prefix: string, d: MonthYear, path: string, strict: boolean): void {
  checkKeys(d, DATE_KEYS, path, strict);
  if (d.month !== undefined) out.push([`${prefix}[month]`, num(d.month, `${path}.month`, 1, 12)]);
  out.push([`${prefix}[year]`, num(d.year, `${path}.year`, 1900, 2100)]);
}

function encodeAttachment(out: Part[], prefix: string, a: Attachment, path: string, strict: boolean): void {
  checkKeys(a, ATTACHMENT_KEYS, path, strict);
  out.push([`${prefix}[type]`, oneOf(a.type, `${path}.type`, ATTACHMENT_TYPES)]);
  if (a.title !== undefined) out.push([`${prefix}[title]`, str(a.title, `${path}.title`, 200)]);
  if (a.description !== undefined) out.push([`${prefix}[description]`, str(a.description, `${path}.description`, 1000)]);
  if (a.url !== undefined) out.push([`${prefix}[url]`, str(a.url, `${path}.url`, 2000)]);
  if (a.file !== undefined) { if (!isBlob(a.file)) throw new ProfileSerialiserError("E_PROFILE_FIELD_TYPE", `${path}.file`, "expected binary"); out.push([`${prefix}[file]`, a.file]); }
  if (a.thumbnail !== undefined) { if (!isBlob(a.thumbnail)) throw new ProfileSerialiserError("E_PROFILE_FIELD_TYPE", `${path}.thumbnail`, "expected binary"); out.push([`${prefix}[thumbnail]`, a.thumbnail]); }
}

function encodeSkills(out: Part[], name: string, skills: unknown, path: string): void {
  if (!Array.isArray(skills)) throw new ProfileSerialiserError("E_PROFILE_FIELD_TYPE", path, "expected a list of strings");
  const seen = new Set<string>();
  skills.forEach((s, i) => {
    const v = str(s, `${path}[${i}]`, LIMITS.skill).trim();
    if (!v) throw new ProfileSerialiserError("E_PROFILE_FIELD_EMPTY", `${path}[${i}]`, "empty skill");
    if (seen.has(v.toLowerCase())) return;   // repeated key once per DISTINCT value
    seen.add(v.toLowerCase());
    out.push([name, v]);
  });
}

function encodeExperience(out: Part[], e: ExperienceInput, strict: boolean): void {
  const p = "experience";
  checkKeys(e, EXPERIENCE_KEYS, p, strict);
  if (!e.id && !(e.role && e.company)) throw new ProfileSerialiserError("E_PROFILE_FIELD_MISSING", p, "an experience needs an id (edit) or role + company (create)");
  if (e.id !== undefined) out.push([`${p}[id]`, str(e.id, `${p}.id`, 100)]);
  if (e.role !== undefined) out.push([`${p}[role]`, str(e.role, `${p}.role`, LIMITS.role)]);
  if (e.company !== undefined) out.push([`${p}[company]`, str(e.company, `${p}.company`, LIMITS.company)]);
  if (e.company_id !== undefined) out.push([`${p}[company_id]`, str(e.company_id, `${p}.company_id`, 100)]);
  if (e.employment_type !== undefined) out.push([`${p}[employment_type]`, oneOf(e.employment_type, `${p}.employment_type`, EMPLOYMENT_TYPES)]);
  if (e.location !== undefined) out.push([`${p}[location]`, str(e.location, `${p}.location`, 200)]);
  if (e.presence !== undefined) out.push([`${p}[presence]`, oneOf(e.presence, `${p}.presence`, PRESENCES)]);
  if (e.description !== undefined) out.push([`${p}[description]`, str(e.description, `${p}.description`, LIMITS.experience_description)]);
  if (e.source_of_hire !== undefined) out.push([`${p}[source_of_hire]`, str(e.source_of_hire, `${p}.source_of_hire`, 100)]);
  if (e.start_date !== undefined) encodeDate(out, `${p}[seniority][start_date]`, e.start_date, `${p}.start_date`, strict);
  if (e.end_date !== undefined) encodeDate(out, `${p}[seniority][end_date]`, e.end_date, `${p}.end_date`, strict);
  if (e.skills !== undefined) encodeSkills(out, `${p}[skills]`, e.skills, `${p}.skills`);
  if (e.attachment !== undefined) encodeAttachment(out, `${p}[attachment]`, e.attachment, `${p}.attachment`, strict);
  out.push([`${p}[notify_network]`, "false"]);   // PRD §5.3: hardcoded, never exposed
}

function encodeEducation(out: Part[], e: EducationInput, strict: boolean): void {
  const p = "education";
  checkKeys(e, EDUCATION_KEYS, p, strict);
  if (!e.id && !e.school) throw new ProfileSerialiserError("E_PROFILE_FIELD_MISSING", p, "an education entry needs an id (edit) or a school (create)");
  if (e.id !== undefined) out.push([`${p}[id]`, str(e.id, `${p}.id`, 100)]);
  if (e.school !== undefined) out.push([`${p}[school]`, str(e.school, `${p}.school`, LIMITS.school)]);
  if (e.degree !== undefined) out.push([`${p}[degree]`, str(e.degree, `${p}.degree`, LIMITS.degree)]);
  if (e.field_of_study !== undefined) out.push([`${p}[field_of_study]`, str(e.field_of_study, `${p}.field_of_study`, LIMITS.field_of_study)]);
  if (e.grade !== undefined) out.push([`${p}[grade]`, str(e.grade, `${p}.grade`, 80)]);
  if (e.activities !== undefined) out.push([`${p}[activities]`, str(e.activities, `${p}.activities`, 500)]);
  if (e.description !== undefined) out.push([`${p}[description]`, str(e.description, `${p}.description`, LIMITS.education_description)]);
  if (e.start_date !== undefined) encodeDate(out, `${p}[start_date]`, e.start_date, `${p}.start_date`, strict);
  if (e.end_date !== undefined) encodeDate(out, `${p}[end_date]`, e.end_date, `${p}.end_date`, strict);
  if (e.skills !== undefined) encodeSkills(out, `${p}[skills]`, e.skills, `${p}.skills`);
  if (e.attachment !== undefined) encodeAttachment(out, `${p}[attachment]`, e.attachment, `${p}.attachment`, strict);
  out.push([`${p}[notify_network]`, "false"]);
}

export interface EncodeOptions { strict?: boolean }

/**
 * Typed payload → ordered multipart parts. `account_id` and `type: LINKEDIN` are always first. Throws
 * ProfileSerialiserError on any unknown / forbidden / out-of-range field. Strict by default.
 */
export function encodeProfileEdit(accountId: string, payload: ProfilePayload, opts: EncodeOptions = {}): Part[] {
  const strict = opts.strict !== false;
  if (!accountId) throw new ProfileSerialiserError("E_PROFILE_FIELD_MISSING", "account_id", "account id required");
  if (!payload || typeof payload !== "object") throw new ProfileSerialiserError("E_PROFILE_FIELD_TYPE", "payload", "expected an object");
  checkKeys(payload, TOP_KEYS, "payload", strict);
  const out: Part[] = [["account_id", accountId], ["type", "LINKEDIN"]];

  if (payload.headline !== undefined) out.push(["headline", str(payload.headline, "headline", LIMITS.headline)]);
  if (payload.summary !== undefined) out.push(["summary", str(payload.summary, "summary", LIMITS.summary)]);
  if (payload.picture !== undefined) { if (!isBlob(payload.picture)) throw new ProfileSerialiserError("E_PROFILE_FIELD_TYPE", "picture", "expected binary"); out.push(["picture", payload.picture]); }
  if (payload.picture_settings !== undefined) encodeSettings(out, "picture_settings", payload.picture_settings, "picture_settings", strict);
  if (payload.cover_picture !== undefined) { if (!isBlob(payload.cover_picture)) throw new ProfileSerialiserError("E_PROFILE_FIELD_TYPE", "cover_picture", "expected binary"); out.push(["cover_picture", payload.cover_picture]); }
  if (payload.cover_picture_settings !== undefined) encodeSettings(out, "cover_picture_settings", payload.cover_picture_settings, "cover_picture_settings", strict);
  if (payload.location !== undefined) {
    checkKeys(payload.location, LOCATION_KEYS, "location", strict);
    if (!payload.location.id && !payload.location.postal_code) throw new ProfileSerialiserError("E_PROFILE_FIELD_MISSING", "location", "location needs an id or a postal_code");
    if (payload.location.id !== undefined) out.push(["location[id]", str(payload.location.id, "location.id", 100)]);
    if (payload.location.postal_code !== undefined) out.push(["location[postal_code]", str(payload.location.postal_code, "location.postal_code", 20)]);
  }
  if (payload.experience !== undefined) encodeExperience(out, payload.experience, strict);
  if (payload.education !== undefined) encodeEducation(out, payload.education, strict);
  if (payload.skills !== undefined) encodeSkills(out, "skills", payload.skills, "skills");
  if (payload.skills_follow !== undefined) {
    if (typeof payload.skills_follow !== "boolean") throw new ProfileSerialiserError("E_PROFILE_FIELD_TYPE", "skills_follow", "expected a boolean");
    out.push(["skills_follow", payload.skills_follow ? "true" : "false"]);
  }
  if (payload.custom_link !== undefined) {
    const l = payload.custom_link;
    checkKeys(l, LINK_KEYS, "custom_link", strict);
    out.push(["custom_link[type]", oneOf(l.type, "custom_link.type", CUSTOM_LINK_TYPES)]);
    const url = str(l.url, "custom_link.url", LIMITS.custom_link_url);
    if (!/^https?:\/\/\S+$/i.test(url)) throw new ProfileSerialiserError("E_PROFILE_FIELD_TYPE", "custom_link.url", "must be an http(s) URL");
    out.push(["custom_link[url]", url]);
    if (l.display_on !== undefined) out.push(["custom_link[display_on]", oneOf(l.display_on, "custom_link.display_on", CUSTOM_LINK_DISPLAY)]);
  }
  if (out.length === 2) throw new ProfileSerialiserError("E_PROFILE_FIELD_MISSING", "payload", "nothing to change");
  return out;
}

/** Parts → FormData for fetch(). Binary parts keep their File name when they have one. */
export function toFormData(parts: Part[]): FormData {
  const f = new FormData();
  for (const [k, v] of parts) {
    if (isBlob(v)) f.append(k, v, (v as File).name || undefined);
    else f.append(k, v);
  }
  return f;
}

/** The text-only view of an encoded body, for tests and audit logs: binary parts are shown as `<binary N bytes>`. */
export function describeParts(parts: Part[]): Array<[string, string]> {
  return parts.map(([k, v]) => [k, isBlob(v) ? `<binary ${v.size} bytes>` : v]);
}

// ---------------------------------------------------------------------------
// Field-group mapping: which groups a payload touches, what can be read back, and the fidelity of a rollback.
// ---------------------------------------------------------------------------

/** Which authority groups a payload touches (PRD §4.2). */
export function fieldGroupsOf(payload: ProfilePayload): FieldGroup[] {
  const g = new Set<FieldGroup>();
  if (payload.headline !== undefined) g.add("headline");
  if (payload.summary !== undefined) g.add("about");
  if (payload.picture !== undefined || payload.picture_settings !== undefined) g.add("photo");
  if (payload.cover_picture !== undefined || payload.cover_picture_settings !== undefined) g.add("cover");
  if (payload.location !== undefined) g.add("location");
  if (payload.experience !== undefined) g.add("experience");
  if (payload.education !== undefined) g.add("education");
  if (payload.skills !== undefined || payload.skills_follow !== undefined) g.add("skills");
  if (payload.custom_link !== undefined) g.add("custom_link");
  return FIELD_GROUPS.filter((x) => g.has(x));
}

/** Payload keys that have NO read path on Unipile (PRD §1.2 consequence 2): our last written value is the only record. */
export const UNREADABLE_KEYS = ["picture_settings", "cover_picture_settings", "custom_link", "skills_follow"] as const;

export function unwrittenFieldsOf(payload: ProfilePayload): string[] {
  return UNREADABLE_KEYS.filter((k) => (payload as Record<string, unknown>)[k] !== undefined);
}

/** The `linkedin_sections` a selective read needs to verify these groups. Never "*". */
export function sectionsForGroups(groups: readonly FieldGroup[]): string[] {
  const s = new Set<string>();
  for (const g of groups) {
    if (g === "about") s.add("about");
    if (g === "experience") s.add("experience");
    if (g === "education") s.add("education");
    if (g === "skills") s.add("skills");
    // headline, photo, cover, location come with the base profile; custom_link has no read path
  }
  return [...s];
}

export type Fidelity = "full" | "partial" | "written_only";

/** Rollback fidelity per payload key (PRD §7.2 table). `uploaded` = we hold the original image in Storage. */
export function fidelityOf(key: string, opts: { uploaded?: boolean } = {}): Fidelity {
  switch (key) {
    case "headline": case "summary": case "experience": case "education": case "skills": case "location": return "full";
    case "picture": case "cover_picture": return opts.uploaded ? "full" : "partial";
    default: return "written_only";
  }
}
