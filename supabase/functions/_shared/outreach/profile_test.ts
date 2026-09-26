// Unit tests for the Profile Studio runtime: snapshot normalisation, post-verify diffing, drift detection, the owner diff table.
//   deno test --allow-read --allow-env --node-modules-dir=none supabase/functions/_shared/outreach/profile_test.ts
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test");
const { _test } = await import("./profile.ts");
const { normaliseProfile, verifyAgainst, diffDocs, diffTable } = _test;

let failed = 0;
const check = (label: string, cond: boolean, extra?: unknown) => { if (!cond) { failed++; console.error(`FAIL ${label}`, extra ?? ""); } };
const same = (label: string, got: unknown, want: unknown) => check(label, JSON.stringify(got) === JSON.stringify(want), { got, want });

// --- normalise
const raw = {
  provider_id: "ACo123", public_identifier: "Ada-L", first_name: "Ada", last_name: "Lovelace", headline: "  Analyst at Babbage & Co ", summary: "About me.\n\nSecond paragraph.",
  location: "London, UK", profile_picture_url: "https://media/pic.jpg", background_picture_url: "https://media/cover.jpg", connections_count: "812", follower_count: 900, premium: true,
  work_experience: [{ id: "exp_1", position: "Analyst", company: "Babbage & Co", company_id: "77", start: "3/2024", current: true, description: "Engines.", skills: ["Maths", { name: "Logic" }] }, { position: "", company: "" }],
  education: [{ id: "edu_1", school: "Home", degree: "None", field_of_study: "Maths", start: "1830" }],
  skills: [{ name: "Maths", endorsement_count: 12 }, "Logic", { name: "" }],
  languages: ["English", { name: "French" }], certifications: [{ name: "Cert", organization: "Org" }], projects: [{ name: "Notes" }], websites: ["https://ada.example", { url: "https://b.example" }],
};
const doc = normaliseProfile(raw, ["about", "experience", "education", "skills"]);
same("headline trimmed", doc.headline, "Analyst at Babbage & Co");
same("public identifier lower-cased", doc.public_identifier, "ada-l");
same("connections parsed", doc.connections_count, 812);
same("premium from `premium`", doc.is_premium, true);
same("cover from background_picture_url", doc.cover_url, "https://media/cover.jpg");
same("experience kept with id + skills, empty entry dropped", doc.experience.map((e) => [e.id, e.title, e.company, e.current, e.skills]), [["exp_1", "Analyst", "Babbage & Co", true, ["Maths", "Logic"]]]);
same("education", doc.education.map((e) => [e.id, e.school, e.field]), [["edu_1", "Home", "Maths"]]);
same("skills with endorsements, blank dropped", doc.skills, [{ name: "Maths", endorsements: 12 }, { name: "Logic", endorsements: null }]);
same("languages / websites", [doc.languages, doc.websites], [["English", "French"], ["https://ada.example", "https://b.example"]]);
same("fetched sections recorded", doc.fetched_sections, ["about", "experience", "education", "skills"]);

// --- verify
const pre = { ...doc };
const postOk = { ...doc, headline: "Helping fintech CFOs close the books in 3 days", summary: "New about", skills: [{ name: "Maths", endorsements: 12 }, { name: "Outbound", endorsements: null }], experience: [{ ...doc.experience[0], description: "New desc" }] };
let v = verifyAgainst({ payload: { headline: "Helping fintech CFOs close the books in 3 days", summary: "New about", skills: ["Outbound"], experience: { id: "exp_1", description: "New desc" }, picture_settings: { filter: "STUDIO" } }, assets: {} }, pre, postOk);
same("everything applied; settings written-only", [v.applied, v.failed, v.written_only], [["headline", "summary", "skills", "experience", "picture_settings"], {}, ["picture_settings"]]);
v = verifyAgainst({ payload: { headline: "Wanted", summary: "New about" }, assets: {} }, pre, { ...postOk, headline: "Old headline" });
same("headline not visible → failed, summary applied", [v.applied, v.failed], [["summary"], { headline: "E_PROFILE_NOT_VISIBLE" }]);
v = verifyAgainst({ payload: { experience: { id: "exp_1", description: "New desc" } }, assets: {} }, pre, { ...postOk, experience: [{ ...doc.experience[0], description: "old" }] });
same("experience description mismatch", v.failed, { experience: "E_PROFILE_NOT_VISIBLE:description" });
v = verifyAgainst({ payload: {}, assets: { picture: "ws/sender/x.jpg" } }, pre, { ...postOk, picture_url: "https://media/pic.jpg" });
same("picture URL unchanged → not visible", v.failed, { picture: "E_PROFILE_NOT_VISIBLE" });
v = verifyAgainst({ payload: {}, assets: { picture: "ws/sender/x.jpg" } }, pre, { ...postOk, picture_url: "https://media/new.jpg" });
same("picture URL changed → applied", v.applied, ["picture"]);
v = verifyAgainst({ payload: { skills: ["Maths"] }, assets: {} }, pre, { ...postOk, skills: [] });
same("skills section empty (throttled) → written-only, not failed", [v.failed, v.written_only], [{}, ["skills"]]);
v = verifyAgainst({ payload: { location: { id: "1" } }, assets: {} }, { ...pre, location: "London, UK" }, { ...postOk, location: "London, UK" });
same("location unchanged text → not visible", v.failed, { location: "E_PROFILE_NOT_VISIBLE" });

// --- drift
same("no drift on identical docs", diffDocs(doc, { ...doc }), []);
same("headline + skills + experience drift", diffDocs(doc, { ...doc, headline: "Changed", skills: [{ name: "Other", endorsements: null }], experience: [{ ...doc.experience[0], description: "edited on LinkedIn" }] }), ["headline", "skills", "experience"]);
same("summary drift ignored when one side unknown", diffDocs({ ...doc, summary: null }, { ...doc, summary: "x" }), []);

// --- email diff table
const html = diffTable({ payload: { headline: "New <b>bold</b>", experience: { id: "exp_1", description: "New desc" } }, assets: { picture: "p" } }, doc);
check("table escapes html", html.includes("New &lt;b&gt;bold&lt;/b&gt;") && !html.includes("<b>bold</b>"));
check("table shows before headline", html.includes("Analyst at Babbage &amp; Co"));
check("table shows previous experience entry", html.includes("Engines."));
check("table shows photo row", html.includes("Profile photo") && html.includes("previous photo"));

if (failed) { console.error(`${failed} check(s) failed`); Deno.exit(1); }
console.log("profile runtime: normalise / verify / drift / diff table OK");
