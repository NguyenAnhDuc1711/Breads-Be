// Quy ước DUY NHẤT cho Cloudinary `public_id` (task 001, epic presigned-media-upload).
// Dùng bởi: task 002 (sinh chữ ký upload), task 003 (`validateMediaUrl`), và về sau cho
// content moderation (PRD FR-3). Không định nghĩa lại quy ước này ở nơi khác.
//
// Cũng là nơi định nghĩa DUY NHẤT flag "break-glass" `MEDIA_LEGACY_FALLBACK_ENABLED` (AD-5) —
// các module khác nhận giá trị flag qua tham số, không tự đọc `process.env`.
import { ObjectId } from "../../utils/index.js";

export type MediaEntityType = "message" | "post";

export interface GeneratePublicIdContext {
  senderId?: string;
  recipientId?: string;
  authorId?: string;
}

export interface ParsedPublicId {
  namespace: "message" | "post";
  key: string;
  generatedId: string;
}

export const generatePublicId = (
  entityType: MediaEntityType,
  context: GeneratePublicIdContext,
): string => {
  const generatedId = ObjectId().toString();

  if (entityType === "message") {
    const { senderId, recipientId } = context;
    if (!senderId || !recipientId) {
      throw new Error(
        'generatePublicId: entityType="message" yêu cầu senderId và recipientId',
      );
    }
    // Sắp xếp cố định, không theo thứ tự ai là sender — 1 cặp user luôn ra đúng 1 prefix (AD-2).
    const sortedPairId = [senderId, recipientId].sort().join("_");
    return `message/${sortedPairId}/${generatedId}`;
  }

  if (entityType === "post") {
    const { authorId } = context;
    if (!authorId) {
      throw new Error('generatePublicId: entityType="post" yêu cầu authorId');
    }
    return `post/${authorId}/${generatedId}`;
  }

  throw new Error(`generatePublicId: entityType không hợp lệ: ${entityType}`);
};

// Khớp `message/{key}/{generatedId}` hoặc `post/{key}/{generatedId}`, dù đứng riêng (public_id
// thô) hay nằm cuối 1 URL Cloudinary đầy đủ (có thể kèm đuôi file và query/hash).
const PUBLIC_ID_PATTERN =
  /(?:^|\/)(message|post)\/([^/?#]+)\/([^/?#.]+)(?:\.[a-zA-Z0-9]+)?(?:[?#].*)?$/;

export const parsePublicId = (
  urlOrPublicId: string,
): ParsedPublicId | null => {
  if (!urlOrPublicId) return null;

  const match = urlOrPublicId.match(PUBLIC_ID_PATTERN);
  if (!match) return null;

  const [, namespace, key, generatedId] = match;
  return { namespace: namespace as "message" | "post", key, generatedId };
};

// Flag khẩn cấp (AD-5) — mặc định TẮT (`false`), chỉ bật khi set rõ `"true"` (so sánh chặt).
export const isMediaLegacyFallbackEnabled = (): boolean =>
  process.env.MEDIA_LEGACY_FALLBACK_ENABLED === "true";
