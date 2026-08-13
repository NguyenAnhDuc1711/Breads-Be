# Đánh giá Kiến trúc & Checklist Production-Readiness — Breads (DATN-Be)

> Góc nhìn: Solution Architect review toàn bộ backend (REST + Socket.IO + feed pipeline + hạ tầng).
> Ngày đánh giá: 2026-08-10. Snapshot theo `master` tại thời điểm review (sau epic `fanout-queue`).
> Mục tiêu tài liệu: (1) đánh giá hiện trạng kiến trúc, (2) liệt kê checklist việc cần làm để đưa
> project từ mức "đồ án tốt nghiệp" lên mức "sản phẩm vận hành production thật".
>
> Cập nhật 2026-08-12: đã xử lý S2, S3, S4, A3, A4 — chi tiết ở mục 3 (✅ Đã xác nhận khắc phục)
> và checkbox `[x]` tương ứng ở mục 4.
>
> Cập nhật 2026-08-12 (bổ sung): review chi tiết module Notification (REST + Socket.IO) — phát
> hiện S5, S6 (nghiêm trọng, chưa fix) và A11-A14 (đáng chú ý) ở mục 3, checklist tương ứng ở mục 4.
>
> Cập nhật 2026-08-12 (epic `notification-fixes`, đã merge `master` @ `e1b36af`): đã xử lý toàn bộ
> S5, S6, A11, A12, A13, A14 qua pipeline CCPM đầy đủ (office-hours → PRD → plan-review 2 vòng →
> 7 task → epic-verify EPIC_COMPLETE 5/5). Thêm 1 finding mới phát hiện khi implement (**A12b**, cùng
> lớp bug với A12 nhưng ở code path unlike) và 1 mở rộng scope được chủ dự án duyệt giữa chừng
> (**S7**, danh tính socket ở `user/connect`) — cả hai cũng đã fix trong cùng epic. Chi tiết ở mục 3.

---

## 1. Tổng quan hệ thống

Backend monolith Node.js/TypeScript (ESM, mixed JS/TS) cho mạng xã hội "Breads":

- **API**: Express 4, REST dưới `/api`, JWT qua cookie httpOnly.
- **Real-time**: Socket.IO (messaging, notification, presence).
- **Dữ liệu**: MongoDB (Mongoose) — DB chính + DB analytics riêng; Redis cho feed ZSET/cache.
- **Hàng đợi**: BullMQ (2 tầng: dispatch → batch) cho fan-out bài viết.
- **Observability**: Prometheus + Grafana + redis/mongo exporter.
- **Quy trình**: một phần dự án (module feed) được phát triển qua CCPM (PRD → epic → issue →
  verify), có unit test (`node --test`) và k6 stress test thật. Phần còn lại của hệ thống (auth,
  message, notification, upload, cron...) không đi qua quy trình này và thiếu kiểm chứng tương ứng.

```mermaid
graph TB
    Client["Client (Web/App)"]

    subgraph AppTier["app container (1 instance)"]
        Express["Express API /api"]
        SocketIO["Socket.IO (in-process registry)"]
        Cron["node-cron (in-process)"]
    end

    subgraph WorkerTier["worker container (scale N — A3, 2026-08-12)"]
        Workers["BullMQ Workers (dispatch + batch)<br/>src/worker.ts, process riêng"]
    end

    Mongo[(MongoDB<br/>Breads + Breads-analytics)]
    Redis[(Redis<br/>feed ZSET + BullMQ)]
    Cloudinary["Cloudinary (media)"]
    Prom["Prometheus + Grafana"]

    Client -->|REST| Express
    Client -->|WebSocket| SocketIO
    Express --> Mongo
    Express --> Redis
    Express --> Cloudinary
    Workers --> Redis
    Workers --> Mongo
    Cron --> Mongo
    Express -->|/metrics| Prom
```

> Lưu ý: `Workers` không còn socket.io instance nên không tự emit được real-time "bài viết mới" (`FEED_SOCKET_ENABLED`) — xem A3 ở mục 3.

---

## 2. Điểm mạnh

