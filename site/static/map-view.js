/* Public map controls. Counts are derived only from verified public title records. */
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
    var ids = ["mode", "metric", "scale", "highlight", "highlight-status", "active", "fit", "date", "days", "play", "motion", "refresh", "play-state", "data-status", "encoding", "new-material", "new-status", "new-date"];
    var ui = {};
    ids.forEach(function (id) { ui[id] = document.getElementById("map-" + id); });
    var data = null, result = null, activity = null, baseline = null, playing = false, timer = null, pulseTimer = null;
    var loading = false, failed = false, epoch = 0, observedTimer = null, checkedAt = null, rollback = false, recentChange = null, request = null;
    var modeChosen = false, startChosen = false, dateChosen = false;
    var archive = window.NewsArchive ? window.NewsArchive.create() : null, snapshot = null, aggregateKey = "", pendingQuery = false, replayEnd = null, unproven = false;
    var timelineWindow = null, observedCompanies = new Set();
    var activityUI = { days: document.getElementById("activity-days"), companies: document.getElementById("activity-company-list"),
      comparison: document.getElementById("map-comparison-status"), summary: document.getElementById("map-update-summary"),
      timeline: document.getElementById("news-timeline"), metricButtons: [] };
    function scopeIDs() { return new Set(graph.nodes.filter(function (n) { return n.type === "company" && inTheme(n); }).map(function (n) { return n.id; })); }
    function selectionKey(value, day) { return value.indexes.ordered.hash + "|" + (day || ui.date.value) + "|" + ui.days.value + "|" + Array.from(scopeIDs()).sort().join("\n"); }
    function queryChanged(keepTimeline) {
      if (!keepTimeline) timelineWindow = null;
      recentChange = null; observedCompanies.clear();
      graph.nodes.forEach(function (n) { n.g.classList.remove("observed-recent", "newly-observed"); });
      updateNotice();
      if (archive && loading) { pendingQuery = true; request.abort(); }
    }
    var initialState = readViewState(window.location.search);
    ["metric", "scale"].forEach(function (key) { if (initialState[key]) ui[key].value = initialState[key]; });
    // Resolve once after node/theme navigation has established the actual graph scope.
    ui.days.value = initialState.days || (graph.isOverview && graph.isOverview() ? "7" : "1");
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
    function metricName() { return ui.metric.value === "news" ? "뉴스" : "공시"; }
    function highlightMinimum() {
      if (!ui.highlight) return 0;
      var value = Number(ui.highlight.value);
      return [0, 1, 2, 3, 5, 10].indexOf(value) >= 0 ? value : 0;
    }
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
    function setState(text) {
      ui["play-state"].textContent = text;
      ui["play-state"].classList.toggle("is-replaying", playing);
    }
    function clearPulse() {
      clearTimeout(pulseTimer); pulseTimer = null;
      clearTimeout(observedTimer); observedTimer = null;
      graph.nodes.forEach(function (n) { n.g.classList.remove("replaying", "newly-observed"); });
    }
    function stop(text) {
      playing = false; epoch++; clearTimeout(timer); timer = null; clearPulse();
      ui.play.textContent = "날짜 재생";
      ui.days.disabled = !data;
      setState(text || "정적 게시본 · 선택 날짜");
    }
    function pulseDate() {
      clearPulse();
      if (!playing || document.hidden || ui.motion.checked || reduced.matches) return;
      graph.nodes.forEach(function (n) {
        if (n.visible && (archive ? counts(n).byDay && counts(n).byDay[ui.date.value] && counts(n).byDay[ui.date.value][ui.metric.value] > 0 : counts(n).items.some(function (d) { return d.date === ui.date.value && d.kind === ui.metric.value; }))) n.g.classList.add("replaying");
      });
      pulseTimer = setTimeout(clearPulse, 1600);
    }
    function matchesCurrent(doc) {
      return !!result && doc.kind === ui.metric.value && doc.date >= result.startDate && doc.date <= result.endDate
        && graph.nodes.some(function (n) { return n.type === "company" && n.visible && inTheme(n) && doc.companies.indexOf(n.id) >= 0; });
    }
    function updateNotice() {
      if (archive) {
        var change = recentChange;
        ui["new-material"].hidden = !change || !change.total;
        ui["new-status"].textContent = change && change.total ? "이 게시본에서 새로 수집 확인: 뉴스 " + change.news + " · 공시 " + change.disclosure + " · 현재 날짜·지표·탐색 범위 안 " + change.inside + " / 밖 " + (change.total - change.inside) + ". 첫 수집 시각과 직전 게시본을 대조했습니다." : "";
        ui["new-date"].hidden = !change || !change.maxDate || change.maxDate === ui.date.value;
        ui["new-date"].dataset.date = change && change.maxDate || ""; return;
      }
      var docs = recentChange && recentChange.newlyObserved || [];
      ui["new-material"].hidden = !docs.length;
      if (!docs.length) {
        ui["new-status"].textContent = "";
        ui["new-date"].hidden = true; ui["new-date"].dataset.date = "";
        return;
      }
      var inside = docs.filter(matchesCurrent).length;
      ui["new-status"].textContent = "이 게시본에서 새로 수집 확인: 뉴스 " + docs.filter(function (d) { return d.kind === "news"; }).length
        + " · 공시 " + docs.filter(function (d) { return d.kind === "disclosure"; }).length
        + " · 현재 날짜·지표·탐색 범위 안 " + inside + " / 밖 " + (docs.length - inside) + ". 첫 수집 시각과 직전 게시본을 대조했습니다.";
      var latest = docs.map(function (d) { return d.date; }).sort().pop();
      ui["new-date"].hidden = latest === ui.date.value;
      ui["new-date"].dataset.date = latest;
    }
    function pulseObserved() {
      clearPulse();
      var docs = !archive && recentChange && recentChange.newlyObserved || [];
      var ids = archive ? recentChange && recentChange.companies || [] : docs.filter(matchesCurrent).flatMap(function (d) { return d.companies; });
      if (archive ? !recentChange || !recentChange.total : !docs.length) return;
      observedCompanies = new Set(ids);
      var count = 0;
      graph.nodes.forEach(function (n) {
        var observed = n.type === "company" && observedCompanies.has(n.id);
        n.g.classList.toggle("observed-recent", observed);
        if (observed && n.visible) {
          count++;
          if (!document.hidden && !ui.motion.checked && !reduced.matches) n.g.classList.add("newly-observed");
        }
      });
      if (count) observedTimer = setTimeout(clearPulse, 6000);
      setState("새로 수집 확인 · " + (count ? count + "곳 강조 · 초록 테두리로 확인 상태 유지" : "현재 화면 강조 없음") + " · 날짜 유지");
      renderActivity();
    }
    function updateActivity() {
      if (!result || !data) { activity = null; return; }
      var days = result.days.length, options = { endDate: result.endDate, days: days, metric: ui.metric.value };
      if (!archive) { activity = MapNews.activity(data, options); return; }
      var range = MapNews.activityRange(result.endDate, days);
      var previous = baseline && baseline.startDate === range.baselineStart && baseline.endDate === range.baselineEnd ? baseline : null;
      activity = MapNews.activityFromAggregates(result, previous, snapshot, options);
    }
    function selectedActivity(n) { return activity && activity.byCompany[n.id]; }
    function rememberTimeline() {
      if (!timelineWindow && result) timelineWindow = { result: result, activity: activity, endDate: result.endDate, days: result.days.length };
    }
    function selectDay(day) {
      if (!data || !validDate(day)) return;
      rememberTimeline(); stop("선택 날짜의 보유 자료 · " + day);
      queryChanged(true); dateChosen = startChosen = true; ui.date.value = day; ui.days.value = "1";
      render();
    }
    function restoreTimeline(text) {
      var previous = timelineWindow;
      if (!previous) return;
      stop(text || "원래 선택 기간으로 돌아왔습니다");
      queryChanged(); ui.date.value = previous.endDate; ui.days.value = String(previous.days);
      dateChosen = startChosen = true; render();
    }
    function buildTimelineControls() {
      if (!activityUI.timeline) return;
      var controls = activityUI.timeline.querySelector(".timeline-controls");
      if (!controls) return;
      var metrics = element("div", null, controls, "timeline-metrics");
      metrics.setAttribute("role", "group"); metrics.setAttribute("aria-label", "활동 자료 종류");
      ["news", "disclosure"].forEach(function (metric) {
        var button = element("button", metric === "news" ? "뉴스" : "공시", metrics);
        button.type = "button"; button.dataset.metric = metric;
        button.addEventListener("click", function () { ui.metric.value = metric; ui.metric.dispatchEvent(new Event("change", { bubbles: true })); });
        activityUI.metricButtons.push(button);
      });
      activityUI.previous = element("button", "←", controls, "timeline-step"); activityUI.previous.type = "button";
      activityUI.previous.setAttribute("aria-label", "이전 날짜");
      activityUI.next = element("button", "→", controls, "timeline-step"); activityUI.next.type = "button";
      activityUI.next.setAttribute("aria-label", "다음 날짜");
      [activityUI.previous, activityUI.next].forEach(function (button, index) {
        button.addEventListener("click", function () {
          if (!data || !validDate(ui.date.value)) return;
          var day = MapNews.shiftDay(ui.date.value, index ? 1 : -1);
          if (day < ui.date.min || day > ui.date.max) return;
          selectDay(day);
        });
      });
      activityUI.reset = element("button", "원래 기간 보기", controls, "timeline-reset"); activityUI.reset.type = "button";
      activityUI.reset.addEventListener("click", function () { restoreTimeline(); });
    }
    function renderActivity() {
      activityUI.metricButtons.forEach(function (button) {
        button.setAttribute("aria-pressed", String(button.dataset.metric === ui.metric.value)); button.disabled = !result;
      });
      if (activityUI.previous) activityUI.previous.disabled = !data || ui.date.value <= ui.date.min || playing;
      if (activityUI.next) activityUI.next.disabled = !data || ui.date.value >= ui.date.max || playing;
      if (activityUI.reset) {
        activityUI.reset.hidden = !timelineWindow;
        if (timelineWindow) activityUI.reset.textContent = timelineWindow.days + "일 전체 보기";
      }
      if (activityUI.comparison) {
        var comparison = activity && activity.comparison;
        var increases = activity ? graph.nodes.filter(function (n) {
          var company = selectedActivity(n); return n.type === "company" && inTheme(n) && company && company.comparison.status === "increase";
        }).length : 0;
        activityUI.comparison.textContent = comparison
          ? comparison.status === "insufficient" ? "평소 대비 증가 비교 보류 · " + comparison.reasonText
            : "같은 수집 범위의 직전 " + activity.range.baselineDays + "일과 비교 · 현재 범위에서 2배 이상·3건 이상 " + increases + "개 기업 · 통계적 유의성 판정 아님"
          : failed ? "뉴스 자료 확인 실패 · 날짜별 활동과 증가 여부를 확인할 수 없습니다." : "날짜별 활동을 확인하고 있습니다.";
      }
      var display = timelineWindow && timelineWindow.result || result;
      var displayActivity = timelineWindow && timelineWindow.activity || activity;
      if (activityUI.days) {
        var focusedDate = activityUI.days.contains(document.activeElement) ? document.activeElement.dataset.date : null;
        activityUI.days.replaceChildren();
        if (!display) element("p", failed ? "자료를 불러오지 못했습니다." : "공개 날짜를 확인하고 있습니다.", activityUI.days, "meta");
        else {
          var maximum = Math.max(1, ...display.days.map(function (day) { return day[ui.metric.value]; }));
          var representative = displayActivity && Object.values(displayActivity.byCompany)[0];
          display.days.forEach(function (day) {
            var daily = representative && representative.series.find(function (row) { return row.date === day.date; });
            var count = day[ui.metric.value] > 0 || daily && daily.complete ? day[ui.metric.value] : null;
            var button = element("button", null, activityUI.days, "activity-day" + (count === null ? " activity-missing" : ""));
            button.type = "button"; button.dataset.date = day.date;
            button.setAttribute("aria-pressed", String(day.date === ui.date.value));
            button.classList.toggle("is-selected", day.date === ui.date.value);
            button.classList.toggle("is-replaying", playing && day.date === ui.date.value);
            button.setAttribute("aria-label", day.date + " · 전체 공개목록 " + metricName() + " " + (count === null ? "관측 자료 미확인" : count + "건 확인") + " · 이 날짜 보기");
            button.title = "전체 공개목록 기준 · " + (count === null ? "빈 날짜를 0건으로 간주하지 않습니다." : "확인한 제목의 고유 출처 수이며 시장 전체 뉴스 수가 아닙니다.");
            element("span", count === null ? "—" : String(count), button, "activity-count");
            var wrap = element("span", null, button, "bar-wrap"), bar = element("span", null, wrap, "activity-bar");
            bar.style.height = count === null ? "6px" : Math.max(3, count / maximum * 100) + "%";
            bar.setAttribute("aria-hidden", "true");
            element("span", day.date.slice(5).replace("-", "/"), button, "activity-label");
            if (count === null) element("span", "미확인", button, "activity-missing-label");
            button.addEventListener("click", function () { selectDay(day.date); });
            if (focusedDate === day.date) button.focus({ preventScroll: true });
          });
        }
      }
      if (activityUI.companies) {
        var focusedCompany = activityUI.companies.contains(document.activeElement) ? document.activeElement.dataset.company : null;
        activityUI.companies.replaceChildren();
        var ranked = result ? graph.nodes.filter(function (n) { return n.type === "company" && inTheme(n) && counts(n)[ui.metric.value] > 0; })
          .sort(function (a, b) { return counts(b)[ui.metric.value] - counts(a)[ui.metric.value] || a.id.localeCompare(b.id, "ko"); }).slice(0, 8) : [];
        ranked.forEach(function (n) {
          var value = selectedActivity(n), button = element("button", null, activityUI.companies, "activity-card");
          button.type = "button"; button.dataset.company = n.id;
          button.classList.toggle("observed-recent", observedCompanies.has(n.id));
          button.classList.toggle("activity-increase", !!value && value.comparison.status === "increase");
          element("span", n.id, button, "activity-name");
          element("span", metricName() + " " + counts(n)[ui.metric.value], button, "activity-badge");
          if (value && value.comparison.status === "increase") element("small", value.comparison.ratio.toFixed(1) + "배 증가", button, "activity-badge");
          var series = displayActivity && displayActivity.byCompany[n.id] && displayActivity.byCompany[n.id].series;
          if (series && series.length > 1) {
            var trend = element("span", null, button, "trend-bars"); trend.setAttribute("aria-hidden", "true");
            var maxCount = Math.max(1, ...series.map(function (day) { return day.observedCount || 0; }));
            series.forEach(function (day) {
              var bar = element("span", null, trend, "activity-trend" + (day.observedCount === null ? " activity-missing" : ""));
              bar.style.height = day.observedCount === null ? "3px" : Math.max(2, day.observedCount / maxCount * 100) + "%";
            });
          }
          button.setAttribute("aria-label", n.id + " · 선택 기간 공개목록 " + metricName() + " " + counts(n)[ui.metric.value] + "건 · 기업과 근거 보기");
          button.addEventListener("click", function () { graph.find(n.id); });
          if (focusedCompany === n.id) button.focus({ preventScroll: true });
        });
        if (!ranked.length) element("p", result ? "현재 범위의 공개목록에서 해당 자료를 찾지 못했습니다. 수집 범위 밖의 소식은 알 수 없습니다." : failed ? "자료 확인 실패" : "기업 활동을 확인하고 있습니다.", activityUI.companies, "meta");
      }
      var subtitle = activityUI.timeline && activityUI.timeline.querySelector(".timeline-subtitle");
      if (subtitle) subtitle.textContent = "막대: 전체 공개목록 · " + (ui.metric.value === "news" ? "제공일" : "접수일") + " 기준";
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
      var scoped = archive ? [] : graph.inScope || graph.getTheme() ? result.documents.filter(function (d) { return d.companies.some(function (id) { return scopeIds.has(id); }); }) : result.documents;
      element("p", "뉴스 " + (archive ? result.scopeTotals.news : scoped.filter(function (d) { return d.kind === "news"; }).length) + " · 공시 " + (archive ? result.scopeTotals.disclosure : scoped.filter(function (d) { return d.kind === "disclosure"; }).length), box, "counts");
      element("p", graph.inScope ? "현재 탐색 범위에 포함된 기업의 전체 소식입니다. 주제별 뉴스 판정은 아닙니다." : graph.getTheme() ? "선택한 테마 소속 기업의 전체 소식입니다. 해당 테마만을 다룬 뉴스 수는 아닙니다." : "아래 수는 공개된 제목 목록 안에서만 비교합니다.", box, "meta");
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
      element("p", "뉴스 " + c.news + " · 공시 " + c.disclosure, box, "counts");
      element("p", dateText(), box, "meta");
      var value = isNews() ? c[ui.metric.value] : counterpart[n.id] || 0;
      if (MapNews.radius(value, ui.scale.value) >= 30) element("p", "점 크기에 표시 상한이 적용되었습니다.", box, "meta");
      element("p", "제목 기준 연결 · 사건 수 미집계", box, "meta");
      var companyActivity = selectedActivity(n);
      if (companyActivity) {
        var comparison = companyActivity.comparison;
        element("p", comparison.status === "increase" ? "평소 대비 " + comparison.ratio.toFixed(1) + "배 증가 · 직전 " + comparison.baselineDays + "일의 일평균 기준"
          : comparison.status === "stable" ? "증가 표시 조건에 해당하지 않음 · 직전 " + comparison.baselineDays + "일의 일평균 기준"
            : "평소 대비 증가 비교 보류 · " + comparison.reasonText, box, comparison.status === "increase" ? "activity-badge" : "meta");
      }
      var shownItems = c.items.slice().sort(MapNews.compareDocuments).slice(0, 8);
      element("p", "선택 기간 전체 " + (c.news + c.disclosure) + "개 중 " + shownItems.length + "개 표시 · " + (c.news + c.disclosure - shownItems.length) + "개 생략", box, "meta");
      element("p", "날짜순이며 같은 날은 시각 있는 뉴스, 날짜만 있는 기관 자료, 공시 순입니다. 날짜만 있는 기관 자료는 첫 수집 확인순이며 제공 시각이 아닙니다. 같은 접수일의 공시는 첫 수집 확인순이며 접수 시각이 아닙니다.", box, "meta");
      var list = element("ul", null, box);
      shownItems.forEach(function (d) {
        var row = element("li", null, list);
        var a = element("a", d.title, row); a.href = d.url; a.target = "_blank"; a.rel = "noopener noreferrer";
        if (d.datePrecision === "day") {
          var dateLine = element("div", null, row, "meta"), provided = element("time", d.date, dateLine); provided.dateTime = d.date;
          element("span", " · " + d.source + " · 기관 자료 제목 · 기관 제공일 · 시각 미제공", dateLine);
          var attribution = element("div", "작성자 " + d.author + " · ", row, "meta");
          var policy = element("a", "공공누리 제1유형(출처표시)", attribution);
          policy.href = d.policyUrl; policy.target = "_blank"; policy.rel = "noopener noreferrer";
        } else element("div", d.date + " · " + d.source + (d.kind === "disclosure" ? " · 공시 접수일" : d.source === "한국은행" ? " · 기관 자료 제목 · 기관 제공일" : " · 기사 제공일"), row, "meta");
        element("div", d.observedAt ? "첫 수집 확인 " + browserClock.format(new Date(d.observedAt)) + " KST" : "첫 수집 시각 기록 없음", row, "meta");
      });
      if (!c.items.length) element("p", "선택 기간의 공개 목록에서 찾은 제목이 없습니다. 수집 범위 밖의 자료는 알 수 없습니다.", box, "meta");
      var allItems = element("a", n.id + " 뉴스·공시 전체 목록", element("p", null, box));
      allItems.href = "./news.html?company=" + encodeURIComponent(n.id);
      allItems.target = "_top";
      var history = result.days.map(function (day) {
        var daily = c.byDay && c.byDay[day.date] || { news: 0, disclosure: 0 };
        return day.date.slice(5) + " 뉴스 " + (day.news > 0 ? daily.news : "미확인") + " / 공시 " + (day.disclosure > 0 ? daily.disclosure : "미확인");
      });
      var disclosure = element("details", null, box);
      element("summary", "날짜별 보유 제목 수", disclosure);
      element("p", history.join(" · "), disclosure, "meta");
      element("p", "미확인은 해당 종류의 날짜별 자료가 없는 경우입니다. 0은 다른 자료가 확인된 그날의 공개목록에서 이 기업의 제목을 찾지 못했다는 뜻이며, 수집 범위 밖의 뉴스가 없다는 뜻이 아닙니다.", disclosure, "meta");
    }
    function message() {
      var text;
      if (!data) text = failed ? "뉴스 자료를 불러오지 못했습니다. 관계 지도는 계속 볼 수 있습니다." : "뉴스 자료를 확인하고 있습니다.";
      else {
        text = "수집 " + data.collectedAt.replace("T", " ").replace("+09:00", " KST");
        if (data.generatedAt) text += " · 공개본 생성 " + data.generatedAt.replace("T", " ").replace("+09:00", " KST");
        if (checkedAt) text += " · 브라우저 확인 " + browserClock.format(new Date(checkedAt)) + " KST";
        text += " · " + dateText();
        text += " · 선택 기간의 공개 출처 뉴스 " + result.totals.news + " / 공시 " + result.totals.disclosure;
        text += " · 화면 표시 중 5분마다 새 게시본 확인 · 날짜 재생 중 확인 대기";
        if (data.partial) text += " · 수집 범위 일부 미확인";
        if (data.note) text += " · " + data.note;
        if (Date.now() - Date.parse(data.collectedAt) > 48 * 3600000) text += " · 수집 후 48시간 경과";
        if (archive) text += " · 최근 30일 기록·총 건수 상한 없음";
        if (archive && loading) text += " · 선택 조건 집계 중: 직전 정상 집계 표시";
        if (unproven) text += " · 직전 목록과 신규 여부 대조 실패: 새 수집 강조 생략";
        if (failed) text += " · 갱신 실패: 마지막으로 확인한 자료 유지";
        if (rollback) text += " · 더 오래된 게시본을 받아 직전 자료 유지";
        if (ui.date.value < data.minDate || ui.date.value > data.maxDate) text += " · 선택 날짜는 현재 공개 목록의 보유일 밖";
      }
      ui["data-status"].textContent = text;
      ui["data-status"].classList.toggle("warning", failed || rollback || !!(data && (data.partial || data.note)));
      if (activityUI.summary) {
        var compact = !data ? failed ? "자료 확인 실패 · 관계 탐색은 계속할 수 있습니다" : "공개된 수집 자료를 확인하고 있습니다" :
          "수집 " + data.collectedAt.slice(0, 16).replace("T", " ") + " KST";
        if (data && data.partial) compact += " · 일부 수집 미확인" + (data.queriesTotal ? " (" + data.queriesOK + "/" + data.queriesTotal + " 조회)" : "");
        if (data && Date.now() - Date.parse(data.collectedAt) > 48 * 3600000) compact += " · 48시간 이상 경과";
        if (failed) compact += data ? " · 갱신 실패, 직전 자료 유지" : "";
        else if (rollback) compact += " · 오래된 게시본 거절, 직전 자료 유지";
        else if (loading) compact += " · 게시 자료 확인 중";
        else if (playing) compact += " · 날짜 재생 중";
        else if (checkedAt) compact += " · 게시본 확인 " + new Date(checkedAt + 9 * 3600000).toISOString().slice(11, 16) + " KST";
        compact += " · 게시본 확인 5분 주기";
        activityUI.summary.textContent = compact;
        activityUI.summary.title = "화면이 보이는 동안 게시된 파일만 확인합니다. 이 동작은 뉴스를 수집하지 않습니다. " + text;
        activityUI.summary.classList.toggle("warning", failed || rollback || !!(data && data.partial));
      }
    }
    function render() {
      if (archive && snapshot && aggregateKey !== selectionKey(snapshot)) {
        if (!loading) loadArchive(false);
      } else if (data && !archive) result = MapNews.aggregate(data, { endDate: ui.date.value, days: Number(ui.days.value) });
      updateActivity();
      var minimum = isNews() ? highlightMinimum() : 0;
      graph.svg.classList.toggle("news-mode", isNews());
      graph.svg.classList.toggle("disclosure-mode", ui.metric.value === "disclosure");
      graph.svg.classList.toggle("news-highlight-active", minimum > 0);
      graph.svg.classList.toggle("reduced-motion", ui.motion.checked || reduced.matches);
      graph.nodes.forEach(function (n) {
        if (n.type !== "company") {
          n.g.classList.remove("news-highlight-hit", "news-highlight-dim");
          return;
        }
        var c = counts(n), value = isNews() ? c[ui.metric.value] : counterpart[n.id] || 0;
        var companyActivity = selectedActivity(n);
        n.activityCount = isNews() ? c[ui.metric.value] : 0;
        n.g.classList.toggle("activity-increase", isNews() && !!companyActivity && companyActivity.comparison.status === "increase");
        n.g.classList.toggle("observed-recent", observedCompanies.has(n.id));
        var emphasized = minimum > 0 && c[ui.metric.value] >= minimum;
        n.r = MapNews.radius(value, ui.scale.value);
        n.w = n.labelWidth + n.r + 8;
        n.circle.setAttribute("r", n.r);
        n.ring.setAttribute("r", n.r + 4);
        n.pulse.setAttribute("r", n.r + 8);
        n.label.setAttribute("x", n.r + 8);
        n.badge.textContent = result && n.type === "company" ? c[ui.metric.value] : "";
        n.g.classList.toggle("hollow", value === 0);
        n.g.classList.toggle("zero-badge", !result || c[ui.metric.value] === 0);
        n.g.classList.toggle("news-highlight-hit", emphasized);
        n.g.classList.toggle("news-highlight-dim", minimum > 0 && !emphasized);
        n.g.setAttribute("aria-label", n.id + " · 등록 상대 " + (counterpart[n.id] || 0) + (result && n.type === "company" ? " · 공개 목록 뉴스 " + c.news + " · 공시 " + c.disclosure : " · 뉴스 집계 미확인"));
      });
      ui["encoding"].textContent = "크기: " + (isNews() ? "공개 목록의 " + metricName() + " 수" : "등록 관계의 서로 다른 상대 수") + " · " + (ui.scale.value === "log" ? "로그 압축 척도" : "면적 비례 척도") + " · 숫자: " + metricName() + " 수 · 초록: 새 수집 확인 · 주황: 날짜 재생 · 보라: 증가 조건 충족 · 색 있는 선: 기존 관계";
      message(); graph.applyFilter(); graph.position();
      if (ui.highlight && ui["highlight-status"]) {
        ui.highlight.disabled = !result;
        if (!result) ui["highlight-status"].textContent = "뉴스 자료를 확인하면 자료 수를 기준으로 기업을 강조할 수 있습니다.";
        else if (!minimum) ui["highlight-status"].textContent = "자료 수 강조 안 함 · 아래 선택으로 기준을 정할 수 있습니다.";
        else {
          var highlighted = graph.nodes.filter(function (n) { return n.type === "company" && n.visible && n.g.classList.contains("news-highlight-hit"); }).length;
          ui["highlight-status"].textContent = metricName() + " " + minimum + "건 이상 강조 · 현재 범위 " + highlighted + "개 기업";
        }
      }
      updateNotice(); renderActivity();
      if (graph.showSelectedRelation && graph.showSelectedRelation()) return;
      if (graph.getShown()) details(graph.getShown()); else overview();
    }
    function nextDay(day) { return MapNews.shiftDay(day, 1); }
    async function replayStep(myEpoch) {
      if (archive) { await loadArchive(false); }
      if (!playing || myEpoch !== epoch || document.hidden) return;
      if (failed) { stop("날짜 재생 중 자료 확인 실패 · 마지막 확인 자료 유지"); renderActivity(); return; }
      render(); setState("과거 날짜 재생 · " + ui.date.value + " · 새 속보 아님"); pulseDate();
      if (ui.date.value >= replayEnd) {
        timer = setTimeout(function () { restoreTimeline("날짜 재생 끝 · 원래 선택 기간으로 돌아왔습니다"); }, 1800); return;
      }
      timer = setTimeout(function () { ui.date.value = nextDay(ui.date.value); replayStep(myEpoch); }, 2200);
    }
    function play() {
      if (playing) { stop("재생 정지 · " + ui.date.value); return; }
      if (!data || !data.minDate || !result || loading || document.hidden) return;
      var source = timelineWindow && timelineWindow.result || result;
      var hasTargets = graph.nodes.some(function (n) {
        return n.type === "company" && inTheme(n) && source.byCompany[n.id] && source.byCompany[n.id][ui.metric.value] > 0;
      });
      if (!hasTargets) { stop("이 조건에 재생할 기업 자료가 없습니다"); return; }
      rememberTimeline(); stop(); queryChanged(true); playing = true; replayEnd = timelineWindow.endDate;
      // Keep the original date strip, aggregate one historical day at a time,
      // and return to the original selection at the end. Camera/selection stay.
      ui.mode.value = "news"; ui.date.value = timelineWindow.result.startDate; ui.days.value = "1";
      ui.days.disabled = true; ui.play.textContent = "재생 멈춤";
      renderActivity();
      replayStep(epoch);
    }
    async function loadArchive(refreshing) {
      if (loading || document.hidden) return;
      loading = true; pendingQuery = false; ui.refresh.disabled = true; ui.play.disabled = true;
      message();
      var controller = new AbortController(); request = controller;
      try {
        var next = refreshing || !snapshot ? await archive.open(controller.signal) : snapshot;
        var reason = archive.relation(snapshot, next);
        if (reason === "rollback") { rollback = true; recentChange = null; updateNotice(); message(); setState("이전 게시본 · 직전 자료 유지"); return; }
        if (!next.coverage.queries_ok) throw new Error("Unconfirmed archive");
        var first = !snapshot, minDate = next.indexes.ordered.count ? next.indexes.ordered.first.slice(0, 10) : next.collected_at.slice(0, 10);
        var maxDate = next.indexes.ordered.count ? next.indexes.ordered.last.slice(0, 10) : next.collected_at.slice(0, 10);
        var day = first ? dateChosen && validDate(ui.date.value) ? ui.date.value : !dateChosen && initialState.date || maxDate : ui.date.value;
        var selectedKey = selectionKey(next, day), scope = scopeIDs(), selectedMetric = ui.metric.value;
        var samePublished = snapshot && snapshot.collected_at === next.collected_at && snapshot.indexes.ordered.hash === next.indexes.ordered.hash;
        var answer = await archive.aggregate(next, { endDate: day, days: Number(ui.days.value), nodes: graph.nodes, scope: scope, signal: controller.signal,
          progress: function (n) { ui["data-status"].textContent = "선택 기간 " + n + "개 확인 중 · 직전 정상 집계 유지"; } });
        var previous = null;
        // A partial collection already rules out a fair baseline comparison.
        // Do not fetch unused history or pad unobserved dates with zeroes.
        if (!next.coverage.partial) {
          var interval = MapNews.activityRange(day, Number(ui.days.value));
          previous = await archive.aggregate(next, { endDate: interval.baselineEnd, days: interval.baselineDays,
            nodes: graph.nodes, scope: scope, signal: controller.signal });
        }
        var change = null, cannotProve = false;
        if (refreshing && snapshot) {
          try { change = await archive.changes(snapshot, next, { nodes: graph.nodes, signal: controller.signal, matches: function (v) {
            return v.doc.kind === selectedMetric && v.doc.date >= answer.startDate && v.doc.date <= answer.endDate && v.doc.companies.some(function (id) { return scope.has(id); });
          } }); } catch (error) { if (controller.signal.aborted) throw error; cannotProve = true; }
        }
        if (controller.signal.aborted) return;
        snapshot = next; result = answer; baseline = previous; aggregateKey = selectedKey;
        data = { minDate: minDate, maxDate: maxDate, collectedAt: next.collected_at, generatedAt: next.generated_at,
          queriesOK: next.coverage.queries_ok, queriesTotal: next.coverage.queries_total, partial: next.coverage.partial, note: next.coverage.note };
        if (!samePublished || !refreshing) {
          recentChange = change;
          if (!samePublished) {
            observedCompanies.clear();
            graph.nodes.forEach(function (n) { n.g.classList.remove("observed-recent"); });
          }
        }
        if (first || refreshing) checkedAt = Date.now();
        failed = rollback = false; unproven = cannotProve;
        if (first) ui.date.value = day;
        ui.date.min = ui.date.value < minDate ? ui.date.value : minDate; ui.date.max = ui.date.value > maxDate ? ui.date.value : maxDate;
        ui.date.disabled = false; ui.days.disabled = playing; ui.mode.options[1].disabled = false;
        var selected = graph.getShown();
        if (first && !modeChosen && initialState.mode === "news") ui.mode.value = "news";
        if (first && !selected && !startChosen && ui.mode.value === "news" && graph.chooseNewsStart) graph.chooseNewsStart(result.byCompany);
        if (first && selected) { if (selected.type !== "company" && !(graph.isKnowledge && graph.isKnowledge())) ui.mode.value = "relations"; ui.active.checked = false; }
        render();
        if (first && graph.initialFit) graph.initialFit(!selected);
        else if (first && !selected) { if (graph.arrangeScope) graph.arrangeScope(); graph.fit(); }
        if (!first && refreshing) {
          if (!samePublished && change && change.total) pulseObserved();
          if (!change || !change.total) setState(cannotProve ? "신규 대조 미확인 · 강조 없음" : reason === "same-collection" ? "같은 수집본 · 새로 수집 확인 없음" : "게시본 확인 · 새 수집 시각이 확인된 출처 없음");
        }
      } catch (error) { if (!controller.signal.aborted) { failed = true; clearPulse(); updateNotice(); message(); renderActivity(); setState("확인 실패 · 직전 정상 집계 유지"); } }
      finally {
        request = null; loading = false; ui.refresh.disabled = false; ui.play.disabled = !data;
        if (pendingQuery && !document.hidden) { pendingQuery = false; loadArchive(false); }
        else { message(); renderActivity(); if (snapshot && aggregateKey !== selectionKey(snapshot) && !failed && !document.hidden) loadArchive(false); }
      }
    }
    async function refresh() {
      if (loading) return;
      if (!archive && document.documentElement && document.documentElement.dataset.newsArchive === "required") { failed = true; message(); return; }
      if (archive) { stop(); timelineWindow = null; updateNotice(); return loadArchive(true); }
      stop(); timelineWindow = null; updateNotice(); loading = true; ui.refresh.disabled = true; ui.play.disabled = true; request = new AbortController(); message();
      try {
        var incoming = MapNews.prepare(await NewsFeed.read({ signal: request.signal }), graph.nodes);
        if (!incoming.maxDate || incoming.queriesOK < 1) throw new Error("unconfirmed feed");
        var first = !data;
        var change = MapNews.diff(data, incoming); checkedAt = Date.now(); failed = false;
        rollback = change.reason === "rollback";
        if (rollback) { recentChange = change; updateNotice(); message(); setState("이전 게시본 · 직전 자료 유지"); return; }
        var changedSnapshot = first || change.reason !== "same-collection" || change.added.length || change.removed.length || change.updated.length;
        data = incoming;
        if (changedSnapshot) { recentChange = first ? null : change; observedCompanies.clear(); }
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
          if (changedSnapshot && change.newlyObserved.length) pulseObserved();
          if (!change.newlyObserved.length) setState(change.reason === "same-collection" ? "같은 수집본 · 새로 수집 확인 없음" : "게시본 확인 · 새 수집 시각이 확인된 출처 없음");
        }
      } catch (e) { if (!request.signal.aborted) { failed = true; message(); } }
      finally { request = null; loading = false; ui.refresh.disabled = false; ui.play.disabled = !data; message(); renderActivity(); }
    }
    ["mode", "metric", "scale", "highlight", "active", "days"].forEach(function (key) { if (!ui[key]) return; ui[key].addEventListener("change", function () {
      if (key === "mode") modeChosen = true;
      startChosen = true; queryChanged(); stop(); render();
    }); });
    ui.date.addEventListener("change", function () {
      dateChosen = startChosen = true;
      if (!validDate(ui.date.value) || data && (ui.date.value < ui.date.min || ui.date.value > ui.date.max)) { ui.date.value = data && data.maxDate || ""; }
      queryChanged(); stop(); render();
    });
    ui.play.addEventListener("click", play); ui.refresh.addEventListener("click", function () { watcher.check(); }); ui.fit.addEventListener("click", graph.fit);
    ui["new-date"].addEventListener("click", function () {
      var day = ui["new-date"].dataset.date;
      if (!data || !day) return;
      queryChanged(); stop("새 자료의 제공·접수 날짜 선택"); ui.date.value = day; render();
    });
    ui.motion.addEventListener("change", function () { stop("움직임 설정 변경"); render(); });
    function reduceChanged() { ui.motion.checked = reduced.matches; stop(); render(); }
    if (reduced.addEventListener) reduced.addEventListener("change", reduceChanged);
    document.addEventListener("visibilitychange", function () { if (document.hidden) stop("재생 정지 · 다른 화면으로 이동"); });
    window.addEventListener("pagehide", function () { stop(); });
    var watcher = NewsFeed.watch({ refresh: refresh, abort: function () { pendingQuery = false; if (request) request.abort(); }, shouldSkip: function () { return playing || loading; } });
    buildTimelineControls(); render(); watcher.check();
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
        var factor = graph.svg.classList.contains("overview") ? Math.max(1, .6 / k) : isNews() ? Math.max(1, .8 / k) : 1;
        graph.nodes.forEach(function (n) {
          if (n.type !== "company") return;
          n.drawR = graph.svg.classList.contains("overview") && !isNews() ? Math.max(n.r * factor, 3.2 / k) : n.r * factor;
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
      filterChanged: function () { startChosen = true; queryChanged(); stop(); render(); },
      visibilityChanged: function () {
        graph.nodes.forEach(function (n) { n.g.setAttribute("tabindex", n.visible ? "0" : "-1"); });
        var empty = document.getElementById("map-empty");
        if (empty) empty.hidden = !isNews() || graph.nodes.some(function (n) { return n.type === "company" && n.visible; });
      }
    };
  }};
})();
