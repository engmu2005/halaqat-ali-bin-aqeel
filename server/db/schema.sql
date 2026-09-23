-- =========================================================
-- مخطط قاعدة البيانات — نظام تحضير حلقات علي بن عقيل (بلوغ المرام)
-- PostgreSQL 13+ — قابل لإعادة التشغيل (IF NOT EXISTS)
-- =========================================================

-- تتبّع إصدارات المخطط
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- جلسات تسجيل الدخول (تستخدمها connect-pg-simple)
CREATE TABLE IF NOT EXISTS session (
  sid VARCHAR NOT NULL COLLATE "default",
  sess JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL,
  CONSTRAINT session_pkey PRIMARY KEY (sid)
);
CREATE INDEX IF NOT EXISTS session_expire_idx ON session (expire);

-- المشرفون ومديرو النظام
-- كلمة المرور تُخزَّن مشفّرة (bcrypt) — لا نص صريح أبداً
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('admin', 'supervisor')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- الحلقات
CREATE TABLE IF NOT EXISTS groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- الحلقات المسندة لكل مشرف — صلاحيات المشرف مقيدة بحلقاته فقط
CREATE TABLE IF NOT EXISTS supervisor_groups (
  supervisor_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  PRIMARY KEY (supervisor_id, group_id)
);

-- الطلاب
CREATE TABLE IF NOT EXISTS students (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  group_id UUID REFERENCES groups(id) ON DELETE SET NULL,
  phone TEXT NOT NULL DEFAULT '' CHECK (char_length(phone) <= 20),
  note TEXT NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS students_group_idx ON students (group_id);
CREATE INDEX IF NOT EXISTS students_name_idx ON students (name);

-- منع تكرار الاسم داخل نفس الحلقة (الطالب بدون حلقة يعامل كـ «بدون حلقة» واحدة)
CREATE UNIQUE INDEX IF NOT EXISTS students_name_group_uniq
  ON students (name, COALESCE(group_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- حالات الحضور الأربع
DO $$ BEGIN
  CREATE TYPE attendance_status AS ENUM ('present', 'late', 'absent', 'excused');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- سجل التحضير: سطر لكل (يوم جلسة، طالب)
-- status NULL = ملاحظة فقط بدون حالة (كما في التطبيق الحالي)
CREATE TABLE IF NOT EXISTS attendance (
  session_date DATE NOT NULL,
  student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  status attendance_status,
  note TEXT NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (session_date, student_id),
  -- السجل يجب أن يحمل حالة أو ملاحظة (الفراغ يُحذف)
  CHECK (status IS NOT NULL OR note <> ''),
  -- قاعدة العمل: التحضير أيام الأحد فقط
  CHECK (EXTRACT(DOW FROM session_date) = 0),
  -- قاعدة العمل: التحضير ابتداءً من الأحد 2026-09-27
  CHECK (session_date >= DATE '2026-09-27')
);
CREATE INDEX IF NOT EXISTS attendance_student_idx ON attendance (student_id);
CREATE INDEX IF NOT EXISTS attendance_date_idx ON attendance (session_date);

-- إعدادات التطبيق المشتركة (نفس مفاتيح الإعدادات الحالية)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO settings (key, value) VALUES (
  'app',
  '{"lessonName":"درس بلوغ المرام","orgName":"حلقات علي بن عقيل – جمعية الدعوة","teacherName":"","showHijri":true,"lateCountsAsPresent":true,"excludeExcused":true,"absenceAlertThreshold":3}'::jsonb
) ON CONFLICT (key) DO NOTHING;

-- سجل العمليات المهمة (Audit Log)
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  username TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  entity TEXT NOT NULL DEFAULT '',
  entity_id TEXT NOT NULL DEFAULT '',
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_user_idx ON audit_log (user_id);

INSERT INTO schema_migrations (version) VALUES ('1') ON CONFLICT (version) DO NOTHING;
