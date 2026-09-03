import http from "k6/http";
import { check, sleep, fail } from "k6";
import { Counter, Trend } from "k6/metrics";
import ws from "k6/ws";
import exec from "k6/execution";
import { buildSummaryFiles } from "./lib/handle-summary.js";

const TEST_NAME = "messages-send";

const BASE_URL = __ENV.BASE_URL || "http://host.docker.internal:8080";
const SENDER_JWT = __ENV.SENDER_JWT || __ENV.JWT || "";
const SENDER_ID = __ENV.SENDER_ID || __ENV.USER_ID || "";
const RECIPIENT_ID = __ENV.RECIPIENT_ID || "";

const MSGS_PER_SESSION = parseInt(__ENV.MSGS_PER_SESSION || "15", 10);
const MSG_INTERVAL_MS = parseInt(__ENV.MSG_INTERVAL_MS || "300", 10);

const HTTP_BASE = BASE_URL.replace(/\/$/, "");
const WS_BASE = HTTP_BASE.replace(/^http/, "ws");

const msgSent = new Counter("messages_sent");
const msgAcked = new Counter("messages_acked");
const msgFailed = new Counter("messages_failed");
const msgLatency = new Trend("message_latency", true);

const VU_LEVELS = [10, 25, 50];
const levelThresholds = {};
for (const level of VU_LEVELS) {
  levelThresholds[`messages_sent{vu_level:${level}}`] = [];
  levelThresholds[`messages_acked{vu_level:${level}}`] = [];
  levelThresholds[`message_latency{vu_level:${level}}`] = [];
}

export const options = {
  scenarios: {
    constant_load: {
      executor: "constant-vus",
      vus: 10,
      duration: "30s",
      gracefulStop: "15s",
      tags: { scenario: "constant" },
    },
    ramp_up: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "15s", target: 10 },
        { duration: "30s", target: 25 },
        { duration: "20s", target: 50 },
        { duration: "15s", target: 50 },
        { duration: "10s", target: 0 },
      ],
      gracefulRampDown: "10s",
      startTime: "35s",
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

function currentVuLevel() {
  const active = exec.instance.vusActive;
  for (const level of VU_LEVELS) {
    if (active <= level) return String(level);
  }
  return String(VU_LEVELS[VU_LEVELS.length - 1]);
}

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

  let jsonStr;
  const colonIdx = body.indexOf(":");
  if (colonIdx !== -1 && colonIdx < 10) {
    jsonStr = body.substring(colonIdx + 2);
  } else if (body.startsWith("0")) {
    jsonStr = body.substring(1);
  } else {
    fail(`Unexpected Engine.IO handshake body: ${body.substring(0, 200)}`);
  }

  return JSON.parse(jsonStr);
}

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

  const handshake = engineIOHandshake();
  const sid = handshake.sid;
  const pingInterval = handshake.pingInterval || 25000;

  const wsUrl = `${WS_BASE}/socket/?EIO=4&transport=websocket&sid=${sid}`;

  const res = ws.connect(wsUrl, { headers: { Cookie: `jwt=${SENDER_JWT}` } }, function (socket) {
    let connected = false;
    const pendingAcks = {};
    let nextAckId = 0;
    let sentCount = 0;
    let sendIntervalHandle = null;

    socket.send("2probe");

    socket.on("message", function (rawData) {
      const data = String(rawData);

      if (data === "3probe") {
        socket.send("5");
        return;
      }

      if (data === "2") {
        socket.send("3");
        return;
      }

      if (data === "6") {
        return;
      }

      if (!data.startsWith("4")) {
        return;
      }

      const sioPayload = data.substring(1);

      if (sioPayload.startsWith("0")) {
        connected = true;
        return;
      }

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
          msgAcked.add(1, { vu_level: vuLevel });
          msgLatency.add(elapsed, { vu_level: vuLevel });
        }
        return;
      }

    });

    socket.on("error", function (e) {
      console.error(`[VU ${__VU}] WS error: ${e}`);
    });

    socket.setTimeout(function () {
      if (!connected) {
        socket.send(`40{"token":"${SENDER_JWT}"}`);
      }
    }, 300);

    socket.setTimeout(function () {
      sendIntervalHandle = socket.setInterval(function () {
        if (sentCount >= MSGS_PER_SESSION) {
          socket.setTimeout(function () {
            socket.close();
          }, 2000);
          return;
        }

        const ackId = nextAckId++;
        const vuLevel = currentVuLevel();
        const now = Date.now();

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

    socket.setInterval(function () {
      socket.send("2");
    }, Math.floor(pingInterval * 0.8));

    socket.setTimeout(function () {
      socket.close();
    }, MSGS_PER_SESSION * MSG_INTERVAL_MS + 8000);
  });

  check(res, {
    "WebSocket upgraded (101)": (r) => r && r.status === 101,
  });

  sleep(Math.random() * 2 + 0.5);
}

export function handleSummary(data) {
  return buildSummaryFiles(data, TEST_NAME);
}
