# Architecture

This document describes the app **as built**, not as originally planned. Where the
build deviated from the PRD's suggestions, that's called out explicitly in
"Assumptions & decisions" below.

## System overview

```
Browser (React SPA)
  │  fetch("/api/chat", { messages })
  ▼
Netlify Edge Function (netlify/edge-functions/chat.ts, Deno)
  │  injects SYSTEM_PROMPT + OPENAI_API_KEY, streams request through
  ▼
OpenAI chat-completions API (stream: true)
  │  SSE deltas flow back through the edge function unmodified
  ▼
Browser: OpenAIStreamDecoder → extractTags() → React state (token-by-token render)
  │  on successful <ADD> tag / on failure
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
One row per successfully-parsed `<ADD>` tag. Written by `useChat.sendMessage` after a
stream finishes and `extractTags` returns at least one match.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | `gen_random_uuid()` default |
| `user_id` | uuid | FK → `auth.users`, isolation key |
| `item` | text | Movie title, taken verbatim from the tag's `item` attribute |
| `rating` | numeric | **LLM-estimated**, 1–5 integer scale, see "Rating scale" below — never a value the user typed directly |
| `category` | text | Hardcoded `"movies"` at the call site (`useChat.ts`); column exists for forward-compatibility, no other category is exercised |
| `raw_user_text` | text | The triggering user message, kept as tracking metadata |
| `created_at` | timestamptz | default `now()` |

Constraint: `rating between 1 and 5` enforced in Postgres (`002_items.sql`), matching the
scale the system prompt instructs the model to use — a belt-and-suspenders check in case
a future prompt change or model drift ever produced an out-of-range value (the frontend's
`ADD_TAG_DEFINITION.validate` in `tagParser.ts` already rejects those before they'd reach
Supabase, but the DB constraint holds regardless of client behavior).

### `chat_messages`
One row per turn (`role: 'user' | 'assistant'`), written by `useChat.ts` right after the
user's message is accepted and again once the assistant's stream finishes. This is what
makes chat history persist across logout/login (FR-006) — `useChat`'s history-load effect
reads this table filtered to the signed-in user on mount.

### `parse_failures`
Written whenever `useChat.ts` can't turn a model turn into either a clean chat message or
a saved item: malformed tag, missing tag on what looked like a loggable opinion, empty
stream, or a network/HTTP error talking to `/api/chat`. `reason` is one of
`malformed | missing | other`. This table has no frontend reader — it exists purely as a
debugging log per FR-004; there is no in-app UI to browse it (Supabase Studio is the
retrieval path an evaluator or dev would use).

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
   then `fetch("/api/chat", { messages: history })`.
2. Edge function prepends `SYSTEM_PROMPT`, forwards to OpenAI with `stream: true`
   (`openaiRequest.ts`), and pipes the upstream `Response.body` straight back — no
   buffering server-side.
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
   time against the complete `rawBuffer` to decide what actually happened:
   - one or more valid `<ADD>` matches → insert into `items`, footnote `Saved · <name>`;
   - a recognized-but-malformed tag → log to `parse_failures` (`reason: "malformed"`),
     footnote `Couldn't log that — logged for review.`;
   - no tag, but `looksLikeLoggableOpinion(userText)` (`opinionHeuristic.ts`) is true →
     treated as a probable compliance miss, logged (`reason: "missing"`), neutral
     footnote;
   - no tag and the user's message didn't look like an opinion → ordinary conversation,
     nothing logged, no footnote;
   - empty final text, non-OK HTTP response, or any thrown exception anywhere in the
     above → `reason: "other"`, danger-toned fallback message, **never** an unhandled
     exception surfaced to the user (all paths are wrapped in `try/catch` inside
     `useChat.sendMessage`).
6. The assistant's final displayed text (tag stripped) is persisted to `chat_messages`
   regardless of which branch above fired.

## Functional requirements → code map

| FR | Requirement | Where it lives |
|---|---|---|
| FR-001 | System prompt driving inline `<ADD>` emission + rating inference | `src/lib/systemPrompt.ts` (imported by the edge function); contract asserted by `src/lib/__tests__/systemPrompt.test.ts` |
| FR-002 | Token-by-token streaming | `netlify/edge-functions/chat.ts` (SSE passthrough, no buffering) + `src/lib/sseParser.ts` (incremental decode) + `src/features/chat/useChat.ts` (`reader.read()` loop updates React state per chunk) |
| FR-003 | Generic, position-independent tag parser | `src/lib/tagParser.ts` — `TagRegistry`/`extractTags` engine is tag-agnostic; `ADD_TAG_DEFINITION` is the only registered definition (`createDefaultTagRegistry`); see file header for how `UPDATE`/`REMOVE` would be added without touching `extractTags` |
| FR-004 | Graceful failure (malformed/missing/ambiguous/off-topic, no silent failure) | `src/features/chat/useChat.ts` (all branches above) + `src/lib/opinionHeuristic.ts` (missing-vs-ordinary-chat classifier) + `parse_failures` table |
| FR-005 | Clean minimal chat UI with write confirmation | `src/features/chat/ChatPanel.tsx` (streaming caret via `MessageBubble`'s `streaming` prop, `Badge` footnote for confirmation/failure) + `src/components/ui/`, `src/components/layout/AppShell.tsx` |
| FR-006 | Email/password auth, persisted chat, per-user isolation | `src/context/AuthContext.tsx`, `src/features/auth/AuthScreen.tsx`, RLS policies in all four `supabase/migrations/*.sql` files |
| FR-007 | Netlify deployment + deliverables | `netlify.toml` (build command + SPA publish dir), `public/_redirects` (SPA fallback routing); the actual deploy, repo link, and written summary are produced by this pipeline's later (docs/deploy) step, not by app code |

## Test coverage as built

`vitest` + `@testing-library/react`, run via `npm test`:

- `src/lib/__tests__/tagParser.test.ts` — tag position independence (start/middle/end),
  malformed/missing-attribute handling, multi-tag-type registry extensibility.
- `src/lib/__tests__/sseParser.test.ts` — SSE line buffering across chunk boundaries,
  `[DONE]` handling, malformed-line resilience.
- `src/lib/__tests__/systemPrompt.test.ts` — asserts the prompt contract the parser
  depends on (tag shape, rating scale documented).
- `src/lib/__tests__/openaiRequest.test.ts` — request body shape (`stream: true`, model).
- `src/lib/__tests__/opinionHeuristic.test.ts` — opinion-signal classification cases.
- `src/context/__tests__/AuthContext.test.tsx`, `src/features/auth/__tests__/AuthScreen.test.tsx`
  — sign-up/sign-in error surfacing, the email-confirmation branch.
- `src/features/chat/__tests__/useChat.test.ts`, `ChatPanel.test.tsx` — history loading,
  sending, footnote rendering.
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
- **Email-confirmation branch (QA fix).** The initial build's `AuthScreen` claimed
  "Account created — signing you in..." unconditionally after a successful sign-up. QA
  caught that Supabase omits the session on projects requiring email confirmation, which
  would have shown a false "signing you in" message and then silently left the user on
  the auth screen with no explanation. `AuthContext.signUp` now returns
  `needsEmailConfirmation`, and `AuthScreen` shows the correct one of two messages.
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