| Điểm mạnh | Bằng chứng |
|---|---|
| Feed pipeline ("For You") thiết kế đúng bài toán social-feed kinh điển | Hybrid fan-out-on-write (user thường) + pull-on-read (celebrity >50k follower), candidate pool cố định trước khi phân trang, decay điểm động không ghi lại — `src/api/services/feed/*` |
| Fail-safe triệt để, có chủ đích | Mọi helper Redis non-throwing, timeout-race 200ms, catch-all lồng nhau ở tầng đọc — NFR-3 "Redis chết không bao giờ thành 5xx" |
| Kiến trúc queue 2 tầng hợp lý | Tách dispatch (1 job/post) khỏi batch (1 job/chunk follower), rate-limit đúng tầng, `jobId` dedupe, retry thật (verify report có bằng chứng "poison job" retry 3 lần) |
| Văn hoá kiểm chứng nghiêm túc (ở module feed) | 95 unit test, k6 stress test đo p50/p90 thật, epic verify report với coverage matrix 12/12 FR/NFR |
| Observability đủ dùng thật | Prometheus + Grafana + exporter cho cả Redis lẫn Mongo, custom gauge cho queue depth |
| Tự tài liệu hoá cả phần chưa xong | `docs/feed-pipeline-flow.md` mục 10 nêu rõ gap cron rebuild ZSET — kỷ luật kỹ thuật hiếm gặp |

---

## 3. Rủi ro & khoảng trống — theo mức độ ưu tiên

### 🔴 Nghiêm trọng

| # | Vấn đề | Vị trí | Vì sao đáng lo |
|---|---|---|---|
| S1 | Không có transaction cho thao tác đa-document | `src/api/services/user.ts:105,123` (`$inc followersCount` tách khỏi `Follow.create`/`deleteOne`) | Crash giữa 2 lệnh → đếm sai vĩnh viễn. Repo đã cần `migrate:backfill-like-follow-counts` để vá — vấn đề đã xảy ra thật. `followersCount` sai còn ảnh hưởng ngược lại ngưỡng celebrity của feed. |
| S2 | ✅ **ĐÃ FIX** — ~~Upload: path ghép trực tiếp `req.query.userId`, không `fileFilter`/`limits`~~ | `src/api/middlewares/upload.ts` | `validateUploadUserId` (validate ObjectId trước khi multer đụng body) + `fileFilter` whitelist ảnh/video/tài liệu (`cb(null,false)` — không dùng `cb(err)` vì multer không tự drain stream, sẽ treo connection) + `limits.fileSize/files` đã có sẵn từ trước. |
| S3 | ✅ **ĐÃ FIX** — ~~Không có rate limiting ở bất kỳ đâu~~ | toàn bộ `app.ts`/routers | `globalTierLimiter` áp cho toàn `/api` + `authTierLimiter` riêng cho login/signup/crawl/forgot-password. |
| S4 | ✅ **ĐÃ FIX** — ~~Graceful shutdown không thực sự "graceful"~~ | `src/server.ts` | `process.exit(0)` giờ nằm trong callback `server.close()`, force-exit timeout 10s, đóng sạch Mongo/Redis/BullMQ queue trước khi thoát. Xử lý cả `SIGTERM` (Docker/K8s) không chỉ `SIGINT`. |
| S5 | ✅ **ĐÃ FIX** — ~~Route đọc thông báo không có xác thực — IDOR~~ | `src/api/routers/notification.route.ts` | `router.use(protectRoute)` mount ở router level (đúng pattern `post.route.ts`); `userId` bỏ hẳn khỏi `getNotificationsSchema`, controller lấy `req.user._id`. `z.object()` strip key lạ nên FE cũ gửi `userId` cũ vẫn `200`, không breaking. Xác nhận bằng smoke test HTTP thật: body chứa `userId` của người khác vẫn chỉ trả đúng thông báo của user đăng nhập. |
| S6 | ✅ **ĐÃ FIX** — ~~Tạo thông báo qua socket không xác thực `fromUser` — giả mạo/xoá thông báo người khác~~ | `src/socket/controllers/notification.controller.ts` | Thêm guard `(socket as any).user?.userId !== fromUser` ngay đầu `create`, mirror 1-1 pattern `likePost`, `return` sớm + `logger.warn` (silent với client). Kèm error containment (`try/catch` bọc toàn bộ thân hàm) vì fix thêm `await` mới có thể tạo unhandled rejection nếu không bọc. |
| S7 | ✅ **ĐÃ FIX** (mới, phát hiện + fix trong epic `notification-fixes`) — Danh tính socket ở `user/connect` do **client tự khai báo**, không đối chiếu JWT | `src/socket/controllers/user.controller.ts` | `socket.data.userId` (dùng để định tuyến push tin nhắn 1-1, presence, và notification) được gán thẳng từ `payload.userId` client gửi lên thay vì `(socket as any).user?.userId` mà middleware JWT đã xác thực sẵn. Bất kỳ socket nào cũng có thể tự nhận là user khác và **nghe lén** notification/tin nhắn real-time của họ. Phát hiện khi review S6: đóng chiều *ghi* (S6) mà bỏ ngỏ chiều *nhận* thì vẫn còn lỗ hổng cùng loại — chủ dự án duyệt mở rộng scope epic để vá luôn. |

