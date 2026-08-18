import http from "k6/http";
import { check, sleep, fail } from "k6";
import { Counter, Trend } from "k6/metrics";
import ws from "k6/ws";
import encoding from "k6/encoding";
import { buildSummaryFiles } from "./lib/handle-summary.js";

// ─── Epic presigned-media-upload — Task 004: baseline TRƯỚC cutover ─────
//
// Đo 3 chỉ số của luồng base64-relay HIỆN TẠI (trước khi task 010/011 xoá code cũ), ở đúng 2 mức
// kích thước đã chốt (epic.md, plan-review round 2 TEST-3):
//   - message/socket (sendMessage): DƯỚI 1MB — path này KHÔNG THỂ hoàn thành ở kích thước lớn hơn,
//     chính là bug gốc do `maxHttpBufferSize` (Socket.IO, mặc định ~1MB, chưa từng override).
//   - post/REST (createPost): 4-11MB — path này CHẠY ĐƯỢC hiện tại (express.json limit 50mb).
//
// 3 chỉ số:
//   1. Bandwidth ingress+egress — k6 tự động track qua `data_sent`/`data_received` (built-in
//      metric, cộng dồn toàn bộ traffic của VU, bao gồm cả WebSocket frame lẫn HTTP request/response
//      — không cần tự đo thủ công).
//   2. Time-to-URL — custom Trend, đo từ lúc gửi request tới lúc nhận response chứa URL Cloudinary
//      (socket: ack callback; REST: response body).
//   3. Peak RAM (RSS) của Breads-Be process — k6 KHÔNG đo được (chạy trong container/VU riêng,
//      không có quyền truy cập process của server). Phải đo bằng script ngoài chạy song song, xem
//      `test/scripts/sample-rss.sh` — SAMPLE USAGE ở cuối file comment này.
//
// Usage (giống `messages-send-stress.js`, cộng biến FIXTURE):
//   # Terminal 1 — chạy song song để lấy RSS (peak RAM), thay <PID> bằng PID thật của process Breads-Be:
//   ./test/scripts/sample-rss.sh <PID> > test/results/$(date -u +%Y-%m-%dT%H-%M-%SZ)__media-bench-rss.log
//
//   # Terminal 2 — chạy benchmark:
//   CREDS=$(node test/scripts/seed-test-users.js)
//   docker run --rm -i --network host -w /test \
//     -e SENDER_JWT=$(echo $CREDS | jq -r .sender.accessToken) \
//     -e SENDER_ID=$(echo $CREDS | jq -r .sender.userId) \
//     -e RECIPIENT_ID=$(echo $CREDS | jq -r .recipient.userId) \
//     -v "$(pwd)/test:/test" grafana/k6 run /test/media-upload-bench.js
//
// Điều kiện đo (ghi kèm khi báo cáo, vì repo này đã có tiền lệ nhiễu đo cao giữa 2 lần chạy —
// xem `test/results/`): chạy đủ VU_ITERATIONS lần/kịch bản, lấy `avg` VÀ `p(95)`/`med` từ report
// (không chỉ 1 số), ghi rõ máy đo (dev laptop hay CI) khi so sánh với task 020 (đo sau cutover).
// ─────────────────────────────────────────────────────────────────────────

const TEST_NAME = "media-upload-bench";

// ─── Configuration via env vars ─────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || "http://host.docker.internal:8080";
const SENDER_JWT = __ENV.SENDER_JWT || __ENV.JWT || "";
const SENDER_ID = __ENV.SENDER_ID || __ENV.USER_ID || "";
const RECIPIENT_ID = __ENV.RECIPIENT_ID || "";

// Số lần lặp mỗi kịch bản — cố định (không phải load test, đây là benchmark so sánh trước/sau, cần
// số lần chạy giống hệt nhau ở task 020 để so sánh công bằng).
const ITERATIONS = parseInt(__ENV.ITERATIONS || "10", 10);

const HTTP_BASE = BASE_URL.replace(/\/$/, "");
const WS_BASE = HTTP_BASE.replace(/^http/, "ws");

// ─── Fixture ảnh — đọc lúc init (open() chỉ dùng được ở init phase) ─────
// sample-media.png (<1MB) cho path message/socket; sample-media-large.png (4-11MB) cho path
// post/REST. Cả 2 do task 004 tự sinh (fixture gốc `sample-media.b64` cũ không có sẵn trong working
// tree lúc viết script này — xem handoff note).
const MESSAGE_IMG_BYTES = open("./fixtures/sample-media.png", "b");
const POST_IMG_BYTES = open("./fixtures/sample-media-large.png", "b");
const MESSAGE_DATA_URI = `data:image/png;base64,${encoding.b64encode(MESSAGE_IMG_BYTES)}`;
const POST_DATA_URI = `data:image/png;base64,${encoding.b64encode(POST_IMG_BYTES)}`;

// ─── Custom metrics ─────────────────────────────────────────────────────
const msgSent = new Counter("media_message_sent");
const msgAcked = new Counter("media_message_acked");
const msgFailed = new Counter("media_message_failed");
const msgLatency = new Trend("media_message_time_to_url", true); // ms

const postSent = new Counter("media_post_sent");
const postOk = new Counter("media_post_ok");
const postFailed = new Counter("media_post_failed");
const postLatency = new Trend("media_post_time_to_url", true); // ms

