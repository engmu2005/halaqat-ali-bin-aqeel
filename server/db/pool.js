'use strict';

/**
 * اتصال PostgreSQL — المصدر الأساسي للحقيقة.
 * بيانات الاتصال من متغير البيئة DATABASE_URL فقط.
 */
const { Pool } = require('pg');
const { config } = require('../config');

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('خطأ غير متوقع في تجمع اتصالات قاعدة البيانات', err);
});

/** استعلام مبسّط */
async function query(text, params) {
  return pool.query(text, params);
}

/** تنفيذ دالة داخل معاملة (Transaction) مع Commit/Rollback تلقائي */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
