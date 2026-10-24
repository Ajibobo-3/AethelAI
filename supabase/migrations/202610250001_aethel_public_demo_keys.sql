alter table public.aethel_api_keys
  add column if not exists expires_at timestamptz;

create table if not exists public.aethel_public_demo_issue_limits (
  ip_hash text primary key,
  issue_date date not null,
  issue_count integer not null check (issue_count between 1 and 3),
  updated_at timestamptz not null default now()
);
create index if not exists aethel_public_demo_issue_date_idx on public.aethel_public_demo_issue_limits (issue_date);

alter table public.aethel_public_demo_issue_limits enable row level security;
revoke all on public.aethel_public_demo_issue_limits from public, anon, authenticated;
grant all on public.aethel_public_demo_issue_limits to service_role;

create or replace function public.aethel_issue_demo_key(
  p_key_hash text,
  p_ip_hash text,
  p_daily_limit integer,
  p_max_issues integer,
  p_expires_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_today date := (now() at time zone 'UTC')::date;
  v_issue_count integer;
  v_key_id uuid;
begin
  if p_key_hash is null or p_ip_hash is null
     or p_daily_limit is distinct from 20
     or p_max_issues is distinct from 3
     or p_expires_at is null or p_expires_at <= now() then
    raise exception 'invalid_demo_key_configuration' using errcode = '22023';
  end if;

  delete from public.aethel_public_demo_issue_limits
  where issue_date < v_today - 30;

  insert into public.aethel_public_demo_issue_limits as issue_limit (ip_hash, issue_date, issue_count, updated_at)
  values (p_ip_hash, v_today, 1, now())
  on conflict (ip_hash) do update set
    issue_date = excluded.issue_date,
    issue_count = case
      when issue_limit.issue_date < v_today then 1
      else issue_limit.issue_count + 1
    end,
    updated_at = now()
  where issue_limit.issue_date < v_today
     or issue_limit.issue_count < p_max_issues
  returning issue_count into v_issue_count;

  if not found then
    raise exception 'public_demo_limit_reached' using errcode = 'P0001';
  end if;

  insert into public.aethel_api_keys (name, key_hash, daily_limit, expires_at)
  values ('Aethel public demo', p_key_hash, p_daily_limit, p_expires_at)
  returning id into v_key_id;

  return v_key_id;
end;
$$;

revoke all on function public.aethel_issue_demo_key(text, text, integer, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.aethel_issue_demo_key(text, text, integer, integer, timestamptz) to service_role;

create or replace function public.aethel_start_request(p_key_id uuid, p_model text, p_daily_limit integer)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_usage_id uuid;
  v_count integer;
  v_key_daily_limit integer;
begin
  select daily_limit into v_key_daily_limit
  from public.aethel_api_keys
  where id = p_key_id and disabled_at is null and (expires_at is null or expires_at > now())
  for update;
  if not found then raise exception 'invalid_key' using errcode = 'P0002'; end if;
  v_key_daily_limit := coalesce(v_key_daily_limit, p_daily_limit);

  select count(*)::integer into v_count
  from public.aethel_usage
  where key_id = p_key_id
    and created_at >= (date_trunc('day', timezone('UTC', now())) at time zone 'UTC');
  if v_count >= v_key_daily_limit then raise exception 'daily_limit_reached' using errcode = 'P0001'; end if;

  insert into public.aethel_usage (key_id, model, status)
  values (p_key_id, p_model, 'pending')
  returning id into v_usage_id;
  return v_usage_id;
end;
$$;

revoke all on function public.aethel_start_request(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.aethel_start_request(uuid, text, integer) to service_role;

notify pgrst, 'reload schema';
