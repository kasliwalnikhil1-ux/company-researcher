// CapitalxAI Outreach Session Sync — background service worker (Manifest V3, no build step).
//
// What it does:
//   * every 180 minutes (alarm) and whenever the LinkedIn `li_at` / `li_a` cookie changes (debounced 60 s)
//     it reads the cookies, resolves the logged-in member id, and POSTs them to the workspace backend
//     (`outreach-cookie-sync`) using the per-sender pairing token pasted in the popup.
//   * the badge shows the last result: OK (green), ! (red: identity mismatch / error), OUT (grey: logged out).
//
// Storage keys (chrome.storage.local):
//   sender_token, functions_base, last_sync_at, last_status, last_error, sender_name, sender_status, backoff_until

const DEFAULT_FUNCTIONS_BASE = "https://ktwqkvjuzsunssudqnrt.supabase.co/functions/v1";
const LINKEDIN_URL = "https://www.linkedin.com/";
const PERIODIC_ALARM = "outreach-sync-periodic";
const DEBOUNCE_ALARM = "outreach-sync-debounced";
const PERIOD_MINUTES = 180;
const DEBOUNCE_MINUTES = 1; // Chrome alarms cannot fire sooner than 1 minute
const RATE_LIMIT_BACKOFF_MS = 10 * 60 * 1000; // backend allows 1 sync / 10 min / sender
const ERROR_BACKOFF_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}
function storageSet(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}
function getCookie(name) {
  return new Promise((resolve) => chrome.cookies.get({ url: LINKEDIN_URL, name }, (c) => resolve(c ? c.value : null)));
}

function setBadge(text, color) {
  try {
    chrome.action.setBadgeText({ text });
    if (color) chrome.action.setBadgeBackgroundColor({ color });
  } catch (_) { /* action API unavailable in some contexts */ }
}

function normaliseBase(base) {
  const b = (base || DEFAULT_FUNCTIONS_BASE).trim().replace(/\/+$/, "");
  return b || DEFAULT_FUNCTIONS_BASE;
}

/** Resolve the logged-in member's plainId + publicIdentifier. */
async function resolveIdentity() {
  let plain_id = null;
  let public_identifier = null;

  // 1) Voyager "me" endpoint (most reliable). Needs the csrf-token header = JSESSIONID cookie value.
  try {
    const jsession = await getCookie("JSESSIONID");
    if (jsession) {
      const res = await fetch("https://www.linkedin.com/voyager/api/me", {
        credentials: "include",
        headers: { "csrf-token": jsession.replace(/^"|"$/g, ""), accept: "application/vnd.linkedin.normalized+json+2.1" },
      });
      if (res.ok) {
        const text = await res.text();
        const m1 = /"plainId":(\d+)/.exec(text);
        const m2 = /"publicIdentifier":"([^"]+)"/.exec(text);
        if (m1) plain_id = m1[1];
        if (m2) public_identifier = m2[1];
      }
    }
  } catch (_) { /* fall through to the HTML page */ }

  // 2) Feed HTML fallback (PRD §11.6): regex on "plainId":N or urn:li:member:N and "publicIdentifier":"x".
  if (!plain_id || !public_identifier) {
    try {
      const res = await fetch("https://www.linkedin.com/feed/", { credentials: "include", redirect: "follow" });
      const html = await res.text();
      if (/\/login|\/checkpoint\/|\/authwall/i.test(res.url) && !/"plainId"/.test(html)) return { plain_id, public_identifier, logged_out: true };
      if (!plain_id) {
        const m = /"plainId":(\d+)/.exec(html) || /urn:li:member:(\d+)/.exec(html);
        if (m) plain_id = m[1];
      }
      if (!public_identifier) {
        const m = /"publicIdentifier":"([^"]+)"/.exec(html);
        if (m) public_identifier = m[1];
      }
    } catch (_) { /* network error: identity unknown */ }
  }
  return { plain_id, public_identifier, logged_out: false };
}

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------
let syncing = null; // in-flight promise (dedupe concurrent triggers)

async function runSync(reason) {
  if (syncing) return syncing;
  syncing = doSync(reason).finally(() => { syncing = null; });
  return syncing;
}

