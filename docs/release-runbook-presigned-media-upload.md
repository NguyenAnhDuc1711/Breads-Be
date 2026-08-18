# Release Runbook — Presigned Media Upload (Cloudinary Signed Upload cutover)

> Epic: `presigned-media-upload`. Liên quan flag break-glass `MEDIA_LEGACY_FALLBACK_ENABLED` (task 001,
> `src/api/services/mediaConvention.ts`, hàm `isMediaLegacyFallbackEnabled()`) và `MEDIA_PATH` mới trong
> submodule `Breads-Shared` (task 002).

## Bối cảnh & giả định

- Dự án là **capstone, không có CI/CD tự động, không dashboard, không alerting**. Mọi bước trong runbook
  này là thao tác **THỦ CÔNG** — người thực hiện (dev) phải tự chạy lệnh, tự đọc kết quả, tự quyết định
  tiếp tục hay dừng. Không có hệ thống nào nhắc nhở nếu bỏ sót bước.
- Runbook này giả định người đọc **không có ngữ cảnh trước** về epic — mọi thuật ngữ dùng trong file được
  giải thích ngay tại chỗ dùng lần đầu.
- **Thứ tự các bước dưới đây là bắt buộc.** Không đảo bước, không bỏ qua bước smoke-check dù có tự tin
  code đã đúng — đây là lần đầu tiên repo có runbook loại này, không có tiền lệ để dựa vào.

---

## Phần A — Thứ tự deploy bắt buộc

- [ ] **A1. Merge + deploy submodule `Breads-Shared`.**
  Submodule `Breads-Shared` (nằm ở `src/Breads-Shared` trong cả 2 repo `Breads-Be` và `Breads-Fe`) chứa
  file `APIConfig.ts` với nhóm hằng số `MEDIA_PATH` (đường dẫn REST endpoint ký chữ ký batch, vd.
  `MEDIA_PATH.SIGN_UPLOAD`) do task 002 thêm. Merge PR của submodule trước, sau đó bump pinned commit
  (con trỏ SHA) ở **cả 2 repo** — `Breads-Be` và `Breads-Fe` — trỏ về đúng commit mới.

- [ ] **A2. Xác nhận SHA submodule khớp ở CẢ 2 repo.**
  Chạy tại root mỗi repo:
  ```bash
  git submodule status
  ```
  Kết quả trả về 1 dòng dạng `<sha> src/Breads-Shared (mô tả)`. **Copy `<sha>` từ output của
  `Breads-Be` và đối chiếu byte-for-byte với `<sha>` từ output của `Breads-Fe`.** Nếu 2 SHA khác nhau —
  DỪNG LẠI, không sang bước A3. Đi bump lại pin ở repo còn thiếu (quay lại A1), commit, rồi chạy lại lệnh
  này cho tới khi khớp.
  > Vì sao bắt buộc: nếu Be trỏ commit mới (đã có `MEDIA_PATH`) nhưng Fe còn trỏ commit cũ, code Fe sẽ
  > không biên dịch được / gọi sai đường dẫn — không phải lỗi runtime tinh vi mà là lỗi rõ ràng ngay khi
  > build Fe, nhưng vẫn nên xác nhận trước khi tốn công deploy.

- [ ] **A3. Deploy `Breads-Be`.**
  Deploy backend theo quy trình hiện có của dự án (build + restart process — xem ghi chú restart ở Phần
  B và Phần C, vì flag `MEDIA_LEGACY_FALLBACK_ENABLED` chỉ được đọc lúc process boot).

- [ ] **A4. Smoke-check cụ thể — xem Phần B ngay bên dưới. KHÔNG bỏ qua bước này.**
  Chỉ được sang A5 sau khi hoàn thành toàn bộ Phần B và xác định rõ kết quả (pass hoặc fail-với-hành-động).

- [ ] **A5. Deploy `Breads-Fe`.**
  Chỉ thực hiện sau khi Phần B đã hoàn tất (pass thẳng, hoặc fail đã xử lý bằng flag ở Phần B).

