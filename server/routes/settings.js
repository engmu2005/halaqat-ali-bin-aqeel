'use strict';

/**
 * إعدادات التطبيق المشتركة (بيانات الدرس + قواعد الحساب).
 * القراءة: لكل المستخدمين. الكتابة: لمدير النظام فقط (تؤثر على تقارير الجميع).
 */
const express = require('express');
const { query } = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../middleware/audit');

const router = express.Router();

function validate(body) {
  const s = {};
  const errors = [];
  if (body.lessonName !== undefined) {
    s.lessonName = String(body.lessonName).trim().slice(0, 80) || 'الدرس';
  }
  if (body.orgName !== undefined) s.orgName = String(body.orgName).trim().slice(0, 120);
  if (body.teacherName !== undefined) s.teacherName = String(body.teacherName).trim().slice(0, 80);
  for (const k of ['showHijri', 'lateCountsAsPresent', 'excludeExcused']) {
    if (body[k] !== undefined) s[k] = !!body[k];
  }
  if (body.absenceAlertThreshold !== undefined) {
    const th = parseInt(body.absenceAlertThreshold, 10);
    if (!Number.isFinite(th) || th < 1 || th > 30) errors.push('حد الغياب المتتالي بين 1 و 30');
    else s.absenceAlertThreshold = th;
  }
  return { s, errors };
}

// GET /api/settings
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const r = await query("SELECT value FROM settings WHERE key = 'app'");
    res.json({ settings: r.rows.length ? r.rows[0].value : {} });
  } catch (err) {
    next(err);
  }
});

// PUT /api/settings — (مدير النظام فقط)
router.put('/', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { s, errors } = validate(req.body || {});
    if (errors.length) return res.status(400).json({ error: errors.join('، ') });

    const r = await query(
      `UPDATE settings SET value = value || $1::jsonb, updated_at = now(), updated_by = $2
       WHERE key = 'app' RETURNING value`,
      [JSON.stringify(s), req.user.id]
    );
    await logAudit(req, 'settings_update', 'settings', 'app', s);
    res.json({ settings: r.rows[0].value });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