### 🟠 Đáng chú ý

| # | Vấn đề | Vị trí | Ghi chú |
|---|---|---|---|
| A1 | ⏸ **HOÃN CÓ CHỦ ĐÍCH** — Không có Redis adapter cho Socket.IO | `src/socket/socket.ts`, `socket/services/user.ts` (`io.fetchSockets()`) | Registry socket chỉ tồn tại trong bộ nhớ tiến trình → không scale ngang được tầng real-time; 2 instance sẽ có 2 tập "online" tách biệt. **Quyết định 2026-08-12**: chưa cần vì project hiện chưa chạy nhiều instance `app` (chỉ 1 trong `docker-compose.yml`) — chỉ cấp thiết khi thật sự scale ngang HTTP/Socket.IO. |
| A2 | ⏸ **HOÃN CÓ CHỦ ĐÍCH** — Cron chạy in-process, không leader election | `src/app.ts` gọi `createDailyCollectionCron()`/`updateUsersCatesCron()` trực tiếp | Scale ngang N instance → cron chạy N lần song song, tạo trùng daily collection. **Quyết định 2026-08-12**: cùng lý do A1 — chỉ 1 instance `app` nên chưa có rủi ro trùng cron; distributed lock cũng tự mang rủi ro riêng (xem thảo luận trade-off trước đó trong session). |
| A3 | ✅ **ĐÃ FIX** — ~~BullMQ worker chạy chung tiến trình với HTTP server~~ | `src/worker.ts` (mới), `src/server.ts` | Worker chạy process riêng (`npm run worker`, service `worker` trong `docker-compose.yml`), scale độc lập bằng `--scale worker=N`. Đánh đổi: worker process không có Socket.IO nên push real-time "bài viết mới" (`FEED_SOCKET_ENABLED`, mặc định tắt) tự bỏ qua — cần A1 nếu muốn giữ tính năng này khi scale. |
| A4 | ✅ **ĐÃ FIX** — ~~`Message`/`Notification` model thiếu index cho query đường nóng~~ | `message.model.ts`, `notification.model.ts` | Đã thêm `{conversationId:1, createdAt:-1}` và `{toUsers:1, createdAt:-1}`. |
| A5 | Tìm kiếm tin nhắn: regex không escape, không text index | `message.controller.ts:186-196` | Input đưa thẳng vào `$regex` không escape → vector ReDoS + luôn full scan collection. |
| A6 | Cookie JWT thiếu `secure: true` | `src/api/utils/genarateTokenAndSetCookie.ts` | Có `httpOnly` + `sameSite: "strict"` nhưng thiếu `secure` — cần ép nếu không chắc chắn có HTTPS termination phía trước. |
| A7 | Cron rebuild/dọn ZSET feed (FR-8 gốc) chưa wire | `docs/feed-pipeline-flow.md` mục 10, `src/cronjob/index.ts` | Nhóm dev đã tự ghi nhận gap này. TTL là cơ chế dọn *duy nhất* đang chạy; hội tụ trạng thái celebrity chậm tới 7 ngày worst-case. |
| A8 | Không có health check endpoint / Docker HEALTHCHECK | `app.ts`, `Dockerfile` | Orchestrator (Docker/K8s) không có cách xác định app đã sẵn sàng nhận traffic hay đã treo. |
| A9 | Production image chạy trực tiếp bằng `tsx` (JIT transpile), không build | `Dockerfile` (`CMD ["npx", "tsx", "src/server.ts"]`) | `tsx`/`typescript` đang nằm trong `devDependencies` nhưng thực chất là runtime dependency của production — nếu ai đổi sang `npm ci --omit=dev` app sẽ vỡ ngay. Không compile trước cũng nghĩa là lỗi type chỉ lộ ra lúc chạy, không có gate nào chặn trước. |
| A10 | Container chạy với user root | `Dockerfile` | Không có `USER node`/non-root — vi phạm hardening cơ bản cho container production. |
| A11 | ✅ **ĐÃ FIX** — ~~Vòng đời "đã đọc" của thông báo bị đứt gãy~~ | `notification.model.ts`, `notification.controller.ts`, `notification.route.ts` | Thêm field `isRead: { type: Boolean, default: false }`. Wire `PATCH /notifications/read` (nhận `notificationId` hoặc `markAll`, XOR). Sau update, recompute `User.hasNewNotify` bằng `Notification.exists`. **Bẫy quan trọng xử lý đúng**: 370k document cũ không có key `isRead` trên đĩa (Mongoose `default` không áp lúc query/aggregate) — mọi filter "chưa đọc" dùng `isRead: { $ne: true }` (không phải `isRead: false`), mọi `$project` dùng `$ifNull: ["$isRead", false]` (không phải `isRead: 1`). Xác nhận bằng aggregate thật trên 1 document legacy thật sự thiếu key. |
| A12 | ✅ **ĐÃ FIX** — ~~Dedupe khi tạo thông báo bỏ qua `target` → mất thông báo hợp lệ~~ | `notification.controller.ts` | Thêm `target` vào điều kiện match (`target ? {target: ObjectId(target)} : {target: {$exists: false}}` — tuyệt đối không `target: undefined`, Mongoose strip key sẽ tái tạo đúng bug cũ). FOLLOW toggle giữ nguyên hành vi (target luôn vắng ở cả 2 phía). **A12b (phát hiện thêm khi implement, cùng lớp bug):** nhánh unlike ở `post.controller.ts` (`likePost`) xoá notification chỉ match `fromUser` + `"toUsers.0"` — bỏ cả `action` lẫn `target` — cũng đã siết đủ 4 điều kiện, thống nhất kiểu match `toUsers: {$in:[...]}` giữa 2 code path. |
| A13 | ✅ **ĐÃ FIX** — ~~Push real-time hỏng âm thầm khi thông báo có nhiều người nhận~~ | `socket/services/user.ts`, `notification.controller.ts` | Thêm `getUserSocketsByUserIds` dùng `.filter()` (bắt mọi tab của mọi user) + chuẩn hoá `String(...)` cả 2 phía; `getUserSocketByUserId` cũ giữ nguyên signature, thành wrapper mỏng (call site `message.ts` không đổi). Sửa luôn bug đi kèm: `User.updateOne({_id: ObjectId(toUsers)})` (mảng → id ngẫu nhiên) → `User.updateMany({_id:{$in: sendTo.map(ObjectId)}})`, dùng `sendTo` (đã lọc `fromUser`) thay vì `toUsers` thô ở cả 2 điểm. |
| A14 | ✅ **ĐÃ FIX** — ~~Data model chưa đủ cho UI "đã đọc"/lọc theo loại thông báo~~ | `notification.model.ts`, `notification.validator.ts`, `notification.controller.ts` | `isRead` per-document đã có (xem A11). Filter theo `action` (`z.enum(Constants.NOTIFICATION_ACTION).optional()`, sentinel `"all"` = không lọc) đã thêm vào `getNotificationsSchema` + `$match` — chốt sau khi chủ dự án xác nhận FE có tab lọc. **Lưu ý phát hiện khi verify (TRACE-2)**: FE hiện tại (`DATN-Fe`) chưa gửi `action` lên server — tab lọc đang lọc phía client trên dữ liệu đã fetch (`Activity.tsx`). Backend capability đã sẵn sàng, backward-compatible, nhưng FE chưa tích hợp — không phải lỗi, chỉ là chưa dùng tới. |

