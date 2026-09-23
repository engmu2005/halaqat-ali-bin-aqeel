'use strict';

/**
 * تسجيل العمليات المهمة (Audit Log).
 * كل عملية حساسة (دخول، إضافة، تعديل، حذف، تحضير جماعي، استعادة…) تُسجَّل هنا.
 */
const { query } = require('../db/pool');

async function logAudit(req, action, entity, entityId, details) {
  try {
    await query(
      `INSERT INTO audit_log (user_id, username, action, entity, entity_id, details, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        (req.session && req.session.userId) || null,
        (req.session && req.session.username) || '',
        String(action),
        String(entity || ''),
        String(entityId || ''),
        JSON.stringify(details || {}),
        String(req.ip || ''),
      ]
    );
  } catch (err) {
    // فشل التسجيل لا يجب أن يوقف العملية، لكن يُسجَّل في السجل
    console.error('فشل تسجيل Audit:', err.message);
  }
}

module.exports = { logAudit };
