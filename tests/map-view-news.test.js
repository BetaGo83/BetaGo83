"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const MapNews = require("../site/static/map-news.js");
const NewsArchive = require("../site/static/news-archive.js");

// Small DOM/event surface for controller integration. Layout and mobile gesture
// quality are checked in the browser; these tests exercise the real controller,
// actual date aggregation/diff functions, and the visible text/class contract.
class Element {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase(); this.document = document; this.children = []; this.parentNode = null;
    this.dataset = {}; this.style = {}; this.attributes = {}; this.listeners = {}; this.value = "";
    this.checked = false; this.disabled = false; this.hidden = false; this.options = []; this._text = "";
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach(n => classes.add(n)), remove: (...names) => names.forEach(n => classes.delete(n)),
      contains: name => classes.has(name), toggle: (name, force) => {
        const keep = force === undefined ? !classes.has(name) : !!force;
        if (keep) classes.add(name); else classes.delete(name); return keep;
      }, classes
    };
  }
  set id(value) { this._id = value; this.document.ids.set(value, this); }
  get id() { return this._id || ""; }
  set className(value) { this.classList.classes.clear(); value.split(/\s+/).filter(Boolean).forEach(n => this.classList.add(n)); }
  get className() { return Array.from(this.classList.classes).join(" "); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
  appendChild(child) { if (child.parentNode) child.remove(); this.children.push(child); child.parentNode = this; return child; }
  insertBefore(child, before) {
    if (child.parentNode) child.remove(); const index = this.children.indexOf(before);
    if (index < 0) return this.appendChild(child); this.children.splice(index, 0, child); child.parentNode = this; return child;
  }
  replaceChildren(...children) { this.children.slice().forEach(child => child.remove()); this._text = ""; children.forEach(child => this.appendChild(child)); }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
    if (this.id && this.document.ids.get(this.id) === this) this.document.ids.delete(this.id);
  }
  get firstChild() { return this.children[0] || null; }
  contains(value) { return value === this || this.children.some(child => child.contains(value)); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] || null; }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  dispatchEvent(event) { for (const callback of this.listeners[event.type] || []) callback(event); }
  click() { if (!this.disabled) this.dispatchEvent({ type: "click" }); }
  focus() { this.document.activeElement = this; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const found = [], matches = element => selector.startsWith(".") ? element.classList.contains(selector.slice(1))
      : selector.startsWith("#") ? element.id === selector.slice(1) : element.tagName === selector.toUpperCase();
    for (const child of this.children) { if (matches(child)) found.push(child); found.push(...child.querySelectorAll(selector)); }
    return found;
  }
}

function setupDocument() {
  const document = { ids: new Map(), hidden: false, listeners: {}, activeElement: null,
    getElementById(id) { return this.ids.get(id) || null; }, createElement(tag) { return new Element(tag, this); },
    addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); } };
  document.body = document.createElement("body"); document.documentElement = document.createElement("html");
  document.documentElement.dataset.newsArchive = "required";
  const add = (id, tag = "div", parent = document.body) => { const element = document.createElement(tag); element.id = id; parent.appendChild(element); return element; };
  const ids = ["mode", "metric", "scale", "highlight", "highlight-status", "active", "fit", "date", "days", "play", "motion", "refresh", "play-state", "data-status", "encoding", "new-material", "new-status", "new-date", "empty", "update-summary", "comparison-status"];
  ids.forEach(id => add("map-" + id));
  const values = { mode: "relations", metric: "news", scale: "log", highlight: "0", days: "7" };
  for (const [id, value] of Object.entries(values)) document.getElementById("map-" + id).value = value;
  document.getElementById("map-mode").options = [{ disabled: false }, { disabled: false }];
  const timeline = add("news-timeline"), controls = add("test-controls", "div", timeline); controls.className = "timeline-controls";
  const subtitle = add("test-subtitle", "span", controls); subtitle.className = "timeline-subtitle";
  add("activity-days", "div", timeline); add("activity-company-list");
  return { document, add };
}

function fixture() {
  const docs = MapNews.dateRange("2026-10-13", "2026-10-19").filter(day => day !== "2026-10-18").map((day, index) => ({
    key: "https://www.hankyung.com/article/202610130000" + index,
    url: "https://www.hankyung.com/article/202610130000" + index, title: "공개 기사 " + index,
    kind: "news", date: day, time: day + "T12:00:00+09:00", observedAt: "2026-10-19T18:00:00+09:00",
    companies: [index % 2 ? "B" : "A"], source: "한국경제", themes: []
  }));
  const data = { documents: docs, companyIds: ["A", "B"], collectedAt: "2026-10-19T18:36:14+09:00",
    generatedAt: "2026-10-19T18:36:14+09:00", partial: true, queriesOK: 13, queriesTotal: 14 };
  return snapshot(data, "first");
}

