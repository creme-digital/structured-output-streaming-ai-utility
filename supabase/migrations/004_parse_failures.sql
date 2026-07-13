-- Log of raw model output when tag extraction fails, for debugging (required by FR-004).

create table if not exists public.parse_failures (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete cascade,
  raw_output text not null,
  reason text not null check (reason in ('malformed', 'missing', 'other')),
  created_at timestamptz not null default now()
);

create index if not exists parse_failures_user_id_created_at_idx
  on public.parse_failures (user_id, created_at desc);

alter table public.parse_failures enable row level security;

-- Every chat interaction in this build happens behind auth (FR-006 ties persistence to login),
-- so failures are always attributable to the signed-in user; isolation matches items/chat_messages.
create policy "parse_failures_select_own"
  on public.parse_failures for select
  using (auth.uid() = user_id);

create policy "parse_failures_insert_own"
  on public.parse_failures for insert
  with check (auth.uid() = user_id);
