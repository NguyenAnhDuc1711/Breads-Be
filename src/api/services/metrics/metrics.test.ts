import assert from "node:assert/strict";
import { after, test } from "node:test";
import { metricsHandler } from "../../middlewares/metrics.ts";
import { batchQueue, closeFanoutQueues, dispatchQueue } from "../feed/queue.ts";

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
    assert.match(state.body, /http_request_duration_seconds/);
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
  await closeFanoutQueues();
});
