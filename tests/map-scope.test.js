"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const MapScope = require("../site/static/map-scope.js");

function fixture() {
  const nodes = [
    ...["a", "b", "shared", "outside", "candidate", "isolated", "metadata-only"].map(id => ({ id, type: "company", themes: ["tech-1"] })),
    { id: "tech-1", type: "theme", category: "기술·디지털" },
    { id: "tech-2", type: "theme", category: "기술·디지털" },
    { id: "tech-empty", type: "theme", category: "기술·디지털" },
    { id: "health", type: "theme", category: "헬스케어" },
    ...["industry-1", "industry-2"].map(id => ({ id, type: "industry" })),
    ...["external-1", "external-2", "external-3"].map(id => ({ id, type: "external" }))
  ];
  const classification = (source, target, extra = {}) => ({ source, target, type: "테마", ...extra });
  const relation = (source, target, type = "공급", level = "공식 발표") => ({ source, target, type, evidence: [{ status: "확인", evidence_level: level }] });
  const edges = [
    classification("outside", "health"),
    classification("a", "tech-1"),
    classification("shared", "tech-1"),
    classification("shared", "tech-2"),
    classification("b", "tech-2"),
    classification("shared", "health"),
    classification("candidate", "tech-1", { presentation: { line_style: "dashed" } }),
    relation("a", "b"),
    relation("b", "shared", "경쟁", "기사 제목"),
    relation("a", "outside"),
    { source: "a", target: "industry-1", type: "업종" },
    { source: "outside", target: "industry-1", type: "업종" },
    { source: "outside", target: "industry-2", type: "업종" },
    relation("a", "external-1", "협력"),
    relation("shared", "external-2", "협력", "기사 제목"),
    relation("outside", "external-3", "협력")
  ];
  return { nodes, edges };
}

function choose(data, options = {}) {
  return MapScope.select(data.nodes, data.edges, {
    view: "knowledge", mode: "all", types: ["company", "theme"], category: "기술·디지털", ...options
  });
}

function sortedIds(result) { return result.nodeIds.slice().sort(); }

test("category uses exact theme membership and eligible classification edges", () => {
  const result = choose(fixture());
  assert.deepEqual(sortedIds(result), ["a", "b", "shared", "tech-1", "tech-2", "tech-empty"]);
  assert.deepEqual(result.edgeIndices.slice().sort((a, b) => a - b), [1, 2, 3, 4, 7]);
  assert.equal(result.totalNodes, 6);
  assert.equal(result.totalEdges, 5);
  assert.equal(result.truncated, false);
  assert.equal(result.focusId, null);
  assert.deepEqual(result.rootIds, []);
});

test("shared membership keeps a single company and never creates a relationship", () => {
  const data = fixture(), before = JSON.stringify(data), result = choose(data);
  assert.equal(result.nodeIds.filter(id => id === "shared").length, 1);
  assert.equal(result.edgeIndices.includes(8), false, "title-only company relation stays excluded");
  assert.equal(result.edgeIndices.includes(9), false, "a confirmed relation does not pull in an outside company");
  assert.equal(result.edgeIndices.includes(5), false, "a shared company's other theme stays outside the category");
  assert.equal(JSON.stringify(data), before, "selection leaves source nodes, edges and metadata unchanged");
  result.edgeIndices.forEach(index => {
    const edge = data.edges[index];
    assert.ok(result.nodeIds.includes(edge.source) && result.nodeIds.includes(edge.target));
  });
});

test("unknown and non-exact category values return empty results without a default company", () => {
  for (const category of ["없음", "기술", " 기술·디지털", "기술·디지털 "]) {
    assert.deepEqual(choose(fixture(), { category }), {
      nodeIds: [], edgeIndices: [], focusId: null, rootIds: [], totalNodes: 0, hiddenNodes: 0,
      totalEdges: 0, hiddenEdges: 0, truncated: false
    });
  }
  assert.throws(() => choose(fixture(), { category: 1 }), /Invalid graph category/);
});

