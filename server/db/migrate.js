'use strict';

/**
 * تطبيق مخطط قاعدة البيانات (server/db/schema.sql).
 * المخطط قابل لإعادة التشغيل بأمان (IF NOT EXISTS).
 * الاستخدام: npm run migrate
 */
const fs = require('fs');
const path = require('path');
const { pool } = require('./pool');
const { assertConfig } = require('../config');

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log('✔ تم تطبيق مخطط قاعدة البيانات بنجاح');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  assertConfig();
  migrate()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('✘ فشل تطبيق المخطط:', err.message);
      process.exit(1);
    });
}

module.exports = { migrate };
