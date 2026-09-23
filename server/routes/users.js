'use strict';

/**
 * إدارة المشرفين ومديري النظام — لمدير النظام فقط.
 * لا حذف نهائي للحسابات (للحفاظ على سجل التدقيق) — بدلاً من ذلك: إيقاف.
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const { query, withTransaction } = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../middleware/audit');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const USERNAME_RE = /^[\p{L}\p{N}._\-]{3,40}$/u;
const BCRYPT_ROUNDS = 12;

function publicUser(u, groupIds) {
  return {
    id: u.id,
    username: u.username,
    fullName: u.full_name,
    role: u.role,
    active: u.active,
    lastLoginAt: u.last_login_at,
    createdAt: u.created_at,
    groupIds: groupIds || [],
  };
}

async function groupsOf(supervisorId) {
  const r = await query(
    'SELECT group_id FROM supervisor_groups WHERE supervisor_id = $1 ORDER BY group_id',
    [supervisorId]
  );
  return r.rows.map((x) => x.group_id);
}

async function activeAdminCount(exceptId = null) {
  const r = await query(
    `SELECT count(*)::int AS n FROM users
     WHERE role = 'admin' AND active = TRUE AND ($1::uuid IS NULL OR id <> $1)`,
    [exceptId]
  );
  return r.rows[0].n;
}

async function setGroups(client, userId, groupIds) {
  await client.query('DELETE FROM supervisor_groups WHERE supervisor_id = $1', [userId]);
  for (const gid of groupIds) {
    await client.query(
      'INSERT INTO supervisor_groups (supervisor_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [userId, gid]
    );
  }
}

async function validGroupIds(groupIds) {
  if (!groupIds.length) return [];
  const r = await query('SELECT id FROM groups WHERE id = ANY($1::uuid[])', [groupIds]);
  return r.rows.map((x) => x.id);
}

// GET /api/users — قائمة الحسابات (للمدير)
router.get('/', async (req, res, next) => {
  try {
    const r = await query(
      'SELECT id, username, full_name, role, active, last_login_at, created_at FROM users ORDER BY active DESC, username'
    );
    const users = [];
    for (const u of r.rows) {
      users.push(publicUser(u, await groupsOf(u.id)));
    }
    res.json({ users });
  } catch (err) {
    next(err);
  }
});

// POST /api/users — إضافة حساب
router.post('/', async (req, res, next) => {
  try {
    const username = String((req.body && req.body.username) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');
    const fullName = String((req.body && req.body.fullName) || '').trim().slice(0, 80);
    const role = String((req.body && req.body.role) || 'supervisor');
    const groupIds = Array.isArray(req.body && req.body.groupIds) ? req.body.groupIds.map(String) : [];

    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'اسم الدخول: 3 أحرف فأكثر (حروف وأرقام و . _ -)' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'كلمة المرور 8 أحرف على الأقل' });
    }
    if (role !== 'admin' && role !== 'supervisor') {
      return res.status(400).json({ error: 'الدور غير صالح' });
    }
    if (role === 'admin' && groupIds.length) {
      return res.status(400).json({ error: 'الإسناد للحلقات للمشرفين فقط' });
    }

    const exists = await query('SELECT 1 FROM users WHERE username = $1', [username]);
    if (exists.rowCount) return res.status(409).json({ error: 'اسم الدخول مستخدم مسبقاً' });

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const cleanIds = await validGroupIds(groupIds);

    const u = await withTransaction(async (client) => {
      const r = await client.query(
        `INSERT INTO users (username, password_hash, full_name, role)
         VALUES ($1, $2, $3, $4) RETURNING id, username, full_name, role, active, last_login_at, created_at`,
        [username, hash, fullName, role]
      );
      const row = r.rows[0];
      if (role === 'supervisor') await setGroups(client, row.id, cleanIds);
      return row;
    });

    await logAudit(req, 'user_create', 'user', u.id, { username, role });
    res.status(201).json({ user: publicUser(u, role === 'supervisor' ? cleanIds : []) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/users/:id — تعديل حساب (اسم/دور/تفعيل/كلمة مرور/حلقات)
router.patch('/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const body = req.body || {};
    const cur = await query('SELECT * FROM users WHERE id = $1', [id]);
    if (!cur.rowCount) return res.status(404).json({ error: 'الحساب غير موجود' });
    const u = cur.rows[0];
    const isSelf = req.user.id === id;

    const fullName = body.fullName !== undefined ? String(body.fullName).trim().slice(0, 80) : u.full_name;
    const role = body.role !== undefined ? String(body.role) : u.role;
    const active = body.active !== undefined ? !!body.active : u.active;
    const password = body.password !== undefined ? String(body.password) : '';

    if (role !== 'admin' && role !== 'supervisor') {
      return res.status(400).json({ error: 'الدور غير صالح' });
    }
    if (password && password.length < 8) {
      return res.status(400).json({ error: 'كلمة المرور 8 أحرف على الأقل' });
    }

    // حماية: لا يقفل المدير حسابه أو يُنزل صلاحيته بنفسه
    if (isSelf && (!active || role !== 'admin')) {
      return res.status(400).json({ error: 'لا يمكنك إيقاف حسابك أو تغيير دورك بنفسك' });
    }
    // حماية: لا يبقى النظام بدون مدير نشط
    if (!active || role !== 'admin') {
      if (u.role === 'admin' && u.active && (await activeAdminCount(id)) === 0) {
        return res.status(400).json({ error: 'لا يمكن إيقاف آخر مدير نظام نشط' });
      }
    }

    let groupIds = null;
    if (Array.isArray(body.groupIds)) {
      if (role === 'admin' && body.groupIds.length) {
        return res.status(400).json({ error: 'الإسناد للحلقات للمشرفين فقط' });
      }
      groupIds = await validGroupIds(body.groupIds.map(String));
    }

    const hash = password ? await bcrypt.hash(password, BCRYPT_ROUNDS) : u.password_hash;

    const updated = await withTransaction(async (client) => {
      const r = await client.query(
        `UPDATE users SET full_name = $2, role = $3, active = $4, password_hash = $5, updated_at = now()
         WHERE id = $1
         RETURNING id, username, full_name, role, active, last_login_at, created_at`,
        [id, fullName, role, active, hash]
      );
      const row = r.rows[0];
      const finalGroups = groupIds !== null
        ? (role === 'supervisor' ? groupIds : [])
        : (role === 'supervisor' ? await groupsOf(id) : []);
      if (groupIds !== null) {
        if (role === 'supervisor') await setGroups(client, id, groupIds);
        else await client.query('DELETE FROM supervisor_groups WHERE supervisor_id = $1', [id]);
      }
      return { row, finalGroups };
    });

    await logAudit(req, 'user_update', 'user', id, {
      fullName,
      role,
      active,
      passwordChanged: !!password,
      groupIds: updated.finalGroups,
    });
    res.json({ user: publicUser(updated.row, updated.finalGroups) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
