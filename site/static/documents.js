(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.DocumentLinks = api; root.addEventListener("DOMContentLoaded", api.start); }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  var MAX_BYTES = 4 * 1024 * 1024, MAX_NODES = 60, MAX_EDGES = 240;
  var TYPES = { companies: "기업", themes: "테마", industries: "산업" };
  function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
  function safeSlug(value) {
    if (typeof value !== "string" || value.length > 250 || /[\s%?#:\\\x00-\x1f\x7f]/.test(value)) return false;
    var parts = value.split("/");
    return parts.length === 2 && Object.prototype.hasOwnProperty.call(TYPES, parts[0]) && !!parts[1]
      && !parts[1].startsWith(".") && !["index", "log", "readme", "claude"].includes(parts[1].toLowerCase());
  }
  function pageURL(slug) {
    if (!safeSlug(slug)) throw new Error("Invalid document slug");
    return "../" + slug.split("/").map(encodeURIComponent).join("/");
  }
  function canonicalPath(filePath) {
    return typeof filePath === "string" && filePath.endsWith(".md") ? filePath.slice(0, -3).split("/").map(function (part) {
      return part.replace(/\s/g, "-").replace(/&/g, "-and-").replace(/%/g, "-percent").replace(/\?/g, "").replace(/#/g, "");
    }).join("/") : null;
  }
  // Same navigation whitelist as MapNewsView; document selection has its own slug check.
  function readViewState(search) {
    var params = new URLSearchParams(search), state = {};
    var allowed = { mode: ["relations", "news"], metric: ["news", "disclosure"], scale: ["log", "area"], days: ["1", "7", "14"] };
    Object.keys(allowed).forEach(function (key) {
      var values = params.getAll(key);
      if (values.length === 1 && allowed[key].indexOf(values[0]) >= 0) state[key] = values[0];
    });
    var dates = params.getAll("date"), date = dates.length === 1 ? dates[0] : "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && date.slice(0, 4) !== "0000") {
      var time = Date.parse(date + "T00:00:00Z");
      if (Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date) state.date = date;
    }
    return state;
  }
  function prepare(index) {
    if (!object(index)) throw new Error("Invalid content index");
    var keys = Object.keys(index);
    if (keys.length > 3000) throw new Error("Too many documents");
    var nodes = [], bySlug = Object.create(null);
    keys.forEach(function (slug) {
      if (!safeSlug(slug)) return;
      var record = index[slug];
      if (!object(record) || record.slug !== slug || canonicalPath(record.filePath) !== slug) return;
      if (typeof record.title !== "string" || !record.title.trim() || record.title.length > 200 || /[\x00-\x1f\x7f<>]/.test(record.title)) throw new Error("Invalid document title");
      if (!Array.isArray(record.links) || record.links.length > 1000) throw new Error("Invalid document links");
      var node = { id: slug, title: record.title, kind: slug.split("/")[0], outgoing: [], incoming: [] };
      nodes.push(node); bySlug[slug] = node;
    });
    nodes.sort(function (a, b) { return a.title.localeCompare(b.title, "ko") || a.id.localeCompare(b.id); });
    var edges = [], ignoredLinks = 0;
    nodes.forEach(function (node) {
      var unique = new Set();
      index[node.id].links.forEach(function (target) {
        if (typeof target !== "string" || !Object.prototype.hasOwnProperty.call(bySlug, target) || target === node.id) { ignoredLinks++; return; }
        if (unique.has(target)) return;
        unique.add(target);
        if (edges.length >= 40000) throw new Error("Too many document links");
        node.outgoing.push(target); bySlug[target].incoming.push(node.id);
        edges.push({ source: node.id, target: target });
      });
    });
    return { nodes: nodes, bySlug: bySlug, edges: edges, excluded: keys.length - nodes.length, ignoredLinks: ignoredLinks };
  }
  function neighborhood(model, selected, depth) {
    if (!Object.prototype.hasOwnProperty.call(model.bySlug, selected) || ![1, 2].includes(depth)) throw new Error("Invalid neighborhood");
    var distance = new Map([[selected, 0]]), frontier = [selected];
    for (var step = 1; step <= depth; step++) {
      var next = [];
      frontier.forEach(function (id) {
        var node = model.bySlug[id];
        node.outgoing.concat(node.incoming).forEach(function (peer) {
          if (!distance.has(peer)) { distance.set(peer, step); next.push(peer); }
        });
      });
      frontier = next;
    }
    var candidates = Array.from(distance.keys()).sort(function (a, b) {
      return distance.get(a) - distance.get(b) || model.bySlug[a].title.localeCompare(model.bySlug[b].title, "ko") || a.localeCompare(b);
    });
    var chosen = candidates.slice(0, MAX_NODES), displayed = new Set(chosen);
    var eligible = model.edges.filter(function (edge) { return displayed.has(edge.source) && displayed.has(edge.target); });
    eligible.sort(function (a, b) {
      return Number(b.source === selected || b.target === selected) - Number(a.source === selected || a.target === selected)
        || a.source.localeCompare(b.source) || a.target.localeCompare(b.target);
    });
    return { ids: chosen, distances: distance, edges: eligible.slice(0, MAX_EDGES), reachable: candidates.length,
      hiddenNodes: candidates.length - chosen.length, hiddenEdges: eligible.length - Math.min(eligible.length, MAX_EDGES) };
  }
  function positions(ids) {
    var columns = Math.min(6, Math.max(1, ids.length)), width = 900, cell = width / columns;
    return { width: width, height: Math.max(220, Math.ceil(ids.length / columns) * 92 + 30),
      points: ids.map(function (id, i) { return { id: id, x: cell * (i % columns + .5), y: 38 + Math.floor(i / columns) * 92 }; }) };
  }
  async function readIndex(fetcher, signal) {
    var controller = new AbortController(), reader = null, complete = false, timer = null, abortListener = null;
    function abort() { controller.abort(); }
    function bounded(pending) {
      return new Promise(function (resolve, reject) {
        function cleanup() { controller.signal.removeEventListener("abort", fail); }
        function fail() { cleanup(); reject(new Error("Document index unavailable")); }
        Promise.resolve(pending).then(function (value) { cleanup(); resolve(value); }, function (error) { cleanup(); reject(error); });
        if (controller.signal.aborted) { fail(); return; }
        controller.signal.addEventListener("abort", fail, { once: true });
      });
    }
    try {
      if (signal) {
        if (signal.aborted) throw new Error("Document index unavailable");
        abortListener = abort; signal.addEventListener("abort", abortListener, { once: true });
      }
      timer = setTimeout(abort, 10000);
      var response = await bounded(fetcher("./contentIndex.json", { cache: "no-store", credentials: "omit", signal: controller.signal }));
      if (!response.ok || !response.body || typeof response.body.getReader !== "function") throw new Error("Document index unavailable");
      var advertised = response.headers.get("content-length");
      if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > MAX_BYTES)) throw new Error("Document index unavailable");
      reader = response.body.getReader();
      // One fixed buffer bounds memory independently of the number of chunks.
      var bytes = new Uint8Array(MAX_BYTES), size = 0;
      while (true) {
        if (controller.signal.aborted) throw new Error("Document index unavailable");
        var part = await bounded(reader.read()); if (part.done) break;
        if (!(part.value instanceof Uint8Array)) throw new Error("Document index unavailable");
        if (size + part.value.byteLength > MAX_BYTES) throw new Error("Document index too large");
        bytes.set(part.value, size); size += part.value.byteLength;
      }
      if (controller.signal.aborted) throw new Error("Document index unavailable");
      var model = prepare(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))));
      complete = true;
      return model;
    } finally {
      clearTimeout(timer);
      if (signal && abortListener) signal.removeEventListener("abort", abortListener);
      if (!complete) {
        controller.abort();
        // Cleanup cannot extend the deadline when the stream itself is stalled.
        if (reader) { try { Promise.resolve(reader.cancel()).catch(function () {}); } catch (_) {} }
      }
      if (reader) { try { reader.releaseLock(); } catch (_) {} }
    }
  }
  async function start() {
    var select = document.getElementById("document-select"), search = document.getElementById("document-search"), depth = document.getElementById("document-depth");
    var status = document.getElementById("document-status"), counts = document.getElementById("document-counts"), svg = document.getElementById("document-graph"), panel = document.getElementById("document-detail");
    var model, selected, viewState = readViewState(window.location.search);
    function html(tag, text, parent) { var element = document.createElement(tag); if (text != null) element.textContent = text; if (parent) parent.appendChild(element); return element; }
    function shape(tag, attrs, parent) { var element = document.createElementNS("http://www.w3.org/2000/svg", tag); Object.keys(attrs).forEach(function (key) { element.setAttribute(key, attrs[key]); }); parent.appendChild(element); return element; }
    function options(query) {
      select.replaceChildren();
      var matches = model.nodes.filter(function (node) { return (node.title + " " + node.id).toLowerCase().includes(query.toLowerCase()); });
      matches.forEach(function (node) { var option = html("option", node.title + " · " + TYPES[node.kind], select); option.value = node.id; });
      if (!matches.length) { html("option", "일치하는 문서 없음", select); select.disabled = true; }
      else { select.disabled = false; if (matches.some(function (node) { return node.id === selected; })) select.value = selected; }
      return matches;
    }
    function choose(id) {
      if (!Object.prototype.hasOwnProperty.call(model.bySlug, id)) return;
      selected = id; search.value = ""; options(""); select.value = id; render();
    }
    function references(title, ids, direction) {
      html("h3", title + " " + ids.length + "개", panel);
      html("p", direction, panel);
      var list = html("ul", null, panel); list.className = "reference-list";
      ids.slice().sort(function (a, b) { return model.bySlug[a].title.localeCompare(model.bySlug[b].title, "ko"); }).slice(0, 60).forEach(function (id) {
        var node = model.bySlug[id], row = html("li", null, list), button = html("button", node.title + " 중심으로 보기", row);
        button.type = "button"; button.addEventListener("click", function (event) {
          choose(id);
          if (event.detail === 0) select.focus({ preventScroll: true });
        });
        var link = html("a", "문서 열기", row); link.href = pageURL(id); link.target = "_top";
      });
      if (!ids.length) html("p", "표시 대상 문서 사이에서는 연결이 없습니다.", panel);
      if (ids.length > 60) html("p", "목록에서 " + (ids.length - 60) + "개를 더 생략했습니다. 문서 선택에서 이름으로 찾을 수 있습니다.", panel);
    }
    function render() {
      var view = neighborhood(model, selected, Number(depth.value)), layout = positions(view.ids), pointById = Object.create(null), current = model.bySlug[selected];
      ["relations", "knowledge"].forEach(function (kind) {
        var query = new URLSearchParams(viewState);
        if (kind === "knowledge") query.set("view", "knowledge");
        // The map verifies this public slug against its loaded graph; never guess from a title.
        if (current.kind === "companies" || current.kind === "themes") query.set("document", current.id);
        document.getElementById(kind + "-link").href = "./map.html" + (query.size ? "?" + query.toString() : "");
      });
      layout.points.forEach(function (point) { pointById[point.id] = point; });
      svg.replaceChildren(); svg.setAttribute("viewBox", "0 0 " + layout.width + " " + layout.height);
      var defs = shape("defs", {}, svg);
      ["base", "out", "in"].forEach(function (kind) {
        var marker = shape("marker", { id: "doc-arrow-" + kind, markerWidth: 6, markerHeight: 6, refX: 5, refY: 3, orient: "auto" }, defs);
        shape("path", { d: "M0,0 L6,3 L0,6 z", fill: "var(--" + (kind === "base" ? "line" : kind) + ")" }, marker);
      });
      view.edges.forEach(function (edge) {
        var a = pointById[edge.source], b = pointById[edge.target], dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy) || 1;
        var kind = edge.source === selected ? "out" : edge.target === selected ? "in" : "base";
        shape("line", { x1: a.x + dx / length * 13, y1: a.y + dy / length * 13, x2: b.x - dx / length * 16, y2: b.y - dy / length * 16,
          class: "doc-edge " + kind, "marker-end": "url(#doc-arrow-" + kind + ")" }, svg);
      });
      layout.points.forEach(function (point) {
        var node = model.bySlug[point.id], hops = view.distances.get(point.id), group = shape("g", { class: "doc-node " + node.kind + (point.id === selected ? " selected" : ""),
          transform: "translate(" + point.x + "," + point.y + ")", tabindex: 0, role: "button", "aria-label": node.title + " · " + (hops ? hops + "단계 연결, 중심으로 보기" : "선택 문서") }, svg);
        shape("title", {}, group).textContent = node.title;
        shape("circle", { r: point.id === selected ? 13 : 10 }, group);
        var title = node.title.length > 15 ? node.title.slice(0, 14) + "…" : node.title;
        shape("text", { y: 32 }, group).textContent = title;
        shape("text", { y: 47, class: "hop" }, group).textContent = hops ? hops + "단계 · " + TYPES[node.kind] : "선택 문서";
        group.addEventListener("click", function () { choose(point.id); });
        group.addEventListener("keydown", function (event) { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(point.id); document.getElementById("document-select").focus(); } });
      });
      counts.textContent = "주변 " + view.reachable + "개 중 " + view.ids.length + "개 표시 · 범위 안에서 생략한 문서 " + view.hiddenNodes + "개 · 표시 링크 " + view.edges.length + "개 · 표시 문서 사이에서 생략한 링크 " + view.hiddenEdges + "개. 작은 화면에서는 그림을 가로로 밀어 볼 수 있습니다.";
      status.textContent = "공개 지식 문서 " + model.nodes.length + "개 · 목록·운영·별칭 등 제외 " + model.excluded + "개 · 현재 선택: " + current.title;
      panel.replaceChildren(); html("h2", current.title, panel); html("p", TYPES[current.kind] + " 문서", panel);
      var page = html("a", "선택 문서 열기 →", panel); page.href = pageURL(selected); page.target = "_top";
      references("이 문서가 참조", current.outgoing, "선택 문서 → 아래 문서");
      references("이 문서를 참조", current.incoming, "아래 문서 → 선택 문서");
    }
    if (window.location.protocol === "file:") {
      status.textContent = "저장한 파일에서는 문서 목록을 불러올 수 없습니다. 공개 사이트에서 열어 주세요.";
      var live = html("a", "공개 문서 연결 열기", panel); live.href = "https://betago83.github.io/BetaGo83/static/documents.html"; return;
    }
    var controller = new AbortController();
    function abortIndex() { controller.abort(); }
    try {
      window.addEventListener("pagehide", abortIndex, { once: true });
      model = await readIndex(fetch, controller.signal);
      if (!model.nodes.length) throw new Error("No public knowledge documents");
      var requestedValues = new URLSearchParams(window.location.search).getAll("node");
      var requested = requestedValues.length === 1 ? requestedValues[0] : null;
      selected = requested && Object.prototype.hasOwnProperty.call(model.bySlug, requested) ? requested : Object.prototype.hasOwnProperty.call(model.bySlug, "companies/삼성전자") ? "companies/삼성전자" : model.nodes[0].id;
      search.disabled = select.disabled = depth.disabled = false; options(""); render();
      select.addEventListener("change", function () { choose(select.value); });
      depth.addEventListener("change", render);
      search.addEventListener("input", function () {
        var matches = options(search.value.trim());
        status.textContent = matches.length ? "검색 결과 " + matches.length + "개. 문서 선택 또는 Enter로 열어 주세요." : "일치하는 공개 문서가 없습니다. 검색어를 지우면 전체 목록으로 돌아갑니다.";
      });
      search.addEventListener("keydown", function (event) { if (event.key === "Enter" && !select.disabled) choose(select.value); });
      window.addEventListener("storage", function (event) { if (event.key === "theme" && ["light", "dark"].includes(event.newValue)) document.documentElement.dataset.theme = event.newValue; });
    } catch (_) {
      status.textContent = "문서 목록을 불러오지 못했습니다. 페이지를 새로 고치거나 위키에서 문서를 열어 주세요."; status.classList.add("error");
      counts.textContent = "자료 확인 실패 · 문서나 링크가 0개라는 뜻은 아닙니다.";
    } finally { window.removeEventListener("pagehide", abortIndex); }
  }
  return { prepare: prepare, neighborhood: neighborhood, positions: positions, safeSlug: safeSlug, pageURL: pageURL, readIndex: readIndex, readViewState: readViewState, start: start };
});
