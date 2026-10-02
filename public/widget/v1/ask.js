/*! GrowthxAI web chat — Ask AI buttons v1 (web-chat-buttons-products-changes.md §4). Loaded by loader.js only when the
 * website's settings place buttons (settings.ask_buttons) or switch on Ask AI on selected text (settings.selection_ask),
 * so a site that uses neither never downloads this file.
 *
 *   place()      puts each button next to its target: a header button at the start / end of the first element its
 *                selector finds, an element button before / after / inside every match (20 at most). A button whose
 *                target was re-rendered, or whose page rule stopped matching, is taken away and placed again when due.
 *                The loader calls it when the config arrives, on a route change and half a second after the page changed.
 *   selection    a small "Ask AI" chip above a selection of 3 or more words inside the configured area.
 * Filled / Outline / Text buttons live in a closed shadow root (the page's CSS cannot break them); "Match my site" is a
 * plain <button class="growthxai-ask"> the page's own CSS styles.
 */
(function () {
  "use strict";
  if (window.__growthxaiWebchatAsk) return;
  window.__growthxaiWebchatAsk = function (L) {
    var doc = document, win = window, esc = L.esc, placed = [], chip = null, selBound = false;   // placed: { id, sig, host, target }
    var SPARK = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M10 2l1.9 5.6a4 4 0 0 0 2.5 2.5L20 12l-5.6 1.9a4 4 0 0 0-2.5 2.5L10 22l-1.9-5.6a4 4 0 0 0-2.5-2.5L0 12l5.6-1.9a4 4 0 0 0 2.5-2.5zM19 1l.8 2.2L22 4l-2.2.8L19 7l-.8-2.2L16 4l2.2-.8z"/></svg>';
    function accent() { return L.safeColor(L.effective().appearance.accent, "#4f46e5"); }
    function onAccent(hex) {   // dark text on a light accent
      var h = hex.slice(1); if (h.length === 3) h = h.replace(/./g, "$&$&");
      var n = parseInt(h, 16), l = (.299 * (n >> 16 & 255) + .587 * (n >> 8 & 255) + .114 * (n & 255)) / 255;
      return l > .62 ? "#111827" : "#fff";
    }
    function buttonCss(a) {
      return ":host{all:initial!important;display:inline-flex!important;vertical-align:middle!important;margin:0 8px!important;font-family:inherit!important}" +
        "button{all:initial;box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 14px;border-radius:999px;font-family:inherit;font-size:14px;font-weight:600;line-height:1;white-space:nowrap;cursor:pointer;-webkit-tap-highlight-color:transparent;transition:opacity .15s}" +
        "button:hover{opacity:.86}button:focus-visible{outline:2px solid " + a + ";outline-offset:2px}svg{flex:0 0 auto}" +
        ".filled{background:" + a + ";color:" + onAccent(a) + "}.outline{color:" + a + ";box-shadow:inset 0 0 0 1.5px " + a + "}.text{color:" + a + ";padding:0 4px}" +
        "@media(prefers-reduced-motion:reduce){button{transition:none}}";
    }

    // ---- buttons ---------------------------------------------------------------------------------------------------
    // The product an "Ask about this" button stands next to: in a list of cards, the card's own link; else the page itself.
    function productRef(t, inList) {
      var c = t.closest("[data-product-url],[data-product-handle]"), a;
      if (c) return c.getAttribute("data-product-url") || c.getAttribute("data-product-handle");
      if (inList) { a = t.matches("a[href]") ? t : t.querySelector("a[href]") || t.closest("a[href]"); if (a && /^https?:/.test(a.href)) return a.href; }
      return location.href;
    }
    function makeButton(b, target, inList) {
      var inner = (b.icon !== false ? SPARK : "") + "<span>" + esc(b.label || "Ask AI") + "</span>", h, el;
      if (b.style === "match") {
        // the site's own button CSS applies: a plain button, class "growthxai-ask"
        h = el = doc.createElement("button"); el.type = "button"; el.className = "growthxai-ask"; el.innerHTML = inner;
        var sv = el.querySelector("svg"); if (sv) { sv.setAttribute("width", "1em"); sv.setAttribute("height", "1em"); sv.style.verticalAlign = "-.125em"; sv.style.marginRight = ".35em"; }
      } else {
        h = doc.createElement("span");
        var sr = h.attachShadow({ mode: "closed" });
        sr.innerHTML = '<button type="button" part="button" class="' + (b.style === "outline" || b.style === "text" ? b.style : "filled") + '">' + inner + "</button>";
        L.adopt(sr, buttonCss(accent()));
        el = sr.querySelector("button");
      }
      h.setAttribute("data-growthxai-btn", b.id);
      el.addEventListener("click", function (ev) {
        ev.preventDefault(); ev.stopPropagation();   // a button inside a product card's link must not follow the link
        var ctx = b.context === "page" ? ("Page: " + doc.title + " (" + location.href + ")").slice(0, 500) : b.context === "product" ? "product:" + productRef(target, inList) : "";
        var asks = !!b.text && (b.click === "ask" || b.click === "prefill");
        L.trigger(b.kind === "header" ? "header_button" : "element_button",
          { act: asks ? "ask" : "open", text: asks ? b.text : "", prefill: b.click === "prefill", context: ctx, mode: b.mode || (b.kind === "header" ? "sidebar" : "") });
      });
      el.addEventListener("mouseenter", L.prefetchChat);
      return h;
    }
    // "header nav, header": the first selector of the list that matches anything, not the first match in document order
    // (which would be the <header> around the <nav>)
    function firstOf(sel) {
      var parts = sel.split(","), i, el;
      if (parts.length > 1) for (i = 0; i < parts.length; i++) { try { el = doc.querySelector(parts[i]); } catch (e) { break; } if (el) return el; }
      return doc.querySelector(sel);
    }
    function tags(t) { return (t.getAttribute("data-growthxai-placed") || "").split(" ").filter(Boolean); }
    function untag(t, id) { var l = tags(t).filter(function (x) { return x !== id; }); if (l.length) t.setAttribute("data-growthxai-placed", l.join(" ")); else t.removeAttribute("data-growthxai-placed"); }
    function clear() { placed.forEach(function (p) { p.host.remove(); untag(p.target, p.id); }); placed = []; hideChip(); }
    function place() {
      if (!L.cfg()) return clear();
      var list = L.effective().ask_buttons || [], url = location.href, live = {}, dbg = L.debug(), a = accent();
      list.forEach(function (b) { if (b && b.id && b.selector && b.enabled !== false && L.rulesOk(b.url_rules, url)) live[b.id] = JSON.stringify(b) + a; });
      placed = placed.filter(function (p) {
        if (live[p.id] === p.sig && p.host.isConnected && p.target.isConnected) return true;
        p.host.remove(); untag(p.target, p.id); if (dbg) p.target.style.outline = "";
        return false;
      });
      list.forEach(function (b) {
        if (!b || !live[b.id]) return;
        var els = [], name = 'Ask AI button "' + (b.label || b.id) + '": ';
        try { els = b.kind === "header" ? [firstOf(b.selector)].filter(Boolean) : Array.prototype.slice.call(doc.querySelectorAll(b.selector)); } catch (e) { L.warn("sel:" + b.id, name + '"' + b.selector + '" is not a valid CSS selector'); }
        els = els.filter(function (t) { return !t.closest("[data-growthxai],[data-growthxai-btn]"); });   // never inside the widget or another placed button
        if (els.length > 20) { L.warn("many:" + b.id, name + els.length + ' elements match "' + b.selector + '"; the first 20 get a button'); els = els.slice(0, 20); }
        if (dbg) L.warn("dbg:" + b.id + ":" + els.length + ":" + url, name + (els.length ? els.length + " element(s) match " : "nothing matches ") + '"' + b.selector + '"', true);
        var inList = els.length > 1;
        els.forEach(function (t) {
          if (tags(t).indexOf(b.id) >= 0) return;   // this target already has this button
          var h = makeButton(b, t, inList), pos = b.position;
          if (b.kind === "header") { if (pos === "start") t.insertBefore(h, t.firstChild); else t.appendChild(h); }
          else if (pos === "before") t.parentNode.insertBefore(h, t);
          else if (pos === "inside") t.appendChild(h);
          else t.parentNode.insertBefore(h, t.nextSibling);
          t.setAttribute("data-growthxai-placed", tags(t).concat(b.id).join(" "));
          if (dbg) t.style.outline = "2px dashed #f59e0b";
          placed.push({ id: b.id, sig: live[b.id], host: h, target: t });
        });
      });
      bindSelection();
    }

    // ---- Ask AI on selected text -------------------------------------------------------------------------------------
    function hideChip() { if (chip) { chip.remove(); chip = null; } }
    function selCheck() {
      var s = L.cfg() ? L.effective().selection_ask : null;
      if (!s || !s.enabled) return hideChip();
      var sel = win.getSelection && win.getSelection(), txt = sel && sel.rangeCount && !sel.isCollapsed ? String(sel).replace(/\s+/g, " ").trim() : "";
      var n = sel && sel.anchorNode, el = n && (n.nodeType === 1 ? n : n.parentElement), ae = doc.activeElement, ok = false;
      if (txt.split(" ").length < 3 || !el || (ae && /^(INPUT|TEXTAREA)$/.test(ae.tagName))) return hideChip();
      try { ok = !!el.closest(s.area || "main, article"); } catch (e) {}
      if (!ok || el.closest("input,textarea,[contenteditable]:not([contenteditable=false]),[data-growthxai],[data-growthxai-btn]")) return hideChip();
      var r = sel.getRangeAt(0).getBoundingClientRect();
      if (!r.width && !r.height) return hideChip();
      hideChip();
      chip = doc.createElement("span"); chip.setAttribute("data-growthxai", "selection");
      var top = r.top - 42, x = Math.max(56, Math.min(win.innerWidth - 56, r.left + r.width / 2));
      var sr = chip.attachShadow({ mode: "closed" });
      sr.innerHTML = '<button type="button" class="filled">' + SPARK + "<span>" + esc(s.label || "Ask AI") + "</span></button>";
      // the place goes into the :host rule: the button sheet resets the host with all:initial!important, which an inline style cannot beat
      L.adopt(sr, buttonCss(accent()) + ":host{margin:0!important;position:fixed!important;z-index:2147483001!important;left:" + x + "px!important;top:" + (top < 6 ? r.bottom + 8 : top) + "px!important;transform:translateX(-50%)!important}" +
        "button{height:32px;font-size:13px;box-shadow:0 6px 18px rgba(0,0,0,.22)}");
      var b = sr.querySelector("button");
      b.addEventListener("mousedown", function (ev) { ev.preventDefault(); });   // keep the selection
      b.addEventListener("click", function () {
        hideChip();
        // the question is put in the box, not sent; the whole selection goes along as background for the assistant
        L.trigger("selection", { act: "ask", prefill: true, text: 'Explain this: "' + txt.slice(0, 200) + '"', context: 'Selected text on the page: "' + txt.slice(0, 600) + '"' });
      });
      (doc.body || doc.documentElement).appendChild(chip);
    }
    function bindSelection() {
      if (selBound || !L.cfg() || !(L.effective().selection_ask || {}).enabled) return;
      selBound = true;
      doc.addEventListener("selectionchange", L.debounce(selCheck, 250));
      win.addEventListener("scroll", hideChip, { passive: true, capture: true });
    }
    return { place: place, clear: clear, hideChip: hideChip };
  };
})();
