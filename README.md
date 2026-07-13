# Structured-Output & Streaming AI Utility

Proof-of-concept chat app for StealthCo: an LLM streams a natural-language reply while
inline-emitting a tagged `<ADD item="..." rating="..." />` block that the frontend parses
in real time and writes to Supabase — the core technical pattern the larger StealthCo
build depends on.

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

## Required deployment configuration

Set these in the Netlify site's **Site settings → Environment variables** before the
first real deploy:

| Variable | Used by | Notes |
|---|---|---|
| `OPENAI_API_KEY` | `netlify/edge-functions/chat.ts` | Server-side only. Without this the chat function returns a clean 500 rather than crashing. |
| `VITE_SUPABASE_URL` | build (Vite) | Baked into the client bundle at build time. |
| `VITE_SUPABASE_ANON_KEY` | build (Vite) | Safe to expose client-side — RLS is the real access boundary. |

## Where each requirement lives

- **FR-001 / system prompt** — `src/lib/systemPrompt.ts` (imported by the edge function).
- **FR-002 / streaming** — `netlify/edge-functions/chat.ts` proxies OpenAI's SSE stream;
  `src/lib/sseParser.ts` decodes it incrementally; `src/features/chat/useChat.ts` reads
  the response body chunk-by-chunk and updates the UI before the reply finishes.
- **FR-003 / generic parser** — `src/lib/tagParser.ts`: a registry-based extractor (only
  `<ADD>` is registered/active; see the file's header comment for how a future `UPDATE`
  or `REMOVE` tag would be added without touching the extraction engine).
- **FR-004 / graceful failure** — handled in `src/features/chat/useChat.ts`: malformed
  tags, no-tag-when-one-looks-expected (`src/lib/opinionHeuristic.ts`), and network/stream
  exceptions all log to `parse_failures` and render a fallback footnote instead of
  crashing or failing silently.
- **FR-005 / chat UI** — `src/features/chat/ChatPanel.tsx` + the design system in
  `src/components/ui/` and `src/components/layout/`.
- **FR-006 / auth + isolation** — `src/context/AuthContext.tsx`,
  `src/features/auth/AuthScreen.tsx`, and RLS policies in `supabase/migrations/`.
- **FR-007 / deployment** — `netlify.toml` + `public/_redirects` (Netlify SPA config);
  the actual deploy/repo-link/summary deliverables are produced by the pipeline's later
  steps.

## Key decisions worth flagging

- **FR-001 said "Supabase Edge Function or equivalent."** This pipeline has no tool to
  deploy Supabase Functions, and the client explicitly wants a Netlify deployment (not
  Lovable), so the OpenAI proxy is a **Netlify Edge Function** instead — it still keeps
  the OpenAI key server-side and supports streaming, which is what FR-001/002 actually
  require.
- **Rating scale**: fixed 1-5 integer scale, inferred by the model from wording intensity
  per `systemPrompt.ts` (loved=5 ... hated=1). Not confirmed numerically by the client;
  documented as a medium-confidence assumption.
- **"Missing tag" classification** (`src/lib/opinionHeuristic.ts`): rather than logging a
  `parse_failures` row on every tag-less reply (which would fire on ordinary off-topic
  chat), a small keyword heuristic on the *user's* message decides whether a tag-less
  reply looks like a genuine model compliance miss worth logging, vs. normal
  conversation. Documented as a judgment call, not a client-confirmed spec.
