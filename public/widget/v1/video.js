/*! GrowthxAI web chat — GIF / video bubble v1. Loaded by loader.js only for inboxes with settings.launcher.video set.
 *
 * With a media URL set, the launcher is that clip in a small bubble (muted, looping) with an X. A click expands it: the
 * clip restarts (with sound when allowed) and suggested questions sit over or below it. A control bar runs along the
 * bottom of the expanded clip, like a video player: the progress line, then play / pause, replay, sound and the time on
 * the left, and on the right the language menu (when the clips come in more than one language), "Voice chat" (when the
 * website's voice assistant is on and the page allows the microphone) and "Text" (launcher.video.cta_text, when set),
 * which opens the panel. On a phone (640px or narrower) the expanded view is the same player, across the width of the
 * screen, with smaller question chips.
 * A question is a text or {text, text_variants, video_url, video_kind, video_variants, link_url, link_text}:
 *   - with its own clip: the clip plays in place of the main one; while it plays the other questions fade out so the
 *     clip can be seen (hovering the questions, pausing or the end of the clip brings them back), and its page link
 *     (when set) shows as a button that opens the page in a new tab;
 *   - with a page link only: the page opens in a new tab;
 *   - with neither: the panel opens and the question is sent.
 * Languages: launcher.video.languages = [{code, label, flag}] (the first is the default) with the main clip per language in
 * `variants`, a question's clip per language in `video_variants` ([{lang, url, kind}]) and its wording per language in
 * `text_variants` ([{lang, text}], migration 072). The language menu switches every clip and question to that language
 * (the choice is kept in localStorage `gxwc:<token>:vlang`; before any choice the browser's language decides). A clip or
 * wording missing in a language falls back to the default one. `url` / `video_url` / `text` stay the default language's.
 * X on the expanded view collapses it; X on the bubble hides it for this browser session and the normal launcher takes
 * over ("Watch video" in the panel menu brings it back). No media, a load error or a closed bubble = the existing
 * launcher, unchanged.
 *
 * Everything renders inside the loader's closed Shadow DOM; the factory below gets the loader's helpers as `L`.
 */