function snapshot(data, hash) {
  return { schema: 1, generated_at: data.generatedAt, collected_at: data.collectedAt, _data: data,
    coverage: { from: "2026-09-19T18:36:14+09:00", to: data.collectedAt, partial: true, queries_ok: 13, queries_total: 14, note: "" },
    indexes: { ordered: { hash, count: data.documents.length, first: "2026-10-13|", last: "2026-10-19|~" } } };
}

async function harness({ reducedMotion = false } = {}) {
  const { document, add } = setupDocument(), timers = new Map(), aggregateCalls = [], nodes = [];
  let timerId = 0, currentTime = 0, incoming = fixture(), fail = false, fitCount = 0, clearCount = 0, watcher;
  for (const [index, id] of ["A", "B"].entries()) {
    const node = { id, type: "company", path: "companies/" + id, x: index * 100, y: index * 20, r: 8, w: 44, visible: true };
    for (const part of ["g", "circle", "label", "ring", "pulse", "badge"]) node[part] = document.createElement(part === "label" ? "text" : part);
    nodes.push(node);
  }
  const panel = add("panel"), svg = add("svg", "svg"); svg.classList.add("overview");
  let shown = nodes[0];
  const graph = { nodes, edges: [], panel, svg,
    fit() { fitCount++; }, clear() { clearCount++; shown = null; }, position() {}, applyFilter() {},
    getTheme: () => "", getShown: () => shown, isOverview: () => true, isKnowledge: () => true,
    inScope: () => true, showSelectedRelation: () => false, initialFit() {}, find(id) { shown = nodes.find(node => node.id === id); }
  };
  const relation = NewsArchive.create().relation;
  const archive = { async open() { if (fail) throw new Error("fixture read failure"); return incoming; }, relation,
    async aggregate(value, options) {
      aggregateCalls.push({ endDate: options.endDate, days: options.days });
      const result = MapNews.aggregate(value._data, options); result.scopeTotals = result.totals; return result;
    }, async changes(previous, next, options) {
      const diff = MapNews.diff(previous._data, next._data), docs = diff.newlyObserved, matching = docs.filter(doc => options.matches({ doc }));
      return { reason: diff.reason, total: docs.length, inside: matching.length,
        news: docs.filter(d => d.kind === "news").length, disclosure: docs.filter(d => d.kind === "disclosure").length,
        companies: Array.from(new Set(matching.flatMap(d => d.companies))), maxDate: docs.length ? docs.map(d => d.date).sort().pop() : null };
    } };
  const clock = { setTimeout(callback, duration) { const id = ++timerId; timers.set(id, { callback, due: currentTime + duration }); return id; }, clearTimeout(id) { timers.delete(id); } };
  const window = { location: { search: "?view=knowledge&scope=all&mode=news&days=7" }, NewsArchive: { create: () => archive },
    matchMedia: () => ({ matches: reducedMotion, addEventListener() {} }), addEventListener() {} };
  const context = vm.createContext({ window, document, MapNews, URLSearchParams, URL, Intl, Event, AbortController,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    NewsFeed: { watch(options) { watcher = { check: async () => { if (!options.shouldSkip()) await options.refresh(); } }; return watcher; } } });
  vm.runInContext(fs.readFileSync(require.resolve("../site/static/map-view.js"), "utf8"), context);
  const view = window.MapNewsView.create(graph);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await settle();
  return { document, nodes, view, aggregateCalls, settle, graph,
    get fitCount() { return fitCount; }, get clearCount() { return clearCount; },
    get shown() { return shown; }, get current() { return incoming; },
    setIncoming(value) { incoming = value; }, setFailure(value) { fail = value; },
    check: async () => { await watcher.check(); await settle(); },
    async tick(duration) {
      const target = currentTime + duration;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break; currentTime = next[1].due; timers.delete(next[0]); next[1].callback(); await settle();
      }
      currentTime = target; await settle();
    }
  };
}

test("뉴스 화면은 실제 수집 상태·미확인 날짜·공개목록 순위를 보이며 첫 로드는 새 수집으로 강조하지 않는다", async () => {
  const h = await harness(), doc = h.document;
  assert.match(doc.getElementById("map-update-summary").textContent, /2026-10-19 18:36 KST/);
  assert.match(doc.getElementById("map-update-summary").textContent, /13\/14 조회/);
  assert.match(doc.getElementById("map-comparison-status").textContent, /비교 보류/);
  const bars = doc.getElementById("activity-days").children;
  assert.equal(bars.length, 7);
  const missing = bars.find(button => button.dataset.date === "2026-10-18");
  assert.match(missing.textContent, /미확인/);
  assert.ok(missing.classList.contains("activity-missing"));
  assert.equal(doc.getElementById("activity-company-list").children.length, 2);
  assert.ok(h.nodes.every(node => !node.g.classList.contains("newly-observed") && !node.g.classList.contains("observed-recent")));
  assert.equal(h.aggregateCalls.length, 1, "부분 수집에서는 불필요한 baseline 요청을 만들지 않는다");
});

