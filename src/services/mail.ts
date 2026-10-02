import nodemailer from "nodemailer";

export function mailer() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.mail.ru",
    port: Number(process.env.SMTP_PORT) || 465,
    secure: true,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}
