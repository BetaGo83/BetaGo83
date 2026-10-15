(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MapNews = factory();
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  var DAY = 86400000;
  var SOURCES = {
    "한국경제": { hosts: ["hankyung.com", "www.hankyung.com"], path: /^\/article\/[0-9]{8,30}$/ },
    "파이낸셜뉴스": { hosts: ["fnnews.com", "www.fnnews.com"], path: /^\/news\/[0-9]{8,30}$/ },
    "이투데이": { hosts: ["etoday.co.kr", "www.etoday.co.kr"], path: /^\/news\/view\/[0-9]{1,20}$/ }
  };
  function requireValue(ok, reason) { if (!ok) throw new Error(reason); }
  function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
  function text(value, maximum) {
    return typeof value === "string" && value.length > 0 && value.length <= maximum && value === value.trim()
      && !/[\x00-\x1f\x7f<>\\]/.test(value);
  }
  function dayValue(day) {
    requireValue(typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day), "Invalid calendar date");
    var value = Date.parse(day + "T00:00:00Z");
    requireValue(Number.isFinite(value) && new Date(value).toISOString().slice(0, 10) === day, "Invalid calendar date");
    return value;
  }
  function timestamp(value) {
    requireValue(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?\+09:00$/.test(value), "Invalid KST timestamp");
    dayValue(value.slice(0, 10));
    requireValue(+value.slice(11, 13) < 24 && +value.slice(14, 16) < 60 && +value.slice(17, 19) < 60, "Invalid clock time");
    var result = Date.parse(value);
    requireValue(Number.isFinite(result), "Invalid timestamp");
    return result;
  }
  function shiftDay(day, offset) {
    requireValue(Number.isInteger(offset) && Math.abs(offset) <= 36600, "Invalid day offset");
    return new Date(dayValue(day) + offset * DAY).toISOString().slice(0, 10);
  }
  function dateRange(start, end) {
    var count = (dayValue(end) - dayValue(start)) / DAY + 1;
    requireValue(count >= 1 && count <= 366, "Invalid date range");
    return Array.from({ length: count }, function (_, i) { return shiftDay(start, i); });
  }
  function slug(path) {
    return path.split("/").map(function (part) {
      return part.replace(/\s/g, "-").replace(/&/g, "-and-").replace(/%/g, "-percent").replace(/\?/g, "").replace(/#/g, "");
    }).join("/");
  }
  function entity(value, kind) {
    requireValue(object(value) && text(value.name, 100) && text(value.url, 400), "Invalid entity");
    var prefix = "../" + kind + "/";
    requireValue(value.url.indexOf(prefix) === 0, "Invalid entity path");
    var part = value.url.slice(prefix.length), decoded;
    try { decoded = decodeURIComponent(part); } catch (_) { throw new Error("Invalid entity encoding"); }
    requireValue(text(decoded, 150) && decoded !== "." && decoded !== ".." && !/[\s/%?#:\\]/.test(decoded), "Invalid entity slug");
    requireValue(part === decoded || part === encodeURIComponent(decoded), "Invalid entity encoding");
    return { name: value.name, path: kind + "/" + decoded };
  }
  function sourceUrl(value, kind, name) {
    requireValue(text(value, 500) && !/[\s%]/.test(value), "Invalid source URL");
    var url;
    try { url = new URL(value); } catch (_) { throw new Error("Invalid source URL"); }
    requireValue(url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash
      && url.href === value, "Invalid source URL");
    if (kind === "disclosure") {
      requireValue(name === "DART" && url.hostname === "dart.fss.or.kr" && url.pathname === "/dsaf001/main.do"
        && /^\?rcpNo=[0-9]{14}$/.test(url.search), "Invalid disclosure URL");
    } else {
      var policy = Object.prototype.hasOwnProperty.call(SOURCES, name) && SOURCES[name];
      requireValue(policy && policy.hosts.indexOf(url.hostname) >= 0 && policy.path.test(url.pathname) && !url.search, "Invalid news URL");
    }
    return url.href;
  }
  function prepare(feed, nodes) {
    requireValue(object(feed) && feed.schema === 1 && feed.retention_days === 14, "Invalid feed schema");
    var generated = timestamp(feed.generated_at), collected = timestamp(feed.collected_at), coverage = feed.coverage;
    requireValue(collected <= generated && object(coverage), "Invalid feed dates");
    var first = timestamp(coverage.from), last = timestamp(coverage.to);
    requireValue(first <= last && last <= collected + 300000 && last - first <= 14 * DAY + 300000, "Invalid feed coverage");
    requireValue(Number.isInteger(coverage.queries_total) && coverage.queries_total >= 0 && coverage.queries_total <= 1000
      && Number.isInteger(coverage.queries_ok) && coverage.queries_ok >= 0 && coverage.queries_ok <= coverage.queries_total
      && typeof coverage.partial === "boolean" && (coverage.queries_ok === coverage.queries_total || coverage.partial), "Invalid coverage status");
    requireValue(Array.isArray(feed.items) && feed.items.length <= 300 && Array.isArray(nodes) && nodes.length <= 5000, "Feed exceeds display limits");
    var companies = Object.create(null), companyIds = [];
    nodes.forEach(function (node) {
      if (!node || node.type !== "company") return;
      requireValue(text(node.id, 100) && text(node.path, 250) && node.path.indexOf("companies/") === 0
        && !Object.prototype.hasOwnProperty.call(companies, node.id), "Invalid graph company");
      companies[node.id] = slug(node.path);
      companyIds.push(node.id);
    });
    var documents = [], byURL = Object.create(null), ids = Object.create(null);
    feed.items.forEach(function (item) {
      requireValue(object(item) && typeof item.id === "string" && /^[0-9a-f]{12,64}$/.test(item.id)
        && !ids[item.id] && text(item.title, 300), "Invalid feed item");
      ids[item.id] = true;
      var published = timestamp(item.published_at);
      requireValue(published >= first && published <= last && (item.kind === "news" || item.kind === "disclosure")
        && ["new", "followup", "correction"].indexOf(item.status) >= 0
        && item.evidence === (item.kind === "news" ? "기사 제목" : "공시 제목"), "Invalid item metadata");
      var companyIDs = [];
      ["companies", "themes"].forEach(function (field) {
        requireValue(Array.isArray(item[field]) && item[field].length <= 20, "Invalid entity list");
        var seen = Object.create(null);
        item[field].forEach(function (value) {
          var checked = entity(value, field);
          requireValue(!seen[checked.path], "Duplicate entity");
          seen[checked.path] = true;
          if (field === "companies" && Object.prototype.hasOwnProperty.call(companies, checked.name)
            && companies[checked.name] === checked.path) companyIDs.push(checked.name);
        });
      });
      requireValue(Array.isArray(item.sources) && item.sources.length >= 1 && item.sources.length <= 5
        && Number.isInteger(item.group_size) && item.group_size >= item.sources.length && item.group_size <= 10000
        && ["single", "exact", "similar"].indexOf(item.grouping) >= 0
        && (item.grouping === "single") === (item.group_size === 1), "Invalid source list");
      var receipt = null;
      item.sources.forEach(function (source) {
        requireValue(object(source) && text(source.name, 40), "Invalid source");
        var sourceTime = timestamp(source.published_at);
        requireValue(sourceTime >= first && sourceTime <= last, "Invalid source date");
        var url = sourceUrl(source.url, item.kind, source.name);
        if (item.kind === "disclosure") {
          requireValue(!receipt || receipt === url, "Multiple disclosure receipts in one item");
          requireValue(source.published_at.slice(0, 10) === item.published_at.slice(0, 10), "Disclosure date mismatch");
          receipt = url;
        }
        var date = (item.kind === "disclosure" ? item.published_at : source.published_at).slice(0, 10);
        var existing = byURL[url];
        if (existing) {
          requireValue(existing.kind === item.kind && existing.date === date, "Conflicting document metadata");
          companyIDs.forEach(function (id) { if (existing.companies.indexOf(id) < 0) existing.companies.push(id); });
          return;
        }
        var doc = { key: url, url: url, title: item.title, kind: item.kind, date: date,
          time: item.kind === "disclosure" ? null : source.published_at, companies: companyIDs.slice(), source: source.name };
        byURL[url] = doc;
        documents.push(doc);
      });
    });
    documents.sort(function (a, b) {
      return a.date < b.date ? 1 : a.date > b.date ? -1 : (a.time || "") < (b.time || "") ? 1 : (a.time || "") > (b.time || "") ? -1 : a.key.localeCompare(b.key);
    });
    return { documents: documents, companyIds: companyIds, minDate: documents.length ? documents[documents.length - 1].date : null,
      maxDate: documents.length ? documents[0].date : null, collectedAt: feed.collected_at, partial: coverage.partial,
      queriesOK: coverage.queries_ok, queriesTotal: coverage.queries_total };
  }
  function aggregate(prepared, options) {
    requireValue(object(prepared) && Array.isArray(prepared.documents) && prepared.documents.length <= 1500
      && Array.isArray(prepared.companyIds) && object(options) && [1, 7, 14].indexOf(options.days) >= 0, "Invalid aggregation options");
    var endDate = options.endDate;
    dayValue(endDate);
    var startDate = shiftDay(endDate, 1 - options.days), byCompany = Object.create(null), byDay = Object.create(null);
    var days = dateRange(startDate, endDate).map(function (date) {
      return byDay[date] = { date: date, news: 0, disclosure: 0 };
    });
    prepared.companyIds.forEach(function (id) { byCompany[id] = { news: 0, disclosure: 0, items: [] }; });
    var docs = prepared.documents.filter(function (doc) { return doc.date >= startDate && doc.date <= endDate; });
    var totals = { news: 0, disclosure: 0 };
    docs.forEach(function (doc) {
      totals[doc.kind]++;
      byDay[doc.date][doc.kind]++;
      doc.companies.forEach(function (id) {
        var stats = byCompany[id];
        if (stats) { stats[doc.kind]++; stats.items.push(doc); }
      });
    });
    return { startDate: startDate, endDate: endDate, documents: docs, byCompany: byCompany, totals: totals, days: days };
  }
  function relationCounts(nodes, edges) {
    var peers = Object.create(null), counts = Object.create(null);
    nodes.forEach(function (node) { if (node.type === "company" || node.type === "external") peers[node.id] = new Set(); });
    edges.forEach(function (edge) {
      var presentation = edge.presentation || {};
      if (edge.type === "테마" || presentation.muted || presentation.line_style === "dashed"
        || edge.source === edge.target || !peers[edge.source] || !peers[edge.target]) return;
      var verified = Array.isArray(edge.evidence) && edge.evidence.some(function (evidence) {
        return evidence && evidence.status === "확인"
          && typeof evidence.evidence_level === "string"
          && evidence.evidence_level.split("·").some(function (level) {
            return ["공시 원문", "공시 항목", "거래소 자료", "공식 발표"].indexOf(level.trim()) >= 0;
          });
      });
      if (verified) { peers[edge.source].add(edge.target); peers[edge.target].add(edge.source); }
    });
    Object.keys(peers).forEach(function (id) { counts[id] = peers[id].size; });
    return counts;
  }
  function radius(count, scale) {
    requireValue(Number.isFinite(count) && count >= 0 && (scale === undefined || scale === "area" || scale === "log"), "Invalid radius input");
    return count === 0 ? 3 : Math.min(30, scale === "log" ? 8 * Math.sqrt(Math.log1p(count)) : 5 * Math.sqrt(count));
  }
  return { prepare: prepare, aggregate: aggregate, relationCounts: relationCounts, radius: radius, shiftDay: shiftDay, dateRange: dateRange };
});
