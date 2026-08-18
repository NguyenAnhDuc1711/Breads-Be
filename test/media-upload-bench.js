import http from "k6/http";
import { check, sleep, fail } from "k6";
import { Counter, Trend } from "k6/metrics";
import ws from "k6/ws";
import encoding from "k6/encoding";
import { buildSummaryFiles } from "./lib/handle-summary.js";

// ─── Epic presigned-media-upload — Task 004 (baseline TRƯỚC cutover) + ────
// ─── Task 020 (đo SAU cutover) ──────────────────────────────────────────
//
// Đo 3 chỉ số của luồng upload media, ở đúng 2 mức kích thước đã chốt (epic.md, plan-review round 2
// TEST-3):
//   - message/socket (sendMessage): DƯỚI 1MB — path này KHÔNG THỂ hoàn thành ở kích thước lớn hơn
//     trước cutover, chính là bug gốc do `maxHttpBufferSize` (Socket.IO, mặc định ~1MB).
//   - post/REST (createPost): 4-11MB.
//
// 3 chỉ số (giống hệt task 004, để so sánh công bằng trước/sau):
//   1. Bandwidth ingress+egress — k6 tự động track qua `data_sent`/`data_received` (built-in
//      metric). LƯU Ý cho mode=after: built-in này gộp CẢ traffic client<->Cloudinary (bytes ảnh
//      thật), nên KHÔNG dùng trực tiếp để so NFR-1 (băng thông/RAM riêng của Breads-Be) — xem chỉ
//      số riêng `media_*_after_backend_bytes` bên dưới.
//   2. Time-to-URL — custom Trend. Ở mode=after đây là ROUND-TRIP THẬT (đúng yêu cầu NFR-3 —
//      "cần đo đúng round-trip thật", xem 020.md Context): tính từ lúc bắt đầu gọi
//      `POST /media/sign-upload` tới lúc nhận ack/response cuối cùng chứa URL đã dùng được — bao
//      gồm cả thời gian upload thật lên Cloudinary. Ở mode=before: tính từ lúc gửi frame/request
//      (payload base64 đã nằm sẵn trong đó) tới lúc ack — giữ NGUYÊN định nghĩa gốc của task 004,
//      không đổi để không phá tính so sánh được của baseline đã có.
//   3. Peak RAM (RSS) của Breads-Be process — đo bằng script ngoài chạy song song, xem
//      `test/scripts/sample-rss.sh` (không đổi giữa 2 mode, chỉ đổi PID/thời điểm chạy).
//
// ─── Mode ────────────────────────────────────────────────────────────────
// MODE=before (mặc định, không đổi hành vi so với task 004): luồng base64-relay CŨ (đã bị task
//   010/011 xoá khỏi server thật — chỉ còn ý nghĩa nếu chạy trước cutover hoặc trên bản deploy chưa
//   cutover).
// MODE=after (task 020, MỚI): luồng cutover thật — gọi `POST /media/sign-upload` (task 002) lấy
//   chữ ký batch, upload byte ảnh THẬT lên Cloudinary bằng chữ ký đó, rồi emit URL trả về qua
//   `sendMessage`/`createPost` y hệt luồng client thật sẽ làm.
//
// Quyết định thiết kế (task 020, khác gợi ý ban đầu ở 020.md Technical Details — ghi rõ lý do):
// script này KHÔNG cần `CLOUDINARY_API_KEY`/`CLOUDINARY_API_SECRET` trong môi trường k6, dù server
// cần chúng. `POST /media/sign-upload` đã trả sẵn `apiKey`/`cloudName` cùng chữ ký trong response
// (`metadata.signatures[i]`) — đó chính là điểm của kiến trúc presigned-upload: client (kể cả
// script benchmark đóng vai client) KHÔNG BAO GIỜ cần thấy `api_secret`, chỉ server ký mới cần.
// Bắt k6 tự đọc `CLOUDINARY_API_SECRET` sẽ đi ngược lại đúng nguyên lý mà epic này dựng ra. Vẫn cần
// mạng thật tới `api.cloudinary.com` (không mock được cho phần đo NFR-3 — xem 020.md Known Warning
// #2) và `CLOUDINARY_CLOUD_NAME` phải khớp giữa server (ký) và tài khoản Cloudinary thật đang chạy
// (không cấu hình lại ở k6, chỉ dùng để BASE_URL trỏ đúng server).
//
// Usage — mode=before (giống hệt task 004):
//   ./test/scripts/sample-rss.sh <PID> > test/results/$(date -u +%Y-%m-%dT%H-%M-%SZ)__media-bench-before-rss.log
//   CREDS=$(node test/scripts/seed-test-users.js)
//   docker run --rm -i --network host -w /test \
//     -e SENDER_JWT=$(echo $CREDS | jq -r .sender.accessToken) \
//     -e SENDER_ID=$(echo $CREDS | jq -r .sender.userId) \
//     -e RECIPIENT_ID=$(echo $CREDS | jq -r .recipient.userId) \
//     -v "$(pwd)/test:/test" grafana/k6 run /test/media-upload-bench.js
//
// Usage — mode=after (task 020, cần server ĐÃ cutover + network thật tới Cloudinary):
//   ./test/scripts/sample-rss.sh <PID> > test/results/$(date -u +%Y-%m-%dT%H-%M-%SZ)__media-bench-after-rss.log
//   CREDS=$(node test/scripts/seed-test-users.js)
//   docker run --rm -i --network host -w /test \
//     -e MODE=after \
//     -e SENDER_JWT=$(echo $CREDS | jq -r .sender.accessToken) \
//     -e SENDER_ID=$(echo $CREDS | jq -r .sender.userId) \
//     -e RECIPIENT_ID=$(echo $CREDS | jq -r .recipient.userId) \
//     -v "$(pwd)/test:/test" grafana/k6 run /test/media-upload-bench.js
//
// Điều kiện đo (ghi kèm khi báo cáo, vì repo này đã có tiền lệ nhiễu đo cao giữa 2 lần chạy — xem
// `test/results/`): chạy đủ ITERATIONS lần/kịch bản, lấy `avg` VÀ `p(95)`/`med` từ report (không
// chỉ 1 số), ghi rõ máy đo + tình trạng mạng (dev laptop hay CI, băng thông thật tới Cloudinary)
// khi so sánh before/after — khác máy/mạng thì % thay đổi không còn ý nghĩa so sánh trực tiếp.
// ─────────────────────────────────────────────────────────────────────────

