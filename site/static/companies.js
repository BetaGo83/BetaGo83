/* A bounded, searchable identity list. It does not infer themes or relationships. */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory();
  else {
    root.CompanyCatalog = factory();
    root.addEventListener("DOMContentLoaded", function () { root.CompanyCatalog.mount(root.document, root); });
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  var MAX_BYTES = 1048576, MAX_ROWS = 5000, PAGE_SIZE = 50, TIMEOUT_MS = 10000;
  var SOURCES = {
    KOSPI: "https://kind.krx.co.kr/corpgeneral/corpList.do?method=download&searchType=13&marketType=stockMkt",
    KOSDAQ: "https://kind.krx.co.kr/corpgeneral/corpList.do?method=download&searchType=13&marketType=kosdaqMkt"
  };
  function exactKeys(value, names) {
    return value && typeof value === "object" && !Array.isArray(value)
      && Object.keys(value).length === names.length && names.every(function (name) { return Object.prototype.hasOwnProperty.call(value, name); });
  }
  function safeText(value, max) {
    return typeof value === "string" && value.length > 0 && value.length <= max && value === value.trim() && !/[\u0000-\u001f\u007f<>]/.test(value);
  }
  function safePath(value) {
    return value === null || safeText(value, 220) && value.indexOf("companies/") === 0
      && value.split("/").length === 2 && !/[\\?#%]/.test(value) && ![".", "..", ""].includes(value.split("/")[1]);
  }
  function normalized(value) { return value.normalize("NFKC").toLowerCase(); }
  function order(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
  function validate(value) {
    if (!exactKeys(value, ["schema_version", "as_of", "sources", "companies"]) || value.schema_version !== 1
        || typeof value.as_of !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.as_of)
        || !Number.isFinite(Date.parse(value.as_of + "T00:00:00Z"))
        || new Date(value.as_of + "T00:00:00Z").toISOString().slice(0, 10) !== value.as_of
        || !exactKeys(value.sources, ["KOSPI", "KOSDAQ"])
        || Object.keys(SOURCES).some(function (market) { return value.sources[market] !== SOURCES[market]; })
        || !Array.isArray(value.companies) || !value.companies.length || value.companies.length > MAX_ROWS) throw new Error("Invalid catalog");
    var tickers = new Set(), paths = new Set();
    var rows = value.companies.map(function (row) {
      if (!exactKeys(row, ["ticker", "name", "market", "krx_industry", "wiki_path"])
          || typeof row.ticker !== "string" || !/^[0-9A-Z]{6}$/.test(row.ticker) || tickers.has(row.ticker)
          || !Object.prototype.hasOwnProperty.call(SOURCES, row.market)
          || !safeText(row.name, 100) || row.krx_industry !== null && !safeText(row.krx_industry, 160) || !safePath(row.wiki_path)
          || row.wiki_path !== null && paths.has(row.wiki_path)) throw new Error("Invalid catalog row");
      tickers.add(row.ticker); if (row.wiki_path !== null) paths.add(row.wiki_path);
      return { ticker: row.ticker, name: row.name, market: row.market, krx_industry: row.krx_industry, wiki_path: row.wiki_path,
        search: normalized([row.name, row.ticker, row.krx_industry === null ? "" : row.krx_industry].join(" ")) };
    }).sort(function (a, b) { return order(a.name, b.name) || order(a.ticker, b.ticker); });
    return { as_of: value.as_of, companies: rows, linked: rows.filter(function (row) { return row.wiki_path !== null; }).length };
  }
  function page(catalog, query, market, number) {
    if (typeof query !== "string" || query.length > 120 || !["", "KOSPI", "KOSDAQ"].includes(market)) throw new Error("Invalid filter");
    var term = normalized(query.trim());
    var found = catalog.companies.filter(function (row) { return (!market || row.market === market) && (!term || row.search.includes(term)); });
    var pages = Math.ceil(found.length / PAGE_SIZE);
    number = Number.isSafeInteger(number) ? Math.max(0, Math.min(number, Math.max(0, pages - 1))) : 0;
    return { rows: found.slice(number * PAGE_SIZE, (number + 1) * PAGE_SIZE), total: found.length, page: number, pages: pages };
  }
  function links(row) {
    if (!row || row.wiki_path === null || !safePath(row.wiki_path)) return null;
    var slug = row.wiki_path.replace(/\s+/g, "-").replace(/&/g, "-and-");
    return { wiki: "../" + slug.split("/").map(encodeURIComponent).join("/"),
      map: "./map.html?document=" + encodeURIComponent(slug) };
  }
  async function read(options) {
    options = options || {};
    var controller = new AbortController(), reader = null, complete = false, timeout = null;
    function abort() { controller.abort(); }
    function bounded(pending) {
      return new Promise(function (resolve, reject) {
        function cleanup() { controller.signal.removeEventListener("abort", fail); }
        function fail() { cleanup(); reject(new Error("Catalog aborted")); }
        Promise.resolve(pending).then(function (value) { cleanup(); resolve(value); }, function (error) { cleanup(); reject(error); });
        if (controller.signal.aborted) { fail(); return; }
        controller.signal.addEventListener("abort", fail, { once: true });
      });
    }
    try {
      if (options.signal) {
        if (options.signal.aborted) throw new Error("Catalog aborted");
        options.signal.addEventListener("abort", abort, { once: true });
      }
      timeout = setTimeout(abort, TIMEOUT_MS);
      var response = await bounded((options.fetch || fetch)("./companies.json", { cache: "no-store", credentials: "omit", signal: controller.signal }));
      if (!response.ok || !response.body || typeof response.body.getReader !== "function") throw new Error("Catalog response");
      reader = response.body.getReader();
      var length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) throw new Error("Catalog size");
      var bytes = new Uint8Array(MAX_BYTES), size = 0;
      while (true) {
        if (controller.signal.aborted) throw new Error("Catalog aborted");
        var part = await bounded(reader.read());
        if (part.done) break;
        if (!(part.value instanceof Uint8Array) || size + part.value.byteLength > MAX_BYTES) throw new Error("Catalog size");
        bytes.set(part.value, size); size += part.value.byteLength;
      }
      if (controller.signal.aborted) throw new Error("Catalog aborted");
      var catalog = validate(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))));
      complete = true;
      return catalog;
    } finally {
      clearTimeout(timeout);
      if (options.signal) options.signal.removeEventListener("abort", abort);
      if (!complete) {
        controller.abort();
        if (reader) { try { Promise.resolve(reader.cancel()).catch(function () {}); } catch (_) {} }
      }
      if (reader) { try { reader.releaseLock(); } catch (_) {} }
    }
  }
  async function mount(doc, env) {
    var $ = function (id) { return doc.getElementById(id); };
    var request = new AbortController(), catalog = null, currentPage = 0;
    function stop() { request.abort(); }
    env.addEventListener("pagehide", stop, { once: true });
    try { var theme = env.localStorage.getItem("theme"); if (theme === "dark" || theme === "light") doc.documentElement.setAttribute("data-theme", theme); } catch (_) {}
    function element(tag, value, parent) {
      var node = doc.createElement(tag); if (value !== null) node.textContent = value;
      if (parent) parent.appendChild(node); return node;
    }
    function link(parent, label, href, external) {
      var node = element("a", label, parent); node.href = href; node.target = external ? "_blank" : "_top";
      if (external) node.rel = "noopener noreferrer";
    }
    function render() {
      if (!catalog) return;
      var result = page(catalog, $("search").value, $("market").value, currentPage); currentPage = result.page;
      $("result-title").textContent = "검색 결과 " + result.total.toLocaleString("ko-KR") + "개";
      $("company-rows").replaceChildren();
      result.rows.forEach(function (row) {
        var tr = element("tr", null, $("company-rows"));
        var title = element("td", null, tr); element("strong", row.name, title); element("div", row.ticker, title).className = "code";
        element("td", row.market === "KOSPI" ? "코스피" : "코스닥", tr);
        element("td", row.krx_industry === null ? "공식 목록에서 확인" : row.krx_industry, tr);
        var destination = element("td", null, tr), hrefs = links(row);
        if (hrefs) { var group = element("div", null, destination); group.className = "row-links"; link(group, "기업 위키", hrefs.wiki, false); link(group, "관계 지도", hrefs.map, false); }
        else element("span", "테마 연결 미구축", destination).className = "pending";
      });
      $("table-wrap").hidden = !result.total; $("empty").hidden = !!result.total;
      $("pager").hidden = result.pages < 2;
      $("page-number").textContent = result.total ? (result.page + 1) + " / " + result.pages + "쪽" : "";
      $("prev").disabled = result.page === 0; $("next").disabled = result.page + 1 >= result.pages;
    }
    $("filters").addEventListener("submit", function (event) { event.preventDefault(); });
    $("search").addEventListener("input", function () { currentPage = 0; render(); });
    $("market").addEventListener("change", function () { currentPage = 0; render(); });
    ["prev", "next"].forEach(function (id) { $(id).addEventListener("click", function () { currentPage += id === "next" ? 1 : -1; render(); $("results").focus({ preventScroll: true }); }); });
    try {
      catalog = await read({ signal: request.signal, fetch: env.fetch.bind(env) });
      if (request.signal.aborted) return;
      $("as-of").textContent = "거래소 목록 기준: " + catalog.as_of + " 보관본";
      $("counts").textContent = "전체 " + catalog.companies.length.toLocaleString("ko-KR") + "개 · 기존 위키 연결 " + catalog.linked.toLocaleString("ko-KR")
        + "개 · 테마 연결 미구축 " + (catalog.companies.length - catalog.linked).toLocaleString("ko-KR") + "개";
      Object.keys(SOURCES).forEach(function (market) { link($("sources"), "공식 KIND " + (market === "KOSPI" ? "코스피" : "코스닥") + " 목록", SOURCES[market], true); });
      $("filter-fields").disabled = false; render();
    } catch (_) {
      if (request.signal.aborted) return;
      $("counts").textContent = "자료를 확인하지 못했습니다.";
      $("result-title").textContent = "목록 확인 실패"; $("error").hidden = false;
    } finally { env.removeEventListener("pagehide", stop); }
  }
  return { validate: validate, page: page, links: links, read: read, mount: mount, MAX_BYTES: MAX_BYTES, MAX_ROWS: MAX_ROWS, PAGE_SIZE: PAGE_SIZE };
});
