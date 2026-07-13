# Structured-Output & Streaming AI Utility

Proof-of-concept chat app for StealthCo: an LLM streams a natural-language reply while
inline-emitting a tagged `<ADD item="..." rating="..." />` block that the frontend parses
in real time and writes to Supabase — the core technical pattern the larger StealthCo
build depends on.

Sign in, tell the assistant about a movie you watched ("I loved Inception"), and watch
the reply stream in token-by-token with a "Saved · Inception" confirmation once the row
lands in Supabase. See `docs/ARCHITECTURE.md` for the full data model, auth model, and a
requirement-by-requirement map of where everything lives in the code.

## Stack

- Vite + React 18 + TypeScript (`src/`)
- Supabase (Postgres + Auth + RLS) — schema in `supabase/migrations/`
- A Netlify Edge Function (`netlify/edge-functions/chat.ts`, Deno runtime) proxies the
  OpenAI streaming chat-completions API so the browser never holds the OpenAI key.

## Local development

```
npm install
cp .env.local.example .env.local   # fill in VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
npm run dev
```

The `/api/chat` edge function only runs under the Netlify dev server or once deployed —
`vite dev` alone will 404 on it. To exercise the full chat flow locally, use
`netlify dev` (Netlify CLI) with `OPENAI_API_KEY` set in your shell, or deploy to Netlify
directly.

The Supabase project itself (tables + RLS policies in `supabase/migrations/`) must
already exist and be reachable at `VITE_SUPABASE_URL` — this repo does not create it;
run the migrations against your Supabase project before first use.

## Tests & build

```
npm test        # vitest run — unit tests for the parser, streaming decoder, system
                 # prompt contract, auth flows, and chat UI (see src/**/__tests__)
npm run build   # tsc --noEmit, then the production Vite build (must exit 0)
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

## Where each requirement lives (quick index)

See `docs/ARCHITECTURE.md` for the full mapping with detail. Short version:

- **FR-001 / system prompt** — `src/lib/systemPrompt.ts`.
- **FR-002 / streaming** — `netlify/edge-functions/chat.ts` (proxy) + `src/lib/sseParser.ts`
  (incremental decode) + `src/features/chat/useChat.ts` (renders partial text as it arrives).
- **FR-003 / generic parser** — `src/lib/tagParser.ts` (registry-based; only `<ADD>` active).
- **FR-004 / graceful failure** — `src/features/chat/useChat.ts` + `src/lib/opinionHeuristic.ts`,
  logging to the `parse_failures` table.
- **FR-005 / chat UI** — `src/features/chat/ChatPanel.tsx` + `src/components/ui/`.
- **FR-006 / auth + isolation** — `src/context/AuthContext.tsx`, `src/features/auth/AuthScreen.tsx`,
  RLS policies in `supabase/migrations/`.
- **FR-007 / deployment** — `netlify.toml` + `public/_redirects`; the deploy/repo-link/summary
  deliverables themselves are produced by the pipeline's later steps.