test("실제 새 관측은 6초 강조 뒤 테두리만 유지하며 재조회는 강조를 재시작하지 않는다", async () => {
  const h = await harness(), previous = h.current;
  const newDoc = { ...previous._data.documents[0], key: "https://www.hankyung.com/article/2026101900999", url: "https://www.hankyung.com/article/2026101900999",
    date: "2026-10-19", time: "2026-10-19T18:40:00+09:00", observedAt: "2026-10-19T18:41:00+09:00" };
  h.setIncoming(snapshot({ ...previous._data, documents: previous._data.documents.concat(newDoc),
    collectedAt: "2026-10-19T19:00:00+09:00", generatedAt: "2026-10-19T19:00:00+09:00" }, "second"));
  await h.check();
  assert.ok(h.nodes[0].g.classList.contains("newly-observed"));
  assert.ok(h.nodes[0].g.classList.contains("observed-recent"));
  assert.equal(h.document.getElementById("map-date").value, "2026-10-19");
  assert.deepEqual(h.nodes.map(node => [node.x, node.y]), [[0, 0], [100, 20]]);
  assert.equal(h.clearCount, 0); assert.equal(h.fitCount, 0);
  await h.tick(6000);
  assert.equal(h.nodes[0].g.classList.contains("newly-observed"), false);
  assert.ok(h.nodes[0].g.classList.contains("observed-recent"));
  await h.check();
  assert.equal(h.nodes[0].g.classList.contains("newly-observed"), false);
  assert.ok(h.nodes[0].g.classList.contains("observed-recent"));
  const date = h.document.getElementById("map-date"); date.value = "2026-10-18"; date.dispatchEvent({ type: "change" }); await h.settle();
  assert.equal(h.nodes[0].g.classList.contains("observed-recent"), false);
  assert.equal(h.shown.id, "A", "날짜 조작은 선택 기업을 지우지 않는다");
});

test("날짜 재생은 원래 7일 안에서 하루씩 집계하며 끝나면 선택 기간으로 복귀한다", async () => {
  const h = await harness(), doc = h.document;
  doc.getElementById("map-play").click(); await h.settle();
  assert.equal(doc.getElementById("map-date").value, "2026-10-13");
  assert.equal(doc.getElementById("map-days").value, "1");
  assert.equal(doc.getElementById("activity-days").children.length, 7, "재생 막대 범위를 유지한다");
  assert.match(doc.getElementById("map-play-state").textContent, /과거 날짜 재생/);
  for (let day = 0; day < 6; day++) await h.tick(2200);
  assert.equal(doc.getElementById("map-date").value, "2026-10-19");
  const replayCalls = h.aggregateCalls.slice(1);
  assert.deepEqual(replayCalls.map(value => value.days), Array(7).fill(1));
  assert.equal(replayCalls[0].endDate, "2026-10-13");
  assert.equal(h.clearCount, 0); assert.equal(h.fitCount, 0);
  assert.equal(h.shown.id, "A");
  await h.tick(1800);
  assert.equal(doc.getElementById("map-days").value, "7");
  assert.equal(doc.getElementById("map-date").value, "2026-10-19");
  assert.match(doc.getElementById("map-play-state").textContent, /원래 선택 기간/);
  assert.ok(h.nodes.every(node => !node.g.classList.contains("newly-observed")));
});

test("게시본 갱신 실패는 기존 집계와 선택을 유지하며 실패를 노출한다", async () => {
  const h = await harness(), countBefore = h.nodes[0].activityCount;
  h.setFailure(true); await h.check();
  assert.match(h.document.getElementById("map-update-summary").textContent, /갱신 실패/);
  assert.equal(h.nodes[0].activityCount, countBefore);
  assert.equal(h.shown.id, "A");
  assert.equal(h.document.getElementById("map-date").value, "2026-10-19");
  assert.ok(h.nodes.every(node => !node.g.classList.contains("newly-observed")));
});

test("움직임 줄이기는 재생 펄스를 막아도 날짜별 집계와 상태 문구를 유지한다", async () => {
  const h = await harness({ reducedMotion: true });
  h.document.getElementById("map-play").click(); await h.settle();
  assert.ok(h.nodes.every(node => !node.g.classList.contains("replaying")));
  assert.match(h.document.getElementById("map-play-state").textContent, /과거 날짜 재생/);
  assert.equal(h.document.getElementById("activity-days").children.length, 7);
});
