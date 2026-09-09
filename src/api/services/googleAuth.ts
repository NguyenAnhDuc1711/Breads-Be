import { OAuth2Client } from "google-auth-library";
import { AuthFailureError, ErrorResponse } from "../../core/error.response.ts";
import HTTPStatus from "../../utils/httpStatus.ts";

export type GoogleProfile = {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
};

/**
 * Phân loại nguyên nhân token hỏng để mỗi phép kiểm (chữ ký, iss, aud, exp)
 * có test riêng — gộp chung thành một lỗi thì một phép kiểm bị bỏ sót vẫn lọt.
 */
export type GoogleTokenErrorCode =
  | "signature"
  | "issuer"
  | "audience"
  | "expired"
  | "invalid";

export class GoogleTokenError extends AuthFailureError {
  code: GoogleTokenErrorCode;

  constructor(code: GoogleTokenErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Thiếu cấu hình là sự cố vận hành của server, không phải lỗi của người dùng. */
export class GoogleAuthConfigError extends ErrorResponse {
  constructor(message = "GOOGLE_CLIENT_ID chưa được cấu hình") {
    super(message, HTTPStatus.SERVER_ERR);
  }
}

// Tạo một lần ở module scope để giữ cache khoá công khai của Google
const client = new OAuth2Client();

const classify = (message: string): GoogleTokenErrorCode => {
  if (message.includes("Wrong recipient")) return "audience";
  if (message.includes("Invalid issuer")) return "issuer";
  if (message.includes("Token used too late")) return "expired";
  if (
    message.includes("Invalid token signature") ||
    message.includes("No pem found for envelope") ||
    message.includes("Wrong number of segments") ||
    message.includes("Can't parse token envelope")
  ) {
    return "signature";
  }
  return "invalid";
};

export async function verifyGoogleIdToken(
  idToken: string,
): Promise<GoogleProfile> {
  // ── CHỐT CHẶN CẤU HÌNH (CRIT-3) ─────────────────────────────
  // PHẢI đứng trước verifyIdToken. `audience` là tham số tuỳ chọn:
  // truyền undefined = thư viện bỏ qua kiểm `aud` mà không báo gì.
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId?.trim()) {
    throw new GoogleAuthConfigError();
  }

  let ticket;
  try {
    ticket = await client.verifyIdToken({ idToken, audience: clientId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new GoogleTokenError(classify(message), message);
  }

  const payload = ticket.getPayload();
  if (!payload) {
    throw new GoogleTokenError("invalid", "Google ID token không có payload");
  }

  return {
    sub: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified === true,
    name: payload.name,
    picture: payload.picture,
  };
}
