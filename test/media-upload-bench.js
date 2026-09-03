import http from "k6/http";
import { check, sleep, fail } from "k6";
import { Counter, Trend } from "k6/metrics";
import ws from "k6/ws";
import encoding from "k6/encoding";
import { buildSummaryFiles } from "./lib/handle-summary.js";

const TEST_NAME = "media-upload-bench";

const BASE_URL = __ENV.BASE_URL || "http://host.docker.internal:8080";
const SENDER_JWT = __ENV.SENDER_JWT || __ENV.JWT || "";
const SENDER_ID = __ENV.SENDER_ID || __ENV.USER_ID || "";
const RECIPIENT_ID = __ENV.RECIPIENT_ID || "";

const MODE = (__ENV.MODE || "before").toLowerCase();
if (MODE !== "before" && MODE !== "after") {
  throw new Error(`media-upload-bench: MODE phải là "before" hoặc "after", nhận "${MODE}"`);
}

const ITERATIONS = parseInt(__ENV.ITERATIONS || "10", 10);

const HTTP_BASE = BASE_URL.replace(/\/$/, "");
const WS_BASE = HTTP_BASE.replace(/^http/, "ws");
const MEDIA_SIGN_UPLOAD_PATH = "/media/sign-upload";

const MESSAGE_IMG_BYTES = open("./fixtures/sample-media.png", "b");
const POST_IMG_BYTES = open("./fixtures/sample-media-large.png", "b");
const MESSAGE_DATA_URI = `data:image/png;base64,${encoding.b64encode(MESSAGE_IMG_BYTES)}`;
const POST_DATA_URI = `data:image/png;base64,${encoding.b64encode(POST_IMG_BYTES)}`;

const msgSent = new Counter("media_message_sent");
const msgAcked = new Counter("media_message_acked");
const msgFailed = new Counter("media_message_failed");
const msgLatency = new Trend("media_message_time_to_url", true);

const postSent = new Counter("media_post_sent");
const postOk = new Counter("media_post_ok");
const postFailed = new Counter("media_post_failed");
const postLatency = new Trend("media_post_time_to_url", true);

const msgAfterSent = new Counter("media_message_after_sent");
const msgAfterAcked = new Counter("media_message_after_acked");
const msgAfterFailed = new Counter("media_message_after_failed");
const msgAfterLatency = new Trend("media_message_after_time_to_url", true);
const msgAfterBackendBytes = new Counter("media_message_after_backend_bytes");

const postAfterSent = new Counter("media_post_after_sent");
const postAfterOk = new Counter("media_post_after_ok");
const postAfterFailed = new Counter("media_post_after_failed");
const postAfterLatency = new Trend("media_post_after_time_to_url", true);
const postAfterBackendBytes = new Counter("media_post_after_backend_bytes");

const BEFORE_SCENARIOS = {
  message_baseline: {
    executor: "shared-iterations",
    vus: 1,
    iterations: ITERATIONS,
    maxDuration: "2m",
    exec: "messageScenario",
    tags: { path: "message-socket" },
  },
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
    media_message_acked: ["count>=0"],
    media_post_ok: ["count>=0"],
    media_message_after_acked: ["count>=0"],
    media_post_after_ok: ["count>=0"],
  },
};

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

    socket.setTimeout(function () {
      if (!acked) {
        metrics.failed.add(1);
      }
      socket.close();
    }, 15000);
  });

  check(res, { "WebSocket upgraded (101)": (r) => r && r.status === 101 });
}

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

export function handleSummary(data) {
  return buildSummaryFiles(data, TEST_NAME);
}
