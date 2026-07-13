-- Logged items: one row per successfully-parsed <ADD> tag (FR-003).
-- rating is an LLM-ESTIMATED intensity inferred from user wording, NOT a measured/user-entered
-- value (see PRD data_model.notes) — stored on a fixed 1-5 scale documented in src/lib/systemPrompt.ts.

create table if not exists public.items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  item text not null,
  rating numeric not null check (rating >= 1 and rating <= 5),
  category text not null default 'movies',
  raw_user_text text not null,
  created_at timestamptz not null default now()
);

create index if not exists items_user_id_created_at_idx
  on public.items (user_id, created_at desc);

alter table public.items enable row level security;

-- Strict per-user isolation: "Only their own data" (auth.notes). Enforced server-side, not UI-only.
create policy "items_select_own"
  on public.items for select
  using (auth.uid() = user_id);

create policy "items_insert_own"
  on public.items for insert
  with check (auth.uid() = user_id);

create policy "items_delete_own"
  on public.items for delete
  using (auth.uid() = user_id);
