import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import { OpenAIStreamDecoder } from "../../lib/sseParser";
import {
  AddTagAttrs,
  createDefaultTagRegistry,
  extractTags,
  stripTrailingPartialTag,
} from "../../lib/tagParser";
import { looksLikeLoggableOpinion } from "../../lib/opinionHeuristic";
import { ChatUiMessage, FootnoteInfo } from "./types";

export type HistoryStatus = "loading" | "ready" | "error";

type ParseFailureReason = "malformed" | "missing" | "other";

/**
 * Drives the whole chat experience: loads persisted history (FR-006), sends a
 * user turn, streams the assistant reply token-by-token (FR-002), extracts
 * `<ADD>` tags via the generic parser as the stream arrives (FR-003), and
 * handles every failure mode without ever throwing past this hook (FR-004).
 */
export function useChat(userId: string) {
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

      let rawBuffer = "";

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages: historyForModel }),
        });

        if (!response.ok || !response.body) {
          const detail = await response.text().catch(() => "");
          await logParseFailure(detail || `HTTP ${response.status}`, "other");
          updateMessage(assistantId, {
            status: "error",
            content: "Sorry, I couldn't reach the assistant just now. Please try again in a moment.",
            footnote: { tone: "danger", text: "Couldn't reach the assistant" },
          });
          return;
        }

        updateMessage(assistantId, { status: "streaming" });

        const streamDecoder = new OpenAIStreamDecoder();
        const textDecoder = new TextDecoder();
        const reader = response.body.getReader();

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          const chunkText = textDecoder.decode(value, { stream: true });
          const { deltas, done: sawDone } = streamDecoder.feed(chunkText);

          if (deltas.length > 0) {
            rawBuffer += deltas.join("");
            const liveDisplay = stripTrailingPartialTag(
              extractTags(rawBuffer, registryRef.current).cleanedText,
            );
            updateMessage(assistantId, { content: liveDisplay });
          }

          if (sawDone) break;
        }

        const finalExtract = extractTags(rawBuffer, registryRef.current);
        const finalDisplay = stripTrailingPartialTag(finalExtract.cleanedText).trim();

        if (!finalDisplay) {
          await logParseFailure(rawBuffer || "(empty response)", "other");
          updateMessage(assistantId, {
            status: "error",
            content: "I didn't get a response that time — please try again.",
            footnote: { tone: "danger", text: "No response received" },
          });
          return;
        }

        let footnote: FootnoteInfo | undefined;

        if (finalExtract.matches.length > 0) {
          const insertResults = await Promise.all(
            finalExtract.matches.map((match) => {
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
          if (failedInsert) {
            await logParseFailure(rawBuffer, "other");
            footnote = { tone: "danger", text: "Couldn't save that item — logged for review." };
          } else {
            const savedNames = finalExtract.matches
              .map((m) => (m.attrs as unknown as AddTagAttrs).item)
              .join(", ");
            footnote = { tone: "success", text: `Saved · ${savedNames}` };
          }
        } else if (finalExtract.malformed.length > 0) {
          await logParseFailure(rawBuffer, "malformed");
          footnote = { tone: "danger", text: "Couldn't log that — logged for review." };
        } else if (looksLikeLoggableOpinion(trimmed)) {
          await logParseFailure(rawBuffer, "missing");
          footnote = { tone: "neutral", text: "Didn't catch an item to log there." };
        }

        updateMessage(assistantId, { status: "done", content: finalDisplay, footnote });

        const { error: assistantInsertError } = await supabase
          .from("chat_messages")
          .insert({ user_id: userId, role: "assistant", content: finalDisplay });
        if (assistantInsertError) {
          console.error("Failed to persist assistant message:", assistantInsertError.message);
        }
      } catch {
        await logParseFailure(rawBuffer || "(no output captured before error)", "other").catch(() => {
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
    [sending, userId, updateMessage, logParseFailure],
  );

  return { messages, historyStatus, sending, sendMessage };
}
