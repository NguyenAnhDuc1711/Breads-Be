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

export const isMediaLegacyFallbackEnabled = (): boolean =>
  process.env.MEDIA_LEGACY_FALLBACK_ENABLED === "true";
