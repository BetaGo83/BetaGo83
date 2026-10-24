/* Browser-local company watchlist. It stores identity fields only; it is not account sync. */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.BetaGoWatchlist = factory(root.localStorage);
})(typeof window !== "undefined" ? window : globalThis, function (storage) {
  "use strict";
  var KEY = "betago83.watchlist.v1", MAX = 200;
  function text(value, max) { return typeof value === "string" && value.trim() && value.length <= max && !/[\u0000-\u001f\u007f<>]/.test(value) ? value.trim() : null; }
  function normalize(value) {
    if (!value || !text(value.id, 80) || !text(value.name, 100) || !text(value.ticker, 20) || !["KOSPI", "KOSDAQ"].includes(value.market)) return null;
    return { id: value.id.trim(), name: value.name.trim(), ticker: value.ticker.trim(), market: value.market, wiki_path: value.wiki_path === null ? null : text(value.wiki_path, 220) };
  }
  function read() {
    if (!storage || typeof storage.getItem !== "function") return [];
    try {
      var value = JSON.parse(storage.getItem(KEY) || "[]");
      if (!Array.isArray(value)) return [];
      var seen = new Set(); return value.map(normalize).filter(function (row) { if (!row || seen.has(row.id)) return false; seen.add(row.id); return true; }).slice(-MAX);
    } catch (_) { return []; }
  }
  function write(rows) { if (storage && typeof storage.setItem === "function") try { storage.setItem(KEY, JSON.stringify(rows.slice(-MAX))); } catch (_) {} }
  function list() { return read(); }
  function has(id) { return read().some(function (row) { return row.id === id; }); }
  function add(value) {
    var row = normalize(value); if (!row) return false;
    var rows = read().filter(function (item) { return item.id !== row.id; }); rows.push(row); write(rows); return true;
  }
  function remove(id) { var rows = read().filter(function (row) { return row.id !== id; }); write(rows); return rows.length; }
  function toggle(value) { var row = normalize(value); if (!row) return false; if (has(row.id)) { remove(row.id); return false; } add(row); return true; }
  function clear() { write([]); return 0; }
  return { key: KEY, max: MAX, list: list, has: has, add: add, remove: remove, toggle: toggle, clear: clear };
});
