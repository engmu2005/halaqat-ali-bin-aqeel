'use strict';

/**
 * مسارات الطلاب (CRUD + إضافة جماعية + استيراد).
 * المدير: كل الطلاب. المشرف: طلاب حلقاته المسندة فقط.
 * الحذف نهائي ويحذف سجلات التحضير (كما في التطبيق الحالي) ويُسجَّل في Audit.
 */
const express = require('express');
const { query } = require('../db/pool');
const { requireAuth, allowedGroupIds, canAccessGroup, canAccessStudent } = require('../middleware/auth');
const { logAudit } = require('../middleware/audit');
const { historyFor } = require('../services/stats');

const router = express.Router();
router.use(requireAuth);

const NAME_MAX = 80;
const PHONE_MAX = 20;
const NOTE_MAX = 200;
const NO_GROUP = '00000000-0000-0000-0000-000000000000';

function mapStudent(r) {
  return {
    id: r.id,
    name: r.name,
    groupId: r.group_id || '',
    phone: r.phone,
    note: r.note,
    active: r.active,
    createdAt: r.created_at ? new Date(r.created_at).getTime() : Date.now(),
  };
}

async function findDuplicate(name, groupId, exceptId) {
  const r = await query(
    `SELECT 1 FROM students
     WHERE name = $1 AND COALESCE(group_id, '${NO_GROUP}'::uuid) = COALESCE($2::uuid, '${NO_GROUP}'::uuid)
       AND ($3::uuid IS NULL OR id <> $3)`,
    [name, groupId || null, exceptId || null]
  );
  return r.rowCount > 0;
}

async function studentExists(id) {
  const r = await query('SELECT id, group_id FROM students WHERE id = $1', [id]);
  return r.rows[0] || null;
}

// GET /api/students?group=all|none|<uuid>&search=&includeInactive=1
router.get('/', async (req, res, next) => {
  try {
    const scope = await allowedGroupIds(req.user);
    const { group, search, includeInactive } = req.query;

    const where = [];
    const params = [];
    const add = (sql, val) => { params.push(val); return sql.replace('$?', `$${params.length}`); };

    if (scope !== null) {
      where.push(add('group_id = ANY($?::uuid[])', scope));
    }
    if (group === 'none') {
      where.push('group_id IS NULL');
    } else if (group && group !== 'all') {
      where.push(add('group_id = $?::uuid', String(group)));
    }
    if (!includeInactive || includeInactive === '0') {
      where.push('active = TRUE');
    }
    if (search && String(search).trim()) {
      params.push(`%${String(search).trim()}%`);
      const i = params.length;
      where.push(`(name ILIKE $${i} OR phone LIKE $${i})`);
    }

    const sql = `SELECT * FROM students ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY name`;
    const r = await query(sql, params);
    res.json({ students: r.rows.map(mapStudent) });
  } catch (err) {
    next(err);
  }
});

// POST /api/students — إضافة طالب
router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const groupId = String(b.groupId || '').trim();
    const phone = String(b.phone || '').trim().slice(0, PHONE_MAX);
    const note = String(b.note || '').trim().slice(0, NOTE_MAX);

    if (!name || name.length > NAME_MAX) return res.status(400).json({ error: 'اسم الطالب مطلوب (80 حرفاً كحد أقصى)' });
    if (note.length > NOTE_MAX) return res.status(400).json({ error: 'الملاحظة طويلة جداً' });
    if (groupId && !(await canAccessGroup(req.user, groupId))) {
      return res.status(403).json({ error: 'لا تملك صلاحية على هذه الحلقة' });
    }
    if (!groupId && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'إضافة طالب بدون حلقة لمدير النظام فقط' });
    }
    if (await findDuplicate(name, groupId || null)) {
      return res.status(409).json({ error: 'يوجد طالب بنفس الاسم في هذه الحلقة' });
    }

    const r = await query(
      'INSERT INTO students (name, group_id, phone, note) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, groupId || null, phone, note]
    );
    await logAudit(req, 'student_create', 'student', r.rows[0].id, { name, groupId });
    res.status(201).json({ student: mapStudent(r.rows[0]) });
  } catch (err) {
    next(err);
  }
});

// POST /api/students/bulk — إضافة قائمة أسماء (دفعة واحدة) مع تخطي المكرر
router.post('/bulk', async (req, res, next) => {
  try {
    const b = req.body || {};
    const groupId = String(b.groupId || '').trim();
    const items = Array.isArray(b.items) ? b.items : [];

    if (groupId && !(await canAccessGroup(req.user, groupId))) {
      return res.status(403).json({ error: 'لا تملك صلاحية على هذه الحلقة' });
    }
    if (!groupId && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'إضافة طلاب بدون حلقة لمدير النظام فقط' });
    }
    if (!items.length) return res.status(400).json({ error: 'اكتب اسماً واحداً على الأقل' });

    let added = 0;
    let skipped = 0;
    for (const it of items) {
      const name = String((it && it.name) || '').trim().slice(0, NAME_MAX);
      if (!name) continue;
      const phone = String((it && it.phone) || '').trim().slice(0, PHONE_MAX);
      if (await findDuplicate(name, groupId || null)) { skipped += 1; continue; }
      await query(
        'INSERT INTO students (name, group_id, phone) VALUES ($1, $2, $3)',
        [name, groupId || null, phone]
      );
      added += 1;
    }
    await logAudit(req, 'student_bulk_create', 'group', groupId, { added, skipped });
    res.status(201).json({ added, skipped });
  } catch (err) {
    next(err);
  }
});

