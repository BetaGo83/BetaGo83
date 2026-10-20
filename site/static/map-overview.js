/* Deterministic, bounded layout of displayed evidence. No background loop. */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MapOverview = factory();
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  function order(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
  function hash(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0) / 4294967296; }
  function labelWidth(name) {
    // World-space clearance estimate only. The renderer measures the actual font
    // for placeLabels(), so long names do not need to distort the whole map.
    var width = 0;
    Array.from(String(name)).forEach(function (letter) { width += letter.charCodeAt(0) > 255 ? 12 : 7; });
    return Math.min(180, width);
  }
  function boxesTouch(a, b) {
    return Math.abs(a.x - b.x) < a.halfW + b.halfW && Math.abs(a.y - b.y) < a.halfH + b.halfH;
  }
  function settle(members) {
    // A finite collision pass gives short labels room as well as the hubs. It
    // never reads news counts, dates, or elapsed time.
    for (var step = 0; step < 40; step++) {
      var collisions = 0;
      for (var i = 0; i < members.length; i++) {
        for (var j = i + 1; j < members.length; j++) {
          var a = members[i], b = members[j];
          if (!boxesTouch(a, b)) continue;
          collisions++;
          var dx = b.x - a.x, dy = b.y - a.y;
          var overlapX = a.halfW + b.halfW - Math.abs(dx) + .1;
          var overlapY = a.halfH + b.halfH - Math.abs(dy) + .1;
          if (overlapX < overlapY) {
            var mx = (dx < 0 ? -1 : 1) * overlapX / 2;
            a.x -= mx; b.x += mx;
          } else {
            var my = (dy < 0 ? -1 : 1) * overlapY / 2;
            a.y -= my; b.y += my;
          }
        }
      }
      if (!collisions) break;
    }
    // Crowded adversarial inputs can outlast relaxation. Reserve hubs first and
    // move only remaining collisions to a nearby free position, with a cap and
    // an always-free outer fallback. This also makes minimum spacing reliable.
    var placed = [];
    members.slice().sort(function (a, b) { return b.peers.length - a.peers.length || order(a.id, b.id); }).forEach(function (p) {
      var originalX = p.x, originalY = p.y, found = false;
      for (var attempt = 0; attempt < 2400; attempt++) {
        var angle = attempt * 2.3999632297, radius = 20 * Math.sqrt(attempt);
        p.x = originalX + Math.cos(angle) * radius; p.y = originalY + Math.sin(angle) * radius;
        if (placed.every(function (q) { return !boxesTouch(p, q); })) { found = true; break; }
      }
      if (!found) p.x = placed.reduce(function (right, q) { return Math.max(right, q.x + q.halfW); }, originalX) + p.halfW + 8;
      placed.push(p);
    });
  }
  function layout(nodes, edges) {
    if (!Array.isArray(nodes) || nodes.length > 400 || !Array.isArray(edges) || edges.length > 1200) throw new Error("Overview size limit");
    var byId = Object.create(null), links = [], unique = new Set();
    var points = nodes.map(function (n) {
      if (!n || typeof n.id !== "string" || !n.id || byId[n.id]) throw new Error("Invalid overview node");
      var p = { id: n.id, type: n.type, peers: [], x: 0, y: 0, vx: 0, vy: 0,
        halfW: Math.max(n.type === "theme" ? 62 : 38, labelWidth(n.name || n.id) / 2 + 16),
        halfH: n.type === "theme" ? 46 : 36 };
      byId[p.id] = p; return p;
    }).sort(function (a, b) { return order(a.id, b.id); });
    edges.slice().filter(function (e) { return e && typeof e.source === "string" && typeof e.target === "string"; })
      .sort(function (a, b) { return order(a.source, b.source) || order(a.target, b.target); }).forEach(function (e) {
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
        q.x = Math.cos(angle) * 46 * Math.sqrt(i); q.y = Math.sin(angle) * 46 * Math.sqrt(i);
      });
      // At most 220 force iterations + 40 collision passes; no background loop.
      for (var step = 0; step < 220 && members.length > 1; step++) {
        var alpha = 1 - step / 240;
        for (var a = 0; a < members.length; a++) {
          var s = members[a];
          for (var b = a + 1; b < members.length; b++) {
            var t = members[b], dx = s.x - t.x, dy = s.y - t.y;
            var d2 = Math.max(1, dx * dx + dy * dy), d = Math.sqrt(d2);
            var themePair = s.type === "theme" && t.type === "theme";
            var clearance = Math.max(themePair ? 176 : 88, (s.halfW + t.halfW) * .9);
            var charge = themePair ? 17000 : 4200;
            var force = Math.min(themePair ? 16 : 10, charge / d2 + Math.max(0, clearance - d) * .12) * alpha;
            s.vx += dx / d * force; s.vy += dy / d * force;
            t.vx -= dx / d * force; t.vy -= dy / d * force;
          }
        }
        componentLinks.forEach(function (pair) {
          var s = pair[0], t = pair[1], dx = t.x - s.x, dy = t.y - s.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
          var desired = Math.max(s.type === "theme" || t.type === "theme" ? 190 : 170, s.halfW + t.halfW + 36);
          var force = (d - desired) * .024 * alpha;
          s.vx += dx / d * force; s.vy += dy / d * force;
          t.vx -= dx / d * force; t.vy -= dy / d * force;
        });
        members.forEach(function (q) {
          q.vx = (q.vx - q.x * .00035 * alpha) * .72; q.vy = (q.vy - q.y * .00035 * alpha) * .72;
          q.x += Math.max(-16, Math.min(16, q.vx)); q.y += Math.max(-16, Math.min(16, q.vy));
        });
      }
      settle(members);
      var cx = members.reduce(function (sum, q) { return sum + q.x; }, 0) / members.length;
      var cy = members.reduce(function (sum, q) { return sum + q.y; }, 0) / members.length;
      var radius = 0;
      members.forEach(function (q) {
        q.x -= cx; q.y -= cy;
        radius = Math.max(radius, Math.hypot(q.x, q.y) + Math.hypot(q.halfW, q.halfH));
      });
      components.push({ id: p.id, members: members, r: radius, x: 0, y: 0 });
    });
    // Separate components share a canvas, without invented links between them.
    components.sort(function (a, b) { return b.r - a.r || order(a.id, b.id); });
    var placed = [];
    components.forEach(function (c) {
      var found = false;
      for (var attempt = 0; attempt < 12000; attempt++) {
        var angle = attempt * 2.3999632297, radius = 32 * Math.sqrt(attempt);
        c.x = Math.cos(angle) * radius * 1.3; c.y = Math.sin(angle) * radius;
        if (placed.every(function (p) { return Math.hypot(c.x - p.x, c.y - p.y) >= c.r + p.r + 40; })) { found = true; break; }
      }
      if (!found) { c.x = placed.reduce(function (max, p) { return Math.max(max, p.x + p.r); }, 0) + c.r + 40; c.y = 0; }
      placed.push(c);
    });
    var positions = Object.create(null);
    placed.forEach(function (c) { c.members.forEach(function (q) { positions[q.id] = { x: q.x + c.x, y: q.y + c.y }; }); });
    return { positions: positions };
  }
  function intersects(a, b, padding) {
    return a.left < b.right + padding && a.right + padding > b.left && a.top < b.bottom + padding && a.bottom + padding > b.top;
  }
  function touchesNode(box, node, padding) {
    var dx = node.x - Math.max(box.left, Math.min(box.right, node.x));
    var dy = node.y - Math.max(box.top, Math.min(box.bottom, node.y));
    return dx * dx + dy * dy < Math.pow(Math.max(0, node.radius || 0) + padding, 2);
  }
  function placeLabels(candidates, options) {
    options = options || {};
    if (!Array.isArray(candidates) || candidates.length > 400 || !Number.isFinite(options.width) || options.width <= 0
      || !Number.isFinite(options.height) || options.height <= 0) throw new Error("Invalid label viewport");
    var padding = options.padding === undefined ? 5 : options.padding;
    var maxLabels = options.maxLabels === undefined ? 400 : options.maxLabels;
    if (!Number.isFinite(padding) || padding < 0 || !Number.isInteger(maxLabels) || maxLabels < 0) throw new Error("Invalid label options");
    var result = Object.create(null), occupied = [], seen = new Set();
    candidates.forEach(function (c) {
      if (!c || typeof c.id !== "string" || !c.id || seen.has(c.id) || ![c.x, c.y, c.width, c.height].every(Number.isFinite)
        || c.width < 0 || c.height < 0 || (c.radius !== undefined && (!Number.isFinite(c.radius) || c.radius < 0))) throw new Error("Invalid label candidate");
      seen.add(c.id); result[c.id] = { visible: false, dx: 0, dy: 0, anchor: "middle", box: null };
    });
    candidates.slice().sort(function (a, b) {
      return Number(!!b.required) - Number(!!a.required) || (b.priority || 0) - (a.priority || 0) || order(a.id, b.id);
    }).forEach(function (c) {
      if (occupied.length >= maxLabels || !c.width || !c.height || c.width + padding * 2 > options.width || c.height + padding * 2 > options.height
        || c.x < 0 || c.x > options.width || c.y < 0 || c.y > options.height) return;
      var r = c.radius || 0, offsets = [];
      // Required labels get first choice and a wider search, but never overlap.
      for (var step = 0; step < (c.required ? 4 : 2); step++) {
        var y = r + c.height / 2 + padding + step * (c.height + padding);
        var x = r + c.width / 2 + padding + step * (c.height + padding);
        offsets.push([0, y], [0, -y], [x, 0], [-x, 0], [x, y], [-x, y], [x, -y], [-x, -y]);
      }
      for (var index = 0; index < offsets.length; index++) {
        var cx = Math.max(padding + c.width / 2, Math.min(options.width - padding - c.width / 2, c.x + offsets[index][0]));
        var cy = Math.max(padding + c.height / 2, Math.min(options.height - padding - c.height / 2, c.y + offsets[index][1]));
        var box = { left: cx - c.width / 2, top: cy - c.height / 2, right: cx + c.width / 2, bottom: cy + c.height / 2 };
        if (occupied.some(function (other) { return intersects(box, other, padding); })
          || candidates.some(function (node) { return touchesNode(box, node, padding); })) continue;
        occupied.push(box);
        result[c.id] = { visible: true, dx: cx - c.x, dy: cy - c.y, anchor: "middle", box: box };
        break;
      }
    });
    return result;
  }
  return { layout: layout, placeLabels: placeLabels };
});
