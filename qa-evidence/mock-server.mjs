// QA-only local server: serves the production build (dist/) exactly like Netlify would,
// and stands in for the netlify/edge-functions/chat.ts edge function at POST /api/chat
// with a REAL chunked SSE stream (written with delays) matching OpenAI's exact wire
// format, since no OPENAI_API_KEY is available in this sandbox. Every other layer
// (useChat.ts, sseParser.ts, tagParser.ts, ChatPanel.tsx, HistoryPanel.tsx, Supabase
// reads/writes/realtime) is the real, unmodified production code path, running against
// the real client Supabase project.
//
// Cycle 6 (PRD v7) QA update: added scripted scenarios for this cycle's amended/added
// behavior — want-to-watch <ADD status="want_to_watch">, the want-to-watch -> watched
// <UPDATE> transition, and the on-request <RECOMMEND> tag (FR-001/FR-003/FR-005/FR-008/
// FR-009/FR-010) — alongside the still-in-regression-scope scenarios carried from prior
// cycles (malformed/missing tags, unrecognized title, retry loop, adversarial input).
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
    // Cycle 6 / FR-001, FR-003, FR-005: future-intent, no rating -> want-to-watch <ADD>.
    match: /want to watch dune/i,
    words: ["Got ", "it, ", "added ", "to ", "your ", "watchlist! ", '<ADD item="Dune" status="want_to_watch" />'],
  },
  {
    // Cycle 6 / FR-009: the want-to-watch -> watched transition — a first real opinion
    // on a previously want-to-watch title is a re-mention, so it's <UPDATE>, not <ADD>.
    match: /finally watched dune/i,
    words: ["Awesome, ", "glad ", "you ", "got ", "to ", "it! ", '<UPDATE item="Dune" rating="5" />'],
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
    // Cycle 6 / FR-004 bug fix: rewatch/changed-opinion phrasing that the model claims
    // to act on in prose but NEVER emits a tag for, across all 3 attempts -> the
    // extended opinion-heuristic must still catch this as a retry-then-fallback-and-log
    // case (this is exactly the dev-reported "claimed but not written" defect).
    match: /rewatchclaimprobe/i,
    words: (call) => ["I'll ", "update ", "your ", "rating ", "now ", `(attempt ${call}).`],
  },
  {
    match: /movie was okay/i,
    words: ["Sounds ", "like ", "a ", "mixed ", "bag ", "- ", "which ", "movie ", "was ", "it?"],
  },
  {
    match: /write your essay|ignore previous instructions/i,
    words: ["I'm ", "just ", "here ", "to ", "chat ", "about ", "movies ", "- ", "what ", "have ", "you ", "watched ", "lately?"],
  },
  {
    // Cycle 6 / FR-001, FR-003, FR-008: on-request recommendation, grounded + display-only.
    match: /what should i watch next/i,
    words: [
      "Since ",
      "you ",
      "loved ",
      "Inception, ",
      "you ",
      "might ",
      "enjoy ",
      "this ",
      "one: ",
      '<RECOMMEND item="Tenet" reason="Another mind-bending Christopher Nolan film with similar themes." />',
    ],
  },
  {
    // FR-004/FR-008: recommendation requested but the user has no rated items yet ->
    // graceful decline, no tag, no fabricated pick.
    match: /recommend something for a brand new user/i,
    words: [
      "I ",
      "don't ",
      "have ",
      "enough ",
      "of ",
      "your ",
      "taste ",
      "to ",
      "go ",
      "on ",
      "yet ",
      "— ",
      "log ",
      "a ",
      "few ",
      "movies ",
      "first ",
      "and ",
      "I'll ",
      "have ",
      "a ",
      "pick ",
      "for ",
      "you!",
    ],
  },

  // ================= PRD v8 (Cycle 8) scenarios =================
  {
    // FR-001/FR-004: sentiment-only phrasing, no explicit number/rating word. The model
    // misses the tag on its first 2 attempts and complies on the 3rd - proves the
    // EXTENDED opinion-heuristic (previously this class of phrasing produced NO
    // parse_failures row at all, meaning the retry safety net never engaged; now it
    // does) recovers a compliance miss exactly like an explicit-rating phrasing would.
    match: /hated barbie/i,
    words: (call) => {
      if (call < 3) return ["That's ", "understandable ", "- ", "not ", "every ", "movie ", `clicks (attempt ${call}).`];
      return ["Got ", "it, ", "noted. ", '<ADD item="Barbie" rating="1" />'];
    },
  },
  {
    // FR-001/FR-004: sentiment-only phrasing that NEVER resolves across all 3 attempts ->
    // must still fall through to fallback + parse_failures (reason "missing"), closing
    // the confirmed defect where sentiment-only misses produced NO parse_failures row.
    match: /disliked cats/i,
    words: (call) => ["Fair ", "enough, ", "tastes ", "vary ", `(attempt ${call}).`],
  },
  {
    // FR-001: mainstream real film that a prior over-correcting gate would have wrongly
    // vetoed - proves the client dispatch path has no hardcoded title gate of its own
    // and logs it exactly like any other recognized <ADD>.
    match: /loved the big short/i,
    words: ["Great ", "pick! ", '<ADD item="The Big Short" rating="5" />'],
  },
  {
    // FR-001: a genuinely fabricated sequel title must still correctly trigger the
    // unrecognized-title clarification path (proves the fix didn't just make the model
    // accept everything).
    match: /point break 2 was amazing/i,
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
      "- ",
      "could ",
      "you ",
      "double-check ",
      "the ",
      "title?",
    ],
  },
  {
    // FR-001/FR-003/FR-004: compound two-opinion message, both tags land in one attempt.
    match: /hated chicago, but i loved a star is born/i,
    words: [
      "Noted ",
      "both! ",
      '<ADD item="Chicago" rating="1" /> ',
      '<ADD item="A Star Is Born" rating="5" />',
    ],
  },
  {
    // FR-001/FR-003/FR-004: compound message that's only partially tagged on the first
    // whole-turn attempt, then fully resolves on the retry - proves whole-turn (not
    // per-tag) retry semantics.
    match: /hated her, but loved dunkirk/i,
    words: (call) => {
      if (call === 1) return ["Noted ", "the ", "Dunkirk ", "one. ", '<ADD item="Dunkirk" rating="5" />'];
      return ["Got ", "both ", "down. ", '<ADD item="Her" rating="1" /> ', '<ADD item="Dunkirk" rating="5" />'];
    },
  },
  {
    // FR-001/FR-003/FR-004: compound message where one opinion NEVER resolves across all
    // 3 whole-turn attempts -> the opinion that DID resolve is still saved, and the
    // unresolved one is visibly named in the fallback, never silently dropped. Both
    // segments must independently read as opinions to the client heuristic (unlike a
    // vague "felt nothing" clause), so "hated Aftersun" is used deliberately.
    match: /loved interstellar, but hated aftersun/i,
    words: (call) => ["Noted ", "the ", "Interstellar ", "one. ", '<ADD item="Interstellar" rating="5" />'],
  },
  {
    // PRD v8 / FR-002 stale-response regression repro: an unrelated first turn about a
    // fabricated title...
    match: /obsession \(2026\) in the backrooms/i,
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
      "- ",
      "could ",
      "you ",
      "double-check ",
      "the ",
      "title?",
    ],
  },
  {
    // ...followed by a completely unrelated second turn. The confirmed live bug replayed
    // the FIRST turn's clarification verbatim for this message; a fresh call must
    // produce this distinct scripted reply instead.
    match: /wolfs was just ok/i,
    words: ["Glad ", "it ", "was ", "decent ", "- ", 'thanks for sharing! <ADD item="Wolfs" rating="3" />'],
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
