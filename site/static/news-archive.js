/* Bounded, content-addressed public archive. No whole-history arrays or storage. */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory(require("./map-news.js"));
  else root.NewsArchive = factory(root.MapNews);
})(typeof window !== "undefined" ? window : globalThis, function (MapNews) {
  "use strict";
  var HASH = /^[0-9a-f]{64}$/, ID = /^[0-9a-f]{24}$/, MAX_BYTES = 262144, MAX_DEPTH = 32;
  function check(ok, message) { if (!ok) throw new Error(message || "Invalid archive"); }
  function keys(v, expected) { return v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === expected.length && expected.every(function (k) { return Object.prototype.hasOwnProperty.call(v, k); }); }
  function integer(v) { return Number.isSafeInteger(v) && v >= 0; }
  function key(v) { return typeof v === "string" && v.length > 0 && v.length <= 160 && !/[\x00-\x20\x7f]/.test(v); }
  function clock(v) {
    check(typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/.test(v), "Invalid archive time");
    var n = Date.parse(v); check(Number.isFinite(n) && new Date(n + 32400000).toISOString().slice(0, 19) === v.slice(0, 19), "Invalid archive date"); return n;
  }
  function stopped(signal) { if (signal && signal.aborted) { var e = new Error("Archive operation cancelled"); e.name = "AbortError"; throw e; } }
  function summary(v) {
    check(keys(v, ["hash", "count", "first", "last"]) && integer(v.count), "Invalid archive summary");
    check(v.count === 0 ? v.hash === null && v.first === "" && v.last === "" : HASH.test(v.hash) && key(v.first) && key(v.last) && v.first <= v.last, "Invalid archive range");
    return v;
  }
  function manifest(v) {
    check(keys(v, ["schema", "generated_at", "collected_at", "coverage", "retention_days", "total_items", "indexes"])
      && v.schema === 1 && v.retention_days === 30 && integer(v.total_items), "Invalid archive manifest");
    var generated = clock(v.generated_at), collected = clock(v.collected_at), c = v.coverage;
    check(collected <= generated && generated <= Date.now() + 300000, "Invalid archive generation");
    check(keys(c, ["from", "to", "queries_total", "queries_ok", "partial", "note"])
      && clock(c.from) === Math.min(collected, generated - 30 * 86400000) && c.to === v.collected_at, "Invalid archive coverage");
    check(integer(c.queries_total) && c.queries_total <= 1000 && integer(c.queries_ok) && c.queries_ok <= c.queries_total
      && typeof c.partial === "boolean" && (c.queries_ok === c.queries_total || c.partial)
      && typeof c.note === "string" && c.note.length <= 300 && !/[\x00-\x1f\x7f<>\\]/.test(c.note), "Invalid archive coverage status");
    check(keys(v.indexes, ["ordered", "ids", "observed"]), "Invalid archive indexes");
    Object.keys(v.indexes).forEach(function (k) { summary(v.indexes[k]); });
    check(v.indexes.ordered.count === v.total_items && v.indexes.ids.count === v.total_items && v.indexes.observed.count <= v.total_items, "Archive count mismatch");
    return v;
  }
  function canonical(v) {
    if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
    if (v && typeof v === "object") return "{" + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ":" + canonical(v[k]); }).join(",") + "}";
    check(v === null || typeof v === "string" || typeof v === "boolean" || Number.isSafeInteger(v), "Invalid canonical JSON");
    return JSON.stringify(v);
  }
  function orderedKey(item) {
    var s = item.sources[0], day = item.provided_on || item.published_at.slice(0, 10);
    var rank = item.kind === "disclosure" ? "0" : item.date_precision === "day" ? "1" : "2";
    return day + "|" + rank + "|" + (rank === "2" ? item.published_at : s.observed_at || "!") + "|" + item.id;
  }
  function create(options) {
    options = options || {};
    var fetcher = options.fetch || fetch, crypt = options.crypto || globalThis.crypto, cache = new Map(), cacheBytes = 0, pending = null;
    var stats = { requests: 0, cacheNodes: 0, maxCacheNodes: 0, cacheBytes: 0, maxCacheBytes: 0, active: 0, maxActive: 0 };
    async function hash(bytes) {
      check(crypt && crypt.subtle, "Secure archive verification is unavailable");
      return Array.from(new Uint8Array(await crypt.subtle.digest("SHA-256", bytes))).map(function (n) { return n.toString(16).padStart(2, "0"); }).join("");
    }
    async function itemHash(item) { return hash(new TextEncoder().encode(canonical(item) + "\n")); }
    async function read(path, maximum, signal) {
      stopped(signal);
      // Only one request owns the network slot; callers cancel superseded work.
      if (pending) { try { await pending; } catch (_) {} stopped(signal); }
      check(!pending, "Archive request already running");
      var controller = new AbortController(), reader = null, complete = false, done;
      pending = new Promise(function (resolve) { done = resolve; });
      function abort() { controller.abort(); }
      function bounded(work) {
        return new Promise(function (resolve, reject) {
          function cleanup() { controller.signal.removeEventListener("abort", fail); }
          function fail() { cleanup(); var e = new Error("Archive request stopped"); e.name = "AbortError"; reject(e); }
          Promise.resolve(work).then(function (v) { cleanup(); resolve(v); }, function (e) { cleanup(); reject(e); });
          if (controller.signal.aborted) fail(); else controller.signal.addEventListener("abort", fail, { once: true });
        });
      }
      if (signal) signal.addEventListener("abort", abort, { once: true });
      var timer = setTimeout(abort, 10000);
      stats.requests++; stats.active++; stats.maxActive = Math.max(stats.maxActive, stats.active);
      try {
        var response = await bounded(fetcher(path, { cache: "no-store", credentials: "omit", redirect: "error", signal: controller.signal }));
        check(response.ok && response.body && response.body.getReader, "Archive response unavailable");
        var length = response.headers.get("content-length");
        check(length === null || /^\d+$/.test(length) && Number(length) <= maximum, "Archive response too large");
        reader = response.body.getReader(); var bytes = new Uint8Array(maximum), size = 0;
        while (true) {
          stopped(signal); var part = await bounded(reader.read()); if (part.done) break;
          check(part.value instanceof Uint8Array && size + part.value.byteLength <= maximum, "Archive response too large");
          bytes.set(part.value, size); size += part.value.byteLength;
        }
        stopped(signal); complete = true; return bytes.slice(0, size);
      } finally {
        clearTimeout(timer); if (signal) signal.removeEventListener("abort", abort);
        if (!complete) { controller.abort(); if (reader) { try { Promise.resolve(reader.cancel()).catch(function () {}); } catch (_) {} } }
        if (reader) { try { reader.releaseLock(); } catch (_) {} }
        stats.active--; pending = null; done();
      }
    }
    function parse(bytes) { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    async function open(signal) { return manifest(parse(await read("./news-archive.json", 65536, signal))); }
    async function node(ref, signal) {
      summary(ref); check(ref.count > 0, "Empty node reference"); stopped(signal);
      var cached = cache.get(ref.hash), value = cached && cached.value;
      if (cached) { cache.delete(ref.hash); cache.set(ref.hash, cached); }
      else {
        var bytes = await read("./news-archive/" + ref.hash.slice(0, 2) + "/" + ref.hash + ".json", MAX_BYTES, signal);
        check(await hash(bytes) === ref.hash, "Archive hash mismatch"); stopped(signal); value = parse(bytes);
        check(value && (value.type === "leaf" || value.type === "branch") && keys(value, ["schema", "type", "count", "first", "last", value.type === "leaf" ? "entries" : "children"])
          && value.schema === 1 && integer(value.count) && value.count > 0 && key(value.first) && key(value.last), "Invalid archive node");
        var rows = value.type === "leaf" ? value.entries : value.children, total = 0, prior = null;
        check(Array.isArray(rows) && rows.length > 0 && rows.length <= (value.type === "leaf" ? 64 : 32), "Archive node fanout");
        rows.forEach(function (row) {
          var first, last;
          if (value.type === "leaf") { check(keys(row, ["key", "value"]) && key(row.key), "Invalid archive entry"); first = last = row.key; total++; }
          else { summary(row); check(row.count > 0, "Empty archive branch"); first = row.first; last = row.last; total += row.count; }
          check(integer(total) && (prior === null || prior < first), "Archive order mismatch"); prior = last;
        });
        check(value.count === total && value.first === (value.type === "leaf" ? rows[0].key : rows[0].first)
          && value.last === (value.type === "leaf" ? rows[rows.length - 1].key : rows[rows.length - 1].last), "Archive node summary mismatch");
        cache.set(ref.hash, { value: value, size: bytes.byteLength }); cacheBytes += bytes.byteLength;
        while (cache.size > 64 || cacheBytes > 1048576) {
          var oldest = cache.keys().next().value; cacheBytes -= cache.get(oldest).size; cache.delete(oldest);
        }
        stats.cacheNodes = cache.size; stats.maxCacheNodes = Math.max(stats.maxCacheNodes, cache.size);
        stats.cacheBytes = cacheBytes; stats.maxCacheBytes = Math.max(stats.maxCacheBytes, cacheBytes);
      }
      check(value.count === ref.count && value.first === ref.first && value.last === ref.last, "Archive child summary mismatch");
      return value;
    }
    async function lookup(snapshot, index, target, signal) {
      check(["ordered", "ids", "observed"].includes(index) && key(target), "Invalid archive lookup");
      var ref = snapshot.indexes[index];
      for (var depth = 0; ref.count && depth < MAX_DEPTH; depth++) {
        stopped(signal); if (target < ref.first || target > ref.last) return null;
        var value = await node(ref, signal);
        if (value.type === "leaf") { var row = value.entries.find(function (e) { return e.key === target; }); return row ? row.value : null; }
        var child = value.children.find(function (c) { return c.first <= target && c.last >= target; });
        if (!child) return null; check(child.count <= ref.count, "Invalid archive branch count"); ref = child;
      }
      check(!ref.count, "Archive depth exceeded"); return null;
    }
    async function* entries(snapshot, index, options) {
      options = options || {}; check(["ordered", "ids", "observed"].includes(index), "Invalid archive index");
      var stack = [{ ref: snapshot.indexes[index], depth: 0 }], prior = null;
      while (stack.length) {
        stopped(options.signal); var frame = stack.pop(), ref = frame.ref;
        if (!ref.count || options.lower && ref.last < options.lower || options.upper && ref.first > options.upper
          || options.after && ref.last <= options.after || options.before && ref.first >= options.before) continue;
        check(frame.depth < MAX_DEPTH, "Archive depth exceeded");
        var value = await node(ref, options.signal);
        if (value.type === "branch") {
          var children = value.children.slice(); if (!options.reverse) children.reverse();
          children.forEach(function (child) { check(child.count <= ref.count, "Invalid archive branch count"); stack.push({ ref: child, depth: frame.depth + 1 }); });
          check(stack.length <= 32 * MAX_DEPTH, "Archive traversal stack exceeded");
        } else {
          var rows = value.entries.slice(); if (options.reverse) rows.reverse();
          for (var i = 0; i < rows.length; i++) {
            var e = rows[i]; stopped(options.signal);
            if (options.lower && e.key < options.lower || options.upper && e.key > options.upper || options.after && e.key <= options.after || options.before && e.key >= options.before) continue;
            check(prior === null || (options.reverse ? e.key < prior : e.key > prior), "Archive iterator order"); prior = e.key;
            yield e;
          }
        }
      }
    }
    async function verifyItem(snapshot, entry, nodes, signal) {
      var item = entry.value, doc = MapNews.archiveItem(item, snapshot, nodes || []), source = item.sources[0];
      if (item.published_at !== null) clock(item.published_at);
      if (source.observed_at !== null) clock(source.observed_at);
      check(ID.test(item.id) && (await hash(new TextEncoder().encode(source.url))).slice(0, 24) === item.id && orderedKey(item) === entry.key, "Archive item identity mismatch");
      var identity = await lookup(snapshot, "ids", item.id, signal), digest = await itemHash(item);
      check(keys(identity, ["key", "sha256"]) && identity.key === entry.key && identity.sha256 === digest, "Archive identity index mismatch");
      if (source.observed_at !== null) {
        var observation = await lookup(snapshot, "observed", source.observed_at + "|" + item.id, signal);
        check(keys(observation, ["id", "key", "sha256"]) && observation.id === item.id && observation.key === entry.key && observation.sha256 === digest, "Archive observation index mismatch");
      }
      stopped(signal); return { key: entry.key, item: item, doc: doc };
    }
    async function* items(snapshot, options) {
      options = options || {};
      for await (var entry of entries(snapshot, "ordered", options)) yield await verifyItem(snapshot, entry, options.nodes, options.signal);
    }
    function relation(previous, next) {
      if (!previous) return "initial";
      if (clock(next.collected_at) < clock(previous.collected_at) || clock(next.generated_at) < clock(previous.generated_at)) return "rollback";
      return next.collected_at === previous.collected_at ? "same-collection" : "new-collection";
    }
    async function* newlyObserved(previous, next, options) {
      options = options || {};
      if (relation(previous, next) !== "new-collection") return;
      for await (var entry of entries(next, "observed", { after: previous.collected_at + "|~", upper: next.collected_at + "|~", signal: options.signal })) {
        var v = entry.value; check(keys(v, ["id", "key", "sha256"]) && ID.test(v.id) && key(v.key) && HASH.test(v.sha256), "Invalid observed entry");
        var item = await lookup(next, "ordered", v.key, options.signal); check(item, "Missing observed item");
        var checked = await verifyItem(next, { key: v.key, value: item }, options.nodes, options.signal);
        check(entry.key === item.sources[0].observed_at + "|" + item.id && v.id === item.id && v.sha256 === await itemHash(item), "Observed item mismatch");
        var old = await lookup(previous, "ids", item.id, options.signal);
        if (old === null) yield checked;
        else check(keys(old, ["key", "sha256"]) && key(old.key) && HASH.test(old.sha256), "Invalid previous identity");
      }
    }
    async function aggregate(snapshot, options) {
      var nodes = options.nodes || [], days = options.days, endDate = options.endDate;
      check([1, 7, 14].includes(days), "Invalid archive interval");
      var startDate = MapNews.shiftDay(endDate, 1 - days), byCompany = Object.create(null), byDay = Object.create(null);
      var dates = MapNews.dateRange(startDate, endDate).map(function (date) { return byDay[date] = { date: date, news: 0, disclosure: 0 }; });
      nodes.forEach(function (n) { if (n.type === "company") byCompany[n.id] = { news: 0, disclosure: 0, items: [], byDay: Object.create(null) }; });
      var totals = { news: 0, disclosure: 0 }, scoped = { news: 0, disclosure: 0 }, processed = 0;
      for await (var value of items(snapshot, { lower: startDate + "|", upper: endDate + "|~", reverse: true, nodes: nodes, signal: options.signal })) {
        var d = value.doc; totals[d.kind]++; byDay[d.date][d.kind]++;
        if (!options.scope || d.companies.some(function (id) { return options.scope.has(id); })) scoped[d.kind]++;
        d.companies.forEach(function (id) {
          var c = byCompany[id]; if (!c) return; c[d.kind]++;
          if (c.items.length < 8) c.items.push(d);
          var perDay = c.byDay[d.date] || (c.byDay[d.date] = { news: 0, disclosure: 0 }); perDay[d.kind]++;
        });
        processed++; if (options.progress && processed % 64 === 0) options.progress(processed);
      }
      return { startDate: startDate, endDate: endDate, byCompany: byCompany, totals: totals, scopeTotals: scoped, days: dates, processed: processed };
    }
    async function scanPage(snapshot, query, options) {
      options = options || {}; var rows = [], inspected = 0, cursor = options.cursor || null, exhausted = true;
      var limit = options.limit || 40, budget = options.budget || 512;
      check(Number.isInteger(limit) && limit > 0 && limit <= 40 && Number.isInteger(budget) && budget > 0 && budget <= 2048, "Invalid scan budget");
      for await (var value of items(snapshot, { reverse: true, before: cursor, signal: options.signal })) {
        inspected++; cursor = value.key;
        if (matches(value.item, query)) rows.push(value.item);
        if (options.progress && inspected % 64 === 0) options.progress(inspected);
        if (rows.length === limit || inspected === budget) { exhausted = cursor === snapshot.indexes.ordered.first; break; }
      }
      return { rows: rows, inspected: inspected, cursor: cursor, exhausted: exhausted };
    }
    async function changes(previous, next, options) {
      options = options || {};
      var result = { reason: relation(previous, next), news: 0, disclosure: 0, inside: 0, total: 0, companies: [], maxDate: null };
      var companies = new Set();
      for await (var value of newlyObserved(previous, next, options)) {
        var doc = value.doc; result[doc.kind]++; result.total++;
        if (!options.matches || options.matches(value)) {
          result.inside++; doc.companies.forEach(function (id) { companies.add(id); });
        }
        if (result.maxDate === null || doc.date > result.maxDate) result.maxDate = doc.date;
      }
      result.companies = Array.from(companies); return result;
    }
    return { open: open, entries: entries, lookup: lookup, items: items, newlyObserved: newlyObserved, aggregate: aggregate,
      relation: relation, changes: changes, scanPage: scanPage, itemHash: itemHash, stats: stats, clear: function () { cache.clear(); cacheBytes = 0; stats.cacheNodes = stats.cacheBytes = 0; } };
  }
  function matches(item, query) {
    return (!query.kind || item.kind === query.kind) && (!query.state || item.status === query.state)
      && (!query.source || item.sources.some(function (s) { return s.name === query.source; }))
      && (!query.company || item.companies.some(function (v) { return v.name === query.company; }))
      && (!query.theme || item.themes.some(function (v) { return v.name === query.theme; }))
      && (!query.text || [item.title].concat(item.sources.map(function (v) { return v.name; }), item.companies.map(function (v) { return v.name; }), item.themes.map(function (v) { return v.name; })).join(" ").toLocaleLowerCase("ko").includes(query.text.trim().toLocaleLowerCase("ko")));
  }
  return { create: create, manifest: manifest, canonical: canonical, orderedKey: orderedKey, matches: matches };
});
