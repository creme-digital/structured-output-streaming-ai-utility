// QA-only local server: serves the production build (dist/) exactly like Netlify would,
// and stands in for the netlify/edge-functions/chat.ts edge function at POST /api/chat
// with a REAL chunked SSE stream (written with delays) matching OpenAI's exact wire
// format, since no OPENAI_API_KEY is available in this sandbox. Every other layer
// (useChat.ts, sseParser.ts, tagParser.ts, ChatPanel.tsx, Supabase writes) is the real,
// unmodified production code path.
//
// Cycle 4 (PRD v5) update: added scripted scenarios for the new/amended behavior this
// cycle actually changed — <UPDATE> re-mention, unrecognized-title clarification, and
// the silent-retry-on-missing-tag loop (FR-001/FR-003/FR-004/FR-009). The retry
// scenarios use a per-trigger call counter (`callCounts`) so the SAME scripted trigger
// phrase can return a different scripted reply on attempt 1 vs. attempt 2 vs. attempt 3
// — this is what lets a single mock endpoint stand in for "the model eventually
// complies" vs. "the model never complies" without needing a real, non-deterministic
// OpenAI call. A `GET /__calls?key=` endpoint exposes the counter so the evidence
// script can assert exactly how many attempts the client made (proving the retry loop
// ran 3x, not 1x) without relying on brittle timing.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, "..", "dist");

const MIME = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

function sseChunk(res, text) {
  return new Promise((resolve) => {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
    setTimeout(resolve, 40);
  });
}

const callCounts = new Map();
function bump(key) {
  const n = (callCounts.get(key) ?? 0) + 1;
  callCounts.set(key, n);
  return n;
}

// Scripted assistant replies keyed by a substring of the incoming user message, split
// into multiple word-groups so the SSE stream genuinely arrives over several chunks
// (proving token-by-token progressive rendering, not full-response buffering).
//
// `words` may instead be a function `(callNumber) => words[]` for scenarios whose
// scripted reply depends on which attempt (1st/2nd/3rd) this is (FR-004 Issue 1 retry).
const SCRIPTS = [
  {
    match: /loved inception/i,
    words: ["Nice, ", "Inception ", "is ", "a ", "great ", "pick! ", '<ADD item="Inception" rating="5" />'],
  },
  {
    match: /liked the matrix/i,
    words: ["Glad ", "you ", "enjoyed ", "it. ", '<ADD item="The Matrix" rating="4" />'],
  },
  {
    // FR-009: re-mention of an already-logged title with a changed opinion -> <UPDATE>,
    // not a fresh <ADD>. Real model-side fuzzy matching is exercised by the edge
    // function/system-prompt unit tests; this scripted reply proves the CLIENT
    // dispatch/render/insert path for a successful <UPDATE> end to end.
    match: /worse on rewatch/i,
    words: ["Ah, ", "noted ", "— ", "updating ", "that ", "one. ", '<UPDATE item="Inception" rating="2" />'],
  },
  {
    match: /malformed-tag-test/i,
    words: ["Logging ", "that ", "now. ", '<ADD item="Broken" rat="oops">'], // not self-closing -> malformed
  },
  {
    // FR-004/FR-009: malformed <UPDATE> must follow the identical fallback discipline
    // as a malformed <ADD> (missing required "rating" attribute).
    match: /malformed-update-test/i,
    words: ["Updating ", "that ", "now. ", '<UPDATE item="Inception" />'], // missing rating -> malformed
  },
  {
    // FR-001 Issue 2 / FR-004: title the model doesn't recognize -> ask, don't guess.
    // Must contain the exact "don't recognize" + "movie" phrasing the system prompt
    // requires and `titleClarificationHeuristic.ts` looks for.
    match: /freeze frame 3000/i,
    words: [
      "Hmm, ",
      "I ",
      "don't ",
      "recognize ",
      "that ",
      "as ",
      "a ",
      "real ",
      "movie ",
      "— ",
      "could ",
      "you ",
      "double-check ",
      "the ",
      "title?",
    ],
  },
  {
    // FR-004 Issue 1: opinion clearly expressed, but the model misses the tag on its
    // first 2 attempts and only complies on the 3rd — proves the silent-retry loop
    // recovers a compliance miss without the user ever seeing the 2 discarded replies.
    match: /retryprobealpha/i,
    words: (call) => {
      if (call < 3) return ["Hmm, ", "tell ", "me ", "more ", "about ", "that ", `(attempt ${call}).`];
      return ["Got ", "it! ", '<ADD item="RetryProbeAlpha" rating="5" />'];
    },
  },
  {
    // FR-004 Issue 1: model NEVER complies across all 3 attempts -> falls through to
    // the existing fallback + parse_failures (reason: "missing").
    match: /retryprobebeta/i,
    words: (call) => ["Sounds ", "like ", "a ", "mixed ", "reaction ", `(attempt ${call})!`],
  },
  {
    match: /movie was okay/i,
    words: ["Sounds ", "like ", "a ", "mixed ", "bag ", "- ", "which ", "movie ", "was ", "it?"],
  },
  {
    match: /write your essay|ignore previous instructions/i,
    words: ["I'm ", "just ", "here ", "to ", "chat ", "about ", "movies ", "- ", "what ", "have ", "you ", "watched ", "lately?"],
  },
];
const DEFAULT_WORDS = ["Tell ", "me ", "more ", "about ", "what ", "you ", "watched."];

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url.startsWith("/__calls")) {
    const key = new URL(req.url, "http://x").searchParams.get("key") ?? "";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ key, count: callCounts.get(key) ?? 0 }));
    return;
  }

  if (req.method === "POST" && req.url === "/api/chat") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      let lastUserMessage = "";
      try {
        const body = JSON.parse(raw || "{}");
        const msgs = Array.isArray(body.messages) ? body.messages : [];
        lastUserMessage = [...msgs].reverse().find((m) => m.role === "user")?.content ?? "";
      } catch {
        // fall through with empty message -> default script
      }

      const script = SCRIPTS.find((s) => s.match.test(lastUserMessage));
      let words;
      if (script) {
        const callNumber = bump(script.match.source);
        words = typeof script.words === "function" ? script.words(callNumber) : script.words;
      } else {
        words = DEFAULT_WORDS;
      }

      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
      for (const w of words) {
        await sseChunk(res, w);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
    return;
  }

  // Static file serving from dist/, SPA fallback to index.html (mirrors public/_redirects).
  let filePath = path.join(distDir, decodeURIComponent(req.url.split("?")[0]));
  if (req.url === "/" || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(distDir, "index.html");
  }
  const ext = path.extname(filePath);
  res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
});

const port = Number(process.argv[2] || 4180);
server.listen(port, "127.0.0.1", () => {
  console.log(`qa mock server listening on http://127.0.0.1:${port}`);
});
