/* Deterministic, bounded layout of displayed evidence. No background loop. */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MapOverview = factory();
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  function order(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
  function hash(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0) / 4294967296; }
  function layout(nodes, edges) {
    if (!Array.isArray(nodes) || nodes.length > 400 || !Array.isArray(edges) || edges.length > 1200) throw new Error("Overview size limit");
    var points = nodes.slice().sort(function (a, b) { return order(a.id, b.id); }).map(function (n) {
      return { id: n.id, type: n.type, peers: [], x: 0, y: 0, vx: 0, vy: 0 };
    });
    var byId = Object.create(null), links = [], unique = new Set();
    points.forEach(function (p) { if (typeof p.id !== "string" || byId[p.id]) throw new Error("Invalid overview node"); byId[p.id] = p; });
    edges.slice().sort(function (a, b) { return order(a.source, b.source) || order(a.target, b.target); }).forEach(function (e) {
      var a = byId[e.source], b = byId[e.target];
      if (!a || !b || a === b) return;
      var key = JSON.stringify([a.id, b.id].sort(order));
      if (unique.has(key)) return;
      unique.add(key); a.peers.push(b); b.peers.push(a); links.push([a, b]);
    });
    var visited = new Set(), components = [];
    points.forEach(function (p) {
      if (visited.has(p.id)) return;
      var members = [p]; visited.add(p.id);
      for (var i = 0; i < members.length; i++) members[i].peers.forEach(function (q) {
        if (!visited.has(q.id)) { visited.add(q.id); members.push(q); }
      });
      members.sort(function (a, b) { return order(a.id, b.id); });
      var ids = new Set(members.map(function (q) { return q.id; }));
      var componentLinks = links.filter(function (pair) { return ids.has(pair[0].id); });
      members.forEach(function (q, i) {
        var angle = i * 2.3999632297 + hash(p.id) * Math.PI * 2;
        q.x = Math.cos(angle) * 26 * Math.sqrt(i); q.y = Math.sin(angle) * 26 * Math.sqrt(i);
      });
      // Input and iteration caps keep work independent of time spent on the page.
      for (var step = 0; step < 260 && members.length > 1; step++) {
        var alpha = 1 - step / 280;
        for (var a = 0; a < members.length; a++) {
          var s = members[a];
          for (var b = a + 1; b < members.length; b++) {
            var t = members[b], dx = s.x - t.x, dy = s.y - t.y;
            var d2 = Math.max(1, dx * dx + dy * dy), d = Math.sqrt(d2);
            // Give theme labels room while shared companies remain single nodes.
            var themePair = s.type === "theme" && t.type === "theme";
            var clearance = themePair ? 150 : 46;
            var charge = themePair ? 11000 : 1900;
            var force = Math.min(themePair ? 12 : 7, charge / d2 + Math.max(0, clearance - d) * .06) * alpha;
            s.vx += dx / d * force; s.vy += dy / d * force;
            t.vx -= dx / d * force; t.vy -= dy / d * force;
          }
        }
        componentLinks.forEach(function (pair) {
          var s = pair[0], t = pair[1], dx = t.x - s.x, dy = t.y - s.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
          var desired = s.type === "theme" || t.type === "theme" ? 120 : 112;
          var force = (d - desired) * .028 * alpha;
          s.vx += dx / d * force; s.vy += dy / d * force;
          t.vx -= dx / d * force; t.vy -= dy / d * force;
        });
        members.forEach(function (q) {
          q.vx = (q.vx - q.x * .0007 * alpha) * .72; q.vy = (q.vy - q.y * .0007 * alpha) * .72;
          q.x += Math.max(-12, Math.min(12, q.vx)); q.y += Math.max(-12, Math.min(12, q.vy));
        });
      }
      var cx = members.reduce(function (sum, q) { return sum + q.x; }, 0) / members.length;
      var cy = members.reduce(function (sum, q) { return sum + q.y; }, 0) / members.length;
      var radius = 0;
      members.forEach(function (q) { q.x -= cx; q.y -= cy; radius = Math.max(radius, Math.hypot(q.x, q.y)); });
      components.push({ id: p.id, members: members, r: radius + (members.length === 1 ? 23 : 48), x: 0, y: 0 });
    });
    // Separate components share a canvas, without invented links between them.
    components.sort(function (a, b) { return b.r - a.r || order(a.id, b.id); });
    var placed = [];
    components.forEach(function (c) {
      var found = false;
      for (var attempt = 0; attempt < 12000; attempt++) {
        var angle = attempt * 2.3999632297, radius = 22 * Math.sqrt(attempt);
        c.x = Math.cos(angle) * radius * 1.3; c.y = Math.sin(angle) * radius;
        if (placed.every(function (p) { return Math.hypot(c.x - p.x, c.y - p.y) >= c.r + p.r + 16; })) { found = true; break; }
      }
      if (!found) { c.x = placed.reduce(function (max, p) { return Math.max(max, p.x + p.r); }, 0) + c.r + 16; c.y = 0; }
      placed.push(c);
    });
    var positions = Object.create(null);
    placed.forEach(function (c) { c.members.forEach(function (q) { positions[q.id] = { x: q.x + c.x, y: q.y + c.y }; }); });
    return { positions: positions };
  }
  return { layout: layout };
});
