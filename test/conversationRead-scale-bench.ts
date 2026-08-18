// Benchmark thủ công cho SC-5 (unread-message-count, task 021): p95 write latency của
// `markConversationRead` khi group có 10 vs 200 thành viên (mỗi thành viên = 1 document
// `ConversationRead` riêng, theo AD-1 — mục tiêu là chứng minh KHÔNG có hot-document contention
// tăng theo group size).
//
// KHÁC quy ước benchmark hiện có trong `test/` (các file `*-stress.js`, `media-upload-bench.js`
// dùng k6 + cần server thật + docker): đây đo latency ghi MongoDB thuần tuý, không phải HTTP/socket
// layer — dùng Node/tsx script đơn giản kết nối thẳng MongoDB (cùng kỹ thuật ephemeral `mongod`
// với `src/socket/controllers/message.controller.sendnext.test.ts`) thay vì k6, vì k6 không đo
// được đúng thứ cần đo ở đây (write latency thuần, không phải network round-trip).
//
// Chạy thủ công: npx tsx test/conversationRead-scale-bench.ts
// KHÔNG chạy qua "npm test" — không khớp glob trong package.json, và bench chạy khá lâu
// (seed 200 document + 50 sample mỗi quy mô).
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mongoose from "mongoose";
import ConversationRead from "../src/api/models/conversationRead.model.js";
import Message from "../src/api/models/message.model.js";
import { markConversationRead } from "../src/api/services/conversationRead.service.js";

const MONGO_PORT = 47_200 + (process.pid % 500);
const DB_NAME = "breads_unread_bench";

const p95 = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.95)];
};

const benchmarkGroupSize = async (participantCount: number, iterations = 50) => {
  const conversationId = new mongoose.Types.ObjectId();
  const targetUserId = new mongoose.Types.ObjectId();

  // Seed participantCount ConversationRead docs cho CÙNG 1 conversation — mô phỏng group đông
  // thành viên (AD-1: mỗi participant = 1 document riêng, không phải 1 field trong Conversation).
  const docs = [{ conversationId, userId: targetUserId, lastReadAt: new Date(0), unreadCount: 5 }];
  for (let i = 1; i < participantCount; i++) {
    docs.push({
      conversationId,
      userId: new mongoose.Types.ObjectId(),
      lastReadAt: new Date(0),
      unreadCount: 5,
    });
  }
  await ConversationRead.insertMany(docs);

  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await markConversationRead({
      conversationId,
      userId: targetUserId,
      lastMsg: { _id: new mongoose.Types.ObjectId(), createdAt: new Date() },
    });
    samples.push(performance.now() - start);
  }

  await ConversationRead.deleteMany({ conversationId });
  return p95(samples);
};

(async () => {
  const dbPath = mkdtempSync(join(tmpdir(), "breads-unread-bench-"));
  let mongod: ChildProcess | null = null;

  try {
    mongod = spawn(
      "mongod",
      ["--dbpath", dbPath, "--port", String(MONGO_PORT), "--bind_ip", "127.0.0.1"],
      { stdio: "ignore" }
    );

    const uri = `mongodb://127.0.0.1:${MONGO_PORT}/${DB_NAME}`;
    const deadline = Date.now() + 30_000;
    let connected = false;
    while (Date.now() < deadline) {
      try {
        await mongoose.connect(uri, { serverSelectionTimeoutMS: 1000 });
        connected = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    if (!connected) {
      throw new Error(
        `Không kết nối được MongoDB tạm ở ${uri}. Cần \`mongod\` trên PATH (brew install mongodb-community).`
      );
    }
    // Model không dùng nhưng import để đảm bảo schema Message được đăng ký (không cần seed message
    // thật cho benchmark này — markConversationRead chỉ cần đếm, không cần message thật tồn tại).
    void Message;

    const p95At10 = await benchmarkGroupSize(10);
    const p95At200 = await benchmarkGroupSize(200);
    const deltaPct = ((p95At200 - p95At10) / p95At10) * 100;

    // SC-5's intent (PRD: "Không suy giảm theo group size") là 1 chiều — chỉ quan tâm group đông
    // hơn có bị CHẬM ĐI hay không (NFR-2: mỗi ghi là 1 document độc lập, không tranh chấp).
    // Nhanh hơn (delta âm) không phải vấn đề, dù PRD viết ngưỡng "±10%" — > +10% (chậm đi) mới
    // là điều cần REVIEW.
    const verdict =
      deltaPct <= 10
        ? "PASS (no degradation as group size grows — NFR-2 holds)"
        : "REVIEW (>10% slower at 200 vs 10 participants — see epic.md R-4 for accepted mitigation options)";

    console.log(
      JSON.stringify(
        {
          p95At10_ms: Number(p95At10.toFixed(3)),
          p95At200_ms: Number(p95At200.toFixed(3)),
          deltaPct: `${deltaPct.toFixed(1)}%`,
          verdict,
        },
        null,
        2
      )
    );
  } finally {
    await mongoose.disconnect().catch(() => {});
    mongod?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    rmSync(dbPath, { recursive: true, force: true });
  }
})();
