'use strict';

/**
 * اختبار تشغيل شامل (Smoke Test) — npm test
 *
 * المتطلبات:
 * - قاعدة بيانات PostgreSQL متاحة عبر DATABASE_URL (يطبَّق المخطط تلقائياً).
 * - يعمل الاختبار على منفذ عشوائي وينظف كل ما ينشئه بنفسه.
 *
 * يغطي: تسجيل الدخول، الأدوار، الحلقات والطلاب، التحضير وقيود الأحد،
 * التقارير والإحصائيات، النسخ الاحتياطي والاستعادة، الترحيل، وسجل العمليات.
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'smoke-test-secret-0123456789abcdef';

const assert = require('assert');
const { randomUUID } = require('crypto');
const { config } = require('../server/config');
const { migrate } = require('../server/db/migrate');
const { pool } = require('../server/db/pool');
const { createApp } = require('../server/app');
const bcrypt = require('bcryptjs');

let pass = 0;
let fail = 0;
function check(label, ok, extra) {
  if (ok) { pass += 1; console.log('✔ ' + label); }
  else { fail += 1; console.log('✘ ' + label + (extra ? ' — ' + extra : '')); }
}

function makeClient(base) {
  return async function req(method, path, body, cookie) {
    const r = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body !== undefined && body !== null ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await r.json(); } catch (_) { /* empty */ }
    return { status: r.status, data, setCookie: r.headers.get('set-cookie') || '' };
  };
}

