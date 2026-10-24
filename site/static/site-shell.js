/* Shared user-purpose navigation for the static views. It never claims a live server is connected. */
(function (root) {
  "use strict";
  function element(tag, text) {
    var node = root.document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function active(path) {
    if (path.indexOf("news.html") >= 0) return "today";
    if (path.indexOf("companies.html") >= 0) return "catalog";
    if (path.indexOf("watchlist.html") >= 0) return "watchlist";
    if (path.indexOf("map.html") >= 0) return "map";
    return "";
  }
  function mount() {
    if (!root.document || root.document.querySelector(".purpose-nav")) return;
    var header = root.document.querySelector("header"), current = header && header.querySelector("nav");
    if (!header || !current) return;
    var nav = element("nav"); nav.className = "purpose-nav"; nav.setAttribute("aria-label", "주요 흐름");
    var currentKey = active(root.location && root.location.pathname || "");
    [
      ["today", "오늘의 흐름", "./news.html"],
      ["map", "기업 지도", "./map.html?view=knowledge&scope=all"],
      ["catalog", "기업·테마", "./companies.html"],
      ["watchlist", "관심 목록", "./watchlist.html"]
    ].forEach(function (item) {
      var link = element("a", item[1]); link.href = item[2]; link.target = "_top";
      if (item[0] === currentKey) { link.setAttribute("aria-current", "page"); link.className = "current"; }
      nav.appendChild(link);
    });
    current.setAttribute("aria-label", "상세 탐색"); current.classList.add("secondary-nav");
    current.parentNode.insertBefore(nav, current);
    var style = element("style");
    style.textContent = ".purpose-nav{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;order:-1}.purpose-nav a{font-weight:650;text-underline-offset:3px}.purpose-nav a.current{font-weight:800;text-decoration-thickness:2px}.secondary-nav{opacity:.86}.shell-status{width:100%;margin:0;color:inherit;opacity:.72;font-size:.75rem;order:4}.shell-status::before{content:'● ';color:#b97812}@media(prefers-color-scheme:dark){.shell-status::before{color:#e2ad55}}";
    header.appendChild(style);
    var status = element("p", "공개 정적 자료 · 실시간 연결 준비 중");
    status.className = "shell-status"; status.setAttribute("role", "status");
    status.title = "현재 화면은 공개 snapshot을 사용합니다. 실시간 서버에 연결된 상태로 표시하지 않습니다.";
    header.appendChild(status);
  }
  if (root.document) root.document.addEventListener("DOMContentLoaded", mount, { once: true });
  if (typeof module === "object" && module.exports) module.exports = { mount: mount, active: active };
})(typeof window !== "undefined" ? window : globalThis);
