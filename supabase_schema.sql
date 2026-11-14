
-- ==============================================================================
-- MOMENTUM CHASERS — SUPABASE PRODUCTION DATABASE SCHEMA
-- Execute this script directly in your Supabase SQL Editor (SQL Editor -> New Query)
-- ==============================================================================

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- ------------------------------------------------------------------------------
-- 1. USER PROFILES TABLE (Linked with Supabase Auth)
-- ------------------------------------------------------------------------------
create table if not exists public.profiles (
    id uuid references auth.users on delete cascade primary key,
    email text unique not null,
    full_name text,
    avatar_url text,
    plan_tier text default 'Pro Terminal',
    broker_connected text default 'None',
    created_at timestamp with time zone default timezone('utc'::text, now()) not null,
    updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable Row Level Security (RLS)
alter table public.profiles enable row level security;

create policy "Users can view their own profile"
    on public.profiles for select
    using (auth.uid() = id);

create policy "Users can update their own profile"
    on public.profiles for update
    using (auth.uid() = id);

-- Auto-create profile trigger on auth signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
    insert into public.profiles (id, email, full_name, avatar_url)
    values (
        new.id,
        new.email,
        coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
        coalesce(new.raw_user_meta_data->>'avatar_url', '👤')
    );
    return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute procedure public.handle_new_user();

-- ------------------------------------------------------------------------------
-- 2. STARRED WATCHLISTS TABLE
-- ------------------------------------------------------------------------------
create table if not exists public.user_watchlists (
    id uuid default uuid_generate_v4() primary key,
    user_id uuid references public.profiles(id) on delete cascade not null,
    symbols jsonb default '["BAJAJ-AUTO", "BSE", "SMSPHARMA"]'::jsonb not null,
    ticker_mode text default 'combined',
    updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
    constraint unique_user_watchlist unique(user_id)
);

alter table public.user_watchlists enable row level security;

create policy "Users can view own watchlist"
    on public.user_watchlists for select
    using (auth.uid() = user_id);

create policy "Users can update own watchlist"
    on public.user_watchlists for all
    using (auth.uid() = user_id);

-- ------------------------------------------------------------------------------
-- 3. MULTI-DEMAT PORTFOLIO HOLDINGS
-- ------------------------------------------------------------------------------
create table if not exists public.portfolio_holdings (
    id uuid default uuid_generate_v4() primary key,
    user_id uuid references public.profiles(id) on delete cascade not null,
    account_label text default 'Account A (Zerodha)' not null,
    symbol text not null,
    quantity integer not null check (quantity > 0),
    avg_buy_price numeric(12, 2) not null,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table public.portfolio_holdings enable row level security;

create policy "Users can manage own portfolio holdings"
    on public.portfolio_holdings for all
    using (auth.uid() = user_id);

-- ------------------------------------------------------------------------------
-- 4. 3-YEAR MAINBOARD IPO HUB TABLE
-- ------------------------------------------------------------------------------
create table if not exists public.ipo_listings (
    id uuid default uuid_generate_v4() primary key,
    company_name text not null,
    symbol text not null,
    issue_year integer not null,
    issue_price numeric(10, 2) not null,
    listing_date date,
    open_date date,
    close_date date,
    listing_open numeric(10, 2),
    listing_close numeric(10, 2),
    current_price numeric(10, 2),
    listing_gain_pct numeric(8, 2),
    current_gain_pct numeric(8, 2),
    subscription_times numeric(8, 2),
    gmp_price numeric(8, 2) default 0,
    category text default 'Mainboard',
    status text default 'Listed',
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table public.ipo_listings enable row level security;

-- Public can read IPO listings
create policy "Public can read IPO listings"
    on public.ipo_listings for select
    using (true);

-- Indexes for lightning fast year & symbol queries
create index if not exists idx_ipo_year on public.ipo_listings(issue_year);
create index if not exists idx_ipo_symbol on public.ipo_listings(symbol);

-- ------------------------------------------------------------------------------
-- 5. CORPORATE & MACRO EVENTS CALENDAR
-- ------------------------------------------------------------------------------
create table if not exists public.events_calendar (
    id uuid default uuid_generate_v4() primary key,
    event_type text not null, -- 'economic', 'earnings', 'concall', 'actions', 'holidays'
    symbol text,
    company_name text,
    event_title text not null,
    event_date date not null,
    event_time text,
    period text,
    details jsonb default '{}'::jsonb,
    impact text default 'high', -- 'high', 'medium', 'low'
    status text default 'Confirmed',
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table public.events_calendar enable row level security;

create policy "Public can read events calendar"
    on public.events_calendar for select
    using (true);

create index if not exists idx_events_date on public.events_calendar(event_date);
create index if not exists idx_events_type on public.events_calendar(event_type);

-- ------------------------------------------------------------------------------
-- 6. LIVE 50x200 EMA CROSSOVER ALERTS HISTORY
-- ------------------------------------------------------------------------------
create table if not exists public.crossover_alerts (
    id uuid default uuid_generate_v4() primary key,
    symbol text not null,
    timeframe text default '15m' not null,
    cross_type text not null, -- 'golden_cross_50_200' or 'death_cross_50_200'
    ema_50 numeric(12, 2) not null,
    ema_200 numeric(12, 2) not null,
    trigger_price numeric(12, 2) not null,
    triggered_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table public.crossover_alerts enable row level security;

create policy "Public can read crossover alerts"
    on public.crossover_alerts for select
    using (true);

create index if not exists idx_crossover_symbol on public.crossover_alerts(symbol);
create index if not exists idx_crossover_triggered on public.crossover_alerts(triggered_at desc);

-- ------------------------------------------------------------------------------
-- 7. INITIAL SAMPLE DATA SEED
-- ------------------------------------------------------------------------------
insert into public.ipo_listings (company_name, symbol, issue_year, issue_price, listing_date, listing_open, listing_close, current_price, listing_gain_pct, current_gain_pct, subscription_times, gmp_price, status)
values
('Waaree Energies Limited', 'WAAREEENER', 2024, 1503.00, '2024-10-28', 2550.00, 2341.40, 2980.50, 55.78, 98.30, 76.34, 1320.00, 'Listed'),
('Hyundai Motor India Limited', 'HYUNDAI', 2024, 1960.00, '2024-10-22', 1934.00, 1819.60, 1795.00, -7.16, -8.42, 2.37, -35.00, 'Listed'),
('Swiggy Limited', 'SWIGGY', 2024, 390.00, '2024-11-13', 420.00, 456.00, 488.50, 16.92, 25.26, 3.59, 25.00, 'Listed'),
('NTPC Green Energy Limited', 'NTPCGREEN', 2025, 108.00, '2025-01-14', 111.50, 118.20, 134.60, 9.44, 24.63, 14.80, 8.50, 'Listed'),
('Tata Passenger Electric Mobility', 'TATAPEV', 2026, 540.00, '2026-03-24', 680.00, 715.00, 782.40, 32.41, 44.89, 48.20, 145.00, 'Listed')
on conflict do nothing;

