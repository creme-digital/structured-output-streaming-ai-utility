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
