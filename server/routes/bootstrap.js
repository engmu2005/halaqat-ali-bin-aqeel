'use strict';

/**
 * تحميل حالة التطبيق كاملة للمستخدم الحالي (حسب صلاحياته):
 * الإعدادات + الحلقات + الطلاب + سجل التحاضير + بيانات وصفية.
 * الواجهة تحفظ هذه النسخة في الذاكرة فقط — لا localStorage لبيانات الطلاب أو التحضير.
 */
const express = require('express');
const { query } = require('../db/pool');
const { requireAuth, allowedGroupIds } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const scope = await allowedGroupIds(req.user);

    const settingsR = await query("SELECT value FROM settings WHERE key = 'app'");
    const settings = settingsR.rows.length ? settingsR.rows[0].value : {};

    const groupsR = scope === null
      ? await query('SELECT id, name FROM groups ORDER BY created_at, name')
      : await query('SELECT id, name FROM groups WHERE id = ANY($1::uuid[]) ORDER BY created_at, name', [scope]);

    const studentsR = scope === null
      ? await query('SELECT * FROM students ORDER BY name')
      : await query('SELECT * FROM students WHERE group_id = ANY($1::uuid[]) ORDER BY name', [scope]);

    const attR = scope === null
      ? await query(
        `SELECT a.session_date::text AS date, a.student_id, a.status, a.note, a.updated_at, a.recorded_at
         FROM attendance a`
      )
      : await query(
        `SELECT a.session_date::text AS date, a.student_id, a.status, a.note, a.updated_at, a.recorded_at
         FROM attendance a JOIN students s ON s.id = a.student_id
         WHERE s.group_id = ANY($1::uuid[])`,
        [scope]
      );

    const attendance = {};
    for (const r of attR.rows) {
      if (!attendance[r.date]) attendance[r.date] = {};
      attendance[r.date][r.student_id] = {
        status: r.status || null,
        note: r.note || '',
        at: new Date(r.updated_at || r.recorded_at).getTime(),
      };
    }

    const backupR = await query(
      "SELECT created_at FROM audit_log WHERE action = 'backup_export' ORDER BY created_at DESC LIMIT 1"
    );

    res.json({
      settings,
      groups: groupsR.rows.map((g) => ({ id: g.id, name: g.name })),
      students: studentsR.rows.map((s) => ({
        id: s.id,
        name: s.name,
        groupId: s.group_id || '',
        phone: s.phone,
        note: s.note,
        active: s.active,
        createdAt: s.created_at ? new Date(s.created_at).getTime() : Date.now(),
      })),
      attendance,
      meta: {
        lastBackupAt: backupR.rows.length ? new Date(backupR.rows[0].created_at).getTime() : null,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
