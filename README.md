# Structured-Output & Streaming AI Utility

A small proof-of-concept chat app built for StealthCo to de-risk the core technical
pattern behind their planned MVP: an LLM that streams a natural-language reply
token-by-token while emitting an inline tagged block (e.g. `<ADD item="Inception"
rating="5" />`) that the frontend parses out of the stream and writes to the database —
with graceful, visible fallback (never a silent failure or a crash) when the model
doesn't cooperate.

Sign up, tell the assistant what you thought of a movie (e.g. "I loved Inception"), and
watch the reply stream in live; on a successful tag extraction the UI confirms the row
was written to Supabase. Chat history and logged items persist per user across
logins and are isolated by Postgres row-level security, not just UI filtering.

This is an evaluation artifact, not the full StealthCo product — see `docs/ARCHITECTURE.md`
for the complete FR-by-FR mapping, the data model as built, and every judgment call made
along the way.

## Running locally

```bash
npm ci
cp .env.local.example .env.local   # fill in the two Supabase values, see below
npm run dev                        # Vite dev server (frontend only)
```

`npm run dev` serves the React app, but **the chat backend is a Netlify Edge Function**
(`netlify/edge-functions/chat.ts`), which the plain Vite dev server does not run. To
exercise a full send → stream → parse → Supabase-write cycle locally, run the app through
the Netlify CLI instead, which serves the frontend and the edge function together on one
origin:

```bash
npm i -g netlify-cli   # once
netlify dev            # reads OPENAI_API_KEY from your shell env; serves / and /api/chat
```

Other scripts:

```bash
npm run build     # tsc --noEmit && vite build -> dist/ (this is what gets deployed)
npm test          # vitest run (no live Supabase/OpenAI needed — see mockSupabase.ts)
npm run lint      # tsc --noEmit
```

## Environment variables

| Variable | Used by | Notes |
|---|---|---|
| `VITE_SUPABASE_URL` | build (Vite), baked into the client bundle | Local: `.env.local`. Deploy: Netlify env vars. |
| `VITE_SUPABASE_ANON_KEY` | build (Vite), baked into the client bundle | Safe to expose client-side — RLS is the real access boundary, not this key. |
| `OPENAI_API_KEY` | `netlify/edge-functions/chat.ts` only | **Server-side only** — never put this in a `VITE_`-prefixed variable or `.env.local`. Read via `Deno.env.get("OPENAI_API_KEY")`. Without it the chat function returns a clean 500 instead of crashing. |

Set all three in the Netlify site's **Site settings → Environment variables** before the
first real deploy; `.env.local.example` documents the two Vite ones for local dev.

## Project structure

```
src/
  lib/             pure, framework-free modules: systemPrompt, tagParser, sseParser,
                    openaiRequest, opinionHeuristic, recommendationHeuristic,
                    titleClarificationHeuristic, watchlistHeuristic, supabaseClient —
                    the parts that are unit-tested without a browser or network
  context/          AuthContext (Supabase session state)
  features/auth/    sign-up / sign-in screen
  features/chat/    useChat hook (streaming + parsing + persistence), ChatPanel UI,
                    RecommendationCard (distinct <RECOMMEND> card)
  features/history/ useHistory hook (RLS-scoped read + realtime subscription),
                    HistoryPanel UI (Rated / Want to Watch tabs)
  components/ui/    small presentational primitives (Button, Card, MessageBubble,
                    Badge, Tabs, ...)
  components/layout/  AppShell (header + content frame)
  pages/            Home (authenticated landing screen: ChatPanel + HistoryPanel)
netlify/edge-functions/chat.ts   OpenAI proxy (Deno), the only place the OpenAI key lives
supabase/migrations/             schema + RLS policies, in apply order
docs/ARCHITECTURE.md             data model, auth model, FR map, assumptions & decisions
```

## Current status (Cycle 9 / PRD v8)

This cycle fixed four correctness defects found in pressure testing (all amend
FR-001/FR-002/FR-003/FR-004; no schema change):

- **Sentiment-only phrasing now reliably logs.** "I hated Barbie" or "I disliked Cats"
  gave no numeric rating word, and `opinionHeuristic.ts` didn't recognize that class of
  phrasing as a loggable opinion at all — so a miss produced no retry and no
  `parse_failures` row whatsoever (a genuinely invisible failure). The heuristic
  (`looksLikeLoggableOpinion`) now also treats bare sentiment words as opinion signals,
  so this phrasing engages the same 3-attempt retry-then-fallback safety net an
  explicit-rating message always did.