const TEST_NAME = "media-upload-bench";

// ─── Configuration via env vars ─────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || "http://host.docker.internal:8080";
const SENDER_JWT = __ENV.SENDER_JWT || __ENV.JWT || "";
const SENDER_ID = __ENV.SENDER_ID || __ENV.USER_ID || "";
const RECIPIENT_ID = __ENV.RECIPIENT_ID || "";

// Task 020: chọn luồng đo. "before" = luồng base64-relay cũ (task 004, mặc định — không đổi hành
// vi cho người đã dùng script này trước task 020). "after" = luồng cutover thật (sign-upload ->
// Cloudinary thật -> emit).
const MODE = (__ENV.MODE || "before").toLowerCase();
if (MODE !== "before" && MODE !== "after") {
  throw new Error(`media-upload-bench: MODE phải là "before" hoặc "after", nhận "${MODE}"`);
}

// Số lần lặp mỗi kịch bản — cố định (không phải load test, đây là benchmark so sánh trước/sau, cần
// số lần chạy giống hệt nhau giữa 2 mode để so sánh công bằng).
const ITERATIONS = parseInt(__ENV.ITERATIONS || "10", 10);

const HTTP_BASE = BASE_URL.replace(/\/$/, "");
const WS_BASE = HTTP_BASE.replace(/^http/, "ws");
// Route.MEDIA + MEDIA_PATH.SIGN_UPLOAD (src/Breads-Shared/APIConfig.ts) — hardcode literal ở đây
// giống cách file này đã hardcode "/socket/"/"/posts/create" (k6 không import được .ts trực tiếp).
const MEDIA_SIGN_UPLOAD_PATH = "/media/sign-upload";

// ─── Fixture ảnh — đọc lúc init (open() chỉ dùng được ở init phase) ─────
// sample-media.png (<1MB) cho path message/socket; sample-media-large.png (4-11MB) cho path
// post/REST. Cả 2 do task 004 tự sinh, tái dùng nguyên trạng cho task 020 (cùng fixture => so sánh
// công bằng).
const MESSAGE_IMG_BYTES = open("./fixtures/sample-media.png", "b");
const POST_IMG_BYTES = open("./fixtures/sample-media-large.png", "b");
// Chỉ mode=before cần data: URI (payload gửi thẳng qua socket/REST); mode=after gửi file thật lên
// Cloudinary nên không cần base64 hoá.
const MESSAGE_DATA_URI = `data:image/png;base64,${encoding.b64encode(MESSAGE_IMG_BYTES)}`;
const POST_DATA_URI = `data:image/png;base64,${encoding.b64encode(POST_IMG_BYTES)}`;

