import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import { OpenAIStreamDecoder } from "../../lib/sseParser";
import {
  AddTagAttrs,
  createDefaultTagRegistry,
  ExtractResult,
  extractTags,
  stripTrailingPartialTag,
} from "../../lib/tagParser";
import { looksLikeLoggableOpinion } from "../../lib/opinionHeuristic";
import { looksLikeUnrecognizedTitleClarification } from "../../lib/titleClarificationHeuristic";
import { ChatUiMessage, FootnoteInfo } from "./types";

export type HistoryStatus = "loading" | "ready" | "error";

type ParseFailureReason = "malformed" | "missing" | "other" | "unrecognized_title";

/**
 * Cycle 4 / FR-004 Issue 1: when the opinion-heuristic fires but a full attempt
 * completes with no <ADD>/<UPDATE> tag, silently retry up to this many additional
 * times (discarding each failed attempt) before falling through to the existing
 * fallback + `parse_failures` log. 1 original attempt + 2 retries = 3 total.
 */
const MAX_ATTEMPTS = 3;

/**
 * Outcome of one fully-consumed attempt at the assistant's reply. Deliberately has NO
 * "network error" member — a thrown exception (fetch rejecting, the stream reader
 * throwing mid-read, etc.) is left to propagate to `sendMessage`'s own top-level
 * try/catch, exactly as in the pre-Cycle-4 implementation, so that fallback path's
 * behavior (message text, footnote, logged reason) is unchanged by this refactor.
 */
type AttemptOutcome =
  | { kind: "success"; extract: ExtractResult; rawBuffer: string; finalDisplay: string }
  | { kind: "malformed"; extract: ExtractResult; rawBuffer: string; finalDisplay: string }
  | { kind: "unrecognized_title"; rawBuffer: string; finalDisplay: string }
  | { kind: "no_tag_retryable"; rawBuffer: string }
  | { kind: "no_tag_final"; rawBuffer: string; finalDisplay: string; loggedAsMissing: boolean }
  | { kind: "empty"; rawBuffer: string }
  | { kind: "http_error"; detail: string };

/**
 * Drives the whole chat experience: loads persisted history (FR-006), sends a
 * user turn, streams the assistant reply token-by-token (FR-002), extracts
 * `<ADD>`/`<UPDATE>` tags via the generic parser as the stream arrives (FR-003,
 * FR-009), and handles every failure mode without ever throwing past this hook
 * (FR-004). `accessToken` (Cycle 4 / FR-009) is optional and, when provided, is
 * forwarded to the edge function so it can read this user's own logged titles
 * (RLS-scoped) for <UPDATE> fuzzy-matching — omitting it just means <UPDATE>
 * never fires and every reply falls back to normal <ADD> behavior, never a crash.
 */
