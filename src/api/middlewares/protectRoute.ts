import jwt from "jsonwebtoken";
import HTTPStatus from "../../utils/httpStatus.js";
import logger from "../../core/logger.js";
import User from "../models/user.model.js";
import RefreshToken from "../models/refreshToken.model.js";
import { hashToken } from "../utils/generateTokens.js";
import {
  ACCOUNT_RESTRICTED_CODE,
  isAccountRestricted,
} from "../../utils/accountStatus.js";

// Avoid writing to the DB on every single request; only refresh the
// timestamp once it's gone stale.
const LAST_ACTIVE_THROTTLE_MS = 5 * 60 * 1000;

const protectRoute = async (req, res, next) => {
  try {
    // Primary: Authorization header (access token)
    // Fallback: legacy cookie (backward compat during transition)
    const token =
      (req.headers.authorization?.startsWith("Bearer ")
        ? req.headers.authorization.split(" ")[1]
        : null) || req.cookies?.jwt;

    let userId: string | null = null;

    if (token) {
      const decoded: any = jwt.verify(token, process.env.JWT_SECRET);
      userId = decoded.userId;
    } else if (req.cookies?.refreshToken) {
      // Fallback for SSR requests: verify identity from active refresh token in DB
      const hashedToken = hashToken(req.cookies.refreshToken);
      const stored = await RefreshToken.findOne({
        token: hashedToken,
        expiresAt: { $gt: new Date() },
      });
      if (stored) {
        userId = stored.userId.toString();
      }
    }

    if (!userId) {
      return res
        .status(HTTPStatus.UNAUTHORIZED)
        .json({ message: "Unauthorized" });
    }

    const user = await User.findById(userId).select("-password");

    // Bước 6 (V9): chặn tài khoản LOCK/BANNED ở ĐÂY, không chỉ ở `loginUser`. Access token sống 30
    // phút và refresh token 7 ngày, nên chặn-lúc-đăng-nhập một mình để lọt cả một cửa sổ dài user
    // vừa bị cấm vẫn thao tác bình thường bằng token đã cấp trước đó. Trước bước này, "ban" chỉ có
    // tác dụng trên UI (`BannedPage.tsx`) — probe V9 xác nhận tài khoản BANNED vẫn login và gọi
    // `GET /users/me` thành công.
    if (user && isAccountRestricted(user.status)) {
      return res.status(HTTPStatus.FORBIDDEN).json({
        message: "Tài khoản đang bị hạn chế",
        code: ACCOUNT_RESTRICTED_CODE,
      });
    }

    req.user = user;

    if (
      user &&
      (!user.lastActiveAt ||
        Date.now() - user.lastActiveAt.getTime() > LAST_ACTIVE_THROTTLE_MS)
    ) {
      User.updateOne({ _id: user._id }, { lastActiveAt: new Date() }).catch(
        (err) => logger.error({ err }, "Error updating lastActiveAt")
      );
    }

    next();
  } catch (err) {
    // Differentiate between expired token and other errors so the FE
    // interceptor can trigger a silent refresh on expiry.
    if (err.name === "TokenExpiredError") {
      return res
        .status(HTTPStatus.UNAUTHORIZED)
        .json({ message: "Token expired", code: "TOKEN_EXPIRED" });
    }
    res.status(HTTPStatus.SERVER_ERR).json({ message: err.message });
    logger.error({ err }, "Error in protectRoute");
  }
};

export default protectRoute;
