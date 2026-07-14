// QA-only local server: serves the production build (dist/) exactly like Netlify would,
// and stands in for the netlify/edge-functions/chat.ts edge function at POST /api/chat
// with a REAL chunked SSE stream (written with delays) matching OpenAI's exact wire
// format, since no OPENAI_API_KEY is available in this sandbox. Every other layer
// (useChat.ts, sseParser.ts, tagParser.ts, ChatPanel.tsx, Supabase writes) is the real,
// unmodified production code path.
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

// Scripted assistant replies keyed by a substring of the incoming user message, split
// into multiple word-groups so the SSE stream genuinely arrives over several chunks
// (proving token-by-token progressive rendering, not full-response buffering).
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
    match: /movie was okay/i,
    words: ["Sounds ", "like ", "a ", "mixed ", "bag ", "- ", "which ", "movie ", "was ", "it?"],
  },
  {
    match: /malformed-tag-test/i,
    words: ["Logging ", "that ", "now. ", '<ADD item="Broken" rat="oops">'], // not self-closing -> malformed
  },
  {
    match: /write your essay|ignore previous instructions/i,
    words: ["I'm ", "just ", "here ", "to ", "chat ", "about ", "movies ", "- ", "what ", "have ", "you ", "watched ", "lately?"],
  },
];
const DEFAULT_WORDS = ["Tell ", "me ", "more ", "about ", "what ", "you ", "watched."];

const server = http.createServer(async (req, res) => {
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
      const words = script ? script.words : DEFAULT_WORDS;

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
