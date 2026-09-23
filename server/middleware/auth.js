'use strict';

/**
 * حماية المسارات: تسجيل الدخول + الصلاحيات.
 * الجلسة كوكي httpOnly — لا شيء حساس في الواجهة.
 * الدور يُتحقق منه من قاعدة البيانات في كل طلب (لإيقاف الحساب فوراً).
 */
const { query } = require('../db/pool');

/** يتطلب تسجيل دخول — يضيف req.user من قاعدة البيانات */
async function requireAuth(req, res, next) {
  try {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: 'يجب تسجيل الدخول' });
    }
    const r = await query(
      'SELECT id, username, full_name, role, active FROM users WHERE id = $1',
      [req.session.userId]
    );
    const u = r.rows[0];
    if (!u || !u.active) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'الحساب غير نشط أو غير موجود' });
    }
    req.user = u;
    return next();
  } catch (err) {
    return next(err);
  }
}

/** يتطلب صلاحية مدير النظام */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'هذه العملية متاحة لمدير النظام فقط' });
  }
  return next();
}

/**
 * نطاق الحلقات المسموح للمستخدم:
 * المدير → null (كل الحلقات)
 * المشرف → معرّفات حلقاته المسندة فقط
 */
async function allowedGroupIds(user) {
  if (user.role === 'admin') return null;
  const r = await query(
    'SELECT group_id FROM supervisor_groups WHERE supervisor_id = $1',
    [user.id]
  );
  return r.rows.map((x) => x.group_id);
}

/** هل يملك المشرف صلاحية على حلقة محددة؟ (المدير دائماً نعم) */
async function canAccessGroup(user, groupId) {
  if (user.role === 'admin') return true;
  if (!groupId) return false; // طالب بدون حلقة: للمدير فقط
  const r = await query(
    'SELECT 1 FROM supervisor_groups WHERE supervisor_id = $1 AND group_id = $2',
    [user.id, groupId]
  );
  return r.rowCount > 0;
}

/** هل يملك صلاحية على طالب (عبر حلقته)؟ */
async function canAccessStudent(user, studentId) {
  const r = await query('SELECT group_id FROM students WHERE id = $1', [studentId]);
  if (!r.rowCount) return false;
  return canAccessGroup(user, r.rows[0].group_id);
}

module.exports = { requireAuth, requireAdmin, allowedGroupIds, canAccessGroup, canAccessStudent };