### 🟡 Nợ kỹ thuật / nhất quán

- ~~**Codebase giữa 2 thời kỳ JS→TS**: models/routers/middlewares còn `.js`~~ — ✅ **ĐÃ XONG**: kiểm tra lại (2026-08-12) không còn file `.js` nào trong `src/`. Vẫn chưa có `tsc --noEmit` chạy tự động ở đâu (xem CI bên dưới).
- **Không có CI/CD** (`.github/` rỗng): 95 unit test + k6 script chất lượng cao nhưng không có gì tự động chạy chúng trên mỗi PR — uổng công đã đầu tư.
- **Không có lint config** (không ESLint) — style code phụ thuộc hoàn toàn vào tự giác.
- **Phân mảnh analytics theo ngày**: `analytics.model.ts` tạo 1 collection Mongo mới mỗi ngày — hợp lý cho throughput nhưng không truy vấn xuyên ngày bằng 1 query được, và số collection tăng vô hạn theo thời gian.
- **Single point of failure hạ tầng có chủ đích**: 1 Mongo (không replica set), 1 Redis, 1 app container trong `docker-compose.yml` — chấp nhận được cho portfolio/demo nhưng cần nói rõ đây là giới hạn biết trước, không phải oversight.
- **Logic tạo/emit/aggregate notification copy-paste 3 nơi**: `notification.controller.ts` (REST), `notification.controller.ts` (socket), `post.controller.ts` (socket, trong `likePost`) đều có cùng ~30 dòng aggregate (lookup `fromUser`/`post`, `$addFields.FromUserDetails`) — không có test nào bắt được lệch giữa 3 bản sao, đổi field response phải sửa đồng bộ cả 3 nơi. **Đã cân nhắc lại trong epic `notification-fixes` (2026-08-12) và cố tình KHÔNG gộp**: tách helper dùng chung sẽ phá tính song song của 2 task sửa 2 file này (mỗi task cần sở hữu độc quyền file để chạy đồng thời) — chấp nhận trùng lặp đổi lấy tốc độ; điều kiện mở lại: xuất hiện bản sao thứ 4.
- **`getNotifications` phân trang bằng `$skip`/`$limit` trần** (`notification.controller.ts:14-16`) — chi phí tăng tuyến tính theo độ sâu trang, chưa là vấn đề với data hiện tại nhưng đáng theo dõi nếu 1 user tích luỹ rất nhiều thông báo.
- **1 test fail có sẵn, không liên quan module Notification**: `FEED_CONFIG: default của 5 field fanout-queue` (`src/api/services/feed/config.ts`) — default đã đổi (5→20, 10→100 khi tách BullMQ worker, xem A3) nhưng test chưa cập nhật theo. Phát hiện khi chạy `epic-verify` cho `notification-fixes` (xác nhận qua `git diff` cho thấy `config.ts` không nằm trong diff của epic đó) — hiện `npm test` exit code là `1` chứ không phải `0` vì lý do này, cần biết trước khi wire CI (mục P1 "Thiết lập CI" bên dưới) nếu không CI sẽ đỏ ngay từ ngày đầu vì lỗi không liên quan.

