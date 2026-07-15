-- Cycle 7 (PRD v7) / FR-001, FR-003, FR-008, FR-009, FR-010: "want to watch" tracking +
-- live history panel.
--
-- ADDITIVE-ONLY, per the work order's migration_notes:
--   1. items.status (text, default 'watched') — a normal rated <ADD>/<UPDATE> implicitly
--      means "watched"; a new <ADD status="want_to_watch" /> means the user intends to
--      watch the title later and carries no rating yet. The DEFAULT backfills every
--      existing row to 'watched' automatically (Postgres populates the new column for
--      pre-existing rows from the DEFAULT at ALTER TABLE time) — nothing already logged
--      is reinterpreted, no separate UPDATE/backfill statement is needed or performed.
--   2. items.rating relaxed to nullable — want-to-watch rows carry no rating. Existing
--      non-null ratings are completely untouched; this only removes a constraint, it
--      does not rewrite any value. The existing `rating between 1 and 5` CHECK already
--      tolerates NULL (a NULL comparison is not FALSE, so the constraint only rejects
--      out-of-range non-null values) — no change needed there.
--   3. Register `items` with the `supabase_realtime` publication so FR-010's history
--      panel can subscribe to INSERT events (RLS still applies to what a given
--      subscriber actually receives — this does not open any new read path).
--
-- No table/column drop, no rename, no destructive UPDATE/DELETE anywhere in this file.

alter table public.items
  add column if not exists status text not null default 'watched';

alter table public.items
  add constraint items_status_check check (status in ('watched', 'want_to_watch'));

alter table public.items
  alter column rating drop not null;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'items'
  ) then
    alter publication supabase_realtime add table public.items;
  end if;
end
$$;
