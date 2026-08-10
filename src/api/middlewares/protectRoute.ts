import jwt from "jsonwebtoken";
import HTTPStatus from "../../utils/httpStatus.js";
import logger from "../../core/logger.js";
import User from "../models/user.model.js";

// Avoid writing to the DB on every single request; only refresh the
// timestamp once it's gone stale.
const LAST_ACTIVE_THROTTLE_MS = 5 * 60 * 1000;

const protectRoute = async (req, res, next) => {
  try {
    const token =
      req.cookies?.jwt ||
      (req.headers.authorization?.startsWith("Bearer ")
        ? req.headers.authorization.split(" ")[1]
        : null);

    if (!token)
      return res
        .status(HTTPStatus.UNAUTHORIZED)
        .json({ message: "Unauthorized" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId).select("-password");
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
    res.status(HTTPStatus.SERVER_ERR).json({ message: err.message });
    logger.error({ err }, "Error in protectRoute");
  }
};

export default protectRoute;
