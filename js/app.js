/* =========================================================
   تحضير درس بلوغ المرام – حلقات علي بن عقيل – جمعية الدعوة
   نظام Web متعدد المستخدمين — قاعدة البيانات PostgreSQL هي المصدر الأساسي للحقيقة
   (localStorage لا يُستخدم إلا لتفضيلات محلية وترحيل البيانات القديمة)
   ========================================================= */
(function () {
  'use strict';

  /* ------------------------------------------------------
     الثوابت
  ------------------------------------------------------ */
  const APP_VERSION = '1.0.1';
  const STORAGE_KEY = 'bulugh-app:v1';
  const MIN_KEY = '0000-00-00';
  const MAX_KEY = '9999-99-99';
  const ATTENDANCE_START = '2026-09-27'; // أول يوم تحضير: الأحد 27/09/2026

  function pad(n) { return String(n).padStart(2, '0'); }
  function toKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function fromKey(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); }
  function todayKey() { return toKey(new Date()); }
  function addDays(k, n) { const d = fromKey(k); d.setDate(d.getDate() + n); return toKey(d); }
  function isValidKey(k) { return /^\d{4}-\d{2}-\d{2}$/.test(k || ''); }

  // التحضير متاح فقط أيام الأحد ابتداءً من 2026-09-27
  function isSundayKey(k) { return isValidKey(k) && fromKey(k).getDay() === 0; }
  function isAllowedAttendanceDate(k) { return isValidKey(k) && k >= ATTENDANCE_START && isSundayKey(k); }
  function defaultAttendanceDate() {
    const t = todayKey();
    if (t < ATTENDANCE_START) return ATTENDANCE_START;
    const day = fromKey(t).getDay();
    const sunday = addDays(t, -day);
    return sunday < ATTENDANCE_START ? ATTENDANCE_START : sunday;
  }
  function nextValidAttendanceDate(k) {
    if (!isValidKey(k) || k < ATTENDANCE_START) return ATTENDANCE_START;
    const day = fromKey(k).getDay();
    if (day === 0) return k;
    return addDays(k, 7 - day);
  }

  const STATUSES = [
    { id: 'present', label: 'حاضر', short: 'ح', emoji: '✅' },
    { id: 'late', label: 'متأخر', short: 'م', emoji: '⏰' },
    { id: 'absent', label: 'غائب', short: 'غ', emoji: '❌' },
    { id: 'excused', label: 'مستأذن', short: 'ع', emoji: '📝' },
  ];
  const STATUS_MAP = Object.fromEntries(STATUSES.map((s) => [s.id, s]));

  const ICONS = {
    note: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4Z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>',
    history: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  };

  /* ------------------------------------------------------
     الحالة والتخزين
  ------------------------------------------------------ */
  const defaultSettings = () => ({
    lessonName: 'درس بلوغ المرام',
    orgName: 'حلقات علي بن عقيل – جمعية الدعوة',
    teacherName: '',
    showHijri: true,
    lateCountsAsPresent: true,
    excludeExcused: true,
    absenceAlertThreshold: 3,
  });

  const defaultState = () => ({
    version: 1,
    settings: defaultSettings(),
    groups: [],
    students: [],
    attendance: {},
    meta: { createdAt: Date.now(), lastBackupAt: null },
  });

  function normalize(data) {
    const base = defaultState();
    const src = data && typeof data === 'object' ? data : {};
    const s = Object.assign(base, src);
    s.settings = Object.assign(defaultSettings(), src.settings || {});
    s.groups = Array.isArray(src.groups) ? src.groups.filter((g) => g && g.id && g.name) : [];
    s.students = Array.isArray(src.students) ? src.students.filter((st) => st && st.id && st.name) : [];
    s.attendance = src.attendance && typeof src.attendance === 'object' ? src.attendance : {};
    s.meta = Object.assign({ createdAt: Date.now(), lastBackupAt: null }, src.meta || {});
    return s;
  }

  // البيانات تُحمَّل من الخادم فقط — قاعدة البيانات هي المصدر الأساسي للحقيقة
  // (localStorage لا يُستخدم إلا لتفضيلات محلية وترحيل البيانات القديمة)
  async function loadFromServer() {
    const data = await apiFetch('GET', '/api/bootstrap');
    state = normalize({
      version: 1,
      settings: data.settings || {},
      groups: data.groups || [],
      students: data.students || [],
      attendance: data.attendance || {},
      meta: {
        createdAt: (state.meta && state.meta.createdAt) || Date.now(),
        lastBackupAt: data.meta ? data.meta.lastBackupAt : null,
      },
    });
  }

  let state = defaultState();

  const ui = {
    date: defaultAttendanceDate(),
    attGroup: 'all',
    attSearch: '',
    stSearch: '',
    stGroup: 'all',
    stShowInactive: false,
    rpPeriod: 'month',
    rpFrom: '',
    rpTo: '',
    rpGroup: 'all',
    rpSort: { key: 'name', dir: 1 },
    editingId: null,
  };

  let lastReport = null;
  let deferredInstallPrompt = null;
  let currentUser = null;
  let usersCache = [];
  let groupsCatalog = [];
  let editingUserId = null;

  /* ------------------------------------------------------
     أدوات عامة
  ------------------------------------------------------ */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function esc(value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }



  const fmtLong = new Intl.DateTimeFormat('ar-u-ca-gregory-nu-latn', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const fmtWeekday = new Intl.DateTimeFormat('ar-u-ca-gregory-nu-latn', { weekday: 'long' });
  let fmtHijri = null;
  try {
    fmtHijri = new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura-nu-latn', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch (e1) {
    try { fmtHijri = new Intl.DateTimeFormat('ar-u-ca-islamic-nu-latn', { day: 'numeric', month: 'long', year: 'numeric' }); } catch (e2) { fmtHijri = null; }
  }

  function fmtShort(k) { const [y, m, d] = k.split('-'); return `${d}/${m}/${y}`; }
  function fmtDateLong(k) { return fmtLong.format(fromKey(k)); }
  function weekday(k) { return fmtWeekday.format(fromKey(k)); }
  function hijri(k, force = false) {
    if (!fmtHijri || (!force && !state.settings.showHijri)) return '';
    try { return fmtHijri.format(fromKey(k)); } catch (e) { return ''; }
  }

  function normalizePhone(phone) {
    let p = String(phone || '').replace(/\D/g, '');
    if (!p) return '';
    if (p.startsWith('00')) p = p.slice(2);
    if (/^05\d{8}$/.test(p)) p = '966' + p.slice(1);
    else if (/^5\d{8}$/.test(p)) p = '966' + p;
    return p;
  }

  function waLink(phone, text) {
    const p = normalizePhone(phone);
    const base = p ? `https://wa.me/${p}` : 'https://wa.me/';
    return text ? `${base}?text=${encodeURIComponent(text)}` : base;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* fallback below */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  let toastTimer;
  function toast(message, type = 'info') {
    const el = $('#toast');
    el.textContent = message;
    el.className = `toast show ${type}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
  }

  function confirmDialog({ title = 'تأكيد', message = '', okText = 'تأكيد', danger = false }) {
    return new Promise((resolve) => {
      const dlg = $('#confirmDialog');
      $('#confirmTitle').textContent = title;
      $('#confirmMessage').textContent = message;
      const ok = $('#confirmOk');
      ok.textContent = okText;
      ok.classList.toggle('btn-danger', danger);
      ok.classList.toggle('btn-primary', !danger);
      dlg.returnValue = '';
      const onClose = () => { dlg.removeEventListener('close', onClose); resolve(dlg.returnValue === 'ok'); };
      dlg.addEventListener('close', onClose);
      dlg.showModal();
    });
  }

  function plural(n, one, two, many) {
    if (n === 1) return one;
    if (n === 2) return two;
    return `${n} ${many}`;
  }

  /* ------------------------------------------------------
     الاتصال بالخادم (API) — المصدر الأساسي للحقيقة
  ------------------------------------------------------ */
  async function apiFetch(method, path, body) {
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        credentials: 'same-origin',
      });
    } catch (e) {
      throw new Error('تعذر الاتصال بالخادم — تحقق من الإنترنت');
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* استجابة فارغة */ }
    if (!res.ok) {
      if (res.status === 401 && path !== '/api/auth/login') showLogin('');
      const err = new Error((data && data.error) || 'حدث خطأ غير متوقع');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /* ------------------------------------------------------
     تسجيل الدخول والخروج
  ------------------------------------------------------ */
  function showLogin(message) {
    $('#loginView').hidden = false;
    document.body.classList.add('logged-out');
    const errEl = $('#loginError');
    errEl.textContent = message || '';
    errEl.hidden = !message;
  }

  function hideLogin() {
    $('#loginView').hidden = true;
    document.body.classList.remove('logged-out');
    $('#loginForm').reset();
    const errEl = $('#loginError');
    errEl.textContent = '';
    errEl.hidden = true;
  }

  async function checkAuth() {
    try {
      const data = await apiFetch('GET', '/api/auth/me');
      currentUser = data.user;
      return true;
    } catch (e) {
      currentUser = null;
      return false;
    }
  }

  async function onLoginSubmit(e) {
    e.preventDefault();
    const username = $('#loginUser').value.trim();
    const password = $('#loginPass').value;
    const errEl = $('#loginError');
    if (!username || !password) {
      errEl.textContent = 'أدخل اسم الدخول وكلمة المرور';
      errEl.hidden = false;
      return;
    }
    const btn = $('#loginSubmit');
    btn.disabled = true;
    try {
      const data = await apiFetch('POST', '/api/auth/login', { username, password });
      currentUser = data.user;
      hideLogin();
      enterApp();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    } finally {
      btn.disabled = false;
    }
  }

  async function logout() {
    try { await apiFetch('POST', '/api/auth/logout'); } catch (e) { /* حتى لو فشل نخرج محلياً */ }
    currentUser = null;
    showLogin('');
  }

  /* ------------------------------------------------------
     إدارة الحسابات (لمدير النظام)
  ------------------------------------------------------ */
  function roleLabel(role) { return role === 'admin' ? 'مدير نظام' : 'مشرف'; }

  function groupNameFromCatalog(id) {
    const g = groupsCatalog.find((x) => x.id === id);
    return g ? g.name : '—';
  }

  async function openUsersDialog() {
    $('#usersDialog').showModal();
    const list = $('#usersList');
    list.innerHTML = '<li class="muted small">جارٍ التحميل…</li>';
    try {
      const data = await apiFetch('GET', '/api/users');
      usersCache = data.users;
      renderUsersList();
    } catch (err) {
      list.innerHTML = `<li class="muted small">${esc(err.message)}</li>`;
    }
  }

  function renderUsersList() {
    const list = $('#usersList');
    if (!usersCache.length) {
      list.innerHTML = '<li class="muted small">لا توجد حسابات.</li>';
      return;
    }
    list.innerHTML = usersCache.map((u) => {
      const assigned = u.groupIds.map(groupNameFromCatalog).join('، ');
      const scope = u.role === 'admin' ? 'كل الحلقات' : (assigned || 'بدون حلقات مسندة');
      const last = u.lastLoginAt ? `آخر دخول ${fmtShort(toKey(new Date(u.lastLoginAt)))}` : 'لم يسجل الدخول بعد';
      return `<li class="group-item user-item" data-id="${esc(u.id)}">
        <div class="user-info">
          <div class="user-line">
            <b>${esc(u.username)}</b>
            ${u.fullName ? `<span class="muted">${esc(u.fullName)}</span>` : ''}
            <span class="badge group">${roleLabel(u.role)}</span>
            ${u.active ? '' : '<span class="badge archived">موقوف</span>'}
          </div>
          <div class="muted small">${esc(scope)} · ${last}</div>
        </div>
        <button type="button" class="btn btn-ghost btn-xs" data-action="edit-user">تعديل</button>
      </li>`;
    }).join('');
  }

  function onUsersListClick(e) {
    const btn = e.target.closest('[data-action="edit-user"]');
    if (!btn) return;
    const li = btn.closest('.user-item');
    const u = usersCache.find((x) => x.id === li.dataset.id);
    if (u) openUserDialog(u);
  }

  function fillUserGroups(selectedIds) {
    $('#usrGroups').innerHTML = groupsCatalog.map((g) => `
      <label class="check"><input type="checkbox" value="${esc(g.id)}" ${selectedIds.includes(g.id) ? 'checked' : ''}> ${esc(g.name)}</label>
    `).join('') || '<span class="muted small">لا توجد حلقات بعد — أضف الحلقات أولاً.</span>';
  }

  function onUserRoleChange() {
    const isAdmin = $('#usrRole').value === 'admin';
    $('#usrGroupsWrap').hidden = isAdmin;
    if (isAdmin) $$('#usrGroups input[type="checkbox"]').forEach((c) => { c.checked = false; });
  }

  async function openUserDialog(user) {
    editingUserId = user ? user.id : null;
    $('#userDialogTitle').textContent = user ? `تعديل حساب ${user.username}` : 'إضافة حساب';
    $('#usrName').value = user ? user.username : '';
    $('#usrName').disabled = !!user;
    $('#usrFull').value = user ? user.fullName || '' : '';
    $('#usrRole').value = user ? user.role : 'supervisor';
    $('#usrPass').value = '';
    $('#usrPassLabel').innerHTML = user ? 'كلمة المرور جديدة (اتركها فارغة للإبقاء)' : 'كلمة المرور <em>*</em>';
    $('#usrActiveWrap').hidden = !user;
    $('#usrActive').checked = user ? !!user.active : true;
    const errEl = $('#userError');
    errEl.textContent = '';
    errEl.hidden = true;
    try {
      const data = await apiFetch('GET', '/api/groups');
      groupsCatalog = data.groups;
    } catch (err) { groupsCatalog = []; }
    fillUserGroups(user && user.role === 'supervisor' ? user.groupIds : []);
    onUserRoleChange();
    $('#userDialog').showModal();
    setTimeout(() => (user ? $('#usrFull') : $('#usrName')).focus(), 30);
  }

  async function onUserFormSubmit(e) {
    e.preventDefault();
    const errEl = $('#userError');
    errEl.hidden = true;
    const username = $('#usrName').value.trim().toLowerCase();
    const fullName = $('#usrFull').value.trim();
    const role = $('#usrRole').value;
    const password = $('#usrPass').value;
    const active = $('#usrActive').checked;
    const groupIds = role === 'supervisor'
      ? $$('#usrGroups input[type="checkbox"]:checked').map((c) => c.value)
      : [];

    const body = editingUserId
      ? { fullName, role, active, groupIds, ...(password ? { password } : {}) }
      : { username, password, fullName, role, groupIds };

    try {
      if (editingUserId) {
        await apiFetch('PATCH', `/api/users/${editingUserId}`, body);
        toast('تم حفظ التعديلات', 'success');
      } else {
        await apiFetch('POST', '/api/users', body);
        toast('تمت إضافة الحساب', 'success');
      }
      $('#userDialog').close();
      await openUsersDialog();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  }

  function updateAccountUi() {
    if (!currentUser) return;
    $('#accountInfo').textContent = `${currentUser.fullName || currentUser.username} · ${roleLabel(currentUser.role)}`;
    $('#adminUsersCard').hidden = currentUser.role !== 'admin';
  }

  /* ------------------------------------------------------
     سجل العمليات + ترحيل البيانات المحلية القديمة
  ------------------------------------------------------ */
  const AUDIT_LABELS = {
    login: 'تسجيل دخول',
    login_failed: 'محاولة دخول فاشلة',
    logout: 'تسجيل خروج',
    user_create: 'إضافة حساب',
    user_update: 'تعديل حساب',
    student_create: 'إضافة طالب',
    student_update: 'تعديل طالب',
    student_delete: 'حذف طالب',
    student_bulk_create: 'إضافة قائمة أسماء',
    student_import: 'استيراد طلاب',
    group_create: 'إضافة حلقة',
    group_update: 'تعديل حلقة',
    group_delete: 'حذف حلقة',
    attendance_set: 'تسجيل تحضير',
    attendance_clear: 'إلغاء تسجيل',
    attendance_mark_all: 'تحضير الجميع كحاضر',
    attendance_clear_day: 'مسح تحضير يوم',
    settings_update: 'تعديل الإعدادات',
    backup_export: 'تنزيل نسخة احتياطية',
    backup_restore: 'استعادة نسخة',
    wipe_all: 'مسح كل البيانات',
    sample_data_add: 'إضافة بيانات تجريبية',
    local_migration: 'ترحيل بيانات من جهاز',
  };

  async function openAuditDialog() {
    $('#auditDialog').showModal();
    const box = $('#auditBody');
    box.innerHTML = '<p class="muted small">جارٍ التحميل…</p>';
    try {
      const data = await apiFetch('GET', '/api/audit?limit=50');
      if (!data.entries.length) { box.innerHTML = '<p class="muted">لا توجد عمليات مسجلة بعد.</p>'; return; }
      box.innerHTML = `<div class="history-list">${data.entries.map((e) => {
        const d = new Date(e.at);
        return `<div class="history-item">
          <span class="h-date">${fmtShort(toKey(d))} ${pad(d.getHours())}:${pad(d.getMinutes())}</span>
          <span class="status-badge present">${AUDIT_LABELS[e.action] || esc(e.action)}</span>
          <span class="muted small">${esc(e.username || '—')}</span>
          ${e.details && Object.keys(e.details).length ? `<span class="h-note">${esc(JSON.stringify(e.details)).slice(0, 120)}</span>` : ''}
        </div>`;
      }).join('')}</div>`;
    } catch (err) {
      box.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
    }
  }

  async function checkLocalMigration() {
    if (!currentUser || currentUser.role !== 'admin') return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      if (localStorage.getItem('bulugh-migrated:v1')) return;
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) { /* غير صالح */ }
      if (!parsed || !Array.isArray(parsed.students) || !parsed.students.length) {
        localStorage.setItem('bulugh-migrated:v1', 'empty');
        return;
      }
      const ok = await confirmDialog({
        title: 'بيانات سابقة على هذا الجهاز',
        message: `وجدنا بيانات سابقة (${plural(parsed.students.length, 'طالب واحد', 'طالبين', 'طالباً')}) محفوظة في هذا المتصفح من النسخة القديمة. هل تريد نقلها إلى النظام الآن؟ (تُضاف للنظام دون حذف أي شيء، ويبقى النسخ المحلي كما هو)`,
        okText: 'نقل البيانات',
      });
      if (!ok) {
        localStorage.setItem('bulugh-migrated:v1', 'skipped');
        return;
      }
      const data = await apiFetch('POST', '/api/migration/import-local', parsed);
      localStorage.setItem('bulugh-migrated:v1', 'done');
      await loadFromServer();
      refreshCurrent();
      toast(`تم نقل البيانات: أُضيف ${data.studentsAdded} طالباً و${data.recordsAdded} سجلاً${data.recordsSkipped ? ` (تُخطّي ${data.recordsSkipped})` : ''}`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ------------------------------------------------------
     عمليات البيانات
  ------------------------------------------------------ */
  const isActive = (s) => s.active !== false;

  function groupName(id) {
    if (!id) return 'بدون حلقة';
    const g = state.groups.find((x) => x.id === id);
    return g ? g.name : 'بدون حلقة';
  }

  function groupIndex(id) {
    if (!id) return Number.MAX_SAFE_INTEGER;
    const i = state.groups.findIndex((g) => g.id === id);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  }

  function sortStudents(list) {
    return list.sort((a, b) => groupIndex(a.groupId) - groupIndex(b.groupId) || a.name.localeCompare(b.name, 'ar'));
  }

  function visibleStudents(groupFilter = 'all', search = '', includeInactive = false) {
    const q = (search || '').trim().toLowerCase();
    return sortStudents(state.students.filter((s) => {
      if (!includeInactive && !isActive(s)) return false;
      if (groupFilter === 'none' && s.groupId) return false;
      if (groupFilter !== 'all' && groupFilter !== 'none' && s.groupId !== groupFilter) return false;
      if (q && !s.name.toLowerCase().includes(q) && !(s.phone || '').includes(q)) return false;
      return true;
    }));
  }

  function findOrCreateGroup(name) {
    const n = (name || '').trim();
    if (!n) return '';
    let g = state.groups.find((x) => x.name === n);
    if (!g) {
      g = { id: uid(), name: n };
      state.groups.push(g);
    }
    return g.id;
  }

  function deleteStudentLocal(id) {
    state.students = state.students.filter((s) => s.id !== id);
    for (const k of Object.keys(state.attendance)) {
      if (state.attendance[k] && state.attendance[k][id]) {
        delete state.attendance[k][id];
        if (!Object.keys(state.attendance[k]).length) delete state.attendance[k];
      }
    }
  }

  async function refreshStudentsFromServer() {
    const data = await apiFetch('GET', '/api/students?includeInactive=1');
    state.students = data.students;
  }

  async function refreshGroupsFromServer() {
    const data = await apiFetch('GET', '/api/groups');
    state.groups = data.groups;
  }

  function getRecord(dateKey, studentId) {
    const day = state.attendance[dateKey];
    return day ? day[studentId] : undefined;
  }

  function applyLocalRecord(dateKey, studentId, record) {
    const day = state.attendance[dateKey] || (state.attendance[dateKey] = {});
    if (!record) {
      delete day[studentId];
      if (!Object.keys(day).length) delete state.attendance[dateKey];
    } else {
      day[studentId] = record;
    }
  }

  async function setStatus(dateKey, studentId, status) {
    const data = await apiFetch('PUT', `/api/attendance/${dateKey}/${studentId}`, { status });
    applyLocalRecord(dateKey, studentId, data.record);
    return data.record;
  }

  async function setNote(dateKey, studentId, note) {
    const data = await apiFetch('PUT', `/api/attendance/${dateKey}/${studentId}`, { note });
    applyLocalRecord(dateKey, studentId, data.record);
    return data.record;
  }

  /* ------------------------------------------------------
     الإحصائيات
  ------------------------------------------------------ */
  function getRange(period, custom = {}) {
    const today = todayKey();
    const d = fromKey(today);
    switch (period) {
      case 'month':
        return { from: toKey(new Date(d.getFullYear(), d.getMonth(), 1)), to: today, label: 'هذا الشهر' };
      case 'lastMonth': {
        const f = new Date(d.getFullYear(), d.getMonth() - 1, 1);
        const t = new Date(d.getFullYear(), d.getMonth(), 0);
        return { from: toKey(f), to: toKey(t), label: 'الشهر الماضي' };
      }
      case '30':
        return { from: addDays(today, -29), to: today, label: 'آخر 30 يوماً' };
      case 'custom': {
        const from = isValidKey(custom.from) ? custom.from : MIN_KEY;
        const to = isValidKey(custom.to) ? custom.to : MAX_KEY;
        return { from, to, label: 'فترة مخصصة' };
      }
      default:
        return { from: MIN_KEY, to: MAX_KEY, label: 'كل الفترة' };
    }
  }

  function rangeText(range) {
    const hasFrom = range.from !== MIN_KEY;
    const hasTo = range.to !== MAX_KEY;
    if (!hasFrom && !hasTo) return 'كل الفترة';
    if (hasFrom && hasTo) return `من ${fmtShort(range.from)} إلى ${fmtShort(range.to)}`;
    if (hasFrom) return `من ${fmtShort(range.from)}`;
    return `حتى ${fmtShort(range.to)}`;
  }

  function computeRate(ps) {
    const { lateCountsAsPresent, excludeExcused } = state.settings;
    const num = ps.present + (lateCountsAsPresent ? ps.late : 0);
    const den = ps.present + ps.late + ps.absent + (excludeExcused ? 0 : ps.excused);
    return den ? Math.round((num / den) * 100) : null;
  }

  function rateClass(rate) {
    if (rate === null || rate === undefined) return 'none';
    if (rate >= 90) return 'good';
    if (rate >= 75) return 'mid';
    return 'low';
  }

  function rateBadge(rate) {
    return `<span class="rate ${rateClass(rate)}">${rate === null ? '—' : rate + '%'}</span>`;
  }

  /* ------------------------------------------------------
     التوجيه بين الأقسام
  ------------------------------------------------------ */
  const VIEWS = ['attendance', 'students', 'reports', 'settings'];
  const RENDERERS = { attendance: renderAttendance, students: renderStudents, reports: renderReports, settings: renderSettings };

  function currentView() {
    const h = location.hash.replace(/^#\/?/, '');
    return VIEWS.includes(h) ? h : 'attendance';
  }

  function route() {
    const view = currentView();
    VIEWS.forEach((v) => { $(`#view-${v}`).hidden = v !== view; });
    $$('.tab').forEach((a) => {
      const active = a.dataset.view === view;
      a.classList.toggle('active', active);
      if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    RENDERERS[view]();
    window.scrollTo({ top: 0 });
  }

  function refreshCurrent() { RENDERERS[currentView()](); }

  /* ------------------------------------------------------
     الترويسة
  ------------------------------------------------------ */
  function updateBrand() {
    const { lessonName, orgName } = state.settings;
    const title = `تحضير ${lessonName || 'الدرس'}`;
    $('#brandTitle').textContent = title;
    $('#brandSub').textContent = orgName || '';
    document.title = orgName ? `${title} – ${orgName}` : title;
  }

  function updateHeaderDate() {
    const k = todayKey();
    $('#todayGreg').textContent = fmtDateLong(k);
    $('#todayHijri').textContent = hijri(k);
  }

  function fillGroupSelect(sel, value, mode = 'filter') {
    const opts = [];
    if (mode === 'filter') opts.push('<option value="all">كل الحلقات</option>');
    else opts.push('<option value="">بدون حلقة</option>');
    state.groups.forEach((g) => opts.push(`<option value="${esc(g.id)}">${esc(g.name)}</option>`));
    if (mode === 'filter') opts.push('<option value="none">بدون حلقة</option>');
    sel.innerHTML = opts.join('');
    sel.value = value;
    if (sel.value !== value) sel.value = mode === 'filter' ? 'all' : '';
    return sel.value;
  }

  function emptyStudentsHtml() {
    return `<li class="empty">
      <strong>لا يوجد طلاب بعد</strong>
      <span>أضف الطلاب أولاً ثم ابدأ التحضير اليومي.</span>
      <div class="actions-row">
        <button type="button" class="btn btn-primary" data-action="go-add">+ إضافة طالب</button>
        <button type="button" class="btn btn-secondary" data-action="go-bulk">إضافة قائمة أسماء</button>
        <button type="button" class="btn btn-ghost" data-action="sample">تجربة ببيانات تجريبية</button>
      </div>
    </li>`;
  }

  /* ------------------------------------------------------
     قسم التحضير
  ------------------------------------------------------ */
  function renderAttendance() {
    // تأكد أن التاريخ المختار هو يوم أحد مسموح
    if (!isAllowedAttendanceDate(ui.date)) {
      ui.date = nextValidAttendanceDate(ui.date);
    }
    const attDateEl = $('#attDate');
    attDateEl.min = ATTENDANCE_START;
    attDateEl.value = ui.date;
    $('#attDateLabel').textContent = fmtDateLong(ui.date);
    $('#attHijriLabel').textContent = hijri(ui.date);
    const prev = addDays(ui.date, -7);
    $('#prevDay').disabled = prev < ATTENDANCE_START;
    $('#prevDay').title = prev < ATTENDANCE_START ? `أول يوم تحضير هو ${fmtShort(ATTENDANCE_START)}` : 'الأحد السابق';
    $('#nextDay').title = 'الأحد التالي';
    ui.attGroup = fillGroupSelect($('#attGroup'), ui.attGroup);
    if ($('#attSearch').value !== ui.attSearch) $('#attSearch').value = ui.attSearch;
    renderAttendanceList();
  }

  function attRowHtml(s, rec) {
    const status = rec && STATUS_MAP[rec.status] ? rec.status : '';
    const note = (rec && rec.note) || '';
    const meta = [groupName(s.groupId)];
    if (s.note) meta.push(s.note);
    return `<li class="att-row ${status ? 'is-' + status : ''}" data-id="${esc(s.id)}">
      <div class="att-main">
        <div class="att-name">${esc(s.name)}</div>
        <div class="att-meta muted">${esc(meta.join(' · '))}</div>
      </div>
      <div class="att-controls">
        <div class="seg" role="group" aria-label="حالة ${esc(s.name)}">
          ${STATUSES.map((st) => `<button type="button" class="seg-btn ${st.id} ${status === st.id ? 'is-active' : ''}" data-status="${st.id}" aria-pressed="${status === st.id}">${st.label}</button>`).join('')}
        </div>
        <button type="button" class="icon-btn note-btn ${note ? 'has-note' : ''}" data-action="note" title="ملاحظة اليوم" aria-label="ملاحظة اليوم">${ICONS.note}</button>
      </div>
      <div class="att-note" ${note ? '' : 'hidden'}>
        <input type="text" class="note-input" value="${esc(note)}" placeholder="ملاحظة لهذا اليوم…" maxlength="200" aria-label="ملاحظة اليوم لـ ${esc(s.name)}">
      </div>
    </li>`;
  }

  function renderAttendanceList() {
    const list = $('#attList');
    const hasActive = state.students.some(isActive);
    if (!hasActive) {
      list.innerHTML = emptyStudentsHtml();
      updateSummary();
      return;
    }
    const students = visibleStudents(ui.attGroup, ui.attSearch);
    if (!students.length) {
      list.innerHTML = '<li class="empty"><strong>لا يوجد طلاب مطابقون</strong><span>جرّب تغيير الحلقة أو كلمة البحث.</span></li>';
      updateSummary();
      return;
    }
    const day = state.attendance[ui.date] || {};
    const showHeads = ui.attGroup === 'all' && state.groups.length > 0;
    let html = '';
    let lastGroup = null;
    for (const s of students) {
      const gid = s.groupId || '';
      if (showHeads && gid !== lastGroup) {
        html += `<li class="att-group-head">${esc(groupName(gid))}</li>`;
        lastGroup = gid;
      }
      html += attRowHtml(s, day[s.id]);
    }
    list.innerHTML = html;
    updateSummary();
  }

  function dayCounts(students, dateKey) {
    const counts = { present: 0, late: 0, absent: 0, excused: 0, unmarked: 0 };
    const day = state.attendance[dateKey] || {};
    for (const s of students) {
      const rec = day[s.id];
      if (rec && STATUS_MAP[rec.status]) counts[rec.status] += 1; else counts.unmarked += 1;
    }
    return counts;
  }

  function updateSummary() {
    const students = visibleStudents(ui.attGroup, ui.attSearch);
    const c = dayCounts(students, ui.date);
    const recorded = students.length - c.unmarked;
    const box = $('#attSummary');
    if (!students.length) { box.innerHTML = ''; return; }
    box.innerHTML = `
      <span class="chip progress">تم تسجيل <b>${recorded}</b> من <b>${students.length}</b></span>
      ${STATUSES.map((st) => `<span class="chip ${st.id}">${st.label} <b>${c[st.id]}</b></span>`).join('')}
      ${c.unmarked ? `<span class="chip">لم يُسجَّل <b>${c.unmarked}</b></span>` : ''}`;
    $('#markAllPresent').disabled = !c.unmarked;
    $('#clearDay').disabled = !recorded;
    $('#shareDay').disabled = !recorded;
    $('#copyDay').disabled = !recorded;
  }

  function updateRow(li, rec) {
    const status = rec && STATUS_MAP[rec.status] ? rec.status : '';
    STATUSES.forEach((st) => li.classList.toggle('is-' + st.id, status === st.id));
    $$('.seg-btn', li).forEach((b) => {
      const active = b.dataset.status === status;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-pressed', String(active));
    });
  }

  async function onAttListClick(e) {
    const actionBtn = e.target.closest('[data-action]');
    if (actionBtn && actionBtn.dataset.action === 'go-add') { location.hash = '#/students'; setTimeout(openStudentDialog, 50); return; }
    if (actionBtn && actionBtn.dataset.action === 'go-bulk') { location.hash = '#/students'; setTimeout(openBulkDialog, 50); return; }
    if (actionBtn && actionBtn.dataset.action === 'sample') { addSampleData(); return; }

    const li = e.target.closest('.att-row');
    if (!li) return;
    const id = li.dataset.id;

    const segBtn = e.target.closest('.seg-btn');
    if (segBtn) {
      const status = segBtn.dataset.status;
      const current = getRecord(ui.date, id);
      const next = current && current.status === status ? null : status;
      try {
        await setStatus(ui.date, id, next);
        updateRow(li, getRecord(ui.date, id));
        updateSummary();
      } catch (err) {
        toast(err.message, 'error');
      }
      return;
    }

    if (actionBtn && actionBtn.dataset.action === 'note') {
      const box = $('.att-note', li);
      box.hidden = !box.hidden;
      if (!box.hidden) $('input', box).focus();
    }
  }

  async function onAttListChange(e) {
    const input = e.target.closest('.note-input');
    if (!input) return;
    const li = input.closest('.att-row');
    try {
      await setNote(ui.date, li.dataset.id, input.value);
      $('.note-btn', li).classList.toggle('has-note', !!input.value.trim());
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function markAllPresent() {
    const students = visibleStudents(ui.attGroup, ui.attSearch);
    try {
      const data = await apiFetch('POST', `/api/attendance/${ui.date}/mark-all`, { studentIds: students.map((s) => s.id) });
      for (const s of students) {
        const rec = getRecord(ui.date, s.id);
        if (!rec || !STATUS_MAP[rec.status]) {
          applyLocalRecord(ui.date, s.id, { status: 'present', note: rec && rec.note ? rec.note : '', at: Date.now() });
        }
      }
      renderAttendanceList();
      toast(data.marked ? `تم تسجيل ${data.marked} كحاضر` : 'الجميع مسجّل مسبقاً', data.marked ? 'success' : 'info');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function clearDay() {
    const students = visibleStudents(ui.attGroup, ui.attSearch);
    const ok = await confirmDialog({
      title: 'مسح تحضير اليوم',
      message: `سيتم مسح تحضير ${fmtShort(ui.date)} للطلاب الظاهرين حالياً (${students.length}). هل أنت متأكد؟`,
      okText: 'مسح',
      danger: true,
    });
    if (!ok) return;
    try {
      await apiFetch('POST', `/api/attendance/${ui.date}/clear`, { studentIds: students.map((s) => s.id) });
      const day = state.attendance[ui.date];
      if (day) {
        for (const s of students) delete day[s.id];
        if (!Object.keys(day).length) delete state.attendance[ui.date];
      }
      renderAttendanceList();
      toast('تم مسح تحضير اليوم');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function buildDaySummary() {
    const students = visibleStudents(ui.attGroup, ui.attSearch);
    const c = dayCounts(students, ui.date);
    const day = state.attendance[ui.date] || {};
    const byStatus = (st) => students.filter((s) => day[s.id] && day[s.id].status === st).map((s) => s.name);
    const { lessonName, orgName, teacherName } = state.settings;
    const lines = [];
    lines.push(`📋 تحضير ${lessonName}`);
    const hj = hijri(ui.date);
    lines.push(`📅 ${fmtDateLong(ui.date)}${hj ? ' – ' + hj : ''}`);
    if (ui.attGroup !== 'all') lines.push(`🏷️ ${groupName(ui.attGroup === 'none' ? '' : ui.attGroup)}`);
    lines.push(`👥 عدد الطلاب: ${students.length}`);
    lines.push(`✅ حاضر: ${c.present}`);
    if (c.late) lines.push(`⏰ متأخر: ${c.late}`);
    lines.push(`❌ غائب: ${c.absent}`);
    if (c.excused) lines.push(`📝 مستأذن: ${c.excused}`);
    if (c.unmarked) lines.push(`⚪ لم يُسجَّل: ${c.unmarked}`);
    const absent = byStatus('absent');
    const late = byStatus('late');
    const excused = byStatus('excused');
    if (absent.length) lines.push('', `الغائبون: ${absent.join('، ')}`);
    if (late.length) lines.push(`المتأخرون: ${late.join('، ')}`);
    if (excused.length) lines.push(`المستأذنون: ${excused.join('، ')}`);
    lines.push('');
    if (teacherName) lines.push(`المعلم: ${teacherName}`);
    if (orgName) lines.push(orgName);
    return lines.join('\n');
  }

  function shareDay() {
    const text = buildDaySummary();
    window.open(waLink('', text), '_blank', 'noopener');
  }

  async function copyDay() {
    const ok = await copyText(buildDaySummary());
    toast(ok ? 'تم نسخ الملخص' : 'تعذر النسخ', ok ? 'success' : 'error');
  }

  /* ------------------------------------------------------
     قسم الطلاب
  ------------------------------------------------------ */
  function renderStudents() {
    ui.stGroup = fillGroupSelect($('#stGroup'), ui.stGroup);
    if ($('#stSearch').value !== ui.stSearch) $('#stSearch').value = ui.stSearch;
    $('#stShowInactive').checked = ui.stShowInactive;
    renderStudentsList();
  }

  async function renderStudentsList() {
    const list = $('#stList');
    const students = visibleStudents(ui.stGroup, ui.stSearch, ui.stShowInactive);
    const total = state.students.length;
    const activeCount = state.students.filter(isActive).length;
    $('#stCount').textContent = total
      ? `${plural(students.length, 'طالب واحد', 'طالبان', 'طالباً')} معروض · الإجمالي ${total} (${activeCount} نشط)`
      : '';

    if (!total) { list.innerHTML = emptyStudentsHtml(); return; }
    if (!students.length) {
      list.innerHTML = '<li class="empty"><strong>لا يوجد طلاب مطابقون</strong><span>جرّب تغيير الحلقة أو كلمة البحث.</span></li>';
      return;
    }
    // نسب الطلاب من قاعدة البيانات (كل الفترة)
    let perStudent = new Map();
    try {
      const data = await apiFetch('GET', '/api/reports/stats?includeInactive=1');
      perStudent = new Map(data.perStudent.map((ps) => [ps.student.id, ps]));
    } catch (e) { /* نسب غير متوفرة مؤقتاً */ }
    list.innerHTML = students.map((s) => {
      const ps = perStudent.get(s.id);
      const rate = ps ? ps.rate : null;
      const phone = s.phone ? `<a href="${waLink(s.phone)}" target="_blank" rel="noopener" dir="ltr" title="مراسلة عبر واتساب">${esc(s.phone)}</a>` : '';
      return `<li class="st-row ${isActive(s) ? '' : 'inactive'}" data-id="${esc(s.id)}">
        <div class="st-main">
          <div class="st-name">
            <button type="button" data-action="history" title="عرض سجل الطالب">${esc(s.name)}</button>
            <span class="badge group">${esc(groupName(s.groupId))}</span>
            ${isActive(s) ? '' : '<span class="badge archived">مؤرشف</span>'}
          </div>
          <div class="st-meta">
            ${phone}
            ${ps && ps.total ? `<span>${plural(ps.total, 'جلسة واحدة', 'جلستان', 'جلسة')}</span>` : '<span>لا توجد سجلات</span>'}
            ${s.note ? `<span>${esc(s.note)}</span>` : ''}
          </div>
        </div>
        ${rateBadge(rate)}
        <div class="st-actions">
          <button type="button" class="icon-btn" data-action="history" title="سجل الحضور" aria-label="سجل الحضور">${ICONS.history}</button>
          <button type="button" class="icon-btn" data-action="edit" title="تعديل" aria-label="تعديل">${ICONS.edit}</button>
          <button type="button" class="icon-btn danger" data-action="delete" title="حذف" aria-label="حذف">${ICONS.trash}</button>
        </div>
      </li>`;
    }).join('');
  }

  function onStListClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'go-add') { openStudentDialog(); return; }
    if (action === 'go-bulk') { openBulkDialog(); return; }
    if (action === 'sample') { addSampleData(); return; }
    const li = e.target.closest('.st-row');
    if (!li) return;
    const id = li.dataset.id;
    if (action === 'edit') openStudentDialog(id);
    else if (action === 'delete') removeStudent(id);
    else if (action === 'history') openHistory(id);
  }

  function openStudentDialog(id = null) {
    ui.editingId = id;
    const s = id ? state.students.find((x) => x.id === id) : null;
    $('#studentDialogTitle').textContent = s ? 'تعديل بيانات الطالب' : 'إضافة طالب';
    $('#stName').value = s ? s.name : '';
    fillGroupSelect($('#stGroupSel'), s ? s.groupId || '' : (ui.stGroup !== 'all' && ui.stGroup !== 'none' ? ui.stGroup : ''), 'pick');
    $('#stPhone').value = s ? s.phone || '' : '';
    $('#stNote').value = s ? s.note || '' : '';
    $('#stActive').checked = s ? isActive(s) : true;
    $('#stActiveWrap').hidden = !s;
    $('#studentDialog').showModal();
    setTimeout(() => $('#stName').focus(), 30);
  }

  async function submitStudentForm(e) {
    e.preventDefault();
    const name = $('#stName').value.trim();
    if (!name) { toast('اكتب اسم الطالب', 'error'); $('#stName').focus(); return; }
    const groupId = $('#stGroupSel').value;
    const phone = $('#stPhone').value.trim();
    const note = $('#stNote').value.trim();
    const active = $('#stActive').checked;
    const duplicate = state.students.find((s) => s.id !== ui.editingId && s.name === name && (s.groupId || '') === (groupId || ''));
    if (duplicate) { toast('يوجد طالب بنفس الاسم في هذه الحلقة', 'error'); return; }

    try {
      if (ui.editingId) {
        const data = await apiFetch('PATCH', `/api/students/${ui.editingId}`, { name, groupId, phone, note, active });
        const s = state.students.find((x) => x.id === ui.editingId);
        if (s) Object.assign(s, data.student);
        toast('تم حفظ التعديلات', 'success');
      } else {
        const data = await apiFetch('POST', '/api/students', { name, groupId, phone, note, active: true });
        state.students.push(data.student);
        toast('تمت إضافة الطالب', 'success');
      }
      $('#studentDialog').close();
      refreshCurrent();
    } catch (err) {
      toast(err.status === 409 ? 'يوجد طالب بنفس الاسم في هذه الحلقة' : err.message, 'error');
    }
  }

  async function removeStudent(id) {
    const s = state.students.find((x) => x.id === id);
    if (!s) return;
    const ok = await confirmDialog({
      title: 'حذف طالب',
      message: `سيتم حذف «${s.name}» وجميع سجلات تحضيره نهائياً. إن أردت الاحتفاظ بالسجل فاختر «تعديل» ثم ألغِ خيار «طالب نشط» بدلاً من الحذف.`,
      okText: 'حذف نهائي',
      danger: true,
    });
    if (!ok) return;
    try {
      await apiFetch('DELETE', `/api/students/${id}`);
      deleteStudentLocal(id);
      renderStudentsList();
      toast('تم حذف الطالب');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* --- إضافة قائمة أسماء --- */
  function openBulkDialog() {
    $('#bulkNames').value = '';
    fillGroupSelect($('#bulkGroupSel'), ui.stGroup !== 'all' && ui.stGroup !== 'none' ? ui.stGroup : '', 'pick');
    $('#bulkDialog').showModal();
    setTimeout(() => $('#bulkNames').focus(), 30);
  }

  async function submitBulkForm(e) {
    e.preventDefault();
    const groupId = $('#bulkGroupSel').value;
    const lines = $('#bulkNames').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) { toast('اكتب اسماً واحداً على الأقل', 'error'); return; }
    const items = [];
    for (const line of lines) {
      const parts = line.split(/[,،\t]/).map((p) => p.trim()).filter(Boolean);
      const name = parts[0];
      const phone = parts.slice(1).find((p) => /\d{7,}/.test(p.replace(/\D/g, ''))) || '';
      if (!name) continue;
      items.push({ name, phone });
    }
    if (!items.length) { toast('اكتب اسماً واحداً على الأقل', 'error'); return; }
    try {
      const data = await apiFetch('POST', '/api/students/bulk', { groupId, items });
      await refreshStudentsFromServer();
      $('#bulkDialog').close();
      refreshCurrent();
      toast(`تمت إضافة ${data.added}${data.skipped ? ` وتخطي ${data.skipped} مكرر` : ''}`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* --- إدارة الحلقات --- */
  function renderGroupList() {
    const list = $('#groupList');
    if (!state.groups.length) {
      list.innerHTML = '<li class="muted small">لا توجد حلقات بعد. أضف حلقة ثم اربط الطلاب بها.</li>';
      return;
    }
    list.innerHTML = state.groups.map((g) => {
      const n = state.students.filter((s) => s.groupId === g.id).length;
      return `<li class="group-item" data-id="${esc(g.id)}">
        <input type="text" value="${esc(g.name)}" maxlength="60" aria-label="اسم الحلقة">
        <span class="count">${plural(n, 'طالب', 'طالبان', 'طالب')}</span>
        <button type="button" class="icon-btn danger" data-action="delete-group" title="حذف الحلقة" aria-label="حذف الحلقة">${ICONS.trash}</button>
      </li>`;
    }).join('');
  }

  function openGroupsDialog() {
    $('#groupNewName').value = '';
    renderGroupList();
    $('#groupsDialog').showModal();
  }

  async function submitGroupAdd(e) {
    e.preventDefault();
    const name = $('#groupNewName').value.trim();
    if (!name) return;
    if (state.groups.some((g) => g.name === name)) { toast('هذه الحلقة موجودة مسبقاً', 'error'); return; }
    try {
      const data = await apiFetch('POST', '/api/groups', { name });
      state.groups.push(data.group);
      $('#groupNewName').value = '';
      renderGroupList();
      toast('تمت إضافة الحلقة', 'success');
    } catch (err) {
      toast(err.status === 409 ? 'هذه الحلقة موجودة مسبقاً' : err.message, 'error');
    }
  }

  async function onGroupListChange(e) {
    const input = e.target.closest('input');
    if (!input) return;
    const li = input.closest('.group-item');
    const g = state.groups.find((x) => x.id === li.dataset.id);
    const name = input.value.trim();
    if (!g) return;
    if (!name) { input.value = g.name; return; }
    if (state.groups.some((x) => x.id !== g.id && x.name === name)) { toast('يوجد حلقة بنفس الاسم', 'error'); input.value = g.name; return; }
    try {
      const data = await apiFetch('PATCH', `/api/groups/${g.id}`, { name });
      g.name = data.group.name;
      toast('تم تعديل اسم الحلقة', 'success');
    } catch (err) {
      input.value = g.name;
      toast(err.status === 409 ? 'يوجد حلقة بنفس الاسم' : err.message, 'error');
    }
  }

  async function onGroupListClick(e) {
    const btn = e.target.closest('[data-action="delete-group"]');
    if (!btn) return;
    const li = btn.closest('.group-item');
    const g = state.groups.find((x) => x.id === li.dataset.id);
    if (!g) return;
    const n = state.students.filter((s) => s.groupId === g.id).length;
    const ok = await confirmDialog({
      title: 'حذف حلقة',
      message: `حذف «${g.name}»؟ ${n ? `سيصبح ${plural(n, 'طالب واحد', 'طالبان', 'طالباً')} بدون حلقة.` : ''}`,
      okText: 'حذف',
      danger: true,
    });
    if (!ok) return;
    try {
      await apiFetch('DELETE', `/api/groups/${g.id}`);
      state.groups = state.groups.filter((x) => x.id !== g.id);
      state.students.forEach((s) => { if (s.groupId === g.id) s.groupId = ''; });
      renderGroupList();
      toast('تم حذف الحلقة');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* --- سجل الطالب --- */
  async function openHistory(id) {
    const s = state.students.find((x) => x.id === id);
    if (!s) return;
    let ps = { present: 0, late: 0, absent: 0, excused: 0, total: 0, rate: null, streak: 0 };
    let records = [];
    try {
      // السجل والإحصائيات من قاعدة البيانات
      const data = await apiFetch('GET', `/api/students/${id}/history`);
      ps = data.stats;
      records = data.records; // [{date, status, note}] — الأحدث أولاً
    } catch (err) {
      toast(err.message, 'error');
      return;
    }

    $('#historyTitle').textContent = `سجل ${s.name}`;
    const msg = `السلام عليكم ورحمة الله وبركاته\nأخي الفاضل ${s.name}،\nلاحظنا غيابك عن ${state.settings.lessonName}. نسأل الله أن يكون المانع خيراً، ونتطلع لحضورك في الدرس القادم.\n${state.settings.orgName || ''}`.trim();
    $('#historyBody').innerHTML = `
      <div class="history-stats">
        <span class="chip progress">${plural(ps.total, 'جلسة واحدة', 'جلستان', 'جلسة')}</span>
        ${STATUSES.map((st) => `<span class="chip ${st.id}">${st.label} <b>${ps[st.id]}</b></span>`).join('')}
        <span class="chip">نسبة الحضور <b>${ps.rate === null ? '—' : ps.rate + '%'}</b></span>
        ${ps.streak >= 2 ? `<span class="chip absent">غياب متتالٍ <b>${ps.streak}</b></span>` : ''}
      </div>
      <p class="muted small">${esc(groupName(s.groupId))}${s.phone ? ` · <a href="${waLink(s.phone, msg)}" target="_blank" rel="noopener">مراسلة عبر واتساب</a>` : ''}${s.note ? ` · ${esc(s.note)}` : ''}</p>
      ${records.length ? `<div class="history-list">${records.map((rec) => {
        const k = rec.date;
        const hj = hijri(k);
        return `<div class="history-item">
          <span class="h-date">${weekday(k)} ${fmtShort(k)}</span>
          <span class="status-badge ${rec.status}">${STATUS_MAP[rec.status].label}</span>
          ${hj ? `<span class="h-hijri">${hj}</span>` : ''}
          ${rec.note ? `<span class="h-note">📝 ${esc(rec.note)}</span>` : ''}
        </div>`;
      }).join('')}</div>` : '<p class="muted">لا توجد سجلات تحضير لهذا الطالب بعد.</p>'}`;
    $('#historyDialog').showModal();
  }

  /* --- استيراد من ملف --- */
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    const src = text.replace(/^\uFEFF/, '');
    for (let i = 0; i < src.length; i += 1) {
      const c = src[i];
      if (inQuotes) {
        if (c === '"') {
          if (src[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
        } else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ',' || c === ';' || c === '\t') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && src[i + 1] === '\n') i += 1;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
  }

  function readSpreadsheet(file) {
    return new Promise((resolve, reject) => {
      const isCsv = /\.(csv|txt)$/i.test(file.name);
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error('تعذر قراءة الملف'));
      if (isCsv || !window.XLSX) {
        if (!isCsv) { reject(new Error('مكتبة قراءة Excel غير متاحة، استخدم ملف CSV')); return; }
        reader.onload = () => resolve(parseCsv(String(reader.result)));
        reader.readAsText(file, 'utf-8');
        return;
      }
      reader.onload = () => {
        try {
          const wb = window.XLSX.read(reader.result, { type: 'array' });
          const ws = wb.Sheets[wb.SheetNames[0]];
          resolve(window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false }));
        } catch (err) { reject(err); }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  function mapImportRows(rows) {
    if (!rows.length) return [];
    const norm = (v) => String(v === null || v === undefined ? '' : v).trim();
    const header = rows[0].map((v) => norm(v).toLowerCase());
    const findIdx = (pred) => header.findIndex(pred);
    let iName = findIdx((h) => h === 'الاسم' || h === 'اسم' || h.includes('اسم الطالب') || h === 'name' || h.includes('student'));
    if (iName === -1) iName = findIdx((h) => h.includes('اسم') || h.includes('name'));
    const hasHeader = iName !== -1;
    const iGroup = hasHeader ? findIdx((h, i) => i !== iName && /حلق|مجموع|group|class|صف|فصل/.test(h)) : -1;
    const iPhone = hasHeader ? findIdx((h, i) => i !== iName && /جوال|هاتف|رقم|phone|mobile|tel/.test(h)) : -1;
    if (!hasHeader) iName = 0;
    const body = hasHeader ? rows.slice(1) : rows;
    const out = [];
    for (const r of body) {
      const name = norm(r[iName]);
      if (!name) continue;
      let group = iGroup >= 0 ? norm(r[iGroup]) : '';
      let phone = iPhone >= 0 ? norm(r[iPhone]) : '';
      if (!hasHeader) {
        for (let c = 1; c < r.length; c += 1) {
          const v = norm(r[c]);
          if (!v) continue;
          if (!phone && /^[+\d\s()-]{8,}$/.test(v)) phone = v;
          else if (!group) group = v;
        }
      }
      if (/^5\d{8}$/.test(phone)) phone = '0' + phone;
      out.push({ name, group, phone });
    }
    return out;
  }

  async function importFromFile(file) {
    if (!file) return;
    try {
      const rows = await readSpreadsheet(file);
      const items = mapImportRows(rows);
      if (!items.length) { toast('لم يتم العثور على أسماء في الملف', 'error'); return; }
      const ok = await confirmDialog({
        title: 'استيراد الطلاب',
        message: `تم العثور على ${plural(items.length, 'طالب واحد', 'طالبين', 'طالباً')} في الملف. سيتم تخطي الأسماء المكررة. متابعة؟`,
        okText: 'استيراد',
      });
      if (!ok) return;
      const data = await apiFetch('POST', '/api/students/import', { items });
      await Promise.all([refreshStudentsFromServer(), refreshGroupsFromServer()]);
      refreshCurrent();
      toast(`تم استيراد ${data.added}${data.skipped ? ` وتخطي ${data.skipped} مكرر` : ''}`, 'success');
    } catch (err) {
      console.error(err);
      toast(err && err.message ? err.message : 'تعذر قراءة الملف', 'error');
    }
  }

  /* ------------------------------------------------------
     قسم التقارير
  ------------------------------------------------------ */
  async function renderReports() {
    $('#rpPeriod').value = ui.rpPeriod;
    $('#rpCustom').hidden = ui.rpPeriod !== 'custom';
    $('#rpFrom').value = ui.rpFrom;
    $('#rpTo').value = ui.rpTo;
    ui.rpGroup = fillGroupSelect($('#rpGroup'), ui.rpGroup);

    const range = getRange(ui.rpPeriod, { from: ui.rpFrom, to: ui.rpTo });
    let stats;
    try {
      // الإحصائيات تُحسب فعلياً من قاعدة البيانات (server/services/stats)
      const data = await apiFetch('GET', `/api/reports/stats?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}&group=${encodeURIComponent(ui.rpGroup)}`);
      stats = Object.assign({}, data, {
        perStudent: new Map(data.perStudent.map((ps) => [ps.student.id, ps])),
      });
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    lastReport = { range, stats };

    const groupLabel = ui.rpGroup === 'all' ? 'كل الحلقات' : groupName(ui.rpGroup === 'none' ? '' : ui.rpGroup);

    $('#printHeader').innerHTML = `
      <img src="./icons/majma-logo.svg" alt="" class="print-logo">
      <h2>${esc(`تقرير تحضير ${state.settings.lessonName}`)}</h2>
      <p>${esc(state.settings.orgName)}${state.settings.teacherName ? ` · ${esc(state.settings.teacherName)}` : ''}</p>
      <p>${esc(rangeText(range))} · ${esc(groupLabel)} · طُبع في ${fmtShort(todayKey())}</p>`;

    $('#rpCards').innerHTML = `
      <div class="stat"><div class="label">عدد الجلسات</div><div class="value">${stats.sessions}</div><div class="sub">${esc(rangeText(range))}</div></div>
      <div class="stat"><div class="label">نسبة الحضور العامة</div><div class="value">${stats.overallRate === null ? '—' : stats.overallRate + '%'}</div><div class="sub">${state.settings.lateCountsAsPresent ? 'المتأخر يُحتسب حاضراً' : 'المتأخر لا يُحتسب حاضراً'}</div></div>
      <div class="stat"><div class="label">عدد الطلاب</div><div class="value">${stats.students.length}</div><div class="sub">${esc(groupLabel)}</div></div>
      <div class="stat"><div class="label">متوسط الحضور في الجلسة</div><div class="value">${stats.avgPerSession}</div><div class="sub">حاضر + متأخر</div></div>`;

    renderAlerts(stats);
    renderStudentsTable(stats);
    renderSessionsTable(stats);
  }

  function renderAlerts(stats) {
    const threshold = Math.max(1, Number(state.settings.absenceAlertThreshold) || 3);
    const alerts = Array.from(stats.perStudent.values()).filter((ps) => ps.streak >= threshold).sort((a, b) => b.streak - a.streak);
    const box = $('#rpAlerts');
    if (!alerts.length) {
      box.innerHTML = `<h2 class="card-title">تنبيهات الغياب المتتالي</h2><p class="muted">لا يوجد طلاب تجاوزوا حد الغياب المتتالي (${threshold} جلسات).</p>`;
      return;
    }
    box.innerHTML = `<h2 class="card-title">تنبيهات الغياب المتتالي (${alerts.length})</h2>
      <div class="alerts-list">${alerts.map((ps) => {
        const s = ps.student;
        const msg = `السلام عليكم ورحمة الله وبركاته\nأخي الفاضل ${s.name}،\nلاحظنا غيابك عن ${state.settings.lessonName} في آخر ${plural(ps.streak, 'جلسة', 'جلستين', 'جلسات')}. نسأل الله أن يكون المانع خيراً، ونتطلع لحضورك في الدرس القادم.\n${state.settings.orgName || ''}`.trim();
        return `<div class="alert-item">
          <span><b>${esc(s.name)}</b> <span class="muted">(${esc(groupName(s.groupId))})</span> – غائب ${plural(ps.streak, 'جلسة', 'جلستين', 'جلسات')} متتالية</span>
          ${s.phone ? `<a class="btn btn-whatsapp btn-xs" href="${waLink(s.phone, msg)}" target="_blank" rel="noopener">تواصل</a>` : ''}
        </div>`;
      }).join('')}</div>`;
  }

  const STUDENT_COLUMNS = [
    { key: 'name', label: 'الاسم' },
    { key: 'group', label: 'الحلقة' },
    { key: 'total', label: 'الجلسات', num: true },
    { key: 'present', label: 'حاضر', num: true, cls: 'c-present' },
    { key: 'late', label: 'متأخر', num: true, cls: 'c-late' },
    { key: 'absent', label: 'غائب', num: true, cls: 'c-absent' },
    { key: 'excused', label: 'مستأذن', num: true, cls: 'c-excused' },
    { key: 'rate', label: 'النسبة', num: true },
  ];

  function sortedStudentRows(stats) {
    const rows = Array.from(stats.perStudent.values());
    const { key, dir } = ui.rpSort;
    const val = (ps) => {
      if (key === 'name') return ps.student.name;
      if (key === 'group') return groupIndex(ps.student.groupId);
      if (key === 'rate') return ps.rate === null ? -1 : ps.rate;
      return ps[key];
    };
    rows.sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      let cmp;
      if (typeof va === 'string') cmp = va.localeCompare(vb, 'ar');
      else cmp = va - vb;
      if (cmp === 0) cmp = a.student.name.localeCompare(b.student.name, 'ar');
      return cmp * dir;
    });
    return rows;
  }

  function renderStudentsTable(stats) {
    const table = $('#rpStudentsTable');
    const rows = sortedStudentRows(stats);
    const head = `<thead><tr><th class="num">#</th>${STUDENT_COLUMNS.map((c) => {
      const sorted = ui.rpSort.key === c.key;
      return `<th data-sort="${c.key}" class="${c.num ? 'num' : ''} ${sorted ? 'sorted' : ''} ${sorted && ui.rpSort.dir === -1 ? 'desc' : ''}">${c.label}</th>`;
    }).join('')}</tr></thead>`;
    if (!rows.length) {
      table.innerHTML = `${head}<tbody><tr><td class="empty-cell" colspan="${STUDENT_COLUMNS.length + 1}">لا يوجد طلاب في هذا النطاق.</td></tr></tbody>`;
      return;
    }
    table.innerHTML = `${head}<tbody>${rows.map((ps, i) => `<tr class="clickable" data-id="${esc(ps.student.id)}">
      <td class="num">${i + 1}</td>
      <td>${esc(ps.student.name)}${isActive(ps.student) ? '' : ' <span class="badge archived">مؤرشف</span>'}</td>
      <td>${esc(groupName(ps.student.groupId))}</td>
      <td class="num">${ps.total}</td>
      <td class="num c-present">${ps.present}</td>
      <td class="num c-late">${ps.late}</td>
      <td class="num c-absent">${ps.absent}</td>
      <td class="num c-excused">${ps.excused}</td>
      <td class="num">${rateBadge(ps.rate)}</td>
    </tr>`).join('')}</tbody>`;
  }

  function renderSessionsTable(stats) {
    const table = $('#rpSessionsTable');
    const showHijri = !!(state.settings.showHijri && fmtHijri);
    const head = `<thead><tr><th>التاريخ</th><th>اليوم</th>${showHijri ? '<th>الهجري</th>' : ''}<th class="num">حاضر</th><th class="num">متأخر</th><th class="num">غائب</th><th class="num">مستأذن</th><th class="num">لم يُسجَّل</th><th class="num">النسبة</th></tr></thead>`;
    if (!stats.perDate.length) {
      table.innerHTML = `${head}<tbody><tr><td class="empty-cell" colspan="${showHijri ? 9 : 8}">لا توجد جلسات مسجلة في هذه الفترة.</td></tr></tbody>`;
      return;
    }
    const rows = stats.perDate.slice().reverse();
    table.innerHTML = `${head}<tbody>${rows.map((r) => {
      const rate = computeRate(r);
      return `<tr class="clickable" data-date="${r.date}" title="فتح تحضير هذا اليوم">
        <td>${fmtShort(r.date)}</td>
        <td>${weekday(r.date)}</td>
        ${showHijri ? `<td>${hijri(r.date)}</td>` : ''}
        <td class="num c-present">${r.present}</td>
        <td class="num c-late">${r.late}</td>
        <td class="num c-absent">${r.absent}</td>
        <td class="num c-excused">${r.excused}</td>
        <td class="num">${r.unmarked}</td>
        <td class="num">${rateBadge(rate)}</td>
      </tr>`;
    }).join('')}</tbody>`;
  }

  function onReportsTableClick(e) {
    const th = e.target.closest('th[data-sort]');
    if (th) {
      const key = th.dataset.sort;
      if (ui.rpSort.key === key) ui.rpSort.dir *= -1;
      else ui.rpSort = { key, dir: key === 'name' || key === 'group' ? 1 : -1 };
      if (lastReport) renderStudentsTable(lastReport.stats);
      return;
    }
    const trStudent = e.target.closest('tr[data-id]');
    if (trStudent) { openHistory(trStudent.dataset.id); return; }
    const trDate = e.target.closest('tr[data-date]');
    if (trDate) {
      ui.date = trDate.dataset.date;
      location.hash = '#/attendance';
    }
  }

  /* --- التصدير --- */
  function reportSheets() {
    const { range, stats } = lastReport;
    const rows = sortedStudentRows(stats);
    const summary = [
      ['#', 'الاسم', 'الحلقة', 'الجوال', 'عدد الجلسات', 'حاضر', 'متأخر', 'غائب', 'مستأذن', 'نسبة الحضور %'],
      ...rows.map((ps, i) => [i + 1, ps.student.name, groupName(ps.student.groupId), ps.student.phone || '', ps.total, ps.present, ps.late, ps.absent, ps.excused, ps.rate === null ? '' : ps.rate]),
    ];
    const dates = stats.perDate.map((r) => r.date);
    const daily = [
      ['الاسم', 'الحلقة', ...dates.map(fmtShort)],
      ...rows.map((ps) => [ps.student.name, groupName(ps.student.groupId), ...dates.map((k) => {
        const rec = state.attendance[k] && state.attendance[k][ps.student.id];
        return rec && STATUS_MAP[rec.status] ? STATUS_MAP[rec.status].short : '';
      })]),
    ];
    const sessions = [
      ['التاريخ', 'اليوم', 'الهجري', 'حاضر', 'متأخر', 'غائب', 'مستأذن', 'لم يُسجَّل', 'نسبة الحضور %'],
      ...stats.perDate.map((r) => { const rate = computeRate(r); return [fmtShort(r.date), weekday(r.date), hijri(r.date, true), r.present, r.late, r.absent, r.excused, r.unmarked, rate === null ? '' : rate]; }),
    ];
    const info = [
      ['التقرير', `تقرير تحضير ${state.settings.lessonName}`],
      ['الجهة', state.settings.orgName],
      ['المعلم', state.settings.teacherName || ''],
      ['الفترة', rangeText(range)],
      ['الحلقة', ui.rpGroup === 'all' ? 'كل الحلقات' : groupName(ui.rpGroup === 'none' ? '' : ui.rpGroup)],
      ['عدد الجلسات', stats.sessions],
      ['نسبة الحضور العامة', stats.overallRate === null ? '' : `${stats.overallRate}%`],
      ['تاريخ التصدير', fmtShort(todayKey())],
      [],
      ['الرموز في السجل اليومي', 'ح = حاضر، م = متأخر، غ = غائب، ع = مستأذن'],
    ];
    return { summary, daily, sessions, info };
  }

  function exportFileBase() {
    const { range } = lastReport;
    const period = range.from !== MIN_KEY ? `${range.from}_${range.to !== MAX_KEY ? range.to : todayKey()}` : 'all';
    return `تحضير-${(state.settings.lessonName || 'الدرس').replace(/\s+/g, '-')}-${period}`;
  }

  function exportXlsx() {
    if (!lastReport) renderReports();
    if (!window.XLSX) { toast('مكتبة Excel غير متاحة، سيتم التصدير بصيغة CSV'); exportCsv(); return; }
    const { summary, daily, sessions, info } = reportSheets();
    const XLSX = window.XLSX;
    const wb = XLSX.utils.book_new();
    wb.Workbook = { Views: [{ RTL: true }] };
    const add = (aoa, name, widths) => {
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      if (widths) ws['!cols'] = widths.map((w) => ({ wch: w }));
      XLSX.utils.book_append_sheet(wb, ws, name);
    };
    add(summary, 'ملخص الطلاب', [5, 28, 18, 14, 12, 8, 8, 8, 8, 14]);
    add(daily, 'السجل اليومي', [28, 18, ...new Array(Math.max(0, daily[0].length - 2)).fill(11)]);
    add(sessions, 'الجلسات', [12, 12, 22, 8, 8, 8, 8, 10, 14]);
    add(info, 'معلومات', [24, 50]);
    XLSX.writeFile(wb, `${exportFileBase()}.xlsx`);
    toast('تم تصدير ملف Excel', 'success');
  }

  function toCsv(aoa) {
    const cell = (v) => {
      const s = String(v === null || v === undefined ? '' : v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return '\uFEFF' + aoa.map((r) => r.map(cell).join(',')).join('\r\n');
  }

  function exportCsv() {
    if (!lastReport) renderReports();
    const { summary, daily } = reportSheets();
    const base = exportFileBase();
    downloadBlob(new Blob([toCsv(summary)], { type: 'text/csv;charset=utf-8' }), `${base}-ملخص.csv`);
    setTimeout(() => downloadBlob(new Blob([toCsv(daily)], { type: 'text/csv;charset=utf-8' }), `${base}-السجل-اليومي.csv`), 400);
    toast('تم تصدير ملفي CSV (الملخص والسجل اليومي)', 'success');
  }

  /* ------------------------------------------------------
     قسم الإعدادات
  ------------------------------------------------------ */
  function renderSettings() {
    const s = state.settings;
    $('#setLesson').value = s.lessonName;
    $('#setOrg').value = s.orgName;
    $('#setTeacher').value = s.teacherName || '';
    $('#setHijri').checked = !!s.showHijri;
    $('#setLate').checked = !!s.lateCountsAsPresent;
    $('#setExcused').checked = !!s.excludeExcused;
    $('#setThreshold').value = s.absenceAlertThreshold;
    $('#appVersion').textContent = APP_VERSION;
    // الإعدادات المشتركة والنسخ الاحتياطي والمسح: لمدير النظام فقط
    const isAdmin = !!(currentUser && currentUser.role === 'admin');
    ['#setLesson', '#setOrg', '#setTeacher', '#setHijri', '#setLate', '#setExcused', '#setThreshold'].forEach((sel) => {
      $(sel).disabled = !isAdmin;
    });
    $('#settingsAdminNote').hidden = isAdmin;
    $('#backupBtn').hidden = !isAdmin;
    $('#restoreBtn').hidden = !isAdmin;
    $('#wipeBtn').hidden = !isAdmin;
    $('#sampleBtn').hidden = !isAdmin;
    updateAccountUi();
    updateStorageInfo();
  }

  function updateStorageInfo() {
    $('#storageSize').textContent = 'قاعدة البيانات المركزية';
    const last = state.meta.lastBackupAt;
    const days = last ? Math.floor((Date.now() - last) / 86400000) : null;
    let info;
    if (!last) info = 'لم يتم أخذ نسخة احتياطية بعد.';
    else if (days === 0) info = 'آخر نسخة احتياطية: اليوم.';
    else info = `آخر نسخة احتياطية: قبل ${plural(days, 'يوم واحد', 'يومين', 'يوماً')}${days >= 14 ? ' – يُنصح بأخذ نسخة جديدة.' : ''}`;
    $('#backupInfo').textContent = `${info} · عدد الطلاب: ${state.students.length} · أيام التحضير المسجلة: ${Object.keys(state.attendance).length}`;
  }

  async function saveSettingsFromForm() {
    const s = state.settings;
    const payload = {
      lessonName: $('#setLesson').value.trim() || 'الدرس',
      orgName: $('#setOrg').value.trim(),
      teacherName: $('#setTeacher').value.trim(),
      showHijri: $('#setHijri').checked,
      lateCountsAsPresent: $('#setLate').checked,
      excludeExcused: $('#setExcused').checked,
      absenceAlertThreshold: (function () {
        const th = parseInt($('#setThreshold').value, 10);
        return Number.isFinite(th) && th > 0 ? Math.min(th, 30) : 3;
      })(),
    };
    try {
      const data = await apiFetch('PUT', '/api/settings', payload);
      state.settings = Object.assign(s, data.settings);
      updateBrand();
      updateHeaderDate();
      toast('تم حفظ الإعدادات', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function downloadBackup() {
    try {
      const data = await apiFetch('GET', '/api/backup/export');
      downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `bulugh-backup-${todayKey()}.json`);
      state.meta.lastBackupAt = Date.now();
      updateStorageInfo();
      toast('تم تنزيل النسخة الاحتياطية', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function restoreBackup(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        if (!parsed || !Array.isArray(parsed.students)) throw new Error('bad');
        const ok = await confirmDialog({
          title: 'استعادة نسخة احتياطية',
          message: `سيتم استبدال البيانات الحالية (${state.students.length} طالب) ببيانات النسخة (${parsed.students.length} طالب، ${Object.keys(parsed.attendance || {}).length} يوم تحضير). متابعة؟`,
          okText: 'استعادة',
          danger: true,
        });
        if (!ok) return;
        const data = await apiFetch('POST', '/api/backup/restore', parsed);
        await loadFromServer();
        updateBrand();
        updateHeaderDate();
        // تصحيح تاريخ الواجهة إن كان غير مسموح
        ui.date = defaultAttendanceDate();
        refreshCurrent();
        toast(`تمت استعادة النسخة الاحتياطية${data.recordsSkipped ? ` (تُخطّي ${data.recordsSkipped} سجلاً غير مسموح)` : ''}`, 'success');
      } catch (err) {
        toast(err && err.message ? err.message : 'الملف غير صالح أو ليس نسخة احتياطية من هذا التطبيق', 'error');
      }
    };
    reader.readAsText(file, 'utf-8');
  }

  async function wipeAll() {
    const ok = await confirmDialog({
      title: 'مسح كل البيانات',
      message: 'سيتم حذف جميع الطلاب والحلقات وسجلات التحضير من النظام نهائياً ولا يمكن التراجع. هل أخذت نسخة احتياطية؟',
      okText: 'نعم، امسح كل شيء',
      danger: true,
    });
    if (!ok) return;
    try {
      await apiFetch('POST', '/api/backup/wipe', {});
      await loadFromServer();
      updateBrand();
      updateHeaderDate();
      ui.date = defaultAttendanceDate();
      refreshCurrent();
      toast('تم مسح جميع البيانات');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function addSampleData() {
    try {
      const data = await apiFetch('POST', '/api/sample-data', {});
      await loadFromServer();
      refreshCurrent();
      toast(data.added ? `تمت إضافة ${data.added} طالباً تجريبياً مع سجلات سابقة (أيام الأحد)` : 'البيانات التجريبية موجودة مسبقاً', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ------------------------------------------------------
     PWA
  ------------------------------------------------------ */
  function setupPwa() {
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('SW registration failed', err));
    }
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      $('#installBtn').hidden = false;
    });
    window.addEventListener('appinstalled', () => {
      deferredInstallPrompt = null;
      $('#installBtn').hidden = true;
      toast('تم تثبيت التطبيق', 'success');
    });
    $('#installBtn').addEventListener('click', async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice.catch(() => {});
      deferredInstallPrompt = null;
      $('#installBtn').hidden = true;
    });
  }

  /* ------------------------------------------------------
     ربط الأحداث
  ------------------------------------------------------ */
  function bindEvents() {
    // التحضير — التنقل بالأحد فقط ابتداءً من 27/09/2026
    $('#attDate').addEventListener('change', (e) => {
      const v = e.target.value;
      if (!isValidKey(v)) return;
      if (!isAllowedAttendanceDate(v)) {
        if (v < ATTENDANCE_START) toast(`التحضير يبدأ من الأحد ${fmtShort(ATTENDANCE_START)}`, 'error');
        else toast('التحضير متاح فقط أيام الأحد', 'error');
        ui.date = nextValidAttendanceDate(v);
        renderAttendance();
        return;
      }
      ui.date = v;
      renderAttendance();
    });
    $('#prevDay').addEventListener('click', () => {
      const prev = addDays(ui.date, -7);
      if (prev < ATTENDANCE_START) { toast(`وصلت إلى أول يوم تحضير (${fmtShort(ATTENDANCE_START)})`, 'info'); return; }
      ui.date = prev;
      renderAttendance();
    });
    $('#nextDay').addEventListener('click', () => { ui.date = addDays(ui.date, 7); renderAttendance(); });
    $('#todayBtn').addEventListener('click', () => { ui.date = defaultAttendanceDate(); renderAttendance(); });
    $('#attGroup').addEventListener('change', (e) => { ui.attGroup = e.target.value; renderAttendanceList(); });
    $('#attSearch').addEventListener('input', debounce((e) => { ui.attSearch = e.target.value; renderAttendanceList(); }, 120));
    $('#markAllPresent').addEventListener('click', markAllPresent);
    $('#clearDay').addEventListener('click', clearDay);
    $('#shareDay').addEventListener('click', shareDay);
    $('#copyDay').addEventListener('click', copyDay);
    $('#attList').addEventListener('click', onAttListClick);
    $('#attList').addEventListener('change', onAttListChange);

    // الطلاب
    $('#stSearch').addEventListener('input', debounce((e) => { ui.stSearch = e.target.value; renderStudentsList(); }, 120));
    $('#stGroup').addEventListener('change', (e) => { ui.stGroup = e.target.value; renderStudentsList(); });
    $('#stShowInactive').addEventListener('change', (e) => { ui.stShowInactive = e.target.checked; renderStudentsList(); });
    $('#addStudentBtn').addEventListener('click', () => openStudentDialog());
    $('#bulkAddBtn').addEventListener('click', openBulkDialog);
    $('#manageGroupsBtn').addEventListener('click', openGroupsDialog);
    $('#importBtn').addEventListener('click', () => $('#importFile').click());
    $('#importFile').addEventListener('change', (e) => { importFromFile(e.target.files[0]); e.target.value = ''; });
    $('#stList').addEventListener('click', onStListClick);
    $('#studentForm').addEventListener('submit', submitStudentForm);
    $('#bulkForm').addEventListener('submit', submitBulkForm);
    $('#groupAddForm').addEventListener('submit', submitGroupAdd);
    $('#groupList').addEventListener('change', onGroupListChange);
    $('#groupList').addEventListener('click', onGroupListClick);
    $('#groupsDialog').addEventListener('close', () => refreshCurrent());

    // التقارير
    $('#rpPeriod').addEventListener('change', (e) => { ui.rpPeriod = e.target.value; renderReports(); });
    $('#rpFrom').addEventListener('change', (e) => { ui.rpFrom = e.target.value; renderReports(); });
    $('#rpTo').addEventListener('change', (e) => { ui.rpTo = e.target.value; renderReports(); });
    $('#rpGroup').addEventListener('change', (e) => { ui.rpGroup = e.target.value; renderReports(); });
    $('#exportXlsx').addEventListener('click', exportXlsx);
    $('#exportCsv').addEventListener('click', exportCsv);
    $('#printBtn').addEventListener('click', () => window.print());
    $('#rpStudentsTable').addEventListener('click', onReportsTableClick);
    $('#rpSessionsTable').addEventListener('click', onReportsTableClick);

    // الإعدادات
    ['#setLesson', '#setOrg', '#setTeacher', '#setHijri', '#setLate', '#setExcused', '#setThreshold'].forEach((sel) => {
      $(sel).addEventListener('change', saveSettingsFromForm);
    });
    $('#backupBtn').addEventListener('click', downloadBackup);
    $('#restoreBtn').addEventListener('click', () => $('#restoreFile').click());
    $('#restoreFile').addEventListener('change', (e) => { restoreBackup(e.target.files[0]); e.target.value = ''; });
    $('#wipeBtn').addEventListener('click', wipeAll);
    $('#sampleBtn').addEventListener('click', addSampleData);

    // النوافذ: زر الإغلاق والنقر على الخلفية
    $$('dialog.dialog').forEach((dlg) => {
      $$('[data-close]', dlg).forEach((b) => b.addEventListener('click', () => dlg.close()));
      dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    });

    // مزامنة مع الخادم عند العودة للتطبيق (تعديلات مشرف آخر أو جهاز آخر)
    const resyncFromServer = debounce(async () => {
      if (!currentUser) return;
      try {
        await loadFromServer();
        updateBrand();
        refreshCurrent();
      } catch (e) { /* انقطاع مؤقت — يبقى العرض السابق */ }
    }, 400);
    window.addEventListener('focus', resyncFromServer);

    // تحديث التاريخ عند العودة للتطبيق في يوم جديد + مزامنة البيانات
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { updateHeaderDate(); resyncFromServer(); }
    });

    window.addEventListener('hashchange', route);

    // تسجيل الدخول والحساب
    $('#loginForm').addEventListener('submit', onLoginSubmit);
    $('#logoutBtn').addEventListener('click', () => { logout(); });
    $('#manageUsersBtn').addEventListener('click', openUsersDialog);
    $('#auditLogBtn').addEventListener('click', openAuditDialog);
    $('#addUserBtn').addEventListener('click', () => openUserDialog(null));
    $('#usersList').addEventListener('click', onUsersListClick);
    $('#userForm').addEventListener('submit', onUserFormSubmit);
    $('#usrRole').addEventListener('change', onUserRoleChange);
  }

  /* ------------------------------------------------------
     بدء التشغيل
  ------------------------------------------------------ */
  function enterApp() {
    return loadFromServer()
      .catch((err) => { toast(err.message, 'error'); })
      .then(() => {
        updateBrand();
        updateHeaderDate();
        route();
      });
  }

  async function init() {
    bindEvents();
    setupPwa();
    updateHeaderDate();
    const ok = await checkAuth();
    if (!ok) {
      showLogin('');
      return;
    }
    enterApp();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
