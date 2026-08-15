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
    secure: process.env.COOKIE_SECURE === "true",
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
    secure: process.env.COOKIE_SECURE === "true",
    path: "/",
  });
  // Also clear the legacy jwt cookie for backward compatibility
  res.cookie("jwt", "", { maxAge: 0 });
};

export default generateTokens;
