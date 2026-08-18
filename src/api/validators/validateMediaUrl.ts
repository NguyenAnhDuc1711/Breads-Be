// Hàm validate URL media DÙNG CHUNG (task 003, epic presigned-media-upload) — chặn "URL injection"
// cho 2 call site: sendMessage (task 010) và createPost (task 011). Xem epic.md AD-2/AD-4/AD-5 cho
// thứ tự gọi hàm này ở call site (GIF carve-out + flag break-glass PHẢI check trước, không phải ở
// đây — hàm này không tự biết gì về GIF hay flag, chỉ validate 1 URL đơn thuần).
//
// Hàm THUẦN theo nghĩa: không throw, không side-effect, kết quả chỉ phụ thuộc `url`/`options` VÀ
// `process.env.CLOUDINARY_CLOUD_NAME` (config Cloudinary bình thường, KHÔNG phải flag khẩn cấp
// `MEDIA_LEGACY_FALLBACK_ENABLED` — nguyên tắc "không tự đọc process.env" chỉ áp dụng cho flag đó,
// xem 003.md Implementation Steps #3 và mediaConvention.ts).
import { parsePublicId } from "../services/mediaConvention.js";

export interface ValidateMediaUrlOptions {
  namespace: "message" | "post";
  expectedKey?: string;
}

export const validateMediaUrl = (
  url: string,
  options: ValidateMediaUrlOptions,
): boolean => {
  if (typeof url !== "string" || url.length === 0) return false;

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  if (!cloudName) return false;

  // Domain phải khớp CHÍNH XÁC Cloudinary account đang cấu hình — không chấp nhận domain
  // Cloudinary khác/domain bất kỳ (kể cả `data:` URI base64 hay host ảnh ngoài như Unsplash).
  const domainPrefix = `https://res.cloudinary.com/${cloudName}/`;
  if (!url.startsWith(domainPrefix)) return false;

  const parsed = parsePublicId(url);
  if (!parsed) return false;
  if (parsed.namespace !== options.namespace) return false;

  // STRICT mode: biết chính xác key (sortedPairId/authorId) của entity đang tạo, phải khớp tuyệt đối.
  if (options.expectedKey !== undefined) {
    return parsed.key === options.expectedKey;
  }

  // LOOSE mode: chỉ cần đúng namespace (không dùng ở call site nào trong epic này, giữ lại để tái
  // dùng sau — xem 003.md Description #5).
  return true;
};
