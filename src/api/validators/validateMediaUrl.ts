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

  const domainPrefix = `https://res.cloudinary.com/${cloudName}/`;
  if (!url.startsWith(domainPrefix)) return false;

  const parsed = parsePublicId(url);
  if (!parsed) return false;
  if (parsed.namespace !== options.namespace) return false;

  if (options.expectedKey !== undefined) {
    return parsed.key === options.expectedKey;
  }

  return true;
};
