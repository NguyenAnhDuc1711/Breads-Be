import HTTPStatus from "../../utils/httpStatus.ts";

export const SITEMAP_SECRET_HEADER = "x-sitemap-secret";

const sitemapAuthGate = (req, res, next) => {
  const provided = req.headers[SITEMAP_SECRET_HEADER];
  const expected = process.env.SITEMAP_SHARED_SECRET;

  if (!expected || !provided || provided !== expected) {
    return res.status(HTTPStatus.UNAUTHORIZED).json({ message: "Unauthorized" });
  }

  next();
};

export default sitemapAuthGate;
