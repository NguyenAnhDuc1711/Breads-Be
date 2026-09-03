import HTTPStatus from "../../utils/httpStatus.js";
import { ForbiddenError } from "../../core/error.response.js";

export const requireRole = (...roles: number[]) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(HTTPStatus.FORBIDDEN).json({ message: "Forbidden" });
    }
    next();
  };
};

export const requireSelfOnParam = (paramName: string, ...roles: number[]) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(HTTPStatus.FORBIDDEN).json({ message: "Forbidden" });
    }
    const isSelf = req.user._id?.toString() === req.params[paramName];
    if (!isSelf && !roles.includes(req.user.role)) {
      return res.status(HTTPStatus.FORBIDDEN).json({ message: "Forbidden" });
    }
    next();
  };
};

export const requireSelfOrRole = (...roles: number[]) =>
  requireSelfOnParam("id", ...roles);


export const assertRole = (user: any, ...roles: number[]): void => {
  if (!user || !roles.includes(user.role)) {
    throw new ForbiddenError();
  }
};

export default requireRole;
