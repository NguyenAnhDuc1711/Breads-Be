import HTTPStatus from "../../utils/httpStatus.js";

// Factory, not a bare middleware — must run AFTER protectRoute (reads
// req.user set by it). Default-deny: missing/unrecognized role is always
// treated as insufficient, never allowed through.
export const requireRole = (...roles: number[]) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(HTTPStatus.FORBIDDEN).json({ message: "Forbidden" });
    }
    next();
  };
};

// Variant for endpoints shared between self-service (any user acting on
// their own resource, identified by req.params.id) and admin override
// (acting on someone else's resource). Must run AFTER protectRoute.
export const requireSelfOrRole = (...roles: number[]) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(HTTPStatus.FORBIDDEN).json({ message: "Forbidden" });
    }
    const isSelf = req.user._id?.toString() === req.params.id;
    if (!isSelf && !roles.includes(req.user.role)) {
      return res.status(HTTPStatus.FORBIDDEN).json({ message: "Forbidden" });
    }
    next();
  };
};

export default requireRole;
