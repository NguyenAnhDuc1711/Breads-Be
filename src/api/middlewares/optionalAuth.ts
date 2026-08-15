import jwt from "jsonwebtoken";
import RefreshToken from "../models/refreshToken.model.js";
import { hashToken } from "../utils/generateTokens.js";

// Like protectRoute, but never blocks the request: routes that serve both
// logged-in and anonymous viewers (e.g. public post pages) use this to know
// who's asking, without requiring a session.
const optionalAuth = async (req, res, next) => {
  // Primary: Authorization header (access token)
  // Fallback: legacy cookie (backward compat during transition)
  const token =
    (req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.split(" ")[1]
      : null) || req.cookies?.jwt;

  req.viewerId = null;
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.viewerId = decoded.userId;
    } catch {
      req.viewerId = null;
    }
  } else if (req.cookies?.refreshToken) {
    try {
      const hashedToken = hashToken(req.cookies.refreshToken);
      const stored = await RefreshToken.findOne({
        token: hashedToken,
        expiresAt: { $gt: new Date() },
      });
      if (stored) {
        req.viewerId = stored.userId.toString();
      }
    } catch {
      req.viewerId = null;
    }
  }
  next();
};

export default optionalAuth;