### ✅ Đã xác nhận khắc phục

- **`FEED_FANOUT_MODE: direct` đã được gỡ khỏi `docker-compose.yml`** (so với lần review trước) — hệ thống nay chạy đúng đường `queue` mặc định của epic `fanout-queue` thay vì đường đồng bộ cũ. Đây từng là finding P0 nghiêm trọng nhất, nay đã đóng.
- **S3 (rate limiting)** — `globalTierLimiter` + `authTierLimiter` đã wire cho toàn `/api` và các route auth-tier.
- **S2 (upload path traversal + fileFilter)** — `validateUploadUserId` + `fileFilter` whitelist mimetype (ảnh/video/tài liệu) trong `src/api/middlewares/upload.ts`, wire vào `util.route.ts`.
- **S4 (graceful shutdown)** — `src/server.ts` sửa lại đúng thứ tự `server.close()` → đóng Mongo/Redis/queue → `process.exit(0)`, có force-exit timeout, xử lý cả `SIGTERM`.
- **A3 (tách BullMQ worker)** — `src/worker.ts` là process riêng, không còn chạy chung HTTP server.
- **A4 (index Message/Notification)** — đã thêm 2 index theo đúng đề xuất.
- **JS→TS migrate** — không còn file `.js` nào trong `src/` (mục nợ kỹ thuật ở trên).
- **S5, S6, S7, A11, A12 (+A12b), A13, A14 (module Notification)** — epic `notification-fixes` (merge `master` @ `e1b36af`, 2026-08-12). Verify qua `epic-verify` (EPIC_COMPLETE, quality 5/5, 0 critical/high gap) với bằng chứng hạ tầng thật: DB seed 214k+ document, `explain("executionStats")` xác nhận `IXSCAN` không `COLLSCAN`, HTTP smoke thật xác nhận không rò rỉ chéo user + badge tắt đúng, 2 negative-control test (sabotage rồi revert) xác nhận test suite không xanh giả.

