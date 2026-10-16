/* Shared GA4 page views for the three standalone public screens. */
(function () {
  "use strict";
  var page;
  try {
    page = new URL(window.location.href);
    if (window.self !== window.top || page.origin !== "https://betago83.github.io"
      || page.username || page.password
      || !/^\/BetaGo83\/static\/(?:map|news|documents)\.html$/.test(page.pathname)) return;
  } catch (_) { return; }
  if (window.__betago83AnalyticsStarted) return;
  window.__betago83AnalyticsStarted = true;

  function start() {
    // Keep only the referring origin; never pass its path, query, or fragment.
    var referrer = "";
    try {
      var source = new URL(document.referrer);
      if (source.protocol === "https:" || source.protocol === "http:") referrer = source.origin + "/";
    } catch (_) { /* A direct visit has no referrer. */ }
    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
    window.gtag("js", new Date());
    // config sends one default page_view. Do not also send a manual page_view.
    // Filter/search/query values are deliberately absent from page_location.
    window.gtag("config", "G-7N54PH33TH", {
      page_title: document.title,
      page_location: page.origin + page.pathname,
      page_referrer: referrer
    });
    var script = document.createElement("script");
    script.async = true;
    script.referrerPolicy = "origin";
    script.src = "https://www.googletagmanager.com/gtag/js?id=G-7N54PH33TH";
    document.head.appendChild(script);
  }
  // The map sets its fixed screen title in its earlier DOMContentLoaded handler.
  if (document.readyState === "complete") start();
  else window.addEventListener("DOMContentLoaded", start, { once: true });
})();
