'use strict';

/**
 * النسخ الاحتياطي والاستعادة الآمنة (لمدير النظام فقط).
 * - التصدير: كل البيانات في ملف JSON واحد — بدون أي كلمات مرور أو أسرار أبداً.
 *   بيانات الحسابات تُصدَّر كأسماء وأدوار فقط؛ عند الاستعادة تُنشأ بلا كلمة مرور صالحة
 *   ويُطلب من المدير تعيين كلمة مرور جديدة لها.
 * - الاستعادة: استبدال البيانات (حلقات/طلاب/تحضير/إعدادات) مع الحفاظ على حسابات قائمة
 *   وعدم المساس بكلمات مرورها. يقبل أيضاً ملفات النسخ الاحتياطي القديمة (localStorage).
 * - المسح: حذف الطلاب والحلقات والتحضير (كما في «مسح كل البيانات») مع بقاء الحسابات.
 */
const express = require('express');
const crypto = require('crypto');
const { query, withTransaction } = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../middleware/audit');
const { isAllowedAttendanceDate } = require('../lib/dates');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const STATUSES = ['present', 'late', 'absent', 'excused'];

// GET /api/backup/export — تنزيل نسخة احتياطية
router.get('/export', async (req, res, next) => {
  try {
    const settingsR = await query("SELECT value FROM settings WHERE key = 'app'");
    const groupsR = await query('SELECT id, name FROM groups ORDER BY created_at, name');
    const studentsR = await query('SELECT * FROM students ORDER BY name');
    const attR = await query(
      'SELECT session_date::text AS date, student_id, status, note, updated_at, recorded_at FROM attendance'
    );
    const usersR = await query('SELECT username, full_name, role, active FROM users ORDER BY username');
    const sgR = await query(
      `SELECT u.username, g.name AS group_name
       FROM supervisor_groups sg
       JOIN users u ON u.id = sg.supervisor_id
       JOIN groups g ON g.id = sg.group_id`
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

    const accounts = usersR.rows.map((u) => ({
      username: u.username,
      fullName: u.full_name,
      role: u.role,
      active: u.active,
      groupNames: sgR.rows.filter((x) => x.username === u.username).map((x) => x.group_name),
    }));

    const payload = {
      app: 'halaqat-ali-bin-aqeel',
      version: 2,
      exportedAt: new Date().toISOString(),
      settings: settingsR.rows.length ? settingsR.rows[0].value : {},
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
      accounts,
    };

    await logAudit(req, 'backup_export', 'backup', '', {
      students: payload.students.length,
      groups: payload.groups.length,
    });
    res.setHeader('Content-Disposition', 'attachment; filename="bulugh-backup.json"');
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

/** يقبل صيغة التصدير الجديدة وصيغة localStorage القديمة (نفس البنية) */
function normalizeBackup(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const students = Array.isArray(parsed.students) ? parsed.students.filter((s) => s && s.name) : null;
  if (!students) return null;
  const groups = Array.isArray(parsed.groups) ? parsed.groups.filter((g) => g && g.name) : [];
  const attendance = parsed.attendance && typeof parsed.attendance === 'object' ? parsed.attendance : {};
  const settings = parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {};
  const accounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
  return { students, groups, attendance, settings, accounts };
}

// POST /api/backup/restore — استعادة نسخة احتياطية (استبدال البيانات)
router.post('/restore', async (req, res, next) => {
  try {
    const nb = normalizeBackup(req.body);
    if (!nb) {
      return res.status(400).json({ error: 'الملف غير صالح أو ليس نسخة احتياطية من هذا التطبيق' });
    }

    const result = await withTransaction(async (client) => {
      // استبدال البيانات (الحسابات الحالية تبقى كما هي بكلمات مرورها)
      await client.query('DELETE FROM attendance');
      await client.query('DELETE FROM students');
      await client.query('DELETE FROM groups');

      // الإعدادات
      if (Object.keys(nb.settings).length) {
        await client.query(
          `INSERT INTO settings (key, value, updated_by) VALUES ('app', $1, $2)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
          [JSON.stringify(nb.settings), req.user.id]
        );
      }

      // الحلقات (نحافظ على المعرّفات عند صلاحية الشكل)
      const gidMap = new Map();
      for (const g of nb.groups) {
        const r = await client.query(
          'INSERT INTO groups (id, name) VALUES (COALESCE($1::uuid, gen_random_uuid()), $2) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id',
          [g.id || null, String(g.name).trim().slice(0, 60)]
        );
        gidMap.set(g.id, r.rows[0].id);
        if (!g.id) gidMap.set(g.name, r.rows[0].id);
      }

      // الطلاب
      let studentsAdded = 0;
      for (const s of nb.students) {
        const gid = s.groupId ? (gidMap.get(s.groupId) || null) : null;
        try {
          await client.query(
            'INSERT INTO students (id, name, group_id, phone, note, active) VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6)',
            [s.id || null, String(s.name).trim().slice(0, 80), gid, String(s.phone || '').slice(0, 20), String(s.note || '').slice(0, 200), s.active !== false]
          );
          studentsAdded += 1;
        } catch (e) {
          if (e.code !== '23505') throw e; // تخطي المكرر
        }
      }

      // التحضير (مع فلترة التواريخ غير المسموحة كما في الاستعادة الحالية)
      const sidMap = new Map();
      const stR = await client.query('SELECT id, name FROM students');
      for (const row of stR.rows) sidMap.set(row.id, row.id);
      let recordsAdded = 0;
      let recordsSkipped = 0;
      for (const [date, day] of Object.entries(nb.attendance)) {
        if (!isAllowedAttendanceDate(date)) { recordsSkipped += 1; continue; }
        for (const [sid, rec] of Object.entries(day || {})) {
          const status = rec && STATUSES.includes(rec.status) ? rec.status : null;
          const note = rec && rec.note ? String(rec.note).slice(0, 200) : '';
          if (!status && !note) { recordsSkipped += 1; continue; }
          if (!sidMap.has(sid)) { recordsSkipped += 1; continue; }
          try {
            await client.query(
              `INSERT INTO attendance (session_date, student_id, status, note, recorded_by)
               VALUES ($1, $2, $3, $4, $5)`,
              [date, sid, status, note, req.user.id]
            );
            recordsAdded += 1;
          } catch (e) {
            recordsSkipped += 1; // تواريخ مخالفة للقيود أو مكررة
          }
        }
      }

      // الحسابات الواردة: إنشاء الناقص فقط — بلا كلمة مرور صالحة (يُعيَّن لها كلمة مرور من لوحة الإدارة)
      const needPasswordReset = [];
      for (const acc of nb.accounts) {
        if (!acc || !acc.username) continue;
        const username = String(acc.username).trim().toLowerCase().slice(0, 40);
        const exists = await client.query('SELECT id, role FROM users WHERE username = $1', [username]);
        let uid;
        if (exists.rowCount) {
          uid = exists.rows[0].id;
        } else {
          const unusable = '!' + crypto.randomBytes(24).toString('hex'); // ليس hash صالح — لا يمكن الدخول بها
          const role = acc.role === 'admin' ? 'admin' : 'supervisor';
          const u = await client.query(
            'INSERT INTO users (username, password_hash, full_name, role, active) VALUES ($1, $2, $3, $4, $5) RETURNING id',
            [username, unusable, String(acc.fullName || '').slice(0, 80), role, acc.active !== false]
          );
          uid = u.rows[0].id;
          needPasswordReset.push(username);
        }
        // حلقات المشرف (بالاسم)
        if (Array.isArray(acc.groupNames) && acc.role !== 'admin') {
          for (const gn of acc.groupNames) {
            const g = await client.query('SELECT id FROM groups WHERE name = $1', [String(gn)]);
            if (g.rowCount) {
              await client.query(
                'INSERT INTO supervisor_groups (supervisor_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                [uid, g.rows[0].id]
              );
            }
          }
        }
      }

      return { studentsAdded, recordsAdded, recordsSkipped, needPasswordReset };
    });

    await logAudit(req, 'backup_restore', 'backup', '', result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/backup/wipe — مسح كل البيانات (طلاب/حلقات/تحضير) — الحسابات والإعدادات تبقى
router.post('/wipe', async (req, res, next) => {
  try {
    await withTransaction(async (client) => {
      await client.query('DELETE FROM attendance');
      await client.query('DELETE FROM students');
      await client.query('DELETE FROM groups');
    });
    await logAudit(req, 'wipe_all', 'backup', '', {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
