'use strict';

/**
 * ترحيل البيانات المحلية القديمة (localStorage — بصيغة bulugh-app:v1) إلى قاعدة البيانات.
 * دمج آمن (Merge): يضيف الناقص فقط ولا يحذف ولا يستبدل anything —
 * المجموعات بالاسم، الطلاب بالاسم+الحلقة (مع ربط سجلات التحضير بالمعرّف الصحيح)،
 * وسجلات التحضير لأيام الأحد المسموحة فقط.
 * متاح لمدير النظام.
 */
const express = require('express');
const { query, withTransaction } = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../middleware/audit');
const { isAllowedAttendanceDate } = require('../lib/dates');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const STATUSES = ['present', 'late', 'absent', 'excused'];

router.post('/import-local', async (req, res, next) => {
  try {
    const parsed = req.body || {};
    const students = Array.isArray(parsed.students) ? parsed.students.filter((s) => s && s.name) : [];
    const groups = Array.isArray(parsed.groups) ? parsed.groups.filter((g) => g && g.name) : [];
    const attendance = parsed.attendance && typeof parsed.attendance === 'object' ? parsed.attendance : {};
    if (!students.length) {
      return res.status(400).json({ error: 'لا توجد بيانات صالحة للترحيل' });
    }

    const result = await withTransaction(async (client) => {
      // الحلقات بالاسم (لا حذف)
      const gidMap = new Map();
      let groupsCreated = 0;
      for (const g of groups) {
        const name = String(g.name).trim().slice(0, 60);
        let r = await client.query('SELECT id FROM groups WHERE name = $1', [name]);
        if (!r.rowCount) {
          r = await client.query('INSERT INTO groups (name) VALUES ($1) RETURNING id', [name]);
          groupsCreated += 1;
        }
        if (g.id) gidMap.set(g.id, r.rows[0].id);
      }

      // الطلاب: إضافة الناقص + ربط المعرّف القديم بالحالي للتحضير
      const sidMap = new Map();
      let studentsAdded = 0;
      let studentsSkipped = 0;
      for (const s of students) {
        const name = String(s.name).trim().slice(0, 80);
        const legacyGid = s.groupId || '';
        const gid = legacyGid ? (gidMap.get(legacyGid) || null) : null;
        // هل يوجد بنفس الاسم والحلقة؟
        const exists = await client.query(
          `SELECT id FROM students
           WHERE name = $1 AND COALESCE(group_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
          [name, gid]
        );
        if (exists.rowCount) {
          if (s.id) sidMap.set(s.id, exists.rows[0].id);
          studentsSkipped += 1;
          continue;
        }
        const r = await client.query(
          'INSERT INTO students (id, name, group_id, phone, note, active) VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6) RETURNING id',
          [s.id || null, name, gid, String(s.phone || '').slice(0, 20), String(s.note || '').slice(0, 200), s.active !== false]
        );
        if (s.id) sidMap.set(s.id, r.rows[0].id);
        studentsAdded += 1;
      }

      // التحضير: إضافة الناقص فقط (الأيام المسموحة)
      let recordsAdded = 0;
      let recordsSkipped = 0;
      for (const [date, day] of Object.entries(attendance)) {
        if (!isAllowedAttendanceDate(date)) { recordsSkipped += 1; continue; }
        for (const [legacySid, rec] of Object.entries(day || {})) {
          const status = rec && STATUSES.includes(rec.status) ? rec.status : null;
          const note = rec && rec.note ? String(rec.note).slice(0, 200) : '';
          if (!status && !note) { recordsSkipped += 1; continue; }
          const sid = sidMap.get(legacySid);
          if (!sid) { recordsSkipped += 1; continue; }
          const exists = await client.query(
            'SELECT 1 FROM attendance WHERE session_date = $1 AND student_id = $2',
            [date, sid]
          );
          if (exists.rowCount) { recordsSkipped += 1; continue; }
          await client.query(
            'INSERT INTO attendance (session_date, student_id, status, note, recorded_by) VALUES ($1, $2, $3, $4, $5)',
            [date, sid, status, note, req.user.id]
          );
          recordsAdded += 1;
        }
      }

      return { studentsAdded, studentsSkipped, recordsAdded, recordsSkipped, groupsCreated };
    });

    await logAudit(req, 'local_migration', 'migration', 'localStorage', result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