- **Mainstream real films stopped being wrongly rejected.** The unrecognized-title
  clarification (FR-001 Issue 2, since Cycle 4) had over-corrected: *The Big Short*, *A
  Star Is Born*, *American History X*, and *The Departed* were being declined as "not a
  real movie" while a genuinely fabricated title ("Point Break 2") was accepted. There
  was no local allowlist/gate to remove (`titleClarificationHeuristic.ts` only detects
  the model's *own* clarification phrasing, unchanged) — the fix is entirely in
  `systemPrompt.ts`'s wording: it now names those four films as must-recognize examples
  and explicitly says recognition is the model's own judgment with "no external list
  you are being checked against" (still no TMDb lookup).
- **Compound multi-opinion messages no longer silently drop an opinion.** "I hated
  Chicago, but I loved A Star is Born" could tag only one of the two. `tagParser.ts`'s
  `extractTags` was already uncapped and `useChat.ts` already dispatched every match, so
  the actual gap was upstream: the system prompt only ever asked for "at most one" tag
  per reply, and nothing detected a *partially*-tagged compound turn as a compliance
  miss. The prompt now asks for one tag per distinct opinion (no cap), and
  `opinionHeuristic.ts` gained segment-splitting (`countLikelyOpinions`,
  `findUncapturedOpinionSegments`) so `useChat.ts` can tell a compound message is only
  partially resolved and silently retry the **whole turn** up to 2 more times
  (discarding any partial success, matching the existing all-or-nothing retry
  semantics) — if opinions are still uncaptured after 3 attempts, the fallback footnote
  now names them (`Didn't catch: "..."`) instead of dropping them.
- **Fixed the stale/replayed-response bug.** A confirmed live repro showed an unrelated
  new message ("Wolfs was just ok") returning a prior turn's clarification text
  verbatim. The audit found no caching layer anywhere in the streaming path; the fix is
  defense-in-depth on two fronts: `fetch("/api/chat", { cache: "no-store", ... })`
  rules out the browser HTTP cache, and `historyForModel` now de-duplicates the current
  user message by id before sending it (closing a latent "send this turn twice" risk
  the audit surfaced) rather than assuming `messagesRef.current` never already contains it.

See `docs/ARCHITECTURE.md`'s "Cycle 9" section for the full technical writeup, including
why this is "Cycle 9" rather than "Cycle 7" despite being PRD v8's *first* change cycle
after PRD v7.

### Previously (Cycle 8 — dev-directed: `<UPDATE>` becomes a true in-place update)

Requested directly by the dev after seeing duplicate "Norbit" rows on a re-rating in the
live history panel: `<UPDATE>` now **updates the existing row in place** (matched
case-insensitively by title) instead of inserting a new history row, reversing Cycle 4's
original "insert-with-history" design. `supabase/migrations/008_items_true_update.sql`
adds the previously-missing `items_update_own` RLS policy (the table had select/insert/
delete policies but no update policy) and one-time-deduped the rows the old behavior had
already produced in production. The live history panel's realtime subscription now
handles `UPDATE` events too, moving a want-to-watch row to "Rated" in place when it
transitions.

### Previously (Cycle 7 — live-site incident: history poisoning + invisible watchlist misses)

A production bug report ("the watchlist did not save and none of the updated ones are
saving") traced to the app poisoning its own model context: assistant replies were
persisted tag-stripped for display, and that same cleaned text was resent to the model
as conversation history, so one stochastic compliance miss taught the model — via its
own prior turn — that tags are optional for the rest of that conversation. Fix:
`chat_messages.raw_content` (`007_chat_messages_raw_content.sql`, additive) stores the
model-visible form of each assistant turn; a turn with no `raw_content` (a miss, a
malformed tag, or any legacy row) is dropped from what's sent back to the model instead
of replayed. Separately, `watchlistHeuristic.ts` closed a gap where a missed "I want to
watch X" produced no retry, no log, and no footnote at all (neither the opinion nor the
recommendation heuristic recognized watch-intent phrasing).

### Previously (Cycle 6 / PRD v7)

This cycle fixed a live regression, added a new tracking status, and shipped a new live
UI surface:

- **Fixed the `<UPDATE>`-claimed-but-not-written bug.** The model would sometimes say
  "I'll update your rating now" for a rewatch/changed-opinion re-mention without
  actually emitting an `<UPDATE>` tag, because `opinionHeuristic.ts` didn't recognize
  that phrasing (only first-time sentiment words), so the existing 2-retry safety net
  never engaged. The heuristic now also catches rewatch/changed-opinion phrasing
  (`rewatched`, `changed my mind`, `opinion ... changed`, `reconsidered`, `second
  viewing`, `actually loved/hated/...`), and the system prompt gained an explicit
  action-integrity guard instructing the model to never claim an action in prose
  without emitting the matching tag in the same turn.
- **"Want to watch" tracking, reusing the existing `<ADD>` tag.** `<ADD item="..."
  status="want_to_watch" />` (rating omitted) logs a title the user intends to watch
  later; a normal `<ADD item="..." rating="..." />` still means "watched" (the
  column default). `items` gained an additive `status` column (`default 'watched'`,
  so every existing row is unaffected) and `rating` was relaxed to nullable
  (`supabase/migrations/006_items_status_and_realtime.sql`). A later real opinion on a
  want-to-watch title goes through the existing `<UPDATE>` path (later revised again in
  Cycle 8 above), preserving the want-to-watch row as history. The UI shows a distinct
  "Want to watch · `<title>`" badge (`tone="watchlist"`), separate from "Saved"/"Rating
  updated".
- **Finished `<RECOMMEND>` (FR-008), carried forward unbuilt since PRD v3.** Despite
  being recorded as shipped, `<RECOMMEND>` had never actually been implemented in any
  prior cycle — this cycle's work order amends its grounding (must exclude
  want-to-watch/unrated rows), which only makes sense if the tag exists, so it's built
  in full here: a fourth registered tag type, dispatched to a distinct
  `RecommendationCard` (display-only, no DB write), grounded in the calling user's own
  rated items only. See `docs/ARCHITECTURE.md`'s "Cycle 6" assumptions for the full
  reasoning.
