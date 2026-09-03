import crypto from "crypto";
import jwt from "jsonwebtoken";
import RefreshToken from "../models/refreshToken.model.js";

const ACCESS_TOKEN_EXPIRES_IN = "30m";
const REFRESH_TOKEN_EXPIRES_IN_MS = 7 * 24 * 60 * 60 * 1000;

export const hashToken = (token: string): string => {
  return crypto.createHash("sha256").update(token).digest("hex");
};

const generateRefreshTokenString = (): string => {
  return crypto.randomBytes(40).toString("hex");
};

export const generateAccessToken = (userId: string): string => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_EXPIRES_IN,
  });
};

const isSecureCookie = (): boolean => process.env.COOKIE_SECURE !== "false";

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

const generateTokens = async (
  userId: string,
  res: any,
): Promise<{ accessToken: string }> => {
  const accessToken = generateAccessToken(userId);
  await generateRefreshToken(userId, res);
  return { accessToken };
};

export const clearRefreshTokenCookie = (res: any): void => {
  res.cookie("refreshToken", "", {
    httpOnly: true,
    maxAge: 0,
    sameSite: "lax",
    secure: isSecureCookie(),
    path: "/",
  });
  res.cookie("jwt", "", { maxAge: 0 });
};

export default generateTokens;
