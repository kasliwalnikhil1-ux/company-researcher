/*! GrowthxAI web chat — voice v1 (web-chat-voice-elevenlabs-PRD.md §2, §6, §7.1, §8). Fetched by chat.js only when a
 * visitor starts a call (and by the app's Voice tab for test calls). Built from widget-src/voice.js with
 * scripts/outreach-widget-build.mjs, which bundles the voice provider's browser SDK (@elevenlabs/client, WebRTC).
 *
 *   window.__growthxaiWebchatVoice = { session, panel }
 *     session(o)  one voice session: token + dynamic variables in, callbacks out. No UI. The app's test panel uses this.
 *     panel(d)    the call view inside the chat panel (orb, status, captions, mute, type-in-call, switch to chat, end),
 *                 the live transcript mirror (/voice/turns) and every way a call hands over or ends. `d` is what chat.js
 *                 lends it (state, api(), strings, the bubble renderer), the way loader.js lends video.js its helpers.
 *
 * A call never blocks the chat: every failure ends with the visitor in the text thread of the same conversation.
 */
import { Conversation } from "@elevenlabs/client";

(function () {
  "use strict";
  var win = window, doc = document;
  if (win.__growthxaiWebchatVoice) return;

  /** What the widget types for the visitor when the server decided the handoff; never mirrored, never stored. */
  var HANDOFF_MARKER = "(handing over to the team)";

  // ---------------------------------------------------------------- one session (no UI) ------------------------------
  // o: { token, language?, variables, clientTools?, on: { connect(id), status(s), mode(m), message({role,text,eventId}),
  //      part({text,type}), tool({name,id,type}), toolResult({name,id,error,result}), error(msg), end(reason, details) } }
  function session(o) {
    var on = o.on || {}, conv = null, over = false, bins = null;
    var call = function (f, a, b) { try { return f && f(a, b); } catch (e) { /* a listener must not break the call */ } };
    var opts = {
      conversationToken: o.token, connectionType: "webrtc", dynamicVariables: o.variables || {}, useWakeLock: true, clientTools: o.clientTools || {},
      onConnect: function (p) { call(on.connect, p && p.conversationId); },
      onDisconnect: function (d) { if (over) return; over = true; call(on.end, (d && d.reason) || "error", d); },
      onError: function (m, c) { call(on.error, String(m || "error"), c); },
      onStatusChange: function (p) { call(on.status, p && p.status); },
      onModeChange: function (p) { call(on.mode, p && p.mode); },
      onMessage: function (m) { if (m && typeof m.message === "string") call(on.message, { role: m.role || (m.source === "user" ? "user" : "agent"), text: m.message, eventId: m.event_id }); },
      onAgentChatResponsePart: function (p) { call(on.part, p); },
      onAgentToolRequest: function (p) { call(on.tool, { name: p && p.tool_name, id: p && p.tool_call_id, type: p && p.tool_type }); },
      onAgentToolResponse: function (p) { call(on.toolResult, { name: p && p.tool_name, id: p && p.tool_call_id, error: !!(p && p.is_error), result: p && p.full_tool_result }); }
    };
    // the language is the one thing a browser may set on the agent; everything else is fixed on the server
    if (o.language) opts.overrides = { agent: { language: o.language } };
    return Conversation.startSession(opts).then(function (c) {
      conv = c;
      return {
        id: function () { try { return conv.getId(); } catch (e) { return null; } },
        /** ends the session; the `end` callback is not called for an end we asked for */
        end: function () { over = true; try { return Promise.resolve(conv.endSession()).catch(function () {}); } catch (e) { return Promise.resolve(); } },
        mute: function (b) { try { conv.setMicMuted(!!b); } catch (e) {} },
        text: function (t) { try { conv.sendUserMessage(String(t)); } catch (e) {} },
        activity: function () { try { conv.sendUserActivity(); } catch (e) {} },
        context: function (t) { try { conv.sendContextualUpdate(String(t)); } catch (e) {} },
        /** 0…1: how loud the agent is right now (drives the orb) */
        level: function () { try { bins = conv.getOutputByteFrequencyData(); var s = 0, n = bins ? bins.length : 0; for (var i = 0; i < n; i++) s += bins[i]; return n ? Math.min(1, s / n / 110) : 0; } catch (e) { return 0; } },
        open: function () { try { return conv.isOpen(); } catch (e) { return false; } }
      };
    });
  }

  // ---------------------------------------------------------------- the call view ------------------------------------
  var STR = {
    en: { end_s: "End", connecting: "Connecting…", listening: "Listening…", thinking: "Thinking…", speaking: "Speaking…", muted: "Muted", mute: "Mute", unmute: "Unmute", sw: "Switch to chat", end: "End call", type: "Type instead…", send: "Send", cc_on: "Show captions", cc_off: "Hide captions", you: "You", call: "Voice call", end_q: "End the call?", keep: "Keep talking",
      away: "The call ended while you were away.", lost: "The connection dropped. You can keep chatting here.", teammate: "A teammate has joined. Switching to chat.", team: "Passing you to the team. Switching to chat.", unavailable: "Voice isn't available right now. You can keep chatting here.", busy: "Voice is busy. Keep chatting here.", limit: "The call reached its time limit. You can keep chatting here.", ended: "Call ended" },
    hi: { end_s: "समाप्त", connecting: "जोड़ रहे हैं…", listening: "सुन रहे हैं…", thinking: "सोच रहे हैं…", speaking: "बोल रहे हैं…", muted: "म्यूट", mute: "म्यूट करें", unmute: "अनम्यूट करें", sw: "चैट पर जाएँ", end: "कॉल समाप्त करें", type: "टाइप करें…", you: "आप", call: "वॉइस कॉल", end_q: "कॉल समाप्त करें?", keep: "बात जारी रखें", away: "आपके दूर रहने पर कॉल समाप्त हो गई।", lost: "कनेक्शन टूट गया। आप यहाँ चैट जारी रख सकते हैं।", teammate: "टीम का सदस्य जुड़ गया है। चैट पर जा रहे हैं।", team: "आपको टीम से जोड़ रहे हैं। चैट पर जा रहे हैं।", unavailable: "वॉइस अभी उपलब्ध नहीं है। आप यहाँ चैट जारी रख सकते हैं।", busy: "वॉइस अभी व्यस्त है। यहाँ चैट जारी रखें।", limit: "कॉल की समय सीमा पूरी हो गई। आप यहाँ चैट जारी रख सकते हैं।", ended: "कॉल समाप्त" },
    es: { end_s: "Terminar", connecting: "Conectando…", listening: "Escuchando…", thinking: "Pensando…", speaking: "Hablando…", muted: "Silenciado", mute: "Silenciar", unmute: "Activar micrófono", sw: "Cambiar al chat", end: "Terminar llamada", type: "Escribe aquí…", you: "Tú", call: "Llamada de voz", end_q: "¿Terminar la llamada?", keep: "Seguir hablando", away: "La llamada terminó mientras no estabas.", lost: "Se perdió la conexión. Puedes seguir por chat.", teammate: "Se ha unido una persona del equipo. Cambiando al chat.", team: "Te pasamos con el equipo. Cambiando al chat.", unavailable: "La voz no está disponible ahora. Puedes seguir por chat.", busy: "La voz está ocupada. Sigue por chat.", limit: "La llamada alcanzó su límite de tiempo. Puedes seguir por chat.", ended: "Llamada terminada" },
    fr: { end_s: "Terminer", connecting: "Connexion…", listening: "À l'écoute…", thinking: "Réflexion…", speaking: "Réponse…", muted: "Micro coupé", mute: "Couper le micro", unmute: "Réactiver le micro", sw: "Passer au chat", end: "Terminer l'appel", type: "Écrivez ici…", you: "Vous", call: "Appel vocal", end_q: "Terminer l'appel ?", keep: "Continuer", away: "L'appel s'est terminé pendant votre absence.", lost: "La connexion a été perdue. Vous pouvez continuer par chat.", teammate: "Un membre de l'équipe vous a rejoint. Passage au chat.", team: "Nous vous passons l'équipe. Passage au chat.", unavailable: "La voix n'est pas disponible pour le moment. Vous pouvez continuer par chat.", busy: "La voix est occupée. Continuez par chat.", limit: "L'appel a atteint sa durée maximale. Vous pouvez continuer par chat.", ended: "Appel terminé" },
    de: { end_s: "Beenden", connecting: "Verbinden…", listening: "Ich höre zu…", thinking: "Ich überlege…", speaking: "Ich spreche…", muted: "Stumm", mute: "Stummschalten", unmute: "Mikrofon an", sw: "Zum Chat wechseln", end: "Anruf beenden", type: "Hier tippen…", you: "Du", call: "Sprachanruf", end_q: "Anruf beenden?", keep: "Weitersprechen", away: "Der Anruf wurde beendet, während du weg warst.", lost: "Die Verbindung ist abgebrochen. Du kannst hier weiterchatten.", teammate: "Jemand aus dem Team ist dazugekommen. Wechsel zum Chat.", team: "Wir verbinden dich mit dem Team. Wechsel zum Chat.", unavailable: "Sprache ist gerade nicht verfügbar. Du kannst hier weiterchatten.", busy: "Sprache ist gerade belegt. Chatte hier weiter.", limit: "Der Anruf hat sein Zeitlimit erreicht. Du kannst hier weiterchatten.", ended: "Anruf beendet" },
    pt: { end_s: "Encerrar", connecting: "Conectando…", listening: "Ouvindo…", thinking: "Pensando…", speaking: "Falando…", muted: "Sem som", mute: "Silenciar", unmute: "Ativar microfone", sw: "Ir para o chat", end: "Encerrar chamada", type: "Digite aqui…", you: "Você", call: "Chamada de voz", end_q: "Encerrar a chamada?", keep: "Continuar falando", away: "A chamada terminou enquanto você estava ausente.", lost: "A conexão caiu. Você pode continuar pelo chat.", teammate: "Alguém da equipe entrou. Indo para o chat.", team: "Passando você para a equipe. Indo para o chat.", unavailable: "A voz não está disponível agora. Você pode continuar pelo chat.", busy: "A voz está ocupada. Continue pelo chat.", limit: "A chamada atingiu o limite de tempo. Você pode continuar pelo chat.", ended: "Chamada encerrada" },
    ar: { end_s: "إنهاء", connecting: "جارٍ الاتصال…", listening: "أستمع…", thinking: "أفكر…", speaking: "أتحدث…", muted: "مكتوم", mute: "كتم", unmute: "إلغاء الكتم", sw: "الانتقال إلى المحادثة", end: "إنهاء المكالمة", type: "اكتب هنا…", you: "أنت", call: "مكالمة صوتية", end_q: "إنهاء المكالمة؟", keep: "متابعة الحديث", away: "انتهت المكالمة أثناء غيابك.", lost: "انقطع الاتصال. يمكنك المتابعة هنا كتابةً.", teammate: "انضم أحد أعضاء الفريق. جارٍ الانتقال إلى المحادثة.", team: "نحوّلك إلى الفريق. جارٍ الانتقال إلى المحادثة.", unavailable: "الصوت غير متاح الآن. يمكنك المتابعة هنا كتابةً.", busy: "الصوت مشغول الآن. تابع هنا كتابةً.", limit: "وصلت المكالمة إلى الحد الزمني. يمكنك المتابعة هنا كتابةً.", ended: "انتهت المكالمة" }
  };
  var IC = {
    mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
    micOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18M9 9v2a3 3 0 0 0 5 2.2M15 9.5V6a3 3 0 0 0-5.7-1.3M5 11a7 7 0 0 0 11.3 5.5M19 11a7 7 0 0 1-.6 2.8M12 18v3"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    end: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>',
    cc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 10.5a2 2 0 1 0 0 3M17 10.5a2 2 0 1 0 0 3"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>'
  };

  function panel(d) {
    var S = d.S, ui = d.ui, api = d.api, esc = d.esc, el = d.el, sdk = d.sdk;
    var C = null;          // the call on screen
    var root = null, ref = {}, raf = 0, awayMsg = null;
    function vcfg() { return (S.eff && S.eff.voice) || {}; }
    function vui() { return vcfg().ui || {}; }
    function L(k) { var own = (vui().labels || {})[k === "sw" ? "switch" : k]; if (own && S.locale === ((S.eff.locale || {}).default || "en").slice(0, 2)) return own; return (STR[S.locale] && STR[S.locale][k]) || STR.en[k] || k; }
    // the End button's own word is short ("End"); a label the website wrote for it is used as it is
    function endShort() { var own = (vui().labels || {}).end; return own && L("end") === own ? own : (STR[S.locale] && STR[S.locale].end_s) || STR.en.end_s; }
    function color(c, f) { return d.safeColor(c, f); }

    function css() {
      var a = vui(), c1 = color(a.orb_1, "var(--accent)"), c2 = color(a.orb_2, "#c7a3ff");
      // the controls never leave the screen: the captions and what the agent shows (cards, a form) scroll between the orb and the buttons
      return ".vc{display:flex;flex-direction:column;align-items:stretch;gap:8px;height:100%;min-height:0;padding:4px 4px 2px}" +
        ".vo{display:flex;flex-direction:column;align-items:center;gap:4px;padding:6px 0 2px;flex:0 0 auto}.orb{margin:8px 0 10px}.vc.x .orb{margin:4px 0 6px}.vsr{display:flex;align-items:baseline;gap:6px}" +
        ".vm{flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:8px}" +
        ".vc.x .vo{padding:2px 0 0;gap:4px}.vc.x .orb{width:48px;height:48px;font-size:16px}.vc.x .vt{display:none}.vx .pcard{width:136px;min-width:136px;max-width:136px}" +
        ".orb{--lv:0;position:relative;width:72px;height:72px;border-radius:50%;background:radial-gradient(circle at 32% 28%," + c2 + "," + c1 + " 62%);box-shadow:0 0 0 calc(4px + var(--lv)*12px) color-mix(in srgb," + c1 + " 18%,transparent),0 6px 18px rgba(0,0,0,.16);transform:scale(calc(1 + var(--lv)*.12));transition:transform .08s linear,box-shadow .08s linear;display:flex;align-items:center;justify-content:center;overflow:hidden;color:#fff;font-weight:700;font-size:22px}" +
        ".orb img{width:56%;height:56%;object-fit:contain;border-radius:50%;background:rgba(255,255,255,.9)}" +
        // the logo is taken as transparent: no orb colour or disc behind it; the ring around it still shows the voice level
        ".orb:has(img.lg){background:transparent;box-shadow:0 0 0 calc(4px + var(--lv)*12px) color-mix(in srgb," + c1 + " 18%,transparent)}.orb img.lg{width:100%;height:100%;background:transparent}" +
        ".vc.s-listening .orb,.vc.s-connecting .orb,.vc.s-thinking .orb{animation:gxorb 2.4s ease-in-out infinite}.vc.s-muted .orb{filter:grayscale(.8);opacity:.75}@keyframes gxorb{50%{transform:scale(1.05)}}" +
        ".vs{font-weight:600;font-size:14px}.vt{font-size:12px;color:var(--ink2);font-variant-numeric:tabular-nums}" +
        ".vcap{flex:0 0 auto;display:flex;flex-direction:column;gap:6px;padding:0 10px;min-height:54px}.vcap p{margin:0;font-size:14px;line-height:1.4;color:var(--ink);overflow-wrap:anywhere}.vcap p b{color:var(--ink2);font-weight:600}.vcap p:not(:last-child){opacity:.6}.vcap[hidden]{display:none}" +
        ".vx{padding:0 6px}.vx:empty{display:none}.vx .msg{margin:0}.vx .msg .av{display:none}.vx .msg .col{max-width:100%}.vx .meta{display:none}" +
        ".vin{display:flex;align-items:center;gap:6px;flex:0 0 auto;margin:0 6px;border:1px solid var(--line);border-radius:14px;background:var(--card);padding:4px 4px 4px 12px}.vin:focus-within{border-color:var(--accent)}.vin input{flex:1;min-width:0;border:0;outline:none;background:transparent;color:var(--ink);font:inherit;padding:6px 0}.vin input::placeholder{color:var(--ink2);opacity:1}" +
        ".vin button{width:30px;height:30px;flex:0 0 auto;border:0;border-radius:50%;background:var(--accent);color:var(--on-accent);cursor:pointer;display:flex;align-items:center;justify-content:center}.vin button:disabled{background:var(--line);color:var(--ink2);cursor:default}.vin svg{width:16px;height:16px}" +
        ".vb{display:flex;gap:4px;justify-content:center;flex-wrap:wrap;flex:0 0 auto;padding:2px 2px 4px}.vb button{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--line);background:transparent;color:var(--ink2);border-radius:999px;padding:5px 10px;white-space:nowrap;font:inherit;font-size:12px;font-weight:500;cursor:pointer}.vb button:hover{color:var(--ink);border-color:var(--ink2)}.vb [data-v=mute][aria-pressed=true]{background:var(--line);color:var(--ink);border-color:var(--line)}.vb [data-v=cc][aria-pressed=false]{opacity:.55}" +
        ".vb svg{width:14px;height:14px}.vb .end{background:#dc2626;border-color:#dc2626;color:#fff}.vb .end:hover{background:#b91c1c;border-color:#b91c1c;color:#fff}" +
        ".vq{display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap;flex:0 0 auto;padding:10px;margin:0 6px;border:1px solid var(--line);border-radius:12px;background:var(--card);font-weight:600}.vq[hidden]{display:none}.vq button{border-radius:999px;padding:7px 13px;font:inherit;font-size:13px;font-weight:600;cursor:pointer;border:1px solid var(--line);background:var(--card);color:var(--ink)}.vq .end{background:#dc2626;border-color:#dc2626;color:#fff}" +
        "@media(max-width:640px){.vin input{font-size:16px}.vc{padding-top:14px}.orb{width:84px;height:84px}.vc.x .orb{width:56px;height:56px}}";
    }

    function avatar() {
      var a = vui().avatar, ap = S.eff.appearance || {};
      var src = a === "bot" ? ap.bot_avatar_url : a === "none" ? null : ap.logo_url;
      return src && /^https:\/\//i.test(src) ? '<img' + (a !== "bot" ? ' class="lg"' : "") + ' src="' + esc(src) + '" alt="">' : "";
    }
    function build() {
      root = el("div", "vc s-connecting"); root.setAttribute("role", "group"); root.setAttribute("aria-label", L("call"));
      root.innerHTML = '<div class="vo"><div class="orb" aria-hidden="true">' + avatar() + '</div><div class="vsr"><div class="vs" role="status" aria-live="polite"></div><div class="vt" aria-hidden="true">0:00</div></div></div>' +
        '<div class="vm"><div class="vcap" aria-live="polite" aria-relevant="additions text"></div><div class="vx"></div></div>' +
        '<div class="vq" role="alertdialog" aria-label="' + esc(L("end_q")) + '" hidden><span>' + esc(L("end_q")) + '</span><button type="button" class="end" data-v="end-yes">' + esc(L("end")) + '</button><button type="button" data-v="end-no">' + esc(L("keep")) + "</button></div>" +
        '<form class="vin" novalidate><input type="text" maxlength="1000" placeholder="' + esc(L("type")) + '" aria-label="' + esc(L("type")) + '" autocomplete="off"><button type="submit" aria-label="' + esc(L("send")) + '" disabled>' + IC.send + "</button></form>" +
        '<div class="vb"><button type="button" data-v="mute" aria-pressed="false">' + IC.mic + "<span>" + esc(L("mute")) + '</span></button><button type="button" data-v="cc" aria-pressed="true" aria-label="' + esc(L("cc_off")) + '" title="' + esc(L("cc_off")) + '">' + IC.cc + '</button>' +
        '<button type="button" data-v="switch">' + IC.chat + "<span>" + esc(L("sw")) + '</span></button><button type="button" class="end" data-v="end" aria-label="' + esc(L("end")) + '">' + IC.end + "<span>" + esc(endShort()) + "</span></button></div>";
      ref = { orb: root.querySelector(".orb"), st: root.querySelector(".vs"), tm: root.querySelector(".vt"), cap: root.querySelector(".vcap"), x: root.querySelector(".vx"), q: root.querySelector(".vq"), form: root.querySelector(".vin"), inp: root.querySelector(".vin input"), go: root.querySelector(".vin button"), mute: root.querySelector("[data-v=mute]"), cc: root.querySelector("[data-v=cc]") };
      var vm0 = root.querySelector(".vm");
      vm0.addEventListener("scroll", function () { if (C) C.stick = vm0.scrollHeight - vm0.scrollTop - vm0.clientHeight < 40; }, { passive: true });
      root.addEventListener("click", function (e) {
        var b = e.target.closest && e.target.closest("[data-v]"); if (!b || !C) return;
        var a = b.getAttribute("data-v");
        if (a === "mute") setMuted(!C.muted);
        else if (a === "cc") { C.cc = !C.cc; d.store.set("voice_cc", C.cc ? 1 : 0); paintCaptions(); }
        else if (a === "switch") leave("switch");
        else if (a === "end" || a === "end-yes") leave("end");
        else if (a === "end-no") { ref.q.hidden = true; C.after = null; ref.inp.focus(); }
      });
      ref.inp.addEventListener("input", function () { ref.go.disabled = !ref.inp.value.trim(); if (C && C.h) C.h.activity(); });   // the agent waits while the visitor types
      ref.inp.addEventListener("keydown", function (e) { if (e.key === "Escape") { e.stopPropagation(); askEnd(); } });
      ref.form.addEventListener("submit", function (e) { e.preventDefault(); var t = ref.inp.value.trim(); if (!t) return; ref.inp.value = ""; ref.go.disabled = true; say(t); });
    }
    function render() {
      if (!C) return;
      d.adopt(css());
      if (!root) build();
      if (!ui.body.contains(root)) { ui.body.textContent = ""; ui.body.appendChild(root); ui.body.scrollTop = 0; }
      paint(); paintCaptions(); paintExtras();
    }
    function status() { return !C || C.state === "connecting" ? "connecting" : C.muted ? "muted" : C.mode === "speaking" ? "speaking" : C.thinking ? "thinking" : "listening"; }
    function paint() {
      if (!root || !C) return;
      var s = status();
      root.className = "vc s-" + s + (C.x ? " x" : "");
      if (ref.st.textContent !== L(s)) ref.st.textContent = L(s);
      ref.mute.setAttribute("aria-pressed", C.muted ? "true" : "false");
      ref.mute.innerHTML = (C.muted ? IC.micOff : IC.mic) + "<span>" + esc(L(C.muted ? "unmute" : "mute")) + "</span>";
      var live = C.state === "live"; ref.inp.disabled = !live; ref.mute.disabled = !live;
    }
    function paintCaptions() {
      if (!root || !C) return;
      ref.cc.setAttribute("aria-pressed", C.cc ? "true" : "false"); ref.cc.title = L(C.cc ? "cc_off" : "cc_on"); ref.cc.setAttribute("aria-label", ref.cc.title);
      ref.cap.hidden = !C.cc;
      var brand = (S.eff.appearance || {}).brand_name || "AI", rows = C.caps.slice(-8);
      if (C.part) rows = rows.concat([{ role: "agent", text: C.part }]).slice(-8);
      ref.cap.innerHTML = rows.map(function (c) { return "<p><b>" + esc(c.role === "user" ? L("you") : brand) + ":</b> " + esc(c.text) + "</p>"; }).join("");
      follow();
    }
    // the newest line stays in view as it is spoken, unless the visitor scrolled up to read back
    function follow() { var vm = root && root.querySelector(".vm"); if (vm && (!C || C.stick !== false)) vm.scrollTop = vm.scrollHeight; }
    // product cards and forms the agent's tools posted into the conversation while it talks: the newest ones, as the thread draws them
    function paintExtras() {
      if (!root || !C) return;
      var list = S.msgs.filter(function (m) { var a = m.content_attributes || {}; return a.voice && a.voice.call_id === C.id && (m.content_type === "cards" || m.content_type === "form" || (a.products && a.products.length)); }).slice(-2);
      var key = list.map(function (m) { return m.id + ":" + JSON.stringify((m.content_attributes || {}).response || (m.content_attributes || {}).submitted || ""); }).join("|") + "|" + JSON.stringify(S.cart || {});
      if (key === C.xkey) return; C.xkey = key;
      ref.x.innerHTML = list.map(function (m) { return d.bubble(m, false, true, false); }).join("");
      C.x = list.length > 0; paint();   // with something to show, the orb makes room
      d.wire();
      follow();
    }
    function tick() {
      if (!C || !root) return;
      var s = C.t0 ? Math.floor((Date.now() - C.t0) / 1000) : 0;
      ref.tm.textContent = Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2);
      if (C.t0 && C.max && s > C.max * 60 + 5) finish("max_duration", L("limit"));   // the provider ends it at the limit; this is the safety net
    }
    function orbLoop() {
      cancelAnimationFrame(raf);
      if (win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      var step = function () { if (!C || !C.h || !root) return; ref.orb.style.setProperty("--lv", C.mode === "speaking" ? C.h.level().toFixed(2) : "0"); raf = requestAnimationFrame(step); };
      raf = requestAnimationFrame(step);
    }

    // ---- live transcript: final turns go to the conversation, buffered up to a second, retried until acknowledged
    function push(role, text, eventId) {
      if (!C || !text || text === HANDOFF_MARKER) return;
      C.q.push({ role: role, text: String(text).slice(0, 2000), event_id: (role === "user" ? "u" : "a") + (eventId != null ? eventId : "x" + (++C.n)), at: new Date().toISOString() });
      if (!C.ft) C.ft = setTimeout(flush, 800);
    }
    function flush(last) {
      if (!C) return Promise.resolve();
      var c = C; clearTimeout(c.ft); c.ft = 0;
      if (c.sending || !c.q.length || !c.id) return Promise.resolve();
      var batch = c.q.slice(0, 20); c.sending = true;
      return api("POST", "/conversations/" + c.chat + "/voice/turns", { call_id: c.id, turns: batch }, { keepalive: !!last }).then(function (r) {
        c.sending = false; c.q.splice(0, batch.length); c.fails = 0;
        if (C !== c || c.done) return;
        if (r && r.takeover) return takeover();
        if (r && r.handoff) return serverHandoff(r.reason || "rule");
        if (r && r.ended) return finish("error", L("lost"), true);
        if (c.q.length) c.ft = setTimeout(flush, 300);
      }, function () {
        c.sending = false; c.fails = (c.fails || 0) + 1;
        if (C === c && !c.done) c.ft = setTimeout(flush, Math.min(15000, 1000 * Math.pow(2, c.fails)));
      });
    }

    // ---- what the session tells us
    function onMessage(m) {
      if (!C) return;
      if (m.role === "user") {
        if (m.text === HANDOFF_MARKER) return;
        // text typed into the call comes back as a transcript: it is already on screen and in the queue
        if (C.typed && C.typed.text === m.text && Date.now() - C.typed.at < 8000) { C.typed = null; return; }
        C.thinking = true;
      } else { C.part = ""; C.thinking = false; }
      C.caps.push({ role: m.role, text: m.text }); if (C.caps.length > 12) C.caps.shift();
      push(m.role, m.text, m.eventId);
      paint(); paintCaptions();
    }
    function onPart(p) { if (!C || !p) return; if (p.type === "start") C.part = ""; if (p.text) C.part = (C.part || "") + p.text; if (p.type === "stop") C.part = ""; if (C.cc) paintCaptions(); }
    function onMode(m) {
      if (!C) return;
      C.mode = m === "speaking" ? "speaking" : "listening";
      if (C.mode === "speaking") { C.thinking = false; C.spoke = true; }
      else if (C.after && C.spoke) { var f = C.after; C.after = null; f(); }   // the agent finished its sentence: now leave
      paint();
    }
    /** after the agent's current sentence (or 6 s), whichever comes first */
    function afterSpeech(f) { if (!C) return; var c = C, did = false, go = function () { if (did || C !== c) return; did = true; clearTimeout(t); c.after = null; f(); }; var t = setTimeout(go, 6000); c.spoke = c.mode === "speaking"; c.after = go; }
    function setMuted(b) { if (!C || !C.h) return; C.muted = !!b; C.h.mute(C.muted); paint(); }
    /** typed text goes into the call; the agent answers it out loud */
    function say(text) {
      if (!C || !C.h || C.state !== "live") return;
      text = String(text).slice(0, 1000);
      C.typed = { text: text, at: Date.now() }; C.thinking = true;
      C.caps.push({ role: "user", text: text }); push("user", text, null);
      C.h.text(text); paint(); paintCaptions();
    }

    // ---- handing over (§6): every path ends in the text chat of the same conversation
    function sw(handoff, reason) { var c = C; return api("POST", "/conversations/" + c.chat + "/voice/switch", { call_id: c.id, handoff: !!handoff, reason: reason || null }, { keepalive: true }).then(function (r) { if (r && r.conversation && S.conv && S.conv.id === c.chat) { Object.assign(S.conv, r.conversation); d.sync(); } }, function () {}); }
    /** the agent called switch_to_chat: it says its sentence, then the call ends */
    function agentSwitch(p) {
      if (!C || C.leaving) return; C.leaving = true;
      var handoff = !!(p && p.handoff), reason = String((p && p.reason) || (handoff ? "agent" : "show_text")).slice(0, 40);
      var done = sw(handoff, reason);
      afterSpeech(function () { done.then(function () { finish(handoff ? "handoff" : "switch", handoff ? L("team") : null, true, { handoff: handoff }); }); });
    }
    /** a handoff rule matched on the server (a keyword, too many turns): the agent says one line, unless it is mid-answer */
    function serverHandoff(reason) {
      if (!C || C.leaving) return; C.leaving = true;
      var c = C, done = sw(true, reason), end = function () { done.then(function () { finish("handoff", L("team"), true, { handoff: true }); }); };
      if (c.mode === "speaking" || !c.h) return end();
      c.h.context("The team is taking over this conversation now. Say exactly one short sentence: you are getting the team for that and switching the visitor to chat. Say nothing else and call no tool.");
      c.h.text(HANDOFF_MARKER);
      afterSpeech(end);
    }
    /** a teammate replied in the inbox during the call */
    function takeover() { if (!C || C.leaving) return; C.leaving = true; sw(false, "takeover").then(function () { finish("takeover", L("teammate"), true, { handoff: false }); }); }
    /** the visitor leaves: back to the thread ("switch") or done ("end") */
    function leave(how) {
      if (!C || C.leaving) return; C.leaving = true;
      var c = C;
      if (!c.id) return finish("visitor", null, true);
      if (how === "switch") sw(false, "visitor").then(function () { finish("switch", null, true, { handoff: false }); });
      else finish("visitor", null, false);
    }
    function askEnd(then) { if (!C) return then && then(); ref.q.hidden = false; C.onEnd = then || null; var b = ref.q.querySelector("button"); b && b.focus(); }

    /** The one way out. told = the server already knows (a switch); otherwise /voice/end reports why. */
    function finish(why, msg, told, extra) {
      if (!C || C.done) return;
      var c = C; c.done = true;
      clearInterval(c.tk); clearTimeout(c.ft); clearTimeout(c.away); cancelAnimationFrame(raf);
      doc.removeEventListener("visibilitychange", onHide);
      var tail = c.q.length && c.id ? api("POST", "/conversations/" + c.chat + "/voice/turns", { call_id: c.id, turns: c.q.splice(0, 20) }, { keepalive: true }).catch(function () {}) : Promise.resolve();
      if (c.h) c.h.end();
      if (c.id && !told) tail.then(function () { return api("POST", "/conversations/" + c.chat + "/voice/end", { call_id: c.id, reason: why }, { keepalive: true }); }).catch(function () {});
      var dur = c.t0 ? Math.round((Date.now() - c.t0) / 1000) : 0, after = c.onEnd;
      C = null; S.call = null; root = null; ref = {};
      if (c.id) (S.endedCalls = S.endedCalls || {})[c.id] = dur;   // the thread's line for this call reads "Call ended" at once
      if (c.id) sdk.emit("voice:ended", { call_id: c.id, duration_s: dur, reason: why });
      if (extra) sdk.emit("voice:switched", { handoff: !!extra.handoff });
      d.toChat(msg, why === "switch" || why === "handoff" || why === "takeover");
      if (after) after();
    }
    function fail(reason, e) {
      var code = reason === "busy" ? "busy" : reason === "mic" ? "mic" : reason === "consent" ? "consent" : "unavailable";
      sdk.emit("voice:error", { code: reason || "error", message: e && e.message });
      var c = C;
      if (c) { c.done = true; clearInterval(c.tk); clearTimeout(c.ft); if (c.h) c.h.end(); if (c.id) (S.endedCalls = S.endedCalls || {})[c.id] = 0; if (c.id) api("POST", "/conversations/" + c.chat + "/voice/end", { call_id: c.id, reason: "error" }, { keepalive: true }).catch(function () {}); }
      C = null; S.call = null; root = null; ref = {};
      d.failed(code, code === "busy" ? L("busy") : code === "unavailable" ? L("unavailable") : null);
    }
    function onHide() {
      if (!C) return;
      clearTimeout(C.away);
      if (doc.hidden) C.away = setTimeout(function () { awayMsg = L("away"); finish("visitor", null, false); }, 60000);   // a call nobody is at ends after a minute
    }
    doc.addEventListener("visibilitychange", function () { if (!doc.hidden && awayMsg) { var m = awayMsg; awayMsg = null; d.toast(m); } });

    function connect(c, retry) {
      return api("POST", "/conversations/" + c.chat + "/voice/start", { consent: true, locale: (S.locale || navigator.language || "en"), page: { url: location.href.slice(0, 500), title: doc.title.slice(0, 200) } }).then(function (r) {
        if (C !== c) return;
        if (!r || !r.ok) return fail((r && r.reason) || "unavailable");
        c.id = r.call_id; c.max = r.max_minutes; S.call = { id: c.id, chat: c.chat };
        return session({
          token: r.conversation_token, language: r.language, variables: r.dynamic_variables,
          clientTools: { switch_to_chat: function (p) { agentSwitch(p || {}); return "ok"; } },
          on: {
            message: onMessage, part: onPart, mode: onMode,
            error: function () { /* the session's end tells us what to do */ },
            end: function (reason) {
              if (C !== c || c.done) return;
              if (reason === "agent") return finish("agent_end_call", null, false);
              // the connection dropped: one automatic retry with a new token, then the thread, with the transcript kept
              if (!c.retried && !c.leaving && !doc.hidden) { c.retried = true; c.h = null; c.state = "connecting"; paint(); flush(); return connect(c, true); }
              finish("error", L("lost"), false);
            }
          }
        }).then(function (h) {
          if (C !== c || c.done) { h.end(); return; }
          c.h = h; c.state = "live"; c.mode = "listening"; if (!c.t0) c.t0 = Date.now();
          if (c.muted) h.mute(true);
          clearInterval(c.tk); c.tk = setInterval(tick, 1000);
          paint(); orbLoop();
          api("POST", "/conversations/" + c.chat + "/voice/turns", { call_id: c.id, turns: [] }).catch(function () {});   // the call is live (not only started)
          if (!retry) sdk.emit("voice:started", { call_id: c.id });
        });
      }).catch(function (e) {
        if (C !== c) return;
        var name = e && (e.name || ""), denied = name === "NotAllowedError" || name === "SecurityError" || /permission|denied|not allowed/i.test(String(e && e.message));
        fail(denied ? "mic" : e && e.code === "E_RATE_LIMITED" ? "busy" : "unavailable", e);
      });
    }

    return {
      /** start a call on the conversation that is open (S.conv). The microphone prompt was already answered by chat.js, inside the click. */
      start: function () {
        if (C || !S.conv) return Promise.resolve();
        C = { chat: S.conv.id, state: "connecting", mode: "listening", caps: [], q: [], n: 0, muted: false, cc: d.store.get("voice_cc") !== 0 && vui().captions !== false, thinking: false };
        doc.addEventListener("visibilitychange", onHide);
        render();
        return connect(C, false);
      },
      render: render,
      active: function () { return !!C; },
      /** a realtime message of the conversation while a call is on */
      onMessage: function (m) {
        if (!C || !m) return;
        if (m.sender_type === "agent") return takeover();
        paintExtras();
      },
      refresh: paintExtras,
      say: say,
      leave: leave,
      askEnd: askEnd
    };
  }

  win.__growthxaiWebchatVoice = { session: session, panel: panel, version: "1.0.0" };
})();
