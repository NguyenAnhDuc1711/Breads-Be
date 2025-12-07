import jwt from "jsonwebtoken";
import HTTPStatus from "../../utils/httpStatus.js";
import User from "../models/user.model.js";

const protectRoute = async (req, res, next) => {
  try {
    const token = req.cookies.jwt;

    if (!token)
      return res
        .status(HTTPStatus.UNAUTHORIZED)
        .json({ message: "Unauthorized" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId).select("-password");
    req.user = user;

    next();
  } catch (err) {
    res.status(HTTPStatus.SERVER_ERR).json({ message: err.message });
    console.log("Error in protectRoute", err.message);
  }
};

export default protectRoute;
