'use strict';

/**
 * سجل العمليات المهمة (Audit Log) — قراءة لمدير النظام.
 */
const express = require('express');
const { query } = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireAdmin);

// GET /api/audit?limit=50
router.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const r = await query(
      `SELECT id, username, action, entity, entity_id, details, ip, created_at
       FROM audit_log ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    res.json({
      entries: r.rows.map((e) => ({
        id: e.id,
        username: e.username,
        action: e.action,
        entity: e.entity,
        entityId: e.entity_id,
        details: e.details,
        at: new Date(e.created_at).getTime(),
      })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
