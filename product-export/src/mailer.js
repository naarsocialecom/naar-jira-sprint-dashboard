const path = require("path");
const nodemailer = require("nodemailer");

async function sendExport(mail, { files, rowCount, title, summary }) {
  if (!mail.to.length) throw new Error("MAIL_TO is empty (set at least one recipient in .env)");

  const transporter = nodemailer.createTransport({
    host: mail.host,
    port: mail.port,
    secure: mail.secure,
    auth: { user: mail.user, pass: mail.pass },
  });

  const date = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const fileNames = files.map((f) => path.basename(f));

  const info = await transporter.sendMail({
    from: mail.from,
    to: mail.to,
    cc: mail.cc.length ? mail.cc : undefined,
    subject: `${mail.subject} - ${date}`,
    text:
      `Hi,\n\nPlease find attached the ${title} (${rowCount} rows) generated on ${date}.\n\n` +
      (summary ? `${summary.text}\n\n` : "") +
      `Attached: ${fileNames.join(", ")}\n\nThis is an automated email.`,
    attachments: files.map((f) => ({ filename: path.basename(f), path: f })),
  });

  return info.messageId;
}

module.exports = { sendExport };
