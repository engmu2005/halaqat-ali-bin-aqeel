'use strict';

/**
 * مسارات التحضير — المصدر الأساسي للحقيقة في PostgreSQL.
 * سطر لكل (يوم جلسة، طالب): حالة + ملاحظة الجلسة.
 * قواعد التطبيق (أيام الأحد ابتداءً من 2026-09-27) تُفرض هنا أيضاً لا في الواجهة فقط.
 */
const express = require('express');
const { query } = require('../db/pool');
const { requireAuth, canAccessStudent } = require('../middleware/auth');
const { logAudit } = require('../middleware/audit');
const { isAllowedAttendanceDate } = require('../lib/dates');

const router = express.Router();
router.use(requireAuth);

const STATUSES = ['present', 'late', 'absent', 'excused'];
const NOTE_MAX = 200;

function mapRecord(r) {
  return {
    status: r.status || null,
    note: r.note || '',
    at: new Date(r.updated_at || r.recorded_at).getTime(),
  };
}

function checkDate(date) {
  if (!isAllowedAttendanceDate(date)) {
    return 'التحضير متاح فقط أيام الأحد ابتداءً من 27/09/2026';
  }
  return null;
}

async function getRow(date, studentId) {
  const r = await query(
    'SELECT session_date::text AS date, student_id, status, note, recorded_at, updated_at FROM attendance WHERE session_date = $1 AND student_id = $2',
    [date, studentId]
  );
  return r.rows[0] || null;
}

async function deleteRow(date, studentId) {
  await query('DELETE FROM attendance WHERE session_date = $1 AND student_id = $2', [date, studentId]);
}

async function upsertRow(date, studentId, status, note, userId) {
  await query(
    `INSERT INTO attendance (session_date, student_id, status, note, recorded_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (session_date, student_id) DO UPDATE
       SET status = EXCLUDED.status, note = EXCLUDED.note, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [date, studentId, status, note || '', userId]
  );
}

// PUT /api/attendance/:date/:studentId — تعيين الحالة و/أو ملاحظة الجلسة
// body: { status?: 'present'|'late'|'absent'|'excused'|null, note?: string }
// نفس منطق setStatus/setNote في التطبيق الحالي (حذف السجل عند الفراغ التام)
router.put('/:date/:studentId', async (req, res, next) => {
  try {
    const { date, studentId } = req.params;
    const dateErr = checkDate(date);
    if (dateErr) return res.status(400).json({ error: dateErr });
    if (!(await canAccessStudent(req.user, studentId))) {
      return res.status(403).json({ error: 'لا تملك صلاحية على هذا الطالب' });
    }

    const b = req.body || {};
    if ('status' in b && b.status !== null && !STATUSES.includes(b.status)) {
      return res.status(400).json({ error: 'حالة الحضور غير صالحة' });
    }
    if ('note' in b && String(b.note || '').length > NOTE_MAX) {
      return res.status(400).json({ error: 'الملاحظة طويلة جداً' });
    }

    let row = await getRow(date, studentId);

    if ('status' in b) {
      const status = b.status;
      if (status === null) {
        if (row && row.note) { row.status = null; } else { row = null; }
      } else {
        row = {
          status,
          note: row && row.note ? row.note : '',
          recorded_at: row ? row.recorded_at : new Date(),
          updated_at: new Date(),
        };
      }
    }

    if ('note' in b) {
      const n = String(b.note || '').trim().slice(0, NOTE_MAX);
      if (row) {
        row.note = n;
        if (!row.status && !n) row = null;
      } else if (n) {
        row = { status: null, note: n, recorded_at: new Date(), updated_at: new Date() };
      }
    }

    if (!row) {
      await deleteRow(date, studentId);
      await logAudit(req, 'attendance_clear', 'attendance', `${date}:${studentId}`, {});
      return res.json({ record: null });
    }

    await upsertRow(date, studentId, row.status, row.note, req.user.id);
    const saved = await getRow(date, studentId);
    await logAudit(req, 'attendance_set', 'attendance', `${date}:${studentId}`, {
      status: saved.status,
      hasNote: !!saved.note,
    });
    return res.json({ record: mapRecord(saved) });
  } catch (err) {
    return next(err);
  }
});

// POST /api/attendance/:date/mark-all — تحضير الجميع كحاضر (للطلاب المحددين وغير المسجَّلين)
router.post('/:date/mark-all', async (req, res, next) => {
  try {
    const { date } = req.params;
    const dateErr = checkDate(date);
    if (dateErr) return res.status(400).json({ error: dateErr });

    const ids = Array.isArray(req.body && req.body.studentIds) ? req.body.studentIds.map(String) : [];
    if (!ids.length) return res.json({ marked: 0 });

    // فلترة ما يملك صلاحية عليه فعلاً
    const allowed = [];
    for (const id of ids) {
      if (await canAccessStudent(req.user, id)) allowed.push(id);
    }

    let marked = 0;
    for (const id of allowed) {
      const row = await getRow(date, id);
      if (row && row.status) continue; // مسجَّل مسبقاً
      // يحفظ الملاحظة إن وُجدت (نفس setStatus الحالي)
      await upsertRow(date, id, 'present', row ? row.note : '', req.user.id);
      marked += 1;
    }
    await logAudit(req, 'attendance_mark_all', 'attendance', date, { marked, requested: ids.length });
    res.json({ marked });
  } catch (err) {
    next(err);
  }
});

// POST /api/attendance/:date/clear — مسح تحضير اليوم للطلاب المحددين (الظاهرين بالفلتر)
router.post('/:date/clear', async (req, res, next) => {
  try {
    const { date } = req.params;
    const dateErr = checkDate(date);
    if (dateErr) return res.status(400).json({ error: dateErr });

    const ids = Array.isArray(req.body && req.body.studentIds) ? req.body.studentIds.map(String) : [];
    if (!ids.length) return res.json({ cleared: 0 });

    const allowed = [];
    for (const id of ids) {
      if (await canAccessStudent(req.user, id)) allowed.push(id);
    }

    let cleared = 0;
    for (const id of allowed) {
      const r = await query('DELETE FROM attendance WHERE session_date = $1 AND student_id = $2', [date, id]);
      cleared += r.rowCount;
    }
    await logAudit(req, 'attendance_clear_day', 'attendance', date, { cleared });
    res.json({ cleared });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
