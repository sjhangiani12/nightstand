/* Device layer. On the Kindle it uses the Mesquite nativeBridge (lipc) and
   the local helper on 127.0.0.1:8765. In a desktop browser every call is a
   no-op, so the UI can be built and screenshotted on the Mac. */
var Device = (function () {
  var HELPER = "http://127.0.0.1:8765";
  var onKindle = (typeof nativeBridge !== "undefined");

  function lipcSetInt(service, prop, value) {
    try {
      if (onKindle && nativeBridge.setIntLipcProperty) {
        nativeBridge.setIntLipcProperty(service, prop, value);
        return true;
      }
    } catch (e) {}
    return false;
  }

  function lipcGetInt(service, prop) {
    try {
      if (onKindle && nativeBridge.getIntLipcProperty) {
        return nativeBridge.getIntLipcProperty(service, prop);
      }
    } catch (e) {}
    return null;
  }

  function lipcSetStr(service, prop, value) {
    try {
      if (onKindle && nativeBridge.setLipcProperty) {
        nativeBridge.setLipcProperty(service, prop, value);
        return true;
      }
    } catch (e) {}
    return false;
  }

  // GET a helper path. cb(err, text). Times out after ms.
  function helper(path, cb, ms) {
    var done = false;
    var xhr;
    try { xhr = new XMLHttpRequest(); } catch (e) { if (cb) cb(e); return; }
    var timer = setTimeout(function () {
      if (done) return;
      done = true;
      try { xhr.abort(); } catch (e) {}
      if (cb) cb(new Error("timeout"));
    }, ms || 4000);
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4 || done) return;
      done = true;
      clearTimeout(timer);
      if (xhr.status === 200) { if (cb) cb(null, xhr.responseText); }
      else if (cb) cb(new Error("status " + xhr.status));
    };
    try {
      xhr.open("GET", HELPER + path, true);
      xhr.send(null);
    } catch (e) {
      if (!done) { done = true; clearTimeout(timer); if (cb) cb(e); }
    }
  }

  return {
    onKindle: onKindle,
    getBrightness: function () { return lipcGetInt("com.lab126.powerd", "flIntensity"); },
    setBrightness: function (level) {
      if (!lipcSetInt("com.lab126.powerd", "flIntensity", level)) helper("/brightness/" + level);
    },
    getBattery: function () { return lipcGetInt("com.lab126.powerd", "battLevel"); },
    getWifi: function () { return lipcGetInt("com.lab126.cmd", "wirelessEnable"); },
    setWifi: function (on) {
      if (!lipcSetInt("com.lab126.cmd", "wirelessEnable", on ? 1 : 0)) helper("/wifi/" + (on ? 1 : 0));
    },
    stockHome: function () {
      // Escape hatch: the real Amazon home. The home watcher lets it through
      // when this flag file exists (see device/nightstand-home.sh).
      helper("/stock-home", function (err) {
        if (err) lipcSetStr("com.lab126.appmgrd", "start", "app://com.lab126.booklet.home");
      });
    },
    sleep: function () { helper("/sleep"); },
    helper: helper
  };
})();
