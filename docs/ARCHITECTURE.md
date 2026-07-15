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
  │  reads caller's own logged titles (RLS-scoped, via accessToken — Cycle 4/FR-009),
  │  injects SYSTEM_PROMPT (+ that titles list) + OPENAI_API_KEY, streams request through
  ▼
OpenAI chat-completions API (stream: true, temperature 0.2)
  │  SSE deltas flow back through the edge function unmodified
  ▼
Browser: OpenAIStreamDecoder → extractTags() → React state (token-by-token render)
  │  on successful <ADD>/<UPDATE> tag / on malformed / on unrecognized-title / on failure
  ▼
Supabase (Postgres, RLS) — items / chat_messages / parse_failures / profiles
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
One row per successfully-parsed `<ADD>` **or `<UPDATE>`** tag (Cycle 4 / FR-009). Written
by `useChat.sendMessage` after a stream finishes and `extractTags` returns at least one
match — `<UPDATE>` uses the exact same `insert` call as `<ADD>`, never an `update`/`upsert`,
so re-mentioning a title deliberately produces a **second, later-`created_at` row** for
that `(user_id, item)` pair rather than overwriting the first. A user's `items` rows are
therefore no longer guaranteed one-per-title: **the "current" rating for a title is the
latest `created_at` row for that title**, and any downstream reader (e.g. FR-008's
recommendation grounding, if it's ever built) must not assume uniqueness.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | `gen_random_uuid()` default |
| `user_id` | uuid | FK → `auth.users`, isolation key |
| `item` | text | Movie title — verbatim from the tag's `item` attribute for `<ADD>`, or the reference-list spelling the model was given for `<UPDATE>` (see systemPrompt.ts) |
| `rating` | numeric | **LLM-estimated**, 1–5 integer scale, see "Rating scale" below — never a value the user typed directly |
| `category` | text | Hardcoded `"movies"` at the call site (`useChat.ts`); column exists for forward-compatibility, no other category is exercised |
| `raw_user_text` | text | The triggering user message, kept as tracking metadata |
| `created_at` | timestamptz | default `now()` |

Constraint: `rating between 1 and 5` enforced in Postgres (`002_items.sql`), matching the
scale the system prompt instructs the model to use — a belt-and-suspenders check in case
a future prompt change or model drift ever produced an out-of-range value (the frontend's
`ADD_TAG_DEFINITION.validate` in `tagParser.ts`, reused unchanged as `UPDATE_TAG_DEFINITION.validate`,
already rejects those before they'd reach Supabase, but the DB constraint holds regardless
of client behavior). No schema change was needed for `<UPDATE>` — same table, same columns,
same constraint, purely additive.

### `chat_messages`
One row per turn (`role: 'user' | 'assistant'`), written by `useChat.ts` right after the
user's message is accepted and again once the assistant's stream finishes. This is what
makes chat history persist across logout/login (FR-006) — `useChat`'s history-load effect
reads this table filtered to the signed-in user on mount.

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
   then `fetch("/api/chat", { messages: history, accessToken })`. `accessToken` (Cycle 4
   / FR-009) is the caller's own Supabase session token, forwarded so the edge function
   can read *their own* previously-logged titles — it is never persisted or used for
   anything besides that one RLS-scoped read.
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
   below) to decide what actually happened:
   - one or more valid `<ADD>`/`<UPDATE>` matches → insert into `items` (both tags
     insert; `<UPDATE>` never overwrites), footnote `Saved · <name>` for `<ADD>` or
     `Rating updated · <name>` (`tone="update"`) for `<UPDATE>`;
   - a recognized-but-malformed `<ADD>` or `<UPDATE>` tag → log to `parse_failures`
     (`reason: "malformed"`), footnote `Couldn't log that — logged for review.`;
   - no tag, but the reply reads like the model's unrecognized-title clarification
     (`looksLikeUnrecognizedTitleClarification`, `titleClarificationHeuristic.ts` —
     Cycle 4 / FR-001 Issue 2) → **not retried**, logged to `parse_failures`
     (`reason: "unrecognized_title"`), shown as an ordinary conversational reply with
     no footnote (expected behavior, not a failure);
   - no tag, and `looksLikeLoggableOpinion(userText)` (`opinionHeuristic.ts`) is true →
     **Cycle 4 / FR-004 Issue 1 retry loop**: silently re-run this whole attempt (steps
     2–5) up to 2 more times (3 attempts total), discarding every failed attempt's
     streamed text entirely — the user only ever sees the *last* attempt's output. If
     an attempt in the loop finally produces a tag, it's handled by the branches above
     as normal. If all 3 attempts produce no tag, log `reason: "missing"` once, neutral
     footnote;
   - no tag and the user's message didn't look like an opinion → ordinary conversation,
     nothing logged, no footnote, no retry;
   - empty final text, non-OK HTTP response, or any thrown exception anywhere in the
     above → `reason: "other"`, danger-toned fallback message, **never** an unhandled
     exception surfaced to the user (all paths are wrapped in `try/catch` inside
     `useChat.sendMessage`).
