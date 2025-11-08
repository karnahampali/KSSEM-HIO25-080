/* eslint-disable */
const nodemailer = require("nodemailer");

const DRIVER = (process.env.MAIL_DRIVER || "smtp").toLowerCase();

let transporter;

function getTransport() {
  if (DRIVER === "stub") {
    return {
      async sendMail(opts) {
        const id = `<stub-${Date.now().toString(36)}@intellihire.local>`;
        console.log("📨 [STUB] would send", {
          from: opts.from,
          replyTo: opts.replyTo,
          to: opts.to,
          subject: opts.subject,
          hasIcs: !!opts.icalEvent || !!(opts.attachments || []).find(a => /\.ics$/i.test(a.filename || "")),
        });
        return { messageId: id };
      },
      async close() {},
    };
  }

  if (!transporter) {
    transporter = nodemailer.createTransport({
      pool: true,
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),      // SendGrid: 587
      secure: String(process.env.SMTP_SECURE || "false") === "true", // SendGrid: false (STARTTLS)
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      maxConnections: 5,
      maxMessages: 100,
      logger: true, // prints SMTP dialog
    });
  }
  return transporter;
}

function icsAttachment(ics) {
  return {
    filename: "invite.ics",
    content: ics,
    contentType: "text/calendar; method=REQUEST; charset=utf-8",
  };
}

function buildMailOptions({ to, subject, text, html, ics, organizerName, organizerEmail }) {
  const verifiedFrom = process.env.VERIFIED_FROM_EMAIL || process.env.FROM_EMAIL || "no-reply@intellihire.local";
  const from = { name: process.env.FROM_NAME || "IntelliHire", address: verifiedFrom };

  const rcpts = Array.isArray(to) ? to.filter(Boolean) : [to].filter(Boolean);

  const mail = { from, to: rcpts, subject, text, html };

  // Replies go to the organizer (so you can use a verified From safely)
  if (organizerEmail) {
    mail.replyTo = { name: organizerName || process.env.FROM_NAME || "Recruiter", address: organizerEmail };
  }

  if (ics) {
    mail.icalEvent = { method: "REQUEST", content: ics };
    mail.attachments = [icsAttachment(ics)];
  }
  return mail;
}

async function sendMail(args) {
  const t = getTransport();
  const first = buildMailOptions(args);

  // Hard guard: fail if we were asked to mail but there are no recipients.
  if (!first.to || first.to.length === 0) {
    const err = new Error("No recipients provided");
    err.code = "NORECIPIENTS";
    throw err;
  }

  try {
    const info = await t.sendMail(first);
    console.log(`📧 SMTP sent (id: ${info.messageId}) to ${first.to.join(", ")}`);
    return info;
  } catch (err) {
    const msg = String(err.response || err.message || "").toLowerCase();
    const isSendGridFromErr = err.responseCode === 550 || /verified sender identity/.test(msg);

    const vFrom = process.env.VERIFIED_FROM_EMAIL;
    const alreadyVerified = first.from && vFrom && first.from.address.toLowerCase() === vFrom.toLowerCase();

    if (isSendGridFromErr && vFrom && !alreadyVerified) {
      console.warn("⚠️ SendGrid 550: retrying with VERIFIED_FROM_EMAIL =", vFrom);
      const retry = { ...first, from: { name: first.from.name, address: vFrom } };
      const info = await t.sendMail(retry);
      console.log(`📧 SMTP sent on retry (id: ${info.messageId}) to ${retry.to.join(", ")}`);
      return info;
    }

    throw err;
  }
}

async function closeTransport() {
  try {
    const t = getTransport();
    if (t && t.close) await t.close();
  } catch {}
}

module.exports = { sendMail, closeTransport };