// ─── k6 options ─────────────────────────────────────────────────────────
export const options = {
  scenarios: {
    // Path message/socket — ảnh <1MB, chạy đủ ITERATIONS lần bằng 1 VU (không phải load test).
    message_baseline: {
      executor: "shared-iterations",
      vus: 1,
      iterations: ITERATIONS,
      maxDuration: "2m",
      exec: "messageScenario",
      tags: { path: "message-socket" },
    },
    // Path post/REST — ảnh 4-11MB, chạy sau message_baseline (tránh 2 luồng chồng lấn làm nhiễu số
    // liệu bandwidth).
    post_baseline: {
      executor: "shared-iterations",
      vus: 1,
      iterations: ITERATIONS,
      maxDuration: "3m",
      startTime: "20s",
      exec: "postScenario",
      tags: { path: "post-rest" },
    },
  },
  thresholds: {
    // Không đặt ngưỡng pass/fail — đây là benchmark ghi số liệu, không phải test chức năng (đúng
    // tinh thần "tham khảo, không phải gate" của toàn epic — xem PRD/epic.md Success Criteria).
    media_message_acked: ["count>=0"],
    media_post_ok: ["count>=0"],
  },
};

// ─── Scenario 1: message/socket (<1MB) ──────────────────────────────────
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

export function messageScenario() {
  if (!SENDER_JWT || !RECIPIENT_ID) {
    console.error("SENDER_JWT/RECIPIENT_ID env var required. Aborting VU.");
    sleep(2);
    return;
  }

  const handshake = engineIOHandshake();
  const sid = handshake.sid;
  const pingInterval = handshake.pingInterval || 25000;
  const wsUrl = `${WS_BASE}/socket/?EIO=4&transport=websocket&sid=${sid}`;

  const res = ws.connect(wsUrl, { headers: { Cookie: `jwt=${SENDER_JWT}` } }, function (socket) {
    let connected = false;
    let acked = false;
    const startedAt = { t: 0 };

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
      if (data === "6") return;
      if (!data.startsWith("4")) return;

      const sioPayload = data.substring(1);
      if (sioPayload.startsWith("0")) {
        connected = true;
        return;
      }
      if (sioPayload.startsWith("3")) {
        const bracketIdx = sioPayload.indexOf("[");
        if (bracketIdx === -1) return;
        const elapsed = Date.now() - startedAt.t;
        try {
          const ackBody = JSON.parse(sioPayload.substring(bracketIdx));
          const response = Array.isArray(ackBody) ? ackBody[0] : ackBody;
          if (response && response.status === "success") {
            msgAcked.add(1);
            msgLatency.add(elapsed);
          } else {
            msgFailed.add(1);
          }
        } catch (_e) {
          msgFailed.add(1);
        }
        acked = true;
        socket.close();
      }
    });

    socket.on("error", function (e) {
      console.error(`[media-bench] WS error: ${e}`);
    });

    socket.setTimeout(function () {
      if (!connected) {
        socket.send(`40{"token":"${SENDER_JWT}"}`);
      }
    }, 300);

    socket.setTimeout(function () {
      const payload = {
        recipientId: RECIPIENT_ID,
        message: {
          media: [{ url: MESSAGE_DATA_URI, type: "image" }],
        },
      };
      const frame = `420["/messages/create",${JSON.stringify(payload)}]`;
      startedAt.t = Date.now();
      socket.send(frame);
      msgSent.add(1);
    }, 800);

    // Safety timeout — nếu không ack trong 15s (đúng dải kích thước có thể timeout do
    // maxHttpBufferSize, dù fixture <1MB không nên gặp), đóng kết nối và tính là failed.
    socket.setTimeout(function () {
      if (!acked) {
        msgFailed.add(1);
      }
      socket.close();
    }, 15000);
  });

  check(res, { "WebSocket upgraded (101)": (r) => r && r.status === 101 });
  sleep(1);
}

// ─── Scenario 2: post/REST (4-11MB) ─────────────────────────────────────
export function postScenario() {
  if (!SENDER_JWT || !SENDER_ID) {
    console.error("SENDER_JWT/SENDER_ID env var required. Aborting VU.");
    sleep(2);
    return;
  }

  const payload = {
    authorId: SENDER_ID,
    content: `[media-bench] ${Date.now()}`,
    media: [{ url: POST_DATA_URI, type: "image" }],
    survey: [],
  };

  const start = Date.now();
  const res = http.post(`${HTTP_BASE}/posts/create`, JSON.stringify(payload), {
    headers: { "Content-Type": "application/json", Cookie: `jwt=${SENDER_JWT}` },
    timeout: "60s",
    tags: { name: "createPost_media" },
  });
  const elapsed = Date.now() - start;

  postSent.add(1);
  const ok = check(res, { "createPost 2xx": (r) => r.status >= 200 && r.status < 300 });
  if (ok) {
    postOk.add(1);
    postLatency.add(elapsed);
  } else {
    postFailed.add(1);
    console.error(`[media-bench] createPost failed: HTTP ${res.status} ${res.body ? res.body.substring(0, 200) : ""}`);
  }

  sleep(1);
}

// ─── Summary ────────────────────────────────────────────────────────────
export function handleSummary(data) {
  return buildSummaryFiles(data, TEST_NAME);
}