---

## 4. Checklist triển khai để đạt mức Production thật

> Đánh dấu `[x]` khi hoàn thành. Sắp theo nhóm, có gợi ý effort (Thấp/Trung bình/Cao).

### P0 — Phải làm trước khi có traffic thật

- [x] Thêm `express-rate-limit` (hoặc tương đương) cho `/auth/login`, `/auth/signup`, tạo post, tìm kiếm tin nhắn (S3) — *Thấp*
- [x] Thêm `limits` (fileSize, files) + `fileFilter` (whitelist mimetype) cho `multer`; sanitize/validate `userId` trước khi ghép vào path upload (S2) — *Thấp*
- [x] Sửa `SIGINT` handler: chuyển `process.exit()` vào trong callback của `server.close()`, exit code `0` cho shutdown bình thường; thêm timeout ép thoát nếu connection không đóng kịp (S4) — *Thấp*
- [ ] Bọc các thao tác đếm-đi-kèm-document (follow/unfollow, like/unlike, v.v.) trong `mongoose.startSession().withTransaction()` (S1) — *Trung bình*
- [ ] Thêm `secure: true` cho cookie JWT khi `NODE_ENV=production` (A6) — *Rất thấp*
- [x] Thêm `protectRoute` cho `notification.route.ts`, lấy `userId` từ `req.user` thay vì body — bỏ hẳn param `userId` khỏi request (S5) — *Thấp*
- [x] Check `fromUser === socket.user?.userId` ở đầu `NotificationController.create` (socket), mirror pattern đã có ở `likePost` (S6) — *Rất thấp*
- [x] Dùng `(socket as any).user?.userId` (JWT) thay vì `payload.userId` (client tự khai) ở `user/connect` (S7, phát hiện khi làm S6) — *Rất thấp*

### P1 — Nên làm sớm, ảnh hưởng trực tiếp đến độ tin cậy/hiệu năng

- [x] Thêm index `{conversationId: 1, createdAt: -1}` cho `Message`, `{toUsers: 1, createdAt: -1}` cho `Notification` (A4) — *Rất thấp*
- [ ] Escape input trước khi đưa vào `$regex`, hoặc chuyển tìm kiếm tin nhắn sang Mongo `$text` index (A5) — *Thấp*
- [ ] Wire cron rebuild/cleanup ZSET đúng đặc tả FR-8 gốc (A7) — *Trung bình*
- [ ] Thêm endpoint `/health` (readiness: check Mongo + Redis ping) và `HEALTHCHECK` trong `Dockerfile` (A8) — *Thấp*
- [ ] Thiết lập CI (GitHub Actions): chạy `npm test` + `npx tsc --noEmit` trên mỗi PR, chặn merge khi fail (nợ kỹ thuật CI/CD) — *Thấp*
- [ ] Thêm ESLint (+ Prettier nếu chưa nhất quán format) và chạy trong CI — *Thấp*
- [x] Thêm field `isRead` (không `readAt` — chưa cần) vào `Notification`, wire route `PATCH /notifications/read`, sửa lại điểm set `hasNewNotify` cho đúng user (vá luôn bug `ObjectId(toUsers)` là mảng) (A11) — *Trung bình*
- [x] Sửa dedupe khi tạo notification để xét thêm `target` (cả 2 code path: generic create + unlike/A12b) (A12) — *Thấp*
- [x] Sửa `getUserSocketByUserId`/call site để nhận đúng nhiều `toUsers` (A13) — *Thấp*
- [x] Thêm filter theo `action` vào `getNotificationsSchema` (A14) — *Thấp* — đã xác nhận với chủ dự án (FE có tab lọc, dù hiện lọc client-side, chưa gọi param mới)

