// Run with Node's built-in test runner: `npm test`.
//
// Phạm vi: FR-9 — `metricsHandler` set đúng 4 dòng `feed_fanout_queue_{waiting,failed}` theo
// `getJobCounts()` thật của `dispatchQueue`/`batchQueue` (mock method trực tiếp trên singleton,
// không mock cả module — 2 Queue instance đã tồn tại thật ở `queue.ts`, không cần Redis chạy vì
// ta không bao giờ gọi `getJobCounts()` gốc), và fail-safe khi `getJobCounts()` reject (Redis
// down lúc scrape) — response `/metrics` vẫn trả về nguyên vẹn phần HTTP metrics, không throw.
//
// Chạy test "Redis down" TRƯỚC test "happy path": Gauge là singleton theo `register` — một khi
// một label combo đã được `.set()`, giá trị đó tồn tại trong registry cho tới lần `.set()` kế
// tiếp (không tự xoá khi catch bỏ qua). Nếu chạy happy-path trước, dòng
// `feed_fanout_queue_waiting{queue="dispatch"}` sẽ vẫn xuất hiện (với giá trị cũ) ở test Redis
// down, làm sai lệch assertion "gauge chưa từng được set thì không có dòng nào".
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { metricsHandler } from "../../middlewares/metrics.ts";
import { batchQueue, closeFanoutQueues, dispatchQueue } from "../feed/queue.ts";

// Stub tối thiểu cho Express Response — `metricsHandler` chỉ dùng `res.set` và `res.end`.
const makeRes = () => {
  const state = { body: "", ended: false };
  const res: any = {
    set: (_key: string, _value: string) => {},
    end: (body: string) => {
      state.body = body;
      state.ended = true;
    },
  };
  return { res, state };
};

test("Redis down: getJobCounts() reject -> /metrics vẫn trả về (không throw), có HTTP metrics khác, thiếu 4 dòng queue", async () => {
  const originalDispatch = dispatchQueue.getJobCounts;
  const originalBatch = batchQueue.getJobCounts;
  dispatchQueue.getJobCounts = (async () => {
    throw new Error("Redis down");
  }) as any;
  batchQueue.getJobCounts = (async () => {
    throw new Error("Redis down");
  }) as any;

  try {
    const { res, state } = makeRes();
    await assert.doesNotReject(metricsHandler({} as any, res));
    assert.equal(state.ended, true);
    // Phần còn lại của response (HTTP metrics đã có sẵn) vẫn nguyên vẹn.
    assert.match(state.body, /http_request_duration_seconds/);
    // Chưa từng .set() -> Gauge chưa xuất hiện dòng nào cho label này.
    assert.doesNotMatch(state.body, /feed_fanout_queue_waiting\{queue="dispatch"\}/);
    assert.doesNotMatch(state.body, /feed_fanout_queue_failed\{queue="batch"\}/);
  } finally {
    dispatchQueue.getJobCounts = originalDispatch;
    batchQueue.getJobCounts = originalBatch;
  }
});

test("FR-9: /metrics chứa đúng feed_fanout_queue_waiting/failed cho queue=dispatch và queue=batch", async () => {
  const originalDispatch = dispatchQueue.getJobCounts;
  const originalBatch = batchQueue.getJobCounts;
  dispatchQueue.getJobCounts = (async () => ({ waiting: 3, failed: 1 })) as any;
  batchQueue.getJobCounts = (async () => ({ waiting: 7, failed: 2 })) as any;

  try {
    const { res, state } = makeRes();
    await metricsHandler({} as any, res);
    assert.equal(state.ended, true);
    assert.match(state.body, /feed_fanout_queue_waiting\{queue="dispatch"\} 3/);
    assert.match(state.body, /feed_fanout_queue_failed\{queue="dispatch"\} 1/);
    assert.match(state.body, /feed_fanout_queue_waiting\{queue="batch"\} 7/);
    assert.match(state.body, /feed_fanout_queue_failed\{queue="batch"\} 2/);
  } finally {
    dispatchQueue.getJobCounts = originalDispatch;
    batchQueue.getJobCounts = originalBatch;
  }
});

after(async () => {
  // Đóng cả 2 Queue + connection nội bộ (import `queue.ts` mở connection Redis thật ngay lúc
  // import) để `node --test` thoát được, cùng pattern `queue.test.ts` đã dùng.
  await closeFanoutQueues();
});
