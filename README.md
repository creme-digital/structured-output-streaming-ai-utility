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
                    openaiRequest, opinionHeuristic, titleClarificationHeuristic,
                    supabaseClient — the parts that are unit-tested without a browser
                    or network
  context/          AuthContext (Supabase session state)
  features/auth/    sign-up / sign-in screen
  features/chat/    useChat hook (streaming + parsing + persistence) + ChatPanel UI
  components/ui/    small presentational primitives (Button, Card, MessageBubble, ...)
  components/layout/  AppShell (header + content frame)
  pages/            Home (authenticated landing screen)
netlify/edge-functions/chat.ts   OpenAI proxy (Deno), the only place the OpenAI key lives
supabase/migrations/             schema + RLS policies, in apply order
docs/ARCHITECTURE.md             data model, auth model, FR map, assumptions & decisions
```

## Current status (Cycle 5 / PRD v6)

This cycle was a **build/deploy fix only, no behavior change**: the Netlify Edge
Function at `netlify/edge-functions/chat.ts` imported `@supabase/supabase-js` via an
`npm:` specifier, which Netlify's edge bundler (Deno-based, experimental npm-module
support) failed to bundle. The import was swapped to a Deno-native ESM URL —
`https://esm.sh/@supabase/supabase-js@2.110.3` — pinned to the exact same version
already in `package.json`'s `dependencies`, so this is a build-target swap, not a
dependency/version bump. Nothing else in the file, and no file under `src/`, changed.
A new regression test, `netlify/edge-functions/__tests__/chat.imports.test.ts`,
statically asserts the file imports from an `esm.sh` URL, contains no `npm:` specifier
anywhere, and stays pinned to the same version as `package.json` — so a future
edit can't silently reintroduce the bundler-breaking import.

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

The PRD's v3 addition — a second, on-request `<RECOMMEND>` tag (FR-008) — remains
**not implemented** in this codebase; it was not in this cycle's change_log scope
(FR-001/003/004/009 only), so per the touch-only-what's-required rule it was carried
forward rather than opportunistically built. See "Assumptions & decisions → Cycle 3"
and "→ Cycle 4" in `docs/ARCHITECTURE.md`.