// ─── Custom metrics — mode=before (task 004, giữ nguyên tên/định nghĩa) ─
const msgSent = new Counter("media_message_sent");
const msgAcked = new Counter("media_message_acked");
const msgFailed = new Counter("media_message_failed");
const msgLatency = new Trend("media_message_time_to_url", true); // ms

const postSent = new Counter("media_post_sent");
const postOk = new Counter("media_post_ok");
const postFailed = new Counter("media_post_failed");
const postLatency = new Trend("media_post_time_to_url", true); // ms

// ─── Custom metrics — mode=after (task 020, NEW) ────────────────────────
const msgAfterSent = new Counter("media_message_after_sent");
const msgAfterAcked = new Counter("media_message_after_acked");
const msgAfterFailed = new Counter("media_message_after_failed");
const msgAfterLatency = new Trend("media_message_after_time_to_url", true); // ms, full round-trip
// NFR-1: bytes qua Breads-Be riêng (sign-upload request+response + emit frame/ack), KHÔNG bao gồm
// bytes ảnh chuyển thẳng client<->Cloudinary — đây mới là số so được với "trước cutover".
const msgAfterBackendBytes = new Counter("media_message_after_backend_bytes");

const postAfterSent = new Counter("media_post_after_sent");
const postAfterOk = new Counter("media_post_after_ok");
const postAfterFailed = new Counter("media_post_after_failed");
const postAfterLatency = new Trend("media_post_after_time_to_url", true); // ms, full round-trip
const postAfterBackendBytes = new Counter("media_post_after_backend_bytes");

// ─── k6 options ─────────────────────────────────────────────────────────
const BEFORE_SCENARIOS = {
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
};

const AFTER_SCENARIOS = {
  // Bao gồm cả sign-upload REST call + upload thật lên Cloudinary trước khi emit -> maxDuration
  // rộng hơn mode=before (network thật tới Cloudinary, không kiểm soát được latency).
  message_after: {
    executor: "shared-iterations",
    vus: 1,
    iterations: ITERATIONS,
    maxDuration: "3m",
    exec: "messageAfterScenario",
    tags: { path: "message-socket-after" },
  },
  post_after: {
    executor: "shared-iterations",
    vus: 1,
    iterations: ITERATIONS,
    maxDuration: "5m",
    startTime: "20s",
    exec: "postAfterScenario",
    tags: { path: "post-rest-after" },
  },
};

export const options = {
  scenarios: MODE === "after" ? AFTER_SCENARIOS : BEFORE_SCENARIOS,
  thresholds: {
    // Không đặt ngưỡng pass/fail — đây là benchmark ghi số liệu, không phải test chức năng (đúng
    // tinh thần "tham khảo, không phải gate" của toàn epic — xem PRD/epic.md Success Criteria, và
    // 020.md Acceptance Criteria "không phải hard gate").
    media_message_acked: ["count>=0"],
    media_post_ok: ["count>=0"],
    media_message_after_acked: ["count>=0"],
    media_post_after_ok: ["count>=0"],
  },
};

// ─── Engine.IO/Socket.IO handshake (dùng chung cả 2 mode) ──────────────
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

