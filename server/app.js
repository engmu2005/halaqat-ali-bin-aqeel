'use strict';

/**
 * تطبيق Express — يقدّم واجهة التطبيق الحالية (نفس الملفات والتصميم)
 * + واجهة برمجية /api للنظام متعدد المستخدمين.
 * لا تُخدَم أبداً ملفات server/ أو node_modules أو .env أو .git.
 */
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const rateLimit = require('express-rate-limit');
const { config } = require('./config');
const { pool } = require('./db/pool');

function createApp() {
  const app = express();

  // خلف البروكسي (Render) — ضروري للكوكيز الآمنة
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // رؤوس أمان (بدون تغيير مظهر الواجهة)
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));

  app.use(express.json({ limit: '25mb' })); // الحد المرتفع لملفات النسخ الاحتياطي وترحيل localStorage
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // جلسة الدخول: كوكي httpOnly آمنة — لا توكنات في الواجهة
  app.use(session({
    store: new PgSession({ pool, tableName: 'session', createTableIfMissing: false }),
    name: 'bulugh.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: config.isProd,
      sameSite: 'lax',
      maxAge: config.sessionTtlDays * 24 * 60 * 60 * 1000,
    },
  }));

  // استجابات API لا تُخزَّن في المتصفح أو Service Worker أبداً
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // تحديد محاولات تسجيل الدخول
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'محاولات دخول كثيرة، حاول بعد قليل' },
  });

  const api = express.Router();

  // فحص صحة النظام
  api.get('/health', async (req, res) => {
    let db = 'down';
    try { await pool.query('SELECT 1'); db = 'ok'; } catch (_) { /* ignore */ }
    res.json({
      ok: db === 'ok',
      app: 'halaqat-ali-bin-aqeel',
      version: '2.0.0',
      env: config.env,
      db,
      time: new Date().toISOString(),
    });
  });

  // مسارات API
  api.use('/auth', authLimiter, require('./routes/auth'));
  api.use('/users', require('./routes/users'));
  api.use('/groups', require('./routes/groups'));
  api.use('/students', require('./routes/students'));
  api.use('/attendance', require('./routes/attendance'));
  api.use('/settings', require('./routes/settings'));
  api.use('/bootstrap', require('./routes/bootstrap'));
  api.use('/reports', require('./routes/reports'));
  api.use('/backup', require('./routes/backup'));
  api.use('/sample-data', require('./routes/sample'));
  api.use('/migration', require('./routes/migration'));
  api.use('/audit', require('./routes/audit'));

  app.use('/api', api);

  // ===== ملفات الواجهة الحالية (Static) =====
  const root = config.rootDir;
  const send = (rel) => (req, res) => res.sendFile(path.join(root, rel));

  app.use('/css', express.static(path.join(root, 'css')));
  app.use('/js', express.static(path.join(root, 'js')));
  app.use('/icons', express.static(path.join(root, 'icons'), { maxAge: '7d' }));
  app.get('/manifest.webmanifest', send('manifest.webmanifest'));
  app.get('/sw.js', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(root, 'sw.js'));
  });
  app.get(['/', '/index.html'], send('index.html'));

  // 404
  app.use('/api', (req, res) => res.status(404).json({ error: 'المسار غير موجود' }));
  app.use((req, res) => res.status(404).type('text/plain; charset=utf-8').send('غير موجود'));

  // معالج الأخطاء — رسائل JSON ولا تكشف تفاصيل داخلية
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'حجم الطلب كبير جداً' });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'محتوى الطلب غير صالح' });
    }
    console.error('خطأ غير معالج:', err);
    return res.status(500).json({ error: 'خطأ داخلي في الخادم' });
  });

  return app;
}

module.exports = { createApp };
