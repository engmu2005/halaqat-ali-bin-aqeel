'use strict';

/**
 * مسارات التقارير والإحصائيات — تُحسب من قاعدة البيانات فعلياً.
 * GET /api/reports/stats?from=&to=&group=all|none|<uuid>&includeInactive=1
 */
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { computeStatsFor } = require('../services/stats');

const router = express.Router();

router.get('/stats', requireAuth, async (req, res, next) => {
  try {
    const { from, to, group, includeInactive } = req.query;
    const stats = await computeStatsFor(req.user, {
      from: from || undefined,
      to: to || undefined,
      group: group || 'all',
      includeInactive: includeInactive === '1' || includeInactive === 'true',
    });
    res.json(stats);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
