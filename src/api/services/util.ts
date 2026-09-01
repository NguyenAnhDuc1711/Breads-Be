import nodemailer from "nodemailer";
import logger from "../../core/logger.js";

export const sendMailService = async ({ from, to, subject, html }) => {
  try {
    const defaultSender = process.env.SEND_MAIL_USER || "mraducky@gmail.com";
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: defaultSender,
        pass: process.env.SEND_MAIL_PASS || "",
      },
    });
    const options = {
      from: from || defaultSender,
      to,
      subject,
      html,
    };
    const info = await transporter.sendMail(options);
    return info;
  } catch (err) {
    logger.error({ err }, "sendMailService failed");
  }
};