// ─── sendMessage qua socket (dùng chung cả 2 mode, chỉ khác `mediaUrl` gửi kèm và mốc thời gian
// bắt đầu đo latency) ─────────────────────────────────────────────────────
// `startRef.t === 0` -> mốc đo bắt đầu ngay TRƯỚC khi gửi frame (định nghĩa gốc của task 004, dùng
// cho mode=before). `startRef.t` đã có giá trị -> giữ nguyên (mode=after truyền mốc từ trước lúc
// gọi sign-upload, để latency phản ánh ĐÚNG round-trip thật NFR-3 yêu cầu).
function sendMessageOverSocket(mediaUrl, startRef, metrics) {
  const handshake = engineIOHandshake();
  const sid = handshake.sid;
  const wsUrl = `${WS_BASE}/socket/?EIO=4&transport=websocket&sid=${sid}`;

  const res = ws.connect(wsUrl, { headers: { Cookie: `jwt=${SENDER_JWT}` } }, function (socket) {
    let connected = false;
    let acked = false;

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
        const elapsed = Date.now() - startRef.t;
        try {
          const ackBody = JSON.parse(sioPayload.substring(bracketIdx));
          const response = Array.isArray(ackBody) ? ackBody[0] : ackBody;
          if (response && response.status === "success") {
            metrics.acked.add(1);
            metrics.latency.add(elapsed);
          } else {
            metrics.failed.add(1);
          }
        } catch (_e) {
          metrics.failed.add(1);
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
        message: { media: [{ url: mediaUrl, type: "image" }] },
      };
      const frame = `420["/messages/create",${JSON.stringify(payload)}]`;
      if (startRef.t === 0) startRef.t = Date.now();
      socket.send(frame);
      metrics.sent.add(1);
    }, 800);

    // Safety timeout — nếu không ack trong 15s, đóng kết nối và tính là failed.
    socket.setTimeout(function () {
      if (!acked) {
        metrics.failed.add(1);
      }
      socket.close();
    }, 15000);
  });

  check(res, { "WebSocket upgraded (101)": (r) => r && r.status === 101 });
}

// ─── createPost qua REST (dùng chung cả 2 mode) ─────────────────────────
function createPostOverRest(mediaUrl, startedAtMs, metrics, backendBytesCounter, extraBackendBytes) {
  const payload = {
    authorId: SENDER_ID,
    content: `[media-bench] ${Date.now()}`,
    media: [{ url: mediaUrl, type: "image" }],
    survey: [],
  };
  const bodyStr = JSON.stringify(payload);

  const res = http.post(`${HTTP_BASE}/posts/create`, bodyStr, {
    headers: { "Content-Type": "application/json", Cookie: `jwt=${SENDER_JWT}` },
    timeout: "60s",
    tags: { name: "createPost_media" },
  });
  const elapsed = Date.now() - startedAtMs;

  metrics.sent.add(1);
  // Bytes qua backend (sign-upload + call này) tính KHÔNG PHỤ THUỘC kết quả 2xx hay không — chi phí
  // băng thông đã phát sinh thật ngay cả khi createPost sau đó lỗi. Chỉ latency (thời gian có URL
  // dùng được) mới cần điều kiện thành công.
  if (backendBytesCounter) {
    backendBytesCounter.add(
      (extraBackendBytes || 0) + bodyStr.length + (res.body ? res.body.length : 0)
    );
  }
  const ok = check(res, { "createPost 2xx": (r) => r.status >= 200 && r.status < 300 });
  if (ok) {
    metrics.ok.add(1);
    metrics.latency.add(elapsed);
  } else {
    metrics.failed.add(1);
    console.error(
      `[media-bench] createPost failed: HTTP ${res.status} ${res.body ? res.body.substring(0, 200) : ""}`
    );
  }
}

// ─── Task 020: gọi POST /media/sign-upload (task 002) ──────────────────
// Trả về {signatures, backendBytes}. `backendBytes` = kích thước request+response của CHÍNH call
// này (JSON nhỏ, không chứa byte ảnh nào) — dùng để cộng vào chỉ số NFR-1 backend-only.
function signUpload(entityType, count, recipientId) {
  const body = { entityType, count };
  if (entityType === "message") {
    body.recipientId = recipientId;
  }
  const bodyStr = JSON.stringify(body);

  const res = http.post(`${HTTP_BASE}${MEDIA_SIGN_UPLOAD_PATH}`, bodyStr, {
    headers: { "Content-Type": "application/json", Cookie: `jwt=${SENDER_JWT}` },
    timeout: "10s",
    tags: { name: "media_sign_upload" },
  });
  if (res.status !== 200) {
    fail(`POST ${MEDIA_SIGN_UPLOAD_PATH} HTTP ${res.status}: ${res.body}`);
  }
  const json = JSON.parse(res.body);
  const signatures = json && json.metadata && json.metadata.signatures;
  if (!Array.isArray(signatures) || signatures.length !== count) {
    fail(`POST ${MEDIA_SIGN_UPLOAD_PATH}: metadata.signatures không hợp lệ: ${res.body}`);
  }

  return {
    signatures,
    backendBytes: bodyStr.length + (res.body ? res.body.length : 0),
  };
}

