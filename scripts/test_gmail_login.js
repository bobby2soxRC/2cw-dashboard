// Checks a Gmail app password against smtp.gmail.com, the same
// way netlify/lib/mailer.js signs in, without sending anything. Use it to
// tell a bad app password apart from a bad value in Netlify.
//
//   node scripts/test_gmail_login.js [2cw.reports@gmail.com]
//
// Asks for the app password, shown as *s; nothing is saved.

const readline = require('readline');
const nodemailer = require('nodemailer');

const user = (process.argv[2] || '2cw.reports@gmail.com').trim();

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.stdoutMuted = false;
// While muted, echo each typed or pasted character as * so a paste is visible.
rl._writeToOutput = (s) => { rl.output.write(rl.stdoutMuted ? s.replace(/[^\r\n]/g, '*') : s); };

console.log(`Paste the app password for ${user}, then press Enter (it shows as *):`);
rl.question('', async (pass) => {
  rl.close();
  process.stdout.write('\n');
  const clean = pass.replace(/\s/g, '');
  console.log(`Password length after removing spaces: ${clean.length} (should be 16)`);
  const t = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass: clean } });
  try {
    await t.verify();
    console.log('OK: Gmail accepted this login. If Netlify still fails, the Netlify values are the problem.');
  } catch (e) {
    console.log(`FAILED: ${e.response || e.message}`);
    console.log('Gmail rejected this login, so the issue is on the Google side (the account or its settings), not Netlify.');
  }
});
rl.stdoutMuted = true;
