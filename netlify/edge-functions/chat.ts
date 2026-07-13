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
import { SYSTEM_PROMPT } from "../../src/lib/systemPrompt.ts";

declare const Deno: { env: { get(key: string): string | undefined } };

const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";

interface ChatRequestBody {
  messages?: ChatTurn[];
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
  const messages: ChatTurn[] = [{ role: "system", content: SYSTEM_PROMPT }, ...history];

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
