'use strict';

/**
 * حساب الإحصائيات — نسخة مطابقة حرفياً لمنطق الواجهة الحالية (computeStats):
 * - نسب الحضور وفق إعدادات (lateCountsAsPresent / excludeExcused) من قاعدة البيانات.
 * - الغياب المتتالي يُحسب على كل الجلسات المسجلة تاريخياً (ليس فترة التقرير فقط).
 * - الجلسات الفارغة (بلا أي تسجيل) لا تدخل جدول الجلسات.
 */
const { query } = require('../db/pool');
const { allowedGroupIds } = require('../middleware/auth');

const MIN_KEY = '0000-00-00';
const MAX_KEY = '9999-99-99';
const STATUSES = ['present', 'late', 'absent', 'excused'];

function computeRate(ps, settings) {
  const lateCountsAsPresent = settings.lateCountsAsPresent !== false;
  const excludeExcused = settings.excludeExcused !== false;
  const num = ps.present + (lateCountsAsPresent ? ps.late : 0);
  const den = ps.present + ps.late + ps.absent + (excludeExcused ? 0 : ps.excused);
  return den ? Math.round((num / den) * 100) : null;
}

async function computeStatsFor(user, opts) {
  const { from = MIN_KEY, to = MAX_KEY, group = 'all', includeInactive = false } = opts || {};
  const scope = await allowedGroupIds(user);

  const settingsR = await query("SELECT value FROM settings WHERE key = 'app'");
  const settings = settingsR.rows.length ? settingsR.rows[0].value : {};

  // الطلاب — نفس فلترة visibleStudents(group, '', includeInactive)
  const where = [];
  const params = [];
  const add = (val) => { params.push(val); return '$' + params.length; };
  if (scope !== null) where.push(`group_id = ANY(${add(scope)}::uuid[])`);
  if (group === 'none') where.push('group_id IS NULL');
  else if (group && group !== 'all') where.push(`group_id = ${add(String(group))}::uuid`);
  if (!includeInactive) where.push('active = TRUE');

  const studentsR = await query(
    `SELECT * FROM students ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`,
    params
  );
  const students = studentsR.rows
    .map((s) => ({
      id: s.id,
      name: s.name,
      groupId: s.group_id || '',
      phone: s.phone,
      note: s.note,
      active: s.active,
    }));

  // سجلات التحضير لكل هؤلاء الطلاب (كل التاريخ — للغياب المتتالي)
  const ids = students.map((s) => s.id);
  const attR = ids.length
    ? await query(
      `SELECT session_date::text AS date, student_id, status, note
       FROM attendance WHERE student_id = ANY($1::uuid[])`,
      [ids]
    )
    : { rows: [] };

  const perStudent = new Map(students.map((s) => [s.id, {
    student: s, present: 0, late: 0, absent: 0, excused: 0, total: 0, rate: null, streak: 0,
  }]));

  // تجميع كل السجلات حسب التاريخ (للحسبة اليومية وللغياب المتتالي)
  const byDate = new Map();
  const perStudentRows = new Map();
  for (const r of attR.rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, new Map());
    byDate.get(r.date).set(r.student_id, r);
    if (!perStudentRows.has(r.student_id)) perStudentRows.set(r.student_id, []);
    perStudentRows.get(r.student_id).push(r);
  }

  const allDates = Array.from(byDate.keys()).sort();
  const dates = allDates.filter((k) => k >= from && k <= to);
  const perDate = [];

  for (const k of dates) {
    const day = byDate.get(k) || new Map();
    const row = { date: k, present: 0, late: 0, absent: 0, excused: 0, unmarked: 0, recorded: 0 };
    for (const s of students) {
      const rec = day.get(s.id);
      if (rec && STATUSES.includes(rec.status)) {
        row[rec.status] += 1;
        row.recorded += 1;
        const ps = perStudent.get(s.id);
        ps[rec.status] += 1;
        ps.total += 1;
      } else {
        row.unmarked += 1;
      }
    }
    if (row.recorded) perDate.push(row);
  }

  let num = 0;
  let den = 0;
  const lateCountsAsPresent = settings.lateCountsAsPresent !== false;
  const excludeExcused = settings.excludeExcused !== false;
  for (const ps of perStudent.values()) {
    ps.rate = computeRate(ps, settings);
    num += ps.present + (lateCountsAsPresent ? ps.late : 0);
    den += ps.present + ps.late + ps.absent + (excludeExcused ? 0 : ps.excused);
  }

  // الغياب المتتالي: على آخر الجلسات المسجلة للطالب (كل الفترة)
  for (const ps of perStudent.values()) {
    const rows = (perStudentRows.get(ps.student.id) || [])
      .filter((r) => STATUSES.includes(r.status))
      .sort((a, b) => (a.date < b.date ? 1 : -1));
    let streak = 0;
    for (const r of rows) {
      if (r.status === 'absent') streak += 1;
      else break;
    }
    ps.streak = streak;
  }

  const overallRate = den ? Math.round((num / den) * 100) : null;
  const attendedTotal = perDate.reduce((acc, r) => acc + r.present + r.late, 0);
  const avgPerSession = perDate.length ? Math.round((attendedTotal / perDate.length) * 10) / 10 : 0;

  return {
    students,
    perStudent: Array.from(perStudent.values()),
    perDate,
    sessions: perDate.length,
    overallRate,
    avgPerSession,
    from,
    to,
  };
}

/** إحصائيات طالب واحد (لسجله) + سجلاته كاملة */
async function historyFor(user, studentId) {
  const settingsR = await query("SELECT value FROM settings WHERE key = 'app'");
  const settings = settingsR.rows.length ? settingsR.rows[0].value : {};

  const rows = await query(
    `SELECT session_date::text AS date, status, note FROM attendance
     WHERE student_id = $1 ORDER BY session_date DESC`,
    [studentId]
  );

  const stats = { present: 0, late: 0, absent: 0, excused: 0, total: 0, rate: null, streak: 0 };
  const records = [];
  for (const r of rows.rows) {
    if (!STATUSES.includes(r.status)) continue;
    stats[r.status] += 1;
    stats.total += 1;
    records.push({ date: r.date, status: r.status, note: r.note || '' });
  }
  stats.rate = computeRate(stats, settings);
  let streak = 0;
  for (const r of records) { // الأحدث أولاً
    if (r.status === 'absent') streak += 1;
    else break;
  }
  stats.streak = streak;
  return { stats, records };
}

module.exports = { computeStatsFor, historyFor, computeRate };
