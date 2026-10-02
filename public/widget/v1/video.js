/*! GrowthxAI web chat — GIF / video bubble v1. Loaded by loader.js only for inboxes with settings.launcher.video set.
 *
 * With a media URL set, the launcher is that clip in a small bubble (muted, looping) with an X. A click expands it: the
 * clip restarts (with sound when allowed) and suggested questions + "Chat with us" sit over or below it. "Chat with us"
 * opens the panel. A question is a text or {text, video_url, video_kind, link_url, link_text}:
 *   - with its own clip: the clip plays in place of the main one, the question's button dims while it plays, the other
 *     buttons stay as they are, and its page link (when set) shows as a button that opens the page in a new tab;
 *   - with a page link only: the page opens in a new tab;
 *   - with neither: the panel opens and the question is sent.
 * Languages: launcher.video.languages = [{code, label, flag}] (the first is the default) with the main clip per language in
 * `variants` and a question's clip per language in `video_variants` ([{lang, url, kind}]). When the clip that is up exists
 * in more than one language, a strip of round flags sits beside the expanded view; a flag switches every clip to that
 * language (the choice is kept in localStorage `gxwc:<token>:vlang`; before any choice the browser's language decides).
 * A clip that exists in one language only shows no strip. `url` / `video_url` stay the default-language clip.
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
  var EXT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';
  var CLIP = /^(https:\/\/[^\s"<>]+|preset:[\w.-]+)$/i, LINK = /^https:\/\/[^\s"<>]+$/i, IMG = /\.(gif|webp|a?png|jpe?g)(\?|#|$)/i;
  function num(v, lo, hi, d) { v = parseFloat(v); return isNaN(v) ? d : Math.max(lo, Math.min(hi, v)); }
  function ratio(r, d) { var m = /^(\d{1,2}):(\d{1,2})$/.exec(r || ""); return m && +m[1] && +m[2] ? m[1] + "/" + m[2] : d; }
  var CODE = /^[a-z]{2,3}(-[a-z0-9]{2,8}){0,2}$/i, FLAG = /^[a-z]{2}(-[a-z]{2,4})?$/;
  // the languages the clips come in, in strip order; the first one is the default
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
  // a suggested question as the settings store it: a text, or {text, video_url, video_kind, video_variants, link_url, link_text}
  function question(x, langs) {
    if (typeof x === "string") x = { text: x };
    if (!x || typeof x !== "object") return null;
    var t = String(x.text || "").trim();
    return t ? { text: t, clips: clips(x.video_url, x.video_kind, x.video_variants, langs), link: LINK.test(x.link_url || "") ? x.link_url : null, label: String(x.link_text || "").trim() } : null;
  }

  win.__growthxaiWebchatVideo = function (L) {
    var esc = L.esc, safeColor = L.safeColor, sdk = L.sdk, vb = null, open = false, quiet = false;
    var lang = L.store ? L.store.get("vlang") : null;   // the language the visitor picked on the strip, if any
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

    // ---- styles (appended to the launcher's stylesheet) ------------------------------------------------------------
    function css(e, l, side, accent) {
      var v = (e.launcher || {}).video; if (!v) return "";
      var sz = num(v.size, 64, 240, 120); if (L.isMobile()) sz = Math.max(64, Math.round(sz * .75));
      var circle = v.shape !== "rounded" && v.shape !== "square", bw = num(v.border_width, 0, 8, 3), fx = num(v.focus_x, 0, 100, 50) + "% " + num(v.focus_y, 0, 100, 50) + "%";
      var xo = circle ? Math.round(sz * .146) - 12 : -8, W = num(v.expanded_width, 280, 720, 420), ms = l.margin_side != null ? l.margin_side : 24, mb = l.margin_bottom != null ? l.margin_bottom : 24;
      var qbg = safeColor(v.question_bg, "#111827"), qc = safeColor(v.question_color, "#ffffff"), over = v.questions_position !== "below";
      var ww = "min(" + W + "px,calc(100vw - " + (ms * 2) + "px))";
      return ".vb{pointer-events:auto;position:relative;display:flex;flex-direction:column;align-items:" + (side === "left" ? "flex-start" : "flex-end") + ";gap:8px;animation:gxin .25s ease both}" +
        ".vbf{position:relative;box-sizing:border-box;width:" + sz + "px;aspect-ratio:" + (circle ? "1/1" : ratio(v.ratio, "1/1")) + ";border-radius:" + (circle ? "50%" : v.shape === "square" ? "10px" : Math.round(sz * .22) + "px") + ";overflow:hidden;cursor:pointer;background:#111827;border:" + bw + "px solid " + safeColor(v.border_color, "#ffffff") + ";box-shadow:0 8px 24px rgba(0,0,0,.22);transition:width .28s cubic-bezier(.3,1.2,.5,1),border-radius .28s,transform .18s;outline-offset:3px}" +
        ".vb:not(.open) .vbf:hover{transform:scale(1.04)}.vbf:focus-visible{outline:2px solid " + accent + "}" +
        // the clip is never stretched: it covers (or fits inside) the bubble, anchored on the focus point, optionally zoomed
        ".vbm{display:block;width:100%;height:100%;object-fit:" + (v.fit === "contain" ? "contain" : "cover") + ";object-position:" + fx + ";transform:scale(" + (num(v.zoom, 100, 300, 100) / 100) + ");transform-origin:" + fx + "}" +
        ".vb.open .vbf{width:" + ww + ";aspect-ratio:" + (v.expanded_ratio && v.expanded_ratio !== "auto" ? ratio(v.expanded_ratio, "16/9") : "var(--ar,16/9)") + ";max-height:calc(100dvh - " + (mb + 32) + "px);min-height:var(--mh,0px);border-radius:16px;border-width:0;cursor:default}.vb.open .vbm{transform:none;object-fit:cover}" +
        ".vbx{position:absolute;top:" + xo + "px;right:" + xo + "px;width:24px;height:24px;padding:0;border-radius:50%;border:0;background:#1f2937;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,.3);z-index:2}.vbx:hover{background:#000}.vbx svg{width:11px;height:11px}.vb.open .vbx{top:-10px;right:-10px;width:30px;height:30px}.vb.open .vbx svg{width:13px;height:13px}" +
        ".vb .badge{top:" + xo + "px;left:" + xo + "px;right:auto;z-index:2}.vb.open .badge{display:none}" +
        ".vbo{position:absolute;inset:0;display:none;flex-direction:column;justify-content:space-between;pointer-events:none}.vb.open .vbo{display:flex}" +
        ".vbt{display:flex;align-items:center;gap:10px;padding:12px 44px 18px 12px;background:linear-gradient(rgba(0,0,0,.5),transparent);pointer-events:auto}.vbt button{width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center}.vbt button:hover{background:rgba(255,255,255,.18)}.vbt svg{width:18px;height:18px}" +
        ".vbt .off,.vbt .muted .on{display:none}.vbt .muted .off{display:inline}" +
        ".vbp{flex:1;height:14px;display:flex;align-items:center;cursor:pointer}.vbp span{flex:1;height:4px;border-radius:2px;background:rgba(255,255,255,.35);overflow:hidden}.vbp i{display:block;height:100%;width:0;background:#fff}" +
        ".vbpl{position:absolute;top:50%;left:50%;width:56px;height:56px;margin:-28px 0 0 -28px;border-radius:50%;background:rgba(0,0,0,.45);color:#fff;display:none;align-items:center;justify-content:center}.vbpl svg{width:28px;height:28px;margin-left:3px}.vb.open.paused .vbpl{display:flex}" +
        ".vbq{display:flex;flex-wrap:wrap;gap:8px;pointer-events:auto}.vbq.over{padding:30px 12px 12px;background:linear-gradient(transparent,rgba(0,0,0,.62))}.vbq.below{display:none;width:" + ww + "}.vb.open .vbq.below{display:flex}" +
        ".vbq button{flex:1 1 40%;min-width:0;display:flex;align-items:center;gap:8px;border:0;border-radius:999px;padding:9px 14px;font:inherit;font-weight:600;font-size:13px;line-height:1.25;cursor:pointer;text-align:start;background:" + (over ? rgba(qbg, .78) : qbg) + ";color:" + qc + ";box-shadow:0 2px 8px rgba(0,0,0,.18);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);transition:transform .15s,opacity .2s}.vbq button:hover{transform:translateY(-1px);background:" + qbg + "}.vbq button:focus-visible{outline:2px solid #fff;outline-offset:1px}" +
        // the question whose clip is playing is dimmed; the others turn solid so they read as the ones to click
        ".vbq.has button:not(.cta){background:" + qbg + "}.vbq button.sel,.vbq button.sel:hover{opacity:.5;transform:none;box-shadow:none}" +
        ".vba{position:absolute;top:0;left:0;background:#111827}.vb.nov .vbt{visibility:hidden}" +
        // language strip: a dark pill of round flags beside the expanded view (above it where there is no room beside)
        ".vb.re{animation:none}.vbs{position:absolute;bottom:0;" + (side === "left" ? "left" : "right") + ":calc(100% + 10px);display:none;flex-direction:column;align-items:center;gap:8px;box-sizing:border-box;padding:10px 8px;border-radius:999px;background:rgba(17,24,39,.92);box-shadow:0 8px 24px rgba(0,0,0,.22);max-height:calc(100dvh - " + (mb + 32) + "px);overflow:auto;scrollbar-width:none;pointer-events:auto}.vbs::-webkit-scrollbar{display:none}.vb.open .vbs.on{display:flex}" +
        ".vbs button{flex:0 0 auto;width:30px;height:30px;padding:0;border:0;border-radius:50%;background:#374151;color:#fff;font-family:inherit;font-weight:700;font-size:10px;cursor:pointer;opacity:.5;overflow:hidden;display:flex;align-items:center;justify-content:center;transition:opacity .15s,width .18s,height .18s}.vbs button:hover{opacity:1}.vbs button:focus-visible{outline:2px solid #fff;outline-offset:2px}.vbs button.on{width:42px;height:42px;opacity:1;box-shadow:0 0 0 3px #fff;cursor:default}.vbs img{display:block;width:100%;height:100%;border-radius:50%}" +
        "@media(max-width:" + (W + ms * 2 + 76) + "px){.vbs{bottom:calc(100% + 12px);left:0;right:auto;flex-direction:row;max-width:calc(" + ww + " - 28px);max-height:none;padding:8px 10px}.vb.open.hl .vbf{max-height:calc(100dvh - " + (mb + 104) + "px)}}" +
        ".vbl{flex:1 1 100%;min-width:0;display:none}.vbl.on{display:flex}.vbl a{display:inline-flex;align-items:center;gap:6px;max-width:100%;box-sizing:border-box;padding:7px 12px;border-radius:999px;background:rgba(255,255,255,.95);color:#111827;font-weight:600;font-size:12.5px;line-height:1.2;text-decoration:none;box-shadow:0 2px 8px rgba(0,0,0,.2)}.vbl a:hover{background:#fff}.vbl a:focus-visible{outline:2px solid " + accent + ";outline-offset:1px}.vbl svg{width:13px;height:13px;flex:0 0 auto}" +
        ".vbq b{flex:0 0 auto;width:20px;height:20px;border-radius:50%;border:1px solid currentColor;opacity:.8;font-size:10px;display:flex;align-items:center;justify-content:center}.vbq span{overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}.vbq .vbl span{display:block;white-space:nowrap;text-overflow:ellipsis}" +
        ".vbq .cta,.vbq .cta:hover{justify-content:center;background:" + safeColor(v.cta_bg, accent) + ";color:" + safeColor(v.cta_color, "#ffffff") + "}.vbq .cta svg{width:16px;height:16px;flex:0 0 auto}";
    }

    // ---- expand / collapse -----------------------------------------------------------------------------------------
    function mute() { var b = vb && vb.el.querySelector("[data-v=mute]"), d = vb && (vb.av || vb.vid); if (b && d) { b.classList.toggle("muted", d.muted); b.setAttribute("aria-pressed", d.muted ? "true" : "false"); } }
    function set(on) {
      if (!vb || open === on) return;
      open = on; vb.el.classList.toggle("open", on); vb.el.classList.remove("paused"); vb.frame.setAttribute("aria-expanded", on ? "true" : "false");
      if (!on) vb.clear();   // a question's clip never outlives the expanded view: the bubble always shows the main one
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
    doc.addEventListener("keydown", function (ev) { if (open && ev.key === "Escape") set(false); });

    // ---- build -----------------------------------------------------------------------------------------------------
    function build(v, key) {
      var langs = languages(v.languages), code = want(langs), mains = clips(v.url, v.kind, v.variants, langs), mc = pick(mains, code);
      var isImg = mc.image, u = esc(url(mc.url));
      var qs = (Array.isArray(v.questions) ? v.questions : []).map(function (x) { return question(x, langs); }).filter(Boolean).slice(0, 6), below = v.questions_position === "below", label = v.cta_text || L.i18n("chat");
      var ctl = !isImg || qs.some(function (x) { return x.clips.some(function (c) { return !c.image; }); });   // replay / progress / sound: whenever some clip here is a video
      var q = '<div class="vbq ' + (below ? "below" : "over") + '"><div class="vbl"><a target="_blank" rel="noopener noreferrer">' + EXT + "<span></span></a></div>" +
        qs.map(function (t, i) { return '<button type="button" data-q="' + i + '"' + (t.clips.length ? ' aria-pressed="false"' : "") + "><b>" + String.fromCharCode(65 + i) + "</b><span>" + esc(t.text) + "</span></button>"; }).join("") +
        '<button type="button" class="cta">' + L.ICON + "<span>" + esc(label) + "</span></button></div>";
      var el = doc.createElement("div"); el.className = "vb";
      el.innerHTML = '<div class="vbf" role="button" tabindex="0" aria-expanded="false" aria-label="' + esc(label) + '">' +
        (isImg ? '<img class="vbm" alt="" src="' + u + '">' : '<video class="vbm" src="' + u + '" muted loop playsinline preload="metadata"></video>') +
        '<div class="vbo">' + (!ctl ? "<span></span>" : '<div class="vbt"><button type="button" data-v="replay" aria-label="Replay">' + REPLAY + '</button><div class="vbp" role="slider" aria-label="Progress"><span><i></i></span></div><button type="button" data-v="mute" aria-label="Sound">' + VOL + "</button></div>") +
        (!ctl ? "" : '<span class="vbpl">' + PLAY + "</span>") + (below ? "" : q) + "</div></div>" + (below ? q : "") +
        '<button class="vbx" type="button" aria-label="' + esc(L.i18n("close")) + '">' + L.CLOSE + "</button>" +
        '<div class="vbs" role="group" aria-label="' + esc(L.i18n("lang") || "Video language") + '"></div>';
      var o = { el: el, key: key, v: v, frame: el.querySelector(".vbf"), vid: isImg ? null : el.querySelector("video"), ans: null, av: null, sel: -1, lang: null, sig: "" }, media = el.querySelector(".vbm"), bar = el.querySelector(".vbp i");
      var qbox = el.querySelector(".vbq"), qb = Array.prototype.slice.call(el.querySelectorAll(".vbq button[data-q]")), lw = el.querySelector(".vbl"), la = lw.firstChild;
      function cur() { return o.av || o.vid; }   // the video the controls act on: a question's clip while one is up, else the main clip
      // Buttons over the clip: the frame grows to hold the controls and every button (a wide clip in a narrow frame is
      // short), so no question is ever cut off, whatever the number of rows.
      var top = el.querySelector(".vbt"), sb = el.querySelector(".vbs");
      o.fit = function () { el.style.setProperty("--mh", open && !below ? ((top ? top.offsetHeight : 0) + qbox.offsetHeight) + "px" : "0px"); };
      // The language strip: only while expanded, and only when the clip that is up (the main one, or the answer of the
      // question that is up) exists in more than one language. The flag of the language playing is the large one.
      function strip() {
        var list = o.sel >= 0 ? qs[o.sel].clips : mains, on = open && list.length > 1, now = o.sel >= 0 ? o.lang : mc.lang;
        var sig = on ? list.map(function (c) { return c.lang; }).join("|") + ">" + now : "";
        sb.classList.toggle("on", on); el.classList.toggle("hl", on);
        if (sig === o.sig) return; o.sig = sig;
        sb.innerHTML = !on ? "" : list.map(function (c) {
          var l = langs.filter(function (x) { return x.code === c.lang; })[0], cur = c.lang === now;
          return '<button type="button" data-l="' + esc(l.code) + '"' + (cur ? ' class="on"' : "") + ' aria-pressed="' + cur + '" aria-label="' + esc(l.label) + '" title="' + esc(l.label) + '">' +
            (l.flag ? '<img alt="" src="' + esc(L.base + "flags/" + l.flag + ".svg") + '">' : "<span>" + esc(l.code.slice(0, 2).toUpperCase()) + "</span>") + "</button>";
        }).join("");
        // a flag file that is missing leaves the language's two letters
        Array.prototype.forEach.call(sb.querySelectorAll("img"), function (im) { im.addEventListener("error", function () { var s = doc.createElement("span"); s.textContent = im.parentNode.getAttribute("data-l").slice(0, 2).toUpperCase(); im.parentNode.replaceChild(s, im); }); });
      }
      o.sync = function () { o.fit(); strip(); };
      sb.addEventListener("click", function (ev) {
        ev.stopPropagation(); var b = ev.target.closest ? ev.target.closest("button[data-l]") : null;
        if (b && !b.classList.contains("on")) relang(b.getAttribute("data-l"));
      });
      sb.addEventListener("keydown", function (ev) { if (ev.key !== "Escape") ev.stopPropagation(); });
      if (!below && win.ResizeObserver) { try { new ResizeObserver(function () { o.fit(); }).observe(qbox); } catch (x) {} }
      // expanded ratio "auto" = the clip's own, kept between 9:16 and 16:9
      function ar(w, h) { if (w && h) el.style.setProperty("--ar", Math.max(.5625, Math.min(1.7778, w / h)).toFixed(4)); }
      function play(d) { var pr = d.play(); if (pr && pr.catch) pr.catch(function (e) { if (e && e.name !== "NotAllowedError") return; d.muted = true; mute(); var p2 = d.play(); p2 && p2.catch && p2.catch(function () {}); }); }
      function act() { if (!open) { set(true); return; } var d = cur(); if (!d) return; if (d.paused) { if (d.ended) d.currentTime = 0; d.play(); } else d.pause(); }
      // which question is up: its button is dim while its clip plays (a clip that ended is no longer playing), its page link shows
      function mark() {
        var live = o.sel >= 0 && !(o.av && o.av.ended), t = o.sel >= 0 ? qs[o.sel] : null;
        qb.forEach(function (b, i) { var on = live && i === o.sel; b.classList.toggle("sel", on); if (b.hasAttribute("aria-pressed")) b.setAttribute("aria-pressed", on ? "true" : "false"); });
        qbox.classList.toggle("has", live);
        if (t && t.link) { la.href = t.link; la.lastChild.textContent = t.label || L.i18n("more") || "Learn more"; } else la.removeAttribute("href");
        lw.classList.toggle("on", !!(t && t.link));
        el.classList.toggle("nov", !cur());
        o.sync();
      }
      function wire(d) {
        d.addEventListener("timeupdate", function () { if (open && d === cur() && d.duration && bar) bar.style.width = (d.currentTime / d.duration * 100) + "%"; });
        ["play", "pause", "ended"].forEach(function (ev) { d.addEventListener(ev, function () { if (d !== cur()) return; el.classList.toggle("paused", open && (d.paused || d.ended)); if (d === o.av) mark(); }); });
      }
      // back to the main clip (the view was collapsed, or the question's clip would not load)
      o.clear = function (resume) {
        var a = o.ans; if (!a) return;
        o.ans = o.av = null; o.sel = -1; o.lang = null;
        try { if (a.pause) { a.pause(); a.removeAttribute("src"); a.load(); } } catch (x) {}
        a.remove(); el.classList.remove("paused"); if (bar) bar.style.width = "0";
        if (o.vid) ar(o.vid.videoWidth, o.vid.videoHeight); else ar(media.naturalWidth, media.naturalHeight);
        mark(); mute();
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
        el.classList.remove("paused"); if (bar) bar.style.width = "0";
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
        el.querySelector("[data-v=replay]").addEventListener("click", function (ev) { ev.stopPropagation(); var d = cur(); if (d) { d.currentTime = 0; d.play(); } });
        el.querySelector("[data-v=mute]").addEventListener("click", function (ev) { ev.stopPropagation(); var d = cur(); if (d) { d.muted = !d.muted; mute(); } });
        el.querySelector(".vbp").addEventListener("click", function (ev) { ev.stopPropagation(); var d = cur(), r = this.getBoundingClientRect(); if (d && d.duration && r.width) d.currentTime = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * d.duration; });
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
      Array.prototype.forEach.call(el.querySelectorAll(".vbq button"), function (b) {
        b.addEventListener("click", function (ev) {
          ev.stopPropagation(); var i = b.getAttribute("data-q"), t = i == null ? null : qs[+i];
          if (!t) { set(false); sdk.open(); return; }
          L.emit("video:question", { text: t.text, index: +i, action: t.clips.length ? "video" : t.link ? "link" : "chat" });
          if (t.clips.length) { answer(+i); return; }
          if (t.link) { L.emit("video:link", { url: t.link, index: +i }); try { win.open(t.link, "_blank", "noopener,noreferrer"); } catch (x) {} return; }
          set(false); sdk.send(t.text);
        });
      });
      return o;
    }

    // ---- render (called from the loader's renderLauncher; v = null hides the bubble) ----------------------------------
    function render(v) {
      if (!v) { if (vb) { if (open) set(false); if (vb.vid) { try { vb.vid.pause(); } catch (x) {} } vb.el.classList.add("hidden"); } return false; }
      var key = JSON.stringify(v) + "|" + L.locale() + "|" + (lang || "");
      if (!vb || vb.key !== key) {
        var was = open;
        if (vb) { try { vb.clear(); if (vb.vid) vb.vid.pause(); } catch (x) {} vb.el.remove(); open = false; }
        vb = build(v, key); if (was) vb.el.className = "vb open re";
        L.wrap().insertBefore(vb.el, L.btn()); if (was) set(true);
      }
      vb.el.classList.remove("hidden");
      var bd = vb.el.querySelector(".badge"), n = L.unread(); if (bd) bd.remove();
      if (n > 0) { bd = doc.createElement("span"); bd.className = "badge"; bd.textContent = n > 9 ? "9+" : n; vb.el.appendChild(bd); }
      if (vb.vid && vb.vid.paused && !open && !(win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches)) { var pr = vb.vid.play(); pr && pr.catch && pr.catch(function () {}); }
      return true;
    }

    // A flag on the strip: every clip switches to that language. The bubble is rebuilt for it (the main clip may be a
    // video in one language and a GIF in another), stays expanded, keeps the visitor's sound choice and the question that was up.
    function relang(c) {
      if (!vb) return;
      var v = vb.v, sel = vb.sel, d = vb.av || vb.vid, muted = d ? d.muted : null;
      lang = c; if (L.store) L.store.set("vlang", c);
      L.emit("video:language", { code: c });
      quiet = true; try { render(v); } finally { quiet = false; }   // a rebuild, not the visitor opening the view again
      d = vb.vid; if (d && muted != null) { d.muted = muted; mute(); }
      if (sel >= 0) vb.answer(sel);
    }

    return { css: css, render: render, open: function () { set(true); }, isOpen: function () { return open; }, node: function () { return vb && vb.el.parentNode && !/hidden/.test(vb.el.className) ? vb.el : null; } };
  };
})();
