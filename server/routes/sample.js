'use strict';

/**
 * بيانات تجريبية (كما في زر «إضافة بيانات تجريبية» الحالي) — لمدير النظام.
 * ينشئ حلقتين وطلاباً وسجلات لأيام الأحد السابقة من 27/09/2026.
 */
const express = require('express');
const { query, withTransaction } = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../middleware/audit');
const { addDays, isAllowedAttendanceDate, toKey, fromKey } = require('../lib/dates');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const NAMES_1 = ['أحمد بن محمد', 'خالد بن عبدالله', 'سعد بن فهد', 'عبدالرحمن بن صالح', 'فيصل بن ناصر'];
const NAMES_2 = ['محمد بن إبراهيم', 'يوسف بن سلطان', 'عمر بن عبدالعزيز', 'بدر بن حمد'];
const PATTERN = ['present', 'present', 'late', 'absent', 'present', 'excused', 'present', 'absent'];

function todayKey() { return toKey(new Date()); }

function defaultAttendanceDate() {
  const ATTENDANCE_START = '2026-09-27';
  const t = todayKey();
  if (t < ATTENDANCE_START) return ATTENDANCE_START;
  const day = fromKey(t).getDay();
  const sunday = addDays(t, -day);
  return sunday < ATTENDANCE_START ? ATTENDANCE_START : sunday;
}

router.post('/', async (req, res, next) => {
  try {
    const result = await withTransaction(async (client) => {
      const ensureGroup = async (name) => {
        let g = await client.query('SELECT id FROM groups WHERE name = $1', [name]);
        if (!g.rowCount) {
          g = await client.query('INSERT INTO groups (name) VALUES ($1) RETURNING id', [name]);
        }
        return g.rows[0].id;
      };
      const g1 = await ensureGroup('الحلقة الأولى');
      const g2 = await ensureGroup('الحلقة الثانية');

      let added = 0;
      const all = [];
      const addIfMissing = async (name, gid) => {
        const exists = await client.query(
          `SELECT 1 FROM students WHERE name = $1 AND COALESCE(group_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
          [name, gid]
        );
        if (exists.rowCount) {
          const s = await client.query(
            'SELECT id FROM students WHERE name = $1 AND group_id = $2',
            [name, gid]
          );
          if (s.rowCount) all.push(s.rows[0].id);
          return;
        }
        const r = await client.query(
          'INSERT INTO students (name, group_id) VALUES ($1, $2) RETURNING id',
          [name, gid]
        );
        added += 1;
        all.push(r.rows[0].id);
      };
      for (const n of NAMES_1) await addIfMissing(n, g1);
      for (const n of NAMES_2) await addIfMissing(n, g2);

      // سجلات لأيام الأحد حتى 6 أسابيع سابقة
      const base = defaultAttendanceDate();
      let records = 0;
      for (let w = 0; w < 6; w += 1) {
        const k = addDays(base, -w * 7);
        if (!isAllowedAttendanceDate(k)) break;
        for (let i = 0; i < all.length; i += 1) {
          const status = PATTERN[(i + w) % PATTERN.length];
          await client.query(
            `INSERT INTO attendance (session_date, student_id, status, recorded_by)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (session_date, student_id) DO UPDATE SET status = EXCLUDED.status, updated_at = now()`,
            [k, all[i], status, req.user.id]
          );
          records += 1;
        }
      }
      return { added, records };
    });

    await logAudit(req, 'sample_data_add', 'sample', '', result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
