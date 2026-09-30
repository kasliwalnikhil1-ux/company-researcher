/*! GrowthxAI web chat — loader v1 (web-chat-PRD.md §4). MIT-style embed: one script tag, nothing else on page load.
 *
 *   <script>
 *     window.growthxaiSettings = { position: "right", locale: "en" };            // optional
 *     (function(d,t){var g=d.createElement(t),s=d.getElementsByTagName(t)[0];
 *      g.src="https://<app>/widget/v1/loader.js"; g.async=true;
 *      g.dataset.websiteToken="<WEBSITE_TOKEN>"; g.dataset.api="https://<project>.supabase.co/functions/v1/outreach-webchat";
 *      s.parentNode.insertBefore(g,s);})(document,"script");
 *   </script>
 *
 * Responsibilities (nothing more, to stay small):
 *   1. read the script's data-* + window.growthxaiSettings (alias window.kapturedSettings);
 *   2. paint the launcher at once from the cached config (localStorage), refresh the config in the background (2 s timeout);
 *   3. targeting rules, popup nudge, unread badge, online dot;
 *   4. expose the SDK global (window.growthxai, alias window.kaptured) with a call queue until chat.js is loaded;
 *   5. lazy-load chat.js: on first open, on launcher hover, on idle for returning visitors (they may have unread messages).
 * Isolation: closed Shadow DOM, constructable stylesheets (work under a strict style-src CSP), host element pointer-events:none.
 */