### P2 — Cần thiết trước khi tự tin gọi là "production"

- [ ] Chuyển `tsx`/`typescript` từ `devDependencies` sang `dependencies` **hoặc** thêm bước `tsc` build thật và chạy image bằng JS đã compile, không JIT-transpile lúc chạy (A9) — *Trung bình*
- [ ] Thêm `USER node` (non-root) trong `Dockerfile`, review lại toàn bộ Dockerfile theo hardening checklist cơ bản (A10) — *Thấp*
- [ ] Cấu hình secret management thật (không `.env` commit/copy tay) — Docker secrets, hoặc vault/parameter store tuỳ nơi deploy — *Trung bình*
- [ ] Thêm structured logging (JSON) + tích hợp error tracking (Sentry hoặc tương đương) thay cho `console.log`/`console.error` rải rác — *Trung bình*
- [ ] Viết test cho các luồng ngoài feed: auth, message, notification, upload, report/moderation — hiện chỉ feed có coverage đáng kể — *Cao*
- [ ] Thêm API documentation (OpenAPI/Swagger) cho toàn bộ router — *Trung bình*

### P3 — Chuẩn bị cho scale ngang thật sự (nhiều instance)

- [ ] ⏸ Thêm `@socket.io/redis-adapter` để chia sẻ registry socket giữa các instance (A1) — *Trung bình* — **hoãn có chủ đích 2026-08-12**, chưa cần vì chưa scale ngang `app`
- [ ] ⏸ Chuyển cron sang cơ chế có leader election (ví dụ lock qua Redis, hoặc scheduler ngoài — K8s CronJob riêng) thay vì `node-cron` in-process (A2) — *Trung bình* — **hoãn có chủ đích 2026-08-12**, cùng lý do A1
- [x] Tách BullMQ worker (`initFanoutWorkers`) ra khỏi process HTTP server thành service/deployment riêng, scale độc lập theo queue depth (A3) — *Cao*
- [ ] Chuyển MongoDB sang replica set (tối thiểu 3 node) để có failover thật + hỗ trợ transaction đáng tin cậy hơn (S1 phụ thuộc vào đây) — *Cao*
- [ ] Đưa Redis lên chế độ có HA (Sentinel/Cluster) nếu feed/queue là đường sống còn — *Cao*
- [ ] Thêm load balancer + horizontal pod/container autoscaling trước app tier — *Cao*

### Nợ kỹ thuật / dọn dẹp lâu dài (không chặn go-live nhưng nên có lộ trình)

- [x] Hoàn tất migrate JS → TS cho toàn bộ `models`/`routers`/`middlewares` để nhất quán với tầng feed — *Cao*
- [ ] Đánh giá chiến lược rotate/archive cho collection analytics theo-ngày trước khi số lượng collection trở thành vấn đề vận hành — *Trung bình*
- [ ] Ghi rõ trong tài liệu vận hành: hệ thống hiện là single-instance-by-design (Mongo/Redis/app đều 1 node) — để người review sau không hiểu nhầm là oversight — *Rất thấp*

---

## 5. Ghi chú

Tài liệu này là bản chụp tại thời điểm review; nhiều chi tiết (đặc biệt số dòng file) có thể lệch nếu
code tiếp tục thay đổi — dùng path/tên hàm để tra cứu lại vị trí chính xác khi bắt tay triển khai
checklist. Nên review lại tài liệu này sau khi hoàn thành mỗi nhóm ưu tiên (P0 → P1 → P2 → P3).
