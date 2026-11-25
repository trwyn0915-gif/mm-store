-- RIP Online World: initial Supabase schema
-- Run this in the Supabase SQL Editor after creating a project.
create extension if not exists pgcrypto;

create table if not exists public.world_players (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 20),
  character_id text not null default 'survivor',
  room_id text not null default 'station',
  x real not null default 480,
  y real not null default 270,
  facing text not null default 'down' check (facing in ('up','down','left','right')),
  level integer not null default 1 check (level >= 1),
  experience integer not null default 0 check (experience >= 0),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.world_chat (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 20),
  room_id text not null default 'station',
  message text not null check (char_length(message) between 1 and 300),
  created_at timestamptz not null default now()
);

create index if not exists world_players_room_seen_idx
  on public.world_players(room_id, last_seen_at desc);
create index if not exists world_chat_room_created_idx
  on public.world_chat(room_id, created_at desc);

alter table public.world_players enable row level security;
alter table public.world_chat enable row level security;

drop policy if exists "Players are visible to everyone" on public.world_players;
create policy "Players are visible to everyone"
  on public.world_players for select to authenticated using (true);

drop policy if exists "Players can create their own character" on public.world_players;
create policy "Players can create their own character"
  on public.world_players for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Players can update their own character" on public.world_players;
create policy "Players can update their own character"
  on public.world_players for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "Players can delete their own character" on public.world_players;
create policy "Players can delete their own character"
  on public.world_players for delete to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Authenticated users can read room chat" on public.world_chat;
create policy "Authenticated users can read room chat"
  on public.world_chat for select to authenticated using (true);

drop policy if exists "Players can send chat as themselves" on public.world_chat;
create policy "Players can send chat as themselves"
  on public.world_chat for insert to authenticated
  with check (auth.uid() = user_id);

-- Enable realtime row events for the initial presence fallback and chat feed.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'world_players'
  ) then
    alter publication supabase_realtime add table public.world_players;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'world_chat'
  ) then
    alter publication supabase_realtime add table public.world_chat;
  end if;
end $$;
