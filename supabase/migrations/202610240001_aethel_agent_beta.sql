alter table public.aethel_api_keys
  add column if not exists daily_limit integer not null default 100
  check (daily_limit > 0);

create table if not exists public.agent_sessions (
  key_id uuid not null references public.aethel_api_keys(id) on delete cascade,
  session_id text not null check (char_length(session_id) between 1 and 100),
  history jsonb not null default '[]'::jsonb check (jsonb_typeof(history) = 'array'),
  steps jsonb not null default '[]'::jsonb check (jsonb_typeof(steps) = 'array'),
  status text not null default 'running' check (status in ('running', 'completed', 'max_iterations_reached', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (key_id, session_id)
);

create index if not exists agent_sessions_updated_idx on public.agent_sessions (key_id, updated_at desc);
alter table public.agent_sessions enable row level security;
revoke all on public.agent_sessions from anon, authenticated;
grant all on public.agent_sessions to service_role;

create or replace function public.aethel_start_request(p_key_id uuid, p_model text, p_daily_limit integer)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_usage_id uuid;
  v_count integer;
  v_daily_limit integer;
begin
  select daily_limit into v_daily_limit
  from public.aethel_api_keys
  where id = p_key_id and disabled_at is null
  for update;
  if not found then raise exception 'invalid_key' using errcode = 'P0002'; end if;
  v_daily_limit := coalesce(v_daily_limit, p_daily_limit);

  select count(*)::integer into v_count
  from public.aethel_usage
  where key_id = p_key_id
    and created_at >= (date_trunc('day', timezone('UTC', now())) at time zone 'UTC');
  if v_count >= v_daily_limit then raise exception 'daily_limit_reached' using errcode = 'P0001'; end if;

  insert into public.aethel_usage (key_id, model, status)
  values (p_key_id, p_model, 'pending')
  returning id into v_usage_id;
  return v_usage_id;
end;
$$;

revoke all on function public.aethel_start_request(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.aethel_start_request(uuid, text, integer) to service_role;

create or replace function public.aethel_topup_key(
  p_key_id uuid,
  p_increase_by integer,
  p_reset boolean,
  p_default_limit integer,
  p_max_limit integer
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current_limit integer;
  v_new_limit integer;
begin
  if p_default_limit < 1 or p_max_limit < p_default_limit then
    raise exception 'invalid_limit_configuration' using errcode = '22023';
  end if;
  if p_reset is distinct from true and coalesce(p_increase_by, 0) < 1 then
    raise exception 'invalid_topup' using errcode = '22023';
  end if;
  if p_reset is true and coalesce(p_increase_by, 0) <> 0 then
    raise exception 'invalid_topup' using errcode = '22023';
  end if;

  select daily_limit into v_current_limit
  from public.aethel_api_keys
  where id = p_key_id and disabled_at is null
  for update;
  if not found then raise exception 'key_not_found' using errcode = 'P0002'; end if;

  if p_reset is true then
    v_new_limit := p_default_limit;
  else
    v_new_limit := v_current_limit + p_increase_by;
    if v_new_limit > p_max_limit then raise exception 'daily_limit_ceiling_exceeded' using errcode = '22023'; end if;
  end if;

  update public.aethel_api_keys set daily_limit = v_new_limit where id = p_key_id;
  return v_new_limit;
end;
$$;

revoke all on function public.aethel_topup_key(uuid, integer, boolean, integer, integer) from public, anon, authenticated;
grant execute on function public.aethel_topup_key(uuid, integer, boolean, integer, integer) to service_role;

notify pgrst, 'reload schema';