async function doSync(reason) {
  const st = await storageGet(["sender_token", "functions_base", "backoff_until"]);
  const token = (st.sender_token || "").trim();
  if (!token) {
    await storageSet({ last_status: "no_token", last_error: "Paste a pairing token in the popup to start syncing." });
    setBadge("", null);
    return { ok: false, status: "no_token" };
  }
  const manual = reason === "manual";
  if (!manual && st.backoff_until && Date.now() < st.backoff_until) {
    return { ok: false, status: "backoff", until: st.backoff_until };
  }

  const li_at = await getCookie("li_at");
  if (!li_at) {
    await storageSet({ last_status: "logged_out", last_error: "No li_at cookie — log in to LinkedIn in this browser profile.", last_sync_at: Date.now() });
    setBadge("OUT", "#6b7280");
    return { ok: false, status: "logged_out" };
  }
  const li_a = await getCookie("li_a");
  const identity = await resolveIdentity();
  if (identity.logged_out) {
    await storageSet({ last_status: "logged_out", last_error: "LinkedIn redirected to login — session expired.", last_sync_at: Date.now() });
    setBadge("OUT", "#6b7280");
    return { ok: false, status: "logged_out" };
  }

  const body = {
    li_at,
    li_a: li_a || undefined,
    user_agent: (typeof navigator !== "undefined" && navigator.userAgent) || "unknown",
    plain_id: identity.plain_id || undefined,
    public_identifier: identity.public_identifier || undefined,
  };

  const url = `${normaliseBase(st.functions_base)}/outreach-cookie-sync`;
  let res, data = null, text = "";
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    text = await res.text();
    try { data = JSON.parse(text); } catch (_) { data = null; }
  } catch (e) {
    await storageSet({ last_status: "error", last_error: `Network error: ${e && e.message ? e.message : e}`, last_sync_at: Date.now(), backoff_until: Date.now() + ERROR_BACKOFF_MS });
    setBadge("!", "#dc2626");
    return { ok: false, status: "error", error: String(e) };
  }

  if (res.ok) {
    const sender = data && data.sender ? data.sender : null;
    await storageSet({
      last_status: "ok", last_error: "", last_sync_at: Date.now(), backoff_until: Date.now() + RATE_LIMIT_BACKOFF_MS,
      sender_name: sender ? (sender.display_name || sender.id) : "", sender_status: sender ? sender.status : "",
      last_reconnect: data && data.reconnect ? data.reconnect : null,
    });
    setBadge("OK", "#16a34a");
    return { ok: true, status: "ok", sender };
  }

  const code = (data && data.code) || `HTTP ${res.status}`;
  const msg = (data && (data.error || data.message)) || text.slice(0, 200) || res.statusText;
  let status = "error";
  let backoff = ERROR_BACKOFF_MS;
  if (res.status === 409 || code === "E_IDENTITY_MISMATCH") status = "identity_mismatch";
  else if (res.status === 429 || code === "E_RATE_LIMITED") { status = "rate_limited"; backoff = RATE_LIMIT_BACKOFF_MS; }
  else if (res.status === 401 || res.status === 403) status = "bad_token";
  else if (res.status === 404) status = "sender_disabled";
  await storageSet({ last_status: status, last_error: `${code}: ${msg}`, last_sync_at: Date.now(), backoff_until: Date.now() + backoff });
  setBadge("!", "#dc2626");
  return { ok: false, status, code, error: msg };
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------
function ensureAlarms() {
  chrome.alarms.get(PERIODIC_ALARM, (a) => {
    if (!a) chrome.alarms.create(PERIODIC_ALARM, { delayInMinutes: 1, periodInMinutes: PERIOD_MINUTES });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarms();
  setBadge("", null);
});
chrome.runtime.onStartup.addListener(ensureAlarms);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PERIODIC_ALARM) runSync("periodic");
  else if (alarm.name === DEBOUNCE_ALARM) runSync("cookie_changed");
});

// li_at / li_a changed → debounce (re-creating an alarm with the same name resets it)
chrome.cookies.onChanged.addListener((info) => {
  const c = info.cookie;
  if (!c || !/linkedin\.com$/.test(c.domain || "")) return;
  if (c.name !== "li_at" && c.name !== "li_a") return;
  if (info.removed && c.name === "li_at" && info.cause !== "overwrite") {
    // logged out
    storageSet({ last_status: "logged_out", last_error: "li_at cookie removed (logged out of LinkedIn)." });
    setBadge("OUT", "#6b7280");
    return;
  }
  chrome.alarms.create(DEBOUNCE_ALARM, { delayInMinutes: DEBOUNCE_MINUTES });
});

// popup → background
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "sync-now") {
    runSync("manual").then(sendResponse).catch((e) => sendResponse({ ok: false, status: "error", error: String(e) }));
    return true; // async
  }
  if (msg && msg.type === "ensure-alarms") { ensureAlarms(); sendResponse({ ok: true }); }
  return false;
});
