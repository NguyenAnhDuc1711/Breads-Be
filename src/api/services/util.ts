import nodemailer from "nodemailer";

export const sendMailService = async ({ from, to, subject, html }) => {
  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: "mraducky@gmail.com",
        pass: process.env.SEND_MAIL_PASS || "",
      },
    });
    const options = {
      from,
      to,
      subject,
      html,
    };
    const info = await transporter.sendMail(options);
    return info;
  } catch (err) {
    console.log("sendMailService: ", err);
  }
};
