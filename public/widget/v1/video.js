/*! GrowthxAI web chat — GIF / video bubble v1. Loaded by loader.js only for inboxes with settings.launcher.video set.
 *
 * With a media URL set, the launcher is that clip in a small bubble (muted, looping) with an X. A click expands it: the
 * clip restarts (with sound when allowed) and suggested questions + "Chat with us" sit over or below it. A question
 * opens the panel and sends it; "Chat with us" just opens the panel. X on the expanded view collapses it; X on the
 * bubble hides it for this browser session and the normal launcher takes over. No media, a load error or a closed
 * bubble = the existing launcher, unchanged.
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
  function num(v, lo, hi, d) { v = parseFloat(v); return isNaN(v) ? d : Math.max(lo, Math.min(hi, v)); }
  function ratio(r, d) { var m = /^(\d{1,2}):(\d{1,2})$/.exec(r || ""); return m && +m[1] && +m[2] ? m[1] + "/" + m[2] : d; }

  win.__growthxaiWebchatVideo = function (L) {
    var esc = L.esc, safeColor = L.safeColor, sdk = L.sdk, vb = null, open = false;
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
        ".vb.open .vbf{width:" + ww + ";aspect-ratio:" + (v.expanded_ratio && v.expanded_ratio !== "auto" ? ratio(v.expanded_ratio, "16/9") : "var(--ar,16/9)") + ";max-height:calc(100dvh - " + (mb + 32) + "px);border-radius:16px;border-width:0;cursor:default}.vb.open .vbm{transform:none;object-fit:cover}" +
        ".vbx{position:absolute;top:" + xo + "px;right:" + xo + "px;width:24px;height:24px;padding:0;border-radius:50%;border:0;background:#1f2937;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,.3);z-index:2}.vbx:hover{background:#000}.vbx svg{width:11px;height:11px}.vb.open .vbx{top:-10px;right:-10px;width:30px;height:30px}.vb.open .vbx svg{width:13px;height:13px}" +
        ".vb .badge{top:" + xo + "px;left:" + xo + "px;right:auto;z-index:2}.vb.open .badge{display:none}" +
        ".vbo{position:absolute;inset:0;display:none;flex-direction:column;justify-content:space-between;pointer-events:none}.vb.open .vbo{display:flex}" +
        ".vbt{display:flex;align-items:center;gap:10px;padding:12px 44px 18px 12px;background:linear-gradient(rgba(0,0,0,.5),transparent);pointer-events:auto}.vbt button{width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center}.vbt button:hover{background:rgba(255,255,255,.18)}.vbt svg{width:18px;height:18px}" +
        ".vbt .off,.vbt .muted .on{display:none}.vbt .muted .off{display:inline}" +
        ".vbp{flex:1;height:14px;display:flex;align-items:center;cursor:pointer}.vbp span{flex:1;height:4px;border-radius:2px;background:rgba(255,255,255,.35);overflow:hidden}.vbp i{display:block;height:100%;width:0;background:#fff}" +
        ".vbpl{position:absolute;top:50%;left:50%;width:56px;height:56px;margin:-28px 0 0 -28px;border-radius:50%;background:rgba(0,0,0,.45);color:#fff;display:none;align-items:center;justify-content:center}.vbpl svg{width:28px;height:28px;margin-left:3px}.vb.open.paused .vbpl{display:flex}" +
        ".vbq{display:flex;flex-wrap:wrap;gap:8px;pointer-events:auto}.vbq.over{padding:30px 12px 12px;background:linear-gradient(transparent,rgba(0,0,0,.62))}.vbq.below{display:none;width:" + ww + "}.vb.open .vbq.below{display:flex}" +
        ".vbq button{flex:1 1 40%;min-width:0;display:flex;align-items:center;gap:8px;border:0;border-radius:999px;padding:9px 14px;font:inherit;font-weight:600;font-size:13px;line-height:1.25;cursor:pointer;text-align:start;background:" + (over ? rgba(qbg, .78) : qbg) + ";color:" + qc + ";box-shadow:0 2px 8px rgba(0,0,0,.18);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);transition:transform .15s}.vbq button:hover{transform:translateY(-1px);background:" + qbg + "}.vbq button:focus-visible{outline:2px solid #fff;outline-offset:1px}" +
        ".vbq b{flex:0 0 auto;width:20px;height:20px;border-radius:50%;border:1px solid currentColor;opacity:.8;font-size:10px;display:flex;align-items:center;justify-content:center}.vbq span{overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}" +
        ".vbq .cta,.vbq .cta:hover{justify-content:center;background:" + safeColor(v.cta_bg, accent) + ";color:" + safeColor(v.cta_color, "#ffffff") + "}.vbq .cta svg{width:16px;height:16px;flex:0 0 auto}";
    }

    // ---- expand / collapse -----------------------------------------------------------------------------------------
    function mute() { var b = vb && vb.el.querySelector("[data-v=mute]"); if (b) { b.classList.toggle("muted", vb.vid.muted); b.setAttribute("aria-pressed", vb.vid.muted ? "true" : "false"); } }
    function set(on) {
      if (!vb || open === on) return;
      open = on; vb.el.classList.toggle("open", on); vb.el.classList.remove("paused"); vb.frame.setAttribute("aria-expanded", on ? "true" : "false");
      var vd = vb.vid;
      if (vd) {
        try {
          vd.loop = !on; vd.muted = !on || vb.v.sound === false; if (on) vd.currentTime = 0;
          // a browser that refuses sound here still plays the clip muted
          var pr = vd.play(); if (pr && pr.catch) pr.catch(function () { vd.muted = true; mute(); var p2 = vd.play(); p2 && p2.catch && p2.catch(function () {}); });
        } catch (x) {}
        mute();
      }
      if (on) { L.hidePopup(); L.prefetchChat(); }
      L.emit(on ? "video:opened" : "video:closed", {});
    }
    doc.addEventListener("click", function (ev) { if (open && ev.target !== L.host()) set(false); });   // clicks inside the closed shadow root arrive retargeted to the host
    doc.addEventListener("keydown", function (ev) { if (open && ev.key === "Escape") set(false); });

    // ---- build -----------------------------------------------------------------------------------------------------
    function build(v, key) {
      var isImg = v.kind === "image" || (v.kind !== "video" && /\.(gif|webp|a?png|jpe?g)(\?|#|$)/i.test(v.url)), u = esc(url(v.url));
      var qs = (v.questions || []).map(function (t) { return String(t || "").trim(); }).filter(Boolean).slice(0, 6), below = v.questions_position === "below", label = v.cta_text || L.i18n("chat");
      var q = '<div class="vbq ' + (below ? "below" : "over") + '">' + qs.map(function (t, i) { return '<button type="button" data-q="' + i + '"><b>' + String.fromCharCode(65 + i) + "</b><span>" + esc(t) + "</span></button>"; }).join("") +
        '<button type="button" class="cta">' + L.ICON + "<span>" + esc(label) + "</span></button></div>";
      var el = doc.createElement("div"); el.className = "vb";
      el.innerHTML = '<div class="vbf" role="button" tabindex="0" aria-expanded="false" aria-label="' + esc(label) + '">' +
        (isImg ? '<img class="vbm" alt="" src="' + u + '">' : '<video class="vbm" src="' + u + '" muted loop playsinline preload="metadata"></video>') +
        '<div class="vbo">' + (isImg ? "<span></span>" : '<div class="vbt"><button type="button" data-v="replay" aria-label="Replay">' + REPLAY + '</button><div class="vbp" role="slider" aria-label="Progress"><span><i></i></span></div><button type="button" data-v="mute" aria-label="Sound">' + VOL + "</button></div>") +
        (isImg ? "" : '<span class="vbpl">' + PLAY + "</span>") + (below ? "" : q) + "</div></div>" + (below ? q : "") +
        '<button class="vbx" type="button" aria-label="' + esc(L.i18n("close")) + '">' + L.CLOSE + "</button>";
      var o = { el: el, key: key, v: v, frame: el.querySelector(".vbf"), vid: isImg ? null : el.querySelector("video") }, media = el.querySelector(".vbm"), bar = el.querySelector(".vbp i");
      // expanded ratio "auto" = the clip's own, kept between 9:16 and 16:9
      function ar(w, h) { if (w && h) el.style.setProperty("--ar", Math.max(.5625, Math.min(1.7778, w / h)).toFixed(4)); }
      function act() { if (!open) { set(true); return; } var d = o.vid; if (!d) return; if (d.paused) { if (d.ended) d.currentTime = 0; d.play(); } else d.pause(); }
      media.addEventListener("error", function () { open = false; L.fail(); });
      if (o.vid) {
        o.vid.muted = true;
        o.vid.addEventListener("loadedmetadata", function () { ar(o.vid.videoWidth, o.vid.videoHeight); });
        o.vid.addEventListener("timeupdate", function () { if (open && o.vid.duration) bar.style.width = (o.vid.currentTime / o.vid.duration * 100) + "%"; });
        ["play", "pause", "ended"].forEach(function (ev) { o.vid.addEventListener(ev, function () { el.classList.toggle("paused", open && (o.vid.paused || o.vid.ended)); }); });
        el.querySelector("[data-v=replay]").addEventListener("click", function (ev) { ev.stopPropagation(); o.vid.currentTime = 0; o.vid.play(); });
        el.querySelector("[data-v=mute]").addEventListener("click", function (ev) { ev.stopPropagation(); o.vid.muted = !o.vid.muted; mute(); });
        el.querySelector(".vbp").addEventListener("click", function (ev) { ev.stopPropagation(); var r = this.getBoundingClientRect(); if (o.vid.duration && r.width) o.vid.currentTime = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * o.vid.duration; });
      } else media.addEventListener("load", function () { ar(media.naturalWidth, media.naturalHeight); });
      o.frame.addEventListener("click", act);
      o.frame.addEventListener("keydown", function (ev) { if (ev.target === o.frame && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); act(); } });
      o.frame.addEventListener("mouseenter", L.prefetchChat);
      el.querySelector(".vbx").addEventListener("click", function (ev) {
        ev.stopPropagation();
        if (open) { set(false); o.frame.focus(); return; }
        L.dismiss();
      });
      Array.prototype.forEach.call(el.querySelectorAll(".vbq button"), function (b) {
        b.addEventListener("click", function (ev) {
          ev.stopPropagation(); var i = b.getAttribute("data-q"), text = i == null ? null : qs[+i];
          set(false);
          if (text) { L.emit("video:question", { text: text, index: +i }); sdk.send(text); } else sdk.open();
        });
      });
      return o;
    }

    // ---- render (called from the loader's renderLauncher; v = null hides the bubble) ----------------------------------
    function render(v) {
      if (!v) { if (vb) { if (open) set(false); if (vb.vid) { try { vb.vid.pause(); } catch (x) {} } vb.el.classList.add("hidden"); } return false; }
      var key = JSON.stringify(v) + "|" + L.locale();
      if (!vb || vb.key !== key) { var was = open; if (vb) { vb.el.remove(); open = false; } vb = build(v, key); L.wrap().insertBefore(vb.el, L.btn()); if (was) set(true); }
      vb.el.classList.remove("hidden");
      var bd = vb.el.querySelector(".badge"), n = L.unread(); if (bd) bd.remove();
      if (n > 0) { bd = doc.createElement("span"); bd.className = "badge"; bd.textContent = n > 9 ? "9+" : n; vb.el.appendChild(bd); }
      if (vb.vid && vb.vid.paused && !open && !(win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches)) { var pr = vb.vid.play(); pr && pr.catch && pr.catch(function () {}); }
      return true;
    }

    return { css: css, render: render, isOpen: function () { return open; }, node: function () { return vb && vb.el.parentNode && !/hidden/.test(vb.el.className) ? vb.el : null; } };
  };
})();
