create table if not exists public.feature_access_locks (
  id uuid primary key default gen_random_uuid(),
  feature_key text unique not null,
  feature_name text not null,
  is_locked boolean not null default false,
  locked_reason text,
  updated_by_operator_id text,
  updated_by_username text,
  updated_by_role text,
  updated_at timestamptz default now(),
  created_at timestamptz default now()
);

insert into public.feature_access_locks (feature_key, feature_name, is_locked)
values
  ('parser', 'Parser QRIS', false),
  ('bonus', 'Bonus Harian', false),
  ('claim_mahjong', 'Klaim Mahjong', false),
  ('audit', 'Audit Bonus', false),
  ('admin_operators', 'Admin Operator', false),
  ('monitoring_bonus', 'Monitoring Bonus Operator', false),
  ('module_guide', 'Modul Panduan', false)
on conflict (feature_key) do nothing;
