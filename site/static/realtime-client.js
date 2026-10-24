/* Opt-in EventSource client. Loading this file never opens a connection. */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory({});
  else root.BetaGoRealtime = factory(root);
})(typeof window !== "undefined" ? window : globalThis, function (root) {
  "use strict";
  var MAX_QUEUE = 500;

  function create(options) {
    options = options || {};
    var source = null, paused = false, queue = [], state = "idle", lastEventId = "";
    var onEvent = typeof options.onEvent === "function" ? options.onEvent : function () {};
    var onStatus = typeof options.onStatus === "function" ? options.onStatus : function () {};
    var onSnapshotRequired = typeof options.onSnapshotRequired === "function" ? options.onSnapshotRequired : function () {};

    function report(next, extra) {
      state = next;
      try { onStatus(Object.assign({ state: state, queued: queue.length, lastEventId: lastEventId }, extra || {})); } catch (_) {}
    }
    function configuredURL() { return typeof options.url === "string" && /^https?:\/\/[^\s]+$/i.test(options.url); }
    function deliver(data, event) {
      if (paused) {
        if (queue.length >= MAX_QUEUE) { report("queue_limit"); return; }
        queue.push({ data: data, event: event });
        report("paused");
        return;
      }
      try { onEvent(data, event); } catch (_) { report("handler_error"); }
    }
    function material(event) {
      var data;
      try { data = JSON.parse(event.data || "{}"); } catch (_) { report("protocol_error"); return; }
      if (!data || typeof data !== "object" || Array.isArray(data)) { report("protocol_error"); return; }
      if (event.lastEventId) lastEventId = event.lastEventId;
      deliver(data, event);
    }
    function snapshotRequired(event) {
      report("snapshot_required");
      try { onSnapshotRequired(event); } catch (_) {}
    }
    function connect() {
      if (source) return false;
      if (!configuredURL()) { report("invalid_url"); return false; }
      if (!root || typeof root.EventSource !== "function") { report("unsupported"); return false; }
      try {
        report("connecting"); source = new root.EventSource(options.url);
        source.addEventListener("material", material);
        source.addEventListener("snapshot_required", snapshotRequired);
        source.onopen = function () { report("connected"); };
        source.onerror = function () { report("reconnecting"); };
        return true;
      } catch (_) { source = null; report("connect_error"); return false; }
    }
    function pause() { paused = true; report("paused"); return queue.length; }
    function resume() {
      paused = false;
      var pending = queue.splice(0);
      pending.forEach(function (item) { deliver(item.data, item.event); });
      report(source ? "connected" : "idle");
      return pending.length;
    }
    function close() {
      if (source && typeof source.close === "function") source.close();
      source = null; report("closed");
    }
    return {
      connect: connect, pause: pause, resume: resume, close: close,
      state: function () { return state; }, queued: function () { return queue.length; },
      lastEventId: function () { return lastEventId; }, maxQueue: MAX_QUEUE
    };
  }
  return { create: create };
});
