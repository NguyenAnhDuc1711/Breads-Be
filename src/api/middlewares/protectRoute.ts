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

const LAST_ACTIVE_THROTTLE_MS = 5 * 60 * 1000;

const protectRoute = async (req, res, next) => {
  try {
    const token =
      (req.headers.authorization?.startsWith("Bearer ")
        ? req.headers.authorization.split(" ")[1]
        : null) || req.cookies?.jwt;

    let userId: string | null = null;

    if (token) {
      const decoded: any = jwt.verify(token, process.env.JWT_SECRET);
      userId = decoded.userId;
    } else if (req.cookies?.refreshToken) {
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
