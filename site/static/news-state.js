/* Small browser-only state for unread public observations. It stores URLs, never article bodies. */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.NewsState = factory(root.localStorage);
})(typeof window !== "undefined" ? window : globalThis, function (storage) {
  "use strict";
  var KEY = "betago83.news-unread.v1", MAX = 500, URL_MAX = 4096;
  function valid(value) { return typeof value === "string" && value.length > 0 && value.length <= URL_MAX && /^https:\/\//.test(value); }
  function read() {
    if (!storage || typeof storage.getItem !== "function") return [];
    try {
      var value = JSON.parse(storage.getItem(KEY) || "[]");
      return Array.isArray(value) ? value.filter(valid).slice(-MAX) : [];
    } catch (_) { return []; }
  }
  function write(values) {
    if (!storage || typeof storage.setItem !== "function") return;
    try { storage.setItem(KEY, JSON.stringify(values.slice(-MAX))); } catch (_) {}
  }
  function list() { return read(); }
  function remember(values) {
    var next = read(), seen = new Set(next);
    (Array.isArray(values) ? values : [values]).filter(valid).forEach(function (value) { if (!seen.has(value)) { seen.add(value); next.push(value); } });
    next = next.slice(-MAX); write(next); return next.length;
  }
  function has(value) { return valid(value) && read().indexOf(value) >= 0; }
  function markRead(values) {
    var removed = new Set(Array.isArray(values) ? values : [values]), next = read().filter(function (value) { return !removed.has(value); });
    write(next); return next.length;
  }
  function clear() { write([]); return 0; }
  return { key: KEY, max: MAX, list: list, remember: remember, has: has, markRead: markRead, clear: clear };
});
