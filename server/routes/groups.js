'use strict';

/**
 * مسارات الحلقات.
 * المدير: كل الحلقات. المشرف: الحلقات المسندة له فقط.
 */
const express = require('express');
const { query } = require('../db/pool');
const { requireAuth, allowedGroupIds } = require('../middleware/auth');

const router = express.Router();

// GET /api/groups — قائمة الحلقات حسب الصلاحية
router.get('/', requireAuth, async (req, res, next) => {
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

module.exports = router;
