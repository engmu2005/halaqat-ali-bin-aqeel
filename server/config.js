'use strict';

/**
 * إعدادات الخادم — كل الأسرار تأتي من متغيرات البيئة فقط.
 * لا تُكتب أي كلمة مرور أو سر قاعدة بيانات داخل الكود.
 */
require('dotenv').config();
const path = require('path');

const config = {
  env: process.env.NODE_ENV || 'development',
  isProd: (process.env.NODE_ENV || 'development') === 'production',
  port: Number(process.env.PORT || 8080),
  databaseUrl: process.env.DATABASE_URL || '',
  sessionSecret: process.env.SESSION_SECRET || '',
  sessionTtlDays: Math.max(1, Number(process.env.SESSION_TTL_DAYS || 30)),
  rootDir: path.resolve(__dirname, '..'),
};

/** يتحقق من وجود متغيرات البيئة الضرورية قبل الإقلاع */
function assertConfig() {
  const missing = [];
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  if (!config.sessionSecret || config.sessionSecret.length < 16) {
    missing.push('SESSION_SECRET (16 حرفاً على الأقل)');
  }
  if (missing.length) {
    console.error('متغيرات بيئة مطلوبة مفقودة: ' + missing.join('، '));
    console.error('انسخ .env.example إلى .env واملأ القيم محلياً، أو اضبطها من لوحة Render.');
    process.exit(1);
  }
  if (config.isProd && /change-me|please|secret123/i.test(config.sessionSecret)) {
    console.error('SESSION_SECRET ما زال قيمة افتراضية — غيّره قبل التشغيل في production.');
    process.exit(1);
  }
}

module.exports = { config, assertConfig };
