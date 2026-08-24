// Config cho User service — cùng convention đọc `process.env.*` với `feed/config.ts`
// (biến môi trường UPPER_SNAKE_CASE, prefix domain `USER_`).

/**
 * --- Rollback runbook: USER_RESPONSE_FIELD_FILTER_ENABLED (mở rộng lean-api-response sang User) ---
 *
 * Mục đích: gate việc lược field optional rỗng (followed/following/collection/links) khỏi response
 * User — tách thời điểm deploy code khỏi thời điểm hành vi API đổi, cùng lý do AD-3 đã dùng cho
 * Post (`POST_RESPONSE_FIELD_FILTER_ENABLED`, đã gỡ sau khi rollout production ổn định). User CHƯA
 * qua rollout thật nên vẫn cần flag, không unconditional ngay như Post hiện tại.
 *
 * Bật: set `USER_RESPONSE_FIELD_FILTER_ENABLED=true` trong `.env`, restart process.
 * Rollback khẩn cấp: đổi về `false` (hoặc unset — mặc định OFF), restart. Cùng ước tính thời gian
 * với Post (~5-10 phút, trong ngưỡng NFR-4).
 */
export const boolFlag = (raw: string | undefined): boolean => raw === "true";

export const USER_CONFIG = Object.freeze({
  // Mặc định OFF — tính năng mới với User, chưa xác nhận FE ổn định qua production như Post.
  responseFieldFilterEnabled: boolFlag(
    process.env.USER_RESPONSE_FIELD_FILTER_ENABLED,
  ),
});
