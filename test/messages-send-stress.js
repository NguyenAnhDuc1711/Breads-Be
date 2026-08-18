import http from "k6/http";
import { check, sleep, fail } from "k6";
import { Counter, Trend } from "k6/metrics";
import ws from "k6/ws";
import exec from "k6/execution";
import { buildSummaryFiles } from "./lib/handle-summary.js";

// ─── k6 stress test for Socket.IO messaging (sendMessage) ───────────────
//
// Socket.IO uses Engine.IO under the hood:
//   1. HTTP polling handshake → get session ID (sid)
//   2. Upgrade to WebSocket at /socket/?EIO=4&transport=websocket&sid=...
//   3. Exchange Engine.IO frames (0=open, 2=ping, 3=pong, 4=message)
//      + Socket.IO frames (0=connect, 2=event, 42=[event, payload])
//
// Usage (from project root):
//   docker run --rm -i --network host -w /test \
//     -e BASE_URL=http://host.docker.internal:8080 \
//     -e SENDER_JWT=<token> -e SENDER_ID=<id> \
//     -e RECIPIENT_ID=<id> \
//     -v "$(pwd)/test:/test" grafana/k6 run /test/messages-send-stress.js
//
// Simplified one-liner (with seed-test-users.js output):
//   CREDS=$(node test/scripts/seed-test-users.js)
//   docker run --rm -i --network host -w /test \
//     -e SENDER_JWT=$(echo $CREDS | jq -r .sender.accessToken) \
//     -e SENDER_ID=$(echo $CREDS | jq -r .sender.userId) \
//     -e RECIPIENT_ID=$(echo $CREDS | jq -r .recipient.userId) \
//     -v "$(pwd)/test:/test" grafana/k6 run /test/messages-send-stress.js
// ─────────────────────────────────────────────────────────────────────────

const TEST_NAME = "messages-send";

// ─── Configuration via env vars ─────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || "http://host.docker.internal:8080";
const SENDER_JWT = __ENV.SENDER_JWT || __ENV.JWT || "";
const SENDER_ID = __ENV.SENDER_ID || __ENV.USER_ID || "";
const RECIPIENT_ID = __ENV.RECIPIENT_ID || "";

// How many messages each VU sends per WebSocket session
const MSGS_PER_SESSION = parseInt(__ENV.MSGS_PER_SESSION || "15", 10);
// Pacing between messages in ms (~3.3 msg/s by default, under the 5/s rate limit)
const MSG_INTERVAL_MS = parseInt(__ENV.MSG_INTERVAL_MS || "300", 10);

// Derived URLs
const HTTP_BASE = BASE_URL.replace(/\/$/, "");
// Convert http(s):// to ws(s)://
const WS_BASE = HTTP_BASE.replace(/^http/, "ws");

// ─── Custom metrics ─────────────────────────────────────────────────────
const msgSent = new Counter("messages_sent");
const msgAcked = new Counter("messages_acked");
const msgFailed = new Counter("messages_failed");
const msgLatency = new Trend("message_latency", true); // in ms

// ─── k6 options ─────────────────────────────────────────────────────────
const VU_LEVELS = [10, 25, 50];
const levelThresholds = {};
for (const level of VU_LEVELS) {
  levelThresholds[`messages_sent{vu_level:${level}}`] = [];
  levelThresholds[`messages_acked{vu_level:${level}}`] = [];
  levelThresholds[`message_latency{vu_level:${level}}`] = [];
}

export const options = {
  scenarios: {
    // Scenario 1: Constant load — baseline
    constant_load: {
      executor: "constant-vus",
      vus: 10,
      duration: "30s",
      gracefulStop: "15s",
      tags: { scenario: "constant" },
    },
    // Scenario 2: Ramping load — stress
    ramp_up: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "15s", target: 10 },
        { duration: "30s", target: 25 },
        { duration: "20s", target: 50 },
        { duration: "15s", target: 50 }, // sustain peak
        { duration: "10s", target: 0 },  // cool down
      ],
      gracefulRampDown: "10s",
      startTime: "35s", // start after constant_load
      tags: { scenario: "ramp" },
    },
  },
  thresholds: {
    messages_sent: ["count>0"],
    messages_acked: ["count>0"],
    messages_failed: ["count<50"],
    message_latency: ["p(95)<3000", "avg<1000"],
    ...levelThresholds,
  },
};

// ─── Helpers ────────────────────────────────────────────────────────────
function currentVuLevel() {
  const active = exec.instance.vusActive;
  for (const level of VU_LEVELS) {
    if (active <= level) return String(level);
  }
  return String(VU_LEVELS[VU_LEVELS.length - 1]);
}

/**
 * Perform Engine.IO polling handshake to obtain a session ID.
 * GET /socket/?EIO=4&transport=polling
 * Response body: "0{\"sid\":\"xxx\",\"upgrades\":[\"websocket\"],...}"
 * (may be length-prefixed in EIO4: "NN:0{...}")
 */
function engineIOHandshake() {
  const url = `${HTTP_BASE}/socket/?EIO=4&transport=polling`;
  const res = http.get(url, {
    headers: { Cookie: `jwt=${SENDER_JWT}` },
    timeout: "10s",
    tags: { name: "engineio_handshake" },
  });

  if (res.status !== 200) {
    fail(`Engine.IO handshake HTTP ${res.status}: ${res.body}`);
  }

  const body = res.body;

  // Parse: body is either "0{...}" or length-prefixed "NN:0{...}"
  let jsonStr;
  const colonIdx = body.indexOf(":");
  if (colonIdx !== -1 && colonIdx < 10) {
    // Length-prefixed: skip "NN:0"
    jsonStr = body.substring(colonIdx + 2);
  } else if (body.startsWith("0")) {
    jsonStr = body.substring(1);
  } else {
    fail(`Unexpected Engine.IO handshake body: ${body.substring(0, 200)}`);
  }

  return JSON.parse(jsonStr);
}

