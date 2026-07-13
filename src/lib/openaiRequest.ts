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

export function buildOpenAIRequestBody(messages: ChatTurn[]) {
  return {
    model: OPENAI_MODEL,
    stream: true,
    temperature: 0.6,
    messages,
  };
}
