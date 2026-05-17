drop table if exists public.bonus_done_daily;

create table public.bonus_done_daily (
  id bigserial primary key,
  bonus_date date not null,
  login_id text not null,
  login_key text not null,
  bonus_type text not null default 'BONUS_HARIAN',
  bonus_amount int,
  remark text,
  source text not null default 'unknown',
  operator_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '2 days'),
  constraint bonus_done_daily_unique unique (
    bonus_date,
    login_key,
    bonus_type
  )
);

create index if not exists bonus_done_daily_date_idx
on public.bonus_done_daily (bonus_date);

create index if not exists bonus_done_daily_expires_idx
on public.bonus_done_daily (expires_at);

create index if not exists bonus_done_daily_lookup_idx
on public.bonus_done_daily (bonus_date, login_key, bonus_type);

alter table public.bonus_done_daily enable row level security;
