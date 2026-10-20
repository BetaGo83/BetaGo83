"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const MapNews = require("../site/static/map-news.js");
const NewsArchive = require("../site/static/news-archive.js");

function document(url, date, companies = ["A"], kind = "news") {
  return { key: url, url, title: "공개 제목", kind, date,
    time: kind === "news" ? date + "T12:00:00+09:00" : null,
    observedAt: "2026-10-15T15:00:00+09:00", companies, themes: [], source: kind === "news" ? "한국경제" : "DART" };
}

function prepared(documents) {
  return { documents, companyIds: ["A", "B"], generatedAt: "2026-10-16T06:00:00+09:00",
    collectedAt: "2026-10-16T06:00:00+09:00", partial: false, queriesOK: 2, queriesTotal: 2,
    coverageFrom: "2026-09-16T06:00:00+09:00", coverageTo: "2026-10-16T06:00:00+09:00" };
}

function countsFixture({ endDate = "2026-10-15", days = 1, baselineA = 1, selectedA = 3 } = {}) {
  const range = MapNews.activityRange(endDate, days), docs = [];
  for (const day of MapNews.dateRange(range.baselineStart, range.baselineEnd)) {
    // B keeps a dated public record even when A has none.
    docs.push(document("baseline-B-" + day, day, ["B"]));
    for (let n = 0; n < baselineA; n++) docs.push(document("baseline-A-" + day + "-" + n, day));
  }
  for (let n = 0; n < selectedA; n++) docs.push(document("selected-A-" + n, endDate));
  const data = prepared(docs);
  data.collectedAt = data.generatedAt = data.coverageTo = MapNews.shiftDay(endDate, 1) + "T06:00:00+09:00";
  data.dailyCoverage = MapNews.dateRange(range.baselineStart, range.endDate).map(date => ({ date, complete: true, scope: "same-publishers-and-query-scope" }));
  return { range, data, options: { endDate, days, metric: "news" } };
}

test("1·7·14일 창은 바로 직전의 최소 7일과 겹치지 않게 비교한다", () => {
  assert.deepEqual(MapNews.activityRange("2026-11-02", 1), {
    startDate: "2026-11-02", endDate: "2026-11-02", days: 1, baselineDays: 7,
    baselineStart: "2026-10-26", baselineEnd: "2026-11-01"
  });
  for (const days of [7, 14]) {
    const range = MapNews.activityRange("2026-11-02", days);
    assert.equal(MapNews.dateRange(range.baselineStart, range.baselineEnd).length, days);
    assert.equal(MapNews.shiftDay(range.baselineEnd, 1), range.startDate);
  }
  assert.equal(MapNews.activityRange("2028-03-01", 1).baselineEnd, "2028-02-29");
});

test("중복 출처 URL은 제공일 기준으로 한 번만 세며 첫 관측일로 옮기지 않는다", () => {
  const url = "https://www.hankyung.com/article/2026101200001";
  const source = { name: "한국경제", url, published_at: "2026-10-12T23:59:00+09:00", observed_at: "2026-10-15T15:00:00+09:00" };
  const common = { title: "회사 소식", published_at: source.published_at, kind: "news", status: "new", evidence: "기사 제목",
    themes: [], sources: [source], group_size: 1, grouping: "single" };
  const data = MapNews.prepare({ schema: 3, retention_days: 14, generated_at: "2026-10-16T06:00:00+09:00",
    collected_at: "2026-10-16T06:00:00+09:00", coverage: { from: "2026-10-02T06:00:00+09:00", to: "2026-10-16T06:00:00+09:00",
      queries_ok: 2, queries_total: 2, partial: false, note: "" }, items: [
      { ...common, id: "111111111111111111111111", companies: [{ name: "A", url: "../companies/A" }] },
      { ...common, id: "222222222222222222222222", companies: [{ name: "B", url: "../companies/B" }] }
    ] }, [{ id: "A", type: "company", path: "companies/A" }, { id: "B", type: "company", path: "companies/B" }]);
  const result = MapNews.aggregate(data, { endDate: "2026-10-12", days: 1 });
  assert.equal(result.totals.news, 1);
  assert.equal(result.byCompany.A.news, 1);
  assert.equal(result.byCompany.B.news, 1);
  assert.equal(MapNews.aggregate(data, { endDate: "2026-10-15", days: 1 }).totals.news, 0);
  assert.equal(data.documents[0].observedAt, source.observed_at);
});