6. The assistant's final displayed text (tag stripped) is persisted to `chat_messages`
   regardless of which branch above fired — only the surviving, kept attempt's text is
   ever persisted; discarded retry attempts are never written anywhere.

## Functional requirements → code map

| FR | Requirement | Where it lives |
|---|---|---|
| FR-001 | System prompt driving inline `<ADD>`/`<UPDATE>` emission, rating inference, conservative temperature, unrecognized-title clarification | `src/lib/systemPrompt.ts` (`SYSTEM_PROMPT`, `buildExistingTitlesMessage`, imported by the edge function); `src/lib/openaiRequest.ts` (`OPENAI_TEMPERATURE = 0.2`, documented in-file — Cycle 4 / Issue 1); contract asserted by `src/lib/__tests__/systemPrompt.test.ts` and `openaiRequest.test.ts` |
| FR-002 | Token-by-token streaming | `netlify/edge-functions/chat.ts` (SSE passthrough, no buffering) + `src/lib/sseParser.ts` (incremental decode) + `src/features/chat/useChat.ts` (`reader.read()` loop updates React state per chunk) — unchanged this cycle apart from the retry loop wrapping the same per-chunk logic |
| FR-003 | Generic, position-independent tag parser | `src/lib/tagParser.ts` — `TagRegistry`/`extractTags` engine is tag-agnostic; `createDefaultTagRegistry()` registers **two** definitions, `ADD_TAG_DEFINITION` and `UPDATE_TAG_DEFINITION` (Cycle 4 / FR-009 — same `validateItemRatingAttrs`, different dispatch in `useChat.ts`); see file header for how `RECOMMEND`/`REMOVE` would be added without touching `extractTags` |
| FR-004 | Graceful failure (malformed/missing/ambiguous/off-topic, no silent failure) + Cycle 4 silent-retry + unrecognized-title logging | `src/features/chat/useChat.ts` (`runAttempt`/retry loop, all branches) + `src/lib/opinionHeuristic.ts` (missing-vs-ordinary-chat classifier) + `src/lib/titleClarificationHeuristic.ts` (unrecognized-title classifier, Cycle 4) + `parse_failures` table (`reason` now includes `unrecognized_title`, `supabase/migrations/005_...sql`) |
| FR-005 | Clean minimal chat UI with write confirmation + distinct "rating updated" badge | `src/features/chat/ChatPanel.tsx` (streaming caret via `MessageBubble`'s `streaming` prop, `Badge` footnote for confirmation/failure) + `src/components/ui/` (`Badge` gains `tone="update"`, Cycle 4 / FR-009 — distinct accent-soft styling from `success`/`danger`/`neutral`) + `src/components/layout/AppShell.tsx` |
| FR-006 | Email/password auth, persisted chat, per-user isolation | `src/context/AuthContext.tsx`, `src/features/auth/AuthScreen.tsx`, RLS policies in all `supabase/migrations/*.sql` files (unchanged this cycle; the Cycle-4 `<UPDATE>` insert and titles-read both reuse existing `items` RLS policies, no new policy needed) |
| FR-007 | Netlify deployment + deliverables, incl. Cycle 5's edge-function build/deploy fix | `netlify.toml` (build command + SPA publish dir), `public/_redirects` (SPA fallback routing); the actual deploy, repo link, and written summary are produced by this pipeline's later (docs/deploy) step, not by app code. Cycle 5: `netlify/edge-functions/chat.ts`'s `@supabase/supabase-js` import moved from an `npm:` specifier to a Deno-native `https://esm.sh/@supabase/supabase-js@2.110.3` ESM URL to unblock Netlify's edge bundler; locked in by `netlify/edge-functions/__tests__/chat.imports.test.ts` |
| FR-008 | Personalized, on-request `<RECOMMEND>` tag | **Still not implemented.** `createDefaultTagRegistry()` (`src/lib/tagParser.ts`) registers `ADD_TAG_DEFINITION` and `UPDATE_TAG_DEFINITION` only; there is no `RECOMMEND` tag definition, no system-prompt clause conditioning its emission, and no distinct-card rendering anywhere in `src/`. This cycle's change_log scopes only FR-001/003/004/009, so per the touch-only-what's-required rule this pre-existing (Cycle 3) gap was carried forward rather than opportunistically built. See "Assumptions & decisions → Cycle 3" and "→ Cycle 4" below. |
| FR-009 | `<UPDATE>` as a third inline tag type: model-side fuzzy re-mention matching, insert-with-history, distinct "rating updated" badge | `src/lib/systemPrompt.ts` (`buildExistingTitlesMessage` + ADD-vs-UPDATE prompt rules) + `netlify/edge-functions/chat.ts` (`fetchExistingTitlesMessage`, RLS-scoped per-request read of the caller's own titles) + `src/lib/tagParser.ts` (`UPDATE_TAG_DEFINITION`) + `src/features/chat/useChat.ts` (insert dispatch + `tone="update"` footnote) + `src/components/ui/Badge.tsx` (`"update"` tone) |

## Test coverage as built

`vitest` + `@testing-library/react`, run via `npm test`:

- `src/lib/__tests__/tagParser.test.ts` — tag position independence (start/middle/end),
  malformed/missing-attribute handling, multi-tag-type registry extensibility, and
  (Cycle 4) `UPDATE_TAG_DEFINITION` registration + identical malformed-handling to `<ADD>`.
- `src/lib/__tests__/sseParser.test.ts` — SSE line buffering across chunk boundaries,
  `[DONE]` handling, malformed-line resilience.
- `src/lib/__tests__/systemPrompt.test.ts` — asserts the prompt contract the parser
  depends on (tag shape, rating scale documented, ADD-vs-UPDATE rules, unrecognized-title
  clarification instruction) and `buildExistingTitlesMessage` (dedup, cap, null-when-empty).
- `src/lib/__tests__/openaiRequest.test.ts` — request body shape (`stream: true`, model,
  and Cycle 4's `temperature: 0.2`).
- `src/lib/__tests__/opinionHeuristic.test.ts` — opinion-signal classification cases.
- `src/lib/__tests__/titleClarificationHeuristic.test.ts` — (Cycle 4) recognizes the
  model's "don't recognize ... movie" clarification phrasing, rejects unrelated replies.
- `src/context/__tests__/AuthContext.test.tsx`, `src/features/auth/__tests__/AuthScreen.test.tsx`
  — sign-up/sign-in error surfacing, the email-confirmation branch.
- `src/features/chat/__tests__/useChat.test.ts`, `ChatPanel.test.tsx` — history loading,
  sending, footnote rendering, and (Cycle 4) the silent-retry loop (succeeds on a later
  attempt / exhausts all 3 / never retries a malformed or unrecognized-title reply),
  `<UPDATE>` insert-not-overwrite dispatch and its distinct footnote.
- `src/__tests__/App.test.tsx` — auth gating (no session → `AuthScreen`; session →
  `ChatPanel` + sign-out), and a non-crashing fallback when history load fails.

All Supabase calls are exercised against `src/test/mockSupabase.ts`, a minimal fake of
the `.from(table).select/.eq/.order/.insert` surface this app actually uses — no live
Supabase project or network access is required to run the suite.

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
