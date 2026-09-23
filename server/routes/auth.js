'use strict';

/**
 * مسارات تسجيل الدخول والخروج والحساب الحالي.
 * كلمات المرور تُتحقق بـ bcrypt — لا تُخزَّن ولا تُعاد كنص صريح أبداً.
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../middleware/audit');

const router = express.Router();

const USERNAME_RE = /^[\p{L}\p{N}._\-]{3,40}$/u;

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    fullName: u.full_name,
    role: u.role,
    active: u.active,
  };
}

// POST /api/auth/login — تسجيل الدخول
router.post('/login', async (req, res, next) => {
  try {
    const username = String((req.body && req.body.username) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');

    if (!USERNAME_RE.test(username) || !password) {
      return res.status(400).json({ error: 'أدخل اسم الدخول وكلمة المرور' });
    }

    const r = await query(
      'SELECT id, username, full_name, role, active, password_hash FROM users WHERE username = $1',
      [username]
    );
    const u = r.rows[0];
    const ok = u ? await bcrypt.compare(password, u.password_hash) : false;

    if (!u || !ok || !u.active) {
      // رسالة موحدة — لا نكشف هل الاسم موجود
      req.session.username = username; // لأغراض تدقيق محاولات الفشل
      await logAudit(req, 'login_failed', 'user', u ? u.id : username, {});
      return res.status(401).json({ error: 'اسم الدخول أو كلمة المرور غير صحيحة' });
    }

    // منع تثبيت الجلسة (Session Fixation): جلسة جديدة بعد النجاح
    await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
    req.session.userId = u.id;
    req.session.username = u.username;
    req.session.role = u.role;

    await query('UPDATE users SET last_login_at = now() WHERE id = $1', [u.id]);
    await logAudit(req, 'login', 'user', u.id, {});

    return res.json({ user: publicUser(u) });
  } catch (err) {
    return next(err);
  }
});

// POST /api/auth/logout — تسجيل الخروج
router.post('/logout', async (req, res, next) => {
  try {
    if (req.session && req.session.userId) {
      await logAudit(req, 'logout', 'user', req.session.userId, {});
    }
    req.session.destroy(() => {
      res.clearCookie('bulugh.sid', { httpOnly: true, sameSite: 'lax', secure: req.secure });
      res.json({ ok: true });
    });
  } catch (err) {
    return next(err);
  }
});

// GET /api/auth/me — الحساب الحالي (أو 401)
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

module.exports = router;
