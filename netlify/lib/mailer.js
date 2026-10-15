// Outgoing email for every Netlify function, sent as services@somarosafarms.com
// through Google Workspace's SMTP server. Lives outside netlify/functions so
// Netlify doesn't deploy it as a function of its own; functions require() it
// and the bundler pulls it in.
//
// Required env vars (Netlify site config):
//   GMAIL_USER           services@somarosafarms.com
//   GMAIL_APP_PASSWORD   16-character app password for that account
//                        (Google Account -> Security -> 2-Step Verification
//                        -> App passwords). Not the account's real password.
// Optional:
//   MAIL_FROM_NAME       display name, default "2CW Productions"
//
// Gmail caps a Workspace account at about 2,000 messages a day, far more than
// reports and PIN resets need. Sent mail shows up in that mailbox's Sent folder.

const nodemailer = require('nodemailer');

let transport = null;

function mailConfigured() {
  return Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD.replace(/\s/g, '') }
    });
  }
  return transport;
}

// sendMail({to, subject, text, html, attachments?, replyTo?}). `to` is an
// address or a list of them. Throws if mail isn't configured or Gmail refuses.
async function sendMail({ to, subject, text, html, attachments, replyTo }) {
  if (!mailConfigured()) throw new Error('Email is not set up (GMAIL_USER / GMAIL_APP_PASSWORD missing)');
  const list = (Array.isArray(to) ? to : [to]).map((s) => String(s).trim()).filter(Boolean);
  if (!list.length) throw new Error('No recipients');
  const name = process.env.MAIL_FROM_NAME || '2CW Productions';
  return getTransport().sendMail({
    from: `"${name}" <${process.env.GMAIL_USER}>`,
    to: list.join(', '),
    subject, text, html, attachments, replyTo
  });
}

// "a@x.com, b@y.com; c@z.com" -> ['a@x.com', 'b@y.com', 'c@z.com']
const parseRecipients = (s) => String(s || '').split(/[,;\s]+/).map((x) => x.trim()).filter((x) => x.includes('@'));

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = { mailConfigured, sendMail, parseRecipients, escapeHtml };
