-- ============================================================
--  ABISE AUTO PARTS — database setup
--  Paste this whole file into YOUR NEW Supabase project:
--    SQL Editor -> New query -> Run
--  IMPORTANT: create a brand-new Supabase project for this app.
--  Do NOT run this in the database used by any other app.
--
--  It creates one shared table that holds the whole shop as a
--  single JSON document, and locks it so only signed-in users
--  (the owner and you) can read/write.
-- ============================================================

-- 1) The table that holds the whole shop as one JSON document
create table if not exists public.shop_data (
  id text primary key,
  content jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- 2) Turn on Row Level Security
alter table public.shop_data enable row level security;

-- 3) Allow any signed-in (authenticated) user to read and write.
--    Since only the owner and you will have accounts, this means
--    just the two of you share the data.
drop policy if exists "authenticated read"   on public.shop_data;
drop policy if exists "authenticated insert" on public.shop_data;
drop policy if exists "authenticated update" on public.shop_data;

create policy "authenticated read"
  on public.shop_data for select
  to authenticated using (true);

create policy "authenticated insert"
  on public.shop_data for insert
  to authenticated with check (true);

create policy "authenticated update"
  on public.shop_data for update
  to authenticated using (true) with check (true);

-- 4) Let live sync (realtime) broadcast changes to both devices
alter publication supabase_realtime add table public.shop_data;

-- 5) IMPORTANT for live sync: make realtime include the full changed row
alter table public.shop_data replica identity full;