export function useChat(userId: string, accessToken?: string) {
  const [messages, setMessages] = useState<ChatUiMessage[]>([]);
  const [historyStatus, setHistoryStatus] = useState<HistoryStatus>("loading");
  const [sending, setSending] = useState(false);

  const messagesRef = useRef<ChatUiMessage[]>([]);
  messagesRef.current = messages;

  const registryRef = useRef(createDefaultTagRegistry());

  useEffect(() => {
    let cancelled = false;

    async function loadHistory() {
      setHistoryStatus("loading");
      const { data, error } = await supabase
        .from("chat_messages")
        .select("id, role, content")
        .eq("user_id", userId)
        .order("created_at", { ascending: true });

      if (cancelled) return;
      if (error) {
        setHistoryStatus("error");
        return;
      }

      setMessages(
        (data ?? []).map((row) => ({
          id: row.id as string,
          role: row.role as "user" | "assistant",
          content: row.content as string,
          status: "done" as const,
        })),
      );
      setHistoryStatus("ready");
    }

    loadHistory();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const updateMessage = useCallback((id: string, patch: Partial<ChatUiMessage>) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }, []);

  const logParseFailure = useCallback(
    async (rawOutput: string, reason: ParseFailureReason) => {
      const { error } = await supabase
        .from("parse_failures")
        .insert({ user_id: userId, raw_output: rawOutput, reason });
      if (error) {
        // The failure log itself failed to write — nothing further we can safely do here
        // without risking an unhandled rejection; the user-facing fallback still renders.
        console.error("Failed to log parse failure:", error.message);
      }
    },
    [userId],
  );

  const sendMessage = useCallback(
    async (rawText: string) => {
      const trimmed = rawText.trim();
      if (!trimmed || sending) return;

      setSending(true);

      const userMessage: ChatUiMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: trimmed,
        status: "done",
      };
      const assistantId = crypto.randomUUID();
      const assistantPlaceholder: ChatUiMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
        status: "pending",
      };

      setMessages((prev) => [...prev, userMessage, assistantPlaceholder]);

      const { error: userInsertError } = await supabase
        .from("chat_messages")
        .insert({ user_id: userId, role: "user", content: trimmed });

      if (userInsertError) {
        updateMessage(assistantId, {
          status: "error",
          content: "Sorry — I couldn't save your message. Please check your connection and try again.",
          footnote: { tone: "danger", text: "Not saved" },
        });
        setSending(false);
        return;
      }

      const historyForModel = [...messagesRef.current, userMessage]
        .filter((m) => m.status !== "error")
        .map((m) => ({ role: m.role, content: m.content }));

      // Tracks the most recently-seen partial buffer across attempts so the top-level
      // catch below can still log *something* useful if an exception interrupts an
      // in-progress stream read, matching the pre-Cycle-4 behavior of logging whatever
      // had been buffered before the failure (rather than only ever the empty string).
      const lastRawBufferRef = { current: "" };

      /**
       * Runs exactly one attempt at the assistant's reply: fetch, stream-decode,
       * progressively update the visible bubble, then classify what happened. Does
       * NOT log to parse_failures or finalize UI state beyond the bubble's own
       * content/status — that's the caller's job once it knows whether this attempt
       * is being kept or silently discarded and retried (FR-004 Issue 1).
       */
      async function runAttempt(): Promise<AttemptOutcome> {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messages: historyForModel,
            ...(accessToken ? { accessToken } : {}),
          }),
        });

        if (!response.ok || !response.body) {
          const detail = await response.text().catch(() => "");
          return { kind: "http_error", detail: detail || `HTTP ${response.status}` };
        }

        updateMessage(assistantId, { status: "streaming" });

        const streamDecoder = new OpenAIStreamDecoder();
        const textDecoder = new TextDecoder();
        const reader = response.body.getReader();
        let rawBuffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          const chunkText = textDecoder.decode(value, { stream: true });
          const { deltas, done: sawDone } = streamDecoder.feed(chunkText);

          if (deltas.length > 0) {
            rawBuffer += deltas.join("");
            lastRawBufferRef.current = rawBuffer;
            const liveDisplay = stripTrailingPartialTag(
              extractTags(rawBuffer, registryRef.current).cleanedText,
            );
            updateMessage(assistantId, { content: liveDisplay });
          }

          if (sawDone) break;
        }

        const extract = extractTags(rawBuffer, registryRef.current);
        const finalDisplay = stripTrailingPartialTag(extract.cleanedText).trim();

        if (!finalDisplay) {
          return { kind: "empty", rawBuffer };
        }

        if (extract.matches.length > 0) {
          return { kind: "success", extract, rawBuffer, finalDisplay };
        }

        if (extract.malformed.length > 0) {
          return { kind: "malformed", extract, rawBuffer, finalDisplay };
        }

        if (looksLikeUnrecognizedTitleClarification(finalDisplay)) {
          return { kind: "unrecognized_title", rawBuffer, finalDisplay };
        }

        return { kind: "no_tag_retryable", rawBuffer };
      }

      try {
        // Definite-assignment: the loop below always assigns `outcome` before it exits
        // (every branch either `continue`s to retry or assigns-then-`break`s) — there is
        // no fall-through path that leaves it unset.
        let outcome!: AttemptOutcome;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          if (attempt > 1) {
            // Discard the previous attempt entirely — the user never sees it — and
            // show the pending/waiting state again while the silent retry runs.
            updateMessage(assistantId, { status: "pending", content: "" });
          }

          const attemptOutcome = await runAttempt();

          if (attemptOutcome.kind === "no_tag_retryable") {
            const opinionLikely = looksLikeLoggableOpinion(trimmed);
            const attemptsRemain = attempt < MAX_ATTEMPTS;
            if (opinionLikely && attemptsRemain) {
              continue; // silent retry (FR-004 Issue 1) — loop again
            }
            // Either it never looked retry-worthy, or we've exhausted every attempt.
            outcome = {
              kind: "no_tag_final",
              rawBuffer: attemptOutcome.rawBuffer,
              finalDisplay: stripTrailingPartialTag(
                extractTags(attemptOutcome.rawBuffer, registryRef.current).cleanedText,
              ).trim(),
              loggedAsMissing: opinionLikely,
            };
            break;
          }

          outcome = attemptOutcome;
          break;
        }

        switch (outcome.kind) {
          case "http_error": {
            await logParseFailure(outcome.detail, "other");
            updateMessage(assistantId, {
              status: "error",
              content: "Sorry, I couldn't reach the assistant just now. Please try again in a moment.",
              footnote: { tone: "danger", text: "Couldn't reach the assistant" },
            });
            return;
          }

          case "empty": {
            await logParseFailure(outcome.rawBuffer || "(empty response)", "other");
            updateMessage(assistantId, {
              status: "error",
              content: "I didn't get a response that time — please try again.",
              footnote: { tone: "danger", text: "No response received" },
            });
            return;
          }

          case "malformed": {
            await logParseFailure(outcome.rawBuffer, "malformed");
            updateMessage(assistantId, {
              status: "done",
              content: outcome.finalDisplay,
              footnote: { tone: "danger", text: "Couldn't log that — logged for review." },
            });
            break;
          }

          case "unrecognized_title": {
            // Expected, non-failure behavior (FR-001 Issue 2) — the model correctly
            // declined to guess at a title it doesn't recognize. Still logged for
            // visibility/analytics (FR-004), but not surfaced as an error to the user.
            await logParseFailure(outcome.rawBuffer, "unrecognized_title");
            updateMessage(assistantId, { status: "done", content: outcome.finalDisplay });
            break;
          }

          case "no_tag_final": {
            if (outcome.loggedAsMissing) {
              await logParseFailure(outcome.rawBuffer, "missing");
            }
            updateMessage(assistantId, {
              status: "done",
              content: outcome.finalDisplay,
              footnote: outcome.loggedAsMissing
                ? { tone: "neutral", text: "Didn't catch an item to log there." }
                : undefined,
            });
            break;
          }

          case "success": {
            const insertResults = await Promise.all(
              outcome.extract.matches.map((match) => {
                const attrs = match.attrs as unknown as AddTagAttrs;
                return supabase.from("items").insert({
                  user_id: userId,
                  item: attrs.item,
                  rating: attrs.rating,
                  category: "movies",
                  raw_user_text: trimmed,
                });
              }),
            );

            const failedInsert = insertResults.find((r) => r.error);
            let footnote: FootnoteInfo;

            if (failedInsert) {
              await logParseFailure(outcome.rawBuffer, "other");
              footnote = { tone: "danger", text: "Couldn't save that item — logged for review." };
            } else {
              const addNames = outcome.extract.matches
                .filter((m) => m.tag === "ADD")
                .map((m) => (m.attrs as unknown as AddTagAttrs).item);
              const updateNames = outcome.extract.matches
                .filter((m) => m.tag === "UPDATE")
                .map((m) => (m.attrs as unknown as AddTagAttrs).item);

              if (updateNames.length > 0 && addNames.length === 0) {
                // Cycle 4 / FR-009: distinct "rating updated" confirmation, visually
                // different from the <ADD> "Saved" badge (FR-005).
                footnote = { tone: "update", text: `Rating updated · ${updateNames.join(", ")}` };
              } else if (addNames.length > 0 && updateNames.length === 0) {
                footnote = { tone: "success", text: `Saved · ${addNames.join(", ")}` };
              } else {
                // Defensive: the system prompt asks for at most one tag per reply, but
                // don't assume — surface both confirmations rather than dropping one.
                const parts: string[] = [];
                if (addNames.length) parts.push(`Saved · ${addNames.join(", ")}`);
                if (updateNames.length) parts.push(`Rating updated · ${updateNames.join(", ")}`);
                footnote = { tone: "update", text: parts.join(" · ") };
              }
            }

            updateMessage(assistantId, { status: "done", content: outcome.finalDisplay, footnote });
            break;
          }
        }

        const persistedContent =
          outcome.kind === "malformed" || outcome.kind === "unrecognized_title" || outcome.kind === "no_tag_final"
            ? outcome.finalDisplay
            : outcome.kind === "success"
              ? outcome.finalDisplay
              : undefined;

        if (persistedContent !== undefined) {
          const { error: assistantInsertError } = await supabase
            .from("chat_messages")
            .insert({ user_id: userId, role: "assistant", content: persistedContent });
          if (assistantInsertError) {
            console.error("Failed to persist assistant message:", assistantInsertError.message);
          }
        }
      } catch {
        await logParseFailure(lastRawBufferRef.current || "(no output captured before error)", "other").catch(() => {
          // Best-effort only — never let a logging failure surface as an unhandled rejection.
        });
        updateMessage(assistantId, {
          status: "error",
          content: "Sorry, something went wrong on my end. Please try again.",
          footnote: { tone: "danger", text: "Something went wrong" },
        });
      } finally {
        setSending(false);
      }
    },
    [sending, userId, accessToken, updateMessage, logParseFailure],
  );

  return { messages, historyStatus, sending, sendMessage };
}
