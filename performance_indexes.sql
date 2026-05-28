-- Performance indexes for Admin Operator and Monitoring Bonus Operator.
-- Run once in the database pusat SQL editor.

create index if not exists idx_bonus_process_locks_date_status
on public.bonus_process_locks (bonus_date, lock_status, updated_at desc);

create index if not exists idx_bonus_process_locks_claim_owner
on public.bonus_process_locks (claim_owner, updated_at desc);

create index if not exists idx_bonus_done_daily_lock_id
on public.bonus_done_daily (lock_id);

create index if not exists idx_bonus_done_daily_date_status
on public.bonus_done_daily (bonus_date, bonus_status);

create index if not exists idx_operator_active_sessions_active_seen
on public.operator_active_sessions (is_active, last_seen_at);

create index if not exists idx_operator_active_sessions_operator_token
on public.operator_active_sessions (operator_id, session_token_id);

create index if not exists idx_operators_active_role
on public.operators (is_active, role);
