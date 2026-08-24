// Config cho Post service, cùng convention đọc `process.env.*` với `feed/config.ts`
// (biến môi trường UPPER_SNAKE_CASE, prefix domain `POST_`).

/**
 * --- Rollback runbook: POST_RESPONSE_FIELD_FILTER_ENABLED (FR-5, NFR-4) ---
 *
 * Mục đích: gate việc lược field optional rỗng (survey/files/...) khỏi response Post,
 * tách thời điểm deploy code khỏi thời điểm hành vi API thực sự đổi (xem AD-3 trong
 * epic.md) — cho phép FE ổn định trước khi bật ở production.
 *
 * Bật (dev/staging):
 *   1. Set `POST_RESPONSE_FIELD_FILTER_ENABLED=true` trong `.env`.
 *   2. Restart process (`npm run dev` / `npm run worker:dev`).
 *
 * Bật ở production:
 *   1. Đổi biến môi trường trên hạ tầng deploy đang giữ env production (nơi các biến
 *      như `MONGO_URI`, `JWT_SECRET` hiện đang được quản lý) — chỉ người quản trị hạ
 *      tầng deploy có quyền đổi biến này.
 *   2. Restart service. KHÔNG cần build/deploy lại code — flag đọc runtime lúc import
 *      module.
 *
 * Rollback khẩn cấp (mục tiêu NFR-4: ≤15 phút):
 *   1. Đổi `POST_RESPONSE_FIELD_FILTER_ENABLED` về `false` (hoặc unset — mặc định đã
 *      là OFF) trên env production.
 *   2. Restart service.
 *   3. Xác nhận response Post trả đầy đủ field trở lại.
 *   Ước tính: đổi env var (~2 phút) + restart (~1-3 phút) + xác nhận (~2 phút) => ~5-10
 *   phút, trong ngưỡng NFR-4.
 */
export const boolFlag = (raw: string | undefined): boolean => raw === "true";

export const POST_CONFIG = Object.freeze({
  // Mặc định OFF (khác `fanoutEnabled` của feed dùng `!== "false"` mặc định ON) vì đây
  // là tính năng MỚI, cần mặc định an toàn cho tới khi FE xác nhận ổn định.
  responseFieldFilterEnabled: boolFlag(
    process.env.POST_RESPONSE_FIELD_FILTER_ENABLED,
  ),
});
