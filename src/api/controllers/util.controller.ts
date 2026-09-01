import { decodeString } from "../../Breads-Shared/util/index.js";
import { BadRequestError } from "../../core/error.response.js";
import { OK } from "../../core/success.response.js";
import User from "../models/user.model.js";
import { sendMailService } from "../services/util.js";
import { forgotPWMailForm } from "../utils/index.js";

export const sendForgotPWMail = async (req, res) => {
  const { from, to, subject, code, url } = req.body;
  if (!to) {
    throw new BadRequestError("Empty user's mail");
  }
  let decodedCode = decodeString(code);
  const userInfo = await User.findOne({ email: to });
  let userId = "";
  let newUrl = "";
  if (userInfo) {
    userId = JSON.parse(
      JSON.stringify(userInfo?._id).replace("new ObjectId", "")
    );
  }
  if (userId) {
    newUrl = url.replace("userId", `${userId}`);
    newUrl = newUrl.replace(code, decodedCode);
  }
  const result = await sendMailService({
    from,
    to,
    subject: subject || "Reset password",
    html: forgotPWMailForm(to, decodedCode, newUrl),
  });
  new OK({
    message: "Send forgot password mail successfully",
    metadata: result,
  }).send(res);
};
