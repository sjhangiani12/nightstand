/* Nightstand app. ES5 only: the Kindle's web engine is old. */
(function () {
  var D = NS_SAMPLE;
  var VIEWS = ["home", "tonight", "lamp", "alarm", "goodnight", "reader", "library", "getbook"];
  var state = {
    tzOffset: null,
    calendar: "sample",
    alarms: [],
    alarmDate: null,
    alarmVolume: 10,
    lampsLive: false,
    library: [],
    amazon: [],
    libTab: null,
    libPage: 0,
    syncedAt: null,
    readerFrom: "home",
    view: "home",
    bright: 12,
    wifi: 1,
    dark: 0,
    alarmMin: null,      // minutes after midnight
    suggestedMin: null,
    alarmSet: false,
    countdown: null
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function on(id, fn) {
    var el = $(id);
    if (el) el.addEventListener("click", fn, false);
  }

  /* ---------- scale: the page is drawn 618 px wide, then zoomed to the
     screen width. The height is whatever is left under the system status
     bar (firmware 5.18 keeps it on top of web apps). ---------- */
  function scale() {
    var w = window.innerWidth || document.documentElement.clientWidth || 1072;
    var h = window.innerHeight || document.documentElement.clientHeight || 1448;
    var z = w / 618;
    var vh = Math.floor(h / z);
    document.body.style.zoom = z; // (a transform scale drops glyphs in this engine)
    for (var i = 0; i < VIEWS.length; i++) $(VIEWS[i]).style.height = vh + "px";
  }

  /* Hide the system search/title bar and stop a top tap from opening it. */
  function chrome() {
    try {
      if (window.kindle && kindle.messaging && kindle.messaging.sendMessage) {
        kindle.messaging.sendMessage("com.lab126.chromebar", "configureChrome", {
          appId: "com.nightstand.app",
          titleBar: { clientParams: { handleTap: "ignore" } }
        });
      }
    } catch (e) {}
    // Hide the system status bar (time, Wi-Fi, battery), like KOReader does.
    // Home draws its own status row.
    try {
      if (typeof nativeBridge !== "undefined" && nativeBridge.setLipcProperty) {
        nativeBridge.setLipcProperty("com.lab126.pillow", "disableEnablePillow", "disable");
      }
    } catch (e2) {}
  }

  /* ---------- time helpers ---------- */
  var DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  function toMin(hhmm) { var p = hhmm.split(":"); return parseInt(p[0], 10) * 60 + parseInt(p[1], 10); }
  function h12(min) {
    var h = Math.floor(min / 60) % 24, m = min % 60;
    var hh = h % 12 === 0 ? 12 : h % 12;
    return { t: hh + ":" + (m < 10 ? "0" : "") + m, ap: h < 12 ? "AM" : "PM" };
  }
  function shortTime(min) {
    var x = h12(min);
    return x.t.replace(":00", ":00");
  }
  function durText(mins) {
    var h = Math.floor(mins / 60), m = mins % 60;
    if (h && m) return h + " h " + m + " m";
    if (h) return h + " h";
    return m + " min";
  }

  /* ---------- the alarm rule ---------- */
  function firstMeeting() {
    var ev = D.tomorrow.events;
    for (var i = 0; i < ev.length; i++) if (ev[i].kind === "meeting") return ev[i];
    return null;
  }
  function suggestAlarm() {
    var r = D.alarmRule, fm = firstMeeting();
    if (!fm) return toMin(r.fallback);
    var t = toMin(fm.start) - r.leadMinutes;
    var lo = toMin(r.earliest), hi = toMin(r.latest);
    if (t < lo) t = lo;
    if (t > hi) t = hi;
    return t;
  }

  /* ---------- Home ---------- */
  // Local time in the home time zone. The server sends the offset, so a
  // wrong Kindle time zone does not matter (its UTC clock is right).
  function homeNow() {
    var d = new Date();
    if (state.tzOffset === null) return d;
    var u = new Date(d.getTime() + state.tzOffset * 60000);
    return { getHours: function () { return u.getUTCHours(); }, getMinutes: function () { return u.getUTCMinutes(); },
             getDay: function () { return u.getUTCDay(); }, getMonth: function () { return u.getUTCMonth(); }, getDate: function () { return u.getUTCDate(); } };
  }

  function loadTonight(cb) {
    Device.helper("/tonight", function (err, text) {
      var j = null;
      try { j = JSON.parse(text); } catch (e) {}
      if (!err && j && j.ok) {
        if (typeof j.tzOffsetMinutes === "number") state.tzOffset = j.tzOffsetMinutes;
        if (j.weather) D.weather = j.weather;
        state.calendar = j.calendar;
        if (j.calendar === "ok" || j.calendar === "not-connected") {
          D.tomorrow = { label: j.tomorrow.label, date: j.tomorrow.date, events: j.tomorrow.events || [] };
        }
        state.suggestedMin = suggestAlarm();
        if (!state.alarmSet) state.alarmMin = state.suggestedMin;
      }
      if (cb) cb();
      show(state.view);
    }, 15000);
  }

  function renderClock() {
    var d = homeNow();
    var x = h12(d.getHours() * 60 + d.getMinutes());
    $("clock").innerHTML = x.t;
    $("date").innerHTML = DAYS[d.getDay()] + ", " + MONTHS[d.getMonth()].slice(0, 3) + " " + d.getDate();
  }

  /* ---------- Library (EPUBs from the server, unpacked on the Kindle) ---------- */
  function prog(id) {
    if (id && id.indexOf("amz-") === 0) {
      for (var a = 0; a < state.amazon.length; a++) if (state.amazon[a].id === id) {
        var b = state.amazon[a];
        return b.pct > 0 ? { p: b.pct / 100, at: b.at } : null;
      }
      return null;
    }
    try { var v = JSON.parse(localStorage.getItem("ns-prog-" + id) || "null"); if (v) return v; } catch (e) {}
    return null;
  }
  function saveProg(id, p, loc) {
    var v = { p: p, loc: loc, at: new Date().getTime() };
    try { localStorage.setItem("ns-prog-" + id, JSON.stringify(v)); localStorage.setItem("ns-last", id); } catch (e) {}
    if (state.progTimer) clearTimeout(state.progTimer);
    state.progTimer = setTimeout(function () { Device.helper("/lib/progress?id=" + id + "&p=" + p.toFixed(4) + "&loc=" + encodeURIComponent(loc)); }, 1500);
  }
  function loadLibrary(cb) {
    Device.helper("/lib/sync", function (err, text) {
      var ok = false;
      try { var j = JSON.parse(text); if (j && j.items) { state.library = j.items; state.pending = j.pending || []; ok = true; } } catch (e) {}
      if (!ok && !Device.onKindle && typeof NS_SAMPLE_LIBRARY !== "undefined") { state.library = NS_SAMPLE_LIBRARY.items; ok = true; }
      if (ok) state.syncedAt = new Date().getTime();
      if (state.view === "home") renderShelf();
      if (state.view === "library") renderLibrary();
      if (cb) cb();
      watchPending();
    }, 90000);
  }
  // While a Shelfmark book is on its way, re-sync every 15 s on the Library screen.
  function inFlight() {
    var n = 0, p = state.pending || [];
    for (var i = 0; i < p.length; i++) if (p[i].status !== "error") n++;
    return n;
  }
  function watchPending() {
    clearTimeout(state.pendTimer);
    if (!inFlight()) return;
    state.pendTimer = setTimeout(function () {
      if (state.view === "library" || state.view === "getbook") loadLibrary();
      else watchPending();
    }, 15000);
  }
  function pendingLabel(x) {
    if (x.status === "error") return "Failed: " + (x.error || "unknown reason").replace(/^Shelfmark:\s*/, "");
    if (x.status === "processing") return "Checking the file…";
    if (x.status === "waiting") return "Requested";
    if (x.fetch_note === "Downloading" && x.fetch_pct !== null && x.fetch_pct !== undefined) return "Downloading " + Math.round(x.fetch_pct) + "%";
    return x.fetch_note || "Requested";
  }
  function allItems() { return state.library.concat(state.amazon); }
  function findItem(id) {
    var all = allItems();
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }
  function coverUrl(it) {
    if (it.amazon) return "http://127.0.0.1:8765/amazon/cover?asin=" + it.asin;
    return it.cover ? "http://127.0.0.1:8765/lib/file?p=" + it.id + "/" + it.cover : "";
  }
  function authorName(j) {
    try { var a = JSON.parse(j)[0].name.display; var p = a.split(", "); return p.length === 2 ? p[1] + " " + p[0] : a; } catch (e) { return ""; }
  }
  // Amazon store books (DRM): listed with their covers, opened in Amazon's reader.
  function loadAmazon(cb) {
    Device.helper("/amazon/books", function (err, text) {
      if (err && !Device.onKindle && typeof NS_SAMPLE_AMAZON !== "undefined") { err = null; text = NS_SAMPLE_AMAZON; }
      if (!err && text && text.indexOf("error=") !== 0) {
        var out = [], lines = text.split("\n");
        for (var i = 0; i < lines.length; i++) {
          var f = lines[i].split("\t");
          if (f.length < 5 || !f[0]) continue;
          var title = f[1].length > 48 && f[1].indexOf(": ") > 0 ? f[1].slice(0, f[1].indexOf(": ")) : f[1];
          out.push({ id: "amz-" + f[0], asin: f[0], amazon: true, kind: "book", title: title, author: authorName(f[2]), site: authorName(f[2]),
                     pct: Math.round(parseFloat(f[3]) || 0), at: (parseInt(f[4], 10) || 0) * 1000, ready_at: (parseInt(f[4], 10) || 0) * 1000 });
        }
        state.amazon = out;
      }
      if (state.view === "home") renderShelf();
      if (state.view === "library") renderLibrary();
      if (cb) cb();
    }, 15000);
  }
  function shelfItems() {
    var list = allItems();
    // Most recently read first, then newest unread.
    list.sort(function (a, b) {
      var pa = prog(a.id), pb = prog(b.id);
      var ka = pa ? pa.at : (a.ready_at || 0) - 1e13, kb = pb ? pb.at : (b.ready_at || 0) - 1e13;
      return kb - ka;
    });
    var out = [];
    for (var i = 0; i < list.length && out.length < 5; i++) {
      var p = prog(list[i].id);
      if (p && p.p > 0.98) continue; // finished
      out.push(list[i]);
    }
    return out;
  }
  // Long titles get a smaller size on the shelf; the card clips anything left over.
  function titleSize(t) { var n = String(t || "").length; return n > 70 ? " xlong" : n > 40 ? " long" : ""; }
  // Center-crop an image into its box once it loads (no object-fit in this engine).
  window.nsCrop = function (img, w, h) {
    var nw = img.naturalWidth || img.width, nh = img.naturalHeight || img.height;
    if (window.nsRepaint) window.nsRepaint();
    if (!nw || !nh) return;
    if (nw < 300 || nw / nh > 4) { // too small to fill the box: show the text cover instead
      img.style.display = "none";
      img.parentNode.className += " text";
      return;
    }
    if (nw / nh > w / h) { var sw = Math.round(nw * h / nh); img.style.height = h + "px"; img.style.width = sw + "px"; img.style.marginLeft = -Math.round((sw - w) / 2) + "px"; }
    else { var sh = Math.round(nh * w / nw); img.style.width = w + "px"; img.style.height = sh + "px"; img.style.marginTop = -Math.round((sh - h) / 4) + "px"; }
  };
  function cropImg(src, w, h) {
    return '<img src="' + src + '" alt="" style="width:' + w + 'px" onload="nsCrop(this,' + w + ',' + h + ')"/>';
  }
  function progressNote(b, hero) {
    var p = prog(b.id), pct = p ? Math.round(p.p * 100) : 0;
    if (b.amazon) return pct + "%" + (hero ? " · tap to continue" : "");
    var left = b.minutes ? Math.max(1, Math.round(b.minutes * (1 - (p ? p.p : 0)))) : null;
    if (!p || pct === 0) return "New · " + (b.minutes || "?") + " min" + (hero ? " · tap to start" : "");
    return (left ? left + " min left" : pct + "%") + (hero ? " · tap to continue" : "");
  }
  function renderShelf() {
    if (!state.library.length && !state.amazon.length) return; // first sync still running
    var items = shelfItems(), newCount = 0;
    for (var k = 0; k < state.library.length; k++) if (!prog(state.library[k].id)) newCount++;
    $("new-count").innerHTML = newCount ? " · " + newCount + " new" : "";

    // Hero: the thing you read last.
    var h = items[0], html = "";
    if (h) {
      var hp = prog(h.id), hpct = hp ? Math.round(hp.p * 100) : 0, cover;
      if (h.amazon) cover = '<div class="h-cover"><img src="' + coverUrl(h) + '" alt="" style="width:178px;height:269px"/></div>';
      else if (coverUrl(h)) cover = '<div class="h-cover">' + cropImg(coverUrl(h), 178, 269) + '<div class="ck">Article</div><div class="ct">' + esc(h.title) + '</div></div>';
      else cover = '<div class="h-cover text"><div class="ck">Article</div><div class="ct">' + esc(h.title) + '</div></div>';
      html = '<button type="button" class="h-hero-btn" data-book="' + h.id + '">' + cover +
        '<div class="h-title">' + esc(h.title || "Untitled") + '</div>' +
        '<div class="h-bar"><div style="width:' + hpct + '%"></div></div>' +
        '<div class="h-meta">' + esc(progressNote(h, true)) + '</div></button>';
    }
    $("hero").innerHTML = html;

    // Library row: the next four. Books stand tall; article images are square crops.
    html = "";
    for (var i = 1; i < items.length; i++) {
      var b = items[i], box;
      if (b.amazon) box = '<div class="h-box tall"><img src="' + coverUrl(b) + '" alt="" style="width:120px;height:180px"/></div>';
      else if (coverUrl(b)) box = '<div class="h-box">' + cropImg(coverUrl(b), 120, 120) + '<div class="ct">' + esc(b.title) + '</div></div>';
      else box = '<div class="h-box text"><div class="ct">' + esc(b.title) + '</div></div>';
      var cap = b.amazon ? b.title + " · " + progressNote(b) : coverUrl(b) ? b.title : (b.site ? b.site + " · " : "") + progressNote(b);
      html += '<td><button type="button" class="h-tile" data-book="' + b.id + '">' + box + '<div class="h-cap">' + esc(cap) + '</div></button></td>';
    }
    for (var e = items.length; e < 5; e++) html += "<td></td>";
    $("covers").innerHTML = html;
  }
  function openBook(id) {
    var it = findItem(id), p = prog(id);
    if (it && it.amazon) { toast("Opening in Kindle…"); Device.helper("/amazon/open?asin=" + it.asin); return; }
    state.readerFrom = state.view === "library" ? "library" : "home";
    show("reader");
    Reader.open(id, it, p ? p.loc : "", function (err) { if (err) { toast(err); show("home"); } });
  }

  /* ---------- Library screen ---------- */
  var LIB_TABS = [
    { k: "reading", label: "Reading" },
    { k: "articles", label: "Articles" },
    { k: "books", label: "Books" },
    { k: "finished", label: "Finished" }
  ];
  function done(it) { var p = prog(it.id); return !!(p && p.p >= 0.98); }
  function libItems(tab) {
    var out = [];
    var all = allItems();
    for (var i = 0; i < all.length; i++) {
      var it = all[i], p = prog(it.id);
      var isBook = it.kind === "book";
      if (tab === "reading" && p && p.p > 0 && !done(it)) out.push(it);
      if (tab === "articles" && !isBook && !done(it)) out.push(it);
      if (tab === "books" && isBook && !done(it)) out.push(it);
      if (tab === "finished" && done(it)) out.push(it);
    }
    out.sort(function (a, b) {
      if (tab === "reading" || tab === "finished") return (prog(b.id) || {}).at - (prog(a.id) || {}).at;
      return (b.ready_at || 0) - (a.ready_at || 0);
    });
    return out;
  }
  function sentLabel(ms) {
    if (!ms) return "";
    var off = state.tzOffset === null ? -new Date().getTimezoneOffset() : state.tzOffset;
    var u = new Date(ms + off * 60000), today = homeDate(0);
    var ds = u.getUTCFullYear() + "-" + pad2(u.getUTCMonth() + 1) + "-" + pad2(u.getUTCDate());
    var n = Math.round((dateUTC(today) - dateUTC(ds)) / 86400000);
    if (n === 0) return "sent today";
    if (n === 1) return "sent yesterday";
    return "sent " + MONTHS[u.getUTCMonth()].slice(0, 3) + " " + u.getUTCDate();
  }
  var EMPTY = {
    reading: "Nothing in progress. Open an article from the Articles tab.",
    articles: "No articles yet. Send one with the /add link or from Claude, then tap Sync now.",
    books: "No books yet. Books from your Kindle and DRM-free EPUBs show up here.",
    finished: "Nothing finished yet."
  };
  function renderLibrary() {
    if (!state.libTab) state.libTab = libItems("reading").length ? "reading" : "articles";
    var html = "";
    for (var t = 0; t < LIB_TABS.length; t++) {
      var n = libItems(LIB_TABS[t].k).length;
      html += '<td><button type="button" class="lib-tab' + (LIB_TABS[t].k === state.libTab ? " on" : "") + '" data-tab="' + LIB_TABS[t].k + '">' +
        LIB_TABS[t].label + (n ? " · " + n : "") + "</button></td>";
    }
    $("lib-tabs").innerHTML = html;
    $("lib-synced").innerHTML = state.syncedAt ? "Synced " + h12(homeMinutes(state.syncedAt)).t + " " + h12(homeMinutes(state.syncedAt)).ap : "Not synced yet";

    var items = libItems(state.libTab);
    var coming = "", comingRows = 0;
    if (state.libTab === "books" && state.libPage === 0) {
      var pend = state.pending || [];
      for (var k = 0; k < pend.length; k++) {
        var x = pend[k], pct = x.status === "fetching" && x.fetch_note === "Downloading" ? Math.round(x.fetch_pct || 0) : 0;
        coming += '<div class="lib-row coming"><div class="lib-rt">' + esc(x.title || "Untitled") + '</div>' +
          '<div class="lib-rm">' + esc((x.author ? x.author + " · " : "") + pendingLabel(x)) + '</div>' +
          (pct ? '<div class="bar"><div style="width:' + pct + '%"></div></div>' : "") + '</div>';
      }
      comingRows = pend.length;
      if (coming) coming = '<div class="eyebrow coming-h">Coming</div>' + coming + '<div class="eyebrow coming-h">On this Kindle</div>';
    }
    // Room between the tabs (about 190 px from the top) and the pager (80 px).
    var per = Math.max(4, Math.floor((($("library").offsetHeight || 777) - 270) / 92));
    if (coming) per = Math.max(2, per - comingRows - 1); // "Coming" rows and the two headings take room
    var pages = Math.max(1, Math.ceil(items.length / per));
    if (state.libPage >= pages) state.libPage = pages - 1;
    if (state.libPage < 0) state.libPage = 0;
    var slice = items.slice(state.libPage * per, state.libPage * per + per);
    html = "";
    for (var i = 0; i < slice.length; i++) {
      var it = slice[i], p = prog(it.id), pct = p ? Math.round(p.p * 100) : 0;
      var left = it.minutes ? Math.max(1, Math.round(it.minutes * (1 - (p ? p.p : 0)))) : null;
      var meta = it.amazon ? [it.author, pct ? pct + "% read" : "Not started", "Kindle book"]
        : [it.site || it.author || "", p && !done(it) ? (left ? left + " min left" : pct + "%") : (it.minutes ? it.minutes + " min" : ""), sentLabel(it.ready_at)];
      var tag = done(it) ? "<span>Done</span>" : p && pct > 0 ? "<span>" + pct + "%</span>" : it.amazon ? "" : '<span class="new">New</span>';
      html += '<div class="lib-row" data-book="' + it.id + '"><table><tr>' +
        (coverUrl(it) ? (it.amazon ? '<td class="lib-thumb"><img src="' + coverUrl(it) + '" alt=""/></td>'
                                   : '<td class="lib-thumb wide"><div><img src="' + coverUrl(it) + '" alt=""/></div></td>') : "") + '<td>' +
        '<div class="lib-rt">' + esc(it.title || "Untitled") + '</div>' +
        '<div class="lib-rm">' + esc(meta.filter(function (x) { return x; }).join(" · ")) + '</div>' +
        (state.libTab === "finished" && !it.amazon ? '<button type="button" class="lib-arch" data-arch="' + it.id + '">Archive</button>' : "") +
        '</td><td class="lib-tag">' + tag + '</td></tr></table></div>';
    }
    if (!html) html = '<div class="lib-empty">' + EMPTY[state.libTab] + "</div>";
    $("lib-list").innerHTML = coming + html;
    $("lib-pager").className = "lib-pager" + (pages > 1 ? "" : " hidden");
    $("lib-page").innerHTML = (state.libPage + 1) + " of " + pages;
    $("lib-prev").disabled = state.libPage === 0;
    $("lib-next").disabled = state.libPage >= pages - 1;
  }
  function homeMinutes(ms) {
    var off = state.tzOffset === null ? -new Date().getTimezoneOffset() : state.tzOffset;
    var u = new Date(ms + off * 60000);
    return u.getUTCHours() * 60 + u.getUTCMinutes();
  }
  function archive(id) {
    toast("Archiving…");
    Device.helper("/lib/archive?id=" + id, function () {
      try { localStorage.removeItem("ns-prog-" + id); } catch (e) {}
      for (var i = 0; i < state.library.length; i++) if (state.library[i].id === id) { state.library.splice(i, 1); break; }
      renderLibrary();
      toast("Archived.");
    }, 30000);
  }

  function renderHome() {
    renderClock();
    var fm = firstMeeting();
    if (fm) $("g-first").innerHTML = "<b>Tomorrow</b> " + h12(toMin(fm.start)).t + " " + esc(fm.title);
    else $("g-first").innerHTML = state.calendar === "not-connected" ? "<b>Tomorrow</b> calendar not connected" : "<b>Tomorrow</b> no meetings";
    var nx = nextAlarm();
    if (nx && nx.d === tomorrowDate()) $("g-alarm").innerHTML = "Alarm " + h12(toMin(nx.t)).t + " set";
    else $("g-alarm").innerHTML = "Alarm " + h12(state.suggestedMin).t + " suggested";
    $("g-wx").innerHTML = esc(String(D.weather.now || "").replace(" and ", " "));
    renderShelf();
  }

  /* ---------- Tonight ---------- */
  function renderBright() {
    $("b-label").innerHTML = "Light " + state.bright;
    var filled = Math.round(state.bright / 2), html = "";
    for (var i = 0; i < 12; i++) html += '<td><div class="seg' + (i < filled ? " on" : "") + '"></div></td>';
    $("segs").innerHTML = html;
  }

  function renderKeys() {
    $("k-wifi").className = "key" + (state.wifi ? " on" : "");
    $("k-wifi-s").innerHTML = state.wifi ? "On" : "Off";
    $("k-dark").className = "key" + (state.dark ? " on" : "");
    $("k-dark-s").innerHTML = state.dark ? "On" : "Off";
    $("k-sync-s").innerHTML = D.newCount + " new";
  }

  function renderEvents() {
    var ev = D.tomorrow.events, html = "", meetings = 0, blocks = 0, firstSeen = false;
    for (var i = 0; i < ev.length; i++) {
      var e = ev[i];
      if (e.kind === "skip") continue;
      var isMeet = e.kind === "meeting";
      if (isMeet) meetings++; else blocks++;
      var label = isMeet ? (firstSeen ? (e.len || "").toUpperCase() : "FIRST MEETING") : e.kind.toUpperCase();
      if (isMeet) firstSeen = true;
      html += '<tr class="' + (isMeet ? "meeting" : "block") + '">' +
        '<td class="et">' + h12(toMin(e.start)).t + '</td>' +
        '<td>' + esc(e.title) + '</td>' +
        '<td class="el">' + esc(label) + '</td></tr>';
    }
    if (!html) {
      html = '<tr class="block"><td>' + (state.calendar === "not-connected" ? "Calendar not connected yet." : "Nothing on the calendar.") + '</td></tr>';
    }
    $("events").innerHTML = html;
    $("cal-title").innerHTML = "Tomorrow · " + esc(D.tomorrow.label);
    $("cal-count").innerHTML = meetings + " meetings · " + blocks + " blocks";
  }

  function nextAlarm() { return state.alarms && state.alarms.length ? state.alarms[0] : null; }

  function renderAlarmCard() {
    var nx = nextAlarm(), fm = firstMeeting();
    if (nx) {
      var x = h12(toMin(nx.t));
      $("al-time").innerHTML = x.t;
      $("al-ampm").innerHTML = x.ap;
      $("al-kicker").innerHTML = "Alarm · " + esc(relLabel(nx.d)).toLowerCase() + (nx.id === "-" ? " · saved" : " · set");
      $("al-why").innerHTML = esc(dateLabel(nx.d)) + (state.alarms.length > 1 ? " · " + (state.alarms.length - 1) + " more" : "") + " · Sonos, " + esc(D.speaker);
      $("al-set").innerHTML = "Set ✓";
    } else {
      var y = h12(state.suggestedMin);
      $("al-time").innerHTML = y.t;
      $("al-ampm").innerHTML = y.ap;
      $("al-kicker").innerHTML = "Alarm · suggested";
      $("al-why").innerHTML = (fm ? (toMin(fm.start) - state.suggestedMin) + " min before " + esc(fm.title.toLowerCase()) : "No meetings tomorrow") + " · Sonos, " + esc(D.speaker);
      $("al-set").innerHTML = "Set";
    }
  }

  function renderLamps() {
    var html = "";
    for (var i = 0; i < D.lamps.length; i++) {
      var l = D.lamps[i];
      html += '<tr><td class="ln" data-open="' + i + '">' + esc(l.name) + ' <span>›</span></td>' +
        '<td class="lp">' + (l.reachable === false ? "Offline" : (l.on ? l.pct + "%" : "Off")) + '</td>' +
        '<td class="lt"><button type="button" class="toggle' + (l.on ? " on" : "") + '" data-lamp="' + i + '" aria-label="' + esc(l.name) + '"><div></div></button></td></tr>';
    }
    $("lamps").innerHTML = html;
  }

  function shortName(n) { var w = String(D.room || "").split(" ")[0]; return String(n).replace(w ? new RegExp("^" + w + "\\s+", "i") : /^$/, "").replace(/^(\w)/, function (c) { return c.toUpperCase(); }); }

  function loadLamps() {
    Device.helper("/hue/lights", function (err, text) {
      if (err) { state.lampsLive = false; renderLamps(); return; }
      try {
        var j = JSON.parse(text), list = [];
        for (var id in j) {
          if (!j.hasOwnProperty(id) || !j[id].state) continue;
          var st = j[id].state;
          list.push({ id: id, name: shortName(j[id].name), on: !!st.on && st.reachable !== false, pct: Math.max(1, Math.round((st.bri || 0) / 254 * 100)), ct: st.ct || null, reachable: st.reachable !== false });
        }
        if (list.length) { D.lamps = list; state.lampsLive = true; }
      } catch (e) {}
      renderLamps();
      if (state.view === "lamp" && !state.lampPending) renderLampView();
    }, 8000);
  }

  /* Dates in the home time zone, as "YYYY-MM-DD". */
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function homeDate(addDays) {
    var off = state.tzOffset === null ? -new Date().getTimezoneOffset() : state.tzOffset;
    var u = new Date(new Date().getTime() + off * 60000 + (addDays || 0) * 86400000);
    return u.getUTCFullYear() + "-" + pad2(u.getUTCMonth() + 1) + "-" + pad2(u.getUTCDate());
  }
  function dateUTC(ds) { var p = ds.split("-"); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function addDays(ds, n) {
    var u = new Date(dateUTC(ds) + n * 86400000);
    return u.getUTCFullYear() + "-" + pad2(u.getUTCMonth() + 1) + "-" + pad2(u.getUTCDate());
  }
  function daysFromToday(ds) { return Math.round((dateUTC(ds) - dateUTC(homeDate(0))) / 86400000); }
  function dateLabel(ds) {
    var u = new Date(dateUTC(ds));
    return DAYS[u.getUTCDay()].slice(0, 3) + ", " + MONTHS[u.getUTCMonth()].slice(0, 3) + " " + u.getUTCDate();
  }
  function relLabel(ds) {
    var n = daysFromToday(ds);
    return n === 0 ? "Today" : n === 1 ? "Tomorrow" : n < 0 ? "Past" : "In " + n + " days";
  }
  function tomorrowDate() { return D.tomorrow.date || homeDate(1); }

  function parseAlarms(text) {
    var out = [], lines = String(text || "").split("\n");
    for (var i = 0; i < lines.length; i++) {
      var m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d) (\S+)/.exec(lines[i]);
      if (m) out.push({ d: m[1], t: m[2], id: m[3] });
    }
    return out;
  }

  function loadAlarm() {
    Device.helper("/alarm/list", function (err, text) {
      if (err) return;
      state.alarms = parseAlarms(text);
      if (state.view === "tonight") renderAlarmCard();
      if (state.view === "alarm") renderAlarmList();
      if (state.view === "home") renderHome();
    }, 30000);
  }

  // Add an alarm on a date. replace = drop other alarms on that day first.
  function addAlarm(ds, min, replace) {
    var t = pad2(Math.floor(min / 60)) + ":" + pad2(min % 60);
    toast("Setting the alarm…");
    Device.helper("/alarm/add?d=" + ds + "&t=" + t + (replace ? "&replace=1" : ""), function (err, text) {
      if (!err && /^ok/.test(text)) {
        state.alarms = parseAlarms(text);
        var pending = false;
        for (var i = 0; i < state.alarms.length; i++) if (state.alarms[i].d === ds && state.alarms[i].t === t && state.alarms[i].id === "-") pending = true;
        toast((pending ? "Saved. It goes on the Sonos when it is a week away: " : "Alarm set: ") + dateLabel(ds) + ", " + h12(min).t + " " + h12(min).ap + ".");
      } else if (/past/.test(text || "")) {
        toast("That time has already passed.");
      } else {
        toast("Could not reach the Sonos. Try again.");
      }
      if (state.view === "tonight") renderAlarmCard();
      if (state.view === "alarm") renderAlarmList();
    }, 30000);
  }

  function deleteAlarm(ds, t) {
    Device.helper("/alarm/del?d=" + ds + "&t=" + t, function (err, text) {
      if (!err) state.alarms = parseAlarms(text);
      renderAlarmList();
      toast("Alarm deleted.");
    }, 30000);
  }

  function renderTonight() {
    renderClock();
    renderEvents();
    renderAlarmCard();
    renderLamps();
    loadLamps();
    loadAlarm();
  }

  /* ---------- One lamp ---------- */
  // Hue's own presets, as colour temperature (mireds) + brightness.
  var PRESETS = [
    { name: "Nightlight", note: "2200 K · 5%", ct: 454, pct: 5 },
    { name: "Relax", note: "2237 K · 57%", ct: 447, pct: 57 },
    { name: "Read", note: "2890 K · 100%", ct: 346, pct: 100 },
    { name: "Concentrate", note: "4292 K · 100%", ct: 233, pct: 100 },
    { name: "Energize", note: "6410 K · 100%", ct: 156, pct: 100 }
  ];
  function curLamp() { return D.lamps[state.lampIdx || 0]; }

  function renderLampView() {
    var l = curLamp();
    if (!l) return;
    $("lamp-name").innerHTML = esc(l.name);
    $("lamp-sub").innerHTML = esc(D.room) + " · Hue" + (l.reachable === false ? " · offline" : "");
    $("lamp-toggle").className = "toggle" + (l.on ? " on" : "");
    $("lamp-pct").innerHTML = l.on ? l.pct : "Off";
    var html = "", filled = l.on ? Math.round(l.pct / 10) : 0;
    for (var i = 0; i < 10; i++) html += '<td><button type="button" class="lseg' + (i < filled ? " on" : "") + '" data-pct="' + ((i + 1) * 10) + '" aria-label="' + ((i + 1) * 10) + ' percent"></button></td>';
    $("lamp-segs").innerHTML = html;
    html = "";
    for (var k = 0; k < PRESETS.length; k++) {
      var p = PRESETS[k], active = l.on && l.ct && Math.abs(l.ct - p.ct) <= 12 && Math.abs(l.pct - p.pct) <= 4;
      if (k % 2 === 0) html += "<tr>";
      html += '<td><button type="button" class="preset' + (active ? " on" : "") + '" data-preset="' + k + '">' + esc(p.name) + '<span>' + esc(p.note) + '</span></button></td>';
      if (k % 2 === 1 || k === PRESETS.length - 1) html += (k % 2 === 0 ? "<td></td>" : "") + "</tr>";
    }
    $("lamp-presets").innerHTML = html;
  }

  // Send the lamp's state after taps settle (one request, not one per tap).
  function pushLamp(extra) {
    var l = curLamp();
    if (!l || !l.id) return;
    if (state.lampTimer) clearTimeout(state.lampTimer);
    state.lampPending = true;
    state.lampTimer = setTimeout(function () {
      var q = "/hue/set?id=" + l.id + "&on=" + (l.on ? 1 : 0);
      if (l.on) q += "&bri=" + Math.max(1, Math.round(l.pct / 100 * 254));
      if (extra && extra.ct) q += "&ct=" + extra.ct;
      Device.helper(q, function () { state.lampPending = false; }, 8000);
    }, 450);
  }

  function lampStep(d) {
    var l = curLamp();
    if (!l) return;
    if (!l.on) { l.on = true; l.pct = 0; }
    l.pct = Math.max(1, Math.min(100, (d > 0 ? Math.floor(l.pct / 10) * 10 : Math.ceil(l.pct / 10) * 10) + d));
    renderLampView();
    pushLamp();
  }

  /* ---------- Alarm ---------- */
  function renderAlarm() {
    if (!state.alarmDate || daysFromToday(state.alarmDate) < 0) state.alarmDate = tomorrowDate();
    var x = h12(state.alarmMin), ds = state.alarmDate, isTomorrow = ds === tomorrowDate();
    $("d-label").innerHTML = esc(dateLabel(ds));
    $("d-rel").innerHTML = esc(relLabel(ds));
    $("d-prev").disabled = daysFromToday(ds) <= 0;
    $("a-time").innerHTML = x.t;
    $("a-ampm").innerHTML = x.ap;
    $("a-suggest-t").innerHTML = h12(state.suggestedMin).t;
    var fm = firstMeeting();
    $("a-why").innerHTML = isTomorrow && fm ? "First meeting " + esc(fm.title) + " at " + h12(toMin(fm.start)).t + ". Suggested: wake " + D.alarmRule.leadMinutes + " min before." : "";
    $("a-set").innerHTML = "Set alarm · " + esc(dateLabel(ds)) + " · " + x.t + " " + x.ap;
    $("a-vol").innerHTML = state.alarmVolume;
    $("a-vol-note").innerHTML = state.alarmVolume <= 8 ? "Soft" : state.alarmVolume <= 16 ? "Medium" : "Loud";
    renderAlarmList();
  }

  function loadVolume() {
    Device.helper("/alarm/volume", function (err, t) {
      var m = /volume=(\d+)/.exec(t || "");
      if (m) { state.alarmVolume = parseInt(m[1], 10); if (state.view === "alarm") $("a-vol").innerHTML = state.alarmVolume; }
    }, 10000);
  }
  function setVolume(v) {
    state.alarmVolume = Math.max(2, Math.min(40, v));
    $("a-vol").innerHTML = state.alarmVolume;
    if (state.volTimer) clearTimeout(state.volTimer);
    state.volTimer = setTimeout(function () {
      Device.helper("/alarm/volume?v=" + state.alarmVolume, function (err, t) {
        if (!err) { toast("Alarm volume " + state.alarmVolume + (state.alarms.length ? ". Your alarms were updated." : ".")); loadAlarm(); }
      }, 30000);
    }, 900);
  }

  function renderAlarmList() {
    var list = state.alarms || [], html = "";
    for (var i = 0; i < list.length; i++) {
      var a = list[i], x = h12(toMin(a.t));
      html += '<tr><td class="at">' + x.t + " " + x.ap + '</td>' +
        '<td>' + esc(dateLabel(a.d)) + ' <span class="as">· ' + (a.id === "-" ? "saved, goes on the Sonos " + esc(dateLabel(addDays(a.d, -6))) : esc(relLabel(a.d)).toLowerCase()) + '</span></td>' +
        '<td class="ax"><button type="button" data-del="' + a.d + " " + a.t + '">Delete</button></td></tr>';
    }
    if (!html) html = '<tr><td class="empty">No alarms set.</td></tr>';
    $("a-list").innerHTML = html;
  }

  /* ---------- Goodnight ---------- */
  function renderGoodnight() {
    var x = h12(state.alarmMin), fm = firstMeeting();
    var rows = [
      ["Alarm", nextAlarm() ? h12(toMin(nextAlarm().t)).t + " " + h12(toMin(nextAlarm().t)).ap + " · " + relLabel(nextAlarm().d) : "Not set"],
      ["Lights", "Off · " + D.room],
      ["First up", fm ? fm.title + ", " + h12(toMin(fm.start)).t : "Nothing"]
    ];
    var html = "";
    for (var i = 0; i < rows.length; i++) html += '<tr><td class="gl">' + esc(rows[i][0]) + '</td><td class="gv">' + esc(rows[i][1]) + '</td></tr>';
    $("gn-rows").innerHTML = html;
    $("gn-sun").innerHTML = "Sunrise " + esc(D.weather.sunrise) + " · " + esc(D.weather.low) + " low";
    var b = D.shelf[0];
    $("gn-book").innerHTML = b ? esc(b.title) + " · " + b.pct + "%" : "";
  }

  function startCountdown() {
    var left = 10;
    $("undo").className = "undo";
    function tick() {
      $("undo-text").innerHTML = "Lights off in " + left + " s. Then the Kindle sleeps.";
      if (left <= 0) {
        stopCountdown();
        $("undo").className = "undo hidden";
        $("gn-wake").className = "gn-wake";
        for (var i = 0; i < D.lamps.length; i++) D.lamps[i].on = false;
        Device.helper("/hue/off", function () {
          // Let the 3 s fade finish, then sleep.
          setTimeout(function () { if (state.view === "goodnight") Device.sleep(); }, 3500);
        }, 10000);
        return;
      }
      left -= 1;
      state.countdown = setTimeout(tick, 1000);
    }
    tick();
  }
  function stopCountdown() {
    if (state.countdown) { clearTimeout(state.countdown); state.countdown = null; }
  }

  /* ---------- navigation ---------- */
  function show(name) {
    state.view = name;
    for (var i = 0; i < VIEWS.length; i++) $(VIEWS[i]).className = $(VIEWS[i]).className.replace(/\s*hidden/g, "") + (VIEWS[i] === name ? "" : " hidden");
    if (name === "home") renderHome();
    if (name === "tonight") renderTonight();
    if (name === "alarm") renderAlarm();
    if (name === "lamp") renderLampView();
    if (name === "library") renderLibrary();
    if (name === "getbook") renderGetBook();
    repaintAll();
    setTimeout(repaintAll, 700);
    if (name === "goodnight") renderGoodnight();
  }

  function toast(text) {
    var t = $("toast");
    t.innerHTML = esc(text);
    t.className = "toast";
    setTimeout(function () { t.className = "toast hidden"; }, 2500);
  }

  /* ---------- gestures: swipe down from the top edge, swipe up to close ---------- */
  function gestures() {
    var sx = 0, sy = 0, tracking = false;
    function start(x, y) { sx = x; sy = y; tracking = true; }
    function end(x, y) {
      if (!tracking) return;
      tracking = false;
      var dy = y - sy, dx = x - sx, H = window.innerHeight || 1448;
      if (Math.abs(dy) < H * 0.08 || Math.abs(dx) > Math.abs(dy)) return;
      if (dy > 0 && sy < H * 0.2 && state.view !== "tonight" && state.view !== "goodnight") { show("tonight"); loadTonight(); }
      else if (dy < 0 && state.view === "tonight") show("home");
    }
    document.addEventListener("touchstart", function (e) { var t = e.changedTouches[0]; start(t.clientX, t.clientY); }, false);
    document.addEventListener("touchend", function (e) { var t = e.changedTouches[0]; end(t.clientX, t.clientY); }, false);
    document.addEventListener("mousedown", function (e) { start(e.clientX, e.clientY); }, false);
    document.addEventListener("mouseup", function (e) { end(e.clientX, e.clientY); }, false);
  }

  /* ---------- Get a book ---------- */
  var gb = { text: "", results: null, book: null, shelfmark: false, busy: false, kb: true, status: "" };
  var KB = ["1234567890", "qwertyuiop", "asdfghjkl", "zxcvbnm"];
  function renderKb() {
    var h = "";
    for (var r = 0; r < KB.length; r++) {
      h += "<table><tr>";
      for (var i = 0; i < KB[r].length; i++) h += '<td><button type="button" data-k="' + KB[r].charAt(i) + '">' + KB[r].charAt(i) + "</button></td>";
      if (r === 2) h += '<td><button type="button" data-k="\'">\'</button></td>';
      if (r === 3) h += '<td colspan="3"><button type="button" class="wide" data-k="del">Delete</button></td>';
      h += "</tr></table>";
    }
    h += '<table><tr><td colspan="2"><button type="button" class="wide" data-k="clear">Clear</button></td>' +
      '<td colspan="5"><button type="button" class="wide" data-k=" ">space</button></td>' +
      '<td colspan="3"><button type="button" class="wide go" data-k="go">Search</button></td></tr></table>';
    $("gb-kb").innerHTML = h;
  }
  function gbStatus(t) { gb.status = t; $("gb-status").innerHTML = esc(t); }
  function renderGetBook() {
    $("gb-text").innerHTML = esc(gb.text);
    $("gb-hint").className = "gb-hint" + (gb.text ? " hidden" : "");
    $("gb-kb").className = "gb-kb" + (gb.kb ? "" : " hidden");
    if (!$("gb-kb").innerHTML) renderKb();
    $("gb-status").innerHTML = esc(gb.status);
    var h = "";
    var list = gb.results || [];
    var max = gb.kb ? 3 : 7;
    for (var i = 0; i < list.length && i < max; i++) {
      var o = list[i];
      h += '<table class="gb-row"><tr><td><div class="gb-rt">' + esc(o.title) + '</div><div class="gb-rm">' +
        esc([o.author, o.source === "gutenberg" ? "Project Gutenberg" : o.source === "standardebooks" ? "Standard Ebooks" : (o.note || "Shelfmark")].filter(function (x) { return x; }).join(" · ")) +
        '</div></td><td class="gb-get"><button type="button" class="btn light" data-get="' + i + '">Get</button></td></tr></table>';
    }
    if (gb.results && !list.length && gb.book && gb.shelfmark) {
      h += '<table class="gb-row"><tr><td><div class="gb-rt">' + esc(gb.book.title) + '</div><div class="gb-rm">' +
        esc((gb.book.author || "") + (gb.book.year ? " · " + gb.book.year : "") + " · ask Shelfmark") +
        '</div></td><td class="gb-get"><button type="button" class="btn light" data-shelf="1">Ask</button></td></tr></table>';
    }
    $("gb-list").innerHTML = h;
  }
  function gbSearch() {
    var q = gb.text.replace(/^\s+|\s+$/g, "");
    if (!q || gb.busy) return;
    gb.busy = true; gb.results = null; gb.kb = false;
    gbStatus("Searching the free libraries and Shelfmark for “" + q + "”… (up to 45 s)");
    renderGetBook(); repaintAll();
    Device.helper("/book/find?q=" + encodeURIComponent(q), function (err, text) {
      gb.busy = false;
      var d = null;
      try { d = JSON.parse(text); } catch (e) {}
      if ((err || !d) && !Device.onKindle && D.sampleBooks) { d = D.sampleBooks; err = null; } // desktop preview
      if (err || !d) { gbStatus("Search did not work. Check Wi-Fi and try again."); renderGetBook(); repaintAll(); return; }
      gb.results = d.options || [];
      gb.book = d.book || null;
      gb.shelfmark = !!d.shelfmark;
      if (gb.results.length) gbStatus(gb.results.length === 1 ? "Found it. Tap Get." : "Pick the right one and tap Get.");
      else if (gb.book && gb.shelfmark) gbStatus("Not in the free libraries. Shelfmark can look for it.");
      else if (gb.book) gbStatus("“" + gb.book.title + "” is not in the free libraries.");
      else gbStatus("No book found. Try the title and the author's last name.");
      renderGetBook(); repaintAll();
    }, 65000);
  }
  function gbGet(path, label) {
    if (gb.busy) return;
    gb.busy = true;
    gbStatus("Getting “" + label + "”…");
    repaintAll();
    Device.helper(path, function (err, text) {
      gb.busy = false;
      var d = null;
      try { d = JSON.parse(text); } catch (e) {}
      if (err || !d) { gbStatus("That did not work. Check Wi-Fi and try again."); repaintAll(); return; }
      if (d.status === "ready" && d.id) {
        gbStatus("Got it. Downloading to the Kindle…"); repaintAll();
        loadLibrary(function () {
          if (findItem(d.id)) { state.readerFrom = "library"; openBook(d.id); }
          else { gbStatus("Ready. It is in your Library under Books."); repaintAll(); }
        });
      } else if (d.status === "waiting" || d.status === "fetching") {
        toast("Requested. Follow it under Books.");
        state.libTab = "books"; state.libPage = 0;
        loadLibrary(); show("library");
      } else {
        gbStatus("Could not get it: " + (d.error || d.message || "unknown reason")); repaintAll();
      }
    }, 95000);
  }
  function gbKey(k) {
    if (k === "go") return gbSearch();
    if (k === "del") gb.text = gb.text.slice(0, -1);
    else if (k === "clear") { gb.text = ""; gb.results = null; gb.status = ""; }
    else if (gb.text.length < 60) gb.text += k;
    $("gb-text").innerHTML = esc(gb.text);
    $("gb-hint").className = "gb-hint" + (gb.text ? " hidden" : "");
    if (k === "clear") renderGetBook();
  }

  /* ---------- wiring ---------- */
  function wire() {
    on("open-tonight", function () { show("tonight"); loadTonight(); });
    on("close-tonight", function () { show("home"); });
    on("close-tonight-top", function () { show("home"); });
    on("open-library", function () { state.libPage = 0; show("library"); });
    on("lib-back", function () { show("home"); });
    on("open-getbook", function () { gb.kb = true; if (!gb.results) gb.status = ""; show("getbook"); });
    on("gb-back", function () { show("library"); });
    $("gb-kb").addEventListener("click", function (e) {
      var t = e.target;
      if (t.getAttribute && t.getAttribute("data-k") !== null) gbKey(t.getAttribute("data-k"));
    }, false);
    $("getbook").addEventListener("click", function (e) {
      var t = e.target;
      for (var n = t; n && n !== this; n = n.parentNode) if (n.className && String(n.className).indexOf("gb-field") >= 0) { gb.kb = true; renderGetBook(); repaintAll(); return; }
      if (!t.getAttribute) return;
      var i = t.getAttribute("data-get");
      if (i !== null && gb.results && gb.results[+i]) {
        var o = gb.results[+i];
        gbGet("/book/get?source=" + encodeURIComponent(o.source) + "&ref=" + encodeURIComponent(o.ref) + "&title=" + encodeURIComponent(o.title) + "&author=" + encodeURIComponent(o.author || ""), o.title);
      }
      if (t.getAttribute("data-shelf") && gb.book) gbGet("/book/get?query=" + encodeURIComponent(gb.book.title + " " + (gb.book.author || "")), gb.book.title);
    }, false);
    on("lib-sync", function () { toast("Syncing…"); loadAmazon(); loadLibrary(function () { toast("Synced. " + state.library.length + " articles, " + state.amazon.length + " Kindle books."); }); });
    on("lib-prev", function () { state.libPage--; renderLibrary(); });
    on("lib-next", function () { state.libPage++; renderLibrary(); });
    $("lib-tabs").addEventListener("click", function (e) {
      var t = e.target;
      if (t.getAttribute && t.getAttribute("data-tab")) { state.libTab = t.getAttribute("data-tab"); state.libPage = 0; renderLibrary(); }
    }, false);
    $("lib-list").addEventListener("click", function (e) {
      var t = e.target;
      if (t.getAttribute && t.getAttribute("data-arch")) { archive(t.getAttribute("data-arch")); return; }
      while (t && t !== this && t.getAttribute && t.getAttribute("data-book") === null) t = t.parentNode;
      if (t && t.getAttribute && t.getAttribute("data-book")) openBook(t.getAttribute("data-book"));
    }, false);
    on("open-library-2", function () { state.libPage = 0; show("library"); });
    $("home").addEventListener("click", function (e) {
      var t = e.target;
      while (t && t !== this && t.getAttribute && t.getAttribute("data-book") === null) t = t.parentNode;
      if (t && t.getAttribute && t.getAttribute("data-book")) openBook(t.getAttribute("data-book"));
    }, false);
    on("al-set", function () { addAlarm(tomorrowDate(), state.suggestedMin, true); });
    on("al-change", function () { state.alarmDate = tomorrowDate(); state.alarmMin = state.suggestedMin; show("alarm"); loadAlarm(); loadVolume(); });
    on("alarm-back", function () { show("tonight"); });
    function setMin(m) { state.alarmMin = (m + 1440) % 1440; renderAlarm(); }
    on("a-minus", function () { setMin(state.alarmMin - 5); });
    on("a-plus", function () { setMin(state.alarmMin + 5); });
    on("a-h-minus", function () { setMin(state.alarmMin - 60); });
    on("a-h-plus", function () { setMin(state.alarmMin + 60); });
    on("a-suggest", function () { state.alarmDate = tomorrowDate(); setMin(state.suggestedMin); });
    on("d-prev", function () { if (daysFromToday(state.alarmDate) > 0) { state.alarmDate = addDays(state.alarmDate, -1); renderAlarm(); } });
    on("d-next", function () { state.alarmDate = addDays(state.alarmDate, 1); renderAlarm(); });
    on("a-set", function () { addAlarm(state.alarmDate, state.alarmMin, false); });
    on("a-vol-down", function () { setVolume(state.alarmVolume - 2); $("a-vol-note").innerHTML = state.alarmVolume <= 8 ? "Soft" : state.alarmVolume <= 16 ? "Medium" : "Loud"; });
    on("a-vol-up", function () { setVolume(state.alarmVolume + 2); $("a-vol-note").innerHTML = state.alarmVolume <= 8 ? "Soft" : state.alarmVolume <= 16 ? "Medium" : "Loud"; });
    $("a-list").addEventListener("click", function (e) {
      var t = e.target;
      if (!t.getAttribute || !t.getAttribute("data-del")) return;
      var p = t.getAttribute("data-del").split(" ");
      deleteAlarm(p[0], p[1]);
    }, false);
    on("lights-out", function () { show("goodnight"); startCountdown(); });
    on("undo-btn", function (e) { if (e) e.stopPropagation(); stopCountdown(); show("tonight"); });
    // After lights out the screen has no buttons: any tap goes Home.
    $("goodnight").addEventListener("click", function () {
      if (state.countdown) return; // the Undo bar handles taps during the countdown
      show("home");
    }, false);
    on("stock-home", function () { Device.stockHome(); });
    on("lamp-back", function () { show("tonight"); });
    on("lamp-minus", function () { lampStep(-10); });
    on("lamp-plus", function () { lampStep(10); });
    on("lamp-toggle", function () { var l = curLamp(); if (!l) return; l.on = !l.on; if (l.on && l.pct < 1) l.pct = 50; renderLampView(); pushLamp(); });
    $("lamp-segs").addEventListener("click", function (e) {
      var t = e.target, l = curLamp();
      if (!l || !t.getAttribute || !t.getAttribute("data-pct")) return;
      l.on = true; l.pct = parseInt(t.getAttribute("data-pct"), 10); renderLampView(); pushLamp();
    }, false);
    $("lamp-presets").addEventListener("click", function (e) {
      var t = e.target, l = curLamp();
      while (t && t !== this && t.getAttribute && t.getAttribute("data-preset") === null) t = t.parentNode;
      if (!l || !t || !t.getAttribute || t.getAttribute("data-preset") === null) return;
      var p = PRESETS[parseInt(t.getAttribute("data-preset"), 10)];
      l.on = true; l.pct = p.pct; l.ct = p.ct; renderLampView(); pushLamp({ ct: p.ct });
    }, false);

    $("lamps").addEventListener("click", function (e) {
      var t = e.target;
      var o = t;
      while (o && o !== this && o.getAttribute && o.getAttribute("data-open") === null) o = o.parentNode;
      if (o && o.getAttribute && o.getAttribute("data-open") !== null) { state.lampIdx = parseInt(o.getAttribute("data-open"), 10); show("lamp"); return; }
      while (t && t !== this && t.getAttribute && t.getAttribute("data-lamp") === null) t = t.parentNode;
      if (t && t.getAttribute && t.getAttribute("data-lamp") !== null) {
        var l = D.lamps[parseInt(t.getAttribute("data-lamp"), 10)];
        l.on = !l.on;
        renderLamps();
        if (l.id) Device.helper("/hue/set?id=" + l.id + "&on=" + (l.on ? 1 : 0), function () { setTimeout(loadLamps, 600); }, 8000);
      }
    }, false);
  }

  function trace(m) { try { var x = new XMLHttpRequest(); x.open("GET", "http://127.0.0.1:8765/jslog?m=" + encodeURIComponent("trace " + m), false); x.send(null); } catch (e) {} }
  /* With body zoom, this engine repaints too small an area when content
     changes after the first draw, so new text shows up cut off or missing.
     After any change, force one full repaint (batched). */
  var repaintTimer = null;
  function repaintAll() {
    if (repaintTimer) return;
    repaintTimer = setTimeout(function () {
      repaintTimer = null;
      var b = document.body;
      b.style.visibility = "hidden";
      b.offsetHeight; // force layout
      b.style.visibility = "";
    }, 60);
  }
  window.nsRepaint = repaintAll;

  // Room and speaker names come from the Kindle's config (helper /names).
  function applyNames() {
    var r = document.getElementsByClassName("js-room"), s = document.getElementsByClassName("js-speaker"), i;
    for (i = 0; i < r.length; i++) r[i].innerHTML = esc(D.room);
    for (i = 0; i < s.length; i++) s[i].innerHTML = esc(D.speaker);
  }
  function loadNames() {
    applyNames();
    Device.helper("/names", function (err, text) {
      if (err || !text) return;
      var m = /room=(.*)/.exec(text), n = /speaker=(.*)/.exec(text);
      if (m && m[1]) D.room = m[1];
      if (n && n[1]) D.speaker = n[1];
      applyNames();
    });
  }

  function init() {
    chrome();
    scale();
    state.suggestedMin = suggestAlarm();
    state.alarmMin = state.suggestedMin;
    wire();
    document.addEventListener("DOMSubtreeModified", repaintAll, false);
    setTimeout(repaintAll, 400); setTimeout(repaintAll, 1200); setTimeout(repaintAll, 3000);
    // Screenshot / test hook: index.html#tonight opens that view.
    var start = (location.hash || "").replace("#", "") || window.NS_START || "";
    if (start === "books") { state.libTab = "books"; start = "library"; } // screenshot shortcut
    show(VIEWS.indexOf(start) >= 0 ? start : "home");
    if (start !== "goodnight") $("gn-wake").className = "gn-wake hidden";
    if (start === "goodnight") $("undo").className = "undo";
    setInterval(function () { if (state.view === "home" || state.view === "tonight") renderClock(); }, 30000);
    loadNames();
    loadTonight();
    setInterval(function () { loadTonight(); }, 30 * 60000);
    Reader.init(function () { show(state.readerFrom || "home"); }, saveProg);
    loadAmazon();
    loadAlarm();
    loadVolume();
    loadLibrary(function () {
      // Test hooks for screenshots: reader, reader-next<N>, reader-menu, reader-toc
      var m = /^reader(-next(\d+)|-menu|-toc)?$/.exec(start || "");
      if (m && state.library.length) {
        var id = state.library[state.library.length - 1].id;
        Reader.open(id, findItem(id), "0:0", function () {
          state.view = "reader";
          for (var v = 0; v < VIEWS.length; v++) $(VIEWS[v]).className = "view" + (VIEWS[v] === "reader" ? "" : " hidden");
          var n = m[2] ? parseInt(m[2], 10) : 0;
          for (var k = 0; k < n; k++) Reader.next();
          if (m[1] === "-menu") Reader.menu(true);
          if (m[1] === "-toc") Reader.toc(true);
        });
      }
    });
    setInterval(function () { loadLibrary(); }, 15 * 60000);
    // New build on the device (tools/deploy.sh writes js/build.txt): reload in place.
    Device.helper("/build", function (err, b) {
      if (err) return;
      state.build = b;
      setInterval(function () {
        Device.helper("/build", function (e2, b2) { if (!e2 && b2 && state.build && b2 !== state.build) location.reload(); }, 5000);
      }, 15000);
    }, 5000);
    // Wake detection: timers stop while the Kindle sleeps, so a long gap
    // between ticks means it just woke. Go Home (per the spec) and force a
    // full repaint; the window is only partly redrawn after the sleep screen.
    state.lastTick = new Date().getTime();
    setInterval(function () {
      var t = new Date().getTime();
      if (t - state.lastTick > 15000) {
        stopCountdown();
        var b = document.body;
        b.style.display = "none";
        b.offsetHeight; // force layout
        b.style.display = "";
        var last = null, lp = null;
        try { last = localStorage.getItem("ns-last"); lp = last ? prog(last) : null; } catch (e2) {}
        if (lp && lp.p < 0.98 && t - lp.at < 12 * 3600000 && findItem(last)) openBook(last);
        else show("home");
        loadTonight();
        loadLibrary();
        loadAmazon();
      }
      state.lastTick = t;
    }, 2000);
  }

  window.addEventListener("resize", scale, false);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, false);
  else init();
})();
