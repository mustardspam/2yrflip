-- ============================================================
-- Buy Box backend: monthly usage cap + address cache
-- Run this ONCE in Supabase → SQL Editor → New query → Run.
-- ============================================================

-- Per-month RentCast call counter
create table if not exists public.api_usage (
  month text primary key,           -- 'YYYY-MM' (UTC)
  count int  not null default 0
);

-- Cache so repeat lookups of the same address don't re-bill RentCast
create table if not exists public.buybox_cache (
  address    text primary key,      -- lower-cased address
  month      text not null,         -- month the cache entry belongs to
  payload    jsonb not null,
  created_at timestamptz not null default now()
);

-- Read current month's usage
create or replace function public.get_usage(p_month text)
returns int
language sql
security definer
set search_path = public
as $$
  select coalesce((select count from public.api_usage where month = p_month), 0);
$$;

-- Atomically add N to this month's usage, return the new total
create or replace function public.add_usage(p_month text, p_n int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare c int;
begin
  insert into public.api_usage(month, count) values (p_month, p_n)
  on conflict (month) do update set count = public.api_usage.count + p_n
  returning count into c;
  return c;
end;
$$;

-- Lock the tables: no anon/public access. The Edge Function uses the
-- service-role key, which bypasses RLS. With RLS on and NO policies,
-- nobody else can read or write these tables.
alter table public.api_usage    enable row level security;
alter table public.buybox_cache enable row level security;
