-- Cycle 7: fix for the self-reinforcing "history poisoning" compliance bug.
--
-- Root cause (reproduced against the live site): assistant replies are persisted with
-- their <ADD>/<UPDATE>/<RECOMMEND> tags stripped (correct for display), but that same
-- cleaned text was ALSO what got sent back to the model as conversation history. After
-- one stochastic compliance miss (a prose claim like "I'll update your rating now" with
-- no tag), the persisted claim becomes few-shot evidence that tags are optional, and the
-- model stops emitting them for the rest of the conversation — every subsequent
-- <UPDATE>/want-to-watch turn silently fails.
--
-- Fix: store the model-visible form of each assistant turn separately.
--   raw_content = the assistant's raw output, tags included  -> sent back to the model
--   raw_content = NULL -> this turn is EXCLUDED from model history entirely
--     (compliance misses, malformed-tag turns, and every pre-migration row — which
--     instantly detoxes any history already poisoned before this fix shipped).
-- `content` remains the cleaned display text and is untouched.
--
-- ADDITIVE-ONLY: one nullable column, no backfill (NULL is the correct value for every
-- existing row), no drop/rename/rewrite anywhere in this file.

alter table public.chat_messages
  add column if not exists raw_content text;
