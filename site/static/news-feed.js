/* One bounded request for the public headline snapshot. No polling or storage. */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.NewsFeed = factory();
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  var MAX_BYTES = 1048576, TIMEOUT_MS = 10000;
  async function read(options) {
    options = options || {};
    var signal = options.signal, controller = new AbortController(), reader = null, complete = false;
    var timeout = null, abortListener = null;
    function abort() { controller.abort(); }
    function bounded(pending) {
      return new Promise(function (resolve, reject) {
        function cleanup() { controller.signal.removeEventListener("abort", fail); }
        function fail() { cleanup(); reject(new Error("feed aborted")); }
        Promise.resolve(pending).then(function (value) { cleanup(); resolve(value); }, function (error) { cleanup(); reject(error); });
        if (controller.signal.aborted) { fail(); return; }
        controller.signal.addEventListener("abort", fail, { once: true });
      });
    }
    try {
      if (signal) {
        if (signal.aborted) throw new Error("feed aborted");
        abortListener = abort;
        signal.addEventListener("abort", abortListener, { once: true });
      }
      timeout = setTimeout(abort, TIMEOUT_MS);
      var response = await bounded(fetch("./news-feed.json", { cache: "no-store", credentials: "omit", signal: controller.signal }));
      if (!response.ok) throw new Error("feed response");
      if (!response.body || typeof response.body.getReader !== "function") throw new Error("feed stream unavailable");
      reader = response.body.getReader();
      var advertised = response.headers.get("content-length");
      if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > MAX_BYTES)) throw new Error("feed size");
      // A fixed buffer also bounds memory when a response sends tiny chunks.
      var bytes = new Uint8Array(MAX_BYTES), size = 0;
      while (true) {
        if (controller.signal.aborted) throw new Error("feed aborted");
        var part = await bounded(reader.read());
        if (part.done) break;
        if (!(part.value instanceof Uint8Array)) throw new Error("feed bytes");
        if (size + part.value.byteLength > MAX_BYTES) throw new Error("feed size");
        bytes.set(part.value, size); size += part.value.byteLength;
      }
      if (controller.signal.aborted) throw new Error("feed aborted");
      var parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
      complete = true;
      return parsed;
    } finally {
      clearTimeout(timeout);
      if (signal && abortListener) signal.removeEventListener("abort", abortListener);
      if (!complete) {
        controller.abort();
        // Cleanup must not extend the request deadline if a stream is stalled.
        if (reader) { try { Promise.resolve(reader.cancel()).catch(function () {}); } catch (_) {} }
      }
      if (reader) { try { reader.releaseLock(); } catch (_) {} }
    }
  }
  return { read: read };
});
