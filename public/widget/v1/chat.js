/*! GrowthxAI web chat — panel v1 (web-chat-PRD.md §5, §6, §13). Loaded by loader.js on first open (or on idle for
 * returning visitors). No dependencies. Everything renders inside a closed Shadow DOM; the only globals are
 * window.growthxai (+ alias window.kaptured) and window.__growthxaiWebchatPanel (the factory the loader calls).
 *
 * Message engine: one conversation open at a time; messages arrive over Supabase Realtime (public capability topic
 * webchat:<conversation>:<stream_key>, a tiny Phoenix-protocol client below) with long-polling every 5 s as fallback;
 * sends are optimistic with an echo_id and queue locally while offline; other tabs sync through BroadcastChannel.
 */
(function () {
  "use strict";
  if (window.__growthxaiWebchatPanel) return;

  // ---------------------------------------------------------------- i18n --------------------------------------------
  var STR = {
    en: { chat: "Chat with us", close: "Close", send: "Send", placeholder: "Type a message…", start: "Start a conversation", cont: "Continue conversation", newconv: "New conversation", prev: "Previous conversations", online: "We're online", offline: "We're away at the moment", minutes: "Replies in a few minutes", hours: "Replies in a few hours", day: "Replies within a day", back_at: "We're away — back {when}", tomorrow: "tomorrow", soon: "We'll reply as soon as we can", ai: "AI", you: "You", talk: "Talk to a person", sources: "Sources", helpful: "Helpful", nothelpful: "Not helpful", thanks: "Thanks for your feedback", retry: "Retry", failed: "Not sent", sent: "Sent", read: "Read", typing: "{name} is typing…", closed: "This conversation is closed — start a new one", end: "End conversation", ended: "Conversation ended", rate: "How was this conversation?", comment: "Tell us more (optional)", submit: "Submit", rated: "Thanks for your rating", email_ph: "you@example.com", name_ph: "Your name", phone_ph: "+1 555 0100", required: "Required", invalid_email: "Enter a valid email", invalid_phone: "Enter a valid phone number", transcript: "Email me this conversation", transcript_sent: "Transcript sent", transcript_email: "Where should we send it?", sound_on: "Sound on", sound_off: "Sound off", popout: "Open in a new window", attach: "Attach a file", emoji: "Add an emoji", too_large: "File too large (max {mb} MB)", bad_type: "This file type is not allowed", limit: "Messages can be up to 5,000 characters", rate_limited: "You're sending too fast — try again in a moment", verify_failed: "We couldn't confirm you're not a robot. Please try again.", error: "Something went wrong. Please try again.", offline_q: "You're offline — we'll send this when you're back", today: "Today", yesterday: "Yesterday", powered: "Powered by", brand: "GrowthxAI", back: "Back", menu: "Menu", ai_note: "Answers by AI assistant. Ask for a person any time.", handoff: "Connecting you with a person…", copy: "Copy", copied: "Copied", download: "Download", consent_err: "Please accept to continue", campaign_reply: "Reply", closepanel: "Close chat", team: "Team" },
    hi: { chat: "हमसे चैट करें", send: "भेजें", placeholder: "संदेश लिखें…", start: "बातचीत शुरू करें", cont: "बातचीत जारी रखें", newconv: "नई बातचीत", prev: "पिछली बातचीत", online: "हम ऑनलाइन हैं", offline: "हम अभी उपलब्ध नहीं हैं", minutes: "आमतौर पर कुछ मिनटों में जवाब", hours: "आमतौर पर कुछ घंटों में जवाब", day: "आमतौर पर एक दिन में जवाब", back_at: "हम बाहर हैं — {when} वापस", tomorrow: "कल", soon: "हम जल्द ही जवाब देंगे", you: "आप", talk: "किसी व्यक्ति से बात करें", sources: "स्रोत", helpful: "उपयोगी", nothelpful: "उपयोगी नहीं", thanks: "आपकी प्रतिक्रिया के लिए धन्यवाद", retry: "फिर कोशिश करें", failed: "नहीं भेजा गया", closed: "यह बातचीत बंद है — नई शुरू करें", end: "बातचीत समाप्त करें", rate: "यह बातचीत कैसी रही?", comment: "और बताएं (वैकल्पिक)", submit: "भेजें", rated: "रेटिंग के लिए धन्यवाद", required: "आवश्यक", invalid_email: "सही ईमेल दर्ज करें", transcript: "यह बातचीत ईमेल करें", error: "कुछ गलत हो गया। फिर कोशिश करें।", today: "आज", yesterday: "कल", handoff: "आपको एक व्यक्ति से जोड़ रहे हैं…", back: "वापस" },
    es: { chat: "Chatea con nosotros", send: "Enviar", placeholder: "Escribe un mensaje…", start: "Iniciar conversación", cont: "Continuar conversación", newconv: "Nueva conversación", prev: "Conversaciones anteriores", online: "Estamos en línea", offline: "No estamos disponibles ahora", minutes: "Suele responder en unos minutos", hours: "Suele responder en unas horas", day: "Suele responder en un día", back_at: "Volvemos {when}", tomorrow: "mañana", soon: "Responderemos lo antes posible", you: "Tú", talk: "Hablar con una persona", sources: "Fuentes", helpful: "Útil", nothelpful: "No útil", thanks: "Gracias por tu opinión", retry: "Reintentar", failed: "No enviado", closed: "Esta conversación está cerrada — inicia una nueva", end: "Terminar conversación", rate: "¿Cómo fue esta conversación?", comment: "Cuéntanos más (opcional)", submit: "Enviar", rated: "Gracias por tu valoración", required: "Obligatorio", invalid_email: "Introduce un email válido", transcript: "Enviarme esta conversación", error: "Algo salió mal. Inténtalo de nuevo.", today: "Hoy", yesterday: "Ayer", handoff: "Conectándote con una persona…", back: "Atrás" },
    fr: { chat: "Discutez avec nous", send: "Envoyer", placeholder: "Écrivez un message…", start: "Démarrer une conversation", cont: "Continuer la conversation", newconv: "Nouvelle conversation", prev: "Conversations précédentes", online: "Nous sommes en ligne", offline: "Nous sommes absents", minutes: "Répond généralement en quelques minutes", hours: "Répond généralement en quelques heures", day: "Répond généralement en un jour", back_at: "De retour {when}", tomorrow: "demain", soon: "Nous répondrons dès que possible", you: "Vous", talk: "Parler à une personne", sources: "Sources", helpful: "Utile", nothelpful: "Pas utile", thanks: "Merci pour votre retour", retry: "Réessayer", failed: "Non envoyé", closed: "Cette conversation est fermée — commencez-en une nouvelle", end: "Terminer la conversation", rate: "Comment s'est passée cette conversation ?", comment: "Dites-nous en plus (facultatif)", submit: "Envoyer", rated: "Merci pour votre note", required: "Obligatoire", invalid_email: "Entrez un e-mail valide", transcript: "M'envoyer cette conversation", error: "Une erreur est survenue. Réessayez.", today: "Aujourd'hui", yesterday: "Hier", handoff: "Mise en relation avec une personne…", back: "Retour" },
    de: { chat: "Chatte mit uns", send: "Senden", placeholder: "Nachricht schreiben…", start: "Unterhaltung starten", cont: "Unterhaltung fortsetzen", newconv: "Neue Unterhaltung", prev: "Frühere Unterhaltungen", online: "Wir sind online", offline: "Wir sind gerade nicht da", minutes: "Antwortet meist in wenigen Minuten", hours: "Antwortet meist in einigen Stunden", day: "Antwortet meist innerhalb eines Tages", back_at: "Wieder da {when}", tomorrow: "morgen", soon: "Wir antworten so schnell wie möglich", you: "Du", talk: "Mit einer Person sprechen", sources: "Quellen", helpful: "Hilfreich", nothelpful: "Nicht hilfreich", thanks: "Danke für dein Feedback", retry: "Erneut senden", failed: "Nicht gesendet", closed: "Diese Unterhaltung ist beendet — starte eine neue", end: "Unterhaltung beenden", rate: "Wie war diese Unterhaltung?", comment: "Erzähl uns mehr (optional)", submit: "Absenden", rated: "Danke für deine Bewertung", required: "Pflichtfeld", invalid_email: "Gib eine gültige E-Mail ein", transcript: "Unterhaltung per E-Mail senden", error: "Etwas ist schiefgelaufen. Bitte erneut versuchen.", today: "Heute", yesterday: "Gestern", handoff: "Wir verbinden dich mit einer Person…", back: "Zurück" },
    pt: { chat: "Fale conosco", send: "Enviar", placeholder: "Escreva uma mensagem…", start: "Iniciar conversa", cont: "Continuar conversa", newconv: "Nova conversa", prev: "Conversas anteriores", online: "Estamos online", offline: "Estamos ausentes no momento", minutes: "Normalmente responde em minutos", hours: "Normalmente responde em algumas horas", day: "Normalmente responde em um dia", back_at: "Voltamos {when}", tomorrow: "amanhã", soon: "Responderemos o mais rápido possível", you: "Você", talk: "Falar com uma pessoa", sources: "Fontes", helpful: "Útil", nothelpful: "Não útil", thanks: "Obrigado pelo feedback", retry: "Tentar de novo", failed: "Não enviado", closed: "Esta conversa foi encerrada — inicie uma nova", end: "Encerrar conversa", rate: "Como foi esta conversa?", comment: "Conte mais (opcional)", submit: "Enviar", rated: "Obrigado pela avaliação", required: "Obrigatório", invalid_email: "Digite um e-mail válido", transcript: "Enviar esta conversa por e-mail", error: "Algo deu errado. Tente novamente.", today: "Hoje", yesterday: "Ontem", handoff: "Conectando você a uma pessoa…", back: "Voltar" },
    ar: { chat: "تحدث معنا", send: "إرسال", placeholder: "اكتب رسالة…", start: "ابدأ محادثة", cont: "متابعة المحادثة", newconv: "محادثة جديدة", prev: "المحادثات السابقة", online: "نحن متصلون", offline: "نحن غير متاحين الآن", minutes: "عادةً نرد خلال دقائق", hours: "عادةً نرد خلال ساعات", day: "عادةً نرد خلال يوم", back_at: "سنعود {when}", tomorrow: "غدًا", soon: "سنرد في أقرب وقت", you: "أنت", talk: "التحدث مع شخص", sources: "المصادر", helpful: "مفيد", nothelpful: "غير مفيد", thanks: "شكرًا لملاحظاتك", retry: "إعادة المحاولة", failed: "لم يُرسل", closed: "هذه المحادثة مغلقة — ابدأ محادثة جديدة", end: "إنهاء المحادثة", rate: "كيف كانت هذه المحادثة؟", comment: "أخبرنا المزيد (اختياري)", submit: "إرسال", rated: "شكرًا لتقييمك", required: "مطلوب", invalid_email: "أدخل بريدًا إلكترونيًا صالحًا", transcript: "أرسل لي هذه المحادثة", error: "حدث خطأ ما. حاول مرة أخرى.", today: "اليوم", yesterday: "أمس", handoff: "جارٍ توصيلك بشخص…", back: "رجوع" }
  };
  var RTL = { ar: 1, he: 1, fa: 1, ur: 1 };
  var EMOJIS = "😀 😃 😄 😁 😆 😅 😂 🙂 😉 😊 😍 😘 😎 🤔 😐 😕 🙁 😢 😭 😤 😡 👍 👎 👏 🙏 💪 🙌 👋 ❤️ 💔 🔥 ✨ 🎉 ✅ ❌ ⭐ 💡 📎 📅 📞 ✉️ 🚀 🤝 👀 💬 🙈 🤷 🤩".split(" ");

  // ---------------------------------------------------------------- utils -------------------------------------------
  var doc = document, win = window;
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function safeUrl(u) { u = String(u || "").trim(); return /^(https?:|mailto:|tel:)/i.test(u) ? u : (/^\//.test(u) ? u : "#"); }
  function safeColor(c, d) { return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(c || "")) ? c : d; }
  function uid() { return (win.crypto && crypto.randomUUID) ? crypto.randomUUID() : "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
  function el(tag, cls, html) { var n = doc.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; }
  function debounce(f, ms) { var t; return function () { var a = arguments, s = this; clearTimeout(t); t = setTimeout(function () { f.apply(s, a); }, ms); }; }
  function hexToRgb(h) { h = h.replace("#", ""); if (h.length === 3) h = h.split("").map(function (c) { return c + c; }).join(""); var n = parseInt(h, 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  function luminance(h) { var c = hexToRgb(h).map(function (v) { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; }
  function contrastText(h) { return luminance(h) > .5 ? "#111827" : "#ffffff"; }
  function shade(h, amt) { var c = hexToRgb(h).map(function (v) { return Math.max(0, Math.min(255, Math.round(v + amt))); }); return "#" + c.map(function (v) { return ("0" + v.toString(16)).slice(-2); }).join(""); }
  function md(src, allow) {
    if (!allow) return "<p>" + esc(src).replace(/\n/g, "<br>") + "</p>";
    var lines = String(src || "").replace(/\s*\[\d+\]/g, "").split("\n"), html = "", i = 0;
    function inline(t) {
      t = esc(t).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*\w])\*([^*]+)\*/g, "$1<em>$2</em>").replace(/(^|[^_\w])_([^_]+)_/g, "$1<em>$2</em>");
      t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, a, u) { return '<a href="' + esc(safeUrl(u)) + '" target="_blank" rel="noopener noreferrer">' + a + "</a>"; });
      t = t.replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g, function (_, p, u) { return p + '<a href="' + esc(safeUrl(u)) + '" target="_blank" rel="noopener noreferrer">' + u + "</a>"; });
      return t;
    }
    while (i < lines.length) {
      var ln = lines[i];
      if (/^```/.test(ln)) { var buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; html += "<pre><code>" + esc(buf.join("\n")) + "</code></pre>"; continue; }
      if (/^\s*[-*•]\s+/.test(ln)) { html += "<ul>"; while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) { html += "<li>" + inline(lines[i].replace(/^\s*[-*•]\s+/, "")) + "</li>"; i++; } html += "</ul>"; continue; }
      if (/^\s*\d+[.)]\s+/.test(ln)) { html += "<ol>"; while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { html += "<li>" + inline(lines[i].replace(/^\s*\d+[.)]\s+/, "")) + "</li>"; i++; } html += "</ol>"; continue; }
      if (ln.trim() === "") { i++; continue; }
      var para = []; while (i < lines.length && lines[i].trim() !== "" && !/^(```|\s*[-*•]\s|\s*\d+[.)]\s)/.test(lines[i])) para.push(lines[i++]);
      html += "<p>" + inline(para.join("\n")).replace(/\n/g, "<br>") + "</p>";
    }
    return html;
  }
  function fmtTime(d) { try { return new Date(d).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); } catch (e) { return ""; } }
  function dayLabel(d, T) { var x = new Date(d), n = new Date(); var same = function (a, b) { return a.toDateString() === b.toDateString(); }; if (same(x, n)) return T("today"); n.setDate(n.getDate() - 1); if (same(x, n)) return T("yesterday"); return x.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }); }
  function initials(n) { return String(n || "?").split(/\s+/).slice(0, 2).map(function (p) { return p.charAt(0).toUpperCase(); }).join(""); }
  function sanitizeCss(css) { return String(css || "").replace(/@import[^;]*;?/gi, "").replace(/expression\s*\(/gi, "").replace(/url\((?!\s*['"]?(?:https:|data:image\/))[^)]*\)/gi, "url()").replace(/<\/style/gi, "").slice(0, 20000); }

  // ---------------------------------------------------------------- minimal Phoenix realtime client -------------------
  function Realtime(url, key) {
    var ws = null, ref = 1, hb = null, topics = {}, backoff = 1000, closed = false, self = this, connected = false;
    this.connected = function () { return connected; };
    function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
    function connect() {
      if (closed) return;
      try { ws = new WebSocket(url + "?apikey=" + encodeURIComponent(key) + "&vsn=1.0.0"); } catch (e) { retry(); return; }
      ws.onopen = function () { connected = true; backoff = 1000; hb = setInterval(function () { send({ topic: "phoenix", event: "heartbeat", payload: {}, ref: String(ref++) }); }, 25000); Object.keys(topics).forEach(join); self.onstate && self.onstate(true); };
      ws.onmessage = function (ev) {
        var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        var t = topics[m.topic]; if (!t) return;
        if (m.event === "broadcast" && m.payload) t.cb(m.payload.event, m.payload.payload);
      };
      ws.onclose = function () { connected = false; clearInterval(hb); self.onstate && self.onstate(false); retry(); };
      ws.onerror = function () { try { ws.close(); } catch (e) {} };
    }
    function retry() { if (closed) return; setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 30000); }
    function join(topic) { send({ topic: topic, event: "phx_join", payload: { config: { broadcast: { self: false, ack: false }, presence: { key: "" }, postgres_changes: [], private: false } }, ref: String(ref++) }); }
    this.subscribe = function (topic, cb) { topic = "realtime:" + topic; if (topics[topic]) { topics[topic].cb = cb; return; } topics[topic] = { cb: cb }; if (connected) join(topic); };
    this.unsubscribe = function (topic) { topic = "realtime:" + topic; if (!topics[topic]) return; send({ topic: topic, event: "phx_leave", payload: {}, ref: String(ref++) }); delete topics[topic]; };
    this.close = function () { closed = true; clearInterval(hb); try { ws && ws.close(); } catch (e) {} };
    if ("WebSocket" in win) connect();
  }

  // ================================================================ panel factory ====================================
  win.__growthxaiWebchatPanel = function (sdk, cfg, eff) {
    var L = sdk._loader, API = L.api, TOKEN = L.token, store = L.store, settings = sdk.settings || {};
    var S = { cfg: cfg, eff: eff, open: false, view: "home", vt: store.get("vt"), visitor: null, convs: [], conv: null, msgs: [], byId: {}, pending: {}, agentTyping: null, aiStream: null,
              rt: null, poll: null, hbTimer: null, mode: null, locale: "en", muted: !!store.get("muted"), unreadPrev: [], mounted: false, sending: false, campaignTimers: [], lastConfigVersion: cfg.config_version, files: [] };
    var host, shadow, sheet, root, ui = {}, bc = null, focusBefore = null, listeners = [];
    var T = function (k, vars) { var s = (STR[S.locale] && STR[S.locale][k]) || STR.en[k] || k; return vars ? s.replace(/\{(\w+)\}/g, function (_, v) { return vars[v] != null ? vars[v] : ""; }) : s; };
    function t2(k) { var o = S.eff.locale && S.eff.locale.strings && S.eff.locale.strings[S.locale]; return (o && o[k]) || null; }

    // ---------------------------------------------------------------- api -------------------------------------------
    function api(method, path, body, opts) {
      opts = opts || {};
      var h = { "content-type": "application/json", "x-website-token": TOKEN };
      if (S.vt && !opts.noAuth) h.authorization = "Bearer " + S.vt;
      return fetch(API + path + (path.indexOf("?") >= 0 ? "&" : "?") + "token=" + encodeURIComponent(TOKEN), { method: method, headers: h, body: body != null ? JSON.stringify(body) : undefined, keepalive: !!opts.keepalive })
        .then(function (r) {
          if (r.status === 401 && !opts.noAuth && !opts.retried) { S.vt = null; store.del("vt"); return ensureVisitor().then(function () { return api(method, path, body, Object.assign({}, opts, { retried: true })); }); }
          if (opts.raw) return r;
          return r.text().then(function (t) { var j = {}; try { j = t ? JSON.parse(t) : {}; } catch (e) {} if (!r.ok) { var e2 = new Error(j.error || ("http " + r.status)); e2.code = j.code || (r.status === 429 ? "E_RATE_LIMITED" : "E_HTTP"); e2.status = r.status; throw e2; } return j; });
        });
    }
    var visitorP = null;
    function ensureVisitor() {
      if (S.visitor && S.vt) return Promise.resolve(S.visitor);
      if (visitorP) return visitorP;
      var utm = {}; try { new URL(location.href).searchParams.forEach(function (v, k) { if (/^utm_/i.test(k) || k === "ref") utm[k] = v.slice(0, 200); }); } catch (e) {}
      var body = { visitor_token: S.vt || store.get("vt") || null, locale: S.locale, timezone: (Intl.DateTimeFormat().resolvedOptions() || {}).timeZone, referrer: doc.referrer || null, landing_url: location.href, utm: Object.keys(utm).length ? utm : null, page: { url: location.href, title: doc.title } };
      visitorP = api("POST", "/visitor", body, { noAuth: true }).then(function (r) {
        S.vt = r.visitor_token; store.set("vt", S.vt); S.visitor = r.visitor; S.convs = r.conversations || []; S.blocked = !!r.blocked;
        if (S.visitor && S.visitor.identifier) L.identified(true);
        visitorP = null; return S.visitor;
      }, function (e) { visitorP = null; throw e; });
      return visitorP;
    }

    // ---------------------------------------------------------------- styles ----------------------------------------
    function styles() {
      var e = S.eff, ap = e.appearance || {}, accent = safeColor(ap.accent, "#4f46e5"), onAccent = contrastText(accent), dark = isDark();
      var bg = dark ? "#111827" : safeColor(ap.widget_bg, "#ffffff"), chatBg = dark ? "#0b1220" : safeColor(ap.chat_bg, "#f8f8fa"), ink = dark ? "#f3f4f6" : "#111827", ink2 = dark ? "#9ca3af" : "#6b7280", line = dark ? "#1f2937" : "#e5e7eb", card = dark ? "#1f2937" : "#ffffff";
      var font = (ap.font && ap.font !== "Inter" ? ap.font.replace(/[^\w\s,-]/g, "") + "," : "") + "Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif";
      var w = Math.min(720, Math.max(320, parseInt(ap.panel_width, 10) || 384)), z = parseInt(ap.z_index, 10) || 2147483000, side = ap.drawer_side === "left" ? "left" : "right";
      var lpos = (isMobile() ? Object.assign({}, e.launcher.desktop, e.launcher.mobile) : e.launcher.desktop) || {}, lside = lpos.position === "left" ? "left" : "right", lsize = { sm: 48, md: 56, lg: 64 }[lpos.size] || 56;
      return ":host{all:initial}*,*::before,*::after{box-sizing:border-box}" +
        ".root{--accent:" + accent + ";--on-accent:" + onAccent + ";--accent-2:" + shade(accent, dark ? 40 : -20) + ";--bg:" + bg + ";--chat:" + chatBg + ";--ink:" + ink + ";--ink2:" + ink2 + ";--line:" + line + ";--card:" + card + ";font:14px/1.45 " + font + ";color:var(--ink);z-index:" + z + ";direction:" + (RTL[S.locale] ? "rtl" : "ltr") + "}" +
        ".panel{position:fixed;display:flex;flex-direction:column;background:var(--bg);color:var(--ink);overflow:hidden;box-shadow:0 18px 60px rgba(0,0,0,.24);opacity:0;pointer-events:none;transition:transform .22s cubic-bezier(.34,1.3,.64,1),opacity .2s;z-index:" + z + "}" +
        ".panel.open{opacity:1;pointer-events:auto}" +
        ".mode-bubble .panel{width:" + w + "px;max-width:calc(100vw - 32px);height:600px;max-height:calc(100dvh - " + (lsize + (lpos.margin_bottom || 24) + 24) + "px);bottom:" + (lsize + (lpos.margin_bottom || 24) + 12) + "px;" + lside + ":" + (lpos.margin_side || 24) + "px;border-radius:18px;transform:scale(.94) translateY(8px);transform-origin:bottom " + lside + "}.mode-bubble .panel.open{transform:none}" +
        ".mode-drawer .panel,.mode-inline .panel{top:0;bottom:0;" + side + ":0;width:" + w + "px;max-width:100vw;height:100dvh;transform:translateX(" + (side === "left" ? "-" : "") + "105%)}.mode-drawer .panel.open,.mode-inline .panel.open{transform:none}" +
        ".mode-sidebar .panel{top:0;bottom:0;" + side + ":0;width:var(--sbw," + w + "px);max-width:100vw;height:100dvh;transform:translateX(" + (side === "left" ? "-" : "") + "105%);box-shadow:none;border-" + (side === "left" ? "right" : "left") + ":1px solid var(--line)}.mode-sidebar .panel.open{transform:none}" +
        ".resizer{position:absolute;top:0;bottom:0;" + (side === "left" ? "right" : "left") + ":-4px;width:8px;cursor:col-resize;display:none}.mode-sidebar .resizer{display:block}" +
        ".mode-modal .panel{top:50%;left:50%;width:min(680px,calc(100vw - 32px));height:min(640px,calc(100dvh - 48px));border-radius:18px;transform:translate(-50%,-50%) scale(.96)}.mode-modal .panel.open{transform:translate(-50%,-50%)}" +
        ".backdrop{position:fixed;inset:0;background:rgba(0,0,0,.35);opacity:0;pointer-events:none;transition:opacity .2s;z-index:" + (z - 1) + "}.mode-drawer .backdrop.open,.mode-modal .backdrop.open,.mode-inline .backdrop.open{opacity:1;pointer-events:auto}" +
        ".mode-embedded .panel{position:relative;width:100%;height:100%;min-height:480px;box-shadow:none;opacity:1;pointer-events:auto;transform:none;border-radius:0}" +
        "@media(max-width:640px){.mode-bubble .panel,.mode-drawer .panel,.mode-inline .panel,.mode-sidebar .panel,.mode-modal .panel{inset:0;width:100vw;max-width:100vw;height:100dvh;max-height:100dvh;border-radius:0;transform:translateY(100%)}.mode-bubble .panel.open,.mode-drawer .panel.open,.mode-inline .panel.open,.mode-sidebar .panel.open,.mode-modal .panel.open{transform:none}}" +
        ".hd{background:var(--accent);color:var(--on-accent);padding:14px 16px;display:flex;align-items:center;gap:10px;flex:0 0 auto}.hd .logo{width:40px;height:40px;border-radius:50%;background:rgba(255,255,255,.22);display:flex;align-items:center;justify-content:center;overflow:hidden;flex:0 0 auto;font-weight:700}.hd .logo img{width:100%;height:100%;object-fit:cover}" +
        ".hd .ttl{font-weight:700;font-size:15px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.hd .sub{font-size:12px;opacity:.9;display:flex;align-items:center;gap:6px;min-width:0}.hd .sub>span:last-child{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}.hd .sub .dot{width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 2px rgba(255,255,255,.35);flex:0 0 auto}.hd .sub .dot.off{background:#9ca3af}" +
        ".hd .grow{flex:1;min-width:0}.hd .ib{width:34px;height:34px;border:0;border-radius:10px;background:transparent;color:inherit;cursor:pointer;display:flex;align-items:center;justify-content:center;opacity:.9}.hd .ib:hover{background:rgba(255,255,255,.18);opacity:1}.hd .ib svg{width:20px;height:20px}" +
        ".hd .avs{display:flex}.hd .avs span{width:26px;height:26px;border-radius:50%;background:var(--card);color:var(--ink);font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;border:2px solid var(--accent);margin-left:-8px}" +
        ".menu{position:absolute;top:56px;" + (RTL[S.locale] ? "left" : "right") + ":10px;background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.18);padding:6px;min-width:220px;z-index:5}.menu button{display:flex;width:100%;text-align:start;gap:10px;align-items:center;padding:9px 10px;border:0;background:transparent;color:inherit;border-radius:8px;cursor:pointer;font:inherit}.menu button:hover,.menu button:focus-visible{background:var(--chat)}.menu svg{width:16px;height:16px;color:var(--ink2)}" +
        ".body{flex:1;min-height:0;overflow-y:auto;background:var(--chat);padding:14px 14px 6px;overscroll-behavior:contain;scroll-behavior:smooth}" +
        ".home{padding:22px 18px}.home h2{margin:0 0 4px;font-size:22px;line-height:1.2}.home p{margin:0 0 16px;color:var(--ink2)}.home .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 14px;margin-bottom:10px;cursor:pointer;display:flex;align-items:center;gap:10px}.home .card:hover{border-color:var(--accent)}.home .card b{display:block}.home .card small{color:var(--ink2)}.home .card svg{width:18px;height:18px;color:var(--accent);flex:0 0 auto;margin-inline-start:auto}" +
        ".qp{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0 12px}.qp button{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:7px 12px;cursor:pointer;font:inherit;color:var(--ink);text-align:start}.qp button:hover{border-color:var(--accent);color:var(--accent)}" +
        ".day{display:flex;align-items:center;gap:10px;color:var(--ink2);font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin:10px 0}.day::before,.day::after{content:'';flex:1;height:1px;background:var(--line)}" +
        ".msg{display:flex;gap:8px;margin:2px 0;align-items:flex-start}.msg.me{flex-direction:row-reverse}.msg .av{width:28px;height:28px;border-radius:50%;background:var(--card);border:1px solid var(--line);font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex:0 0 auto;overflow:hidden;visibility:hidden}.msg.first .av{visibility:visible;margin-top:26px}.msg .av img{width:100%;height:100%;object-fit:cover}.msg.me .av{display:none}" +
        ".msg .col{max-width:80%;min-width:0;display:flex;flex-direction:column;gap:2px}.msg.me .col{align-items:flex-end}.msg .who{font-size:11px;color:var(--ink2);margin:8px 0 2px;display:none}.msg.first .who{display:block}.msg .who .ai{background:var(--accent);color:var(--on-accent);border-radius:4px;padding:0 5px;font-size:10px;margin-inline-start:4px}" +
        ".bub{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:9px 13px;word-wrap:break-word;overflow-wrap:anywhere;position:relative}.msg.me .bub{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}.msg.me .bub a{color:inherit}.bub p{margin:0 0 6px}.bub p:last-child{margin:0}.bub ul,.bub ol{margin:4px 0;padding-inline-start:20px}.bub a{color:var(--accent);text-decoration:underline}.bub code{background:rgba(0,0,0,.08);padding:1px 5px;border-radius:5px;font-size:.92em}.bub pre{background:#111827;color:#e5e7eb;padding:10px;border-radius:8px;overflow:auto}.bub pre code{background:none;color:inherit}" +
        ".bub img.pic{max-width:240px;max-height:240px;border-radius:10px;display:block;cursor:zoom-in}.file{display:flex;align-items:center;gap:8px;text-decoration:none;color:inherit;font-weight:500;cursor:pointer}.file svg{width:18px;height:18px;flex:0 0 auto}" +
        ".meta{font-size:11px;color:var(--ink2);display:flex;gap:6px;align-items:center;margin:0 4px}.meta .tick{font-size:11px}.meta .tick.read{color:var(--accent)}.meta .fail{color:#ef4444;cursor:pointer;text-decoration:underline}" +
        ".sys{text-align:center;color:var(--ink2);font-size:12px;margin:8px 0}" +
        ".typing{display:inline-flex;gap:4px;padding:10px 13px}.typing i{width:6px;height:6px;border-radius:50%;background:var(--ink2);animation:gxb 1.2s infinite}.typing i:nth-child(2){animation-delay:.2s}.typing i:nth-child(3){animation-delay:.4s}@keyframes gxb{0%,60%,100%{opacity:.3}30%{opacity:1}}" +
        ".cur{display:inline-block;width:7px;height:14px;background:var(--accent);margin-inline-start:1px;animation:gxbl 1s steps(2) infinite;vertical-align:-2px}@keyframes gxbl{50%{opacity:0}}" +
        ".src{margin-top:8px;font-size:12px}.src summary{cursor:pointer;color:var(--ink2)}.src a{display:block;color:var(--accent);margin:3px 0;text-decoration:none}" +
        ".fb{margin-top:8px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}.fb button{background:none;border:1px solid var(--line);border-radius:8px;cursor:pointer;padding:3px 9px;font:inherit;font-size:12px;color:var(--ink)}.fb button:hover{border-color:var(--accent)}.fb .ok{font-size:12px;color:#16a34a}" +
        ".acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.acts button,.acts a{background:var(--card);color:var(--accent);border:1px solid var(--accent);border-radius:999px;padding:6px 12px;cursor:pointer;font:inherit;font-size:13px;text-decoration:none}.acts button:disabled{opacity:.5;cursor:default}" +
        ".cards{display:flex;gap:10px;overflow-x:auto;scroll-snap-type:x mandatory;padding:6px 0 4px;scrollbar-width:thin}.cardi{min-width:200px;max-width:220px;flex:0 0 auto;scroll-snap-align:start;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--card)}.cardi img{width:100%;height:120px;object-fit:cover;display:block}.cardi .ct{padding:8px 10px}.cardi b{display:block;font-size:13px}.cardi small{color:var(--ink2);display:block;margin:2px 0 6px}" +
        ".form{display:flex;flex-direction:column;gap:8px;margin-top:6px}.form label{font-size:12px;color:var(--ink2);display:block;margin-bottom:2px}.form input,.form select,.form textarea{width:100%;border:1px solid var(--line);border-radius:10px;padding:9px 11px;font:inherit;background:var(--card);color:var(--ink);outline:none}.form input:focus,.form select:focus,.form textarea:focus{border-color:var(--accent)}.form .err{color:#ef4444;font-size:12px}.form .cb{display:flex;gap:8px;align-items:flex-start;font-size:13px}.form .cb input{width:auto}.form .hp{position:absolute;left:-9999px;opacity:0;height:0}" +
        ".pbtn{background:var(--accent);color:var(--on-accent);border:0;border-radius:10px;padding:10px 14px;font:inherit;font-weight:600;cursor:pointer}.pbtn:disabled{opacity:.5;cursor:default}.sbtn{background:transparent;color:var(--accent);border:1px solid var(--accent);border-radius:10px;padding:9px 14px;font:inherit;font-weight:600;cursor:pointer}" +
        ".csat{display:flex;gap:8px;justify-content:center;margin:8px 0}.csat button{background:var(--card);border:1px solid var(--line);border-radius:12px;font-size:22px;width:44px;height:44px;cursor:pointer}.csat button:hover,.csat button.on{border-color:var(--accent);transform:scale(1.08)}" +
        ".cp{border-top:1px solid var(--line);background:var(--bg);padding:10px 10px 8px;flex:0 0 auto;position:relative}.cp .row{display:flex;gap:6px;align-items:flex-end}.cp textarea{flex:1;border:1px solid var(--line);border-radius:14px;padding:10px 12px;font:inherit;resize:none;max-height:120px;min-height:42px;outline:none;background:var(--card);color:var(--ink)}.cp textarea:focus{border-color:var(--accent)}.cp .ib{width:40px;height:40px;flex:0 0 auto;border:0;border-radius:10px;background:transparent;color:var(--ink2);cursor:pointer;display:flex;align-items:center;justify-content:center}.cp .ib:hover{background:var(--chat);color:var(--ink)}.cp .ib svg{width:20px;height:20px}.cp .send{background:var(--accent);color:var(--on-accent)}.cp .send:disabled{opacity:.4}" +
        ".cp .dis{color:var(--ink2);font-size:13px;text-align:center;padding:8px}.cp .files{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px}.cp .files span{background:var(--chat);border:1px solid var(--line);border-radius:8px;padding:3px 8px;font-size:12px;display:inline-flex;gap:6px;align-items:center}.cp .files button{border:0;background:none;cursor:pointer;color:var(--ink2);font-size:14px;line-height:1}" +
        ".emo{position:absolute;bottom:62px;" + (RTL[S.locale] ? "right" : "left") + ":10px;background:var(--card);border:1px solid var(--line);border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.18);padding:8px;display:grid;grid-template-columns:repeat(8,32px);gap:2px;z-index:5}.emo button{width:32px;height:32px;border:0;background:none;font-size:20px;cursor:pointer;border-radius:6px}.emo button:hover{background:var(--chat)}" +
        ".foot{text-align:center;font-size:11px;color:var(--ink2);padding:4px 0 2px}.foot a{color:inherit;text-decoration:none;font-weight:600}" +
        ".note{font-size:11px;color:var(--ink2);text-align:center;padding:6px 10px 0}.toast{position:absolute;left:50%;transform:translateX(-50%);bottom:90px;background:#111827;color:#fff;padding:8px 14px;border-radius:999px;font-size:13px;z-index:6;animation:gxin .2s ease}@keyframes gxin{from{opacity:0;transform:translate(-50%,6px)}to{opacity:1;transform:translateX(-50%)}}" +
        ".light{position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;z-index:" + (z + 1) + ";cursor:zoom-out}.light img{max-width:92vw;max-height:92vh;border-radius:8px}" +
        ".convs .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin-bottom:8px;cursor:pointer}.convs .card:hover{border-color:var(--accent)}.convs small{color:var(--ink2);display:block}.convs .st{font-size:10px;padding:1px 6px;border-radius:6px;background:var(--chat);color:var(--ink2);margin-inline-start:6px}" +
        ".drag{outline:2px dashed var(--accent);outline-offset:-6px}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}" +
        "@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}" +
        sanitizeCss(ap.custom_css);
    }
    function isDark() { var t = S.eff.appearance && S.eff.appearance.theme; if (settings.darkMode) t = settings.darkMode; if (t === "dark") return true; if (t === "light") return false; return win.matchMedia && win.matchMedia("(prefers-color-scheme: dark)").matches; }
    function isMobile() { return win.matchMedia && win.matchMedia("(max-width: 640px)").matches; }
    function applyStyles() { var t = styles(); try { if (!sheet && "replaceSync" in CSSStyleSheet.prototype) { sheet = new CSSStyleSheet(); shadow.adoptedStyleSheets = [sheet]; } if (sheet) { sheet.replaceSync(t); return; } } catch (e) {} var st = shadow.querySelector("style") || el("style"); st.textContent = t; if (!st.parentNode) shadow.insertBefore(st, shadow.firstChild); }

    // ---------------------------------------------------------------- mount -----------------------------------------
    var I = {
      x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
      dots: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
      back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
      send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>',
      clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M21.4 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>',
      smile: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/></svg>',
      file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
      chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
      plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
      list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
      mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
      bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
      ext: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/></svg>',
      end: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/></svg>'
    };
    function mount() {
      if (S.mounted) return;
      var mode = currentMode();
      var container = null;
      if (mode === "embedded") { var sel = S.eff.appearance.mount_selector || settings.mountSelector; try { container = sel && doc.querySelector(sel); } catch (e) {} if (!container) { mode = "bubble"; } }
      host = el("div"); host.id = "growthxai-webchat-panel"; host.setAttribute("data-growthxai", "panel");
      if (container) { host.style.cssText = "display:block;width:100%;height:100%;min-height:480px"; container.appendChild(host); }
      else { host.style.cssText = "position:fixed;inset:auto;width:0;height:0;overflow:visible;z-index:2147483000"; (doc.body || doc.documentElement).appendChild(host); }
      shadow = host.attachShadow({ mode: "closed" });
      root = el("div", "root mode-" + mode); shadow.appendChild(root);
      root.innerHTML = '<div class="backdrop"></div><section class="panel" role="' + (mode === "embedded" ? "region" : "dialog") + '" aria-modal="' + (mode === "drawer" || mode === "modal" || mode === "inline" ? "true" : "false") + '" aria-label="' + esc(S.eff.appearance.brand_name || "Chat") + '" tabindex="-1"><div class="resizer" aria-hidden="true"></div><div class="hd"></div><div class="body" aria-live="polite" aria-relevant="additions"></div><div class="cp"></div></section>';
      ui.panel = root.querySelector(".panel"); ui.hd = root.querySelector(".hd"); ui.body = root.querySelector(".body"); ui.cp = root.querySelector(".cp"); ui.backdrop = root.querySelector(".backdrop");
      applyStyles();
      ui.backdrop.addEventListener("click", function () { api_.close(); });
      ui.panel.addEventListener("keydown", function (e) { if (e.key === "Escape" && mode !== "embedded") { e.stopPropagation(); api_.close(); } if (e.key === "Tab") trapFocus(e); });
      ui.body.addEventListener("scroll", debounce(function () { if (ui.body.scrollTop < 40 && S.conv && S.msgs.length && !S.loadingMore && S.hasMore !== false) loadOlder(); }, 120));
      setupResizer(mode);
      if (win.matchMedia) { try { win.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyStyles); } catch (e) {} }
      win.addEventListener("resize", debounce(applyStyles, 200));
      S.mounted = true; S.mode = mode;
      if (mode === "embedded") { S.open = true; ui.panel.classList.add("open"); }
      renderHeader(); renderView();
    }
    function currentMode() { var m = (S.eff.appearance && S.eff.appearance.mode) || "bubble"; if (settings.mode) m = settings.mode; if (S.forcedMode) m = S.forcedMode; return ["bubble", "drawer", "sidebar", "modal", "inline", "embedded"].indexOf(m) >= 0 ? m : "bubble"; }
    function setupResizer(mode) {
      var r = root.querySelector(".resizer"), saved = store.get("sbw"); if (saved) root.style.setProperty("--sbw", saved + "px");
      var side = S.eff.appearance.drawer_side === "left" ? "left" : "right";
      r.addEventListener("mousedown", function (e) { e.preventDefault(); var sx = e.clientX, sw = ui.panel.getBoundingClientRect().width; function mv(ev) { var w = Math.max(320, Math.min(720, sw + (side === "left" ? ev.clientX - sx : sx - ev.clientX))); root.style.setProperty("--sbw", w + "px"); pushBody(); } function up() { doc.removeEventListener("mousemove", mv); doc.removeEventListener("mouseup", up); store.set("sbw", parseInt(getComputedStyle(root).getPropertyValue("--sbw"), 10) || null); } doc.addEventListener("mousemove", mv); doc.addEventListener("mouseup", up); });
      if (mode !== "sidebar") r.style.display = "none";
    }
    function pushBody() {
      var side = S.eff.appearance.drawer_side === "left" ? "Left" : "Right", h = doc.documentElement;
      if (S.mode === "sidebar" && S.open && !isMobile()) { var w = ui.panel.getBoundingClientRect().width; h.style["margin" + side] = w + "px"; h.style.transition = "margin .22s"; }
      else { h.style.marginLeft = ""; h.style.marginRight = ""; }
    }
    function trapFocus(e) {
      if (S.mode === "embedded" || S.mode === "bubble" || S.mode === "sidebar") return;
      var f = ui.panel.querySelectorAll("button:not([disabled]),[href],input,select,textarea,[tabindex]:not([tabindex='-1'])"); if (!f.length) return;
      var first = f[0], last = f[f.length - 1], a = shadow.activeElement;
      if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
    }

    // ---------------------------------------------------------------- header ----------------------------------------
    function availabilityText() {
      var av = S.cfg.availability || {}, rt = (S.eff.messages || {}).reply_time || "minutes";
      if (av.online) return rt === "none" ? "" : T(rt);
      if (av.in_hours) return t2("unavailable_message") || (S.eff.messages && S.eff.messages.unavailable_message) || T("soon");
      if (av.next_open_at) { var d = new Date(av.next_open_at), n = new Date(), diffH = (d - n) / 36e5; var when = diffH < 20 && d.toDateString() === n.toDateString() ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : (diffH < 36 ? T("tomorrow") : d.toLocaleDateString(undefined, { weekday: "long" })); return T("back_at", { when: when }); }
      return T("soon");
    }
    function renderHeader() {
      var ap = S.eff.appearance, av = S.cfg.availability || {}, feats = S.eff.features || {}, agents = (av.agents || []).slice(0, 3);
      var showStatus = feats.show_offline_status !== false || av.online;
      ui.hd.innerHTML = (S.view !== "home" && S.view !== "embedded-home" ? '<button class="ib" data-a="back" aria-label="' + esc(T("back")) + '">' + I.back + "</button>" : "") +
        '<div class="logo" aria-hidden="true">' + (ap.logo_url ? '<img src="' + esc(safeUrl(ap.logo_url)) + '" alt="">' : esc(initials(ap.brand_name))) + "</div>" +
        '<div class="grow"><div class="ttl">' + esc(t2("brand_name") || ap.brand_name || "Chat") + '</div><div class="sub">' + (showStatus ? '<span class="dot' + (av.online ? "" : " off") + '"></span>' : "") + "<span>" + esc(availabilityText() || (av.online ? T("online") : "")) + "</span></div></div>" +
        (agents.length && feats.show_agent_names !== false ? '<div class="avs" aria-hidden="true">' + agents.map(function (a) { return "<span>" + esc(initials(a.name)) + "</span>"; }).join("") + "</div>" : "") +
        '<button class="ib" data-a="menu" aria-label="' + esc(T("menu")) + '" aria-haspopup="menu">' + I.dots + "</button>" +
        (S.mode !== "embedded" ? '<button class="ib" data-a="close" aria-label="' + esc(T("closepanel")) + '">' + I.x + "</button>" : "");
      ui.hd.querySelectorAll("[data-a]").forEach(function (b) { b.addEventListener("click", function () { var a = b.getAttribute("data-a"); if (a === "close") api_.close(); else if (a === "back") showHome(); else if (a === "menu") toggleMenu(b); }); });
    }
    function toggleMenu(anchor) {
      var m = root.querySelector(".menu"); if (m) { m.remove(); return; }
      var feats = S.eff.features || {}, items = [];
      if (!feats.single_conversation && S.view === "messages") items.push(["new", I.plus, T("newconv")]);
      if (!feats.single_conversation && S.convs.length) items.push(["list", I.list, T("prev")]);
      if (feats.transcript !== false && S.conv) items.push(["transcript", I.mail, T("transcript")]);
      if (feats.end_conversation !== false && S.conv && S.conv.status !== "resolved") items.push(["end", I.end, T("end")]);
      if (feats.sounds !== false) items.push(["sound", I.bell, S.muted ? T("sound_on") : T("sound_off")]);
      if (S.mode !== "embedded" && settings.showPopoutButton !== false) items.push(["popout", I.ext, T("popout")]);
      m = el("div", "menu"); m.setAttribute("role", "menu");
      m.innerHTML = items.map(function (it) { return '<button role="menuitem" data-m="' + it[0] + '">' + it[1] + "<span>" + esc(it[2]) + "</span></button>"; }).join("");
      m.querySelectorAll("[data-m]").forEach(function (b) { b.addEventListener("click", function () { m.remove(); menuAction(b.getAttribute("data-m")); }); });
      ui.panel.appendChild(m); var first = m.querySelector("button"); first && first.focus();
      setTimeout(function () { doc.addEventListener("click", function h(ev) { if (!m.contains(ev.target) && ev.target !== anchor) { m.remove(); } doc.removeEventListener("click", h); }, { once: true }); }, 0);
    }
    function menuAction(a) {
      if (a === "new") startNew(); else if (a === "list") { S.view = "list"; renderHeader(); renderView(); }
      else if (a === "transcript") transcript(); else if (a === "end") endConversation();
      else if (a === "sound") { S.muted = !S.muted; store.set("muted", S.muted ? 1 : 0); }
      else if (a === "popout") api_.popoutChatWindow();
    }

    // ---------------------------------------------------------------- views -----------------------------------------
    function renderView() {
      if (S.view === "home") renderHome(); else if (S.view === "list") renderList(); else if (S.view === "prechat") renderPrechat(); else renderMessages();
      renderComposer();
    }
    function showHome() { S.view = "home"; renderHeader(); renderView(); }
    function activeConv() { return S.convs.filter(function (c) { return c.status !== "resolved"; }).sort(function (a, b) { return new Date(b.last_message_at || b.created_at) - new Date(a.last_message_at || a.created_at); })[0] || null; }
    function renderHome() {
      var ap = S.eff.appearance, ms = S.eff.messages || {}, feats = S.eff.features || {}, open = activeConv(), last = S.convs[0];
      var h = '<div class="home"><h2>' + esc(t2("welcome_title") || ap.welcome_title || "") + "</h2><p>" + esc(t2("welcome_tagline") || ap.welcome_tagline || "") + "</p>";
      if (open || (feats.single_conversation && last)) { var c = open || last; h += '<div class="card" data-open="' + esc(c.id) + '"><div><b>' + esc(T("cont")) + "</b><small>" + esc((c.last_message_preview || "").slice(0, 80)) + "</small></div>" + I.chev + "</div>"; }
      if (!feats.single_conversation || !last) h += '<div class="card" data-new="1"><div><b>' + esc(T("start")) + "</b><small>" + esc(availabilityText()) + "</small></div>" + I.chev + "</div>";
      var qp = (ms.quick_replies || []).slice(0, 6); if (qp.length) h += '<div class="qp" role="group">' + qp.map(function (q) { return '<button type="button" data-q="' + esc(q) + '">' + esc(q) + "</button>"; }).join("") + "</div>";
      if (!feats.single_conversation && S.convs.length > 1) h += '<div class="card" data-list="1"><div><b>' + esc(T("prev")) + "</b><small>" + S.convs.length + "</small></div>" + I.chev + "</div>";
      h += "</div>";
      ui.body.innerHTML = h;
      ui.body.querySelectorAll("[data-open]").forEach(function (n) { n.addEventListener("click", function () { openConv(n.getAttribute("data-open")); }); });
      ui.body.querySelectorAll("[data-new]").forEach(function (n) { n.addEventListener("click", function () { startNew(); }); });
      ui.body.querySelectorAll("[data-list]").forEach(function (n) { n.addEventListener("click", function () { S.view = "list"; renderHeader(); renderView(); }); });
      ui.body.querySelectorAll("[data-q]").forEach(function (n) { n.addEventListener("click", function () { startNew(n.getAttribute("data-q")); }); });
      ui.cp.innerHTML = powered();
    }
    function renderList() {
      var h = '<div class="convs">' + S.convs.map(function (c) { return '<div class="card" data-open="' + esc(c.id) + '" role="button" tabindex="0"><b>' + esc((c.last_message_preview || T("start")).slice(0, 80)) + '</b><span class="st">' + esc(c.status) + "</span><small>" + esc(dayLabel(c.last_message_at || c.created_at, T)) + (c.unread ? " · " + c.unread + " new" : "") + "</small></div>"; }).join("") + "</div>";
      ui.body.innerHTML = h;
      ui.body.querySelectorAll("[data-open]").forEach(function (n) { var go = function () { openConv(n.getAttribute("data-open")); }; n.addEventListener("click", go); n.addEventListener("keydown", function (e) { if (e.key === "Enter") go(); }); });
      ui.cp.innerHTML = powered();
    }
    function powered() { return (S.eff.features || {}).powered_by !== false ? '<div class="foot">' + esc(T("powered")) + ' <a href="https://growthxai.com/?utm_source=webchat" target="_blank" rel="noopener">' + esc(T("brand")) + "</a></div>" : ""; }

    // ---------------------------------------------------------------- pre-chat form (PRD §5.5) ----------------------
    var pendingFirst = null;
    function needsPrechat() {
      var pc = S.eff.pre_chat || {}; if (!pc.enabled) return false;
      if (S.visitor && S.visitor.identity_verified) return false;
      if (pc.when === "offline_only" && S.cfg.availability && S.cfg.availability.online) return false;
      var fields = (pc.fields || []).filter(function (f) { return f.visible !== false && f.enabled !== false; });
      var v = S.visitor || {};
      return fields.some(function (f) { if (f.key === "name" && v.name) return false; if (f.key === "email" && v.email) return false; if (f.key === "phone" && v.phone) return false; return true; });
    }
    function renderPrechat() {
      var pc = S.eff.pre_chat || {}, v = S.visitor || {};
      var fields = (pc.fields || []).filter(function (f) { return f.visible !== false && f.enabled !== false && !((f.key === "name" && v.name) || (f.key === "email" && v.email) || (f.key === "phone" && v.phone)); });
      var h = '<div class="home"><p>' + esc(pc.message || "") + '</p><form class="form" novalidate>';
      fields.forEach(function (f, i) {
        var id = "f" + i, ph = esc(f.placeholder || (f.key === "email" ? T("email_ph") : f.key === "name" ? T("name_ph") : f.key === "phone" ? T("phone_ph") : ""));
        h += '<div><label for="' + id + '">' + esc(f.label || f.key) + (f.required ? " *" : "") + "</label>";
        if (f.type === "list" || f.type === "select") h += '<select id="' + id + '" name="' + esc(f.key) + '"' + (f.required ? " required" : "") + '><option value="">' + ph + "</option>" + (f.options || f.values || []).map(function (o) { var val = typeof o === "string" ? o : (o.value || o.label); return '<option value="' + esc(val) + '">' + esc(typeof o === "string" ? o : (o.label || o.value)) + "</option>"; }).join("") + "</select>";
        else if (f.type === "checkbox") h += '<label class="cb"><input type="checkbox" id="' + id + '" name="' + esc(f.key) + '"> ' + esc(f.placeholder || "") + "</label>";
        else if (f.type === "textarea") h += '<textarea id="' + id + '" name="' + esc(f.key) + '" rows="3" placeholder="' + ph + '"' + (f.required ? " required" : "") + "></textarea>";
        else h += '<input id="' + id + '" name="' + esc(f.key) + '" type="' + (f.type === "phone" ? "tel" : f.type === "url" ? "url" : f.type === "number" ? "number" : f.type === "date" ? "date" : f.type === "email" ? "email" : "text") + '" placeholder="' + ph + '"' + (f.required ? " required" : "") + (f.pattern ? ' data-pattern="' + esc(f.pattern) + '"' : "") + (f.key === "email" ? ' autocomplete="email"' : f.key === "name" ? ' autocomplete="name"' : f.key === "phone" ? ' autocomplete="tel"' : "") + ">";
        h += '<div class="err" data-err="' + esc(f.key) + '"></div></div>';
      });
      if (pc.consent && pc.consent.enabled) h += '<label class="cb"><input type="checkbox" name="_consent"> <span>' + esc(pc.consent.label || "") + (pc.consent.link ? ' <a href="' + esc(safeUrl(pc.consent.link)) + '" target="_blank" rel="noopener">↗</a>' : "") + '</span></label><div class="err" data-err="_consent"></div>';
      h += '<input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true"><button class="pbtn" type="submit">' + esc(T("start")) + "</button></form></div>";
      ui.body.innerHTML = h;
      var form = ui.body.querySelector("form");
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        if (form.website && form.website.value) return;   // honeypot
        var data = { custom: {} }, ok = true;
        ui.body.querySelectorAll(".err").forEach(function (x) { x.textContent = ""; });
        fields.forEach(function (f) {
          var inp = form.elements[f.key]; if (!inp) return;
          var val = f.type === "checkbox" ? !!inp.checked : String(inp.value || "").trim(), err = null;
          if (f.required && (val === "" || val === false)) err = T("required");
          else if (val && (f.type === "email" || f.key === "email") && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(val)) err = T("invalid_email");
          else if (val && (f.type === "phone" || f.key === "phone") && !/^\+?[\d\s().-]{6,20}$/.test(val)) err = T("invalid_phone");
          else if (val && f.pattern) { try { if (!new RegExp(f.pattern).test(val)) err = f.pattern_error || T("required"); } catch (x) {} }
          if (err) { ok = false; var en = ui.body.querySelector('[data-err="' + f.key + '"]'); if (en) en.textContent = err; }
          if (["name", "email", "phone"].indexOf(f.key) >= 0) data[f.key] = val; else data.custom[f.key] = val;
        });
        if (pc.consent && pc.consent.enabled) { var cb = form.elements._consent; if (!cb.checked && pc.consent.required !== false) { ok = false; ui.body.querySelector('[data-err="_consent"]').textContent = T("consent_err"); } data.consent = { accepted: !!cb.checked, text_version: pc.consent.text_version }; }
        if (!ok) return;
        var first = pendingFirst; pendingFirst = null;
        createConversation(data, S.pendingSource || "launcher").then(function () { if (first) sendText(first); });
      });
      ui.cp.innerHTML = powered();
      var f0 = form.querySelector("input,select,textarea"); f0 && f0.focus();
    }

    // ---------------------------------------------------------------- conversations ---------------------------------
    function startNew(firstText, source) {
      S.pendingSource = source || S.pendingSource || "launcher";
      ensureVisitor().then(function () {
        var feats = S.eff.features || {};
        var open = activeConv();
        if ((feats.single_conversation && S.convs.length) || (open && !firstText && feats.single_conversation)) return openConv((open || S.convs[0]).id).then(function () { if (firstText) sendText(firstText); });
        if (needsPrechat()) { pendingFirst = firstText || null; S.view = "prechat"; renderHeader(); renderView(); return; }
        return createConversation(null, S.pendingSource).then(function () { if (firstText) sendText(firstText); });
      }).catch(showErr);
    }
    function postConversation(form, source, retried) {
      var body = { form: form, source: source || "launcher", page: { url: location.href, title: doc.title, campaign_message: S.campaignMsg || null, campaign_id: S.campaignId || null } };
      return turnstileToken().then(function (tt) { if (tt) body.turnstile_token = tt; return api("POST", "/conversations", body); })
        .catch(function (e) { if (e && e.code === "E_TURNSTILE" && !retried) return postConversation(form, source, true); throw e; });   // a token is single-use and expires: one fresh try
    }
    function createConversation(form, source) {
      return postConversation(form, source).then(function (r) {
        S.campaignMsg = null; S.campaignId = null;
        if (r.visitor) S.visitor = r.visitor;
        var c = r.conversation; S.convs = [c].concat(S.convs.filter(function (x) { return x.id !== c.id; }));
        sdk.emit("conversation:started", { id: c.id }); L.store.set("chatted", 1);
        return openConv(c.id);
      });
    }
    function openConv(id) {
      var c = S.convs.filter(function (x) { return x.id === id; })[0];
      if (!c) return Promise.resolve();
      if (S.conv && S.conv.id !== id) leaveRealtime();
      S.conv = c; S.msgs = []; S.byId = {}; S.hasMore = true; S.view = "messages"; renderHeader(); renderView();
      joinRealtime(); startHeartbeat();
      return api("GET", "/conversations/" + id + "/messages?limit=50").then(function (r) { (r.messages || []).forEach(addMsg); S.hasMore = (r.messages || []).length >= 50; renderMessages(true); markRead(); flushQueue(); }).catch(showErr);
    }
    function loadOlder() {
      if (!S.msgs.length) return; S.loadingMore = true; var first = S.msgs[0], h0 = ui.body.scrollHeight;
      api("GET", "/conversations/" + S.conv.id + "/messages?limit=50&before=" + encodeURIComponent(first.sent_at)).then(function (r) { var got = r.messages || []; S.hasMore = got.length >= 50; got.forEach(addMsg); renderMessages(false); ui.body.scrollTop = ui.body.scrollHeight - h0; }).catch(function () {}).then(function () { S.loadingMore = false; });
    }
    function addMsg(m) {
      if (m.echo_id && S.pending[m.echo_id]) { var p = S.pending[m.echo_id]; delete S.pending[m.echo_id]; S.msgs = S.msgs.filter(function (x) { return x !== p; }); }
      if (S.byId[m.id]) { Object.assign(S.byId[m.id], m); return false; }
      S.byId[m.id] = m; S.msgs.push(m); S.msgs.sort(function (a, b) { return new Date(a.sent_at) - new Date(b.sent_at); }); return true;
    }

    // ---------------------------------------------------------------- messages render -------------------------------
    function renderMessages(scroll) {
      var body = ui.body, ap = S.eff.appearance, feats = S.eff.features || {}, ms = S.eff.messages || {}, html = "", lastDay = null, prev = null, av = S.cfg.availability || {};
      var ai = S.conv && (av.ai_mode !== "off") && !(S.conv.handed_off_at);
      if (!S.msgs.length && !ai) html += '<div class="note">' + esc(availabilityText()) + "</div>";
      if (ai && S.msgs.length) html += '<div class="note">' + esc(T("ai_note")) + "</div>";
      S.msgs.forEach(function (m) {
        var day = dayLabel(m.sent_at, T); if (day !== lastDay) { html += '<div class="day">' + esc(day) + "</div>"; lastDay = day; prev = null; }
        if (m.content_type === "event") { html += sysLine(m); prev = null; return; }
        if (m.deleted) return;
        var me = m.sender_type === "visitor", first = !prev || prev.sender_type !== m.sender_type || prev.sender_name !== m.sender_name || (new Date(m.sent_at) - new Date(prev.sent_at)) > 60000;
        var last = true; // computed below via lookahead
        html += bubble(m, me, first);
        prev = m;
      });
      if (S.aiStream) html += S.aiStream.html;
      if (S.agentTyping) html += '<div class="msg first"><div class="av">' + esc(initials(S.agentTyping)) + '</div><div class="col"><div class="who">' + esc(S.agentTyping) + '</div><div class="bub typing" aria-label="' + esc(T("typing", { name: S.agentTyping })) + '"><i></i><i></i><i></i></div></div></div>';
      body.innerHTML = html;
      wireBubbles();
      if (scroll !== false) body.scrollTop = body.scrollHeight;
    }
    function sysLine(m) {
      var a = m.content_attributes || {}, k = a.kind, t = "";
      if (k === "assigned") t = (a.agent || T("team")) + " joined"; else if (k === "resolved") t = T("ended"); else if (k === "reopened") t = T("cont"); else if (k === "email_sent") t = "Sent to " + (a.to || "your email"); else if (k === "ai_stopped" || k === "unassigned" || k === "ai_resumed") return ""; else t = k || "";
      return t ? '<div class="sys">' + esc(t) + "</div>" : "";
    }
    function bubble(m, me, first) {
      var a = m.content_attributes || {}, feats = S.eff.features || {}, ap = S.eff.appearance;
      var who = me ? "" : (m.sender_type === "bot" ? (ap.brand_name || "") + '<span class="ai">' + esc(T("ai")) + "</span>" : (feats.show_agent_names !== false ? esc(m.sender_name || T("team")) : esc(T("team"))));
      var inner = "";
      if (m.text) inner += md(m.text, feats.markdown !== false && !me);
      (m.attachments || []).forEach(function (f) { var img = /^image\//.test(f.type || ""); inner += img ? '<img class="pic" data-att="' + esc(f.id) + '" alt="' + esc(f.name || "") + '" src="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27200%27 height=%27120%27%3E%3C/svg%3E">' : '<a class="file" data-att="' + esc(f.id) + '" role="button">' + I.file + "<span>" + esc(f.name || "file") + (f.size ? " · " + Math.round(f.size / 1024) + " KB" : "") + "</span></a>"; });
      if (m.content_type === "cards" && a.items) inner += cards(a.items);
      if (m.content_type === "quick_replies" && a.items) inner += '<div class="acts">' + a.items.map(function (it) { var t = typeof it === "string" ? it : it.title; return '<button type="button" data-qr="' + esc(typeof it === "string" ? it : (it.value || it.title)) + '"' + (a.response ? " disabled" : "") + ">" + esc(t) + "</button>"; }).join("") + "</div>";
      if (m.content_type === "form") inner += formBlock(m);
      if (m.content_type === "csat") inner += csatBlock(m);
      if (a.ai && m.sender_type === "bot") inner += aiExtras(m);
      if (a.handoff && !S.conv.handed_off_at) {}
      var meta = me ? '<div class="meta"><span>' + esc(fmtTime(m.sent_at)) + "</span>" + (m.failed ? '<span class="fail" data-retry="' + esc(m.echo_id) + '">' + esc(T("failed")) + " · " + esc(T("retry")) + "</span>" : m.pending ? "<span>…</span>" : (feats.read_receipts !== false ? '<span class="tick' + (m.read_by_agent_at ? " read" : "") + '" title="' + esc(m.read_by_agent_at ? T("read") : T("sent")) + '">' + (m.read_by_agent_at ? "✓✓" : "✓") + "</span>" : "")) + "</div>"
                    : '<div class="meta"><span>' + esc(fmtTime(m.sent_at)) + "</span></div>";
      var avatar = m.sender_type === "bot" ? (ap.bot_avatar_url ? '<img src="' + esc(safeUrl(ap.bot_avatar_url)) + '" alt="">' : esc(initials(ap.brand_name))) : esc(initials(m.sender_name || T("team")));
      return '<div class="msg' + (me ? " me" : "") + (first ? " first" : "") + '" data-id="' + esc(m.id) + '">' + (me ? "" : '<div class="av" aria-hidden="true">' + avatar + "</div>") + '<div class="col">' + (who ? '<div class="who">' + who + "</div>" : "") + '<div class="bub">' + inner + "</div>" + meta + "</div></div>";
    }
    function cards(items) {
      return '<div class="cards" role="region">' + items.slice(0, 10).map(function (c) { return '<div class="cardi">' + (c.media_url ? '<img src="' + esc(safeUrl(c.media_url)) + '" alt="" loading="lazy">' : "") + '<div class="ct"><b>' + esc(c.title || "") + "</b>" + (c.description ? "<small>" + esc(c.description) + "</small>" : "") + '<div class="acts">' + (c.actions || []).map(function (ac) { return ac.type === "postback" ? '<button type="button" data-pb="' + esc(ac.payload || ac.text) + '">' + esc(ac.text) + "</button>" : '<a href="' + esc(safeUrl(ac.uri || ac.url)) + '" target="_blank" rel="noopener">' + esc(ac.text || "Open") + "</a>"; }).join("") + "</div></div></div>"; }).join("") + "</div>";
    }
    function formBlock(m) {
      var a = m.content_attributes || {};
      if (a.response || a.submitted) return '<div class="fb"><span class="ok">✓ ' + esc(a.form === "email" ? (a.response && a.response.email) || "" : T("sent")) + "</span></div>";
      if (a.form === "email") return '<form class="form" data-form="email"><input type="email" name="email" placeholder="' + esc(T("email_ph")) + '" required autocomplete="email"><button class="pbtn" type="submit">' + esc(T("send")) + '</button><div class="err"></div></form>';
      var items = a.items || [];
      return '<form class="form" data-form="generic">' + items.map(function (f, i) { var n = esc(f.name || "f" + i); return '<div><label>' + esc(f.label || f.name) + "</label>" + (f.type === "select" ? '<select name="' + n + '">' + (f.options || []).map(function (o) { return '<option value="' + esc(o.value) + '">' + esc(o.label) + "</option>"; }).join("") + "</select>" : f.type === "text_area" ? '<textarea name="' + n + '" rows="3" placeholder="' + esc(f.placeholder || "") + '"' + (f.required ? " required" : "") + "></textarea>" : '<input name="' + n + '" type="' + (f.type === "email" ? "email" : "text") + '" placeholder="' + esc(f.placeholder || "") + '"' + (f.required ? " required" : "") + ">") + "</div>"; }).join("") + '<button class="pbtn" type="submit">' + esc(a.button_label || T("submit")) + "</button></form>";
    }
    function csatBlock(m) {
      var a = m.content_attributes || {}, r = a.response || (S.conv && S.conv.csat);
      if (r) return '<div class="fb"><span class="ok">✓ ' + esc(T("rated")) + "</span></div>";
      var scale = a.scale === "thumbs" ? [[1, "👎"], [5, "👍"]] : [[1, "😞"], [2, "😕"], [3, "😐"], [4, "🙂"], [5, "😍"]];
      return '<div><p>' + esc(T("rate")) + '</p><div class="csat" role="radiogroup">' + scale.map(function (s) { return '<button type="button" role="radio" aria-checked="false" data-rate="' + s[0] + '" aria-label="' + s[0] + '">' + s[1] + "</button>"; }).join("") + "</div>" + (a.ask_comment !== false ? '<form class="form" data-form="csat"><textarea name="comment" rows="2" placeholder="' + esc(T("comment")) + '"></textarea><button class="pbtn" type="submit" disabled>' + esc(T("submit")) + "</button></form>" : "") + "</div>";
    }
    function aiExtras(m) {
      var a = m.content_attributes || {}, h = "";
      if ((S.eff.ai || {}).show_sources !== false && a.sources && a.sources.length) h += '<details class="src"><summary>' + esc(T("sources")) + "</summary>" + a.sources.map(function (s) { return s.url ? '<a href="' + esc(safeUrl(s.url)) + '" target="_blank" rel="noopener noreferrer">' + esc(s.title || s.url) + "</a>" : ""; }).join("") + "</details>";
      h += '<div class="fb">' + (a.feedback ? '<span class="ok">✓ ' + esc(T("thanks")) + "</span>" : '<button type="button" data-fb="1" data-turn="' + esc(a.turn_id || "") + '" aria-label="' + esc(T("helpful")) + '">👍</button><button type="button" data-fb="-1" data-turn="' + esc(a.turn_id || "") + '" aria-label="' + esc(T("nothelpful")) + '">👎</button>') + '<button type="button" data-copy="' + esc(m.id) + '">' + esc(T("copy")) + "</button>" + (!S.conv.handed_off_at ? '<button type="button" data-talk="1">' + esc(T("talk")) + "</button>" : "") + "</div>";
      return h;
    }
    function wireBubbles() {
      var b = ui.body;
      b.querySelectorAll("[data-att]").forEach(function (n) {
        var id = n.getAttribute("data-att"), isImg = n.tagName === "IMG";
        var load = function () { return api("GET", "/attachments/" + S.conv.id + "/" + encodeURIComponent(id)).then(function (r) { return r.url; }); };
        if (isImg) { load().then(function (u) { n.src = u; n.addEventListener("click", function () { lightbox(u); }); }).catch(function () {}); }
        else n.addEventListener("click", function () { load().then(function (u) { win.open(u, "_blank", "noopener"); }).catch(showErr); });
      });
      b.querySelectorAll("[data-qr]").forEach(function (n) { n.addEventListener("click", function () { sendText(n.getAttribute("data-qr")); }); });
      b.querySelectorAll("[data-pb]").forEach(function (n) { n.addEventListener("click", function () { sdk.emit("postback", { payload: n.getAttribute("data-pb") }); api("POST", "/events", { name: "postback", props: { payload: n.getAttribute("data-pb") }, conversation_id: S.conv.id }).catch(function () {}); }); });
      b.querySelectorAll("[data-fb]").forEach(function (n) { n.addEventListener("click", function () { var turn = n.getAttribute("data-turn"), v = +n.getAttribute("data-fb"); var msgEl = n.closest(".msg"), m = S.byId[msgEl.getAttribute("data-id")]; if (m) { m.content_attributes = Object.assign({}, m.content_attributes, { feedback: v }); } renderMessages(false); api("POST", "/feedback", { turn_id: turn, value: v }).catch(function () {}); }); });
      b.querySelectorAll("[data-copy]").forEach(function (n) { n.addEventListener("click", function () { var m = S.byId[n.getAttribute("data-copy")]; try { navigator.clipboard.writeText(m.text || ""); toast(T("copied")); } catch (e) {} }); });
      b.querySelectorAll("[data-talk]").forEach(function (n) { n.addEventListener("click", function () { sendText(T("talk")); }); });
      b.querySelectorAll("[data-retry]").forEach(function (n) { n.addEventListener("click", function () { var p = S.pending[n.getAttribute("data-retry")]; if (p) { p.failed = false; p.pending = true; renderMessages(false); deliver(p); } }); });
      b.querySelectorAll("[data-rate]").forEach(function (n) { n.addEventListener("click", function () { var wrap = n.closest(".bub"); wrap.querySelectorAll("[data-rate]").forEach(function (x) { x.classList.remove("on"); x.setAttribute("aria-checked", "false"); }); n.classList.add("on"); n.setAttribute("aria-checked", "true"); wrap.setAttribute("data-rating", n.getAttribute("data-rate")); var f = wrap.querySelector("form[data-form=csat]"); if (f) f.querySelector("button").disabled = false; else submitCsat(+n.getAttribute("data-rate"), null); }); });
      b.querySelectorAll("form[data-form]").forEach(function (f) {
        f.addEventListener("submit", function (e) {
          e.preventDefault(); var kind = f.getAttribute("data-form");
          if (kind === "email") { var em = f.email.value.trim(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) { f.querySelector(".err").textContent = T("invalid_email"); return; } var msgEl = f.closest(".msg"), m = S.byId[msgEl.getAttribute("data-id")]; m.content_attributes = Object.assign({}, m.content_attributes, { response: { email: em } }); if (S.visitor) S.visitor.email = em; renderMessages(false); sendRaw({ content_type: "form_response", content_attributes: { form: "email", values: { email: em } } }); }
          else if (kind === "csat") { var wrap = f.closest(".bub"); submitCsat(+wrap.getAttribute("data-rating"), f.comment.value.trim() || null); }
          else { var vals = []; Array.prototype.forEach.call(f.elements, function (x) { if (x.name) vals.push({ name: x.name, value: x.value }); }); var mm = S.byId[f.closest(".msg").getAttribute("data-id")]; mm.content_attributes = Object.assign({}, mm.content_attributes, { submitted: true }); renderMessages(false); sendRaw({ content_type: "form_response", content_attributes: { form: "generic", message_id: mm.id, values: vals } }); }
        });
      });
    }
    function submitCsat(rating, comment) { api("POST", "/conversations/" + S.conv.id + "/csat", { rating: rating, comment: comment }).then(function (r) { S.conv = Object.assign(S.conv, r.conversation); sdk.emit("csat:submitted", { rating: rating }); renderMessages(false); }).catch(showErr); }
    function lightbox(u) { var d = el("div", "light", '<img src="' + esc(u) + '" alt="">'); d.addEventListener("click", function () { d.remove(); }); root.appendChild(d); }
    function toast(t) { var d = el("div", "toast", esc(t)); ui.panel.appendChild(d); setTimeout(function () { d.remove(); }, 1800); }
    function showErr(e) { var code = e && e.code; toast(code === "E_RATE_LIMITED" ? T("rate_limited") : code === "E_TURNSTILE" ? T("verify_failed") : code === "E_TOO_LARGE" ? T("too_large", { mb: 10 }) : code === "E_TYPE_BLOCKED" ? T("bad_type") : T("error")); sdk.emit("error", { code: code, message: e && e.message }); }

    // ---------------------------------------------------------------- composer --------------------------------------
    function composerDisabled() {
      if (!S.conv) return null; var feats = S.eff.features || {};
      if (S.conv.status === "resolved" && feats.allow_after_resolved === false) return T("closed");
      return null;
    }
    function renderComposer() {
      if (S.view !== "messages") return;
      var feats = S.eff.features || {}, ms = S.eff.messages || {}, dis = composerDisabled();
      if (dis) { ui.cp.innerHTML = '<div class="dis">' + esc(dis) + '</div><div class="acts" style="justify-content:center;margin:0 0 6px"><button type="button" class="sbtn" data-new="1">' + esc(T("newconv")) + "</button></div>" + powered(); ui.cp.querySelector("[data-new]").addEventListener("click", function () { startNew(); }); return; }
      ui.cp.innerHTML = '<div class="files"></div><div class="row">' + (feats.file_picker !== false ? '<button class="ib" type="button" data-c="file" aria-label="' + esc(T("attach")) + '">' + I.clip + '</button><input type="file" multiple hidden>' : "") +
        '<textarea rows="1" maxlength="5000" placeholder="' + esc(t2("placeholder") || ms.placeholder || T("placeholder")) + '" aria-label="' + esc(T("placeholder")) + '"></textarea>' +
        (feats.emoji_picker !== false ? '<button class="ib" type="button" data-c="emoji" aria-label="' + esc(T("emoji")) + '">' + I.smile + "</button>" : "") +
        '<button class="ib send" type="button" data-c="send" aria-label="' + esc(T("send")) + '" disabled>' + I.send + "</button></div>" + powered();
      var ta = ui.cp.querySelector("textarea"), sendB = ui.cp.querySelector("[data-c=send]"), fileI = ui.cp.querySelector("input[type=file]");
      ui.ta = ta;
      var typingT = 0, lastTyping = 0;
      ta.addEventListener("input", function () { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 120) + "px"; sendB.disabled = !ta.value.trim() && !S.files.length; var now = Date.now(); if (now - lastTyping > 2000) { lastTyping = now; api("POST", "/conversations/" + S.conv.id + "/typing", { on: true, preview: ta.value.slice(0, 300) }).catch(function () {}); } clearTimeout(typingT); typingT = setTimeout(function () { api("POST", "/conversations/" + S.conv.id + "/typing", { on: false }).catch(function () {}); }, 4000); });
      ta.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(); } });
      ta.addEventListener("paste", function (e) { var items = (e.clipboardData || {}).items || []; for (var i = 0; i < items.length; i++) if (items[i].kind === "file") { var f = items[i].getAsFile(); if (f) addFile(f); } });
      sendB.addEventListener("click", submit);
      ui.cp.querySelectorAll("[data-c=file]").forEach(function (b) { b.addEventListener("click", function () { fileI.click(); }); });
      if (fileI) fileI.addEventListener("change", function () { Array.prototype.forEach.call(fileI.files, addFile); fileI.value = ""; });
      ui.cp.querySelectorAll("[data-c=emoji]").forEach(function (b) { b.addEventListener("click", function () { var p = ui.cp.querySelector(".emo"); if (p) { p.remove(); return; } p = el("div", "emo", EMOJIS.map(function (x) { return '<button type="button">' + x + "</button>"; }).join("")); p.querySelectorAll("button").forEach(function (x) { x.addEventListener("click", function () { var s = ta.selectionStart || ta.value.length; ta.value = ta.value.slice(0, s) + x.textContent + ta.value.slice(ta.selectionEnd || s); ta.dispatchEvent(new Event("input")); ta.focus(); p.remove(); }); }); ui.cp.appendChild(p); }); });
      ["dragenter", "dragover"].forEach(function (ev) { ui.panel.addEventListener(ev, function (e) { e.preventDefault(); ui.panel.classList.add("drag"); }); });
      ["dragleave", "drop"].forEach(function (ev) { ui.panel.addEventListener(ev, function (e) { e.preventDefault(); ui.panel.classList.remove("drag"); if (ev === "drop" && e.dataTransfer && feats.file_picker !== false) Array.prototype.forEach.call(e.dataTransfer.files, addFile); }); });
      renderFiles();
      function submit() { var t = ta.value.trim(); if (!t && !S.files.length) return; ta.value = ""; ta.style.height = "auto"; sendB.disabled = true; clearTimeout(typingT); sendText(t); }
    }
    function addFile(f) {
      var sec = (S.eff.security || {}).attachments || {}, max = Math.min(sec.max_mb || 10, 10) * 1048576;
      if (f.size > max) { toast(T("too_large", { mb: Math.round(max / 1048576) })); return; }
      if (/\.(exe|msi|bat|cmd|com|scr|ps1|sh|js|jar|vbs|dll|apk|dmg|pkg|html?|svg)$/i.test(f.name)) { toast(T("bad_type")); return; }
      if (S.files.length >= 5) return;
      S.files.push(f); renderFiles(); var b = ui.cp.querySelector("[data-c=send]"); if (b) b.disabled = false;
    }
    function renderFiles() { var w = ui.cp.querySelector(".files"); if (!w) return; w.innerHTML = S.files.map(function (f, i) { return "<span>" + esc(f.name) + '<button type="button" data-rm="' + i + '" aria-label="' + esc(T("close")) + '">×</button></span>'; }).join(""); w.querySelectorAll("[data-rm]").forEach(function (b) { b.addEventListener("click", function () { S.files.splice(+b.getAttribute("data-rm"), 1); renderFiles(); }); }); }

    // ---------------------------------------------------------------- Turnstile (PRD §7: bot check before the first message)
    // Cloudflare's script is loaded only when the inbox has it on, and the box renders into a light-DOM host (Turnstile
    // does not render inside a closed shadow root) with appearance "interaction-only": nothing shows unless Cloudflare
    // needs a click, then the box appears over the composer. Tokens are single-use and expire after 5 minutes, so one
    // is fetched right before each conversation start and sent as `turnstile_token`; the server verifies it.
    var ts = { load: null, wait: null, id: null, host: null };
    function turnstileOn() { var sec = S.eff.security || {}; return !!(sec.turnstile_enabled && sec.turnstile_site_key); }
    function turnstileScript() {
      if (win.turnstile) return Promise.resolve(win.turnstile);
      if (ts.load) return ts.load;
      ts.load = new Promise(function (res, rej) {
        var s = doc.querySelector('script[src^="https://challenges.cloudflare.com/turnstile/"]');
        if (!s) { s = doc.createElement("script"); s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"; s.async = true; s.defer = true; (doc.head || doc.documentElement).appendChild(s); }
        s.addEventListener("load", function () { if (win.turnstile) res(win.turnstile); else rej(new Error("turnstile")); });
        s.addEventListener("error", function () { ts.load = null; rej(new Error("turnstile")); });
      });
      return ts.load;
    }
    function turnstileHost(show) {
      if (!ts.host) { ts.host = el("div"); ts.host.setAttribute("data-growthxai", "turnstile"); ts.host.style.cssText = "position:fixed;z-index:2147483001;opacity:0;pointer-events:none;transition:opacity .15s"; (doc.body || doc.documentElement).appendChild(ts.host); }
      if (show && ui.panel) { var r = ui.panel.getBoundingClientRect(); ts.host.style.left = Math.max(8, r.left + 16) + "px"; ts.host.style.top = Math.max(8, r.bottom - 150) + "px"; }
      ts.host.style.opacity = show ? "1" : "0"; ts.host.style.pointerEvents = show ? "auto" : "none";
      return ts.host;
    }
    function codeErr(code) { var e = new Error(code); e.code = code; return e; }
    function turnstileToken() {
      if (!turnstileOn()) return Promise.resolve(null);
      if (ts.wait) return ts.wait;
      ts.wait = turnstileScript().then(function (tsl) {
        return new Promise(function (res, rej) {
          var host = turnstileHost(false), timer = setTimeout(function () { finish(); rej(codeErr("E_TURNSTILE")); }, 120000);
          function finish() { clearTimeout(timer); ts.wait = null; turnstileHost(false); }
          try { if (ts.id != null) tsl.remove(ts.id); } catch (e) {}
          ts.id = null; host.innerHTML = "";
          ts.id = tsl.render(host, { sitekey: S.eff.security.turnstile_site_key, action: "webchat_start", appearance: "interaction-only", theme: isDark() ? "dark" : "light", size: "normal",
            callback: function (token) { finish(); res(token); },
            "error-callback": function () { finish(); rej(codeErr("E_TURNSTILE")); return true; },
            "timeout-callback": function () { finish(); rej(codeErr("E_TURNSTILE")); },
            "before-interactive-callback": function () { turnstileHost(true); },
            "after-interactive-callback": function () { turnstileHost(false); } });
        });
      }).catch(function () { ts.wait = null; turnstileHost(false); throw codeErr("E_TURNSTILE"); });
      return ts.wait;
    }

    // ---------------------------------------------------------------- sending ---------------------------------------
    function sendText(text) {
      if (!S.conv) { pendingFirst = null; return startNew(text); }
      if (composerDisabled()) return startNew(text);
      var files = S.files.splice(0); renderFiles();
      var m = { id: "tmp-" + uid(), echo_id: uid(), conversation_id: S.conv.id, sender_type: "visitor", content_type: files.length ? "attachment" : "text", text: text || null, attachments: files.map(function (f) { return { name: f.name, type: f.type, size: f.size, id: "local" }; }), sent_at: new Date().toISOString(), pending: true, _files: files };
      S.pending[m.echo_id] = m; S.msgs.push(m); renderMessages(true); L.store.set("chatted", 1);
      deliver(m);
    }
    function sendRaw(o) { var m = Object.assign({ id: "tmp-" + uid(), echo_id: uid(), sender_type: "visitor", sent_at: new Date().toISOString(), pending: true, hidden: true }, o); S.pending[m.echo_id] = m; deliver(m); }
    function deliver(m) {
      if (!navigator.onLine) { queueOffline(m); return; }
      var up = Promise.resolve([]);
      if (m._files && m._files.length) up = Promise.all(m._files.map(uploadFile));
      up.then(function (ids) {
        return api("POST", "/conversations/" + S.conv.id + "/messages", { echo_id: m.echo_id, text: m.text, attachments: ids.filter(Boolean), content_type: m.content_type, content_attributes: m.content_attributes || {} });
      }).then(function (r) {
        delete S.pending[m.echo_id]; S.msgs = S.msgs.filter(function (x) { return x !== m; });
        if (r.dropped) { r.message.pending = false; }
        if (r.new_conversation && r.conversation) { S.convs = [r.conversation].concat(S.convs.filter(function (x) { return x.id !== r.conversation.id; })); openConv(r.conversation.id).then(function () { addMsg(r.message); renderMessages(true); }); return; }
        if (r.conversation) { Object.assign(S.conv, r.conversation); syncConvList(); }
        if (!m.hidden) { addMsg(r.message); }
        renderMessages(true); broadcastTabs({ t: "sync", conv: S.conv.id });
        sdk.emit("message:sent", { id: r.message && r.message.id, text: m.text });
        if (r.ai) streamAi(r.message.id);
        if (r.handoff) sdk.emit("handoff", { id: S.conv.id });
        if (S.mode === "modal" && !S.handedToSidebar) { S.handedToSidebar = true; api_.setMode("sidebar"); }
      }).catch(function (e) {
        if (e && e.code === "E_RATE_LIMITED") { toast(T("rate_limited")); }
        m.pending = false; m.failed = true; renderMessages(false); if (!(e && e.code === "E_RATE_LIMITED")) showErr(e);
      });
    }
    function uploadFile(f) {
      return api("POST", "/uploads", { conversation_id: S.conv.id, name: f.name, type: f.type || "application/octet-stream", size: f.size }).then(function (r) {
        return fetch(r.url, { method: "PUT", headers: { "content-type": f.type || "application/octet-stream", "x-upsert": "false" }, body: f }).then(function (res) { if (!res.ok) throw new Error("upload failed"); return r.upload_id; });
      });
    }
    function queueOffline(m) { var q = store.get("q") || []; q.push({ conv: S.conv.id, echo_id: m.echo_id, text: m.text, content_type: m.content_type, content_attributes: m.content_attributes || {} }); store.set("q", q.slice(-20)); toast(T("offline_q")); }
    function flushQueue() {
      var q = store.get("q") || []; if (!q.length || !navigator.onLine || !S.conv) return;
      var mine = q.filter(function (x) { return x.conv === S.conv.id; }); store.set("q", q.filter(function (x) { return x.conv !== S.conv.id; }));
      mine.reduce(function (p, x) { return p.then(function () { return api("POST", "/conversations/" + x.conv + "/messages", { echo_id: x.echo_id, text: x.text, content_type: x.content_type, content_attributes: x.content_attributes }).then(function (r) { var pm = S.pending[x.echo_id]; if (pm) { delete S.pending[x.echo_id]; S.msgs = S.msgs.filter(function (y) { return y !== pm; }); } addMsg(r.message); renderMessages(true); if (r.ai) streamAi(r.message.id); }).catch(function () {}); }); }, Promise.resolve());
    }
    win.addEventListener("online", flushQueue);

    // ---------------------------------------------------------------- AI streaming (PRD §5.4) -----------------------
    function streamAi(messageId) {
      var page = pageContext();
      S.aiStream = { html: '<div class="msg first"><div class="av">' + esc(initials(S.eff.appearance.brand_name)) + '</div><div class="col"><div class="who">' + esc(S.eff.appearance.brand_name || "") + '<span class="ai">' + esc(T("ai")) + '</span></div><div class="bub typing"><i></i><i></i><i></i></div></div></div>', text: "" };
      renderMessages(true);
      var ctl = ("AbortController" in win) ? new AbortController() : null;
      S.aiAbort = ctl;
      fetch(API + "/chat?token=" + encodeURIComponent(TOKEN), { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + S.vt, "x-website-token": TOKEN }, body: JSON.stringify({ conversation_id: S.conv.id, message_id: messageId, page: page }), signal: ctl ? ctl.signal : undefined })
        .then(function (res) {
          if (!res.ok || !res.body) throw new Error("http " + res.status);
          var reader = res.body.getReader(), dec = new TextDecoder(), buf = "", done = false;
          function pump() { return reader.read().then(function (r) { if (r.done) { finish(); return; } buf += dec.decode(r.value, { stream: true }); var frames = buf.split("\n\n"); buf = frames.pop(); frames.forEach(handle); return pump(); }); }
          function handle(f) {
            var ev = (f.match(/^event:\s*(.*)$/m) || [])[1] || "", data = (f.match(/^data:\s*([\s\S]*)$/m) || [])[1] || ""; var j; try { j = JSON.parse(data); } catch (e) { j = data; }
            if (ev === "token" && !done) { S.aiStream.text += j; S.aiStream.html = '<div class="msg first"><div class="av">' + esc(initials(S.eff.appearance.brand_name)) + '</div><div class="col"><div class="who">' + esc(S.eff.appearance.brand_name || "") + '<span class="ai">' + esc(T("ai")) + '</span></div><div class="bub">' + md(S.aiStream.text, true) + '<span class="cur"></span></div></div></div>'; renderMessages(true); }
            else if (ev === "done") { done = true; S.aiStream = null; if (j && j.message) { addMsg(j.message); } renderMessages(true); if (j && j.handoff) sdk.emit("handoff", { id: S.conv.id }); }
            else if (ev === "skip" || ev === "cancelled") { done = true; S.aiStream = null; renderMessages(true); }
            else if (ev === "error") { done = true; S.aiStream = null; renderMessages(true); }
          }
          function finish() { if (!done) { S.aiStream = null; renderMessages(true); } }
          return pump();
        }).catch(function () { S.aiStream = null; renderMessages(true); });
    }
    function pageContext() {
      try {
        var skip = { SCRIPT: 1, STYLE: 1, NAV: 1, FOOTER: 1, HEADER: 1, NOSCRIPT: 1, SVG: 1 }, w = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, { acceptNode: function (n) { return skip[n.parentElement && n.parentElement.tagName] || (n.parentElement && n.parentElement.closest && n.parentElement.closest("[data-growthxai]")) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; } }), text = "", node;
        while ((node = w.nextNode()) && text.length < 2500) { var t = node.textContent.trim(); if (t) text += t + " "; }
        return { url: location.href, title: doc.title, text: text.trim().slice(0, 2500) };
      } catch (e) { return { url: location.href, title: doc.title }; }
    }

    // ---------------------------------------------------------------- realtime + polling + heartbeat -----------------
    function joinRealtime() {
      if (!S.conv || !S.conv.stream_key) return;
      var rtc = S.cfg.realtime || {};
      if (!S.rt && rtc.url && rtc.anon_key && "WebSocket" in win) { S.rt = new Realtime(rtc.url, rtc.anon_key); S.rt.onstate = function (up) { if (up) { stopPoll(); catchUp(); } else startPoll(); }; }
      var topic = "webchat:" + S.conv.id + ":" + S.conv.stream_key;
      if (S.rt) S.rt.subscribe(topic, function (ev, payload) { onRealtime(ev, payload); });
      if (!S.rt || !S.rt.connected()) startPoll();
    }
    function leaveRealtime() { if (S.rt && S.conv) S.rt.unsubscribe("webchat:" + S.conv.id + ":" + S.conv.stream_key); stopPoll(); stopHeartbeat(); }
    function onRealtime(ev, p) {
      if (!S.conv || !p) return;
      if (ev === "message.created" && p.message) { if (p.message.conversation_id !== S.conv.id) return; var isNew = addMsg(p.message); if (isNew && p.message.sender_type !== "visitor") { S.agentTyping = null; if (S.aiStream && p.message.sender_type === "agent") { if (S.aiAbort) S.aiAbort.abort(); S.aiStream = null; } notify(p.message); sdk.emit("message", strip(p.message)); if (S.open && !doc.hidden) markRead(); else bumpUnread(); } renderMessages(true); }
      else if (ev === "message.updated" && p.message) { if (S.byId[p.message.id]) { Object.assign(S.byId[p.message.id], p.message); renderMessages(false); } }
      else if (ev === "typing") { S.agentTyping = p.typing ? (p.agent || T("team")) : null; renderMessages(true); clearTimeout(S.typingT); if (p.typing) S.typingT = setTimeout(function () { S.agentTyping = null; renderMessages(false); }, 12000); }
      else if (ev === "conversation.status" && p.conversation) { Object.assign(S.conv, { status: p.conversation.status, handed_off_at: p.conversation.handed_off_at, resolved_at: p.conversation.resolved_at, ai_handled: p.conversation.ai_handled }); syncConvList(); if (p.conversation.status === "resolved") sdk.emit("conversation:resolved", { id: S.conv.id }); renderView(); }
    }
    function strip(m) { return { id: m.id, conversation_id: m.conversation_id, sender_type: m.sender_type, sender_name: m.sender_name, text: m.text, content_type: m.content_type, sent_at: m.sent_at }; }
    function catchUp() { if (!S.conv || !S.msgs.length) return; var last = S.msgs.filter(function (m) { return !m.pending; }).slice(-1)[0]; if (!last) return; api("GET", "/conversations/" + S.conv.id + "/messages?after=" + encodeURIComponent(last.delivered_at || last.sent_at)).then(function (r) { var n = 0; (r.messages || []).forEach(function (m) { if (addMsg(m)) { n++; if (m.sender_type !== "visitor") { notify(m); if (S.open && !doc.hidden) markRead(); else bumpUnread(); } } }); if (n) renderMessages(true); }).catch(function () {}); }
    function startPoll() { stopPoll(); S.poll = setInterval(function () { if (S.conv && (S.open || S.mode === "embedded")) catchUp(); }, 5000); }
    function stopPoll() { clearInterval(S.poll); S.poll = null; }
    function startHeartbeat() { stopHeartbeat(); S.hbTimer = setInterval(function () { if (S.conv && S.open && !doc.hidden) api("POST", "/conversations/" + S.conv.id + "/heartbeat").then(function (r) { if (r && r.agent_typing && !S.agentTyping) { S.agentTyping = T("team"); renderMessages(false); } }).catch(function () {}); }, 30000); }
    function stopHeartbeat() { clearInterval(S.hbTimer); S.hbTimer = null; }
    function markRead() { if (!S.conv) return; var unread = S.msgs.some(function (m) { return m.sender_type !== "visitor" && !m.read_by_visitor_at; }); S.msgs.forEach(function (m) { if (m.sender_type !== "visitor" && !m.read_by_visitor_at) m.read_by_visitor_at = new Date().toISOString(); }); if (S.conv.unread) { S.conv.unread = 0; syncConvList(); } setUnreadTotal(); if (unread) api("POST", "/conversations/" + S.conv.id + "/read").catch(function () {}); }
    function bumpUnread() { S.conv.unread = (S.conv.unread || 0) + 1; syncConvList(); setUnreadTotal(); }
    function setUnreadTotal() { var n = 0, prev = []; S.convs.forEach(function (c) { n += c.unread || 0; }); if (S.conv && S.conv.unread) { S.msgs.filter(function (m) { return m.sender_type !== "visitor" && !m.read_by_visitor_at && m.text; }).slice(-2).forEach(function (m) { prev.push({ from: m.sender_name || S.eff.appearance.brand_name, text: m.text }); }); } L.setUnread(n, prev); }
    function syncConvList() { S.convs = S.convs.map(function (c) { return c.id === S.conv.id ? S.conv : c; }); }
    function notify(m) { if ((S.eff.features || {}).sounds === false || S.muted || !doc.hidden && S.open) return; try { var ac = new (win.AudioContext || win.webkitAudioContext)(), o = ac.createOscillator(), g = ac.createGain(); o.type = "sine"; o.frequency.value = 880; g.gain.value = .08; o.connect(g); g.connect(ac.destination); o.start(); g.gain.exponentialRampToValueAtTime(.0001, ac.currentTime + .25); o.stop(ac.currentTime + .26); } catch (e) {} }
    function broadcastTabs(o) { try { bc && bc.postMessage(o); } catch (e) {} }
    try { bc = new BroadcastChannel("gxwc:" + TOKEN); bc.onmessage = function (ev) { var d = ev.data || {}; if (d.t === "sync" && S.conv && d.conv === S.conv.id) catchUp(); if (d.t === "reset") { S.vt = null; S.visitor = null; S.convs = []; S.conv = null; S.msgs = []; if (S.mounted) { S.view = "home"; renderHeader(); renderView(); } } }; } catch (e) {}
    doc.addEventListener("visibilitychange", function () { if (!doc.hidden && S.open && S.conv) { catchUp(); markRead(); } });

    // ---------------------------------------------------------------- actions ---------------------------------------
    function endConversation() { if (!S.conv) return; api("POST", "/conversations/" + S.conv.id + "/resolve").then(function (r) { Object.assign(S.conv, r.conversation); syncConvList(); sdk.emit("conversation:resolved", { id: S.conv.id }); catchUp(); renderView(); }).catch(showErr); }
    function transcript() {
      if (!S.conv) return;
      var go = function () { api("POST", "/conversations/" + S.conv.id + "/transcript", {}).then(function (r) { toast(r.ok ? T("transcript_sent") : T("error")); }).catch(showErr); };
      if (S.visitor && S.visitor.email) return go();
      var em = win.prompt(T("transcript_email")); if (!em || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return;
      sendRaw({ content_type: "form_response", content_attributes: { form: "email", values: { email: em } } }); S.visitor.email = em; setTimeout(go, 800);
    }

    // ---------------------------------------------------------------- campaigns (PRD §5.11) --------------------------
    function evalCampaigns() {
      S.campaignTimers.forEach(clearTimeout); S.campaignTimers = [];
      var list = S.cfg.campaigns || []; if (!list.length || S.conv) return;
      var av = S.cfg.availability || {}, seen = store.get("camp") || {}, url = location.href;
      list.forEach(function (c) {
        var r = c.rules || {};
        if (r.business_hours_only && !av.in_hours) return;
        var rules = r.url_rules || (r.url ? [{ op: "contains", value: r.url }] : []); if (rules.length && !rules.some(function (x) { return x.op === "regex" ? (function () { try { return new RegExp(x.value).test(url); } catch (e) { return false; } })() : x.op === "equals" ? url === x.value : x.op === "starts_with" ? url.indexOf(x.value) === 0 : url.indexOf(x.value) >= 0; })) return;
        var vis = r.visitor || "all"; if (vis === "identified" && !(S.visitor && S.visitor.identifier)) return; if (vis === "new" && S.convs.length) return; if (vis === "returning" && !S.convs.length) return;
        if (c.frequency === "once" && seen[c.id]) return; if (c.frequency === "session" && sessionStorage.getItem("gxc:" + c.id)) return;
        S.campaignTimers.push(setTimeout(function () {
          if (S.open || S.conv) return;
          seen[c.id] = Date.now(); store.set("camp", seen); try { sessionStorage.setItem("gxc:" + c.id, "1"); } catch (e) {}
          api("POST", "/campaigns/" + c.id + "/hit", { kind: "shown" }).catch(function () {});
          S.campaignMsg = c.message; S.campaignId = c.id;
          if (c.display === "open") { api_.open({ source: "campaign" }); showCampaign(c); }
          else L.setUnread(L.cfg() && 0, [{ from: c.sender_name || S.eff.appearance.brand_name, text: c.message }]);
          sdk.on("opened", function once() { sdk.off("opened", once); if (S.campaignId === c.id) { api("POST", "/campaigns/" + c.id + "/hit", { kind: "clicked" }).catch(function () {}); showCampaign(c); } });
        }, Math.max(0, (parseFloat(r.time_on_page_s) || 0) * 1000)));
      });
    }
    function showCampaign(c) {
      S.view = "messages"; S.conv = null; S.msgs = [{ id: "camp-" + c.id, sender_type: c.sender_kind === "agent" ? "agent" : "bot", sender_name: c.sender_name, text: c.message, content_type: c.quick_replies && c.quick_replies.length ? "quick_replies" : "text", content_attributes: { items: c.quick_replies || [] }, sent_at: new Date().toISOString() }];
      S.pendingSource = "campaign"; renderHeader(); renderMessages(true); renderComposer();
    }

    // ---------------------------------------------------------------- public API (SDK, PRD §6) -----------------------
    var api_ = {
      get mode() { return S.mode; },
      open: function (o) {
        mount(); if (S.open && S.mode !== "embedded") return;
        S.open = true; S.pendingSource = (o && o.source) || "launcher"; focusBefore = doc.activeElement;
        ui.panel.classList.add("open"); ui.backdrop.classList.add("open"); L.setOpen(true); pushBody();
        if (!S.visitor) ensureVisitor().then(function () { if (S.view === "home") renderHome(); if (S.blocked) {} var ac = activeConv(); if (ac && (S.eff.features || {}).single_conversation) openConv(ac.id); else if (ac && ac.unread) openConv(ac.id); }).catch(function () {});
        else if (S.conv) { catchUp(); markRead(); }
        setTimeout(function () { var f = ui.ta || ui.panel.querySelector("button,input,textarea"); f && f.focus(); }, 250);
        sdk.emit("opened", {});
      },
      close: function () { if (!S.mounted || !S.open || S.mode === "embedded") return; S.open = false; ui.panel.classList.remove("open"); ui.backdrop.classList.remove("open"); L.setOpen(false); pushBody(); var m = root.querySelector(".menu"); m && m.remove(); try { focusBefore && focusBefore.focus(); } catch (e) {} sdk.emit("closed", {}); },
      toggle: function (st) { if (st === "open" || (st == null && !S.open)) api_.open(); else api_.close(); },
      setMode: function (m) { if (["bubble", "drawer", "sidebar", "modal", "inline", "embedded"].indexOf(m) < 0) return; var wasOpen = S.open; S.forcedMode = m; if (S.mounted) { api_.close(); pushBody(); host.remove(); S.mounted = false; sheet = null; } mount(); if (wasOpen) api_.open(); },
      send: function (text, o) { if (o && o.prefill) { api_.open(); setTimeout(function () { if (ui.ta) { ui.ta.value = text; ui.ta.dispatchEvent(new Event("input")); ui.ta.focus(); } }, 300); return; } api_.open(); ensureVisitor().then(function () { sendText(String(text || "")); }); },
      setUser: function (identifier, user) {
        user = user || {}; L.identified(true);
        return ensureVisitor().then(function () {
          if (S.visitor && S.visitor.identifier && String(S.visitor.identifier) !== String(identifier) && user.identifier_hash) { return api("POST", "/visitor/reset").then(function () { S.vt = null; store.del("vt"); S.visitor = null; S.convs = []; S.conv = null; S.msgs = []; broadcastTabs({ t: "reset" }); return ensureVisitor(); }); }
        }).then(function () {
          return api("POST", "/visitor/identify", { identifier: identifier, identifier_hash: user.identifier_hash || user.identifierHash, name: user.name, email: user.email, phone: user.phone || user.phone_number, avatar_url: user.avatar_url || user.avatarUrl, company: user.company || user.company_name, custom_attributes: user.custom_attributes || user.customAttributes || {} });
        }).then(function (r) { if (r.visitor_token) { S.vt = r.visitor_token; store.set("vt", S.vt); } S.visitor = r.visitor; S.convs = r.conversations || S.convs; if (S.mounted && S.view === "home") renderHome(); setUnreadTotal(); sdk.emit("identified", { verified: r.verified }); return r; })
          .catch(function (e) { sdk.emit("error", { code: e.code || "E_IDENTITY_INVALID", message: e.message }); throw e; });
      },
      setCustomAttributes: function (o) { return ensureVisitor().then(function () { return api("PATCH", "/visitor/attributes", { custom_attributes: o || {} }); }); },
      deleteCustomAttribute: function (k) { return ensureVisitor().then(function () { return api("PATCH", "/visitor/attributes", { delete: [k] }); }); },
      setConversationCustomAttributes: function (o) { if (!S.conv) { S.pendingConvAttrs = Object.assign({}, S.pendingConvAttrs, o); return Promise.resolve(); } return api("PATCH", "/visitor/attributes", { conversation_id: S.conv.id, conversation_custom_attributes: o }); },
      deleteConversationCustomAttribute: function (k) { if (!S.conv) return Promise.resolve(); return api("PATCH", "/visitor/attributes", { conversation_id: S.conv.id, conversation_delete: [k] }); },
      setLabel: function (l) { if (!S.conv) { (S.pendingLabels = S.pendingLabels || []).push(l); return Promise.resolve(); } return api("PATCH", "/visitor/attributes", { conversation_id: S.conv.id, add_labels: [l] }); },
      removeLabel: function (l) { if (!S.conv) return Promise.resolve(); return api("PATCH", "/visitor/attributes", { conversation_id: S.conv.id, remove_labels: [l] }); },
      setLocale: function (l) { S.locale = STR[l] ? l : (STR[String(l).slice(0, 2)] ? String(l).slice(0, 2) : "en"); if (S.mounted) { applyStyles(); renderHeader(); renderView(); } },
      setColorScheme: function (s) { settings.darkMode = s; if (S.mounted) applyStyles(); },
      trackEvent: function (name, props) { return ensureVisitor().then(function () { return api("POST", "/events", { name: name, props: props || {}, conversation_id: S.conv ? S.conv.id : null }); }); },
      reset: function () { var p = S.vt ? api("POST", "/visitor/reset").catch(function () {}) : Promise.resolve(); return p.then(function () { S.vt = null; store.del("vt"); store.del("q"); store.del("chatted"); S.visitor = null; S.convs = []; leaveRealtime(); S.conv = null; S.msgs = []; S.byId = {}; L.identified(false); L.setUnread(0, []); broadcastTabs({ t: "reset" }); if (S.mounted) { S.view = "home"; renderHeader(); renderView(); } }); },
      destroy: function () { api_.close(); leaveRealtime(); if (S.rt) S.rt.close(); S.campaignTimers.forEach(clearTimeout); if (host) host.remove(); S.mounted = false; var lh = doc.getElementById("growthxai-webchat"); lh && lh.remove(); },
      popoutChatWindow: function () { var origin = (function () { try { return new URL(doc.currentScript ? doc.currentScript.src : (doc.querySelector("script[data-website-token]") || {}).src || location.href).origin; } catch (e) { return location.origin; } })(); win.open(origin + "/chat/" + TOKEN, "growthxai_chat_" + TOKEN, "width=420,height=640,noopener"); },
      consent: function (ok) { if (ok) ensureVisitor(); },
      onRouteChange: function (url) { if (S.vt) api("POST", "/page-view", { views: [{ url: url, title: doc.title, referrer: doc.referrer, at: new Date().toISOString() }] }, { keepalive: true }).catch(function () {}); evalCampaigns(); },
      configUpdated: function (c, e) { S.cfg = c; S.eff = e; if (S.mounted) { applyStyles(); renderHeader(); renderView(); } evalCampaigns(); }
    };

    // ---------------------------------------------------------------- init ------------------------------------------
    (function init() {
      var l = settings.locale || (sdk.overrides || {}).locale;
      if (!l && S.eff.locale && S.eff.locale.use_browser !== false) l = (navigator.language || "en").slice(0, 2);
      if (!l && S.eff.locale) l = S.eff.locale.default;
      S.locale = STR[l] ? l : "en";
      var mode = currentMode();
      if (mode === "embedded") { mount(); ensureVisitor().then(function () { if (settings.resume) { api("GET", "/resume?t=" + encodeURIComponent(settings.resume)).then(function (r) { S.vt = r.visitor_token; store.set("vt", S.vt); S.visitor = null; return ensureVisitor().then(function () { if (S.convs.some(function (c) { return c.id === r.conversation_id; })) openConv(r.conversation_id); else renderHome(); }); }).catch(function () { renderHome(); }); } else { var ac = activeConv(); if (ac) openConv(ac.id); else renderHome(); } setUnreadTotal(); evalCampaigns(); }).catch(function () {}); }
      else if (S.vt) { ensureVisitor().then(function () { setUnreadTotal(); var ac = activeConv(); if (ac && ac.status !== "resolved") { S.conv = ac; joinRealtime(); } evalCampaigns(); }).catch(function () {}); }
      else { evalCampaigns(); }
      if (mode === "modal") doc.addEventListener("keydown", function (e) { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); api_.toggle(); } });
      win.addEventListener("pagehide", function () { if (S.conv && S.vt) { try { navigator.sendBeacon && navigator.sendBeacon(API + "/conversations/" + S.conv.id + "/typing?token=" + TOKEN, new Blob([JSON.stringify({ on: false })], { type: "text/plain" })); } catch (e) {} } });
    })();
    return api_;
  };
})();