(function () {
  "use strict";
  if (window.__growthxaiWebchatVideo) return;
  var doc = document, win = window;
  var REPLAY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>';
  var VOL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5L6 9H2v6h4l5 4z"/><path class="on" d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/><path class="off" d="M22 9l-6 6M16 9l6 6"/></svg>';
  var PLAY = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
  var PP = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path class="pl" d="M8 5v14l11-7z"/><path class="pa" d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>';
  var MIC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
  var CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>';
  var TICK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7"/></svg>';
  var EXT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';
  var CLIP = /^(https:\/\/[^\s"<>]+|preset:[\w.-]+)$/i, LINK = /^https:\/\/[^\s"<>]+$/i, IMG = /\.(gif|webp|a?png|jpe?g)(\?|#|$)/i;
  function num(v, lo, hi, d) { v = parseFloat(v); return isNaN(v) ? d : Math.max(lo, Math.min(hi, v)); }
  function ratio(r, d) { var m = /^(\d{1,2}):(\d{1,2})$/.exec(r || ""); return m && +m[1] && +m[2] ? m[1] + "/" + m[2] : d; }
  function clock(s) { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2); }
  var DEF_CTA = /^\s*(chat with us|text)?\s*$/i;   // the chat button's default words, old and new
  var CODE = /^[a-z]{2,3}(-[a-z0-9]{2,8}){0,2}$/i, FLAG = /^[a-z]{2}(-[a-z]{2,4})?$/;
  // the languages the clips come in, in menu order; the first one is the default
  function languages(list) {
    var seen = {};
    return (Array.isArray(list) ? list : []).map(function (x) {
      var c = x && typeof x === "object" ? String(x.code || "") : "", k = c.toLowerCase();
      if (!CODE.test(c) || seen[k]) return null; seen[k] = 1;
      return { code: c, label: String(x.label || "").trim() || c, flag: FLAG.test(x.flag || "") ? x.flag : "" };
    }).filter(Boolean).slice(0, 8);
  }
  // one clip per language, in the order of the languages; with none, the single clip from before languages existed
  function clips(u, kind, variants, langs) {
    var out = [], list = Array.isArray(variants) ? variants : [];
    function one(lang, cu, ck) { return { lang: lang, url: cu, image: ck === "image" || (ck !== "video" && IMG.test(cu)) }; }
    langs.forEach(function (l) { var m = list.filter(function (x) { return x && x.lang === l.code && CLIP.test(x.url || ""); })[0]; if (m) out.push(one(l.code, m.url, m.kind)); });
    if (!out.length && CLIP.test(u || "")) out.push(one(null, u, kind));
    return out;
  }
  // a suggested question as the settings store it, worded in the language that is playing (else the default wording)
  function question(x, langs, code) {
    if (typeof x === "string") x = { text: x };
    if (!x || typeof x !== "object") return null;
    var t = String(x.text || "").trim(), tv = (Array.isArray(x.text_variants) ? x.text_variants : []).filter(function (y) { return y && y.lang === code && String(y.text || "").trim(); })[0];
    return t ? { text: tv ? String(tv.text).trim() : t, base: t, clips: clips(x.video_url, x.video_kind, x.video_variants, langs), link: LINK.test(x.link_url || "") ? x.link_url : null, label: String(x.link_text || "").trim() } : null;
  }

  win.__growthxaiWebchatVideo = function (L) {
    var esc = L.esc, safeColor = L.safeColor, sdk = L.sdk, vb = null, open = false, quiet = false;
    var lang = L.store ? L.store.get("vlang") : null;   // the language the visitor picked in the menu, if any
    // the language to play: the visitor's pick, else the browser's language (exact, then the same base language), else the default
    function want(langs) {
      var n = String(navigator.language || "").toLowerCase(), p = String(lang || "").toLowerCase();
      function by(f) { return langs.filter(function (l) { return f(l.code.toLowerCase()); })[0]; }
      var m = (p && by(function (c) { return c === p; })) || by(function (c) { return c === n; }) || (n && by(function (c) { return c.split("-")[0] === n.split("-")[0]; })) || langs[0];
      return m ? m.code : null;
    }
    function pick(list, code) { return list.filter(function (c) { return c.lang === code; })[0] || list[0] || null; }
    function rgba(h, a) { h = safeColor(h, "#111827").slice(1); if (h.length === 3) h = h.replace(/./g, "$&$&"); var n = parseInt(h, 16); return "rgba(" + (n >> 16 & 255) + "," + (n >> 8 & 255) + "," + (n & 255) + "," + a + ")"; }
    function url(u) { return /^preset:/i.test(u) ? L.base + "presets/" + u.slice(7) : u; }   // built-in clips ship next to this file
    function flagImg(l) { return l.flag ? '<img alt="" loading="lazy" decoding="async" src="' + esc(L.base + "flags/" + l.flag + ".svg") + '">' : "<span>" + esc(l.code.slice(0, 2).toUpperCase()) + "</span>"; }

    // ---- styles (appended to the launcher's stylesheet) ------------------------------------------------------------
    function css(e, l, side, accent) {
      var v = (e.launcher || {}).video; if (!v) return "";
      var sz = num(v.size, 64, 240, 120); if (L.isMobile()) sz = Math.max(64, Math.round(sz * .75));
      var circle = v.shape !== "rounded" && v.shape !== "square", bw = num(v.border_width, 0, 8, 3), fx = num(v.focus_x, 0, 100, 50) + "% " + num(v.focus_y, 0, 100, 50) + "%";
      var xo = circle ? Math.round(sz * .146) - 12 : -8, W = num(v.expanded_width, 280, 720, 420), ms = l.margin_side != null ? l.margin_side : 24, mb = l.margin_bottom != null ? l.margin_bottom : 24;
      var qbg = safeColor(v.question_bg, "#111827"), qc = safeColor(v.question_color, "#ffffff"), over = v.questions_position !== "below";
      var ww = "min(" + W + "px,calc(100vw - " + (ms * 2) + "px))";
      return ".vb{pointer-events:auto;position:relative;display:flex;flex-direction:column;align-items:" + (side === "left" ? "flex-start" : "flex-end") + ";gap:8px;animation:gxin .25s ease both}.vb.re{animation:none}" +
        ".vbf{position:relative;box-sizing:border-box;width:" + sz + "px;aspect-ratio:" + (circle ? "1/1" : ratio(v.ratio, "1/1")) + ";border-radius:" + (circle ? "50%" : v.shape === "square" ? "10px" : Math.round(sz * .22) + "px") + ";overflow:hidden;cursor:pointer;background:#111827;border:" + bw + "px solid " + safeColor(v.border_color, "#ffffff") + ";box-shadow:0 8px 24px rgba(0,0,0,.22);transition:width .28s cubic-bezier(.3,1.2,.5,1),border-radius .28s,transform .18s;outline-offset:3px}" +
        ".vb:not(.open) .vbf:hover{transform:scale(1.04)}.vbf:focus-visible{outline:2px solid " + accent + "}" +
        // the clip is never stretched: it covers (or fits inside) the bubble, anchored on the focus point, optionally zoomed
        ".vbm{display:block;width:100%;height:100%;object-fit:" + (v.fit === "contain" ? "contain" : "cover") + ";object-position:" + fx + ";transform:scale(" + (num(v.zoom, 100, 300, 100) / 100) + ");transform-origin:" + fx + "}" +
        ".vb.open .vbf{width:" + ww + ";container-type:inline-size;aspect-ratio:" + (v.expanded_ratio && v.expanded_ratio !== "auto" ? ratio(v.expanded_ratio, "16/9") : "var(--ar,16/9)") + ";max-height:calc(100dvh - " + (mb + 32) + "px);min-height:var(--mh,0px);border-radius:16px;border-width:0;cursor:default}.vb.open .vbm{transform:none;object-fit:cover}" +
        ".vbx{position:absolute;top:" + xo + "px;right:" + xo + "px;width:24px;height:24px;padding:0;border-radius:50%;border:0;background:#1f2937;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,.3);z-index:2}.vbx:hover{background:#000}.vbx svg{width:11px;height:11px}.vb.open .vbx{top:-10px;right:-10px;width:30px;height:30px}.vb.open .vbx svg{width:13px;height:13px}" +
        ".vb .badge{top:" + xo + "px;left:" + xo + "px;right:auto;z-index:2}.vb.open .badge{display:none}" +
        ".vbo{position:absolute;inset:0;display:none;flex-direction:column;justify-content:flex-end;pointer-events:none}.vb.open .vbo{display:flex}" +
        ".vbpl{position:absolute;top:50%;left:50%;width:56px;height:56px;margin:-28px 0 0 -28px;border-radius:50%;background:rgba(0,0,0,.45);color:#fff;display:none;align-items:center;justify-content:center}.vbpl svg{width:28px;height:28px;margin-left:3px}.vb.open.paused .vbpl{display:flex}" +
        // the bottom block: questions (when they sit over the clip) and the control bar, on a dark fade. The questions are
        // a two-column grid, never a stack: 2 = one row of two, 4 = 2 x 2, 3 = two then one; a single one takes the row.
        ".vbb{display:flex;flex-direction:column;gap:8px;padding:30px 10px 6px;background:linear-gradient(transparent,rgba(0,0,0,.66));pointer-events:auto;transition:background .3s}.vbb.playing{background:linear-gradient(transparent,rgba(0,0,0,.42))}" +
        ".vbq{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;pointer-events:auto}.vbq.one{grid-template-columns:minmax(0,1fr)}.vbq.below{display:none;width:" + ww + "}.vb.open .vbq.below{display:grid}" +
        ".vbq button{min-width:0;display:flex;align-items:center;gap:6px;border:0;border-radius:999px;padding:5px 10px;font:inherit;font-weight:600;font-size:12px;line-height:1.25;cursor:pointer;text-align:start;background:" + (over ? rgba(qbg, .78) : qbg) + ";color:" + qc + ";box-shadow:0 2px 8px rgba(0,0,0,.18);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);transition:transform .15s,opacity .25s}.vbq button:hover{transform:translateY(-1px);background:" + qbg + "}.vbq button:focus-visible{outline:2px solid #fff;outline-offset:1px}" +
        // while a question's clip plays, the others fade almost out of sight so the clip can be seen; hovering the
        // questions, a pause or the end of the clip brings them back. The question that is playing stays dim.
        ".vbq button.sel,.vbq button.sel:hover{opacity:.55;transform:none;box-shadow:none}.vbq.playing button:not(.sel){opacity:.12}.vbq.playing:not(.hold):hover button:not(.sel),.vbq.playing:has(:focus-visible) button:not(.sel){opacity:1}" +
        ".vba{position:absolute;top:0;left:0;background:#111827}" +
        ".vbl{grid-column:1/-1;min-width:0;display:none}.vbl.on{display:flex}.vbl a{display:inline-flex;align-items:center;gap:6px;max-width:100%;box-sizing:border-box;padding:7px 12px;border-radius:999px;background:rgba(255,255,255,.95);color:#111827;font-weight:600;font-size:12.5px;line-height:1.2;text-decoration:none;box-shadow:0 2px 8px rgba(0,0,0,.2)}.vbl a:hover{background:#fff}.vbl a:focus-visible{outline:2px solid " + accent + ";outline-offset:1px}.vbl svg{width:13px;height:13px;flex:0 0 auto}" +
        ".vbq b{flex:0 0 auto;width:16px;height:16px;box-sizing:border-box;border-radius:50%;border:1px solid currentColor;opacity:.8;font-size:9px;display:flex;align-items:center;justify-content:center}.vbq span{overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}.vbq .vbl span{display:block;white-space:nowrap;text-overflow:ellipsis}" +
        // the control bar
        ".vbc{display:flex;flex-direction:column;gap:2px;color:#fff}.vbp{height:12px;display:flex;align-items:center;cursor:pointer}.vbp span{flex:1;height:3px;border-radius:2px;background:rgba(255,255,255,.35);overflow:hidden;transition:height .15s}.vbp:hover span{height:5px}.vbp i{display:block;height:100%;width:0;background:#fff}" +
        ".vbr{display:flex;align-items:center;gap:4px;min-width:0}.vbr .sp{flex:1;min-width:4px}.vbk{display:contents}.vbk button,.vbln{flex:0 0 auto;height:32px;min-width:32px;padding:0;border:0;border-radius:999px;background:transparent;color:#fff;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font:inherit}.vbk button:hover,.vbln:hover{background:rgba(255,255,255,.18)}.vbk button:focus-visible,.vbln:focus-visible,.vbct:focus-visible{outline:2px solid #fff;outline-offset:1px}.vbr svg{width:18px;height:18px}" +
        ".vbtm{flex:0 0 auto;padding:0 4px;font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap;opacity:.9}" +
        ".vbr .off,.vbr .muted .on{display:none}.vbr .muted .off{display:inline}.vbr .pa{display:none}.vb:not(.paused) [data-v=play] .pl{display:none}.vb:not(.paused) [data-v=play] .pa{display:inline}.vb.nov .vbk,.vb.nov .vbp{display:none}" +
        // language menu: the flag of the language playing, opening a list above it
        ".vbg{position:relative;flex:0 0 auto}.vbln{gap:4px;padding:0 6px 0 4px}.vbln img,.vbln>span:first-child{width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:#374151;font-size:9px;font-weight:700;overflow:hidden}.vbln svg{width:12px;height:12px;transition:transform .15s}.vbln[aria-expanded=true] svg{transform:rotate(180deg)}" +
        ".vbm2{position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);width:max-content;min-width:150px;max-width:240px;max-height:220px;overflow:auto;margin:0;padding:6px;list-style:none;border-radius:12px;background:rgba(17,24,39,.96);box-shadow:0 10px 30px rgba(0,0,0,.35);display:none;z-index:3}.vbm2.on{display:block}" +
        ".vbm2 button{width:100%;display:flex;align-items:center;gap:9px;padding:7px 8px;border:0;border-radius:8px;background:transparent;color:#fff;font:inherit;font-size:13px;text-align:start;cursor:pointer}.vbm2 button:hover,.vbm2 button:focus-visible{background:rgba(255,255,255,.12);outline:none}.vbm2 img,.vbm2 button>span:first-child{width:20px;height:20px;flex:0 0 auto;border-radius:50%;background:#374151;font-size:9px;font-weight:700;display:flex;align-items:center;justify-content:center;overflow:hidden}.vbm2 em{flex:1;font-style:normal}.vbm2 svg{width:14px;height:14px;visibility:hidden}.vbm2 [aria-checked=true] svg{visibility:visible}" +
        // Voice / Text: two small pills at the right end of the bar, both in the player's own see-through look (like play / sound);
        // the website's colours never reach them (cta_bg / cta_color are kept in the settings but not used)
        ".vbct{flex:0 1 auto;min-width:0;display:inline-flex;align-items:center;gap:5px;height:30px;padding:0 11px;border:0;border-radius:999px;font:inherit;font-weight:600;font-size:12px;white-space:nowrap;cursor:pointer;background:rgba(255,255,255,.16);color:#fff;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}.vbct:hover{background:rgba(255,255,255,.28)}.vbct svg{width:14px;height:14px;flex:0 0 auto}.vbct span{min-width:0;overflow:hidden;text-overflow:ellipsis}" +
        // a narrow clip: the time goes first, then replay; the two pills tighten but keep their words ("Voice" / "Text" are short)
        "@container (max-width:480px){.vbtm{display:none}}@container (max-width:390px){.vbr [data-v=replay]{display:none}}@container (max-width:330px){.vbct{padding:0 8px;gap:4px;font-size:11.5px}.vbr{gap:2px}}@container (max-width:250px){.vbct span{display:none}}" +
        // Phones (.m, see build): the same player as on a large screen, questions and Voice / Text inside it, but
        // across the width of the screen (whatever expanded width the website set), with smaller chips.
        ".vb.m.open{position:fixed;left:10px;right:10px;bottom:calc(10px + env(safe-area-inset-bottom,0px));align-items:stretch}" +
        ".vb.m.open .vbf{width:100%;max-height:calc(100dvh - 20px)}.vb.m .vbq.below{width:auto}" +
        ".vb.m.open .vbx{top:8px;right:8px;background:rgba(0,0,0,.55)}" +
        ".vb.m .vbq button{padding:4px 9px;gap:5px;font-size:11px}.vb.m .vbq b{width:14px;height:14px;font-size:8px}.vb.m .vbl a{padding:5px 10px;font-size:11.5px}" +
        ".vb.m .vbk button,.vb.m .vbln{height:36px;min-width:36px}";
    }

    // ---- expand / collapse -----------------------------------------------------------------------------------------
    function mute() { var b = vb && vb.el.querySelector("[data-v=mute]"), d = vb && (vb.av || vb.vid); if (b && d) { b.classList.toggle("muted", d.muted); b.setAttribute("aria-pressed", d.muted ? "true" : "false"); } }
    function set(on) {
      if (!vb || open === on) return;
      open = on; vb.el.classList.toggle("open", on); vb.el.classList.remove("paused"); vb.frame.setAttribute("aria-expanded", on ? "true" : "false");
      if (!on) { vb.clear(); vb.menu(false); }   // a question's clip never outlives the expanded view: the bubble always shows the main one
      vb.sync();
      var vd = vb.vid;
      if (vd) {
        try {
          vd.loop = !on; vd.muted = !on || vb.v.sound === false; if (on) vd.currentTime = 0;
          // a browser that refuses sound here still plays the clip muted (a play() cut short by a pause is not a refusal)
          var pr = vd.play(); if (pr && pr.catch) pr.catch(function (e) { if (e && e.name !== "NotAllowedError") return; vd.muted = true; mute(); var p2 = vd.play(); p2 && p2.catch && p2.catch(function () {}); });
        } catch (x) {}
        mute();
      }
      if (on) { L.hidePopup(); L.prefetchChat(); }
      if (!quiet) L.emit(on ? "video:opened" : "video:closed", {});
    }
    doc.addEventListener("click", function (ev) { if (open && ev.target !== L.host()) set(false); });   // clicks inside the closed shadow root arrive retargeted to the host
    doc.addEventListener("keydown", function (ev) { if (open && ev.key === "Escape") { if (vb && vb.menu()) vb.menu(false); else set(false); } });

    // ---- build -----------------------------------------------------------------------------------------------------
    function build(v, key) {
      var langs = languages(v.languages), code = want(langs), mains = clips(v.url, v.kind, v.variants, langs), mc = pick(mains, code);
      var isImg = mc.image, u = esc(url(mc.url)), now = langs.filter(function (l) { return l.code === code; })[0] || null;
      // on a phone the player spans the screen (class "m"); everything else is laid out as on a large screen
      var mob = L.isMobile(), qs = (Array.isArray(v.questions) ? v.questions : []).map(function (x) { return question(x, langs, code); }).filter(Boolean).slice(0, 6), below = v.questions_position === "below";
      // the button that opens the chat says "Text" (in the page's language) unless the website set its own words;
      // "Chat with us" was the default before, so it counts as unset
      var label = DEF_CTA.test(v.cta_text || "") ? L.i18n("text") || "Text" : String(v.cta_text).trim();
      var ctl = !isImg || qs.some(function (x) { return x.clips.some(function (c) { return !c.image; }); });   // play / progress / sound: whenever some clip here is a video
      var voice = L.voice ? L.voice() : null;
      var acts = (voice ? '<button type="button" class="vbct" data-v="voice">' + MIC + "<span>" + esc(voice.label || L.i18n("voice_chat") || "Voice") + "</span></button>" : "") +
        '<button type="button" class="vbct cta" data-v="chat">' + L.ICON + "<span>" + esc(label) + "</span></button>";
      var q = '<div class="vbq ' + (below ? "below" : "over") + (qs.length === 1 ? " one" : "") + '"><div class="vbl"><a target="_blank" rel="noopener noreferrer">' + EXT + "<span></span></a></div>" +
        qs.map(function (t, i) { return '<button type="button" data-q="' + i + '"' + (t.clips.length ? ' aria-pressed="false"' : "") + "><b>" + String.fromCharCode(65 + i) + "</b><span>" + esc(t.text) + "</span></button>"; }).join("") + "</div>";
      var bar = '<div class="vbc">' + (ctl ? '<div class="vbp" role="slider" aria-label="Progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" tabindex="-1"><span><i></i></span></div>' : "") +
        '<div class="vbr">' + (ctl ? '<span class="vbk"><button type="button" data-v="play" aria-label="Play / pause">' + PP + '</button><button type="button" data-v="replay" aria-label="Replay">' + REPLAY + '</button><button type="button" data-v="mute" aria-label="Sound">' + VOL + '</button><span class="vbtm" aria-hidden="true">0:00</span></span>' : "") +
        '<span class="sp"></span>' +
        (langs.length > 1 && now ? '<div class="vbg"><button type="button" class="vbln" aria-haspopup="true" aria-expanded="false" aria-label="' + esc((L.i18n("lang") || "Video language") + ": " + now.label) + '" title="' + esc(now.label) + '">' + flagImg(now) + CHEV + "</button>" +
          '<ul class="vbm2" role="menu">' + langs.map(function (l) { return '<li role="none"><button type="button" role="menuitemradio" data-l="' + esc(l.code) + '" aria-checked="' + (l.code === code) + '">' + flagImg(l) + "<em>" + esc(l.label) + "</em>" + TICK + "</button></li>"; }).join("") + "</ul></div>" : "") +
        acts + "</div></div>";
      var el = doc.createElement("div"); el.className = "vb" + (mob ? " m" : "");
      el.innerHTML = '<div class="vbf" role="button" tabindex="0" aria-expanded="false" aria-label="' + esc(L.i18n("chat")) + '">' +
        (isImg ? '<img class="vbm" alt="" src="' + u + '">' : '<video class="vbm" src="' + u + '" muted loop playsinline preload="metadata"></video>') +
        '<div class="vbo">' + (ctl ? '<span class="vbpl">' + PLAY + "</span>" : "") + '<div class="vbb">' + (below ? "" : q) + bar + "</div></div></div>" + (below ? q : "") +
        '<button class="vbx" type="button" aria-label="' + esc(L.i18n("close")) + '">' + L.CLOSE + "</button>";
      var o = { el: el, key: key, v: v, frame: el.querySelector(".vbf"), vid: isImg ? null : el.querySelector("video"), ans: null, av: null, sel: -1, lang: null }, media = el.querySelector(".vbm"), bar_ = el.querySelector(".vbp i");
      var qbox = el.querySelector(".vbq"), bb = el.querySelector(".vbb"), qb = Array.prototype.slice.call(el.querySelectorAll(".vbq button[data-q]")), lw = el.querySelector(".vbl"), la = lw.firstChild, tm = el.querySelector(".vbtm");
      var lb = el.querySelector(".vbln"), lm = el.querySelector(".vbm2");
      function cur() { return o.av || o.vid; }   // the video the controls act on: a question's clip while one is up, else the main clip
      // The bottom block over the clip: the frame grows to hold every question and the bar (a wide clip in a narrow
      // frame is short), so nothing is ever cut off, whatever the number of rows.
      o.fit = function () { el.style.setProperty("--mh", open ? (bb.offsetHeight + 28) + "px" : "0px"); };
      o.sync = function () { o.fit(); };
      // the language menu: open / closed (no argument = is it open)
      o.menu = function (on) {
        if (!lm) return false;
        if (on === undefined) return lm.classList.contains("on");
        lm.classList.toggle("on", !!on); lb.setAttribute("aria-expanded", on ? "true" : "false");
        if (on) {
          // straight above the flag, centred on it, but never past the clip's edges (the frame clips what overflows)
          lm.style.left = lm.style.transform = "";
          try {
            var fr = o.frame.getBoundingClientRect(), gr = lb.getBoundingClientRect(), pr = lb.parentNode.getBoundingClientRect(), mw = lm.offsetWidth;
            var x = Math.max(fr.left + 8, Math.min(fr.right - 8 - mw, gr.left + gr.width / 2 - mw / 2));
            lm.style.transform = "none"; lm.style.left = Math.round(x - pr.left) + "px";
          } catch (x) {}
          var c = lm.querySelector('[aria-checked="true"]') || lm.querySelector("button"); c && c.focus();
        }
        return !!on;
      };
      if (lb) {
        lb.addEventListener("click", function (ev) { ev.stopPropagation(); o.menu(!o.menu()); });
        lm.addEventListener("click", function (ev) {
          ev.stopPropagation(); var b = ev.target.closest ? ev.target.closest("button[data-l]") : null; if (!b) return;
          o.menu(false); if (b.getAttribute("aria-checked") !== "true") relang(b.getAttribute("data-l")); else lb.focus();
        });
        lm.addEventListener("keydown", function (ev) {
          var items = Array.prototype.slice.call(lm.querySelectorAll("button")), i = items.indexOf(ev.target.closest ? ev.target.closest("button") : null);
          if (ev.key === "ArrowDown" || ev.key === "ArrowUp") { ev.preventDefault(); ev.stopPropagation(); var n = items[(i + (ev.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]; n && n.focus(); }
          else if (ev.key === "Escape") { ev.stopPropagation(); o.menu(false); lb.focus(); }
        });
        // a flag file that is missing leaves the language's two letters
        Array.prototype.forEach.call(el.querySelectorAll(".vbg img"), function (im) { im.addEventListener("error", function () { var b = im.closest("[data-l]"), s = doc.createElement("span"); s.textContent = (b ? b.getAttribute("data-l") : code || "").slice(0, 2).toUpperCase(); im.parentNode.replaceChild(s, im); }); });
      }
      qbox.addEventListener("mouseleave", function () { qbox.classList.remove("hold"); });
      if (win.ResizeObserver) { try { new ResizeObserver(function () { o.fit(); }).observe(bb); } catch (x) {} }
      // expanded ratio "auto" = the clip's own, kept between 9:16 and 16:9
      function ar(w, h) { if (w && h) el.style.setProperty("--ar", Math.max(.5625, Math.min(1.7778, w / h)).toFixed(4)); }
      function play(d) { var pr = d.play(); if (pr && pr.catch) pr.catch(function (e) { if (e && e.name !== "NotAllowedError") return; d.muted = true; mute(); var p2 = d.play(); p2 && p2.catch && p2.catch(function () {}); }); }
      function toggle() { var d = cur(); if (!d) return; if (d.paused) { if (d.ended) d.currentTime = 0; play(d); } else d.pause(); }
      function act() { if (!open) { set(true); return; } if (o.menu()) { o.menu(false); return; } toggle(); }
      function time(d) {
        if (!d || d !== cur()) return;
        var p = d.duration ? d.currentTime / d.duration * 100 : 0;
        if (bar_) bar_.style.width = p + "%";
        if (tm) tm.textContent = clock(d.currentTime) + (d.duration && isFinite(d.duration) ? " / " + clock(d.duration) : "");
      }
      // which question is up: its button is dim while its clip plays, the others fade while it plays, its page link shows
      function mark() {
        var live = o.sel >= 0 && !(o.av && o.av.ended), playing = live && !!o.av && !o.av.paused, t = o.sel >= 0 ? qs[o.sel] : null;
        qb.forEach(function (b, i) { var on = live && i === o.sel; b.classList.toggle("sel", on); if (b.hasAttribute("aria-pressed")) b.setAttribute("aria-pressed", on ? "true" : "false"); });
        qbox.classList.toggle("playing", playing); bb.classList.toggle("playing", playing);
        if (t && t.link) { la.href = t.link; la.lastChild.textContent = t.label || L.i18n("more") || "Learn more"; } else la.removeAttribute("href");
        lw.classList.toggle("on", !!(t && t.link));
        el.classList.toggle("nov", !cur());
        if (!cur() && tm) tm.textContent = "";
        o.sync();
      }
      function wire(d) {
        d.addEventListener("timeupdate", function () { if (open) time(d); });
        d.addEventListener("loadedmetadata", function () { time(d); });
        ["play", "pause", "ended"].forEach(function (ev) { d.addEventListener(ev, function () { if (d !== cur()) return; el.classList.toggle("paused", open && (d.paused || d.ended)); if (d === o.av) mark(); }); });
      }
      // back to the main clip (the view was collapsed, or the question's clip would not load)
      o.clear = function (resume) {
        var a = o.ans; if (!a) return;
        o.ans = o.av = null; o.sel = -1; o.lang = null;
        try { if (a.pause) { a.pause(); a.removeAttribute("src"); a.load(); } } catch (x) {}
        a.remove(); el.classList.remove("paused"); if (bar_) bar_.style.width = "0";
        if (o.vid) ar(o.vid.videoWidth, o.vid.videoHeight); else ar(media.naturalWidth, media.naturalHeight);
        mark(); mute(); time(o.vid);
        if (resume && open && o.vid) play(o.vid);
      };
      // a question with its own clip: it plays over the main one, inside the same frame, with the same controls
      function answer(i) {
        var t = qs[i], c = pick(t.clips, code), d = cur(), muted = d ? d.muted : v.sound === false, a;
        if (!c) return;
        if (o.sel === i && o.ans) { if (o.av) { o.av.currentTime = 0; play(o.av); } return; }
        o.clear();
        a = doc.createElement(c.image ? "img" : "video"); a.className = "vbm vba";
        a.addEventListener("error", function () { if (o.ans === a) o.clear(true); });
        if (c.image) { a.alt = ""; a.addEventListener("load", function () { if (o.ans === a) ar(a.naturalWidth, a.naturalHeight); }); }
        else {
          a.setAttribute("playsinline", ""); a.playsInline = true; a.preload = "auto"; a.muted = muted; wire(a);
          a.addEventListener("loadedmetadata", function () { if (o.ans === a) ar(a.videoWidth, a.videoHeight); });
        }
        if (o.vid) { try { o.vid.pause(); } catch (x) {} }
        o.ans = a; o.av = c.image ? null : a; o.sel = i; o.lang = c.lang;
        a.src = url(c.url); o.frame.insertBefore(a, o.frame.querySelector(".vbo"));
        el.classList.remove("paused"); if (bar_) bar_.style.width = "0"; if (tm) tm.textContent = "0:00";
        mark(); mute();
        if (o.av) play(a);
      }
      o.answer = answer;
      media.addEventListener("error", function () { open = false; L.fail(); });
      if (o.vid) {
        o.vid.muted = true; wire(o.vid);
        o.vid.addEventListener("loadedmetadata", function () { if (!o.ans) ar(o.vid.videoWidth, o.vid.videoHeight); });
      } else media.addEventListener("load", function () { if (!o.ans) ar(media.naturalWidth, media.naturalHeight); });
      if (ctl) {
        el.querySelector("[data-v=play]").addEventListener("click", function (ev) { ev.stopPropagation(); toggle(); });
        el.querySelector("[data-v=replay]").addEventListener("click", function (ev) { ev.stopPropagation(); var d = cur(); if (d) { d.currentTime = 0; play(d); } });
        el.querySelector("[data-v=mute]").addEventListener("click", function (ev) { ev.stopPropagation(); var d = cur(); if (d) { d.muted = !d.muted; mute(); } });
        el.querySelector(".vbp").addEventListener("click", function (ev) { ev.stopPropagation(); var d = cur(), r = this.getBoundingClientRect(); if (d && d.duration && r.width) d.currentTime = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * d.duration; });
      }
      bb.addEventListener("click", function (ev) { if (ev.target === bb) { ev.stopPropagation(); act(); } });   // the fade behind the buttons is still the clip
      el.querySelector("[data-v=chat]").addEventListener("click", function (ev) { ev.stopPropagation(); L.emit("video:chat", {}); set(false); sdk.open(); });
      var vo = el.querySelector("[data-v=voice]");
      if (vo) {
        vo.addEventListener("click", function (ev) { ev.stopPropagation(); L.emit("video:voice", {}); set(false); sdk.call({ source: "voice" }); });
        vo.addEventListener("mouseenter", function () { if (L.prefetchVoice) L.prefetchVoice(); });
      }
      mark();
      o.frame.addEventListener("click", act);
      o.frame.addEventListener("keydown", function (ev) { if (ev.target === o.frame && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); act(); } });
      o.frame.addEventListener("mouseenter", L.prefetchChat);
      el.querySelector(".vbx").addEventListener("click", function (ev) {
        ev.stopPropagation();
        if (open) { set(false); o.frame.focus(); return; }
        L.dismiss();
      });
      // the page link of the question that is up: a normal link in a new tab; the clip stops talking over the new page
      la.addEventListener("click", function (ev) {
        ev.stopPropagation(); if (!la.getAttribute("href")) { ev.preventDefault(); return; }
        if (o.av) { try { o.av.pause(); } catch (x) {} }
        L.emit("video:link", { url: la.href, index: o.sel });
      });
      la.addEventListener("keydown", function (ev) { ev.stopPropagation(); });
      qb.forEach(function (b) {
        b.addEventListener("click", function (ev) {
          ev.stopPropagation(); var i = +b.getAttribute("data-q"), t = qs[i];
          if (!t) return;
          L.emit("video:question", { text: t.text, index: i, action: t.clips.length ? "video" : t.link ? "link" : "chat" });
          // the pointer is still on the questions after the click: they fade anyway, and hovering brings them back only
          // once it has left and come back
          if (t.clips.length) { qbox.classList.add("hold"); answer(i); return; }
          if (t.link) { L.emit("video:link", { url: t.link, index: i }); try { win.open(t.link, "_blank", "noopener,noreferrer"); } catch (x) {} return; }
          set(false); sdk.send(t.text);
        });
      });
      return o;
    }

    // ---- render (called from the loader's renderLauncher; v = null hides the bubble) ----------------------------------
    function render(v) {
      if (!v) { if (vb) { if (open) set(false); if (vb.vid) { try { vb.vid.pause(); } catch (x) {} } vb.el.classList.add("hidden"); } return false; }
      var vc = L.voice ? L.voice() : null;
      var key = JSON.stringify(v) + "|" + L.locale() + "|" + (lang || "") + "|" + (vc ? vc.label || "1" : "") + "|" + (L.isMobile() ? "m" : "d");
      if (!vb || vb.key !== key) {
        var was = open;
        if (vb) { try { vb.clear(); if (vb.vid) vb.vid.pause(); } catch (x) {} vb.el.remove(); open = false; }
        vb = build(v, key); if (was) vb.el.className = "vb open re";
        L.wrap().insertBefore(vb.el, L.btn()); if (was) set(true);
      }
      vb.el.classList.remove("hidden");
      var bd = vb.el.querySelector(".badge"), n = L.unread(); if (bd) bd.remove();
      if (n > 0) { bd = doc.createElement("span"); bd.className = "badge"; bd.textContent = n > 9 ? "9+" : n; vb.el.appendChild(bd); }
      if (vb.vid && vb.vid.paused && !open && autoplay()) { var pr = vb.vid.play(); pr && pr.catch && pr.catch(function () {}); }
      return true;
    }
    // loops by itself only without reduced motion / Data Saver and in a visible tab; else the first frame, played on click
    function autoplay() {
      var c = navigator.connection;
      return !doc.hidden && !(c && c.saveData) && !(win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches);
    }
    doc.addEventListener("visibilitychange", function () {
      if (!vb || !vb.vid || open || vb.el.classList.contains("hidden")) return;
      if (doc.hidden) { try { vb.vid.pause(); } catch (x) {} }
      else if (vb.vid.paused && autoplay()) { var pr = vb.vid.play(); pr && pr.catch && pr.catch(function () {}); }
    });

    // crossing the phone width (a rotation, a resized window) rebuilds the bubble for the other layout
    var mq = win.matchMedia ? win.matchMedia("(max-width: 640px)") : null;
    function relayout() { if (!vb || vb.el.classList.contains("hidden")) return; quiet = true; try { render(vb.v); } finally { quiet = false; } }
    if (mq) { try { mq.addEventListener("change", relayout); } catch (x) { try { mq.addListener(relayout); } catch (y) {} } }

    // A language from the menu: every clip and question switches to it. The bubble is rebuilt for it (the main clip may
    // be a video in one language and a GIF in another), stays expanded, keeps the visitor's sound choice and the question that was up.
    function relang(c) {
      if (!vb) return;
      var v = vb.v, sel = vb.sel, d = vb.av || vb.vid, muted = d ? d.muted : null;
      lang = c; if (L.store) L.store.set("vlang", c);
      L.emit("video:language", { code: c });
      quiet = true; try { render(v); } finally { quiet = false; }   // a rebuild, not the visitor opening the view again
      d = vb.vid; if (d && muted != null) { d.muted = muted; mute(); }
      if (sel >= 0) vb.answer(sel);
      var lb = vb.el.querySelector(".vbln"); if (lb) lb.focus();
    }

    return { css: css, render: render, open: function () { set(true); }, isOpen: function () { return open; }, node: function () { return vb && vb.el.parentNode && !/hidden/.test(vb.el.className) ? vb.el : null; } };
  };
})();
