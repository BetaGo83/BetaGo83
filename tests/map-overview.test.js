const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const MapOverview = require('../site/static/map-overview.js');
const MapScope = require('../site/static/map-scope.js');

function nearestDistances(positions) {
  const points = Object.values(positions);
  return points.map((p, i) => Math.min(...points.filter((_, j) => j !== i).map(q => Math.hypot(p.x - q.x, p.y - q.y))));
}
function assertSeparatedLabels(labels, width, height) {
  const boxes = Object.values(labels).filter(label => label.visible).map(label => label.box);
  for (const b of boxes) {
    assert.ok(b.left >= 0 && b.top >= 0 && b.right <= width && b.bottom <= height, 'labels remain in the viewport');
    for (const other of boxes) {
      if (other === b) continue;
      assert.ok(b.right <= other.left || other.right <= b.left || b.bottom <= other.top || other.bottom <= b.top, 'visible labels do not overlap');
    }
  }
}

test('the current capped public graph keeps every displayed node, spacing, and deterministic positions', () => {
  const graph = MapScope.enrich(JSON.parse(fs.readFileSync(path.join(__dirname, '../wiki/graph.json'), 'utf8')));
  const scope = MapScope.select(graph.nodes, graph.edges, { view: 'knowledge', mode: 'all', types: ['company', 'theme'] });
  const kept = new Set(scope.nodeIds);
  const nodes = graph.nodes.filter(n => kept.has(n.id));
  const edges = scope.edgeIndices.map(i => graph.edges[i]);
  const before = JSON.stringify({ nodes, edges });
  const first = MapOverview.layout(nodes, edges);
  const reordered = MapOverview.layout(nodes.slice().reverse(), edges.slice().reverse());
  assert.equal(Object.keys(first.positions).length, nodes.length);
  assert.ok(nodes.length <= 400 && edges.length <= 1200);
  assert.deepEqual(first, reordered, 'array order does not move nodes');
  assert.equal(JSON.stringify({ nodes, edges }), before, 'source graph stays unchanged');
  assert.ok(Object.values(first.positions).every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
  assert.ok(Math.min(...nearestDistances(first.positions)) >= 70, 'the densest displayed pair stays separated');
});

test('isolated and disconnected nodes remain separate without synthetic edges', () => {
  const nodes = [{ id: '외딴 회사', type: 'company' }, { id: '가', type: 'company' }, { id: '나', type: 'theme' }];
  const edges = [{ source: '가', target: '나' }];
  const before = JSON.stringify(edges);
  const result = MapOverview.layout(nodes, edges);
  assert.equal(Object.keys(result.positions).length, 3);
  assert.ok(Math.min(...nearestDistances(result.positions)) >= 70);
  assert.equal(JSON.stringify(edges), before);
  assert.deepEqual(MapOverview.layout([], []), { positions: Object.create(null) });
});

test('long labels get layout clearance without depending on news or mutable radius', () => {
  const nodes = [{ id: '중심', type: 'theme' }, ...Array.from({ length: 16 }, (_, i) => ({ id: `회사-${i}`, name: '긴 기업 이름과 영문 Company', type: 'company' }))];
  const edges = nodes.slice(1).map(n => ({ source: n.id, target: '중심' }));
  const first = MapOverview.layout(nodes, edges);
  const updated = nodes.map((n, i) => ({ ...n, news: i * 40, drawR: 30, date: '2026-10-20' }));
  assert.deepEqual(MapOverview.layout(updated, edges), first);
  assert.ok(Math.min(...nearestDistances(first.positions)) >= 70);
});

test('invalid nodes and graph sizes fail within the established input limits', () => {
  assert.throws(() => MapOverview.layout(Array.from({ length: 401 }, (_, i) => ({ id: String(i) })), []), /size limit/);
  assert.throws(() => MapOverview.layout([], Array.from({ length: 1201 }, () => ({}))), /size limit/);
  assert.throws(() => MapOverview.layout([{ id: 'same' }, { id: 'same' }], []), /Invalid overview node/);
  assert.throws(() => MapOverview.layout([{ id: '' }], []), /Invalid overview node/);
  assert.throws(() => MapOverview.layout([null], []), /Invalid overview node/);
});

test('label placement finds alternate sides and keeps dense desktop and mobile labels disjoint', () => {
  for (const width of [360, 1440]) {
    const height = 640;
    const candidates = Array.from({ length: 35 }, (_, i) => ({
      id: `기업-${i}`, x: 30 + (i % 5) * (width - 60) / 4, y: 60 + Math.floor(i / 5) * 70,
      radius: 9, width: i % 3 === 0 ? 110 : 78, height: 18, priority: i === 17 ? 100 : 0, required: i === 17,
    }));
    const before = JSON.stringify(candidates);
    const labels = MapOverview.placeLabels(candidates, { width, height, padding: 5 });
    assert.ok(labels['기업-17'].visible, 'selected label receives first choice');
    assert.ok(Object.values(labels).filter(l => l.visible).length >= 10, 'dense maps retain useful labels');
    assertSeparatedLabels(labels, width, height);
    assert.equal(JSON.stringify(candidates), before);
    assert.deepEqual(MapOverview.placeLabels(candidates.slice().reverse(), { width, height, padding: 5 }), labels);
  }
});

test('label visibility never sacrifices non-overlap for a required label or an impossible name', () => {
  const candidates = Array.from({ length: 24 }, (_, i) => ({ id: String(i), x: 100, y: 100, radius: 14, width: 98, height: 22, required: true }));
  candidates.push({ id: 'too-wide', x: 100, y: 100, radius: 14, width: 1000, height: 22, required: true });
  candidates.push({ id: 'offscreen', x: -20, y: 100, radius: 14, width: 20, height: 22 });
  const labels = MapOverview.placeLabels(candidates, { width: 200, height: 200 });
  assert.ok(Object.values(labels).some(l => l.visible));
  assert.ok(Object.values(labels).some(l => !l.visible));
  assert.equal(labels['too-wide'].visible, false);
  assert.equal(labels.offscreen.visible, false);
  assertSeparatedLabels(labels, 200, 200);
});

test('label placement avoids node circles and honors an explicit visible-label budget', () => {
  const candidates = [{ id: 'selected', x: 100, y: 100, radius: 10, width: 70, height: 18, required: true },
    { id: 'blocker', x: 100, y: 125, radius: 14, width: 60, height: 18 }];
  const labels = MapOverview.placeLabels(candidates, { width: 360, height: 300, maxLabels: 1 });
  assert.ok(labels.selected.visible);
  assert.ok(labels.selected.dy < 0, 'a node below forces the label to another side');
  assert.equal(labels.blocker.visible, false);
  assert.equal(Object.values(MapOverview.placeLabels(candidates, { width: 360, height: 300, maxLabels: 0 })).filter(l => l.visible).length, 0);
  assert.throws(() => MapOverview.placeLabels(candidates, { width: NaN, height: 300 }), /Invalid label viewport/);
  assert.throws(() => MapOverview.placeLabels([...candidates, candidates[0]], { width: 360, height: 300 }), /Invalid label candidate/);
});