(function () {
  "use strict";
  if (window.__growthxaiWebchatLoaded) return;
  window.__growthxaiWebchatLoaded = true;

  var doc = document, win = window;
  var script = doc.currentScript || (function () { var s = doc.getElementsByTagName("script"); return s[s.length - 1]; })();
  var ds = (script && script.dataset) || {};
  var settings = win.growthxaiSettings || win.kapturedSettings || {};
  var token = ds.websiteToken || settings.websiteToken;
  if (!token) return;
  var src = (script && script.src) || "";
  var API = (ds.api || settings.api || "").replace(/\/+$/, "");
  var CHAT_URL = src.replace(/loader\.js(\?.*)?$/, "chat.js$1");
  if (!API) { try { console.warn("[growthxai] data-api missing on the widget script tag"); } catch (e) {} return; }
  var LS = "gxwc:" + token + ":";
  var store = {
    get: function (k) { try { return JSON.parse(localStorage.getItem(LS + k)); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(LS + k); } catch (e) {} }
  };

  // ---- data-* overrides (chatbot-main compatible) --------------------------------------------------------------
  var overrides = {};
  ["mode", "theme", "accent", "position", "locale", "mountSelector", "quickPrompts", "sendUtm", "baseDomain"].forEach(function (k) { if (ds[k] != null) overrides[k] = ds[k]; });
  if (overrides.quickPrompts) overrides.quickPrompts = String(overrides.quickPrompts).split("|").map(function (s) { return s.trim(); }).filter(Boolean);

  // ---- SDK global with a call queue -----------------------------------------------------------------------------
  var listeners = {}, queue = [], panel = null, state = { open: false, unread: 0, identified: false, consent: !(settings.waitForConsent) };
  function emit(ev, data) {
    (listeners[ev] || []).slice().forEach(function (cb) { try { cb(data); } catch (e) {} });
    try { win.dispatchEvent(new CustomEvent("growthxai:" + ev, { detail: data })); win.dispatchEvent(new CustomEvent("kaptured:" + ev, { detail: data })); } catch (e) {}
  }
  function call(name, args) {
    if (panel && panel[name]) return panel[name].apply(panel, args);
    queue.push([name, args]);
    if (name !== "on" && name !== "off" && name !== "setUser" && name !== "setCustomAttributes" && name !== "consent") loadChat();
  }
  var sdk = {
    version: "1.0.0", token: token, settings: settings, overrides: overrides,
    on: function (ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb); return sdk; },
    off: function (ev, cb) { listeners[ev] = (listeners[ev] || []).filter(function (f) { return f !== cb; }); return sdk; },
    emit: emit,
    get isOpen() { return state.open; },
    get mode() { return (panel && panel.mode) || (cfg && effective(cfg).appearance.mode) || "bubble"; },
    getUnreadCount: function () { return state.unread; },
    consent: function (ok) { state.consent = ok !== false; if (state.consent) { store.set("consent", 1); boot(); } else { store.del("consent"); } call("consent", [state.consent]); },
    toggleBubbleVisibility: function (v) { hideLauncher = v === "hide"; renderLauncher(); },
    _loader: { setUnread: setUnread, setOpen: function (o) { state.open = o; renderLauncher(); }, cfg: function () { return cfg; }, store: store, api: API, token: token, emit: emit, effective: function () { return effective(cfg); }, identified: function (v) { state.identified = !!v; renderLauncher(); } }
  };
  ["open", "close", "toggle", "setMode", "send", "setUser", "setCustomAttributes", "deleteCustomAttribute", "setConversationCustomAttributes",
   "deleteConversationCustomAttribute", "setLabel", "removeLabel", "setLocale", "setColorScheme", "trackEvent", "reset", "destroy", "popoutChatWindow", "onRouteChange"]
    .forEach(function (n) { sdk[n] = function () { return call(n, Array.prototype.slice.call(arguments)); }; });
  win.growthxai = sdk; if (!win.kaptured) win.kaptured = sdk;

  // ---- config -----------------------------------------------------------------------------------------------------
  var cfg = null, pendingStart = null, hideLauncher = !!settings.hideMessageBubble, host = null, shadow = null, sheet = null, btn = null, popupEl = null, popupTimer = null;
  function effective(c) {
    // precedence: SDK call > window.growthxaiSettings > data-* > server config > defaults (PRD §4.1)
    var s = c.settings || {}, ap = Object.assign({}, s.appearance), la = Object.assign({}, s.launcher);
    if (overrides.mode) ap.mode = overrides.mode; if (settings.mode) ap.mode = settings.mode;
    if (overrides.theme) ap.theme = overrides.theme; if (settings.darkMode) ap.theme = settings.darkMode;
    if (overrides.accent) ap.accent = overrides.accent;
    if (overrides.position || settings.position) { la.desktop = Object.assign({}, la.desktop, { position: settings.position || overrides.position }); la.mobile = Object.assign({}, la.mobile, { position: settings.position || overrides.position }); }
    if (settings.type === "expanded_bubble") la.desktop = Object.assign({}, la.desktop, { type: "button", text: settings.launcherTitle || la.desktop.text });
    if (settings.launcherTitle) la.desktop = Object.assign({}, la.desktop, { text: settings.launcherTitle });
    if (overrides.mountSelector) { ap.mode = "embedded"; ap.mount_selector = overrides.mountSelector; }
    return Object.assign({}, s, { appearance: ap, launcher: la, messages: Object.assign({}, s.messages, overrides.quickPrompts ? { quick_replies: overrides.quickPrompts } : {},
      settings.welcomeTitle ? { welcome_title: settings.welcomeTitle } : {}, settings.welcomeDescription ? { welcome_tagline: settings.welcomeDescription } : {}) });
  }
  function fetchConfig() {
    var ctl = ("AbortController" in win) ? new AbortController() : null, t = setTimeout(function () { ctl && ctl.abort(); }, 2000);
    return fetch(API + "/config?token=" + encodeURIComponent(token), { signal: ctl ? ctl.signal : undefined }).then(function (r) { clearTimeout(t); return r.ok ? r.json() : null; })
      .then(function (c) { if (c && c.ok) { store.set("cfg", { at: Date.now(), cfg: c }); return c; } if (c && c.error === "inactive") { store.del("cfg"); } return null; })
      .catch(function () { clearTimeout(t); return null; });
  }

  // ---- targeting (PRD §5.10) -----------------------------------------------------------------------------------
  function isMobile() { return win.matchMedia && win.matchMedia("(max-width: 640px)").matches; }
  function urlMatch(rule, url) {
    var v = String(rule.value || ""); if (!v) return false;
    switch (rule.op) {
      case "equals": return url === v || url.replace(/\/$/, "") === v.replace(/\/$/, "");
      case "starts_with": return url.indexOf(v) === 0;
      case "regex": try { return new RegExp(v).test(url); } catch (e) { return false; }
      default: return url.indexOf(v) >= 0;
    }
  }
  function targeted(c) {
    var t = (c.settings && c.settings.targeting) || {}, url = location.href;
    if (t.hide_mobile && isMobile()) return false;
    if (t.hide_desktop && !isMobile()) return false;
    if (t.identified_only && !state.identified) return false;
    if (c.settings && c.settings.features && c.settings.features.hide_outside_hours && c.availability && !c.availability.in_hours) return false;
    var rules = t.url_rules || [], shows = rules.filter(function (r) { return r.action === "show"; }), hides = rules.filter(function (r) { return r.action !== "show"; });
    if (hides.some(function (r) { return urlMatch(r, url); })) return false;
    if (shows.length && !shows.some(function (r) { return urlMatch(r, url); })) return false;
    return true;
  }

  // ---- launcher --------------------------------------------------------------------------------------------------
  var ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  var CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function safeColor(c, d) { return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(c || "")) ? c : d; }
  function css(c) {
    var e = effective(c), l = isMobile() ? Object.assign({}, e.launcher.desktop, e.launcher.mobile) : e.launcher.desktop || {};
    var size = { sm: 48, md: 56, lg: 64 }[l.size] || 56, accent = safeColor(e.appearance.accent, "#4f46e5"), side = l.position === "left" ? "left" : "right";
    return ":host{all:initial}" +
      ".wrap{position:fixed;" + side + ":" + (l.margin_side != null ? l.margin_side : 24) + "px;bottom:" + (l.margin_bottom != null ? l.margin_bottom : 24) + "px;z-index:" + (parseInt(e.appearance.z_index, 10) || 2147483000) + ";display:flex;flex-direction:column;align-items:" + (side === "left" ? "flex-start" : "flex-end") + ";gap:10px;font:14px/1.4 " + (e.appearance.font && e.appearance.font !== "Inter" ? esc(e.appearance.font) + "," : "") + "Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;pointer-events:none}" +
      ".btn{pointer-events:auto;display:inline-flex;align-items:center;justify-content:center;gap:8px;border:0;cursor:pointer;color:#fff;background:" + accent + ";box-shadow:0 8px 24px rgba(0,0,0,.18);transition:transform .18s cubic-bezier(.34,1.56,.64,1),opacity .2s;-webkit-tap-highlight-color:transparent;position:relative;outline-offset:3px}" +
      ".btn:hover{transform:scale(1.05)}.btn:focus-visible{outline:2px solid " + accent + "}" +
      ".btn.icon{width:" + size + "px;height:" + size + "px;border-radius:50%}.btn.icon svg{width:" + Math.round(size * .46) + "px;height:" + Math.round(size * .46) + "px}" +
      ".btn.pill{height:" + Math.max(44, size - 8) + "px;padding:0 18px 0 14px;border-radius:999px;font-weight:600;font-size:15px}.btn.pill svg{width:20px;height:20px}" +
      ".btn img{width:100%;height:100%;object-fit:cover;border-radius:50%}" +
      ".badge{position:absolute;top:-4px;" + side + ":-4px;min-width:20px;height:20px;padding:0 6px;border-radius:10px;background:#ef4444;color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 2px #fff}" +
      ".dot{position:absolute;bottom:2px;" + (side === "left" ? "left" : "right") + ":2px;width:12px;height:12px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 2px #fff}" +
      ".pop{pointer-events:auto;max-width:280px;background:#fff;color:#111;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.16);padding:12px 36px 12px 14px;position:relative;font-size:14px;line-height:1.45;display:flex;gap:10px;align-items:flex-start;animation:gxin .25s ease both}" +
      ".pop img{width:40px;height:40px;border-radius:50%;object-fit:cover;flex:0 0 auto}.pop .x{position:absolute;top:6px;" + (side === "left" ? "left" : "right") + ":auto;right:6px;width:24px;height:24px;border:0;background:transparent;color:#888;cursor:pointer;border-radius:6px}.pop .x:hover{background:#f3f4f6}.pop .x svg{width:14px;height:14px}" +
      ".prev{pointer-events:auto;background:#fff;color:#111;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.14);padding:10px 12px;max-width:280px;font-size:13px;cursor:pointer;animation:gxin .25s ease both}.prev b{display:block;font-size:12px;color:#555;margin-bottom:2px}" +
      "@keyframes gxin{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}" +
      "@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}" +
      "@media(prefers-color-scheme:dark){.pop,.prev{background:#1f2937;color:#f3f4f6}.pop .x{color:#9ca3af}.prev b{color:#9ca3af}}" +
      ".hidden{display:none!important}";
  }
  function applyStyles(text) {
    try {
      if (!sheet && "replaceSync" in CSSStyleSheet.prototype) { sheet = new CSSStyleSheet(); shadow.adoptedStyleSheets = [sheet]; }
      if (sheet) { sheet.replaceSync(text); return; }
    } catch (e) {}
    var st = shadow.querySelector("style") || doc.createElement("style"); st.textContent = text; if (!st.parentNode) shadow.insertBefore(st, shadow.firstChild);
  }
  function mount() {
    if (host) return;
    host = doc.createElement("div"); host.id = "growthxai-webchat"; host.setAttribute("data-growthxai", "launcher");
    host.style.cssText = "position:fixed;inset:auto;width:0;height:0;overflow:visible;pointer-events:none;z-index:2147483000";
    (doc.body || doc.documentElement).appendChild(host);
    shadow = host.attachShadow({ mode: "closed" });
    var wrap = doc.createElement("div"); wrap.className = "wrap"; wrap.setAttribute("part", "wrap"); shadow.appendChild(wrap);
    btn = doc.createElement("button"); btn.type = "button"; wrap.appendChild(btn);
    btn.addEventListener("click", function () { if (state.open) sdk.close(); else sdk.open(); });
    btn.addEventListener("mouseenter", prefetchChat); btn.addEventListener("focus", prefetchChat);
    win.addEventListener("resize", debounce(function () { if (cfg) applyStyles(css(cfg)); }, 200));
  }
  function renderLauncher() {
    if (!cfg) return;
    mount();
    var e = effective(cfg), l = isMobile() ? Object.assign({}, e.launcher.desktop, e.launcher.mobile) : e.launcher.desktop || {};
    applyStyles(css(cfg));
    var show = !hideLauncher && !e.launcher.hide && targeted(cfg) && e.appearance.mode !== "embedded" && !(state.open && (isMobile() || e.appearance.mode !== "bubble"));
    btn.className = "btn " + (l.type === "button" && !isMobile() ? "pill" : "icon") + (show ? "" : " hidden");
    var label = state.open ? (i18n("close")) : (l.text || i18n("chat"));
    btn.setAttribute("aria-label", label); btn.title = label; btn.setAttribute("aria-expanded", state.open ? "true" : "false");
    var inner = state.open ? CLOSE : (e.appearance.logo_url ? '<img src="' + esc(e.appearance.logo_url) + '" alt="">' : ICON);
    if (btn.className.indexOf("pill") >= 0 && !state.open) inner += "<span>" + esc(l.text || i18n("chat")) + "</span>";
    if (!state.open && state.unread > 0 && e.launcher.show_unread_count !== false) inner += '<span class="badge" aria-label="' + state.unread + ' unread">' + (state.unread > 9 ? "9+" : state.unread) + "</span>";
    if (!state.open && e.launcher.online_dot !== false && cfg.availability && cfg.availability.online) inner += '<span class="dot" aria-hidden="true"></span>';
    btn.innerHTML = inner;
    if (state.open || !show) hidePopup();
  }
  function setUnread(n, previews) {
    state.unread = n || 0; renderLauncher();
    var e = effective(cfg || { settings: {} });
    var wrap = shadow && shadow.querySelector(".wrap"); if (!wrap) return;
    Array.prototype.slice.call(wrap.querySelectorAll(".prev")).forEach(function (x) { x.remove(); });
    if (state.open || !previews || !previews.length || e.launcher.show_unread_previews === false || settings.showUnreadMessagesDialog === false) return;
    previews.slice(-2).forEach(function (p) {
      var d = doc.createElement("div"); d.className = "prev"; d.setAttribute("role", "button"); d.tabIndex = 0;
      d.innerHTML = "<b>" + esc(p.from || e.appearance.brand_name || "") + "</b>" + esc(String(p.text || "").slice(0, 140));
      d.addEventListener("click", function () { sdk.open(); });
      wrap.insertBefore(d, btn);
    });
    emit("unread", { count: state.unread });
  }
  // proactive nudge (PRD §5.3): once per session, never after the visitor has chatted
  function schedulePopup() {
    var e = effective(cfg), p = e.popup || {};
    if (!p.enabled || !p.text || store.get("chatted") || sessionStorage.getItem(LS + "pop")) return;
    clearTimeout(popupTimer);
    popupTimer = setTimeout(function () {
      if (state.open || !btn || btn.className.indexOf("hidden") >= 0) return;
      try { sessionStorage.setItem(LS + "pop", "1"); } catch (x) {}
      popupEl = doc.createElement("div"); popupEl.className = "pop"; popupEl.setAttribute("role", "status");
      popupEl.innerHTML = (p.image_url ? '<img src="' + esc(p.image_url) + '" alt="">' : "") + "<div>" + esc(String(p.text).slice(0, 60)) + "</div>" + '<button class="x" type="button" aria-label="' + i18n("dismiss") + '">' + CLOSE + "</button>";
      popupEl.querySelector(".x").addEventListener("click", function (ev) { ev.stopPropagation(); hidePopup(); });
      popupEl.addEventListener("click", function () { hidePopup(); sdk.open({ source: "popup" }); });
      shadow.querySelector(".wrap").insertBefore(popupEl, btn);
    }, Math.max(0, (parseFloat(p.delay_s) || 3) * 1000));
  }
  function hidePopup() { clearTimeout(popupTimer); if (popupEl) { popupEl.remove(); popupEl = null; } }
  var STR = { en: { chat: "Chat with us", close: "Close chat", dismiss: "Dismiss" }, es: { chat: "Chatea con nosotros", close: "Cerrar chat", dismiss: "Cerrar" }, fr: { chat: "Discutez avec nous", close: "Fermer", dismiss: "Fermer" }, de: { chat: "Chatte mit uns", close: "Chat schließen", dismiss: "Schließen" }, pt: { chat: "Fale conosco", close: "Fechar", dismiss: "Fechar" }, hi: { chat: "हमसे चैट करें", close: "चैट बंद करें", dismiss: "हटाएँ" }, ar: { chat: "تحدث معنا", close: "إغلاق", dismiss: "إغلاق" } };
  function locale() {
    var l = settings.locale || overrides.locale; var e = cfg ? effective(cfg) : null;
    if (!l && e && e.locale && e.locale.use_browser !== false) l = (navigator.language || "en").slice(0, 2);
    if (!l && e && e.locale) l = e.locale.default;
    return STR[l] ? l : "en";
  }
  function i18n(k) { return (STR[locale()] || STR.en)[k] || STR.en[k]; }
  function debounce(f, ms) { var t; return function () { clearTimeout(t); t = setTimeout(f, ms); }; }

  // ---- chat.js loading -------------------------------------------------------------------------------------------
  var chatState = 0, chatCbs = [];
  function prefetchChat() {
    if (chatState) return;
    try { var l = doc.createElement("link"); l.rel = "prefetch"; l.as = "script"; l.href = CHAT_URL; doc.head.appendChild(l); } catch (e) {}
  }
  function loadChat(cb) {
    if (cb) chatCbs.push(cb);
    if (chatState === 2) { cb && cb(); return; }
    if (chatState === 1) return;
    chatState = 1;
    var s = doc.createElement("script"); s.src = CHAT_URL; s.async = true;
    s.onload = function () {
      var init = win.__growthxaiWebchatPanel;
      if (!init) { chatState = 0; return; }
      var start = function () {
        panel = init(sdk, cfg, effective(cfg));
        chatState = 2;
        queue.splice(0).forEach(function (q) { try { panel[q[0]] && panel[q[0]].apply(panel, q[1]); } catch (e) {} });
        chatCbs.splice(0).forEach(function (f) { try { f(); } catch (e) {} });
      };
      // open() / send() called before /config answered (a site button, autoOpen): the panel needs the config, so
      // start it when boot() has one; queued calls stay queued until then.
      if (cfg) start(); else pendingStart = start;
    };
    s.onerror = function () { chatState = 0; };
    doc.head.appendChild(s);
  }
  win.__growthxaiWebchatSDK = sdk;

  // ---- SPA route changes (PRD §4.2) -----------------------------------------------------------------------------
  function hookHistory() {
    var fire = debounce(function () { emit("route", { url: location.href }); if (cfg) { renderLauncher(); } call("onRouteChange", [location.href]); }, 50);
    ["pushState", "replaceState"].forEach(function (m) { var orig = history[m]; if (!orig) return; history[m] = function () { var r = orig.apply(this, arguments); fire(); return r; }; });
    win.addEventListener("popstate", fire); win.addEventListener("hashchange", fire);
  }

  // ---- boot -------------------------------------------------------------------------------------------------------
  var booted = false;
  function boot() {
    if (booted || !state.consent) { if (!state.consent && store.get("consent")) { state.consent = true; } else return; }
    booted = true;
    var cached = store.get("cfg");
    if (cached && cached.cfg && Date.now() - cached.at < 7 * 86400000) { cfg = cached.cfg; renderLauncher(); schedulePopup(); }
    fetchConfig().then(function (c) {
      if (c) { var changed = !cfg || cfg.config_version !== c.config_version; cfg = c; renderLauncher(); if (!cached) schedulePopup(); if (panel && panel.configUpdated && changed) panel.configUpdated(c, effective(c)); }
      else if (!cfg) return;
      if (pendingStart) { var ps = pendingStart; pendingStart = null; ps(); }
      emit("ready", { config_version: cfg.config_version });
      // returning visitor: load the panel core early so unread counts + realtime work while closed
      if (store.get("vt") || effective(cfg).appearance.mode === "embedded") { (win.requestIdleCallback || function (f) { setTimeout(f, 1200); })(function () { loadChat(); }); }
      if (settings.autoOpen) sdk.open();
    });
    hookHistory();
  }
  if (settings.waitForConsent && !store.get("consent")) { /* the site calls growthxai.consent(true) */ } else boot();
})();
