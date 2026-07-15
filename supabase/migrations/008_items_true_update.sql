-- Cycle 8 (dev-directed): <UPDATE> becomes a true in-place update.
--
-- Cycles 4-7 deliberately implemented <UPDATE> as a fresh INSERT (full uncollapsed
-- rating history, "the current rating is the latest row"). The dev has now explicitly
-- reversed that decision after seeing it live ("I want the update to be a true update
-- rather than a new log"): a re-rated title must keep ONE row per (user, category,
-- title), modified in place.
--
--   1. items_update_own RLS policy — the client-side update path did not exist before,
--      so no UPDATE policy was ever granted; without this the new code would silently
--      match zero rows.
--   2. One-time dedupe of rows produced by the old insert-per-<UPDATE> behavior: keep
--      the newest row per (user_id, category, lower(item)) — exactly the row every
--      reader already treated as "the current rating" — and delete the older
--      duplicates. Verified immediately before applying: this removes a single row
--      (one user's older "Norbit" log) in the production project.
--
-- No unique index on (user_id, category, lower(item)) is added: <ADD>-vs-<UPDATE>
-- routing is the model's job (via the titles reference list), and a rare duplicate
-- <ADD> is preferable to a hard insert failure surfacing mid-chat.

create policy "items_update_own"
  on public.items for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

with ranked as (
  select id,
         row_number() over (
           partition by user_id, category, lower(item)
           order by created_at desc
         ) as rn
  from public.items
)
delete from public.items
where id in (select id from ranked where rn > 1);
