/*
 * WebRTC Worker-side shim for Xpra HTML5 client.
 *
 * This script runs inside the Protocol.js Web Worker (imported via
 * importScripts before Protocol.js). It patches self.WebSocket so that
 * the Worker's XpraProtocol uses a MessagePort bridge to the main thread
 * instead of a real WebSocket. The main thread bridges the MessagePort
 * to the WebRTC DataChannel.
 *
 * Port message protocol (Worker ↔ main thread):
 *   Main → Worker:
 *     {type: "open"}              DataChannel is open, activate shim
 *     {type: "message", data}     Data received from DataChannel
 *     {type: "close", code, reason}  DataChannel closed (retry pending)
 *     {type: "fallback"}          WebRTC failed, use real WebSocket
 *   Worker → Main:
 *     {type: "send", data}        Send data to DataChannel
 *     {type: "close", code, reason}  WebSocket.close() called
 */
(function() {
  "use strict";

  // Only run in Worker context
  if (typeof window !== "undefined") return;

  var OriginalWebSocket = self.WebSocket;
  var dcPort = null;
  var shimState = "waiting"; // "waiting" | "ready" | "failed"
  var activeShim = null;
  var pendingShim = null;

  // ── Intercept port transfer from main thread ──────────────────────
  // This listener is added before Protocol.js's listener, so it fires
  // first and can stop propagation for our init message.

  self.addEventListener("message", function(e) {
    if (!e.data || e.data.__type !== "webrtc-init") return;
    e.stopImmediatePropagation();

    dcPort = e.ports[0];
    shimState = "waiting";
    console.log("[WebRTCWorkerShim] Port received from main thread");

    dcPort.onmessage = function(ev) {
      var msg = ev.data;
      switch (msg.type) {
        case "open":
          console.log("[WebRTCWorkerShim] DataChannel open");
          shimState = "ready";
          if (pendingShim) {
            activateShim(pendingShim);
          }
          break;

        case "message":
          if (activeShim && activeShim.readyState === 1) {
            fireListeners(activeShim, "message", {
              type: "message", data: msg.data
            });
          }
          break;

        case "close":
          console.log("[WebRTCWorkerShim] DataChannel closed, code=" + msg.code);
          shimState = "waiting";
          if (activeShim) fireClose(activeShim, msg.code || 1006, msg.reason || "");
          if (pendingShim) fireClose(pendingShim, msg.code || 1006, msg.reason || "");
          break;

        case "fallback":
          console.warn("[WebRTCWorkerShim] Falling back to real WebSocket");
          shimState = "failed";
          self.WebSocket = OriginalWebSocket;
          if (activeShim) fireClose(activeShim, 1006, "WebRTC fallback");
          if (pendingShim) fireClose(pendingShim, 1006, "WebRTC fallback");
          break;
      }
    };
  });

  // ── Event helpers ─────────────────────────────────────────────────

  function fireListeners(shim, type, ev) {
    var handler = shim["on" + type];
    if (handler) {
      try { handler.call(shim, ev); } catch (e) {
        console.error("[WebRTCWorkerShim]", type, "handler error:", e);
      }
    }
    var arr = shim._listeners[type];
    if (!arr) return;
    for (var i = 0; i < arr.length; i++) {
      try { arr[i].call(shim, ev); } catch (e) {
        console.error("[WebRTCWorkerShim]", type, "listener error:", e);
      }
    }
  }

  function fireClose(shim, code, reason) {
    if (shim.readyState === 3) return;
    shim.readyState = 3;
    if (activeShim === shim) activeShim = null;
    if (pendingShim === shim) pendingShim = null;
    fireListeners(shim, "close", {
      type: "close", code: code, reason: reason, wasClean: (code === 1000)
    });
  }

  function activateShim(shim) {
    if (activeShim && activeShim !== shim) {
      fireClose(activeShim, 1000, "replaced");
    }
    if (pendingShim === shim) pendingShim = null;
    activeShim = shim;
    shim.readyState = 1; // OPEN

    // Fire open async — Protocol.js sets listeners after constructor returns
    setTimeout(function() {
      if (activeShim !== shim) return;
      fireListeners(shim, "open", { type: "open" });
    }, 0);
  }

  // ── WorkerDataChannelWebSocket ────────────────────────────────────

  function WorkerDataChannelWebSocket(url, protocols) {
    if (shimState === "failed" || !dcPort) {
      console.log("[WebRTCWorkerShim] new WebSocket() → real WebSocket (state=" + shimState + " port=" + !!dcPort + ")");
      return new OriginalWebSocket(url, protocols);
    }

    console.log("[WebRTCWorkerShim] new WebSocket() → DataChannel shim (state=" + shimState + ")");

    this.url = url;
    this.protocol = (typeof protocols === "string")
      ? protocols
      : (protocols && protocols[0]) || "";
    this.extensions = "";
    this.binaryType = "arraybuffer";
    this.bufferedAmount = 0;
    this.readyState = 0; // CONNECTING

    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this._listeners = {};

    if (shimState === "ready") {
      activateShim(this);
    } else {
      if (pendingShim) {
        fireClose(pendingShim, 1006, "superseded");
      }
      pendingShim = this;
    }
  }

  WorkerDataChannelWebSocket.CONNECTING = 0;
  WorkerDataChannelWebSocket.OPEN = 1;
  WorkerDataChannelWebSocket.CLOSING = 2;
  WorkerDataChannelWebSocket.CLOSED = 3;

  WorkerDataChannelWebSocket.prototype.send = function(data) {
    if (this !== activeShim || shimState !== "ready") {
      throw new DOMException("WebSocket is not open", "InvalidStateError");
    }
    dcPort.postMessage({type: "send", data: data});
  };

  WorkerDataChannelWebSocket.prototype.close = function(code, reason) {
    if (this.readyState >= 2) return;
    this.readyState = 2; // CLOSING

    if (this === activeShim && dcPort) {
      dcPort.postMessage({type: "close", code: code || 1000, reason: reason || ""});
    }

    if (this === activeShim) activeShim = null;
    if (this === pendingShim) pendingShim = null;

    var self_shim = this;
    setTimeout(function() {
      fireClose(self_shim, code || 1000, reason || "");
    }, 0);
  };

  WorkerDataChannelWebSocket.prototype.addEventListener = function(type, fn) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(fn);
  };

  WorkerDataChannelWebSocket.prototype.removeEventListener = function(type, fn) {
    var arr = this._listeners[type];
    if (!arr) return;
    this._listeners[type] = arr.filter(function(f) { return f !== fn; });
  };

  WorkerDataChannelWebSocket.prototype.dispatchEvent = function(ev) {
    fireListeners(this, ev.type, ev);
    return true;
  };

  // ── Patch WebSocket in Worker scope ───────────────────────────────

  self.WebSocket = WorkerDataChannelWebSocket;
  self.WebSocket.CONNECTING = 0;
  self.WebSocket.OPEN = 1;
  self.WebSocket.CLOSING = 2;
  self.WebSocket.CLOSED = 3;

  console.log("[WebRTCWorkerShim] Worker WebSocket patched");
})();
