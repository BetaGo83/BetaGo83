(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MapScope = factory();
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  var BUSINESS_TYPES = ["company"];
  var KNOWLEDGE_TYPES = ["company", "external", "theme", "industry"];
  var STRONG_LEVELS = ["공시 원문", "공시 항목", "거래소 자료", "공식 발표"];
  function ordered(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
  function copy(value) {
    if (Array.isArray(value)) return value.map(copy);
    if (value && typeof value === "object") {
      var result = {};
      Object.keys(value).forEach(function (key) {
        Object.defineProperty(result, key, { value: copy(value[key]), writable: true, enumerable: true, configurable: true });
      });
      return result;
    }
    return value;
  }
  function validGraph(nodes, edges) {
    if (!Array.isArray(nodes) || nodes.length > 5000 || !Array.isArray(edges) || edges.length > 50000) throw new Error("Invalid graph size");
    var byId = Object.create(null);
    nodes.forEach(function (node) {
      if (!node || typeof node.id !== "string" || !node.id || byId[node.id]) throw new Error("Invalid graph node");
      byId[node.id] = node;
    });
    return byId;
  }
  function strongEvidence(value) {
    return value && value.status === "확인" && typeof value.evidence_level === "string"
      && value.evidence_level.split("·").some(function (level) { return STRONG_LEVELS.indexOf(level.trim()) >= 0; });
  }
  function confirmedRelation(edge) {
    if (!edge) return false;
    var p = edge.presentation || {};
    return edge.type !== "테마" && edge.type !== "업종" && !p.muted && p.line_style !== "dashed"
      && Array.isArray(edge.evidence) && edge.evidence.some(strongEvidence);
  }
  function enrich(data) {
    if (!data || typeof data !== "object") throw new Error("Invalid graph");
    validGraph(data.nodes, data.edges);
    var result = copy(data), byId = Object.create(null), industries = Object.create(null), linked = new Set();
    result.nodes.forEach(function (node) {
      byId[node.id] = node;
      if (node.type === "industry" && typeof node.name === "string") industries[node.name] = node;
    });
    result.edges.forEach(function (edge) { if (edge.type === "업종") linked.add(JSON.stringify([edge.source, edge.target])); });
    result.nodes.slice().forEach(function (company) {
      if (company.type !== "company" || ["KOSPI", "KOSDAQ"].indexOf(company.market) < 0
        || typeof company.krx_industry !== "string" || !company.krx_industry.trim()
        || /미확인|대상\s*아님|해외|비상장|확인\s*(?:중|못)|분류\s*없음|^(?:N\/A|미분류|없음|[-–—]+)$/i.test(company.krx_industry.trim())) return;
      var name = company.krx_industry.trim(), industry = industries[name];
      if (!industry) {
        var id = "업종: " + name, suffix = 2;
        while (byId[id]) { id = "업종: " + name + " (" + suffix + ")"; suffix++; }
        industry = { id: id, type: "industry", name: name, aliases: [], themes: [], classifications: [],
          derived_from: "krx_industry", classification_dates: [], summary: "기업 페이지에 기재된 거래소 업종" };
        result.nodes.push(industry); industries[name] = industry; byId[id] = industry;
      }
      var date = typeof company.classification_as_of === "string" ? company.classification_as_of : "";
      if (!Array.isArray(industry.classification_dates)) industry.classification_dates = [];
      if (date && industry.classification_dates.indexOf(date) < 0) industry.classification_dates.push(date);
      industry.classification_dates.sort(ordered);
      var key = JSON.stringify([company.id, industry.id]);
      if (linked.has(key)) return;
      linked.add(key);
      var evidence = [{ date: date, text: "기업 페이지의 업종 필드: " + name,
        status: "기재", evidence_level: "위키 업종 필드", sources: [], weak: false,
        provenance: { company: company.id, field: "krx_industry", as_of: date } }];
      (Array.isArray(company.classifications) ? company.classifications : []).forEach(function (classification) {
        if (!classification || !strongEvidence(classification)) return;
        if (classification.topic !== name && classification.industry !== name && classification.krx_industry !== name) return;
        evidence.push(copy(classification));
      });
      result.edges.push({ source: company.id, target: industry.id, type: "업종", evidence: evidence,
        derived_from: "krx_industry", presentation: { label: "기업 페이지 업종", muted: false, line_style: "solid" } });
    });
    return result;
  }
  function hidden(kind, values) {
    if (!values) return false;
    if (Array.isArray(values)) return values.indexOf(kind) >= 0;
    if (values instanceof Set) return values.has(kind);
    return Object.prototype.hasOwnProperty.call(values, kind) && !!values[kind];
  }
  function permittedNodes(nodes, options) {
    var kinds = options.view === "relations" ? BUSINESS_TYPES : KNOWLEDGE_TYPES;
    var filter = options.types;
    if (filter !== undefined && !Array.isArray(filter) && !(filter instanceof Set)) throw new Error("Invalid node types");
    var byId = Object.create(null);
    nodes.forEach(function (node) {
      if (kinds.indexOf(node.type) < 0) return;
      if (filter !== undefined && !(filter instanceof Set ? filter.has(node.type) : filter.indexOf(node.type) >= 0)) return;
      byId[node.id] = node;
    });
    return byId;
  }
  function eligible(edge, byId, options) {
    if (!edge || typeof edge.source !== "string" || typeof edge.target !== "string" || edge.source === edge.target
      || !byId[edge.source] || !byId[edge.target] || hidden(edge.type, options.hiddenKinds)) return false;
    if (options.view === "relations" && (edge.type === "테마" || edge.type === "업종")) return false;
    if (options.includeUnconfirmed === true) return true;
    if (edge.type === "테마" || edge.type === "업종") {
      var p = edge.presentation || {};
      return !p.muted && p.line_style !== "dashed";
    }
    return confirmedRelation(edge);
  }
  function defaultFrom(nodes, edges, byId, options) {
    var peers = Object.create(null);
    nodes.forEach(function (node) { if (node.type === "company" && byId[node.id]) peers[node.id] = new Set(); });
    edges.forEach(function (edge) {
      if (!edge || !eligible(edge, byId, options) || edge.type === "테마" || edge.type === "업종"
        || BUSINESS_TYPES.indexOf(byId[edge.source].type) < 0 || BUSINESS_TYPES.indexOf(byId[edge.target].type) < 0) return;
      if (peers[edge.source]) peers[edge.source].add(edge.target);
      if (peers[edge.target]) peers[edge.target].add(edge.source);
    });
    return Object.keys(peers).sort(function (a, b) { return peers[b].size - peers[a].size || ordered(a, b); })[0] || null;
  }
  function normalize(options) {
    var result = Object.assign({ view: "relations", mode: "nearby", depth: 1, includeUnconfirmed: false }, options || {});
    if (result.limit === undefined) result.limit = result.mode === "all" ? 400 : 80;
    if (["relations", "knowledge"].indexOf(result.view) < 0 || ["nearby", "all"].indexOf(result.mode) < 0
      || [1, 2].indexOf(result.depth) < 0
      || !Number.isInteger(result.limit) || result.limit < 1) throw new Error("Invalid graph scope options");
    result.limit = Math.min(result.mode === "all" ? 400 : 80, result.limit);
    if (result.mode === "all") {
      if (result.edgeLimit === undefined) result.edgeLimit = 1200;
      if (!Number.isInteger(result.edgeLimit) || result.edgeLimit < 1) throw new Error("Invalid graph edge limit");
      result.edgeLimit = Math.min(1200, result.edgeLimit);
    }
    return result;
  }
  function defaultFocus(nodes, edges, options) {
    validGraph(nodes, edges);
    var opts = normalize(options), allowed = permittedNodes(nodes, opts);
    return defaultFrom(nodes, edges, allowed, opts);
  }
  function select(nodes, edges, options) {
    var all = validGraph(nodes, edges), opts = normalize(options), allowed = permittedNodes(nodes, opts);
    if (opts.mode === "all") {
      // Whole-map scope ignores focus/theme. Use nearby mode for a subject or theme neighborhood.
      var candidatesAll = [];
      edges.forEach(function (edge, index) { if (eligible(edge, allowed, opts)) candidatesAll.push(index); });
      candidatesAll.sort(function (a, b) {
        return ordered(edges[a].source, edges[b].source) || ordered(edges[a].target, edges[b].target)
          || ordered(edges[a].type || "", edges[b].type || "") || a - b;
      });
      // The overview is capped for rendering. Name-order truncation made most visible
      // companies lose their counterpart outside the cap, so rank themes first and then
      // connected entities by eligible degree. Isolated entities remain deterministic
      // fallbacks after the connected portion has been selected.
      var degree = Object.create(null);
      candidatesAll.forEach(function (index) {
        var edge = edges[index]; degree[edge.source] = (degree[edge.source] || 0) + 1;
        degree[edge.target] = (degree[edge.target] || 0) + 1;
      });
      var rankedAll = Object.keys(allowed).sort(function (a, b) {
        var at = allowed[a].type === "theme" ? 1 : 0, bt = allowed[b].type === "theme" ? 1 : 0;
        if (at !== bt) return bt - at;
        var ad = degree[a] || 0, bd = degree[b] || 0;
        if ((ad > 0) !== (bd > 0)) return ad > 0 ? -1 : 1;
        return bd - ad || ordered(a, b);
      });
      var nodeIdsAll = rankedAll.slice(0, opts.limit), keptAll = new Set(nodeIdsAll);
      var edgeIndicesAll = candidatesAll.filter(function (index) {
        return keptAll.has(edges[index].source) && keptAll.has(edges[index].target);
      }).slice(0, opts.edgeLimit);
      var hiddenNodesAll = rankedAll.length - nodeIdsAll.length;
      var hiddenEdgesAll = candidatesAll.length - edgeIndicesAll.length;
      return { nodeIds: nodeIdsAll, edgeIndices: edgeIndicesAll, focusId: null, rootIds: [],
        totalNodes: rankedAll.length, hiddenNodes: hiddenNodesAll,
        totalEdges: candidatesAll.length, hiddenEdges: hiddenEdgesAll,
        truncated: hiddenNodesAll > 0 || hiddenEdgesAll > 0 };
    }
    var candidates = [], adjacent = Object.create(null);
    Object.keys(allowed).forEach(function (id) { adjacent[id] = new Set(); });
    edges.forEach(function (edge, index) {
      if (!eligible(edge, allowed, opts)) return;
      candidates.push(index); adjacent[edge.source].add(edge.target); adjacent[edge.target].add(edge.source);
    });
    var roots = [];
    if (opts.focus && all[opts.focus]) {
      if (allowed[opts.focus]) roots.push(opts.focus);
    }
    else if (opts.theme && all[opts.theme] && all[opts.theme].type === "theme") {
      if (opts.view === "knowledge") { if (allowed[opts.theme]) roots.push(opts.theme); }
      else {
        var members = new Set();
        edges.forEach(function (edge) {
          if (edge && edge.type === "테마" && edge.target === opts.theme && allowed[edge.source]
            && allowed[edge.source].type === "company") members.add(edge.source);
        });
        roots = Array.from(members).sort(ordered);
      }
    } else {
      var focus = defaultFrom(nodes, edges, allowed, opts);
      if (focus) roots.push(focus);
    }
    var distances = Object.create(null), frontier = roots.slice();
    roots.forEach(function (id) { distances[id] = 0; });
    for (var hop = 1; hop <= opts.depth && frontier.length; hop++) {
      var next = [];
      frontier.forEach(function (id) {
        adjacent[id].forEach(function (peer) {
          if (Object.prototype.hasOwnProperty.call(distances, peer)) return;
          distances[peer] = hop; next.push(peer);
        });
      });
      frontier = next;
    }
    var ranked = Object.keys(distances).sort(function (a, b) { return distances[a] - distances[b] || ordered(a, b); });
    var nodeIds = ranked.slice(0, opts.limit), kept = new Set(nodeIds);
    var scopeEdges = candidates.filter(function (index) {
      return Object.prototype.hasOwnProperty.call(distances, edges[index].source)
        && Object.prototype.hasOwnProperty.call(distances, edges[index].target);
    });
    var edgeIndices = scopeEdges.filter(function (index) { return kept.has(edges[index].source) && kept.has(edges[index].target); });
    return { nodeIds: nodeIds, edgeIndices: edgeIndices, focusId: roots[0] || null, rootIds: roots,
      totalNodes: ranked.length, hiddenNodes: ranked.length - nodeIds.length,
      totalEdges: scopeEdges.length, hiddenEdges: scopeEdges.length - edgeIndices.length, truncated: ranked.length > nodeIds.length };
  }
  return { enrich: enrich, select: select, defaultFocus: defaultFocus, confirmedRelation: confirmedRelation };
});
