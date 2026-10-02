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
 *   3. targeting rules, popup nudge, unread badge, online dot; a GIF / video bubble instead of the icon when the inbox
 *      has one (settings.launcher.video) — that code is video.js, fetched only then;
 *   4. expose the SDK global (window.growthxai, alias window.kaptured) with a call queue until chat.js is loaded;
 *   5. lazy-load chat.js: on first open, on launcher hover, on idle for returning visitors (they may have unread messages);
 *   6. the site's own buttons (web-chat-buttons-products-changes.md §2–§4): data-growthxai="open|close|toggle",
 *      data-growthxai-ask / -prefill (+ -mode, -context, -label), ask-form / ask-input, data-growthxai-unread badges,
 *      links (?gx=open, ?gx_q=, #ask-ai) and the ⌘K / Ctrl+K shortcut. The Ask AI buttons the website's settings place
 *      and Ask AI on selected text are ask.js, fetched only when the settings use them. With "My own buttons"
 *      (launcher.hide) nothing shows or opens by itself.
 *   7. voice (web-chat-voice-elevenlabs-PRD.md §2.1): growthxai.call() and data-growthxai="call" start a voice call with
 *      the assistant; with "Voice first" the launcher says so and opens the panel straight into the call. The call
 *      view and the voice SDK are voice.js, fetched by chat.js when a call starts (prefetched on hover of a call button).
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
  var CHAT_URL = src.replace(/loader\.js(\?.*)?$/, "chat.js$1"), VIDEO_URL = src.replace(/loader\.js(\?.*)?$/, "video.js$1"), ASK_URL = src.replace(/loader\.js(\?.*)?$/, "ask.js$1"), VOICE_URL = src.replace(/loader\.js(\?.*)?$/, "voice.js$1");
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
  var denied = null, warned = {};   // denied: why this site may not use the widget (queued calls are dropped, one warning says why)
  function warn(key, text) { if (warned[key]) return; warned[key] = 1; try { console.warn("[growthxai] " + text); } catch (e) {} }
  function emit(ev, data) {
    (listeners[ev] || []).slice().forEach(function (cb) { try { cb(data); } catch (e) {} });
    try { win.dispatchEvent(new CustomEvent("growthxai:" + ev, { detail: data })); win.dispatchEvent(new CustomEvent("kaptured:" + ev, { detail: data })); } catch (e) {}
  }
  function call(name, args) {
    if (panel && panel[name]) return panel[name].apply(panel, args);
    if (name === "close") return;   // nothing is open yet
    if (denied) { warn("denied", "The chat was not opened: " + denied + "."); return; }
    queue.push([name, args]);
    if (name !== "on" && name !== "off" && name !== "setUser" && name !== "setCustomAttributes" && name !== "consent") loadChat();
  }
  var sdk = {
    version: "1.2.0", token: token, settings: settings, overrides: overrides,
    on: function (ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb); return sdk; },
    off: function (ev, cb) { listeners[ev] = (listeners[ev] || []).filter(function (f) { return f !== cb; }); return sdk; },
    emit: emit,
    get isOpen() { return state.open; },
    get mode() { return (panel && panel.mode) || (cfg && effective(cfg).appearance.mode) || "bubble"; },
    getUnreadCount: function () { return state.unread; },
    consent: function (ok) { state.consent = ok !== false; if (state.consent) { store.set("consent", 1); boot(); } else { store.del("consent"); } call("consent", [state.consent]); },
    toggleBubbleVisibility: function (v) { hideLauncher = v === "hide"; renderLauncher(); },
    _loader: { setUnread: setUnread, setOpen: setOpen, cfg: function () { return cfg; }, store: store, api: API, token: token, emit: emit, effective: function () { return effective(cfg); }, identified: function (v) { state.identified = !!v; renderLauncher(); },
      keys: true,   // ⌘K / Ctrl+K is bound here, in every shell: the panel does not bind it again
      voiceUrl: VOICE_URL,
      video: { available: function () { return videoAvailable(); }, show: function () { showVideo(); } } }   // the panel menu's "Watch video"
  };
  ["open", "close", "toggle", "ask", "call", "setMode", "send", "setUser", "setCustomAttributes", "deleteCustomAttribute", "setConversationCustomAttributes",
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
    if (/^preset:[\w.-]+$/i.test(ap.bot_avatar_url || "")) ap.bot_avatar_url = src.replace(/loader\.js(\?.*)?$/, "avatars/") + ap.bot_avatar_url.slice(7);   // built-in avatars ship next to this file
    return Object.assign({}, s, { appearance: ap, launcher: la, messages: Object.assign({}, s.messages, overrides.quickPrompts ? { quick_replies: overrides.quickPrompts } : {},
      settings.welcomeTitle ? { welcome_title: settings.welcomeTitle } : {}, settings.welcomeDescription ? { welcome_tagline: settings.welcomeDescription } : {}) });
  }
  // null = no answer in time (the cached config, if any, keeps the widget going); a refusal sets `denied`
  function fetchConfig(ms) {
    var ctl = ("AbortController" in win) ? new AbortController() : null, t = setTimeout(function () { ctl && ctl.abort(); }, ms || 2000);
    return fetch(API + "/config?token=" + encodeURIComponent(token), { signal: ctl ? ctl.signal : undefined })
      .then(function (r) { clearTimeout(t); if (r.status === 403) { denied = "this domain is not in the website's allowed domains"; return null; } if (r.status === 404) { denied = "the website token is unknown"; return null; } return r.ok ? r.json() : null; })
      .then(function (c) { if (c && c.ok) { denied = null; store.set("cfg", { at: Date.now(), cfg: c }); return c; } if (c && c.error === "inactive") denied = "the widget is switched off for this website"; if (denied) store.del("cfg"); return null; })
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
  // "hide" rules always win; with any "show" rule only matching pages pass
  function rulesOk(rules, url) {
    rules = rules || [];
    var shows = rules.filter(function (r) { return r.action === "show"; }), hides = rules.filter(function (r) { return r.action !== "show"; });
    if (hides.some(function (r) { return urlMatch(r, url); })) return false;
    return !shows.length || shows.some(function (r) { return urlMatch(r, url); });
  }
  function targeted(c) {
    var t = (c.settings && c.settings.targeting) || {};
    if (t.hide_mobile && isMobile()) return false;
    if (t.hide_desktop && !isMobile()) return false;
    if (t.identified_only && !state.identified) return false;
    if (c.settings && c.settings.features && c.settings.features.hide_outside_hours && c.availability && !c.availability.in_hours) return false;
    return rulesOk(t.url_rules, location.href);
  }

  // ---- launcher --------------------------------------------------------------------------------------------------
  var ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  var CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  var MIC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function safeColor(c, d) { return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(c || "")) ? c : d; }
  function css(c) {
    var e = effective(c), l = isMobile() ? Object.assign({}, e.launcher.desktop, e.launcher.mobile) : e.launcher.desktop || {};
    var size = { sm: 48, md: 56, lg: 64 }[l.size] || 56, accent = safeColor(e.appearance.accent, "#4f46e5"), side = l.position === "left" ? "left" : "right";
    return ":host{all:initial}" +
      ".wrap{position:fixed;" + side + ":" + (l.margin_side != null ? l.margin_side : 24) + "px;bottom:" + (l.margin_bottom != null ? l.margin_bottom : 24) + "px;z-index:" + (parseInt(e.appearance.z_index, 10) || 2147483000) + ";display:flex;flex-direction:column;align-items:" + (side === "left" ? "flex-start" : "flex-end") + ";gap:10px;font:14px/1.4 " + (e.appearance.font && e.appearance.font !== "Inter" ? esc(e.appearance.font) + "," : "") + "Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;pointer-events:none}" +
      ".btn{pointer-events:auto;display:inline-flex;align-items:center;justify-content:center;gap:8px;border:0;cursor:pointer;color:#fff;background:" + accent + ";box-shadow:0 8px 24px rgba(0,0,0,.18);transition:transform .18s cubic-bezier(.34,1.56,.64,1),opacity .2s;-webkit-tap-highlight-color:transparent;position:relative;outline-offset:3px}" +
      ".btn:hover{transform:scale(1.05)}.btn:focus-visible{outline:2px solid " + accent + "}" +
      ".btn.icon{width:" + size + "px;height:" + size + "px;padding:0;border-radius:50%}.btn.icon svg{width:" + Math.round(size * .46) + "px;height:" + Math.round(size * .46) + "px}" +
      ".btn.pill{height:" + Math.max(44, size - 8) + "px;padding:0 18px 0 14px;border-radius:999px;font-weight:600;font-size:15px}.btn.pill svg{width:20px;height:20px}" +
      // a logo keeps its own proportions: it is fitted whole into the launcher, never cropped or squeezed
      ".btn img{display:block;flex:0 0 auto;width:100%;height:100%;min-width:0;object-fit:contain;border-radius:50%}.btn.pill img{width:auto;height:28px;max-width:84px;border-radius:6px}" +
      ".badge{position:absolute;top:-4px;" + side + ":-4px;min-width:20px;height:20px;padding:0 6px;border-radius:10px;background:#ef4444;color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 2px #fff}" +
      ".dot{position:absolute;bottom:2px;" + (side === "left" ? "left" : "right") + ":2px;width:12px;height:12px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 2px #fff}" +
      ".pop{pointer-events:auto;max-width:280px;background:#fff;color:#111;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.16);padding:12px 36px 12px 14px;position:relative;font-size:14px;line-height:1.45;display:flex;gap:10px;align-items:flex-start;animation:gxin .25s ease both}" +
      ".pop img{width:40px;height:40px;border-radius:50%;object-fit:cover;flex:0 0 auto}.pop .x{position:absolute;top:6px;" + (side === "left" ? "left" : "right") + ":auto;right:6px;width:24px;height:24px;border:0;background:transparent;color:#888;cursor:pointer;border-radius:6px}.pop .x:hover{background:#f3f4f6}.pop .x svg{width:14px;height:14px}" +
      ".prev{pointer-events:auto;background:#fff;color:#111;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.14);padding:10px 12px;max-width:280px;font-size:13px;cursor:pointer;animation:gxin .25s ease both}.prev b{display:block;font-size:12px;color:#555;margin-bottom:2px}" +
      "@keyframes gxin{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}" +
      "@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}" +
      "@media(prefers-color-scheme:dark){.pop,.prev{background:#1f2937;color:#f3f4f6}.pop .x{color:#9ca3af}.prev b{color:#9ca3af}}" +
      (vmod ? vmod.css(e, l, side, accent) : "") +
      ".hidden{display:none!important}";
  }
  function adopt(root, text, keep) {
    try {
      if ("replaceSync" in CSSStyleSheet.prototype) { var sh = keep || new CSSStyleSheet(); sh.replaceSync(text); if (!keep) root.adoptedStyleSheets = [sh]; return sh; }
    } catch (e) {}
    var st = root.querySelector("style") || doc.createElement("style"); st.textContent = text; if (!st.parentNode) root.insertBefore(st, root.firstChild);
    return null;
  }
  function applyStyles(text) { sheet = adopt(shadow, text, sheet); }
  function mount() {
    if (host) return;
    host = doc.createElement("div"); host.id = "growthxai-webchat"; host.setAttribute("data-growthxai", "launcher");
    host.style.cssText = "position:fixed;inset:auto;width:0;height:0;overflow:visible;pointer-events:none;z-index:2147483000";
    (doc.body || doc.documentElement).appendChild(host);
    shadow = host.attachShadow({ mode: "closed" });
    var wrap = doc.createElement("div"); wrap.className = "wrap"; wrap.setAttribute("part", "wrap"); shadow.appendChild(wrap);
    btn = doc.createElement("button"); btn.type = "button"; wrap.appendChild(btn);
    btn.addEventListener("click", function () { if (state.open) sdk.close(); else if (voiceFirst()) sdk.call({ source: "voice" }); else sdk.open(); });
    btn.addEventListener("mouseenter", function () { prefetchChat(); if (voiceFirst()) prefetchVoice(); }); btn.addEventListener("focus", prefetchChat);
    win.addEventListener("resize", debounce(function () { if (cfg) applyStyles(css(cfg)); }, 200));
  }
  // "My own buttons" (launcher.hide): no launcher, video bubble, popup nudge or unread previews; the chat opens only
  // from the site's own buttons and links.
  function ownButtons() { return !!(cfg && effective(cfg).launcher.hide); }
  // Voice: can this browser take a call, and does the website want the launcher to lead with it ("Voice first")?
  function voiceCfg() { var v = cfg && effective(cfg).voice; return v && v.enabled && navigator.mediaDevices && win.RTCPeerConnection && win.isSecureContext !== false ? v : null; }
  function voiceFirst() { var v = voiceCfg(); return !!(v && ((v.ui || {}).show_on || {}).launcher === true); }
  var voicePre = 0;
  function prefetchVoice() { if (voicePre) return; voicePre = 1; try { var l = doc.createElement("link"); l.rel = "prefetch"; l.as = "script"; l.href = VOICE_URL; doc.head.appendChild(l); } catch (e) {} }
  function renderLauncher() {
    if (!cfg) return;
    mount();
    var e = effective(cfg), l = isMobile() ? Object.assign({}, e.launcher.desktop, e.launcher.mobile) : e.launcher.desktop || {};
    applyStyles(css(cfg));
    var mode = (panel && panel.mode) || e.appearance.mode;   // a button may have opened the chat in another shell
    var show = !hideLauncher && !e.launcher.hide && targeted(cfg) && e.appearance.mode !== "embedded" && !(state.open && (isMobile() || mode !== "bubble"));
    var vc = show && !state.open ? vconf(e) : null; if (vc && !vmod) loadVideo();
    var video = vmod ? vmod.render(vc) : !!vc;   // while video.js is on its way the icon stays hidden, so it does not flash
    btn.className = "btn " + (l.type === "button" && !isMobile() ? "pill" : "icon") + (show && !video ? "" : " hidden");
    var vf = !state.open && voiceFirst(), vtext = vf ? String((voiceCfg().ui || {}).start_text || "").slice(0, 40) || i18n("talk") : "";
    var label = state.open ? (i18n("close")) : vf ? vtext : (l.text || i18n("chat"));
    btn.setAttribute("aria-label", label); btn.title = label; btn.setAttribute("aria-expanded", state.open ? "true" : "false");
    var inner = state.open ? CLOSE : vf ? MIC : (e.appearance.logo_url ? '<img src="' + esc(e.appearance.logo_url) + '" alt="">' : ICON);
    if (btn.className.indexOf("pill") >= 0 && !state.open) inner += "<span>" + esc(vf ? vtext : l.text || i18n("chat")) + "</span>";
    if (!state.open && state.unread > 0 && e.launcher.show_unread_count !== false) inner += '<span class="badge" aria-label="' + state.unread + ' unread">' + (state.unread > 9 ? "9+" : state.unread) + "</span>";
    if (!state.open && e.launcher.online_dot !== false && cfg.availability && cfg.availability.online) inner += '<span class="dot" aria-hidden="true"></span>';
    btn.innerHTML = inner;
    if (state.open || !show) hidePopup();
  }
  function setOpen(o) {
    state.open = !!o; renderLauncher();
    try { doc.documentElement.classList.toggle("growthxai-open", state.open); } catch (e) {}
    syncPage(); hideChip();
  }

  // ---- GIF / video bubble (settings.launcher.video; see video.js) ----------------------------------------------------
  var vmod = null, vstate = 0;   // vstate: 0 not requested, 1 requested, 2 unusable (script or media failed) -> normal launcher
  function sess(k, v) { try { if (v === undefined) return sessionStorage.getItem(LS + k); sessionStorage.setItem(LS + k, v); } catch (x) {} return null; }
  function vclip(e) { var v = (e.launcher || {}).video; return v && v.enabled !== false && vstate !== 2 && /^(https:\/\/\S+|preset:[\w.-]+)$/i.test(v.url || "") ? v : null; }
  function vconf(e) { return sess("vbx") ? null : vclip(e); }
  // The X on the bubble hides it for the session; "Watch video" in the panel menu brings it back, expanded.
  var vwant = false;
  function videoAvailable() { if (!cfg) return false; var e = effective(cfg); return !!vclip(e) && !hideLauncher && !e.launcher.hide && targeted(cfg) && e.appearance.mode !== "embedded"; }
  function showVideo() {
    try { sessionStorage.removeItem(LS + "vbx"); } catch (x) {}
    vwant = true;
    if (state.open) sdk.close(); else renderLauncher();   // the bubble only shows while the panel is closed
    vexpand();
  }
  function vexpand() { if (!vwant || !vmod) return; vwant = false; if (vmod.node()) setTimeout(function () { if (vmod.open && !state.open) vmod.open(); }, 0); }   // after the click that asked for it has finished bubbling
  function loadVideo() {
    if (vstate) return; vstate = 1;
    var s = doc.createElement("script"); s.src = VIDEO_URL; s.async = true;
    s.onload = function () {
      var f = win.__growthxaiWebchatVideo;
      if (f) vmod = f({ sdk: sdk, emit: emit, store: store, esc: esc, safeColor: safeColor, isMobile: isMobile, i18n: i18n, locale: locale, ICON: ICON, CLOSE: CLOSE, base: src.replace(/loader\.js(\?.*)?$/, ""),
        prefetchChat: prefetchChat, hidePopup: hidePopup, host: function () { return host; }, wrap: function () { return shadow.querySelector(".wrap"); }, btn: function () { return btn; },
        unread: function () { return effective(cfg).launcher.show_unread_count !== false ? state.unread : 0; },
        fail: function () { vstate = 2; renderLauncher(); },
        dismiss: function () { sess("vbx", "1"); emit("video:dismissed", {}); renderLauncher(); btn.focus(); } });   // X on the bubble: gone for this browser session
      else vstate = 2;
      renderLauncher(); vexpand();
    };
    s.onerror = function () { vstate = 2; renderLauncher(); };
    doc.head.appendChild(s);
  }
  function anchor() { return (vmod && vmod.node()) || btn; }   // what the popup and the unread previews sit above
  function setUnread(n, previews) {
    var was = state.unread;
    state.unread = n || 0; renderLauncher(); syncPage();
    if (state.unread !== was) emit("unread", { count: state.unread });
    var e = effective(cfg || { settings: {} });
    var wrap = shadow && shadow.querySelector(".wrap"); if (!wrap) return;
    Array.prototype.slice.call(wrap.querySelectorAll(".prev")).forEach(function (x) { x.remove(); });
    if (state.open || !previews || !previews.length || e.launcher.hide || e.launcher.show_unread_previews === false || settings.showUnreadMessagesDialog === false) return;
    previews.slice(-2).forEach(function (p) {
      var d = doc.createElement("div"); d.className = "prev"; d.setAttribute("role", "button"); d.tabIndex = 0;
      d.innerHTML = "<b>" + esc(p.from || e.appearance.brand_name || "") + "</b>" + esc(String(p.text || "").slice(0, 140));
      d.addEventListener("click", function () { sdk.open(); });
      wrap.insertBefore(d, anchor());
    });
  }
  // proactive nudge (PRD §5.3): once per session, never after the visitor has chatted
  function schedulePopup() {
    var e = effective(cfg), p = e.popup || {};
    if (!p.enabled || !p.text || e.launcher.hide || store.get("chatted") || sess("pop")) return;
    clearTimeout(popupTimer);
    popupTimer = setTimeout(function () {
      if (state.open || !btn || (vmod && vmod.isOpen()) || /hidden/.test(anchor().className)) return;
      sess("pop", "1");
      popupEl = doc.createElement("div"); popupEl.className = "pop"; popupEl.setAttribute("role", "status");
      popupEl.innerHTML = (p.image_url ? '<img src="' + esc(p.image_url) + '" alt="">' : "") + "<div>" + esc(String(p.text).slice(0, 60)) + "</div>" + '<button class="x" type="button" aria-label="' + i18n("dismiss") + '">' + CLOSE + "</button>";
      popupEl.querySelector(".x").addEventListener("click", function (ev) { ev.stopPropagation(); hidePopup(); });
      popupEl.addEventListener("click", function () { hidePopup(); sdk.open({ source: "popup" }); });
      shadow.querySelector(".wrap").insertBefore(popupEl, anchor());
    }, Math.max(0, (parseFloat(p.delay_s) || 3) * 1000));
  }
  function hidePopup() { clearTimeout(popupTimer); if (popupEl) { popupEl.remove(); popupEl = null; } }
  var STR = { en: { talk: "Talk to us", chat: "Chat with us", close: "Close chat", dismiss: "Dismiss", more: "Learn more", lang: "Video language" }, es: { talk: "Habla con nosotros", chat: "Chatea con nosotros", close: "Cerrar chat", dismiss: "Cerrar", more: "Más información", lang: "Idioma del vídeo" }, fr: { talk: "Parlez-nous", chat: "Discutez avec nous", close: "Fermer", dismiss: "Fermer", more: "En savoir plus", lang: "Langue de la vidéo" }, de: { talk: "Sprich mit uns", chat: "Chatte mit uns", close: "Chat schließen", dismiss: "Schließen", more: "Mehr erfahren", lang: "Videosprache" }, pt: { talk: "Fale conosco por voz", chat: "Fale conosco", close: "Fechar", dismiss: "Fechar", more: "Saiba mais", lang: "Idioma do vídeo" }, hi: { talk: "हमसे बात करें", chat: "हमसे चैट करें", close: "चैट बंद करें", dismiss: "हटाएँ", more: "और जानें", lang: "वीडियो की भाषा" }, ar: { talk: "تحدث إلينا", chat: "تحدث معنا", close: "إغلاق", dismiss: "إغلاق", more: "اعرف المزيد", lang: "لغة الفيديو" } };
  function locale() {
    var l = settings.locale || overrides.locale; var e = cfg ? effective(cfg) : null;
    if (!l && e && e.locale && e.locale.use_browser !== false) l = (navigator.language || "en").slice(0, 2);
    if (!l && e && e.locale) l = e.locale.default;
    return STR[l] ? l : "en";
  }
  function i18n(k) { return (STR[locale()] || STR.en)[k] || STR.en[k]; }
  function debounce(f, ms) { var t; return function () { clearTimeout(t); t = setTimeout(f, ms); }; }

  // ---- the site's own buttons, inputs and links (web-chat-buttons-products-changes.md §2, §3) -----------------------
  var MODES = ["bubble", "drawer", "sidebar", "modal", "inline"];
  // Every way of opening the chat goes through here. kind: button | ask | input | link | header_button | element_button |
  // selection | shortcut. o: { act: open | close | toggle | ask, text, prefill, context, mode, label }.
  function trigger(kind, o) {
    if (o.act === "close" || (o.act === "toggle" && state.open)) { sdk.close(); return; }
    emit("trigger", o.text ? { kind: kind, text: o.text } : { kind: kind });   // before the chat opens
    if (o.act === "call") { if (o.label) sdk.setLabel(String(o.label).slice(0, 60)); sdk.call({ source: "voice", mode: MODES.indexOf(o.mode) >= 0 ? o.mode : undefined }); return; }
    var mode = MODES.indexOf(o.mode) >= 0 ? o.mode : undefined, source = kind === "shortcut" ? "launcher" : kind;
    if (o.label) sdk.setLabel(String(o.label).slice(0, 60));
    if (o.text) sdk.ask(o.text, { context: o.context || undefined, mode: mode, prefill: !!o.prefill, source: source });
    else sdk.open({ mode: mode, source: source, context: o.context || undefined });
  }
  function dat(el, n) { var v = el.getAttribute("data-growthxai" + n); return v == null ? "" : v; }
  function withOpts(el, o) { o.context = dat(el, "-context").slice(0, 500); o.mode = dat(el, "-mode"); o.label = dat(el, "-label"); return o; }
  doc.addEventListener("click", function (ev) {
    if (ev.defaultPrevented || ev.button) return;   // the page's own handler wins
    var t = ev.target, el = t && t.closest && t.closest('[data-growthxai],[data-growthxai-ask],[data-growthxai-prefill],a[href="#ask-ai"]');
    if (!el) return;
    var v = dat(el, ""), ask = dat(el, "-ask").trim(), pre = dat(el, "-prefill"), o = null, kind = "button";
    if (ask) { o = { act: "ask", text: ask }; kind = "ask"; }
    else if (pre.trim()) { o = { act: "ask", text: pre, prefill: true }; kind = "ask"; }
    else if (v === "open" || v === "close" || v === "toggle" || v === "call") o = { act: v };
    else if (el.tagName === "A" && el.getAttribute("href") === "#ask-ai") { o = { act: "open" }; kind = "link"; }
    if (!o) return;   // our own hosts (launcher, panel) and ask-form / ask-input carry the attribute too
    var inner = t.closest("a[href],button,input,select,textarea");
    if (inner && inner !== el && el.contains(inner)) return;   // a link or control of the page inside the element keeps its own job
    var nav = el.closest("a[href],button,input");   // a link would navigate and a submit button would submit: we handle the click instead
    if (nav && (nav.tagName === "A" || (nav.form && /^(submit|image)$/.test(nav.type)))) ev.preventDefault();
    trigger(kind, withOpts(el, o));
  });
  // a call button under the pointer: voice.js is on its way before the click
  doc.addEventListener("mouseover", function (ev) { var t = ev.target; if (!voicePre && t && t.closest && t.closest('[data-growthxai="call"]') && voiceCfg()) prefetchVoice(); }, { passive: true });
  doc.addEventListener("submit", function (ev) {
    var f = ev.target;
    if (ev.defaultPrevented || !f || !f.getAttribute || f.getAttribute("data-growthxai") !== "ask-form") return;
    ev.preventDefault();   // the page does not submit
    var inp = f.querySelector('input:not([type]),input[type=text],input[type=search],textarea'), q = inp ? String(inp.value || "").trim() : "";
    if (!q) { if (inp) inp.focus(); return; }
    inp.value = "";
    trigger("input", withOpts(f, { act: "ask", text: q }));
  });
  function shortcutOn() { if (!cfg) return false; var e = effective(cfg), s = e.shortcut || {}; return s.enabled === true || (s.enabled == null && e.appearance.mode === "modal"); }
  doc.addEventListener("keydown", function (ev) {
    var t = ev.target;
    if (ev.key === "Escape") hideChip();
    if (ev.defaultPrevented) return;   // e.g. the page's own ⌘K
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing && t && t.getAttribute && t.getAttribute("data-growthxai") === "ask-input") {
      var q = String(t.value || "").trim(); if (!q) return;
      ev.preventDefault(); t.value = "";
      trigger("input", withOpts(t, { act: "ask", text: q }));
    } else if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && !ev.shiftKey && String(ev.key).toLowerCase() === "k" && shortcutOn()) {
      ev.preventDefault(); ev.stopImmediatePropagation();   // a chat.js from before this file bound ⌘K itself in the modal shell
      trigger("shortcut", { act: "toggle" });
    }
  });
  // The page's own badge and buttons: the unread count, aria state.
  function each(sel, f) { try { Array.prototype.forEach.call(doc.querySelectorAll(sel), f); } catch (e) {} }
  function syncPage() {
    var n = state.unread, t = n > 0 ? String(n) : "", ex = state.open ? "true" : "false";
    each("[data-growthxai-unread]", function (b) {
      if (b.textContent !== t) b.textContent = t;
      if (b.getAttribute("data-count") !== String(n)) b.setAttribute("data-count", n);
      if (n > 0) b.removeAttribute("hidden"); else if (!b.hasAttribute("hidden")) b.setAttribute("hidden", "");
    });
    each('[data-growthxai="open"],[data-growthxai="toggle"],[data-growthxai="call"]', function (b) { if (b.getAttribute("aria-expanded") !== ex) b.setAttribute("aria-expanded", ex); if (!b.hasAttribute("aria-haspopup")) b.setAttribute("aria-haspopup", "dialog"); });
  }
  // Links: ?gx=open opens the chat, ?gx_q=… opens it with the question in the box (never sent: a link must not speak
  // for the visitor), #ask-ai opens it. The parameters leave the address bar, so a refresh or a shared link does not reopen.
  var linkTrigger = null, dbg = !!sess("dbg");
  (function () {
    try {
      var u = new URL(location.href), p = u.searchParams, q = (p.get("gx_q") || "").trim().slice(0, 300);
      if (p.get("gx_debug") === "1") { dbg = true; sess("dbg", "1"); }   // "Test on my site": for this tab only
      if (q) linkTrigger = { act: "ask", text: q, prefill: true }; else if (p.get("gx") === "open" || u.hash === "#ask-ai") linkTrigger = { act: "open" };
      if (p.has("gx") || p.has("gx_q") || u.hash === "#ask-ai") {
        p.delete("gx"); p.delete("gx_q"); if (u.hash === "#ask-ai") u.hash = "";
        history.replaceState(history.state, "", u.pathname + u.search + u.hash);
      }
    } catch (e) {}
  })();

  // ---- Ask AI buttons the website's settings place + Ask AI on selected text (§4.1, §4.2; see ask.js) ------------------
  // That code is ask.js, fetched only when the settings have a button or the selection chip on.
  var amod = null, astate = 0;   // astate: 0 not requested, 1 requested, 2 failed
  function askWanted() { if (!cfg) return false; var e = effective(cfg); return (e.ask_buttons || []).length > 0 || !!(e.selection_ask || {}).enabled; }
  function place() {
    if (amod) { amod.place(); return; }
    if (astate || !askWanted()) return;
    astate = 1;
    var s = doc.createElement("script"); s.src = ASK_URL; s.async = true;
    s.onload = function () {
      var f = win.__growthxaiWebchatAsk;
      if (!f) { astate = 2; return; }
      amod = f({ cfg: function () { return cfg; }, effective: function () { return effective(cfg); }, trigger: trigger, esc: esc, safeColor: safeColor, adopt: adopt, rulesOk: rulesOk,
        debounce: debounce, prefetchChat: prefetchChat, debug: function () { return dbg; },
        warn: function (key, text, info) { if (warned[key]) return; warned[key] = 1; try { console[info ? "log" : "warn"]("[growthxai] " + text); } catch (e) {} } });
      amod.place();
    };
    s.onerror = function () { astate = 2; };
    doc.head.appendChild(s);
  }
  function hideChip() { if (amod) amod.hideChip(); }
  // Single-page apps re-render: look again half a second after the page changed (elements added later, re-rendered targets).
  var mo = null, moT = 0;
  function watch() {
    if (mo || !("MutationObserver" in win)) return;
    mo = new MutationObserver(function () { if (!moT) moT = setTimeout(function () { moT = 0; place(); syncPage(); }, 500); });
    mo.observe(doc.documentElement, { childList: true, subtree: true });
  }
  // everything on the page that depends on the config: called when it arrives, when it changes and on a route change
  function applyPage() { place(); syncPage(); watch(); }

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
    var fire = debounce(function () { emit("route", { url: location.href }); if (cfg) { renderLauncher(); place(); } call("onRouteChange", [location.href]); }, 50);
    ["pushState", "replaceState"].forEach(function (m) { var orig = history[m]; if (!orig) return; history[m] = function () { var r = orig.apply(this, arguments); fire(); return r; }; });
    win.addEventListener("popstate", fire); win.addEventListener("hashchange", fire);
  }

  // ---- boot -------------------------------------------------------------------------------------------------------
  var booted = false;
  // The site may not use the widget (domain not allowed, widget off): what was painted from the cache goes, queued
  // clicks are dropped, and one console line says why.
  function refuse() {
    cfg = null; pendingStart = null;
    if (host) host.style.display = "none";
    if (amod) amod.clear();
    if (queue.some(function (q) { return q[0] === "open" || q[0] === "ask" || q[0] === "toggle" || q[0] === "send"; })) warn("denied", "The chat was not opened: " + denied + ".");
    queue.length = 0;
  }
  function boot() {
    if (booted || !state.consent) { if (!state.consent && store.get("consent")) { state.consent = true; } else return; }
    booted = true;
    var cached = store.get("cfg");
    if (cached && cached.cfg && Date.now() - cached.at < 7 * 86400000) { cfg = cached.cfg; renderLauncher(); schedulePopup(); applyPage(); }
    var got = function (c) {
      if (denied) { refuse(); return; }
      if (c) { var changed = !cfg || cfg.config_version !== c.config_version; cfg = c; renderLauncher(); applyPage(); if (!cached) schedulePopup(); if (panel && panel.configUpdated && changed) panel.configUpdated(c, effective(c)); }
      else if (!cfg) {
        // no answer in time and nothing cached: a visitor who already clicked a button is waiting, so ask once more, patiently
        if ((queue.length || pendingStart) && !got.again) { got.again = 1; fetchConfig(10000).then(got); }
        return;
      }
      if (pendingStart) { var ps = pendingStart; pendingStart = null; ps(); }
      emit("ready", { config_version: cfg.config_version });
      // returning visitor: load the panel core early so unread counts + realtime work while closed
      if (store.get("vt") || effective(cfg).appearance.mode === "embedded") { (win.requestIdleCallback || function (f) { setTimeout(f, 1200); })(function () { loadChat(); }); }
      if (settings.autoOpen) sdk.open();
    };
    fetchConfig().then(got);
    hookHistory();
  }
  if (linkTrigger) trigger("link", linkTrigger);   // queued until the config says this site may use the widget
  if (settings.waitForConsent && !store.get("consent")) { /* the site calls growthxai.consent(true) */ } else boot();
})();