test("첫 로드·같은 게시본·제목 정정·오래된 관측의 재등장은 신규 수집 신호가 아니다", () => {
  const old = prepared([document("existing", "2026-10-15")]);
  assert.equal(MapNews.diff(null, old).newlyObserved.length, 0);
  assert.equal(MapNews.diff(old, old).newlyObserved.length, 0);
  const amended = { ...old, documents: [{ ...old.documents[0], title: "제목 정정" }] };
  assert.equal(MapNews.diff(old, amended).updated.length, 1);
  assert.equal(MapNews.diff(old, amended).newlyObserved.length, 0);
  const later = { ...old, collectedAt: "2026-10-16T07:00:00+09:00", generatedAt: "2026-10-16T07:00:00+09:00",
    documents: old.documents.concat(document("old-title-now-classified", "2026-10-14")) };
  assert.equal(MapNews.diff(old, later).added.length, 1);
  assert.equal(MapNews.diff(old, later).newlyObserved.length, 0);
  const newDocument = { ...document("new-source", "2026-10-16"), observedAt: "2026-10-16T06:30:00+09:00" };
  later.documents.push(newDocument, { ...document("observation-unknown", "2026-10-16"), observedAt: null });
  assert.deepEqual(MapNews.diff(old, later).newlyObserved.map(d => d.url), ["new-source"]);
  assert.equal(MapNews.diff(later, old).reason, "rollback");
  assert.equal(MapNews.diff(later, old).newlyObserved.length, 0);
});

test("증가 신호는 같은 수집 범위의 완결된 날짜와 명시한 배수·최소 건수를 요구한다", () => {
  const { data, options } = countsFixture();
  const activity = MapNews.activity(data, options);
  const a = activity.byCompany.A;
  assert.equal(a.comparison.status, "increase");
  assert.equal(a.comparison.baselineMean, 1);
  assert.equal(a.comparison.expectedCount, 1);
  assert.equal(a.comparison.ratio, 3);
  assert.deepEqual(a.comparison.threshold, { ratio: 2, minimumCount: 3 });
  assert.equal(a.series[0].count, 3);
  assert.equal(a.series[0].complete, true);
  assert.match(a.comparison.basis, /통계적 유의성 판정 아님/);
  const few = countsFixture({ selectedA: 2 });
  assert.equal(MapNews.activity(few.data, few.options).byCompany.A.comparison.status, "stable");
});

test("7·14일 총합 비교에서는 기준 일평균을 선택 기간 길이에 맞춰 환산한다", () => {
  for (const days of [7, 14]) {
    const { data, options } = countsFixture({ days, selectedA: days * 2 });
    const value = MapNews.activity(data, options).byCompany.A.comparison;
    assert.equal(value.baselineMean, 1);
    assert.equal(value.expectedCount, days);
    assert.equal(value.ratio, 2);
    assert.equal(value.status, "increase");
  }
});

test("기준 0건은 무한 배수 또는 급증으로 표시하지 않는다", () => {
  const { data, options } = countsFixture({ baselineA: 0, selectedA: 20 });
  const value = MapNews.activity(data, options).byCompany.A.comparison;
  assert.equal(value.status, "insufficient");
  assert.equal(value.reason, "baseline-zero");
  assert.equal(value.ratio, null);
  assert.equal(value.baselineCount, 0);
});

test("일부 수집 실패는 기록된 건수를 보존하되 완결성과 증가 판정을 차단한다", () => {
  const { data, options } = countsFixture();
  data.partial = true; data.queriesOK = 1;
  const value = MapNews.activity(data, options).byCompany.A;
  assert.equal(value.selectedCount, 3);
  assert.equal(value.comparison.status, "insufficient");
  assert.equal(value.comparison.reason, "partial-collection");
  assert.equal(value.comparison.ratio, null);
  assert.equal(value.series[0].observedCount, 3);
  assert.equal(value.series[0].count, null);
});

test("최신 수집일은 KST 하루가 끝나지 않았으므로 과거 완전한 하루와 비교하지 않는다", () => {
  const { data, options } = countsFixture();
  data.collectedAt = data.generatedAt = data.coverageTo = "2026-10-15T23:59:59+09:00";
  const value = MapNews.activity(data, options).byCompany.A;
  assert.equal(value.comparison.reason, "incomplete-day");
  assert.equal(value.series[0].complete, false);
});

test("30일 보관창·조회 성공·기존 제목의 존재만으로 일별 수집완료를 추정하지 않는다", () => {
  const { data, options } = countsFixture();
  delete data.dailyCoverage;
  const value = MapNews.activity(data, options).byCompany.A;
  assert.equal(value.comparison.reason, "coverage-unproven");
  assert.equal(value.comparison.ratio, null);
  assert.equal(value.series[0].status, "observed-only");
});