- **Live history panel (FR-010).** A new panel to the right of the chat, "Rated" and
  "Want to Watch" tabs, showing every historical row per title uncollapsed, updating in
  real time via a Supabase realtime subscription on `items` INSERT events scoped to the
  signed-in user (`useHistory.ts`) — riding entirely on the existing per-user RLS, no
  new read/write path.

### Previously (Cycle 5 / PRD v6)

Build/deploy fix only, no behavior change: the Netlify Edge Function's
`@supabase/supabase-js` import was swapped from an `npm:` specifier (which Netlify's
edge bundler couldn't reliably bundle) to a Deno-native `https://esm.sh/...` ESM URL,
pinned to the same version already in `package.json`.

### Previously (Cycle 4 / PRD v5)

The theme's primary accent is `#A0B9BF` (soft slate blue) applied uniformly across
buttons, message bubbles, badges, links/focus rings, and the auth screen (`src/styles/theme.css`).

This cycle fixed two correctness defects and shipped one new tag type:

- **Lower, documented temperature.** The OpenAI call now runs at `temperature: 0.2`
  (`src/lib/openaiRequest.ts`, `OPENAI_TEMPERATURE`) — down from 0.6 — to reduce
  intermittent non-logging of clearly negative/neutral opinions.
- **Bounded silent retry.** When the user's message reads like a loggable opinion
  (`opinionHeuristic.ts`) but a full attempt streams back with no `<ADD>`/`<UPDATE>`
  tag, `useChat.ts` silently retries the OpenAI call up to 2 more times (3 attempts
  total), discarding every failed attempt — the user only ever sees the final
  attempt's output. If all 3 attempts fail, the existing fallback + `parse_failures`
  log (`reason: "missing"`) still applies.
- **Ask instead of guessing on unrecognized titles.** The system prompt
  (`src/lib/systemPrompt.ts`) now instructs the model to ask for clarification,
  model-knowledge-only (no TMDb/external lookup), rather than emit a tag for a title
  it doesn't recognize as real. Those clarifications are logged to `parse_failures`
  with `reason: "unrecognized_title"` (expected behavior, logged for visibility, not
  a genuine failure) — recognized by `src/lib/titleClarificationHeuristic.ts`.
- **`<UPDATE>` — a third registered tag type (FR-009).** On re-mention of an
  already-logged title, the model emits `<UPDATE item="..." rating="..." />` instead
  of a fresh `<ADD>` (model-side fuzzy title matching — the edge function passes the
  user's own previously-logged titles to the model). The parser dispatches `<UPDATE>`
  to a handler that **inserts a new `items` row** (never overwrites), preserving full
  rating history per title, and the UI shows a distinct "Rating updated · `<title>`"
  badge (`tone="update"`) next to the existing "Saved · `<title>`" confirmation.

No schema changes beyond widening the `parse_failures.reason` check constraint
(`supabase/migrations/005_parse_failures_unrecognized_title_reason.sql`) to allow the
new `unrecognized_title` value.

(As of Cycle 4, the PRD's v3 addition — a second, on-request `<RECOMMEND>` tag,
FR-008 — remained unimplemented, carried forward rather than opportunistically built
since it wasn't in that cycle's change_log scope. It was finally built in Cycle 6 — see
above.)