test("optional industries and external nodes stay one eligible edge from category companies", () => {
  const result = choose(fixture(), { types: ["company", "theme", "industry", "external"] });
  assert.deepEqual(sortedIds(result), ["a", "b", "external-1", "industry-1", "shared", "tech-1", "tech-2", "tech-empty"]);
  assert.deepEqual(result.edgeIndices.slice().sort((a, b) => a - b), [1, 2, 3, 4, 7, 10, 13]);
  assert.equal(result.totalNodes, 8);
  assert.equal(result.totalEdges, 7);
});

test("node and line visibility do not erase documented company membership", () => {
  const result = choose(fixture(), { types: new Set(["company"]), hiddenKinds: ["테마"] });
  assert.deepEqual(sortedIds(result), ["a", "b", "shared"]);
  assert.deepEqual(result.edgeIndices, [7]);
  const allHidden = choose(fixture(), { hiddenKinds: new Set(["테마", "공급"]) });
  assert.equal(allHidden.totalNodes, 6);
  assert.equal(allHidden.totalEdges, 0);
});

test("explicit unconfirmed display preserves the existing presentation opt-in", () => {
  const result = choose(fixture(), { includeUnconfirmed: true, types: ["company", "theme", "external"] });
  assert.ok(result.nodeIds.includes("candidate"));
  assert.ok(result.nodeIds.includes("external-2"));
  assert.ok(result.edgeIndices.includes(6));
  assert.ok(result.edgeIndices.includes(8));
  assert.ok(result.edgeIndices.includes(14));
  assert.equal(result.nodeIds.includes("outside"), false);
});

test("reverse stored classification endpoints are still read without rewriting source indices", () => {
  const data = fixture();
  data.edges[1] = { source: "tech-1", target: "a", type: "테마" };
  const result = choose(data);
  assert.ok(result.nodeIds.includes("a"));
  assert.ok(result.edgeIndices.includes(1));
  assert.deepEqual(data.edges[1], { source: "tech-1", target: "a", type: "테마" });
});

test("category caps report complete candidate totals and omitted nodes and edges", () => {
  const result = choose(fixture(), { limit: 4, edgeLimit: 1 });
  assert.equal(result.nodeIds.length, 4);
  assert.equal(result.edgeIndices.length, 1);
  assert.equal(result.totalNodes, 6);
  assert.equal(result.hiddenNodes, 2);
  assert.equal(result.totalEdges, 5);
  assert.equal(result.hiddenEdges, 4);
  assert.equal(result.truncated, true);
  assert.deepEqual(result, choose(fixture(), { limit: 4, edgeLimit: 1 }));
});

test("an absent or empty category preserves legacy all-scope selection", () => {
  const data = fixture();
  const options = { view: "knowledge", mode: "all", types: ["company", "theme"], limit: 400 };
  const baseline = MapScope.select(data.nodes, data.edges, options);
  assert.deepEqual(choose(data, { category: "" }), baseline);
  assert.deepEqual(choose(data, { category: undefined }), baseline);
  assert.deepEqual(sortedIds(baseline), ["a", "b", "candidate", "health", "isolated", "metadata-only", "outside", "shared", "tech-1", "tech-2", "tech-empty"]);
});

test("nearby scope keeps explicit focus priority even if a category is passed", () => {
  const data = fixture();
  for (const view of ["relations", "knowledge"]) {
    const options = { view, mode: "nearby", focus: "outside", depth: 1 };
    const baseline = MapScope.select(data.nodes, data.edges, options);
    assert.equal(baseline.focusId, "outside");
    assert.deepEqual(MapScope.select(data.nodes, data.edges, { ...options, category: "기술·디지털" }), baseline);
    assert.deepEqual(MapScope.select(data.nodes, data.edges, { ...options, category: "알 수 없음" }), baseline);
  }
});

test("company-only all scope can use category membership without drawing classification links", () => {
  const result = choose(fixture(), { view: "relations" });
  assert.deepEqual(sortedIds(result), ["a", "b", "shared"]);
  assert.deepEqual(result.edgeIndices, [7]);
});
