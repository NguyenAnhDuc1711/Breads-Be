import crypto from "crypto";
import jwt from "jsonwebtoken";
import RefreshToken from "../models/refreshToken.model.js";

const ACCESS_TOKEN_EXPIRES_IN = "30m";
const REFRESH_TOKEN_EXPIRES_IN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Hash a refresh token with SHA-256 before storing in the database.
 * We never store raw refresh tokens — only their hashes — so a database
 * leak does not directly expose usable tokens.
 */
export const hashToken = (token: string): string => {
  return crypto.createHash("sha256").update(token).digest("hex");
};

/**
 * Generate a cryptographically random opaque refresh token string.
 */
const generateRefreshTokenString = (): string => {
  return crypto.randomBytes(40).toString("hex");
};

/**
 * Issue a short-lived JWT access token.
 */
export const generateAccessToken = (userId: string): string => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_EXPIRES_IN,
  });
};

/**
 * `Secure` cookie: MẶC ĐỊNH BẬT, chỉ tắt được khi khai báo tường minh `COOKIE_SECURE=false`.
 *
 * Trước đây là `=== "true"`, tức mặc định TẮT — và `.env` không hề khai biến này, nên refresh token
 * (sống 7 ngày) đi qua HTTP trần ở mọi môi trường. Đảo chiều mặc định là điểm mấu chốt: cấu hình
 * an toàn phải là cái xảy ra khi người ta KHÔNG làm gì cả.
 *
 * Idiom `!== "false"` dùng lại đúng pattern của `FEED_FANOUT_ENABLED`/`FEED_DISCOVERY_ENABLED`
 * (`services/feed/config.ts`) để cả repo thống nhất một cách đọc cờ boolean.
 *
 * Dev local KHÔNG bị ảnh hưởng: trình duyệt hiện đại coi `http://localhost` là secure context nên
 * vẫn nhận `Secure` cookie. Chỉ khi test qua IP LAN trần (vd `http://192.168.x.x`) mới cần
 * `COOKIE_SECURE=false`.
 */
const isSecureCookie = (): boolean => process.env.COOKIE_SECURE !== "false";

/**
 * Create a new refresh token, persist its hash in MongoDB, and set it as
 * an httpOnly cookie on the response.
 *
 * Returns the raw (unhashed) refresh token string so the caller can
 * include it in the response if needed, but typically the cookie is
 * the only transport channel.
 */
export const generateRefreshToken = async (
  userId: string,
  res: any,
): Promise<string> => {
  const rawToken = generateRefreshTokenString();
  const hashedToken = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRES_IN_MS);

  await RefreshToken.create({
    token: hashedToken,
    userId,
    expiresAt,
  });

  res.cookie("refreshToken", rawToken, {
    httpOnly: true,
    maxAge: REFRESH_TOKEN_EXPIRES_IN_MS,
    sameSite: "lax",
    secure: isSecureCookie(),
    path: "/",
  });

  return rawToken;
};

/**
 * Convenience wrapper: generate both tokens and set the refresh cookie.
 * Returns the access token (to be sent in the response body).
 */
const generateTokens = async (
  userId: string,
  res: any,
): Promise<{ accessToken: string }> => {
  const accessToken = generateAccessToken(userId);
  await generateRefreshToken(userId, res);
  return { accessToken };
};

/**
 * Clear the refresh token cookie (used during logout).
 */
export const clearRefreshTokenCookie = (res: any): void => {
  res.cookie("refreshToken", "", {
    httpOnly: true,
    maxAge: 0,
    sameSite: "lax",
    secure: isSecureCookie(),
    path: "/",
  });
  // Also clear the legacy jwt cookie for backward compatibility
  res.cookie("jwt", "", { maxAge: 0 });
};

export default generateTokens;