// ─── Task 020: upload byte ảnh THẬT lên Cloudinary bằng chữ ký đã cấp ──
// KHÔNG mock — NFR-3 (round-trip thật) yêu cầu đo đúng thời gian upload thật (Known Warning #2,
// 020.md Context). `signature.apiKey`/`cloudName` lấy từ response `signUpload()`, KHÔNG đọc
// process.env trong k6 — xem giải thích thiết kế ở đầu file.
function uploadToCloudinary(fileBytes, filename, contentType, signature) {
  const url = `https://api.cloudinary.com/v1_1/${signature.cloudName}/${signature.resourceType}/upload`;
  const formData = {
    file: http.file(fileBytes, filename, contentType),
    api_key: signature.apiKey,
    timestamp: String(signature.timestamp),
    signature: signature.signature,
    public_id: signature.publicId,
  };

  const res = http.post(url, formData, {
    timeout: "60s",
    tags: { name: "cloudinary_upload" },
  });
  if (res.status < 200 || res.status >= 300) {
    fail(`Cloudinary upload HTTP ${res.status}: ${res.body ? res.body.substring(0, 300) : ""}`);
  }
  const json = JSON.parse(res.body);
  if (!json.secure_url) {
    fail(`Cloudinary upload response thiếu secure_url: ${res.body ? res.body.substring(0, 300) : ""}`);
  }
  return json.secure_url;
}

// ─── Scenario 1a: message/socket, mode=before (<1MB, base64 qua socket) ─
export function messageScenario() {
  if (!SENDER_JWT || !RECIPIENT_ID) {
    console.error("SENDER_JWT/RECIPIENT_ID env var required. Aborting VU.");
    sleep(2);
    return;
  }

  sendMessageOverSocket(MESSAGE_DATA_URI, { t: 0 }, {
    sent: msgSent,
    acked: msgAcked,
    failed: msgFailed,
    latency: msgLatency,
  });
  sleep(1);
}

// ─── Scenario 1b: message/socket, mode=after (task 020) ────────────────
// sign-upload -> upload thật lên Cloudinary -> emit URL qua socket. Latency đo từ TRƯỚC lúc gọi
// sign-upload (round-trip thật, NFR-3), không phải từ lúc gửi frame.
export function messageAfterScenario() {
  if (!SENDER_JWT || !RECIPIENT_ID) {
    console.error("SENDER_JWT/RECIPIENT_ID env var required. Aborting VU.");
    sleep(2);
    return;
  }

  const startedAt = Date.now();
  const sign = signUpload("message", 1, RECIPIENT_ID);
  const secureUrl = uploadToCloudinary(
    MESSAGE_IMG_BYTES,
    "sample-media.png",
    "image/png",
    sign.signatures[0]
  );
  msgAfterBackendBytes.add(sign.backendBytes);

  sendMessageOverSocket(secureUrl, { t: startedAt }, {
    sent: msgAfterSent,
    acked: msgAfterAcked,
    failed: msgAfterFailed,
    latency: msgAfterLatency,
  });
  sleep(1);
}

// ─── Scenario 2a: post/REST, mode=before (4-11MB, base64 qua REST) ─────
export function postScenario() {
  if (!SENDER_JWT || !SENDER_ID) {
    console.error("SENDER_JWT/SENDER_ID env var required. Aborting VU.");
    sleep(2);
    return;
  }

  createPostOverRest(POST_DATA_URI, Date.now(), {
    sent: postSent,
    ok: postOk,
    failed: postFailed,
    latency: postLatency,
  });
  sleep(1);
}

// ─── Scenario 2b: post/REST, mode=after (task 020) ──────────────────────
export function postAfterScenario() {
  if (!SENDER_JWT || !SENDER_ID) {
    console.error("SENDER_JWT/SENDER_ID env var required. Aborting VU.");
    sleep(2);
    return;
  }

  const startedAt = Date.now();
  const sign = signUpload("post", 1);
  const secureUrl = uploadToCloudinary(
    POST_IMG_BYTES,
    "sample-media-large.png",
    "image/png",
    sign.signatures[0]
  );

  createPostOverRest(
    secureUrl,
    startedAt,
    { sent: postAfterSent, ok: postAfterOk, failed: postAfterFailed, latency: postAfterLatency },
    postAfterBackendBytes,
    sign.backendBytes
  );
  sleep(1);
}

// ─── Summary ────────────────────────────────────────────────────────────
export function handleSummary(data) {
  return buildSummaryFiles(data, TEST_NAME);
}
