create table if not exists public.bonus_process_locks (
  id bigserial primary key,
  bonus_date date not null,
  lock_status text not null default 'PENDING',
  claim_owner text not null,
  claim_batch_id text not null,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  pending_expires_at timestamptz not null default (now() + interval '5 minutes'),
  expires_at timestamptz not null default (now() + interval '2 days'),
  done_at timestamptz
);

alter table public.bonus_process_locks
drop constraint if exists bonus_process_locks_bonus_date_key;

create unique index if not exists bonus_process_locks_one_active_pending_idx
on public.bonus_process_locks (bonus_date)
where lock_status = 'PENDING';

create index if not exists bonus_process_locks_status_idx
on public.bonus_process_locks (bonus_date, lock_status);

create index if not exists bonus_process_locks_owner_idx
on public.bonus_process_locks (claim_owner);

create index if not exists bonus_process_locks_expire_idx
on public.bonus_process_locks (expires_at);

alter table public.bonus_done_daily
add column if not exists bonus_status text not null default 'PENDING';

alter table public.bonus_done_daily
add column if not exists claim_owner text;

alter table public.bonus_done_daily
add column if not exists claim_batch_id text;

alter table public.bonus_process_locks
add column if not exists operator_name text;

alter table public.bonus_done_daily
add column if not exists operator_name text;

alter table public.bonus_process_locks
add column if not exists done_by_name text;

alter table public.bonus_done_daily
add column if not exists done_by_name text;

alter table public.bonus_process_locks
add column if not exists finalized_by_admin_id text;

alter table public.bonus_process_locks
add column if not exists finalized_by_admin_name text;

alter table public.bonus_process_locks
add column if not exists finalized_at timestamptz;

alter table public.bonus_process_locks
add column if not exists finalized_note text;

alter table public.bonus_done_daily
add column if not exists finalized_by_admin_id text;

alter table public.bonus_done_daily
add column if not exists finalized_by_admin_name text;

alter table public.bonus_done_daily
add column if not exists finalized_at timestamptz;

alter table public.bonus_done_daily
add column if not exists finalized_note text;

alter table public.bonus_done_daily
add column if not exists claimed_at timestamptz not null default now();

alter table public.bonus_done_daily
add column if not exists done_at timestamptz;

alter table public.bonus_done_daily
add column if not exists pending_expires_at timestamptz;

alter table public.bonus_done_daily
add column if not exists expires_at timestamptz not null default (now() + interval '2 days');

create index if not exists bonus_done_daily_status_idx
on public.bonus_done_daily (bonus_date, bonus_status);

create index if not exists bonus_done_daily_owner_idx
on public.bonus_done_daily (bonus_date, claim_owner);

create index if not exists bonus_done_daily_batch_idx
on public.bonus_done_daily (bonus_date, claim_batch_id);

create table if not exists public.operators (
  id bigserial primary key,
  username text not null unique,
  display_name text not null,
  password_hash text not null,
  role text not null default 'operator',
  is_protected boolean not null default false,
  is_active boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint operators_role_check
  check (role in ('operator', 'audit', 'admin', 'superadmin'))
);

alter table public.operators
drop constraint if exists operators_role_check;

alter table public.operators
add constraint operators_role_check
check (role in ('operator', 'audit', 'admin', 'superadmin'));

alter table public.operators
add column if not exists is_protected boolean not null default false;

create index if not exists operators_username_idx
on public.operators (username);

create index if not exists operators_role_idx
on public.operators (role);

alter table public.operators enable row level security;

create extension if not exists pgcrypto;

create table if not exists public.operator_active_sessions (
  id uuid primary key default gen_random_uuid(),
  operator_id text,
  username text,
  display_name text,
  role text,
  session_token_id text,
  is_active boolean default true,
  last_seen_at timestamptz default now(),
  created_at timestamptz default now(),
  expired_at timestamptz,
  expired_reason text
);

alter table public.operator_active_sessions
add column if not exists expired_reason text;

create index if not exists idx_operator_active_sessions_operator_id
on public.operator_active_sessions(operator_id);

create index if not exists idx_operator_active_sessions_active
on public.operator_active_sessions(is_active, last_seen_at);

create index if not exists idx_operator_active_sessions_token
on public.operator_active_sessions(session_token_id);

alter table public.operator_active_sessions enable row level security;

create table if not exists public.operator_admin_actions (
  id uuid primary key default gen_random_uuid(),
  action_type text not null,
  actor_operator_id text,
  actor_username text,
  actor_role text,
  target_operator_id text,
  target_username text,
  target_role text,
  note text,
  affected_rows integer default 0,
  created_at timestamptz default now()
);

create index if not exists operator_admin_actions_actor_idx
on public.operator_admin_actions(actor_operator_id);

create index if not exists operator_admin_actions_target_idx
on public.operator_admin_actions(target_operator_id);

alter table public.operator_admin_actions enable row level security;

create table if not exists public.bonus_admin_actions (
  id uuid primary key default gen_random_uuid(),
  action_type text not null,
  bonus_date date,
  claim_owner text,
  operator_name text,
  admin_id text,
  admin_name text,
  affected_rows int not null default 0,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists bonus_admin_actions_bonus_date_idx
on public.bonus_admin_actions (bonus_date);

create index if not exists bonus_admin_actions_admin_idx
on public.bonus_admin_actions (admin_id);

alter table public.bonus_admin_actions enable row level security;

drop function if exists public.claim_bonus_done_daily(jsonb);
