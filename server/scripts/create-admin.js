'use strict';

/**
 * إنشاء أول حساب «مدير نظام» — أمر سطر أوامر آمن.
 * تفاعلي:   npm run create-admin
 * آلي:      ADMIN_USERNAME=admin ADMIN_PASSWORD='...' ADMIN_FULL_NAME='الاسم' npm run create-admin
 *
 * لا تُمرر كلمات المرور في الكود أو في Git — استخدم المتغيرات أو الإدخال المباشر.
 */
const readline = require('readline');
const bcrypt = require('bcryptjs');
const { pool } = require('../db/pool');
const { assertConfig } = require('../config');

const USERNAME_RE = /^[\p{L}\p{N}._\-]{3,40}$/u;

function askHidden(rl, question) {
  return new Promise((resolve) => {
    const onData = (char) => {
      char = char.toString();
      switch (char) {
        case '\n':
        case '\r':
        case '\u0004':
          process.stdout.write('\n');
          process.stdin.removeListener('data', onData);
          rl.resume();
          rl._writeToOutput = function (s) { if (!rl.stdoutMuted) rl.output.write(s); };
          resolve(rl.line ? rl.line.slice(0, 200) : '');
          rl.close();
          break;
        case '\u0003':
          process.exit(1);
          break;
        default:
          rl.line += char;
          break;
      }
    };
    rl.stdoutMuted = true;
    rl._writeToOutput = function () { this.output.write(question); };
    rl.question(question, () => {});
    process.stdin.on('data', onData);
  });
}

async function main() {
  assertConfig();

  let username = (process.env.ADMIN_USERNAME || '').trim().toLowerCase();
  let fullName = (process.env.ADMIN_FULL_NAME || '').trim();
  let password = process.env.ADMIN_PASSWORD || '';

  if (!username || !password) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise((resolve) => rl.question(q, resolve));
    if (!username) username = (await ask('اسم الدخول للمدير: ')).trim().toLowerCase();
    if (!fullName) fullName = (await ask('الاسم الكامل (اختياري): ')).trim();
    if (!password) password = await askHidden(rl, 'كلمة المرور (لن تظهر): ');
    rl.close();
    if (!password || password.length < 8) {
      console.error('✘ كلمة المرور 8 أحرف على الأقل');
      process.exit(1);
    }
    const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
    const confirm = await new Promise((resolve) => rl2.question('تأكيد كلمة المرور: ', resolve));
    rl2.close();
    if (confirm !== password) {
      console.error('✘ كلمتا المرور غير متطابقتين');
      process.exit(1);
    }
  }

  if (!USERNAME_RE.test(username)) {
    console.error('✘ اسم الدخول غير صالح (3 أحرف فأكثر)');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('✘ كلمة المرور 8 أحرف على الأقل');
    process.exit(1);
  }

  const exists = await pool.query('SELECT 1 FROM users WHERE username = $1', [username]);
  if (exists.rowCount) {
    console.error(`✘ الحساب «${username}» موجود مسبقاً`);
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 12);
  await pool.query(
    "INSERT INTO users (username, password_hash, full_name, role) VALUES ($1, $2, $3, 'admin')",
    [username, hash, fullName]
  );
  console.log(`✔ تم إنشاء حساب مدير النظام «${username}»`);
  await pool.end();
}

main().catch((err) => {
  console.error('✘ فشل إنشاء الحساب:', err.message);
  process.exit(1);
});
