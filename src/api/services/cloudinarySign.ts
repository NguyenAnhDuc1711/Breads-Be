import cloudinary from "cloudinary";
import {
  generatePublicId,
  type GeneratePublicIdContext,
  type MediaEntityType,
} from "./mediaConvention.ts";

export const CLOUDINARY_VIDEO_RESOURCE_TYPE = "video";
export const CLOUDINARY_IMAGE_RESOURCE_TYPE = "image";

export const resolveResourceType = (mediaType?: string): string =>
  mediaType === "video"
    ? CLOUDINARY_VIDEO_RESOURCE_TYPE
    : CLOUDINARY_IMAGE_RESOURCE_TYPE;

const apiSignRequest: (params: Record<string, unknown>, apiSecret: string) => string =
  (cloudinary as any).utils.api_sign_request;

export interface SignBatchInput {
  entityType: MediaEntityType;
  count: number;
  context: GeneratePublicIdContext;
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

  const timestamp = Math.round(Date.now() / 1000);

  const signatures: SignedUpload[] = [];
  for (let i = 0; i < count; i++) {
    const publicId = generatePublicId(entityType, context);
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
