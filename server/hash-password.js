/* Prints a scrypt hash for a staff password. Run it yourself in a private terminal:
     node server/hash-password.js
   The password is typed (or piped) on YOUR machine and is never printed; only the hash is. Put the hash in
   STAFF_OPERATOR_PASSWORD_HASH / STAFF_ADMIN_PASSWORD_HASH (host secret manager or the git-ignored .env). */
'use strict';
const { hashPassword } = require('./auth');

function readSecret(prompt) {
  return new Promise(resolve => {
    if (!process.stdin.isTTY) { let b = ''; process.stdin.on('data', c => b += c).on('end', () => resolve(b.replace(/\r?\n$/, ''))); return; }
    process.stderr.write(prompt); let pw = ''; process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
    process.stdin.on('data', function on(ch) {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', on); process.stderr.write('\n'); return resolve(pw); }
        if (c === '\u0003') process.exit(130);
        if (c === '\u007f' || c === '\b') pw = pw.slice(0, -1); else pw += c;
      }
    });
  });
}
(async () => {
  const pw = await readSecret('New staff password (input hidden): ');
  if (pw.length < 12) { console.error('Use at least 12 characters.'); process.exit(1); }
  if (process.stdin.isTTY && (await readSecret('Repeat password: ')) !== pw) { console.error('Passwords do not match.'); process.exit(1); }
  console.log(await hashPassword(pw));
})();