// ─── Main VU function ───────────────────────────────────────────────────
export default function () {
  if (!SENDER_JWT) {
    console.error("SENDER_JWT (or JWT) env var is required. Aborting VU.");
    sleep(5);
    return;
  }
  if (!RECIPIENT_ID) {
    console.error("RECIPIENT_ID env var is required. Aborting VU.");
    sleep(5);
    return;
  }

  // Step 1: Engine.IO polling handshake to get SID
  const handshake = engineIOHandshake();
  const sid = handshake.sid;
  const pingInterval = handshake.pingInterval || 25000;

  // Step 2: Upgrade to WebSocket
  const wsUrl = `${WS_BASE}/socket/?EIO=4&transport=websocket&sid=${sid}`;

  const res = ws.connect(wsUrl, { headers: { Cookie: `jwt=${SENDER_JWT}` } }, function (socket) {
    let connected = false;
    const pendingAcks = {}; // ackId -> startTimestamp
    let nextAckId = 0;
    let sentCount = 0;
    let sendIntervalHandle = null;

    // ── Engine.IO: send upgrade probe ──
    socket.send("2probe");

    socket.on("message", function (rawData) {
      const data = String(rawData);

      // Engine.IO probe ack → complete upgrade
      if (data === "3probe") {
        socket.send("5"); // upgrade complete
        return;
      }

      // Engine.IO ping → pong
      if (data === "2") {
        socket.send("3");
        return;
      }

      // Engine.IO noop (post-upgrade)
      if (data === "6") {
        return;
      }

      // Socket.IO messages are Engine.IO type "4" (message)
      if (!data.startsWith("4")) {
        return;
      }

      const sioPayload = data.substring(1);

      // Socket.IO connect ack: "0" or "0{...}"
      if (sioPayload.startsWith("0")) {
        connected = true;
        return;
      }

      // Socket.IO ack response: "3<ackId>[response_data]"
      // Example: "30[{\"status\":\"success\",\"data\":{...}}]"
      if (sioPayload.startsWith("3")) {
        const bracketIdx = sioPayload.indexOf("[");
        if (bracketIdx === -1) return;

        const ackIdStr = sioPayload.substring(1, bracketIdx);
        const ackId = parseInt(ackIdStr, 10);
        if (isNaN(ackId) || !pendingAcks[ackId]) return;

        const elapsed = Date.now() - pendingAcks[ackId];
        const vuLevel = currentVuLevel();
        delete pendingAcks[ackId];

        try {
          const ackBody = JSON.parse(sioPayload.substring(bracketIdx));
          const response = Array.isArray(ackBody) ? ackBody[0] : ackBody;

          if (response && response.status === "success") {
            msgAcked.add(1, { vu_level: vuLevel });
            msgLatency.add(elapsed, { vu_level: vuLevel });
          } else {
            msgFailed.add(1, { vu_level: vuLevel });
          }
        } catch (_e) {
          // Got an ack but couldn't parse — still count it
          msgAcked.add(1, { vu_level: vuLevel });
          msgLatency.add(elapsed, { vu_level: vuLevel });
        }
        return;
      }

      // Socket.IO event from server: "2[\"event_name\", ...data]"
      // (incoming messages from other users — we just ignore during stress test)
    });

    socket.on("error", function (e) {
      console.error(`[VU ${__VU}] WS error: ${e}`);
    });

    // ── Wait for connection, then send Socket.IO connect + auth ──
    socket.setTimeout(function () {
      if (!connected) {
        // Send Socket.IO connect with auth token in the handshake payload
        socket.send(`40{"token":"${SENDER_JWT}"}`);
      }
    }, 300);

    // ── Start sending messages after a brief pause for connect ack ──
    socket.setTimeout(function () {
      sendIntervalHandle = socket.setInterval(function () {
        if (sentCount >= MSGS_PER_SESSION) {
          // All messages sent, wait a moment for remaining acks then close
          socket.setTimeout(function () {
            socket.close();
          }, 2000);
          // Clear the send interval by closing on the next tick
          return;
        }

        const ackId = nextAckId++;
        const vuLevel = currentVuLevel();
        const now = Date.now();

        // Socket.IO event with acknowledgement:
        //   "42<ackId>[\"<event_name>\", <payload>]"
        // Event: "/messages/create" (Route.MESSAGE + MESSAGE_PATH.CREATE)
        const payload = {
          recipientId: RECIPIENT_ID,
          message: {
            content: `[k6] VU${__VU} iter${__ITER} #${sentCount} t${now}`,
          },
        };

        const frame = `42${ackId}["/messages/create",${JSON.stringify(payload)}]`;

        pendingAcks[ackId] = now;
        socket.send(frame);
        msgSent.add(1, { vu_level: vuLevel });
        sentCount++;
      }, MSG_INTERVAL_MS);
    }, 1500);

    // ── Keep-alive: Engine.IO pings ──
    socket.setInterval(function () {
      socket.send("2");
    }, Math.floor(pingInterval * 0.8));

    // ── Safety timeout: auto-close WebSocket ──
    socket.setTimeout(function () {
      socket.close();
    }, MSGS_PER_SESSION * MSG_INTERVAL_MS + 8000);
  });

  check(res, {
    "WebSocket upgraded (101)": (r) => r && r.status === 101,
  });

  // Brief pause between iterations to avoid thundering herd on reconnect
  sleep(Math.random() * 2 + 0.5);
}

// ─── Summary ────────────────────────────────────────────────────────────
export function handleSummary(data) {
  return buildSummaryFiles(data, TEST_NAME);
}
