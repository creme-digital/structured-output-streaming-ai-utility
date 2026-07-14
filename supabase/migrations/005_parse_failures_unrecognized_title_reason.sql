-- Cycle 4 (PRD v5) / FR-001 Issue 2 + FR-004: widen the allowed `parse_failures.reason`
-- values to include 'unrecognized_title' — recorded when the model declines to emit
-- <ADD>/<UPDATE> because it doesn't recognize the stated title as a real movie and asks
-- for clarification instead. This is expected, non-failure behavior, logged purely for
-- visibility/analytics (see docs/ARCHITECTURE.md).
--
-- Additive-only: this widens the existing check constraint (adds a new allowed value)
-- without dropping, renaming, or touching any existing column, table, or row. No
-- backfill is needed or performed — this cycle introduces no new rows with the new
-- reason value on its own; the application will start writing it going forward.

alter table public.parse_failures
  drop constraint if exists parse_failures_reason_check;

alter table public.parse_failures
  add constraint parse_failures_reason_check
  check (reason in ('malformed', 'missing', 'other', 'unrecognized_title'));
