// Netlify Edge Function (Deno runtime): proxies the OpenAI streaming
// chat-completions API so the browser never holds the OpenAI secret key
// (FR-001, FR-002). Deployed at /api/chat by the `config.path` export below.
//
// Requires the OPENAI_API_KEY environment variable to be set on the Netlify
// site (Site settings -> Environment variables) — see the build summary.
//
// Prompt + request-shaping logic is deliberately kept in plain, Deno-free
// modules under src/lib so it is unit-testable with vitest; this file is
// only the runtime glue (env var + fetch passthrough).

import { buildOpenAIRequestBody, ChatTurn } from "../../src/lib/openaiRequest.ts";
import { buildExistingTitlesMessage, buildRecommendationContextMessage, SYSTEM_PROMPT } from "../../src/lib/systemPrompt.ts";
// Deno-native ESM import (cycle 6 / FR-007 build fix) — kept out of src/lib so every
// other module stays plain, Deno-free TypeScript that vitest can run under Node/jsdom.
// Netlify's edge bundler only experimentally supports npm: specifiers and fails to
// bundle them reliably; esm.sh serves the same published package as a Deno-native ESM
// module, so this is a build-target swap only, not a dependency/version change. Pinned
// to the same 2.110.3 used by package.json to avoid an unreviewed version bump.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.110.3";

declare const Deno: { env: { get(key: string): string | undefined } };

const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";

interface ChatRequestBody {
  messages?: ChatTurn[];
  /** Cycle 4 / FR-009: the caller's own Supabase access token, used only to read
   * their own (RLS-scoped) logged titles for <UPDATE> fuzzy-matching — never
   * persisted, never used for anything else. */
  accessToken?: string;
}

export default async (request: Request): Promise<Response> => {
  if (request.method !== "POST") {
    return jsonError("Method not allowed.", 405);
  }

  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) {
    return jsonError("Server is not configured with an OpenAI API key.", 500);
  }

  let body: ChatRequestBody;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON request body.", 400);
  }

  const history = Array.isArray(body.messages) ? body.messages : [];
  const { titlesMessage, recommendationMessage } = await fetchUserItemContext(body.accessToken);

  const messages: ChatTurn[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...(titlesMessage ? [{ role: "system" as const, content: titlesMessage }] : []),
    ...(recommendationMessage ? [{ role: "system" as const, content: recommendationMessage }] : []),
    ...history,
  ];

  let upstream: Response;
  try {
    upstream = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(buildOpenAIRequestBody(messages)),
    });
  } catch {
    return jsonError("Could not reach the model provider.", 502);
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    return jsonError(`Model provider returned an error. ${detail}`.trim(), 502);
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
};

export const config = { path: "/api/chat" };

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Cycle 4 / FR-009 + Cycle 6 / FR-008: read the calling user's own previously-logged
 * items ONCE per request, scoped to their session and respecting existing RLS (never the
 * service role), and build the two separate context messages the system prompt draws
 * on:
 *  - `titlesMessage` — every logged title regardless of status (FR-009: a title the
 *    user only marked want-to-watch still counts as "already logged" for ADD-vs-UPDATE
 *    matching, since a first real opinion on it is the want-to-watch -> watched
 *    transition, not a fresh log).
 *  - `recommendationMessage` — RATED titles only (status "watched"), excluding
 *    want-to-watch rows (Cycle 6 / FR-008 amendment: an unrated watchlist entry carries
 *    no opinion signal and must never ground a recommendation).
 *
 * A fresh, request-scoped Supabase client is built per call, authenticated as the
 * calling user via their own access token — PostgREST/RLS evaluates `auth.uid() =
 * user_id` against that token exactly as it would for a direct client-side query, so
 * this never reads across users.
 *
 * Best-effort only and never throws: a missing token, missing Supabase env vars, or a
 * query error all silently fall back to no context at all (the model then only ever
 * emits <ADD>, and declines <RECOMMEND> gracefully) — a safe degradation per FR-004's
 * "never crash" bar, not a feature the rest of the request depends on.
 */
async function fetchUserItemContext(
  accessToken?: string,
): Promise<{ titlesMessage: string | null; recommendationMessage: string | null }> {
  const empty = { titlesMessage: null, recommendationMessage: null };
  if (!accessToken) return empty;

  const supabaseUrl = Deno.env.get("VITE_SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("VITE_SUPABASE_ANON_KEY");
  if (!supabaseUrl || !supabaseAnonKey) return empty;

  try {
    const client = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });

    const { data, error } = await client
      .from("items")
      .select("item, rating, status")
      .order("created_at", { ascending: false })
      .limit(200);

    if (error || !data) return empty;

    const rows = data as Array<{ item: string; rating: number | null; status: string | null }>;
    const titlesMessage = buildExistingTitlesMessage(rows.map((row) => row.item));
    const recommendationMessage = buildRecommendationContextMessage(
      rows
        .filter((row) => (row.status ?? "watched") === "watched" && row.rating != null)
        .map((row) => ({ item: row.item, rating: row.rating as number })),
    );

    return { titlesMessage, recommendationMessage };
  } catch {
    return empty;
  }
}