---

## Phần B — Smoke-check cụ thể (bắt buộc ngay sau A3, trước A5)

> Mục đích: đây là **cơ chế phát hiện duy nhất** khi Be đã deploy nhưng Fe chưa (hoặc lệch giờ) — vì repo
> không có dashboard/alerting tự động, con người phải tự gửi ảnh test và tự đọc kết quả.

### B1. Test 1 — ảnh dưới 1MB qua flow message (socket `sendMessage`)

- [ ] Chuẩn bị 1 ảnh **dưới 1MB** (bất kỳ định dạng ảnh hợp lệ, không phải GIF để test đúng nhánh
  `validateMediaUrl`/flag — GIF có carve-out riêng, không phản ánh đúng luồng cần test ở đây).
- [ ] Gửi ảnh qua flow tạo tin nhắn bình thường (client thật hoặc test script gọi socket event
  `message/create`/`sendMessage`).
- [ ] **Tiêu chí PASS:** message được tạo thành công, `media.url` trong response/DB có dạng
  `res.cloudinary.com/...`, không có lỗi callback nào từ socket.
- [ ] **Tiêu chí FAIL:** có lỗi trả về (callback error, reject, timeout, hoặc `media.url` không đúng
  dạng Cloudinary).

  > **Vì sao giới hạn dưới 1MB, không phải "1 ảnh test" chung chung:** đường socket có giới hạn transport
  > riêng (`maxHttpBufferSize`, hiện tại 1MB) không liên quan gì tới epic này hay tới flag. Ảnh **trên**
  > 1MB gửi qua socket sẽ bị Engine.IO drop packet ở tầng transport **trước khi code app-layer (kể cả
  > flag `MEDIA_LEGACY_FALLBACK_ENABLED`) kịp chạy**. Nếu test bằng ảnh lớn hơn 1MB rồi thấy fail, đó
  > **không phải** bằng chứng "flag chưa hoạt động" hay "Be/Fe lệch deploy" — đó là giới hạn transport có
  > sẵn, không liên quan tới flag. Dùng đúng ảnh dưới 1MB để tránh chẩn đoán sai nguyên nhân.

### B2. Test 2 — ảnh 4-11MB qua flow post (REST `createPost`)

- [ ] Chuẩn bị 1 ảnh trong khoảng **4-11MB**.
- [ ] Gửi ảnh qua flow tạo post bình thường (client thật hoặc gọi trực tiếp REST `createPost`).
- [ ] **Tiêu chí PASS:** post được tạo thành công, `media.url` trong response/DB có dạng
  `res.cloudinary.com/...`, không có lỗi HTTP (không phải 4xx/5xx).
- [ ] **Tiêu chí FAIL:** response trả lỗi (4xx/5xx) hoặc `media.url` không đúng dạng Cloudinary.

### B3. Diễn giải kết quả — hành động cụ thể, không phải "hy vọng đúng giờ"

- [ ] **Nếu CẢ B1 và B2 đều PASS** → tiếp tục sang bước A5 (deploy Fe) bình thường. **KHÔNG cần bật
  flag.**