async function main() {
  if (!config.databaseUrl) {
    console.error('✘ DATABASE_URL غير مضبوط — انظر .env.example');
    process.exit(1);
  }

  await migrate();

  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const req = makeClient(base);

  // حسابات اختبار بأسماء فريدة
  const suffix = randomUUID().slice(0, 8);
  const adminUser = `adm-${suffix}`;
  const supUser = `sup-${suffix}`;
  const hash = await bcrypt.hash('SmokePass!2026', 4);
  await pool.query(
    "INSERT INTO users (username, password_hash, full_name, role) VALUES ($1, $2, 'اختبار مدير', 'admin'), ($3, $2, 'اختبار مشرف', 'supervisor')",
    [adminUser, hash, supUser]
  );

  try {
    // ===== الدخول =====
    const noAuth = await req('GET', '/bootstrap');
    check('البيانات تتطلب تسجيل الدخول (401)', noAuth.status === 401);
    const badLogin = await req('POST', '/auth/login', { username: adminUser, password: 'wrong' });
    check('كلمة مرور خاطئة تُرفض برسالة موحدة', badLogin.status === 401);
    const adminLogin = await req('POST', '/auth/login', { username: adminUser, password: 'SmokePass!2026' });
    check('تسجيل دخول المدير', adminLogin.status === 200 && adminLogin.data.user.role === 'admin');
    const A = adminLogin.setCookie.split(';')[0];
    const supLogin = await req('POST', '/auth/login', { username: supUser, password: 'SmokePass!2026' });
    const S = supLogin.setCookie.split(';')[0];
    check('تسجيل دخول المشرف', supLogin.status === 200);

    // ===== الحلقات والطلاب والصلاحيات =====
    const g1 = (await req('POST', '/groups', { name: `حلقة1-${suffix}` }, A)).data.group;
    const g2 = (await req('POST', '/groups', { name: `حلقة2-${suffix}` }, A)).data.group;
    check('إنشاء حلقتين', !!g1 && !!g2);
    const supId = adminLogin.data.user.role === 'admin'
      ? (await req('GET', '/users', null, A)).data.users.find((u) => u.username === supUser).id
      : null;
    await req('PATCH', `/users/${supId}`, { groupIds: [g1.id] }, A);

    const s1 = (await req('POST', '/students', { name: `طالب1-${suffix}`, groupId: g1.id }, A)).data.student;
    const s2 = (await req('POST', '/students', { name: `طالب2-${suffix}`, groupId: g2.id }, A)).data.student;
    check('إضافة طالبين', !!s1 && !!s2);
    const dup = await req('POST', '/students', { name: `طالب1-${suffix}`, groupId: g1.id }, A);
    check('منع تكرار الاسم في الحلقة (409)', dup.status === 409);
    const supList = await req('GET', '/students', null, S);
    check('المشرف يرى طلاب حلقاته فقط', supList.data.students.length === 1 && supList.data.students[0].id === s1.id);
    const supBad = await req('PATCH', `/students/${s2.id}`, { note: 'x' }, S);
    check('المشرف لا يعدّل خارج حلقاته (403)', supBad.status === 403);

    // ===== التحضير وقيود الأحد =====
    const D = '2026-09-27';
    const monday = await req('PUT', `/attendance/2026-09-28/${s1.id}`, { status: 'present' }, A);
    check('يوم غير أحد يُرفض', monday.status === 400);
    const before = await req('PUT', `/attendance/2026-09-20/${s1.id}`, { status: 'present' }, A);
    check('قبل 27/09/2026 يُرفض', before.status === 400);
    await req('PUT', `/attendance/${D}/${s1.id}`, { status: 'present' }, A);
    await req('PUT', `/attendance/${D}/${s1.id}`, { note: 'ملاحظة' }, A);
    const withNote = await req('PUT', `/attendance/${D}/${s1.id}`, { status: 'absent' }, A);
    check('تعديل التحضير يبقي ملاحظة الجلسة', withNote.data.record.status === 'absent' && withNote.data.record.note === 'ملاحظة');
    const mark = await req('POST', `/attendance/${D}/mark-all`, { studentIds: [s1.id, s2.id] }, A);
    check('تحضير الجميع يسجّل غير المسجَّلين فقط', mark.data.marked === 1);
    const clear = await req('POST', `/attendance/${D}/clear`, { studentIds: [s1.id, s2.id] }, A);
    check('مسح تحضير اليوم', clear.data.cleared === 2);

    // ===== التقارير =====
    await req('PUT', `/attendance/${D}/${s1.id}`, { status: 'absent' }, A);
    await req('PUT', `/attendance/${D}/${s2.id}`, { status: 'present' }, A);
    const stats = (await req('GET', '/reports/stats', null, A)).data;
    check('الإحصائيات من قاعدة البيانات', stats.sessions === 1 && stats.overallRate === 50, JSON.stringify({ s: stats.sessions, r: stats.overallRate }));
    const hist = (await req('GET', `/students/${s1.id}/history`, null, A)).data;
    check('سجل الطالب وغيابه المتتالي', hist.records.length === 1 && hist.stats.streak === 1);

    // ===== النسخ الاحتياطي والاستعادة =====
    const exp = await req('GET', '/backup/export', null, A);
    const raw = JSON.stringify(exp.data);
    check('النسخة الاحتياطية بلا أسرار', exp.status === 200 && !raw.includes('password') && !raw.includes('SmokePass'));
    const restore = await req('POST', '/backup/restore', exp.data, A);
    check('الاستعادة من النسخة', restore.status === 200 && restore.data.studentsAdded === exp.data.students.length, JSON.stringify(restore.data));

    // ===== الترحيل =====
    const legacy = {
      students: [{ id: randomUUID(), name: `قديم-${suffix}`, groupId: '', phone: '', note: '', active: true, createdAt: 1 }],
      groups: [],
      attendance: { [D]: {} },
    };
    const mig = await req('POST', '/migration/import-local', legacy, A);
    check('ترحيل بيانات الجهاز', mig.status === 200 && mig.data.studentsAdded === 1);

    // ===== سجل العمليات =====
    const audit = await req('GET', '/audit', null, A);
    const actions = audit.data.entries.map((e) => e.action);
    check('سجل العمليات يوثق العمليات المهمة',
      ['login', 'student_create', 'attendance_mark_all', 'backup_export', 'backup_restore', 'local_migration'].every((a) => actions.includes(a)),
      JSON.stringify(actions));

    // ===== حماية الحسابات =====
    const leakProbe = JSON.stringify([audit.data, exp.data, (await req('GET', '/users', null, A)).data]);
    check('لا تسرّب كلمات مرور أو أسرار في أي استجابة',
      !leakProbe.includes('SmokePass') && !leakProbe.includes('password_hash') && !leakProbe.includes('$2'));
    const supUsers = await req('GET', '/users', null, S);
    check('المشرف لا يرى إدارة الحسابات', supUsers.status === 403);
  } finally {
    // تنظيف كل ما أنشأه الاختبار
    await pool.query('DELETE FROM students WHERE name LIKE $1', [`%-${suffix}`]);
    await pool.query('DELETE FROM groups WHERE name LIKE $1', [`%-${suffix}`]);
    await pool.query('DELETE FROM users WHERE username IN ($1, $2)', [adminUser, supUser]);
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }

  console.log(`\nالنتيجة النهائية: ${pass} ناجح / ${fail} فاشل`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('✘ فشل الاختبار:', err);
  process.exit(1);
});