// POST /api/students/import — استيراد من Excel/CSV (للمدير — ينشئ حلقات عند الحاجة)
router.post('/import', async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'الاستيراد من ملفات لمدير النظام فقط — استخدم «إضافة قائمة أسماء» داخل حلقاتك' });
    }
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: 'لم يتم العثور على أسماء في الملف' });

    let added = 0;
    let skipped = 0;
    let groupsCreated = 0;
    for (const it of items) {
      const name = String((it && it.name) || '').trim().slice(0, NAME_MAX);
      if (!name) continue;
      const phone = String((it && it.phone) || '').trim().slice(0, PHONE_MAX);
      const groupName = String((it && it.group) || '').trim().slice(0, 60);

      // إنشاء الحلقة إن لم توجد (نفس findOrCreateGroup الحالي)
      let groupId = null;
      if (groupName) {
        let g = await query('SELECT id FROM groups WHERE name = $1', [groupName]);
        if (!g.rowCount) {
          g = await query('INSERT INTO groups (name) VALUES ($1) RETURNING id', [groupName]);
          groupsCreated += 1;
        }
        groupId = g.rows[0].id;
      }
      if (await findDuplicate(name, groupId)) { skipped += 1; continue; }
      await query(
        'INSERT INTO students (name, group_id, phone) VALUES ($1, $2, $3)',
        [name, groupId, phone]
      );
      added += 1;
    }
    await logAudit(req, 'student_import', 'students', '', { added, skipped, groupsCreated });
    res.status(201).json({ added, skipped, groupsCreated });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/students/:id — تعديل بيانات طالب (يشمل الأرشفة عبر active)
router.patch('/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const cur = await studentExists(id);
    if (!cur) return res.status(404).json({ error: 'الطالب غير موجود' });
    if (!(await canAccessStudent(req.user, id))) {
      return res.status(403).json({ error: 'لا تملك صلاحية على هذا الطالب' });
    }

    const b = req.body || {};
    const name = b.name !== undefined ? String(b.name).trim() : null;
    const groupId = b.groupId !== undefined ? String(b.groupId || '').trim() : null;
    const phone = b.phone !== undefined ? String(b.phone).trim().slice(0, PHONE_MAX) : null;
    const note = b.note !== undefined ? String(b.note).trim().slice(0, NOTE_MAX) : null;
    const active = b.active !== undefined ? !!b.active : null;

    if (name !== null && (!name || name.length > NAME_MAX)) {
      return res.status(400).json({ error: 'اسم الطالب مطلوب (80 حرفاً كحد أقصى)' });
    }
    if (groupId !== null) {
      if (groupId && !(await canAccessGroup(req.user, groupId))) {
        return res.status(403).json({ error: 'لا تملك صلاحية على الحلقة الجديدة' });
      }
      if (!groupId && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'نقل طالب إلى «بدون حلقة» لمدير النظام فقط' });
      }
    }

    const finalName = name !== null ? name : null;
    const dupName = finalName !== null ? finalName : null;
    if (dupName !== null && await findDuplicate(dupName, groupId !== null ? groupId : cur.group_id, id)) {
      return res.status(409).json({ error: 'يوجد طالب بنفس الاسم في هذه الحلقة' });
    }

    const r = await query(
      `UPDATE students SET
         name = COALESCE($2, name),
         group_id = CASE WHEN $3::boolean THEN $4::uuid ELSE group_id END,
         phone = COALESCE($5, phone),
         note = COALESCE($6, note),
         active = COALESCE($7, active),
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, finalName, groupId !== null, groupId ? groupId : null, phone, note, active]
    );
    await logAudit(req, 'student_update', 'student', id, {
      name: r.rows[0].name,
      groupId: r.rows[0].group_id,
      active: r.rows[0].active,
    });
    res.json({ student: mapStudent(r.rows[0]) });
  } catch (err) {
    next(err);
  }
});

// GET /api/students/:id/history — سجل الطالب + إحصائياته (من قاعدة البيانات)
router.get('/:id/history', async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const cur = await studentExists(id);
    if (!cur) return res.status(404).json({ error: 'الطالب غير موجود' });
    if (!(await canAccessStudent(req.user, id))) {
      return res.status(403).json({ error: 'لا تملك صلاحية على هذا الطالب' });
    }
    const { stats, records } = await historyFor(req.user, id);
    res.json({ stats, records });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/students/:id — حذف نهائي + حذف سجلات تحضيره
router.delete('/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const cur = await studentExists(id);
    if (!cur) return res.status(404).json({ error: 'الطالب غير موجود' });
    if (!(await canAccessStudent(req.user, id))) {
      return res.status(403).json({ error: 'لا تملك صلاحية على هذا الطالب' });
    }
    await query('DELETE FROM students WHERE id = $1', [id]); // التحضير يُحذف تلقائياً (ON DELETE CASCADE)
    await logAudit(req, 'student_delete', 'student', id, {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