- [ ] **Nếu 1 trong 2 (hoặc cả 2) FAIL:**
  1. [ ] Đọc log backend ngay lập tức để xác định nguyên nhân cụ thể — **KHÔNG vội kết luận** đây là do
     Be/Fe lệch deploy chỉ vì test fail.
  2. [ ] **Chỉ khi** nguyên nhân xác định rõ là do **client cũ / Fe chưa deploy** gửi payload dạng cũ
     (`data:` base64 thay vì URL đã ký) — không phải bug khác (lỗi code, lỗi cấu hình Cloudinary, lỗi
     mạng...) — thì mới thực hiện:
     - [ ] Đặt biến môi trường `MEDIA_LEGACY_FALLBACK_ENABLED=true` trên máy chủ chạy `Breads-Be`.
     - [ ] **Restart lại process `Breads-Be`** (không phải hot-reload). Bắt buộc vì `dotenv` chỉ load
       biến môi trường lúc **boot** process — xác nhận tại `src/server.ts:1`
       (`import "dotenv/config";`, dòng đầu tiên của file entrypoint). Đổi biến env mà không restart sẽ
       **không có tác dụng gì**, flag vẫn đọc giá trị cũ.
     - [ ] Lặp lại B1/B2 sau restart để xác nhận flag đã có tác dụng (client cũ giờ đi qua nhánh fallback
       `uploadFileFromBase64`, không còn bị reject).
     - [ ] Tiếp tục sang A5 (deploy Fe).
  3. [ ] **Nếu nguyên nhân KHÔNG phải do lệch deploy** (vd. lỗi Cloudinary credentials, lỗi network, bug
     code khác) — sửa đúng nguyên nhân gốc, **không bật flag** (bật flag không giải quyết được lỗi không
     liên quan tới base64/legacy client), rồi lặp lại toàn bộ Phần B từ đầu trước khi sang A5.

---

## Phần C — Bước dọn dẹp sau khi Fe deploy xong (tắt flag)

> Flag `MEDIA_LEGACY_FALLBACK_ENABLED` là **lối thoát khẩn cấp tạm thời**, không phải trạng thái vận
> hành bình thường. Để bật quên sẽ khiến code path base64 cũ tiếp tục hoạt động âm thầm, giảm động lực
> phát hiện client nào chưa cập nhật, và giữ nguyên rủi ro bảo mật mà epic này vốn muốn loại bỏ.

- [ ] **C1.** Sau khi `Breads-Fe` đã deploy xong (bước A5), xác nhận Fe hoạt động bình thường bằng cách
  lặp lại **đúng B1 và B2** (cùng 2 kích thước ảnh, cùng tiêu chí pass/fail) — lần này qua client Fe thật
  (không phải test script), để xác nhận toàn bộ luồng thật hoạt động đúng.
- [ ] **C2.** Chỉ sau khi C1 pass, **tắt flag**: đặt `MEDIA_LEGACY_FALLBACK_ENABLED=false` (hoặc xoá hẳn
  biến môi trường khỏi cấu hình) trên máy chủ `Breads-Be`.
- [ ] **C3. Restart lại process `Breads-Be`** — lý do restart giống hệt B3.2 (`dotenv` load lúc boot,
  đổi env không restart sẽ không có tác dụng). Nếu flag ở bước B3 chưa từng được bật (test B1/B2 pass
  ngay từ đầu), bước C2/C3 vẫn nên chạy để xác nhận tường minh flag đang ở trạng thái tắt (giá trị mặc
  định), không dựa vào giả định "chưa đụng vào thì chắc vẫn tắt".
- [ ] **C4.** Sau restart, lặp lại nhanh B1 (ảnh dưới 1MB qua socket) một lần nữa để xác nhận hệ thống
  vẫn hoạt động bình thường với flag tắt — đảm bảo việc tắt flag không vô tình làm gãy luồng chính.

---

## Ghi chú vận hành chung

- Toàn bộ checklist trên **không có bước nào tự động** — không có CI job, không có health-check dashboard,
  không có cảnh báo tự động nếu bỏ sót. Người thực hiện release chịu trách nhiệm tick từng ô và tự xác
  nhận kết quả bằng mắt (đọc response/log trực tiếp).
- Nếu release bị gián đoạn giữa chừng (vd. dừng sau A3, chưa kịp làm Phần B) — **lần quay lại phải bắt
  đầu lại từ Phần B**, không giả định trạng thái cũ vẫn còn đúng.
- File này là **tiền lệ runbook đầu tiên** trong `docs/` của repo — nếu các epic sau cần runbook tương
  tự, có thể dùng cấu trúc 3 phần (thứ tự deploy / smoke-check cụ thể / dọn dẹp) làm mẫu.
