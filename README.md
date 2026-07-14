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
                    openaiRequest, opinionHeuristic, supabaseClient — the parts that are
                    unit-tested without a browser or network
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

## Current status (Cycle 3 / PRD v4)

The theme's primary accent is `#A0B9BF` (soft slate blue) applied uniformly across
buttons, message bubbles, badges, links/focus rings, and the auth screen (`src/styles/theme.css`).
The PRD's v3 addition — a second, on-request `<RECOMMEND>` tag (FR-008) — is **not yet
implemented** in this codebase; see "Assumptions & decisions → Cycle 3" in
`docs/ARCHITECTURE.md` for why and how it was flagged.
