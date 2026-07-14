/**
 * Pure request-shaping helper for the OpenAI chat-completions streaming API.
 * Kept dependency-free (no `fetch`, no secrets) so it is usable from both the
 * Netlify edge function (Deno runtime) and ordinary vitest (Node/jsdom) without
 * any runtime-specific shims, and so the request shape itself is unit-testable.
 */

export type ChatRole = "system" | "user" | "assistant";

export interface ChatTurn {
  role: ChatRole;
  content: string;
}

/**
 * Model choice: left to dev-team discretion per the PRD ("a specific model was
 * not named"). gpt-4o-mini balances response quality against cost/latency for a
 * 2-3-tester proof-of-concept with no rate limiting.
 */
export const OPENAI_MODEL = "gpt-4o-mini";

/**
 * Cycle 4 / FR-001 Issue 1: the dev reported clearly negative/neutral opinions
 * ("I hated Barbie", "Marty Supreme was fine") intermittently producing NO <ADD> tag
 * at the previous temperature (0.6) — model non-determinism, not a parser bug. The
 * dev explicitly declined to dictate an exact number ("just pick something
 * conservative and document it"), citing 0.2-0.3 only as an illustrative range.
 *
 * Chosen value: 0.2 — the low end of that range, and a standard "conservative but not
 * fully deterministic" choice for a task that's still natural-language chat (not pure
 * structured extraction, where 0 would be more typical). Combined with the bounded
 * silent-retry in `useChat.ts` (FR-004), this is the two-layer fix for the
 * intermittent-non-logging defect: fewer misses to begin with, and a safety net when
 * one still occurs.
 */
export const OPENAI_TEMPERATURE = 0.2;

export function buildOpenAIRequestBody(messages: ChatTurn[]) {
  return {
    model: OPENAI_MODEL,
    stream: true,
    temperature: OPENAI_TEMPERATURE,
    messages,
  };
}
