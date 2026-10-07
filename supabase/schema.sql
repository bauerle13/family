-- Home Fund — database setup
-- Paste this whole file into Supabase > SQL Editor > New query, then click Run.

-- 1. Household members ----------------------------------------------------
create table if not exists public.members (
  user_id      uuid primary key references auth.users on delete cascade,
  display_name text,
  created_at   timestamptz not null default now()
);

create or replace function public.is_member()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.members where user_id = auth.uid())
$$;

-- 2. Bank connections (Plaid Items) ---------------------------------------
-- Only the "plaid" Edge Function writes here. Browsers can see the bank
-- name and sync status, but never the access_token or cursor.
create table if not exists public.items (
  id           text primary key,
  institution  text,
  access_token text not null,
  cursor       text,
  status       text not null default 'active',
  last_synced  timestamptz,
  last_error   text,
  created_at   timestamptz not null default now()
);

-- 3. Accounts (linked + manual) -------------------------------------------
create table if not exists public.accounts (
  id                text primary key default ('man_' || gen_random_uuid()),
  item_id           text references public.items(id) on delete cascade,
  institution       text,
  name              text not null,
  nickname          text,
  type              text,
  subtype           text,
  last_four         text,
  balance_ledger    numeric,
  balance_available numeric,
  is_manual         boolean not null default false,
  include_in_goal   boolean not null default false,
  hidden            boolean not null default false,
  flip_sign         boolean not null default false,
  updated_at        timestamptz not null default now()
);

-- 4. Transactions (amount: money in is positive, money out is negative) ----
create table if not exists public.transactions (
  id            text primary key default ('man_' || gen_random_uuid()),
  account_id    text references public.accounts(id) on delete cascade,
  date          date not null,
  description   text,
  amount        numeric not null,
  type          text,
  status        text default 'posted',
  bank_category text,
  counterparty  text,
  category      text,
  note          text,
  is_manual     boolean not null default false,
  created_at    timestamptz not null default now()
);
create index if not exists transactions_date_idx on public.transactions (date desc);
create index if not exists transactions_account_idx on public.transactions (account_id);

-- 5. Bills, subscriptions and expected income -----------------------------
create table if not exists public.bills (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  amount     numeric not null,
  kind       text not null default 'expense' check (kind in ('expense','income')),
  frequency  text not null default 'monthly'
             check (frequency in ('weekly','biweekly','monthly','quarterly','yearly')),
  next_due   date not null,
  match_key  text,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- 6. Settings (home goal, preferences) — one shared row -------------------
create table if not exists public.settings (
  id         int primary key default 1 check (id = 1),
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into public.settings (id) values (1) on conflict do nothing;

-- 7. Row Level Security: only household members see or change anything ---
alter table public.members      enable row level security;
alter table public.items        enable row level security;
alter table public.accounts     enable row level security;
alter table public.transactions enable row level security;
alter table public.bills        enable row level security;
alter table public.settings     enable row level security;

drop policy if exists members_read on public.members;
create policy members_read on public.members for select using (public.is_member());
drop policy if exists items_read on public.items;
create policy items_read on public.items for select using (public.is_member());
drop policy if exists acc_all on public.accounts;
create policy acc_all on public.accounts for all using (public.is_member()) with check (public.is_member());
drop policy if exists txn_all on public.transactions;
create policy txn_all on public.transactions for all using (public.is_member()) with check (public.is_member());
drop policy if exists bill_all on public.bills;
create policy bill_all on public.bills for all using (public.is_member()) with check (public.is_member());
drop policy if exists set_all on public.settings;
create policy set_all on public.settings for all using (public.is_member()) with check (public.is_member());

-- 8. Permissions ----------------------------------------------------------
revoke all on public.members, public.items, public.accounts, public.transactions, public.bills, public.settings from anon;
revoke all on public.items from authenticated;
grant usage on schema public to authenticated, service_role;
grant select (id, institution, status, last_synced, last_error, created_at) on public.items to authenticated;
grant select on public.members to authenticated;
grant select, insert, update, delete on public.accounts, public.transactions, public.bills, public.settings to authenticated;
grant all on public.members, public.items, public.accounts, public.transactions, public.bills, public.settings to service_role;
grant execute on function public.is_member() to authenticated;
