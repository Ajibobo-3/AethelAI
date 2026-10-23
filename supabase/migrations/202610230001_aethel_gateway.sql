create extension if not exists pgcrypto;

create table if not exists public.aethel_api_keys (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  key_hash text not null unique,
  created_at timestamptz not null default now(),
  disabled_at timestamptz
);

create table if not exists public.aethel_usage (
  id uuid primary key default gen_random_uuid(),
  key_id uuid not null references public.aethel_api_keys(id),
  model text not null,
  status text not null check (status in ('pending', 'succeeded', 'failed')) default 'pending',
  prompt_tokens integer not null default 0 check (prompt_tokens >= 0),
  completion_tokens integer not null default 0 check (completion_tokens >= 0),
  total_tokens integer not null default 0 check (total_tokens >= 0),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists aethel_usage_key_day_idx on public.aethel_usage (key_id, created_at desc);

alter table public.aethel_api_keys enable row level security;
alter table public.aethel_usage enable row level security;
revoke all on public.aethel_api_keys, public.aethel_usage from anon, authenticated;
grant all on public.aethel_api_keys, public.aethel_usage to service_role;

create or replace function public.aethel_start_request(p_key_id uuid, p_model text, p_daily_limit integer)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_usage_id uuid;
  v_count integer;
begin
  perform 1 from public.aethel_api_keys where id = p_key_id and disabled_at is null for update;
  if not found then raise exception 'invalid_key' using errcode = 'P0002'; end if;

  select count(*)::integer into v_count
  from public.aethel_usage
  where key_id = p_key_id and created_at >= date_trunc('day', now());
  if v_count >= p_daily_limit then raise exception 'daily_limit_reached' using errcode = 'P0001'; end if;

  insert into public.aethel_usage (key_id, model, status)
  values (p_key_id, p_model, 'pending')
  returning id into v_usage_id;
  return v_usage_id;
end;
$$;

revoke all on function public.aethel_start_request(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.aethel_start_request(uuid, text, integer) to service_role;

notify pgrst, 'reload schema';
