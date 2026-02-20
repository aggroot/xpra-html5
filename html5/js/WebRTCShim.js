/*
 * WebRTC DataChannel shim for Xpra HTML5 client (main thread).
 *
 * This script MUST be loaded as the first <script> in index.html, before any
 * Xpra code runs. It intercepts the Protocol.js Web Worker creation and
 * bridges a MessagePort to the WebRTC DataChannel. The Worker-side shim
 * (WebRTCWorkerShim.js) patches self.WebSocket inside the Worker.
 *
 * Architecture:
 *   Browser main thread                    Protocol.js Worker
 *   ──────────────────                    ──────────────────
 *   DataChannel ↔ MessagePort(port1)  ↔  MessagePort(port2) ↔ patched WebSocket
 *
 * This keeps protocol encoding/decoding on the Worker thread (good perf)
 * while routing data through the WebRTC DataChannel (low latency P2P).
 *
 * DataChannel message framing (1-byte type prefix):
 *   0x00 = control (reset — agent relay closes server-side WS)
 *   0x01 = text message
 *   0x02 = binary message
 *   0x03 = chunk (more chunks follow — for messages exceeding SCTP max)
 *
 * Chunking: large messages are split into [0x03][data] chunks, with the
 * final chunk using the original type byte [0x01/0x02][data].
 *
 * Activation: WebRTC is opt-in via query parameter ?transport=webrtc.
 * Without it, the shim does nothing and Xpra uses a normal WebSocket.
 *
 * Session ID is extracted from the URL path: /session/{id}/xpra/...
 */
