import jwt from "jsonwebtoken";

// Like protectRoute, but never blocks the request: routes that serve both
// logged-in and anonymous viewers (e.g. public post pages) use this to know
// who's asking, without requiring a session.
const optionalAuth = (req, res, next) => {
  const token =
    req.cookies?.jwt ||
    (req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.split(" ")[1]
      : null);

  req.viewerId = null;
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.viewerId = decoded.userId;
    } catch {
      req.viewerId = null;
    }
  }
  next();
};

export default optionalAuth;
