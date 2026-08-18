// Cấp chữ ký Cloudinary Signed Upload theo BATCH (epic presigned-media-upload, task 002 —
// FR-1/FR-2/FR-7).
//
// Khác `uploadFileFromBase64` (`src/api/utils/index.ts:5`) ở chỗ: ở đây backend KHÔNG chạm tới
// bytes. Chỉ ký `{public_id, timestamp}` rồi trả về cho client tự POST thẳng lên Cloudinary.
// `api_secret` không bao giờ rời server.
//
// Quy tắc bất biến: `public_id` sinh từ `generatePublicId` (task 001) với context lấy từ AUTH,
// không phải từ body client — xem `media.controller.ts`. Chữ ký ràng buộc `public_id`, nên client
// không thể đổi đích upload sang namespace/người khác mà chữ ký vẫn hợp lệ.
import cloudinary from "cloudinary";
import {
  generatePublicId,
  type GeneratePublicIdContext,
  type MediaEntityType,
} from "./mediaConvention.ts";

// Cloudinary phân loại asset theo `resource_type` và nó nằm TRONG URL upload
// (`/v1_1/{cloud}/{resource_type}/upload`). Video bắt buộc `video`; image và gif đều là `image`
// (gif là 1 định dạng ảnh với Cloudinary, không phải resource type riêng) — FR-7.
export const CLOUDINARY_VIDEO_RESOURCE_TYPE = "video";
export const CLOUDINARY_IMAGE_RESOURCE_TYPE = "image";

export const resolveResourceType = (mediaType?: string): string =>
  mediaType === "video"
    ? CLOUDINARY_VIDEO_RESOURCE_TYPE
    : CLOUDINARY_IMAGE_RESOURCE_TYPE;

// Type khai báo của package `cloudinary` thiếu `utils` trên default export (lỗi tsc có sẵn ở
// `src/api/utils/index.ts:14`). Cast hẹp tại đúng 1 chỗ để không thêm lỗi tsc mới.
const apiSignRequest: (params: Record<string, unknown>, apiSecret: string) => string =
  (cloudinary as any).utils.api_sign_request;

export interface SignBatchInput {
  entityType: MediaEntityType;
  count: number;
  /** Danh tính người ký — LUÔN lấy từ `req.user`, không bao giờ từ `req.body`. */
  context: GeneratePublicIdContext;
  /** `items[i].type` mô tả file thứ i; vắng mặt -> mặc định image. */
  items?: { type?: string }[];
}

export interface SignedUpload {
  signature: string;
  timestamp: number;
  apiKey: string;
  cloudName: string;
  publicId: string;
  resourceType: string;
}

export const signBatch = ({
  entityType,
  count,
  context,
  items,
}: SignBatchInput): SignedUpload[] => {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME ?? "";
  const apiKey = process.env.CLOUDINARY_API_KEY ?? "";
  const apiSecret = process.env.CLOUDINARY_API_SECRET ?? "";

  // 1 timestamp cho cả batch: Cloudinary chỉ dùng nó để kiểm tra chữ ký còn trong cửa sổ hợp lệ,
  // và cả batch được cấp trong cùng 1 request nên không có lý do để lệch nhau.
  const timestamp = Math.round(Date.now() / 1000);

  const signatures: SignedUpload[] = [];
  for (let i = 0; i < count; i++) {
    const publicId = generatePublicId(entityType, context);
    // Ký ĐÚNG tập tham số mà client sẽ gửi kèm (ngoài `file`/`api_key`/`signature`). Thêm/bớt
    // param ở client mà không ký lại -> Cloudinary từ chối, đúng như mong muốn.
    const signature = apiSignRequest(
      { public_id: publicId, timestamp },
      apiSecret,
    );

    signatures.push({
      signature,
      timestamp,
      apiKey,
      cloudName,
      publicId,
      resourceType: resolveResourceType(items?.[i]?.type),
    });
  }

  return signatures;
};