(function() {
  "use strict";

  // ── Activation gate ──────────────────────────────────────────────────

  var transport = new URLSearchParams(window.location.search).get("transport");
  if (transport !== "webrtc") {
    return;
  }

  // ── Configuration ────────────────────────────────────────────────────

  var MSG_TYPE_CONTROL = 0;
  var MSG_TYPE_TEXT = 1;
  var MSG_TYPE_BINARY = 2;
  var MSG_TYPE_CHUNK = 3;
  var DATACHANNEL_TIMEOUT = 15000;
  var ICE_GATHER_TIMEOUT = 5000;

  var pathMatch = window.location.pathname.match(/\/session\/([^/]+)\/xpra/);
  if (!pathMatch) {
    console.log("[WebRTCShim] Not in session context, skipping");
    return;
  }
  var SESSION_ID = pathMatch[1];
  console.log("[WebRTCShim] Session:", SESSION_ID, "transport: webrtc");

  // ── Shared state ─────────────────────────────────────────────────────

  var state = "setup";       // "setup" | "ready" | "failed"
  var retriesLeft = 1;       // one retry on mid-session DC failure
  var dataChannel = null;
  var peerConnection = null;
  var workerPort = null;     // MessagePort to Protocol.js Worker

  // ── Worker interception ──────────────────────────────────────────────
  // Intercept new Worker("js/Protocol.js") to inject a MessagePort bridge.
  // Other Workers (decode worker, etc.) pass through unmodified.

  var OriginalWorker = window.Worker;

  window.Worker = function(url, options) {
    var worker = new OriginalWorker(url, options);

    if (typeof url === "string" && url.indexOf("Protocol") !== -1 && state !== "failed") {
      console.log("[WebRTCShim] Intercepted Protocol Worker, setting up MessagePort bridge");

      var channel = new MessageChannel();
      workerPort = channel.port1;
      setupWorkerBridge(workerPort);

      // Transfer port2 to the Worker (received by WebRTCWorkerShim.js)
      worker.postMessage({__type: "webrtc-init"}, [channel.port2]);

      // Notify Worker of current state
      if (state === "ready" && dataChannel && dataChannel.readyState === "open") {
        workerPort.postMessage({type: "open"});
      }
      // Otherwise state is "setup" — Worker will wait for "open" or "fallback"
    }

    return worker;
  };
  window.Worker.prototype = OriginalWorker.prototype;

  // ── MessagePort ↔ DataChannel bridge ─────────────────────────────────

  function setupWorkerBridge(port) {
    port.onmessage = function(ev) {
      var msg = ev.data;
      switch (msg.type) {
        case "send":
          sendToDataChannel(msg.data);
          break;
        case "close":
          // Worker's WebSocket.close() — send reset control frame to agent
          if (dataChannel && dataChannel.readyState === "open") {
            try {
              dataChannel.send(new Uint8Array([MSG_TYPE_CONTROL]).buffer);
            } catch (e) { /* DC might be closing */ }
          }
          break;
      }
    };
  }

  function sendToDataChannel(data) {
    if (!dataChannel || dataChannel.readyState !== "open") return;

    var payload;
    if (typeof data === "string") {
      payload = new TextEncoder().encode(data);
      var frame = new Uint8Array(1 + payload.length);
      frame[0] = MSG_TYPE_TEXT;
      frame.set(payload, 1);
      dataChannel.send(frame.buffer);
    } else {
      // Binary data (ArrayBuffer or typed array)
      var src;
      if (data instanceof ArrayBuffer) {
        src = new Uint8Array(data);
      } else if (ArrayBuffer.isView(data)) {
        src = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      } else {
        src = new Uint8Array(data);
      }
      var frame = new Uint8Array(1 + src.length);
      frame[0] = MSG_TYPE_BINARY;
      frame.set(src, 1);
      try {
        dataChannel.send(frame.buffer);
      } catch (err) {
        console.error("[WebRTCShim] DC send failed:", err.message);
        handleFailure("send: " + err.message);
      }
    }
  }

  // ── Failure / fallback ───────────────────────────────────────────────

  function handleFailure(reason) {
    if (state === "failed") return;
    console.warn("[WebRTCShim] Failure:", reason, "state=" + state, "retriesLeft=" + retriesLeft);

    if (peerConnection) {
      try { peerConnection.close(); } catch (e) {}
      peerConnection = null;
    }
    dataChannel = null;

    if (state === "ready" && retriesLeft > 0) {
      // Mid-session failure — retry WebRTC immediately
      retriesLeft--;
      if (workerPort) workerPort.postMessage({type: "close", code: 1006, reason: reason});
      console.log("[WebRTCShim] Retrying WebRTC...");
      state = "setup";
      setupWebRTC();
    } else {
      // Initial setup failure or retry exhausted — give up
      state = "failed";
      if (workerPort) workerPort.postMessage({type: "fallback"});
      console.warn("[WebRTCShim] Falling back to WebSocket relay");
    }
  }

  // ── DataChannel event routing ────────────────────────────────────────

  function bindDataChannel(dc) {
    var chunkBuffer = []; // buffered chunk data for reassembly

    dc.addEventListener("message", function(ev) {
      if (!workerPort) return;

      var raw = new Uint8Array(ev.data);
      if (raw.length < 1) return;

      var msgType = raw[0];
      if (msgType === MSG_TYPE_CONTROL) return;

      if (msgType === MSG_TYPE_CHUNK) {
        // Non-final chunk — buffer and wait for more
        chunkBuffer.push(raw.slice(1));
        return;
      }

      // Final or complete message (TEXT or BINARY)
      var payload;
      if (chunkBuffer.length > 0) {
        // Reassemble chunked message
        chunkBuffer.push(raw.slice(1));
        var totalSize = 0;
        for (var i = 0; i < chunkBuffer.length; i++) {
          totalSize += chunkBuffer[i].length;
        }
        var assembled = new Uint8Array(totalSize);
        var offset = 0;
        for (var i = 0; i < chunkBuffer.length; i++) {
          assembled.set(chunkBuffer[i], offset);
          offset += chunkBuffer[i].length;
        }
        chunkBuffer = [];
        payload = assembled.buffer;
      } else {
        payload = raw.buffer.slice(1);
      }

      var data = (msgType === MSG_TYPE_TEXT)
        ? new TextDecoder().decode(payload)
        : payload;

      workerPort.postMessage({type: "message", data: data});
    });

    dc.addEventListener("close", function() {
      handleFailure("DataChannel closed");
    });

    dc.addEventListener("error", function() {
      handleFailure("DataChannel error");
    });
  }

  // ── WebRTC setup (async) ─────────────────────────────────────────────

  function generateClientID() {
    var arr = new Uint8Array(8);
    crypto.getRandomValues(arr);
    return Array.from(arr, function(b) {
      return b.toString(16).padStart(2, "0");
    }).join("");
  }

  async function setupWebRTC() {
    var clientID = generateClientID();

    try {
      // 1. Fetch STUN/TURN credentials
      var credResp = await fetch("/session/" + SESSION_ID + "/turn-credentials");
      if (!credResp.ok) throw new Error("TURN credentials HTTP " + credResp.status);
      var creds = await credResp.json();

      // 2. Create PeerConnection
      peerConnection = new RTCPeerConnection({
        iceServers: creds.iceServers || []
      });

      peerConnection.oniceconnectionstatechange = function() {
        if (peerConnection && peerConnection.iceConnectionState === "failed") {
          handleFailure("ICE connection failed");
        }
      };

      // 3. Create DataChannel (ordered — Xpra protocol is stateful)
      var dc = peerConnection.createDataChannel("xpra", { ordered: true });
      dc.binaryType = "arraybuffer";
      dataChannel = dc;

      // 4. Create offer and gather ICE candidates
      var offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      await new Promise(function(resolve) {
        if (peerConnection.iceGatheringState === "complete") {
          resolve();
          return;
        }
        peerConnection.onicecandidate = function(ev) {
          if (!ev.candidate) resolve();
        };
        setTimeout(resolve, ICE_GATHER_TIMEOUT);
      });

      if (state === "failed") return;

      // 5. Send offer via signaling endpoint
      var sigResp = await fetch("/session/" + SESSION_ID + "/signal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "offer",
          clientId: clientID,
          payload: peerConnection.localDescription
        })
      });
      if (!sigResp.ok) throw new Error("Signaling HTTP " + sigResp.status);
      var sigData = await sigResp.json();

      // 6. Set remote description (SDP answer from agent)
      await peerConnection.setRemoteDescription(sigData.payload);

      // 7. Wait for DataChannel to open
      if (dc.readyState !== "open") {
        await new Promise(function(resolve, reject) {
          var done = false;
          var timeout = setTimeout(function() {
            if (!done) { done = true; reject(new Error("DataChannel open timeout")); }
          }, DATACHANNEL_TIMEOUT);

          dc.onopen = function() {
            if (!done) { done = true; clearTimeout(timeout); resolve(); }
          };
          dc.onerror = function() {
            if (!done) { done = true; clearTimeout(timeout); reject(new Error("DataChannel setup error")); }
          };
        });
      }

      if (state === "failed") return;

      // 8. DataChannel is open — wire up event routing
      state = "ready";
      dc.onopen = null;
      dc.onerror = null;
      bindDataChannel(dc);

      if (peerConnection.sctp) {
        console.log("[WebRTCShim] SCTP maxMessageSize:", peerConnection.sctp.maxMessageSize);
      }
      console.log("[WebRTCShim] DataChannel open — WebRTC active");

      // Notify Worker that DC is ready
      if (workerPort) {
        workerPort.postMessage({type: "open"});
      }

    } catch (err) {
      handleFailure(err.message || String(err));
    }
  }

  setupWebRTC();
})();
