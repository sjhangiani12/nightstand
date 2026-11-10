/* Nightstand reader: renders an unpacked EPUB as pages. ES5 only.
   Taps: right 30% = next page, left 30% = previous, middle = menu. */
var Reader = (function () {
  var GAP = 40, PADX = 40;
  var r = { id: null, base: "", spine: [], toc: [], chapter: 0, page: 0, pages: 1, size: 21, pageW: 538, pageH: 700, turns: 0, title: "", meta: null };
  var onExit = null, onProgress = null;

  function $(id) { return document.getElementById(id); }
  function file(path, cb) {
    Device.helper("/lib/file?p=" + encodeURIComponent(path).replace(/%2F/g, "/"), cb, 15000);
  }
  function dirOf(p) { var i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i + 1); }
  function join(dir, href) {
    var parts = (dir + href).split("/"), out = [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === "..") out.pop(); else if (parts[i] !== "." && parts[i] !== "") out.push(parts[i]);
    }
    return out.join("/");
  }
  function attr(tag, name) { var m = new RegExp(name + '\\s*=\\s*"([^"]*)"').exec(tag); return m ? m[1] : ""; }

  /* ---- load the package: container.xml -> OPF -> spine + toc ---- */
  function open(id, meta, startLoc, done) {
    r.id = id; r.meta = meta || {}; r.title = (meta && meta.title) || "";
    file(id + "/META-INF/container.xml", function (err, xml) {
      if (err) return done && done("Could not open the book.");
      var rf = /<rootfile\s[^>]*>/.exec(xml || ""), opfPath = rf ? attr(rf[0], "full-path") : "";
      if (!opfPath) return done && done("This book has no package file.");
      file(id + "/" + opfPath, function (err2, opf) {
        if (err2 || !opf) return done && done("Could not read the book.");
        var base = dirOf(opfPath), items = {}, m, re = /<item\s[^>]*>/g;
        while ((m = re.exec(opf))) items[attr(m[0], "id")] = { href: attr(m[0], "href"), type: attr(m[0], "media-type"), props: attr(m[0], "properties") };
        r.spine = [];
        re = /<itemref\s[^>]*>/g;
        while ((m = re.exec(opf))) { var it = items[attr(m[0], "idref")]; if (it && attr(m[0], "linear") !== "no") r.spine.push(join(base, it.href)); }
        if (!r.title) { var t = /<dc:title[^>]*>([^<]*)</.exec(opf); if (t) r.title = t[1]; }
        r.toc = [];
        var navId = null;
        for (var k in items) if (items.hasOwnProperty(k) && /nav/.test(items[k].props || "")) navId = k;
        var navPath = navId ? join(base, items[navId].href) : null;
        if (!r.spine.length) return done && done("This book has no readable pages.");
        var finish = function () {
          var loc = parseLoc(startLoc);
          r.chapter = Math.min(loc.c, r.spine.length - 1);
          load(r.chapter, function () { goFraction(loc.f); done && done(null); });
        };
        if (!navPath) return finish();
        file(id + "/" + navPath, function (e3, nav) {
          var a, re2 = /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, ndir = dirOf(navPath);
          while (!e3 && nav && (a = re2.exec(nav))) {
            var parts = a[1].split("#");
            r.toc.push({ path: join(ndir, parts[0]), anchor: parts[1] || "", text: a[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ") });
          }
          finish();
        });
      });
    });
  }
  function parseLoc(s) { var m = /^(\d+):([\d.]+)$/.exec(s || ""); return m ? { c: parseInt(m[1], 10), f: parseFloat(m[2]) } : { c: 0, f: 0 }; }

  /* ---- one chapter into the column flow ---- */
  function load(ch, cb) {
    var path = r.spine[ch];
    if (!path) { if (cb) cb(); return; }
    file(r.id + "/" + path, function (err, x) {
      var body = (/<body[^>]*>([\s\S]*)<\/body>/i.exec(x || "") || [0, "<p>This part could not be loaded.</p>"])[1];
      var dir = dirOf(path);
      body = body.replace(/(<img\b[^>]*\bsrc=")([^"]+)(")/gi, function (all, a, src, b) {
        if (/^(https?:|data:)/.test(src)) return a + src + b;
        return a + "http://127.0.0.1:8765/lib/file?p=" + r.id + "/" + join(dir, src) + b;
      });
      body = body.replace(/<image\b[^>]*xlink:href="([^"]+)"[^>]*\/?>(<\/image>)?/gi, function (all, src) {
        return '<img src="http://127.0.0.1:8765/lib/file?p=' + r.id + "/" + join(dir, src) + '"/>';
      });
      r.chapter = ch;
      var flow = $("r-flow");
      flow.innerHTML = body;
      layout();
      if (cb) cb();
    });
  }

  function layout() {
    var view = $("reader");
    var H = view.offsetHeight || 777;
    r.pageW = 618 - 2 * PADX;
    r.pageH = H - 28 - 44;
    var page = $("r-page"), flow = $("r-flow");
    page.style.width = r.pageW + "px";
    page.style.height = r.pageH + "px";
    flow.style.height = r.pageH + "px";
    flow.style.width = r.pageW + "px";
    flow.style.fontSize = r.size + "px";
    flow.style.webkitColumnWidth = r.pageW + "px";
    flow.style.webkitColumnGap = GAP + "px";
    flow.style.columnWidth = r.pageW + "px";
    flow.style.columnGap = GAP + "px";
    r.pages = Math.max(1, Math.ceil((flow.scrollWidth + GAP) / (r.pageW + GAP)));
  }

  function draw() {
    if (r.page >= r.pages) r.page = r.pages - 1;
    if (r.page < 0) r.page = 0;
    $("r-flow").style.left = -(r.page * (r.pageW + GAP)) + "px";
    // Share of the book before this page (0 on the first page).
    // Our article EPUBs start with a title page: leave it out of the count.
    var skip = r.spine.length > 1 && /title\.xhtml$/.test(r.spine[0]) ? 1 : 0;
    var overall = Math.max(0, r.chapter - skip + r.page / r.pages) / Math.max(1, r.spine.length - skip);
    var pct = Math.round(overall * 100);
    $("r-pos").innerHTML = "Page " + (r.page + 1) + " of " + r.pages + (r.spine.length > 1 ? " · part " + (r.chapter + 1) + " of " + r.spine.length : "");
    var mins = r.meta && r.meta.minutes ? Math.max(0, Math.round(r.meta.minutes * (1 - overall))) : null;
    $("r-left").innerHTML = mins !== null ? (mins > 0 ? mins + " min left" : "Finished") : pct + "%";
    $("r-menupos").innerHTML = pct + "% read";
    $("r-title").innerHTML = esc(r.title);
    if (onProgress) onProgress(r.id, Math.min(1, overall), r.chapter + ":" + (r.pages > 1 ? (r.page / (r.pages - 1)).toFixed(4) : "0"));
  }
  function goFraction(f) { r.page = Math.round((f || 0) * (r.pages - 1)); draw(); }

  function next() {
    if (r.page < r.pages - 1) { r.page++; turned(); return; }
    if (r.chapter < r.spine.length - 1) { load(r.chapter + 1, function () { r.page = 0; turned(); }); }
  }
  function prev() {
    if (r.page > 0) { r.page--; turned(); return; }
    if (r.chapter > 0) { load(r.chapter - 1, function () { r.page = r.pages - 1; turned(); }); }
  }
  // Full e-ink refresh every 6 turns clears ghosting.
  function turned() { draw(); r.turns++; if (r.turns % 6 === 0) Device.helper("/flash"); }

  function esc(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;"); }

  function menu(show) { $("r-menu").className = "r-menu" + (show ? "" : " hidden"); }
  function toc(show) {
    if (show) {
      var html = "";
      for (var i = 0; i < r.toc.length; i++) html += '<button type="button" class="' + (i > 0 && r.toc[i].anchor ? "sub" : "") + '" data-toc="' + i + '">' + esc(r.toc[i].text) + "</button>";
      if (!html) html = '<div class="small">This book has no table of contents.</div>';
      $("r-toc-list").innerHTML = html;
    }
    $("r-toc").className = "r-toc" + (show ? "" : " hidden");
  }
  function jump(i) {
    var t = r.toc[i], ch = 0;
    for (var k = 0; k < r.spine.length; k++) if (r.spine[k] === t.path) ch = k;
    load(ch, function () {
      r.page = 0;
      if (t.anchor) {
        var el = document.getElementById(t.anchor);
        if (el) r.page = Math.floor(el.offsetLeft / (r.pageW + GAP));
      }
      toc(false); menu(false); turned();
    });
  }
  function resize(d) {
    var flow = $("r-flow"), f = r.pages > 1 ? r.page / (r.pages - 1) : 0;
    r.size = Math.max(15, Math.min(34, r.size + d));
    try { localStorage.setItem("ns-font", String(r.size)); } catch (e) {}
    layout(); goFraction(f);
  }

  function wire() {
    try { var s = parseInt(localStorage.getItem("ns-font"), 10); if (s) r.size = s; } catch (e) {}
    $("r-page").parentNode.addEventListener("click", function (e) {
      if ($("r-menu").className.indexOf("hidden") < 0 || $("r-toc").className.indexOf("hidden") < 0) return;
      var x = e.clientX / (window.innerWidth || 1072);
      if (x > 0.7) next(); else if (x < 0.3) prev(); else menu(true);
    }, false);
    $("r-menu").addEventListener("click", function (e) {
      var t = e.target;
      if (t === $("r-menu")) menu(false); // tap on the page area closes the menu
    }, false);
    $("r-home").addEventListener("click", function () { menu(false); if (onExit) onExit(); }, false);
    $("r-smaller").addEventListener("click", function () { resize(-2); }, false);
    $("r-bigger").addEventListener("click", function () { resize(2); }, false);
    $("r-contents").addEventListener("click", function () { toc(true); }, false);
    $("r-toc-close").addEventListener("click", function () { toc(false); menu(false); }, false);
    $("r-toc-list").addEventListener("click", function (e) {
      var t = e.target;
      while (t && t !== this && t.getAttribute && t.getAttribute("data-toc") === null) t = t.parentNode;
      if (t && t.getAttribute && t.getAttribute("data-toc") !== null) jump(parseInt(t.getAttribute("data-toc"), 10));
    }, false);
  }

  return {
    init: function (exitCb, progressCb) { onExit = exitCb; onProgress = progressCb; wire(); },
    open: function (id, meta, loc, done) { menu(false); toc(false); open(id, meta, loc, done); },
    relayout: function () { if (r.id) { var f = r.pages > 1 ? r.page / (r.pages - 1) : 0; layout(); goFraction(f); } },
    current: function () { return r.id; },
    next: function () { next(); },
    prev: function () { prev(); },
    menu: function (v) { menu(v); },
    toc: function (v) { toc(v); }
  };
})();
