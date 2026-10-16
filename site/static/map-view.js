/* Public map controls. Counts are derived only from the published title feed. */
(function () {
  "use strict";
  function validDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.slice(0, 4) === "0000") return false;
    var time = Date.parse(value + "T00:00:00Z");
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
  }
  // Keep this small URL whitelist in sync with the document view's readViewState.
  function readViewState(search) {
    var params = new URLSearchParams(search), state = {};
    var allowed = { mode: ["relations", "news"], metric: ["news", "disclosure"], scale: ["log", "area"], days: ["1", "7", "14"] };
    Object.keys(allowed).forEach(function (key) {
      var values = params.getAll(key);
      if (values.length === 1 && allowed[key].indexOf(values[0]) >= 0) state[key] = values[0];
    });
    var dates = params.getAll("date");
    if (dates.length === 1 && validDate(dates[0])) state.date = dates[0];
    return state;
  }
  window.MapNewsView = { readViewState: readViewState, create: function (graph) {
    var ids = ["mode", "metric", "scale", "active", "fit", "date", "days", "play", "motion", "refresh", "play-state", "data-status", "encoding", "new-material", "new-status", "new-date"];
    var ui = {};
    ids.forEach(function (id) { ui[id] = document.getElementById("map-" + id); });
    var data = null, result = null, playing = false, timer = null, pulseTimer = null;
    var loading = false, failed = false, epoch = 0, observedTimer = null, checkedAt = null, rollback = false, recentChange = null, request = null;
    var modeChosen = false, startChosen = false, dateChosen = false;
    var initialState = readViewState(window.location.search);
    ["metric", "scale", "days"].forEach(function (key) { if (initialState[key]) ui[key].value = initialState[key]; });
    var browserClock = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    var counterpart = MapNews.relationCounts(graph.nodes.filter(function (n) { return n.type === "company"; }), graph.edges);
    var reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    ui.motion.checked = reduced.matches;
    ui.mode.options[1].disabled = true;
    graph.nodes.forEach(function (n) {
      n.circle.classList.add("node-body");
      n.labelWidth = Math.max(0, n.w - n.r - 3);
    });

    function element(tag, text, parent, className) {
      var e = document.createElement(tag);
      if (text !== null) e.textContent = text;
      if (className) e.className = className;
      if (parent) parent.appendChild(e);
      return e;
    }
    function counts(n) { return result && result.byCompany[n.id] || { news: 0, disclosure: 0, items: [] }; }
    function isNews() { return ui.mode.value === "news" && !!result; }
    function metricName() { return ui.metric.value === "news" ? "기사" : "공시"; }
    function inTheme(n) {
      if (graph.inScope) return graph.inScope(n);
      var theme = graph.getTheme();
      return !theme || graph.edges.some(function (e) { return e.type === "테마" && e.source === n.id && e.target === theme; });
    }
    function visible(n) {
      if (!isNews()) return true;
      if (n.type !== "company") return !!(graph.isKnowledge && graph.isKnowledge() && (n.type === "theme" || n.type === "industry" || n.type === "external"));
      return !ui.active.checked || counts(n)[ui.metric.value] > 0;
    }
    function dateText() { return result ? result.startDate + " ~ " + result.endDate + " · 한국 날짜" : "자료 확인 전"; }
    function setState(text) { ui["play-state"].textContent = text; }
    function clearPulse() {
      clearTimeout(pulseTimer); pulseTimer = null;
      clearTimeout(observedTimer); observedTimer = null;
      graph.nodes.forEach(function (n) { n.g.classList.remove("replaying", "newly-observed"); });
    }
    function stop(text) {
      playing = false; epoch++; clearTimeout(timer); timer = null; clearPulse();
      ui.play.textContent = "날짜 재생";
      setState(text || "정적 게시본 · 선택 날짜");
    }
    function pulseDate() {
      clearPulse();
      if (!playing || document.hidden || ui.motion.checked || reduced.matches) return;
      graph.nodes.forEach(function (n) {
        if (n.visible && counts(n).items.some(function (d) { return d.date === ui.date.value && d.kind === ui.metric.value; })) n.g.classList.add("replaying");
      });
      pulseTimer = setTimeout(clearPulse, 1600);
    }
    function matchesCurrent(doc) {
      return !!result && doc.kind === ui.metric.value && doc.date >= result.startDate && doc.date <= result.endDate
        && graph.nodes.some(function (n) { return n.type === "company" && n.visible && inTheme(n) && doc.companies.indexOf(n.id) >= 0; });
    }
    function updateNotice() {
      var docs = recentChange && recentChange.newlyObserved || [];
      ui["new-material"].hidden = !docs.length;
      if (!docs.length) {
        ui["new-status"].textContent = "";
        ui["new-date"].hidden = true; ui["new-date"].dataset.date = "";
        return;
      }
      var inside = docs.filter(matchesCurrent).length;
      ui["new-status"].textContent = "이번 확인에서 새로 수집된 출처: 기사 " + docs.filter(function (d) { return d.kind === "news"; }).length
        + " · 공시 " + docs.filter(function (d) { return d.kind === "disclosure"; }).length
        + " · 현재 날짜·지표·탐색 범위 안 " + inside + " / 밖 " + (docs.length - inside) + ". 선택 날짜는 유지합니다.";
      var latest = docs.map(function (d) { return d.date; }).sort().pop();
      ui["new-date"].hidden = latest === ui.date.value;
      ui["new-date"].dataset.date = latest;
    }
    function pulseObserved() {
      clearPulse();
      var docs = recentChange && recentChange.newlyObserved || [];
      if (!docs.length) return;
      var visible = docs.filter(matchesCurrent), count = 0;
      if (!document.hidden && !ui.motion.checked && !reduced.matches) {
        graph.nodes.forEach(function (n) {
          if (n.type === "company" && n.visible && visible.some(function (d) { return d.companies.indexOf(n.id) >= 0; })) { n.g.classList.add("newly-observed"); count++; }
        });
        if (count) observedTimer = setTimeout(clearPulse, 1600);
      }
      setState("새로 수집 확인 · " + (count ? count + "곳 잠깐 강조" : "현재 화면 강조 없음") + " · 날짜 유지");
    }
    function overview() {
      if (graph.getShown()) return;
      var previous = document.getElementById("map-news-detail");
      if (previous) previous.remove();
      var box = element("section", null, graph.panel, "news-detail"); box.id = "map-news-detail";
      graph.panel.insertBefore(box, graph.panel.firstChild);
      element("h3", "공개 목록에서 보기", box);
      if (!result) { element("p", "뉴스 자료를 아직 확인하지 못했습니다.", box, "meta"); return; }
      element("p", dateText(), box, "meta");
      var scopeIds = new Set(graph.nodes.filter(function (n) { return n.type === "company" && inTheme(n); }).map(function (n) { return n.id; }));
      var scoped = graph.inScope || graph.getTheme() ? result.documents.filter(function (d) { return d.companies.some(function (id) { return scopeIds.has(id); }); }) : result.documents;
      element("p", "기사 " + scoped.filter(function (d) { return d.kind === "news"; }).length + " · 공시 " + scoped.filter(function (d) { return d.kind === "disclosure"; }).length, box, "counts");
      element("p", graph.inScope ? "현재 탐색 범위에 포함된 기업의 전체 소식입니다. 주제별 기사 판정은 아닙니다." : graph.getTheme() ? "선택한 테마 소속 기업의 전체 소식입니다. 해당 테마만을 다룬 기사 수는 아닙니다." : "아래 수는 공개된 제목 목록 안에서만 비교합니다.", box, "meta");
      var ranked = graph.nodes.filter(function (n) { return n.type === "company" && inTheme(n) && counts(n)[ui.metric.value] > 0; })
        .sort(function (a, b) { return counts(b)[ui.metric.value] - counts(a)[ui.metric.value] || a.id.localeCompare(b.id, "ko"); }).slice(0, 10);
      var list = element("ol", null, box, "news-ranking");
      ranked.forEach(function (n) {
        var row = element("li", null, list), button = element("button", null, row); button.type = "button";
        element("span", n.id, button); element("small", metricName() + " " + counts(n)[ui.metric.value], button);
        button.addEventListener("click", function () { graph.find(n.id); });
      });
      if (!ranked.length) element("p", "이 조건에 해당하는 제목이 공개 목록에 없습니다. 시장 뉴스가 없다는 뜻은 아닙니다.", box, "meta");
    }
    function details(n) {
      var previous = document.getElementById("map-news-detail");
      if (previous) previous.remove();
      if (n.type !== "company" && n.type !== "external") return;
      var box = element("section", null, graph.panel, "news-detail"); box.id = "map-news-detail";
      element("h3", "점 크기와 소식", box);
      if (n.type === "external") { element("p", "페이지 없는 상대는 기업 여부가 분류되지 않아 기업 관계 수·뉴스 집계에서 제외합니다.", box, "meta"); return; }
      element("p", "조건에 맞는 등록 관계 상대 " + (counterpart[n.id] || 0) + "곳", box, "meta");
      if (!result || n.type === "external") { element("p", "이 점의 뉴스 집계 자료는 확인할 수 없습니다.", box, "meta"); return; }
      var c = counts(n);
      element("p", "기사 " + c.news + " · 공시 " + c.disclosure, box, "counts");
      element("p", dateText(), box, "meta");
      var value = isNews() ? c[ui.metric.value] : counterpart[n.id] || 0;
      if (MapNews.radius(value, ui.scale.value) >= 30) element("p", "점 크기에 표시 상한이 적용되었습니다.", box, "meta");
      element("p", "제목 기준 연결 · 사건 수 미집계 · 급증 비교 자료 부족", box, "meta");
      var shownItems = c.items.slice().sort(MapNews.compareDocuments).slice(0, 8);
      element("p", "선택 기간 전체 " + c.items.length + "개 중 " + shownItems.length + "개 표시 · " + (c.items.length - shownItems.length) + "개 생략", box, "meta");
      element("p", "기사는 제공일·시각순, 공시는 접수일순입니다. 같은 접수일의 공시는 첫 수집 확인순이며 접수 시각이 아닙니다.", box, "meta");
      var list = element("ul", null, box);
      shownItems.forEach(function (d) {
        var row = element("li", null, list);
        var a = element("a", d.title, row); a.href = d.url; a.target = "_blank"; a.rel = "noopener noreferrer";
        element("div", d.date + " · " + d.source + (d.kind === "disclosure" ? " · 공시 접수일" : " · 기사 제공일"), row, "meta");
        element("div", d.observedAt ? "첫 수집 확인 " + browserClock.format(new Date(d.observedAt)) + " KST" : "첫 수집 시각 기록 없음", row, "meta");
      });
      if (!c.items.length) element("p", "선택 기간의 공개 목록에서 찾은 제목이 없습니다. 수집 범위 밖의 자료는 알 수 없습니다.", box, "meta");
      var allItems = element("a", n.id + " 뉴스·공시 전체 목록", element("p", null, box));
      allItems.href = "./news.html?company=" + encodeURIComponent(n.id);
      allItems.target = "_top";
      var history = result.days.map(function (day) {
        var docs = c.items.filter(function (d) { return d.date === day.date; });
        return day.date.slice(5) + " 기사 " + docs.filter(function (d) { return d.kind === "news"; }).length + " / 공시 " + docs.filter(function (d) { return d.kind === "disclosure"; }).length;
      });
      var disclosure = element("details", null, box);
      element("summary", "날짜별 보유 제목 수", disclosure);
      element("p", history.join(" · "), disclosure, "meta");
      element("p", "미수집 날짜도 있을 수 있습니다. 0은 이 공개 목록에서 찾지 못했다는 뜻입니다.", disclosure, "meta");
    }
    function message() {
      var text;
      if (!data) text = failed ? "뉴스 자료를 불러오지 못했습니다. 관계 지도는 계속 볼 수 있습니다." : "뉴스 자료를 확인하고 있습니다.";
      else {
        text = "수집 " + data.collectedAt.replace("T", " ").replace("+09:00", " KST");
        if (data.generatedAt) text += " · 공개본 생성 " + data.generatedAt.replace("T", " ").replace("+09:00", " KST");
        if (checkedAt) text += " · 브라우저 확인 " + browserClock.format(new Date(checkedAt)) + " KST";
        text += " · " + dateText();
        text += " · 선택 기간의 공개 출처 기사 " + result.totals.news + " / 공시 " + result.totals.disclosure;
        text += " · 정적 게시본 · 버튼으로 새 게시본 확인";
        if (data.partial) text += " · 수집 범위 일부 미확인";
        if (data.note) text += " · " + data.note;
        if (Date.now() - Date.parse(data.collectedAt) > 48 * 3600000) text += " · 수집 후 48시간 경과";
        if (failed) text += " · 갱신 실패: 마지막으로 확인한 자료 유지";
        if (rollback) text += " · 더 오래된 게시본을 받아 직전 자료 유지";
        if (ui.date.value < data.minDate || ui.date.value > data.maxDate) text += " · 선택 날짜는 현재 공개 목록의 보유일 밖";
      }
      ui["data-status"].textContent = text;
      ui["data-status"].classList.toggle("warning", failed || rollback || !!(data && (data.partial || data.note)));
    }
    function render() {
      if (data) result = MapNews.aggregate(data, { endDate: ui.date.value, days: Number(ui.days.value) });
      graph.svg.classList.toggle("news-mode", isNews());
      graph.svg.classList.toggle("disclosure-mode", ui.metric.value === "disclosure");
      graph.svg.classList.toggle("reduced-motion", ui.motion.checked || reduced.matches);
      graph.nodes.forEach(function (n) {
        if (n.type !== "company") return;
        var c = counts(n), value = isNews() ? c[ui.metric.value] : counterpart[n.id] || 0;
        n.r = MapNews.radius(value, ui.scale.value);
        n.w = n.labelWidth + n.r + 8;
        n.circle.setAttribute("r", n.r);
        n.ring.setAttribute("r", n.r + 4);
        n.pulse.setAttribute("r", n.r + 8);
        n.label.setAttribute("x", n.r + 8);
        n.badge.textContent = result && n.type === "company" ? c[ui.metric.value] : "";
        n.g.classList.toggle("hollow", value === 0);
        n.g.classList.toggle("zero-badge", !result || c[ui.metric.value] === 0);
        n.g.setAttribute("aria-label", n.id + " · 등록 상대 " + (counterpart[n.id] || 0) + (result && n.type === "company" ? " · 공개 목록 기사 " + c.news + " · 공시 " + c.disclosure : " · 뉴스 집계 미확인"));
      });
      ui["encoding"].textContent = "크기: " + (isNews() ? "공개 목록의 " + metricName() + " 수" : "등록 관계의 서로 다른 상대 수") + " · " + (ui.scale.value === "log" ? "로그 압축 척도" : "면적 비례 척도") + " · 숫자: " + metricName() + " 수 · 점선 링: 급증 비교 자료 부족 · 색 있는 선: 기존 관계";
      message(); graph.applyFilter(); graph.position();
      updateNotice();
      if (graph.getShown()) details(graph.getShown()); else overview();
    }
    function nextDay(day) { var d = new Date(day + "T00:00:00+09:00"); d.setTime(d.getTime() + 86400000); return new Date(d.getTime() + 9 * 3600000).toISOString().slice(0,10); }
    function replayStep(myEpoch) {
      if (!playing || myEpoch !== epoch || document.hidden) return;
      render(); setState("과거 날짜 재생 · " + ui.date.value + " · 새 속보 아님"); pulseDate();
      if (ui.date.value >= data.maxDate) {
        timer = setTimeout(function () { stop("재생 끝 · " + ui.date.value); }, 1800); return;
      }
      timer = setTimeout(function () { ui.date.value = nextDay(ui.date.value); replayStep(myEpoch); }, 2200);
    }
    function play() {
      if (playing) { stop("재생 정지 · " + ui.date.value); return; }
      if (!data || !data.minDate || document.hidden) return;
      var targets = data.documents.filter(function (d) {
        return d.kind === ui.metric.value && d.companies.some(function (id) { return graph.nodes.some(function (n) { return n.id === id && inTheme(n); }); });
      });
      if (!targets.length) { stop("이 조건에 재생할 기업 자료가 없습니다"); return; }
      stop(); playing = true;
      ui.mode.value = "news"; ui.date.value = targets.map(function (d) { return d.date; }).sort()[0];
      ui.play.textContent = "재생 멈춤"; graph.clear();
      // Fit once using every day in the public feed. Playback never moves company positions.
      var active = ui.active.checked; ui.active.checked = false; render(); graph.fit(); ui.active.checked = active;
      replayStep(epoch);
    }
    async function refresh() {
      if (loading) return;
      stop(); recentChange = null; updateNotice(); loading = true; ui.refresh.disabled = true; ui.play.disabled = true; request = new AbortController();
      try {
        var incoming = MapNews.prepare(await NewsFeed.read({ signal: request.signal }), graph.nodes);
        if (!incoming.maxDate || incoming.queriesOK < 1) throw new Error("unconfirmed feed");
        var first = !data;
        var change = MapNews.diff(data, incoming); checkedAt = Date.now(); failed = false;
        rollback = change.reason === "rollback";
        if (rollback) { recentChange = change; updateNotice(); message(); setState("이전 게시본 · 직전 자료 유지"); return; }
        data = incoming; recentChange = first ? null : change;
        if (first) ui.date.value = dateChosen && validDate(ui.date.value) ? ui.date.value : !dateChosen && initialState.date || data.maxDate;
        ui.date.min = ui.date.value < data.minDate ? ui.date.value : data.minDate;
        ui.date.max = ui.date.value > data.maxDate ? ui.date.value : data.maxDate;
        ui.date.disabled = ui.days.disabled = false; ui.mode.options[1].disabled = false;
        var selected = graph.getShown();
        if (first && !modeChosen && initialState.mode === "news") ui.mode.value = "news";
        if (first && !selected && !startChosen && ui.mode.value === "news" && graph.chooseNewsStart) graph.chooseNewsStart(MapNews.aggregate(data, { endDate: ui.date.value, days: Number(ui.days.value) }).byCompany);
        if (first && selected) {
          if (selected.type !== "company" && !(graph.isKnowledge && graph.isKnowledge())) ui.mode.value = "relations";
          ui.active.checked = false;
        }
        render();
        if (first) {
          // The first status text can change the toolbar height. Fit the current scope once,
          // unless the user has already moved it; later refreshes preserve their viewport.
          if (graph.initialFit) graph.initialFit(!selected);
          else if (!selected) { if (graph.arrangeScope) graph.arrangeScope(); graph.fit(); }
        }
        if (!first) {
          pulseObserved();
          if (!change.newlyObserved.length) setState(change.reason === "same-collection" ? "같은 수집본 · 새로 수집 확인 없음" : "게시본 확인 · 새 수집 시각이 확인된 출처 없음");
        }
      } catch (e) { failed = true; message(); }
      finally { request = null; loading = false; ui.refresh.disabled = false; ui.play.disabled = !data; }
    }
    ["mode", "metric", "scale", "active", "days"].forEach(function (key) { ui[key].addEventListener("change", function () {
      if (key === "mode") modeChosen = true;
      startChosen = true; stop(); graph.clear(); render(); if (key === "mode" || key === "active") graph.fit();
    }); });
    ui.date.addEventListener("change", function () {
      dateChosen = startChosen = true;
      if (!validDate(ui.date.value) || data && (ui.date.value < ui.date.min || ui.date.value > ui.date.max)) { ui.date.value = data && data.maxDate || ""; }
      stop(); graph.clear(); render();
    });
    ui.play.addEventListener("click", play); ui.refresh.addEventListener("click", refresh); ui.fit.addEventListener("click", graph.fit);
    ui["new-date"].addEventListener("click", function () {
      var day = ui["new-date"].dataset.date;
      if (!data || !day) return;
      stop("새 자료의 제공·접수 날짜 선택"); ui.date.value = day; graph.clear(); render();
    });
    ui.motion.addEventListener("change", function () { stop("움직임 설정 변경"); render(); });
    function reduceChanged() { ui.motion.checked = reduced.matches; stop(); render(); }
    if (reduced.addEventListener) reduced.addEventListener("change", reduceChanged);
    document.addEventListener("visibilitychange", function () { if (document.hidden) stop("재생 정지 · 다른 화면으로 이동"); });
    window.addEventListener("pagehide", function () { stop(); if (request) request.abort(); });
    render(); refresh();
    return {
      isVisible: visible, showDetails: details,
      navigationState: function () {
        var state = new URLSearchParams();
        ["mode", "metric", "scale", "days"].forEach(function (key) { state.set(key, ui[key].value); });
        if (!data && !modeChosen && initialState.mode) state.set("mode", initialState.mode);
        state.set("date", !data && !dateChosen ? initialState.date || "" : ui.date.value);
        return readViewState(state);
      },
      updateZoom: function (k) {
        var factor = isNews() ? Math.max(1, .8 / k) : 1;
        graph.nodes.forEach(function (n) {
          if (n.type !== "company") return;
          n.drawR = n.r * factor;
          n.circle.setAttribute("r", n.drawR);
          n.ring.setAttribute("r", n.drawR + 4 * factor);
          n.pulse.setAttribute("r", n.drawR + 8 * factor);
          n.label.setAttribute("x", n.drawR + (isNews() ? 7 / k : 8));
          n.label.style.fontSize = isNews() ? Math.max(11, 11 / k) + "px" : "";
          n.badge.style.fontSize = isNews() ? Math.max(10, 10 / k) + "px" : "";
          n.badge.setAttribute("y", isNews() ? Math.max(4, 3 / k) : 4);
        });
      },
      reveal: function (n) { stop(); if (n.type !== "company" && !(graph.isKnowledge && graph.isKnowledge())) ui.mode.value = "relations"; ui.active.checked = false; render(); },
      filterChanged: function () { startChosen = true; stop(); render(); },
      visibilityChanged: function () {
        graph.nodes.forEach(function (n) { n.g.setAttribute("tabindex", n.visible ? "0" : "-1"); });
        var empty = document.getElementById("map-empty");
        if (empty) empty.hidden = !isNews() || graph.nodes.some(function (n) { return n.type === "company" && n.visible; });
      }
    };
  }};
})();
