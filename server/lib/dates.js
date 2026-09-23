'use strict';

/**
 * قواعد تواريخ الجلسات — نفس منطق الواجهة تماماً:
 * التحضير أيام الأحد فقط ابتداءً من الأحد 2026-09-27.
 */
const ATTENDANCE_START = '2026-09-27';

function pad(n) { return String(n).padStart(2, '0'); }
function toKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function fromKey(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(k, n) { const d = fromKey(k); d.setDate(d.getDate() + n); return toKey(d); }
function isValidKey(k) { return /^\d{4}-\d{2}-\d{2}$/.test(k || ''); }
function isSundayKey(k) { return isValidKey(k) && fromKey(k).getDay() === 0; }
function isAllowedAttendanceDate(k) {
  return isValidKey(k) && k >= ATTENDANCE_START && isSundayKey(k);
}

module.exports = { ATTENDANCE_START, pad, toKey, fromKey, addDays, isValidKey, isSundayKey, isAllowedAttendanceDate };
