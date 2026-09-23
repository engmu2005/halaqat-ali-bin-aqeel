'use strict';

/**
 * مسارات الحلقات.
 * المدير: كل الحلقات. المشرف: الحلقات المسندة له فقط.
 * - إضافة حلقة: المدير (تبقى غير مسندة) أو المشرف (تُسنَد له تلقائياً).
 * - تعديل الاسم: المدير لأي حلقة، المشرف لحلقاته.
 * - حذف: المدير لأي حلقة (يصبح طلابها بدون حلقة)، والمشرف للحلقات الفارغة فقط
 *   حتى لا يخرج طلابه من نطاقه دون قصد.
 */
const express = require('express');
const { query, withTransaction } = require('../db/pool');
const { requireAuth, allowedGroupIds, canAccessGroup } = require('../middleware/auth');
const { logAudit } = require('../middleware/audit');

const router = express.Router();
router.use(requireAuth);

const NAME_MAX = 60;

// GET /api/groups — قائمة الحلقات حسب الصلاحية
router.get('/', async (req, res, next) => {
  try {
    const scope = await allowedGroupIds(req.user);
    const r = scope === null
      ? await query('SELECT id, name, created_at FROM groups ORDER BY created_at, name')
      : await query(
        'SELECT id, name, created_at FROM groups WHERE id = ANY($1::uuid[]) ORDER BY created_at, name',
        [scope]
      );
    res.json({ groups: r.rows.map((g) => ({ id: g.id, name: g.name })) });
  } catch (err) {
    next(err);
  }
});

// POST /api/groups — إضافة حلقة
router.post('/', async (req, res, next) => {
  try {
    const name = String((req.body && req.body.name) || '').trim().slice(0, NAME_MAX);
    if (!name) return res.status(400).json({ error: 'اكتب اسم الحلقة' });

    const exists = await query('SELECT 1 FROM groups WHERE name = $1', [name]);
    if (exists.rowCount) return res.status(409).json({ error: 'هذه الحلقة موجودة مسبقاً' });

    const g = await withTransaction(async (client) => {
      const r = await client.query('INSERT INTO groups (name) VALUES ($1) RETURNING id, name', [name]);
      const row = r.rows[0];
      if (req.user.role !== 'admin') {
        // حلقة المشرف الجديدة تُسنَد له تلقائياً
        await client.query(
          'INSERT INTO supervisor_groups (supervisor_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [req.user.id, row.id]
        );
      }
      return row;
    });

    await logAudit(req, 'group_create', 'group', g.id, { name });
    res.status(201).json({ group: { id: g.id, name: g.name } });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/groups/:id — تعديل اسم الحلقة
router.patch('/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const name = String((req.body && req.body.name) || '').trim().slice(0, NAME_MAX);
    if (!name) return res.status(400).json({ error: 'اكتب اسم الحلقة' });
    if (!(await canAccessGroup(req.user, id))) {
      return res.status(403).json({ error: 'لا تملك صلاحية على هذه الحلقة' });
    }

    const exists = await query('SELECT 1 FROM groups WHERE name = $1 AND id <> $2', [name, id]);
    if (exists.rowCount) return res.status(409).json({ error: 'يوجد حلقة بنفس الاسم' });

    const r = await query('UPDATE groups SET name = $2 WHERE id = $1 RETURNING id, name', [id, name]);
    if (!r.rowCount) return res.status(404).json({ error: 'الحلقة غير موجودة' });
    await logAudit(req, 'group_update', 'group', id, { name });
    res.json({ group: { id: r.rows[0].id, name: r.rows[0].name } });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/groups/:id — حذف حلقة (يصبح طلابها بدون حلقة — لا يُحذفون)
router.delete('/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!(await canAccessGroup(req.user, id))) {
      return res.status(403).json({ error: 'لا تملك صلاحية على هذه الحلقة' });
    }
    const g = await query('SELECT id, name FROM groups WHERE id = $1', [id]);
    if (!g.rowCount) return res.status(404).json({ error: 'الحلقة غير موجودة' });

    const count = await query('SELECT count(*)::int AS n FROM students WHERE group_id = $1', [id]);
    const studentsCount = count.rows[0].n;

    // المشرف يحذف الحلقات الفارغة فقط (حماية لطلابه من الخروج من نطاقه)
    if (req.user.role !== 'admin' && studentsCount > 0) {
      return res.status(403).json({
        error: `لا يمكن حذف حلقة تحتوي على طلاب (${studentsCount}) — نقل الطلاب أو حذف الحلقة متاح لمدير النظام`,
      });
    }

    await withTransaction(async (client) => {
      // الطلاب يبقون بدون حلقة (group_id → NULL) تلقائياً عبر ON DELETE SET NULL
      await client.query('DELETE FROM groups WHERE id = $1', [id]);
    });
    await logAudit(req, 'group_delete', 'group', id, { name: g.rows[0].name, studentsCount });
    res.json({ ok: true, studentsCount });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
