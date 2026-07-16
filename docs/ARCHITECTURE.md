# Architecture

This document describes the app **as built**, not as originally planned. Where the
build deviated from the PRD's suggestions, that's called out explicitly in
"Assumptions & decisions" below.

## System overview

```
Browser (React SPA)
  │  fetch("/api/chat", { messages, accessToken })
  ▼
Netlify Edge Function (netlify/edge-functions/chat.ts, Deno)
  │  reads caller's own items ONCE (RLS-scoped, via accessToken — Cycle 4/FR-009),
  │  injects SYSTEM_PROMPT + a titles-context message (all statuses, ADD-vs-UPDATE
  │  matching) + a rated-only recommendation-context message (Cycle 6/FR-008) +
  │  OPENAI_API_KEY, streams request through
  ▼
OpenAI chat-completions API (stream: true, temperature 0.2)
  │  SSE deltas flow back through the edge function unmodified
  ▼
Browser: OpenAIStreamDecoder → extractTags() → React state (token-by-token render)
  │  on successful <ADD>/<UPDATE>/<RECOMMEND> tag / on malformed / on
  │  unrecognized-title / on failure
  ▼
Supabase (Postgres, RLS) — items / chat_messages / parse_failures / profiles
  │  + a realtime subscription on items INSERT (Cycle 6 / FR-010, RLS-scoped)
  ▼
Browser: live history panel (Rated / Want to Watch tabs)
```

The OpenAI API key never reaches the browser: the edge function is the only piece of
server-side compute in this build, and its only job is to attach the key and the system
prompt, then pass the SSE stream through. All prompt-shaping and stream-decoding logic
lives in plain TypeScript modules under `src/lib/` (`systemPrompt.ts`, `openaiRequest.ts`,
`sseParser.ts`) so it can be unit-tested with vitest without a Deno runtime or a live
OpenAI connection — the edge function itself (`netlify/edge-functions/chat.ts`) is thin
glue over those modules.

## Data model as built

Four tables, all under Supabase-managed RLS, `auth.uid()` as the isolation key throughout:

### `profiles`
One row per signed-up user, created automatically by an `on_auth_user_created` trigger
(`supabase/migrations/001_profiles.sql`) — never inserted from the client. It exists to
back per-user isolation and give the schema a natural home for future profile fields;
**the frontend never reads or writes this table directly** in this build (no profile
page or settings UI was in scope).

### `items`
One row per logged title. `<ADD>` inserts; since Cycle 8, `<UPDATE>` performs a **true
in-place update** of the existing row for that title (found case-insensitively; falls
back to an insert if the model emitted `<UPDATE>` for a never-logged title). This
supersedes Cycles 4–7's deliberate insert-per-`<UPDATE>` design ("full uncollapsed
rating history", "the current rating is the latest row"): the dev explicitly reversed
that decision after seeing duplicate entries live. `008_items_true_update.sql` added
the previously-missing `items_update_own` RLS policy and deduped the historical
duplicates (keeping the newest row per `(user_id, category, lower(item))`). Uniqueness
is maintained by app logic + the model's titles reference list, not by a DB unique
index — a rare duplicate `<ADD>` is preferable to a hard insert failure mid-chat.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | `gen_random_uuid()` default |
| `user_id` | uuid | FK → `auth.users`, isolation key |
| `item` | text | Movie title — verbatim from the tag's `item` attribute for `<ADD>`, or the reference-list spelling the model was given for `<UPDATE>` (see systemPrompt.ts) |
| `rating` | numeric, nullable (Cycle 6) | **LLM-estimated**, 1–5 integer scale, see "Rating scale" below — never a value the user typed directly. NULL for a want-to-watch row (Cycle 6 / FR-001/FR-003): the `NOT NULL` constraint was dropped in `006_items_status_and_realtime.sql` specifically to allow this; every rated `<ADD>`/`<UPDATE>` still always carries a real 1–5 value |
| `category` | text | Hardcoded `"movies"` at the call site (`useChat.ts`); column exists for forward-compatibility, no other category is exercised |
| `raw_user_text` | text | The triggering user message, kept as tracking metadata |
| `created_at` | timestamptz | default `now()` |
| `status` | text, `default 'watched'` (Cycle 6) | `"watched"` for a normal rated `<ADD>`/any `<UPDATE>` (including the want-to-watch → watched transition); `"want_to_watch"` for `<ADD status="want_to_watch" />` (rating NULL). Existing rows all backfilled to `"watched"` automatically via the column default — no historical row is reinterpreted. Checked in Postgres (`status in ('watched', 'want_to_watch')`) |

Constraint: `rating between 1 and 5` enforced in Postgres (`002_items.sql`), matching the
scale the system prompt instructs the model to use — a belt-and-suspenders check in case
a future prompt change or model drift ever produced an out-of-range value (the frontend's
`ADD_TAG_DEFINITION.validate` in `tagParser.ts`, reused unchanged as `UPDATE_TAG_DEFINITION.validate`,
already rejects those before they'd reach Supabase, but the DB constraint holds regardless
of client behavior). That check already tolerated `NULL` (a NULL comparison is never
`FALSE`), so no constraint edit was needed there when `rating` was made nullable — only
the column's own `NOT NULL` needed dropping. No schema change was needed for `<UPDATE>`
itself — same table, same columns, purely additive.

