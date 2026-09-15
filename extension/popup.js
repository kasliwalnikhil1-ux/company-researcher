// Popup logic: save pairing token / base URL, trigger a manual sync, render the last result.
const $ = (id) => document.getElementById(id);

const LABELS = {
  ok: ["Synced", "ok"],
  no_token: ["No token", "warn"],
  logged_out: ["Logged out of LinkedIn", "warn"],
  identity_mismatch: ["Wrong LinkedIn account", "err"],
  rate_limited: ["Rate limited — retry later", "warn"],
  bad_token: ["Token rejected", "err"],
  sender_disabled: ["Sender disabled", "err"],
  backoff: ["Waiting (backoff)", "warn"],
  error: ["Error", "err"],
};

function fmt(ts) {
  if (!ts) return "never";
  const d = new Date(ts);
  const diff = Math.round((Date.now() - ts) / 60000);
  const rel = diff < 1 ? "just now" : diff < 60 ? `${diff} min ago` : diff < 1440 ? `${Math.round(diff / 60)} h ago` : `${Math.round(diff / 1440)} d ago`;
  return `${d.toLocaleString()} (${rel})`;
}

function render(st) {
  const [label, cls] = LABELS[st.last_status] || ["Not synced yet", ""];
  const pill = $("status");
  pill.textContent = label;
  pill.className = `pill ${cls}`;
  const dot = $("dot");
  dot.className = `dot ${cls === "ok" ? "ok" : cls === "err" ? "err" : st.last_status === "logged_out" ? "out" : ""}`;
  $("sender").textContent = st.sender_name ? `${st.sender_name}${st.sender_status ? ` (${st.sender_status})` : ""}` : "—";
  $("last").textContent = fmt(st.last_sync_at);
  $("error").textContent = st.last_status && st.last_status !== "ok" ? (st.last_error || "") : "";
}

function load() {
  chrome.storage.local.get(["sender_token", "functions_base", "last_sync_at", "last_status", "last_error", "sender_name", "sender_status"], (st) => {
    $("token").value = st.sender_token || "";
    $("base").value = st.functions_base || "";
    if (st.functions_base) $("advanced").open = true;
    render(st);
  });
}

function save(cb) {
  const sender_token = $("token").value.trim();
  const functions_base = $("base").value.trim().replace(/\/+$/, "");
  chrome.storage.local.set({ sender_token, functions_base, backoff_until: 0 }, () => {
    $("msg").textContent = "Saved.";
    setTimeout(() => { $("msg").textContent = ""; }, 1500);
    chrome.runtime.sendMessage({ type: "ensure-alarms" }, () => void chrome.runtime.lastError);
    if (cb) cb();
  });
}

$("save").addEventListener("click", () => save());

$("sync").addEventListener("click", () => {
  const btn = $("sync");
  btn.disabled = true; btn.textContent = "Syncing…";
  save(() => {
    chrome.runtime.sendMessage({ type: "sync-now" }, (res) => {
      btn.disabled = false; btn.textContent = "Sync now";
      if (chrome.runtime.lastError) { $("msg").textContent = ""; $("error").textContent = chrome.runtime.lastError.message; return; }
      $("msg").textContent = res && res.ok ? "Session synced." : "";
      load();
    });
  });
});

chrome.storage.onChanged.addListener((changes, area) => { if (area === "local") load(); });
load();