test("자료 없는 날짜는 unknown/null로 남고 명시적으로 확인된 빈 날짜만 0이 된다", () => {
  const { data, options } = countsFixture({ days: 7 });
  const first = MapNews.shiftDay(options.endDate, -6);
  delete data.dailyCoverage;
  let value = MapNews.activity(data, options).byCompany.A;
  assert.equal(value.series[0].date, first);
  assert.equal(value.series[0].count, null);
  assert.equal(value.series[0].observedCount, null);
  assert.equal(value.series[0].status, "unknown");
  const range = MapNews.activityRange(options.endDate, options.days);
  data.dailyCoverage = MapNews.dateRange(range.baselineStart, range.endDate).map(date => ({ date, complete: true, scope: "same-scope" }));
  value = MapNews.activity(data, options).byCompany.A;
  assert.equal(value.series[0].count, 0);
  assert.equal(value.series[0].complete, true);
});

test("수집 대상이 날짜 사이에서 달라지면 비교를 보류한다", () => {
  const { data, options } = countsFixture();
  data.dailyCoverage[0].scope = "different-publishers";
  assert.equal(MapNews.activity(data, options).byCompany.A.comparison.reason, "coverage-scope-changed");
});

test("기사와 공시는 따로 집계하고 공시의 수집 시각을 접수 시각으로 만들지 않는다", () => {
  const data = prepared([document("disclosure", "2026-10-14", ["A"], "disclosure"), document("article", "2026-10-15")]);
  const aggregate = MapNews.aggregate(data, { endDate: "2026-10-15", days: 7 });
  assert.equal(aggregate.byCompany.A.news, 1);
  assert.equal(aggregate.byCompany.A.disclosure, 1);
  assert.equal(aggregate.byCompany.A.byDay["2026-10-14"].disclosure, 1);
  assert.equal(aggregate.byCompany.A.items.find(d => d.kind === "disclosure").time, null);
  const value = MapNews.activity(data, { endDate: "2026-10-15", days: 7, metric: "disclosure" });
  assert.equal(value.byCompany.A.selectedCount, 1);
  assert.equal(value.byCompany.A.series.find(d => d.date === "2026-10-15").observedCount, null);
});

test("archive 집계 연결은 비교 창 오류를 조용히 허용하지 않는다", () => {
  const { data, options, range } = countsFixture();
  const current = MapNews.aggregate(data, options);
  const wrong = MapNews.aggregate(data, { endDate: range.endDate, days: 7 });
  assert.throws(() => MapNews.activityFromAggregates(current, wrong, data, options), /range/);
});

test("이전 기업 집계가 없으면 0건으로 채워 증가를 판정하지 않는다", () => {
  const { data, options, range } = countsFixture();
  const current = MapNews.aggregate(data, options);
  const previous = MapNews.aggregate(data, { endDate: range.baselineEnd, days: range.baselineDays });
  delete previous.byCompany.A;
  const value = MapNews.activityFromAggregates(current, previous, data, options).byCompany.A.comparison;
  assert.equal(value.reason, "missing-company-history");
  assert.equal(value.baselineCount, null);
  assert.equal(value.ratio, null);
});

test("게시 archive의 해시와 인덱스를 검증한 집계에서도 불확실한 수집을 급증으로 꾸미지 않는다", async () => {
  const staticPath = path.resolve(__dirname, "../site/static");
  const graph = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../wiki/graph.json"), "utf8"));
  const archive = NewsArchive.create({ crypto: require("node:crypto").webcrypto,
    fetch: async name => new Response(fs.readFileSync(path.resolve(staticPath, name))) });
  const manifest = await archive.open();
  const endDate = manifest.indexes.ordered.last.slice(0, 10);
  const range = MapNews.activityRange(endDate, 7);
  const current = await archive.aggregate(manifest, { endDate, days: 7, nodes: graph.nodes });
  const baseline = await archive.aggregate(manifest, { endDate: range.baselineEnd, days: range.baselineDays, nodes: graph.nodes });
  assert.equal(current.totals.news + current.totals.disclosure, current.processed);
  assert.ok(current.processed <= manifest.total_items);
  const activity = MapNews.activityFromAggregates(current, baseline, manifest, { endDate, days: 7, metric: "news" });
  assert.equal(activity.comparison.status, "insufficient");
  if (manifest.coverage.partial) assert.equal(activity.comparison.reason, "partial-collection");
  assert.ok(Object.values(activity.byCompany).every(c => c.comparison.status === "insufficient"));
  assert.equal(archive.stats.maxActive, 1);
});