**Recommendation grounding (Cycle 6 / FR-008) reads `items` too**, but only rows with
`status = 'watched'` and a non-null `rating` — a want-to-watch row carries no opinion
signal and must never be treated as an expressed preference (`buildRecommendationContextMessage`
in `systemPrompt.ts`, called from the edge function's `fetchUserItemContext`). The
ADD-vs-UPDATE title-matching context (`buildExistingTitlesMessage`), by contrast,
deliberately includes titles of BOTH statuses, since a want-to-watch title still counts
as "already logged" for the purpose of routing a later opinion to `<UPDATE>` instead of
a fresh `<ADD>` (the want-to-watch → watched transition, FR-009).

**Realtime**: `items` is registered on the `supabase_realtime` publication
(`006_items_status_and_realtime.sql`) so the live history panel (FR-010) can subscribe to
`INSERT` events. RLS still governs what a given subscriber actually receives via
Supabase's per-subscriber RLS evaluation for `postgres_changes` — the subscription's own
`filter: user_id=eq.<userId>` is a defense-in-depth/noise-reduction nicety, not the
isolation boundary.

### `chat_messages`
One row per turn (`role: 'user' | 'assistant'`), written by `useChat.ts` right after the
user's message is accepted and again once the assistant's stream finishes. This is what
makes chat history persist across logout/login (FR-006) — `useChat`'s history-load effect
reads this table filtered to the signed-in user on mount.

Since Cycle 7, assistant rows carry two forms of the same turn: `content` (the cleaned,
tag-stripped display text, unchanged from before) and `raw_content` (the model-visible
form — the raw output with its tags intact, or `NULL` meaning "never replay this turn to
the model": compliance misses, malformed-tag turns, and every pre-Cycle-7 row). See the
Cycle 7 section below for the live-site poisoning incident that forced this split.

### `parse_failures`
Written whenever `useChat.ts` can't turn a model turn into either a clean chat message or
a saved item: malformed tag, missing tag on what looked like a loggable opinion (after the
Cycle-4 retry loop below exhausts all 3 attempts), empty stream, or a network/HTTP error
talking to `/api/chat`. `reason` is one of `malformed | missing | other | unrecognized_title`
— the last is new in Cycle 4 (`005_parse_failures_unrecognized_title_reason.sql` widens the
check constraint) and is recorded when the model correctly declines to log a title it
doesn't recognize as real and asks for clarification instead (FR-001 Issue 2); this is
**expected, non-failure behavior**, logged purely for visibility/analytics, not a
compliance miss. This table has no frontend reader — it exists purely as a debugging log
per FR-004; there is no in-app UI to browse it (Supabase Studio is the retrieval path an
evaluator or dev would use).

### Relationships
`profiles.id`, `items.user_id`, `chat_messages.user_id`, and `parse_failures.user_id` all
reference `auth.users(id)` directly (not `profiles.id`) with `on delete cascade` —
`profiles` is a parallel per-user table, not a foreign-key hub the other three route
through. This is a deliberate simplification: the PRD's relationship list draws
`profiles → items/chat_messages/parse_failures`, but since Supabase auth already provides
a stable `auth.users.id` and RLS keys off `auth.uid()` directly, adding an indirection
through `profiles.id` (which is 1:1 with `auth.users.id` anyway) would add a join with no
isolation or integrity benefit.

## Auth model as built

- **Method**: Supabase email/password only (`supabase.auth.signUp` /
  `signInWithPassword`), per FR-006. No social/OAuth/magic-link.
- **Single role**: there is no role column or admin path anywhere in the schema or UI —
  every authenticated user gets the same `ChatPanel` experience, matching
  `auth.roles: [user]` in the PRD.
- **Session handling** (`src/context/AuthContext.tsx`): `AuthProvider` resolves the
  initial session once on mount (`getSession()`), then reacts to
  `onAuthStateChange` for the lifetime of the tab (login, logout, token refresh).
  `App.tsx` gates the whole app on this: no session → `AuthScreen`; session → `Home`
  (which renders `ChatPanel` keyed to `user.id`).
- **Email confirmation handling**: Supabase's `signUp` does not return a session when the
  project requires email confirmation before first login. `AuthContext.signUp` surfaces
  this as `needsEmailConfirmation` rather than the caller assuming sign-up == signed-in;
  `AuthScreen` renders a distinct "check your email" message instead of falsely claiming
  "signing you in..." (this was a QA-stage fix — see Assumptions & decisions).
- **Isolation enforcement**: every table's RLS policies key exclusively off
  `auth.uid() = user_id` (or `= id` for `profiles`) for `select`/`insert`(/`delete` on
  `items`) — enforced in Postgres, not just filtered in the frontend query. The frontend
  additionally always scopes its own queries to the signed-in `user_id` (`useChat.ts`),
  but that's a performance/correctness nicety, not the isolation boundary; a user with a
  valid session but a hand-crafted query still cannot read another user's rows.
- **No admin/reviewer role, no cross-account view** — confirmed absent by design, per
  `out_of_scope`.

## Streaming + parsing pipeline, in order

1. `ChatPanel` → `useChat.sendMessage(text)`: inserts the user's `chat_messages` row,
   builds `historyForModel` (the running conversation, de-duplicated by message id —
   PRD v8 / Cycle 9 / FR-002, closing a latent "send this turn twice" risk found while
   auditing the stale-response bug, see "Assumptions & decisions"), then
   `fetch("/api/chat", { method: "POST", cache: "no-store", body: { messages:
   historyForModel, accessToken } })`. `cache: "no-store"` (PRD v8 / Cycle 9 / FR-002)
   is defense-in-depth ruling out the browser HTTP cache as a stale-response vector — the
   audit found no caching layer anywhere in this path, so this is a hardening measure,
   not a fix for an observed cache hit. `accessToken` (Cycle 4 / FR-009) is the caller's
   own Supabase session token, forwarded so the edge function can read *their own*
   previously-logged titles — it is never persisted or used for anything besides that
   one RLS-scoped read.
2. Edge function (`fetchExistingTitlesMessage`) best-effort reads the caller's own
   `items.item` values via a fresh, per-request Supabase client authenticated with that
   same access token (never the service role — PostgREST/RLS evaluates `auth.uid()` off
   it exactly as a direct client query would), builds a "Titles this user has already
   logged" system message (`buildExistingTitlesMessage`, deduped, capped at 50, omitted
   entirely for a user with none), then prepends `SYSTEM_PROMPT` (+ that message when
   present) and forwards to OpenAI with `stream: true, temperature: 0.2`
   (`openaiRequest.ts`), piping the upstream `Response.body` straight back — no
   buffering server-side. A missing token, missing env vars, or a query error all
   silently fall back to no titles context (never a crash) — the model then only ever
   emits `<ADD>`.
3. Client reads `response.body` with a `ReadableStreamDefaultReader`, feeding each chunk
   to `OpenAIStreamDecoder.feed()` (`sseParser.ts`), which incrementally parses OpenAI's
   `data: {...}` SSE lines (correctly buffering a line split across two chunks) and
   yields plain-text deltas.
4. Each delta is appended to a running `rawBuffer`, which is re-run through
   `extractTags()` (`tagParser.ts`) on every chunk so the **displayed** text always has
   any complete tag already stripped, plus `stripTrailingPartialTag()` to hide an
   in-progress `<ADD item="Ince` tail from flashing on screen mid-stream. This is what
   makes FR-003's "extract the tag from anywhere in the stream" hold even though the
   client only ever sees a growing prefix of the full response.
5. Once the stream ends (`[DONE]` or the reader closes), `extractTags()` runs one final
   time against the complete `rawBuffer` (this is one "attempt" — see the retry loop
   below) to decide what actually happened. `<ADD>`/`<UPDATE>` matches and `<RECOMMEND>`
   matches (Cycle 6 / FR-008) are dispatched independently — a single reply could in
   principle carry one of each, though the system prompt asks for that only when the
   user's message both states an opinion and asks for a recommendation in the same turn:
   - one or more valid `<ADD>`/`<UPDATE>` matches → `<ADD>` inserts a new `items` row;
     `<UPDATE>` (since Cycle 8) updates the caller's existing row for that title
     in place (falling back to an insert if none exists), always setting
     `status: "watched"` — a compound message (PRD v8 / Cycle 9) may carry several
     `<ADD>`/`<UPDATE>` matches in one reply, each dispatched independently. Footnote
     `Saved · <name>` for a rated `<ADD>`, `Want to watch · <name>` (`tone="watchlist"`,
     Cycle 6 / FR-005) for `<ADD status="want_to_watch" />`, or `Rating updated · <name>`
     (`tone="update"`) for `<UPDATE>` (including the want-to-watch → watched transition);
     multiple matches in one turn merge into one footnote (`Saved · A, B`). **Before
     this branch is accepted** (PRD v8 / Cycle 9 / FR-003/FR-004), if the user's message
     reads as genuinely compound (`countLikelyOpinions(userText) >= 2`,
     `opinionHeuristic.ts`) the matched titles are checked against the message's own
     opinion-bearing segments (`findUncapturedOpinionSegments`); if any segment isn't
     accounted for and attempts remain, the **whole turn** is silently retried (not just
     the missing tag) exactly like the no-tag retry below. If all 3 whole-turn attempts
     still leave a segment uncaptured, whatever DID get tagged is still written (never
     discarded for a sibling opinion's failure) and the outcome becomes `partial_multi`:
     one `parse_failures` row (`reason: "missing"`) plus a footnote naming every
     uncaptured opinion (`Didn't catch: "..."`, folded alongside any success footnote);
   - a valid `<RECOMMEND>` match (Cycle 6 / FR-008) → no database write, rendered as a
     distinct `RecommendationCard` (not the footnote pill) under the assistant's bubble;
   - a recognized-but-malformed `<ADD>`/`<UPDATE>`/`<RECOMMEND>` tag → log to
     `parse_failures` (`reason: "malformed"`), footnote
     `Couldn't log that — logged for review.`;
   - no tag, but the reply reads like the model's unrecognized-title clarification
     (`looksLikeUnrecognizedTitleClarification`, `titleClarificationHeuristic.ts` —
     Cycle 4 / FR-001 Issue 2) → **not retried**, logged to `parse_failures`
     (`reason: "unrecognized_title"`), shown as an ordinary conversational reply with
     no footnote (expected behavior, not a failure);
   - no tag, and `looksLikeLoggableOpinion(userText)` (`opinionHeuristic.ts`, extended in
     Cycle 6 to also recognize rewatch/changed-opinion phrasing, and in Cycle 9/PRD v8 to
     also recognize bare sentiment-only phrasing with no explicit number — "I hated
     Barbie" — see "Assumptions & decisions") is true → **FR-004 Issue 1 retry loop**:
     silently re-run this whole attempt (steps 2–5) up to 2 more times (3 attempts
     total), discarding every failed attempt's streamed text entirely — the user only
     ever sees the *last* attempt's output. This is the same loop the compound-message
     whole-turn retry above reuses. If an attempt in the loop finally produces a tag,
     it's handled by the branches above as normal. If all 3 attempts produce no tag, log
     `reason: "missing"` once, neutral footnote;
   - no tag, opinion-heuristic false, but `looksLikeRecommendationRequest(userText)`
     (`recommendationHeuristic.ts`, Cycle 6 / FR-008) is true AND the caller told
     `useChat` the user has at least one rated item (`hasRatedItems`, sourced from
     `useHistory` via `Home.tsx`) → logged once as `reason: "missing"`, same neutral
     footnote treatment, but **not retried** (the PRD scopes the 2-retry safety net to
     FR-004 Issue 1's `<ADD>`/`<UPDATE>` fix, not `<RECOMMEND>`). `hasRatedItems` gates
     this specifically so a brand-new user's expected, tag-less "log a few movies first"
     decline (FR-004's "no fabricated personalized recommendation from empty data") is
     never mislabeled as a compliance miss;
   - no tag and neither heuristic fired → ordinary conversation, nothing logged, no
     footnote, no retry;
   - empty final text, non-OK HTTP response, or any thrown exception anywhere in the
     above → `reason: "other"`, danger-toned fallback message, **never** an unhandled
     exception surfaced to the user (all paths are wrapped in `try/catch` inside
     `useChat.sendMessage`).
6. The assistant's final displayed text (tag stripped) is persisted to `chat_messages`
   regardless of which branch above fired — only the surviving, kept attempt's text is
   ever persisted; discarded retry attempts are never written anywhere.
7. Independently of the chat stream, `useHistory` (Cycle 6 / FR-010) holds its own
   RLS-scoped read of the signed-in user's `items` plus a realtime subscription on
   `items` INSERT events — so a row inserted by step 5 above shows up in the history
   panel's "Rated"/"Want to Watch" tab live, with no manual refresh and no coupling
   between the chat code path and the history panel's own data path.

## Functional requirements → code map

| FR | Requirement | Where it lives |
|---|---|---|
| FR-001 | System prompt driving inline `<ADD>`/`<UPDATE>`/`<RECOMMEND>` emission, rating inference, conservative temperature, unrecognized-title clarification (mainstream titles must not misfire), action-integrity guard, want-to-watch variant, one tag per distinct opinion in a compound message | `src/lib/systemPrompt.ts` (`SYSTEM_PROMPT`, `buildExistingTitlesMessage`, `buildRecommendationContextMessage` — Cycle 6; Cycle 9/PRD v8 tightened the sentiment-only-still-tags, mainstream-title-recognition, and one-tag-per-opinion wording, imported by the edge function); `src/lib/openaiRequest.ts` (`OPENAI_TEMPERATURE = 0.2`, documented in-file); `src/features/chat/useChat.ts` (`historyForModel` dedup by message id + `cache: "no-store"` — Cycle 9, closing the stale-response defect); contract asserted by `src/lib/__tests__/systemPrompt.test.ts` and `openaiRequest.test.ts` |
| FR-002 | Token-by-token streaming; every distinct message gets a genuinely fresh streamed response (no stale/replayed output) | `netlify/edge-functions/chat.ts` (SSE passthrough, no buffering) + `src/lib/sseParser.ts` (incremental decode) + `src/features/chat/useChat.ts` (`reader.read()` loop updates React state per chunk; Cycle 9/PRD v8 added `cache: "no-store"` on the `fetch` and id-based dedup of `historyForModel` as defense-in-depth against a stale/cached response — no caching layer was actually found, see "Assumptions & decisions") |
| FR-003 | Generic, position-independent tag parser, no cap on tags per stream | `src/lib/tagParser.ts` — `TagRegistry`/`extractTags` engine is tag-agnostic and was already uncapped (extracts every match of every registered tag, not just the first per type); `createDefaultTagRegistry()` registers **three** definitions, `ADD_TAG_DEFINITION`, `UPDATE_TAG_DEFINITION`, and `RECOMMEND_TAG_DEFINITION` (Cycle 6 — finishing FR-008). `src/features/chat/useChat.ts` already dispatched every `<ADD>`/`<UPDATE>` match independently; Cycle 9/PRD v8 closed the real compound-message gap one layer up — the system prompt only asking for one tag per reply — plus added the whole-turn retry that detects a *partially*-tagged compound message (see FR-004) |
| FR-004 | Graceful failure (malformed/missing/ambiguous/off-topic, no silent failure) + silent-retry + unrecognized-title logging + missing-`<RECOMMEND>` logging + whole-turn retry for partially-tagged compound messages | `src/features/chat/useChat.ts` (`runAttempt`/retry loop, all branches; Cycle 9/PRD v8 added the `partial_multi` outcome and its whole-turn silent retry) + `src/lib/opinionHeuristic.ts` (missing-vs-ordinary-chat classifier, extended Cycle 6 for rewatch/changed-opinion phrasing and Cycle 9/PRD v8 for bare sentiment-only phrasing plus `countLikelyOpinions`/`identifyOpinionSegments`/`findUncapturedOpinionSegments` for compound-message detection) + `src/lib/recommendationHeuristic.ts` (Cycle 6, missing-`<RECOMMEND>` classifier, gated by `hasRatedItems`, no retry) + `src/lib/titleClarificationHeuristic.ts` (unrecognized-title classifier, unchanged this cycle — see "Assumptions & decisions") + `parse_failures` table (`reason` includes `unrecognized_title`, `supabase/migrations/005_...sql`) |
| FR-005 | Clean minimal chat UI with write confirmation + distinct "rating updated"/"want to watch" badges + `<RECOMMEND>` card | `src/features/chat/ChatPanel.tsx` (streaming caret via `MessageBubble`'s `streaming` prop, `Badge` footnote for confirmation/failure, `RecommendationCard` — Cycle 6) + `src/components/ui/` (`Badge` tones `update`/`watchlist`) + `src/components/layout/AppShell.tsx` |
| FR-006 | Email/password auth, persisted chat, per-user isolation | `src/context/AuthContext.tsx`, `src/features/auth/AuthScreen.tsx`, RLS policies in all `supabase/migrations/*.sql` files (unchanged this cycle; the new `items.status` column and realtime publication registration in `006_...sql` don't touch RLS — isolation is still `auth.uid() = user_id` throughout) |
| FR-007 | Netlify deployment + deliverables, incl. the edge-function build/deploy fix | `netlify.toml` (build command + SPA publish dir), `public/_redirects` (SPA fallback routing); the actual deploy, repo link, and written summary are produced by this pipeline's later (docs/deploy) step, not by app code. `netlify/edge-functions/chat.ts`'s `@supabase/supabase-js` import is a Deno-native `https://esm.sh/@supabase/supabase-js@2.110.3` ESM URL; locked in by `netlify/edge-functions/__tests__/chat.imports.test.ts` |
| FR-008 | Personalized, on-request `<RECOMMEND>` tag, grounded in rated (non-watchlist) items only | **Finished this cycle** (Cycle 6) — see "Assumptions & decisions" for why it had been carried forward unbuilt for three prior cycles. `src/lib/tagParser.ts` (`RECOMMEND_TAG_DEFINITION`, display-only), `src/lib/systemPrompt.ts` (`buildRecommendationContextMessage`, rated-only grounding + prompt rules), `netlify/edge-functions/chat.ts` (`fetchUserItemContext`), `src/features/chat/useChat.ts` (recommendation dispatch, no DB write), `src/features/chat/RecommendationCard.tsx` (distinct card) |
| FR-009 | `<UPDATE>` as a third inline tag type: model-side fuzzy re-mention matching, in-place update (since Cycle 8; originally insert-with-history in Cycles 4–7), distinct "rating updated" badge, want-to-watch → watched transition | `src/lib/systemPrompt.ts` (`buildExistingTitlesMessage` + ADD-vs-UPDATE prompt rules, now spans both statuses) + `netlify/edge-functions/chat.ts` (`fetchUserItemContext`, RLS-scoped per-request read of the caller's own titles) + `src/lib/tagParser.ts` (`UPDATE_TAG_DEFINITION`) + `src/features/chat/useChat.ts` (finds the caller's existing row for the title case-insensitively and updates `rating`/`status`/`raw_user_text` in place, always setting `status: "watched"`, falling back to an insert for a never-logged title; `tone="update"` footnote) + `supabase/migrations/008_items_true_update.sql` (`items_update_own` RLS policy + one-time dedupe) + `src/components/ui/Badge.tsx` (`"update"` tone) |
| FR-010 | Live history panel, "Rated"/"Want to Watch" tabs, realtime | `src/features/history/useHistory.ts` (RLS-scoped read + `supabase.channel(...)` realtime subscription on `items` INSERT), `src/features/history/HistoryPanel.tsx`/`.css` (presentational, `Tabs` primitive), `src/pages/Home.tsx` (wires `useHistory` into both `HistoryPanel` and `ChatPanel`'s `hasRatedItems`), `supabase/migrations/006_items_status_and_realtime.sql` (publication registration) |

## Test coverage as built

`vitest` + `@testing-library/react`, run via `npm test`:

- `src/lib/__tests__/tagParser.test.ts` — tag position independence (start/middle/end),
  malformed/missing-attribute handling, multi-tag-type registry extensibility,
  `UPDATE_TAG_DEFINITION` registration + identical malformed-handling to `<ADD>`, and
  (Cycle 6) the want-to-watch `<ADD>` variant (rating omitted, unrecognized `status`
  rejected) and `RECOMMEND_TAG_DEFINITION` (well-formed extraction, missing-`reason`
  malformed, distinct-from-`<ADD>` dispatch).
- `src/lib/__tests__/sseParser.test.ts` — SSE line buffering across chunk boundaries,
  `[DONE]` handling, malformed-line resilience.
- `src/lib/__tests__/systemPrompt.test.ts` — asserts the prompt contract the parser
  depends on (tag shape, rating scale documented, ADD-vs-UPDATE rules, unrecognized-title
  clarification instruction, and Cycle 6's want-to-watch variant, `<RECOMMEND>` rules,
  and action-integrity guard), `buildExistingTitlesMessage`, and (Cycle 6)
  `buildRecommendationContextMessage` (dedup, cap, null-when-empty, ignores unrated rows);
  (Cycle 9/PRD v8) asserts the prompt names all four previously-misrejected mainstream
  films, states recognition has "no external list you are being checked against", tells
  the model never to withhold a tag for sentiment-only phrasing, and instructs one tag
  per distinct opinion in a compound message.
- `src/lib/__tests__/openaiRequest.test.ts` — request body shape (`stream: true`, model,
  `temperature: 0.2`).
- `src/lib/__tests__/opinionHeuristic.test.ts` — opinion-signal classification cases,
  including (Cycle 6) rewatch/changed-opinion phrasing with no first-time sentiment word,
  and (Cycle 9/PRD v8) a "sentiment-only phrasing, no explicit number" describe block plus
  `splitOpinionSegments`/`countLikelyOpinions`/`findUncapturedOpinionSegments` coverage
  (single- vs. compound-opinion counting, identifying which segment's title was never
  tagged, treating everything as uncaptured when nothing matched).
- `src/lib/__tests__/watchlistHeuristic.test.ts` — (Cycle 7) missed want-to-watch-intent
  classification, so a tagless "I want to watch X" reply engages the same
  retry-then-log-`missing` safety net as a missed `<ADD>`/`<UPDATE>`.
- `src/lib/__tests__/recommendationHeuristic.test.ts` — (Cycle 6) recommendation-request
  classification cases.
- `src/lib/__tests__/titleClarificationHeuristic.test.ts` — recognizes the model's "don't
  recognize ... movie" clarification phrasing, rejects unrelated replies. Unchanged since
  Cycle 4; Cycle 9/PRD v8's title-recognition fix lives entirely in `systemPrompt.ts`'s
  wording (see "Assumptions & decisions"), not here.
- `src/styles/__tests__/theme.test.ts` — pins the `#A0B9BF` accent and its dark contrast
  color, and asserts no retired purple hex remains in `theme.css` (FR-005 regression
  guard).
- `src/context/__tests__/AuthContext.test.tsx`, `src/features/auth/__tests__/AuthScreen.test.tsx`
  — sign-up/sign-in error surfacing, the email-confirmation branch.
- `src/features/chat/__tests__/useChat.test.ts`, `ChatPanel.test.tsx` — history loading,
  sending, footnote rendering, the silent-retry loop (succeeds on a later attempt /
  exhausts all 3 / never retries a malformed or unrecognized-title reply), `<UPDATE>`
  in-place update dispatch (Cycle 8) and its distinct footnote, and (Cycle 6) the
  want-to-watch `<ADD>` dispatch (null rating, `watchlist` footnote), the want-to-watch
  → watched `<UPDATE>` transition, rewatch phrasing engaging the same retry-then-log
  safety net, and `<RECOMMEND>` dispatch (display-only, `hasRatedItems`-gated
  missing-recommendation logging). (Cycle 9/PRD v8) sentiment-only phrasing engaging the
  full 3-attempt retry (both the eventually-succeeds and the never-resolves cases,
  asserting the resulting `parse_failures` row), the compound-message whole-turn retry
  (partial-tag attempt discarded, full retry re-runs both opinions), the
  `partial_multi` fallback after all 3 attempts still miss an opinion (partial success
  kept, uncaptured opinion named in the footnote and logged), and the `historyForModel`
  de-dup-by-id + `cache: "no-store"` regression guards for the stale-response fix.
- `src/features/history/__tests__/useHistory.test.ts`, `HistoryPanel.test.tsx` — (Cycle 6)
  initial load split into rated/watchlist (uncollapsed — multiple rows per title stay
  separate), load-error handling, realtime INSERT events routed to the correct tab
  without a manual refresh, channel cleanup on unmount, and the presentational
  tab-switching/empty/loading/error states; (Cycle 8) realtime `UPDATE` events replacing
  an entry in place, including a watchlist → Rated move.
- `src/__tests__/App.test.tsx` — auth gating (no session → `AuthScreen`; session →
  `ChatPanel` + sign-out), and a non-crashing fallback when history load fails.
- `netlify/edge-functions/__tests__/chat.imports.test.ts` — (Cycle 5) static source-text
  assertions pinning the Deno-native `esm.sh` Supabase import and its version match with
  `package.json`.

All Supabase calls are exercised against `src/test/mockSupabase.ts`, a minimal fake of
the `.from(table).select/.eq/.order/.insert` surface plus (Cycle 6)
`.channel(...).on(...).subscribe()`/`removeChannel(...)`, and (Cycle 8)
`.update(...).eq(...)` call recording, `.ilike(...)`, a chainable `.order().limit()`,
per-table read rows, and per-event realtime handlers — no live Supabase project or
network access is required to run the suite. 177 tests pass as of this cycle.

## Assumptions & decisions

Judgment calls made across design → build → qa, consolidated here for the client's
written-summary deliverable and for a reviewer who only reads this file:

- **Backend runtime: Netlify Edge Function, not "Supabase Edge Function."** FR-001 said
  "Supabase Edge Function or equivalent." This pipeline has no path to deploy Supabase
  Functions, and the client explicitly rejected Lovable in favor of a Netlify
  deployment, so the OpenAI proxy is a Netlify Edge Function instead. It satisfies the
  same requirement — the OpenAI key stays server-side and the response streams through
  unbuffered — via the deployment target the client actually asked for.
- **Model: `gpt-4o-mini`.** The PRD left the specific OpenAI model to dev-team
  discretion. Chosen for latency/cost given a 2–3-tester proof-of-concept with explicit
  no-rate-limiting requirement (`openaiRequest.ts`).
- **Rating scale: fixed 1–5 integer, LLM-inferred from wording intensity.** The client
  confirmed the *concept* (infer intensity from wording) but never a numeric scale; the
  interviewer's `loved=5/liked=3/hated=1` example was extended to a full 1–5 ladder
  (`systemPrompt.ts`) and enforced at three layers: the model's instructions, the
  frontend's `ADD_TAG_DEFINITION.validate` range check, and a Postgres check constraint.
  Documented as medium-confidence per the PRD's own assumption entry.
- **`items` metadata columns (`category`, `raw_user_text`, `created_at`).** The client
  only said "basic and good tracking metadata is preferred" and left the columns to the
  dev team; the interviewer-proposed set was adopted as-is, with `category` hardcoded to
  `"movies"` since no other category is exercised in this build.
- **"Missing tag" classification is a heuristic, not ground truth
  (`src/lib/opinionHeuristic.ts`).** FR-004 requires logging when the model *should* have
  tagged something but didn't, while not spamming `parse_failures` on every ordinary
  off-topic reply. There is no reliable way to know the model's intent from the client
  alone, so a small keyword heuristic on the *user's own message* approximates it: if the
  message reads like a clear opinion (matches an opinion-word list), a tag-less reply is
  logged as `reason: "missing"`; otherwise it's treated as normal conversation and
  nothing is logged. The word list is illustrative, not exhaustive — a genuine
  false-negative/false-positive tradeoff, not a bug.
- **Per-user isolation is enforced via Postgres RLS, not just UI filtering**, per the
  PRD's own note that this reflects a real (if only demo-scoped) privacy requirement
  rather than mere tidiness. Every table's policies check `auth.uid()` directly; a
  compromised or buggy frontend query still cannot leak another user's rows.
  `profiles`/`items`/`chat_messages`/`parse_failures` all reference `auth.users(id)`
  directly (see "Relationships" above) rather than indirecting through `profiles.id`.
- **No rate limiting / usage caps.** Explicitly out of scope per the client
  ("no needed limiting" — only 2–3 testers). The build does not throttle or queue
  requests; it does rely on `try/catch` around every network call so a burst of
  pressure-test messages produces fallback messages/logged failures rather than crashes,
  per FR-004's "hold up under pressure" bar.
- **No StealthCo branding.** Per `out_of_scope`; the UI is an unbranded neutral chat
  interface (see the design step's `DESIGN.md` for the full visual rationale).
- **Only `<ADD>` ships, but the parser is registry-based** (`TagRegistry` /
  `TagDefinition` in `tagParser.ts`) so a future `UPDATE`/`REMOVE` tag type is a new
  registration, not a rewrite of the extraction engine — this is the concrete answer to
  FR-003's "architecture proven flexible" requirement.

### Cycle 3 (PRD v4 — recolor re-affirmation)

- **v2 and v3 change_log entries had never actually been built before this cycle.**
  This cycle's work order frames the `#A0B9BF` recolor as an idempotent re-run of v2
  ("that change already shipped in v2 ... byte-identical to the v2 outcome"). That
  premise didn't hold: prior to this cycle, git history showed only a single
  design/build/qa/docs pass (PRD v1), and `src/styles/theme.css` still carried the
  original purple accent (`#4338ca`). Neither the v2 recolor nor the v3 `<RECOMMEND>`
  feature (FR-008) had been implemented. This was recorded as a soft, non-blocking
  finding (see `DESIGN.md`'s own Cycle 3 section and QA blocker
  `a197956b-710d-4acd-80d6-aae4da153668`) rather than treated as a hard stop, since
  FR-005's target color and scope were unambiguous enough to proceed.
- **This cycle's actual scope was recolor-only, per the touch-only-what's-required
  rule.** The work order's own `changes` array names only `FR-005`, and its summary
  states "no other FR is affected." So this cycle applied the `#A0B9BF` recolor
  (`src/styles/theme.css` — `--color-accent`, `--color-accent-hover`,
  `--color-accent-contrast`, `--color-accent-soft`; see `DESIGN.md` for the exact
  before/after values and the contrast-fix rationale) and left FR-008 unbuilt rather
  than opportunistically building a feature the work order didn't ask for this cycle.
  A dark `--color-accent-contrast` (`#16171b`, not white) was chosen deliberately:
  white-on-`#A0B9BF` measures ~2:1 (fails WCAG AA), dark-on-`#A0B9BF` measures ~8.7:1,
  and the PRD explicitly warns against "white-on-light-blue illegibility."
- **FR-008 (`<RECOMMEND>`) remains unimplemented and is documented here rather than
  silently dropped.** No `RECOMMEND` tag definition, system-prompt clause, or
  distinct-card UI exists in `src/` (confirmed by grep and code review across both the
  build and QA steps of this cycle). Building it was out of this cycle's scope per the
  work order's own framing, so it was not added opportunistically; a dev decision is
  needed on whether a future cycle should explicitly re-open FR-008 to actually ship it.
  This is flagged for the human dev, not silently absorbed into "done."
- **No purple remains anywhere in the shipped CSS.** Every component stylesheet
  references the accent via `var(--color-accent...)` rather than a hardcoded hex, so
  the four-token change in `theme.css` is a complete, single-source recolor; confirmed
  in this cycle's QA pass by grepping hex values out of the built `dist/assets/*.css`.
- **No schema, RLS, or app-behavior change this cycle**, consistent with the work
  order's own migration notes ("no data migration required... this is a re-run of the
  v2 recolor"). All production data (`profiles`, `items`, `chat_messages`,
  `parse_failures`) is untouched; no new migration file was added.

### Cycle 4 (PRD v5 — retry/temperature/title-recognition fixes + FR-009 `<UPDATE>`)

- **Temperature: `0.2`, the low end of the dev's illustrative 0.2–0.3 range, chosen and
  documented by the build agent as the work order required.** The dev explicitly
  declined to dictate an exact number ("just pick something conservative and document
  it"). `0.2` rather than `0` because this is still natural-language chat (greetings,
  clarifying questions, off-topic steering), not pure structured extraction where a
  fully deterministic setting would be more typical — see the in-file rationale in
  `src/lib/openaiRequest.ts`. This is a partial, probabilistic mitigation for Issue 1
  (negative/neutral opinions intermittently not logging), not a guarantee; the bounded
  retry loop below is the second, deterministic layer of the same fix.
- **Retry count: 2 additional attempts (3 total), silent-discard, per the dev's direct
  confirmation.** Implemented as a loop around the existing single-attempt streaming
  logic in `useChat.ts` (`runAttempt`), gated on the *same* `looksLikeLoggableOpinion`
  heuristic FR-004 already used to decide whether a tag-less reply counts as a
  compliance miss — a retry only fires when that heuristic says the user clearly meant
  to log something. A malformed tag (as opposed to no tag at all) is **not** retried:
  the PRD's Issue 1 language and the dev's framing are specifically about the model
  producing *no* tag, not about giving it another chance at a tag it already got
  visibly wrong; retrying a malformed tag would also risk masking a genuine, reviewable
  parser/prompt mismatch behind a silent extra call. This distinction is exercised by
  dedicated tests in `useChat.test.ts`.
- **Discarded attempts are invisible by design, including to `chat_messages`.** Only the
  kept (final) attempt's text is ever streamed to the UI or persisted — the two
  "wasted" attempts leave no trace anywhere, per the dev's explicit "silent-discard is
  fine." The brief extra latency while a retry runs (the model has to fully finish
  streaming before "no tag" can even be detected) was accepted by the dev as consistent
  with FR-002, since nothing is displayed incorrectly during that time — the bubble
  just shows the pending/streaming state a little longer.
- **Unrecognized-title detection is prompt-engineered, not a separate model call.** The
  system prompt requires the model to include the literal phrase "don't recognize"
  (or "do not recognize") together with the word "movie" whenever it declines to tag a
  title it doesn't believe is real, specifically so `titleClarificationHeuristic.ts` can
  reliably distinguish that case from ordinary ambiguous chat. This is a deliberately
  narrow, brittle-by-design contract (like `opinionHeuristic.ts`'s word list) — it
  depends on the model actually following the prompted phrasing, documented as a
  medium-confidence heuristic rather than a semantic classifier.
- **Title recognition is model-knowledge-only — no TMDb/external lookup**, per the PRD's
  own accepted limitation. This means obscure-but-real or very new titles may be
  incorrectly challenged, and confident-sounding fabrications for well-known franchises
  could occasionally slip through; this is a known, documented tradeoff for this cycle,
  not a defect to chase further without reopening scope for an external lookup.
- **`unrecognized_title` is logged to `parse_failures` even though it's not a failure.**
  The dev confirmed this directly ("still get logged ... reason: e.g.
  unrecognized_title"). Reusing the existing free-text `reason` column (widened via
  `005_parse_failures_unrecognized_title_reason.sql`, an additive `check` constraint
  change) rather than adding a new table/column, since this is visibility/analytics
  logging, not a new kind of entity.
- **`<UPDATE>` same-title matching is model-side (the dev's approach "a"), not a
  deterministic string/fuzzy-matcher in application code.** The edge function's only
  job is to hand the model the user's own existing titles (RLS-scoped read, same
  pattern as FR-008's server-side read); the model itself judges whether a new message
  re-mentions one of them (typos/case/phrasing) and picks `<ADD>` vs `<UPDATE>`
  accordingly. Consequence, called out in the PRD itself: this makes the match
  non-deterministic and not unit-testable as an algorithm — test coverage instead
  asserts the two dispatch *behaviors* (insert as new vs. insert-with-history) given a
  tag the parser already extracted, plus the prompt instructions that drive the
  model's judgment, not the judgment itself.
- **`<UPDATE>` always inserts a new row; it never overwrites or upserts.** This was the
  dev's explicit choice ("fuzzy and if there is none then add a new one and insert a
  new row and keep history") specifically to preserve full rating history per title.
  Consequence for every downstream reader of `items` (noted in the data model section
  above): a user's items may now contain multiple historical rows for the same title,
  and "the current rating" means the latest `created_at` row, not the only row.
- **No schema change for `<UPDATE>`** beyond the additive `parse_failures.reason`
  constraint widening above — `<UPDATE>` reuses the exact same `items` columns as
  `<ADD>`, confirmed by `supabase/migrations/002_items.sql` being untouched this cycle.
- **`<UPDATE>`'s "rating updated" confirmation is a fourth `Badge` tone (`"update"`),
  not a new component**, per the design step's own reasoning: `ChatPanel`'s footnote
  slot already renders any `FootnoteInfo.tone` generically, so adding the tone plus one
  new CSS rule (`--color-accent-soft` background, a newly-added `--color-accent-text`
  for legible text on that lighter fill) was sufficient to make it visually distinct
  from both the green `"success"` (`<ADD>`, "Saved") and red `"danger"` (fallback)
  tones, per FR-005's acceptance criteria.
- **FR-008 (`<RECOMMEND>`) remains unimplemented — carried forward a second cycle, not
  silently dropped.** This cycle's `change_log` entry scopes only FR-001/003/004/009;
  FR-008 is not among the amended/added FRs, so per the touch-only-what's-required rule
  it was left exactly as Cycle 3 left it. Confirmed by code review at both build and QA
  time: `createDefaultTagRegistry()` registers `ADD` and `UPDATE` only, no `RECOMMEND`
  tag definition or system-prompt clause exists anywhere in `src/`. A future cycle's
  work order should explicitly decide whether to reopen FR-008.
- **QA verified this cycle's behavioral changes against a scripted mock server, not a
  live OpenAI call** (no `OPENAI_API_KEY` available in the QA sandbox) — the retry
  count, discard behavior, `<UPDATE>` dispatch, malformed handling, and
  `unrecognized_title` logging were all exercised end-to-end against the real
  frontend/parser/Supabase code path with a scripted model response standing in for
  OpenAI's HTTP contract; the model's actual comparative rating inference and its
  live fuzzy-matching judgment are marked `not_verifiable` in `qa-evidence/report.json`
  for that reason, not because the code path was untested.

### Cycle 5 (PRD v6 — Netlify edge-function build/deploy fix, FR-007 only)

- **Root cause: a platform-support gap, not an app-logic bug.** The already-signed-off
  Cycle-4 code imported `@supabase/supabase-js` in `netlify/edge-functions/chat.ts` via
  an `npm:` specifier (`npm:@supabase/supabase-js@2.110.3`). Netlify's Deno-based edge
  bundler only experimentally supports `npm:` specifiers and failed to bundle it,
  breaking the deploy. This was confirmed (per the dev's own framing in this cycle's
  change conversation) to be "the platform changed under us," not a regression
  introduced by prior app-logic changes — no other code in the diff needed review.
- **Fix direction: swap the import target, don't change the function's shape.** Per the
  dev's explicit choice of option (a) over moving the function to a Node.js serverless
  function, `chat.ts` stays a Netlify Edge Function; only the one import line changed,
  from `npm:@supabase/supabase-js@2.110.3` to the Deno-native
  `https://esm.sh/@supabase/supabase-js@2.110.3`. esm.sh serves the same published npm
  package as a Deno-compatible ES module, so this is a build-target swap, not a
  dependency or behavior change.
- **Version pin: `2.110.3`, matching `package.json` exactly, to avoid an unreviewed
  dependency bump.** The migration notes and the dev's own instruction ("pinned to
  2.110.3 or nearest stable") ruled out an unpinned `@2` import; the pin is enforced by
  `netlify/edge-functions/__tests__/chat.imports.test.ts`, which reads both the source
  file and `package.json` and fails if the two versions ever drift apart.
- **No other import in the file needed the same treatment.** The interviewer's
  instruction was to flag any other `npm:`-specifier import in `chat.ts` for the same
  fix; the file's other two imports (`../../src/lib/openaiRequest.ts`,
  `../../src/lib/systemPrompt.ts`) are plain relative paths to Deno-free TypeScript
  modules and were already unaffected. Confirmed by
  `chat.imports.test.ts`'s "only the @supabase/supabase-js import was moved off npm"
  assertion, which counts the file's import lines and asserts exactly one `esm.sh`
  import and two `src/lib/` imports — no more, no less.
- **No file under `src/`, no schema, and no other part of `chat.ts` changed.** This
  cycle's `change_log` entry names FR-007 only ("no behavior, streaming shape, tag
  emission/parsing, or DB writes change"), so per the touch-only-what's-required rule
  the fix is scoped to the single import line plus its explanatory comment and the new
  regression test — confirmed by `git diff` against the prior cycle's commit showing
  exactly that. `npm run build` (`tsc --noEmit && vite build`) passes unchanged; the
  edge function itself is outside that compilation graph (Netlify's edge bundler builds
  it separately at deploy time), so `chat.imports.test.ts`'s static source-text
  assertions are what gives this fix unit-test coverage without a Deno runtime.
- **FR-008 (`<RECOMMEND>`) still remains unimplemented — carried forward a third
  cycle, not silently dropped and not opportunistically built here either.** This
  cycle's `change_log` entry scopes only FR-007; FR-008 is untouched. Confirmed again
  by code review: `createDefaultTagRegistry()` (`src/lib/tagParser.ts`) still registers
  `ADD` and `UPDATE` only. See "Cycle 3" and "Cycle 4" above — a future cycle's work
  order should explicitly decide whether to reopen FR-008.
- **Documentation-only nit, not corrected in code this cycle:** the new test file's and
  `chat.ts`'s own inline comments label this fix "Cycle 6," one ahead of this document's
  own Cycle-3-was-PRD-v4 / Cycle-4-was-PRD-v5 numbering (which makes this cycle
  "Cycle 5," matching PRD v6). The two numbering schemes describe the same change; this
  file's numbering is treated as authoritative for the client-facing written summary,
  and the off-by-one in the code comments is noted here rather than edited, since
  editing `chat.ts`'s comments falls outside this docs step's touch-only-what's-required
  scope and has no effect on behavior, tests, or the build.

### Cycle 6 (PRD v7 — `<UPDATE>`-claimed-but-not-written bug fix, want-to-watch, live history panel)

- **FR-008 (`<RECOMMEND>`) is finished in this cycle, not just amended.** This work
  order's `change_log` lists FR-008 as "amended" (recommendation grounding must now
  exclude want-to-watch rows), but code review at the start of this cycle confirmed —
  again — that `<RECOMMEND>` had never actually been built in any of Cycles 3-5 despite
  being carried forward as a documented gap each time (see "Cycle 3"/"Cycle 4"/"Cycle 5"
  above). An amendment to a feature's grounding logic is meaningless if the feature
  itself doesn't exist, so this cycle builds the whole tag (`RECOMMEND_TAG_DEFINITION` in
  `tagParser.ts`, the "Recommendations" system-prompt clause, `fetchUserItemContext`'s
  `recommendationMessage` in the edge function, display-only dispatch in `useChat.ts`,
  and the `RecommendationCard` component) with the want-to-watch exclusion designed in
  from the start, rather than shipping a no-op amendment to still-nonexistent code. This
  is a build-step judgment call, not a silent scope guess: FR-008 was explicitly named in
  this cycle's `change_log`, is a PRD `functional_requirements` entry with its own full
  acceptance criteria (`priority: "should"`), and the PRD's own touch-only-what's-required
  rule is about not opportunistically building *untouched* FRs — FR-008 was touched.
- **`<RECOMMEND>` tag shape**: `<RECOMMEND item="..." reason="..." />`, matching the PRD's
  `assumptions` entry for the shape (never confirmed by the dev beyond that assumption,
  medium confidence, carried over unchanged from the original v3 change).
- **Recommendation grounding is a second, separate server-side read result, not a filter
  applied late.** `fetchUserItemContext` (renamed from `fetchExistingTitlesMessage`) reads
  `items` once per request and builds two independent context messages: `titlesMessage`
  (every status, for `<ADD>`-vs-`<UPDATE>` matching — a want-to-watch title still counts
  as "already logged" so a later real opinion on it routes to `<UPDATE>`, not a fresh
  `<ADD>`) and `recommendationMessage` (status `"watched"` + non-null `rating` only, via
  `buildRecommendationContextMessage`). This directly satisfies both FR-009 (matching
  must include watchlist titles) and this cycle's FR-008 amendment (grounding must
  exclude them) from the same single read, rather than two separate queries.
- **`requiredAttrs` became a function, not just a list, in `tagParser.ts`.** The PRD
  requires a want-to-watch `<ADD>` to omit `rating` without being malformed, while a
  normal `<ADD>` must still treat a missing `rating` as malformed (a pre-existing, tested
  behavior). Rather than weakening `<ADD>`'s required-attributes check unconditionally
  (which would silently accept `<ADD item="X" />` with no status as "valid, rating null"
  — never asked for, and a real regression risk), `TagDefinition.requiredAttrs` can now
  be a function of the tag's own raw attributes; `<ADD>`'s function returns `["item"]`
  when `status="want_to_watch"` and `["item", "rating"]` otherwise. This keeps the
  pre-existing "missing required attribute(s): rating" malformed-reason text intact for
  every previously-tested case.
- **`<UPDATE>` always writes `status: "watched"`, never inherits a status from anywhere
  else.** An `<UPDATE>` is by definition a fresh, real opinion — including the
  want-to-watch → watched transition (FR-009) — so there is no case where an `<UPDATE>`
  insert should ever carry `status: "want_to_watch"`; this is hardcoded at the insert
  call site in `useChat.ts` rather than threaded through the tag's own attributes.
- **The opinion-heuristic extension is intentionally still a keyword/phrase list, not a
  semantic classifier** — same documented tradeoff as the original heuristic. The dev's
  reported bug (model says "I'll update your rating now" for a rewatch mention, nothing
  lands in the database) was root-caused to this heuristic simply not having rewatch/
  changed-opinion signals, not to a deeper architectural gap — the fix is additive
  patterns (`rewatch(ed/ing)`, `changed my mind`, `opinion ... changed`, `reconsidered`,
  `second viewing`, `actually loved/hated/...`) on the exact same list `<ADD>` misses
  already used, so the *combination* of a correctly-firing heuristic plus the
  pre-existing 3-attempt retry-then-fallback loop (Cycle 4) is the actual fix — no new
  retry/fallback mechanism was needed, just closing the detection gap that kept it from
  engaging.
- **The action-integrity guard is a system-prompt instruction, not a code-level
  enforcement mechanism.** There is no reliable way for the frontend to verify "does this
  prose sentence assert an action" against "was a tag actually emitted" as a general
  semantic check — that would require its own classifier with its own false-positive/
  negative tradeoffs. Per the PRD's own framing ("jointly with FR-001/FR-004"), the real
  fix is two-layered: (1) explicitly instruct the model never to claim an action without
  the matching tag, and (2) make sure the opinion-heuristic reliably detects the phrasing
  that should have produced a tag, so the existing retry-then-fallback safety net catches
  a miss regardless of what the prose claims. Together these close the specific reported
  defect (claim without a tag going completely unlogged) without inventing a new
  prose-vs-tag consistency checker.
- **`items.status`/`rating` nullability: additive migration, verified against the current
  schema before writing it**, per the work order's explicit instruction to inspect
  `rating`'s current constraint rather than assume. `002_items.sql` had `rating numeric
  not null check (...)`; `006_items_status_and_realtime.sql` only drops the `not null`
  (the existing range check already tolerated `NULL`) and adds `status text not null
  default 'watched'` plus its own check constraint — no table/column drop, no rename, no
  destructive `UPDATE`/`DELETE` anywhere in the file. Applied via `apply_client_migration`
  and confirmed successful before any application code was written against it.
- **Realtime is publication-based, not a bespoke websocket.** `items` is added to the
  `supabase_realtime` publication (guarded by a `pg_publication_tables` existence check
  so re-running the migration file would be a no-op rather than an error) so
  `supabase-js`'s standard `channel(...).on("postgres_changes", ...)` API works
  unmodified — no custom server-side push mechanism was built. RLS is what actually
  scopes what a subscriber receives; the subscription's own `user_id=eq.<userId>` filter
  is redundant-but-harmless defense in depth, matching every other per-user query in this
  app.
- **`hasRatedItems` is threaded from `useHistory` into `useChat`/`ChatPanel` as a plain
  boolean prop, not re-derived independently.** Both features need to know "does this
  user have at least one rated item" — `useHistory` already computes exactly that as
  `ratedItems.length > 0` for FR-010, so `Home.tsx` passes it straight through rather than
  having `useChat` run its own duplicate query. Consequence: the missing-`<RECOMMEND>`
  classification is one render behind the absolute latest state in a pathological
  race (rating something in the same instant as asking for a recommendation), which was
  judged an acceptable tradeoff for a 2-3-tester proof-of-concept rather than justifying a
  second live query.
- **Recommendation card is a new small component (`RecommendationCard.tsx`), not another
  `Badge` tone**, per the design step's own framing of FR-008/FR-005 as needing "a card or
  badge" — a card because a recommendation carries a reason worth reading in full, not
  just a short label like the existing footnote pills. It reuses the existing
  `--color-accent`/`--color-accent-soft`/`--color-accent-text` tokens (the same ones the
  `"update"` badge tone uses) rather than inventing new color tokens, so it reads as
  "part of the same accent family" while still being visually distinct in *shape* (a
  bordered block under the bubble, not an inline pill) from every footnote badge.
- **`ChatPanel.tsx`'s per-message JSX gained one wrapping `<div className="chat-panel__turn">`**
  around each `MessageBubble` (+ its optional `RecommendationCard`), because
  `MessageBubble` itself was the direct flex child that `align-self` alignment depended
  on — wrapping it without replicating that alignment on the new wrapper would have
  broken user/assistant bubble alignment. `chat-panel__turn--user`/`--assistant` in
  `ChatPanel.css` replicate the exact alignment `MessageBubble`'s own `.ui-message--*`
  rules already provided, so this is a structural, non-visual change verified by the
  pre-existing "write-confirmation badge" ChatPanel test still passing unmodified.
- **One pre-existing test assertion was widened, not weakened.**
  `tagParser.test.ts`'s very first case asserted `matches[0].attrs).toEqual({ item,
  rating })` with no other keys; since `<ADD>` now always parses an explicit `status`
  field (defaulting to `"watched"`), that exact-equality assertion now includes
  `status: "watched"`. This is a necessary consequence of FR-003's own amendment (parse
  an optional `status` attribute), not a masked regression — every other pre-existing
  assertion in the file (and the rest of the suite) was left untouched and still passes.
- **`App.test.tsx`'s history-load-failure test was made table-aware instead of
  order-dependent.** Before this cycle, `Home` mounted exactly one `.from(...)` consumer
  on mount (`useChat`'s chat-history load), so overriding "the first `.from()` call"
  with `mockImplementationOnce` was an unambiguous way to simulate a failure. `Home` now
  also mounts `useHistory` (a second, independent `.from("items")` consumer), and this
  app doesn't guarantee — nor should a test assume — which of two sibling/parent effects
  commits first. The test now keys its error builder off the table name
  (`chat_messages` only) so it deterministically exercises the same "chat history failed
  to load" path regardless of effect-firing order, rather than becoming flaky or
  silently testing the wrong failure mode.
- **No changes to `AuthScreen`, `AuthContext`, `profiles`/`chat_messages` schema, the
  recolor, or any FR-002/FR-006/FR-007 behavior** — confirmed by diff review; this
  cycle's `change_log` doesn't touch any of them and none needed to change to support
  the additions above.

### Cycle 7 (live-site incident — self-reinforcing history poisoning, missed-watchlist visibility, title-insistence)

This cycle was driven by a production bug report ("the watchlist did not save and none
of the updated ones are saving") rather than a PRD work order. Root cause, reproduced
against the live site by replaying the affected user's exact persisted history through
`/api/chat`:

- **The app was poisoning its own model context.** Assistant replies are persisted with
  their tags stripped (correct for display), but that same cleaned text was also what
  `useChat` sent back to the model as conversation history. After one stochastic
  compliance miss (a prose claim like "I'll update your rating for that movie now." with
  no tag — which the Cycle 6 action-integrity guard reduces but cannot eliminate), the
  persisted tag-less claim becomes few-shot evidence that tags are optional, and the
  model reliably stops emitting them for the remainder of that conversation. A clean
  context tagged correctly in every probe; the poisoned history failed in every probe.
  The 3-attempt retry loop cannot help, because every retry replays the same poisoned
  history.
- **Fix: the model now sees its own past turns raw.** `chat_messages.raw_content`
  (`007_chat_messages_raw_content.sql`, additive-only) stores the model-visible form of
  each assistant turn. `historyForModel` sends `raw_content` for assistant turns and
  drops any assistant turn without one — compliance misses, malformed-tag turns (whose
  broken syntax must not be taught back), and all legacy rows, which instantly detoxes
  every conversation poisoned before the fix shipped. Display behavior is unchanged
  (`content` remains cleaned); a dropped assistant turn just leaves its user turn
  standing alone in model history, which probing showed is harmless.
- **Missed want-to-watch adds were completely invisible.** "I want to watch Toy Story"
  answered with a tag-less prose claim produced no retry, no `parse_failures` row, and
  no footnote: neither the opinion nor the recommendation heuristic fires on a watch
  intent, so `missKind` stayed null and the miss was indistinguishable from chit-chat.
  `watchlistHeuristic.ts` closes the gap — a clear watch intent now gets the same
  2-retry-then-log-`missing` discipline as a missed `<ADD>`/`<UPDATE>`, plus its own
  neutral "Didn't catch a watchlist add there." footnote, and (like every compliance
  miss) persists with `raw_content = NULL`.
- **Prompt hardening, two clauses.** The action-integrity guard now states that history
  is not a formatting example (defense in depth for any tag-less turn that still slips
  into context), and the unrecognized-title rule now tells the model to accept a title
  the user insists is real or supports with detail (actor/director/year) after one
  clarifying question — on the live site it refused "Norbit" (a real 2007 film) twice,
  even after the user named the lead actor.
- **Everything else untouched** — no changes to the edge function, `items` schema, RLS,
  tag parser, or any FR-002/FR-006/FR-007/FR-008 behavior; `parse_failures.reason`
  reuses `missing` for watchlist misses rather than widening the check constraint.

### Cycle 8 (dev-directed: `<UPDATE>` is a true in-place update)

Requested by the dev after verifying the Cycle 7 fixes live: "I want the update to be a
true update rather than a new log" (their Rated tab showed two "Norbit" rows after a
re-rating). This deliberately reverses Cycle 4's insert-per-`<UPDATE>` / full-rating-
history design.

- **Write path** (`useChat.ts`): an `<UPDATE>` match now looks up the user's most recent
  `items` row for that title (exact reference-list spelling via case-insensitive match,
  ilike wildcards escaped) and updates `rating`, `status` (always to `"watched"` — this
  also makes the want-to-watch → watched transition an in-place flip of the same row),
  and `raw_user_text`. If no row exists — the model claimed an update for a never-logged
  title — it falls back to the old insert so the rating is never dropped.
- **RLS**: `items` had select/insert/delete policies but no UPDATE policy (the client
  never updated before), so `008_items_true_update.sql` adds `items_update_own`;
  without it the new code would silently match zero rows.
- **One-time dedupe** in the same migration: keep the newest row per
  `(user_id, category, lower(item))`, delete older duplicates produced by the old
  behavior. Verified against production immediately before applying: exactly one row
  (the older "Norbit") was removed.
- **Live history panel** (`useHistory.ts`): the realtime subscription now also listens
  for `UPDATE` events (channel renamed `items-changes-<userId>`) and replaces the
  matching entry in place — including moving a want-to-watch entry to the Rated tab
  when its row's status flips. The `supabase_realtime` publication already carried
  UPDATE events for `items`; only the client handler was missing.
- **No DB unique index** on the title triple: `<ADD>`-vs-`<UPDATE>` routing remains the
  model's job via the titles reference list, and a rare duplicate `<ADD>` (e.g. a
  session without an access token) is preferable to a hard constraint violation
  surfacing mid-chat as a failed save.
- **Test infrastructure**: `mockSupabase.ts` gained `update(...).eq(...)` recording
  (`updateCalls`), `ilike`, a chainable `order().limit()`, per-table read rows
  (`rowsForTable`), and per-event realtime handlers so INSERT and UPDATE registrations
  don't clobber each other.

### Cycle 9 (PRD v8 — sentiment-only logging, title-recognition over-correction, compound multi-opinion messages, stale-response bug)

**A numbering note first, since it looks like an off-by-two.** This file's own numbering
is `Cycle N = PRD v(N+1)` through Cycle 6 (PRD v7). Cycles 7 and 8 above broke that
pattern: they were live-site incident fixes, made and self-documented directly in this
file by the commits that shipped them (`a8c32c3`, `f68cfdf`), without a docs-step pass
and without reference to the PRD-version numbering — they simply picked the next free
number after "Cycle 6." This work order is PRD v8, which under the original pattern
would be "Cycle 7" (and is labeled that way in `DESIGN.md`, written independently by
this cycle's design step), but that number is already taken in *this* file for an
unrelated change. Rather than have two different "Cycle 7" sections mean two different
things in the same document, this entry is filed as **Cycle 9** — the next number in
this file's actual sequence — with this note so a reader isn't left wondering why the
count jumped. `README.md`'s "Current status" section cross-references this same Cycle 9
label.

This work order (`change_log` v8) amends FR-001/FR-002/FR-003/FR-004 only, fixing four
correctness defects found in live pressure testing. No schema change; no migration.

- **Sentiment-only phrasing ("I hated Barbie") previously produced no `parse_failures`
  row at all — confirmed a heuristic gap, not a model-compliance problem.** The dev's
  own diagnosis (`change_request_id fdd2478b`, question 1: "no parse_failures row at
  all") ruled out the alternative explanation (the model refusing to tag even under
  retry) before any code was touched: if the retry loop had engaged and still failed,
  a `reason: "missing"` row would exist regardless. Its absence means
  `looksLikeLoggableOpinion` never recognized the message as an opinion in the first
  place, so the 2-retry safety net (Cycle 4) never got a chance to run. The fix is
  additive patterns in `opinionHeuristic.ts`'s existing keyword-list approach — the same
  documented, brittle-by-design tradeoff as every previous heuristic extension here —
  plus a systemPrompt.ts clause telling the model explicitly not to withhold a tag for
  lack of an explicit number. QA's mock-server evidence shows the full 3-attempt loop
  now engaging for this phrasing class in both directions: eventually succeeding
  (`FR-004-1-sentiment-only-retry-success.png`) and genuinely exhausting all 3 attempts
  into a real `parse_failures` row (`FR-004-2-sentiment-only-never-resolves.png`) —
  closing the "silent, invisible" failure mode specifically, not just improving the
  model's hit rate.
- **The mainstream-title-rejection defect had no local gate to remove — the PRD's own
  candidate root cause didn't hold up under inspection.** The dev was unsure whether
  `src/lib/titleClarificationHeuristic.ts` contained a hardcoded allowlist/pattern
  overriding model judgment (`change_request_id fdd2478b`, question 2: "not sure...").
  `git diff f68cfdf..3dc0b8a -- src/lib/titleClarificationHeuristic.ts` shows the file
  untouched this cycle, and its full contents (unchanged since Cycle 4) only ever
  pattern-match the *model's own reply* for the "don't recognize ... movie" phrasing —
  there is not, and never was, a client/edge-side list of movie titles anywhere in this
  codebase. The actual defect was in the *prompt's wording*: `systemPrompt.ts`'s
  original instruction ("if you do not recognize it... do NOT emit") gave the model no
  guidance on which way to err, and it drifted toward over-caution on real films. The
  fix names the four reported false-negatives (`The Big Short`, `A Star Is Born`,
  `American History X`, `The Departed`) as must-recognize examples and adds "there is no
  external list you are being checked against... err on the side of recognizing a
  title," while keeping the fabricated-title path intact (`Point Break 2` still
  triggers clarification, confirmed in QA). This stays within the existing
  model-knowledge-only, no-TMDb boundary — it is a prompt-bias correction, not a new
  verification mechanism, so obscure-but-real titles remain an accepted known
  limitation.
- **The compound-message defect's real bottleneck was the system prompt and the
  retry/heuristic layer, not the parser or the dispatcher — both of which were already
  correct.** Both the design and build steps independently confirmed
  `tagParser.ts`'s `extractTags` was never capped to one match per tag type, and
  `useChat.ts` already looped over every `<ADD>`/`<UPDATE>` match and merged their
  confirmations into one footnote (`parts.length > 1` branch, present since at least
  Cycle 6, previously exercised defensively even though the prompt never asked for more
  than one tag). So "no hardcoded cap" (the dev's confirmed direction) required no
  parser or dispatch change at all — the system prompt's "emit at most one of `<ADD>`
  or `<UPDATE>` per reply" instruction was the actual cap, and removing it is FR-003's
  entire code change. The harder half of this defect was FR-004: detecting when a
  compound reply *silently* under-delivers (tags some but not all opinions) requires
  reasoning about the user's own message, which is new logic —
  `opinionHeuristic.ts`'s `countLikelyOpinions`/`findUncapturedOpinionSegments` (a
  deliberately mechanical clause-splitter on commas/semicolons/"but"/"although"/
  "though"/"while"/"whereas" — not a real parser, just enough for the PRD's own
  compound examples) feeding a new `partial_multi` outcome in `useChat.ts`'s retry loop.
- **Whole-turn retry, not per-tag retry, for a partially-tagged compound message — per
  the dev's confirmed direction** (`change_request_id fdd2478b`, question 1: "existing
  2-retry loop to re-run the whole turn"). A partially-successful attempt is discarded
  in full and the entire turn re-sent, exactly like a fully-missing tag (Cycle 4); this
  reuses `MAX_ATTEMPTS` and the existing discard/no-partial-credit-per-attempt
  semantics rather than inventing a second retry mechanism. The `isCompound` gate
  (`countLikelyOpinions(trimmed) >= 2`) specifically prevents a single opinion phrased
  across a comma or "but" (e.g. "I finally watched Dune, loved it") from being
  misclassified as partial — that message counts as exactly one opinion, so the new
  code path never engages and single-opinion dispatch is provably unchanged (QA
  confirmed the pre-existing single-opinion scenarios still pass unmodified).
- **After all 3 whole-turn attempts, partial success is kept — never discarded for a
  sibling opinion's failure — and every uncaptured opinion is named, per FR-004's "no
  silent drops."** `partial_multi` is dispatched through the exact same insert path as
  `success`; the opinions that DID tag are written and confirmed normally. The ones that
  didn't produce a `parse_failures` row (`reason: "missing"`, consistent with every
  other retry-exhausted case) and a footnote naming them verbatim
  (`Didn't catch: "hated Aftersun"`), best-effort matched via
  `findUncapturedOpinionSegments`'s "does the tagged title's text appear in this
  segment" heuristic — approximate by design, since knowing which segment maps to
  which tag is otherwise the model's job, not the client's.
- **The stale-response bug's root cause was audited, not assumed, and no caching layer
  was found** — the PRD itself left the root cause open ("stale closure, cached
  promise, or chat-history mis-assembly... left to the build agent to locate"). The
  build step traced the full request path (`useChat.ts` → `fetch` → edge function →
  OpenAI) and found no service worker, no HTTP client with its own cache, and no
  `Cache-Control` response header that would make a stale revalidation possible. Two
  hardening changes were made anyway as defense-in-depth against the *class* of bug the
  PRD named, even without a smoking gun: `fetch(..., { cache: "no-store" })` rules out
  the browser HTTP cache categorically, and `historyForModel` now filters out any
  message already present in `messagesRef.current` by id before appending the current
  turn's user message, rather than assuming it's always still absent — a distinct,
  latent "send this turn's message twice" risk the audit surfaced along the way (not
  itself the confirmed repro, but in the same family and cheap to close). QA reproduced
  the exact confirmed repro (`Obsession (2026)`/backrooms clarification, then an
  unrelated "Wolfs was just ok") against a scripted mock server and confirmed turn 2
  gets its own fresh fetch and its own distinct, correctly-tagged reply — not the prior
  turn's text.
- **No change to `tagParser.ts`, `sseParser.ts`, `titleClarificationHeuristic.ts`,
  `recommendationHeuristic.ts`, `watchlistHeuristic.ts`, the edge function, any
  migration, RLS policy, or CSS/theme file this cycle** — confirmed by `git show --stat`
  against `3dc0b8a`, which touches exactly `useChat.ts`, `opinionHeuristic.ts`,
  `systemPrompt.ts`, and their tests. FR-005/FR-008/FR-009/FR-010 are named in the PRD's
  own migration notes only as regression smoke-tests sharing the touched code path, not
  as amended FRs, and QA's pass confirms none of them regressed (multiple tags in one
  turn render as one merged footnote without crashing or dropping information, per the
  existing Cycle 9 FR-003 finding above).
- **QA verified this cycle's behavioral changes against a scripted mock server, not a
  live OpenAI call** (no `OPENAI_API_KEY` in the QA sandbox, consistent with every prior
  cycle) — the sentiment-only retry engagement, the mainstream-title prompt wording, the
  compound one-shot and whole-turn-retry dispatch, the partial-after-3-attempts
  fallback, and the stale-response regression guard were all exercised end-to-end
  against the real frontend/parser/Supabase code path with scripted model responses
  standing in for OpenAI's HTTP contract; the model's actual live compliance with the
  new prompt wording is marked `not_verifiable` in `qa-evidence/report.json` for the
  handful of criteria that can only be confirmed against a live OpenAI call (e.g. "the
  function calls the OpenAI API and does not use a hardcoded/mock response"), not
  because the code path itself was untested.
