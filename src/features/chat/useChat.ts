import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import { OpenAIStreamDecoder } from "../../lib/sseParser";
import {
  AddTagAttrs,
  createDefaultTagRegistry,
  ExtractResult,
  extractTags,
  RecommendTagAttrs,
  stripTrailingPartialTag,
  UpdateTagAttrs,
} from "../../lib/tagParser";
import {
  countLikelyOpinions,
  findUncapturedOpinionSegments,
  identifyOpinionSegments,
  looksLikeLoggableOpinion,
} from "../../lib/opinionHeuristic";
import { looksLikeRecommendationRequest } from "../../lib/recommendationHeuristic";
import { looksLikeWatchlistIntent } from "../../lib/watchlistHeuristic";
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
  | {
      // PRD v8 / FR-004: a compound multi-opinion message where the model tagged SOME
      // but not all of the distinct opinions it expressed, discovered only after this
      // whole attempt finished streaming (see the "whole-turn retry" note below).
      kind: "partial_multi";
      extract: ExtractResult;
      rawBuffer: string;
      finalDisplay: string;
      missingSegments: string[];
    }
  | { kind: "malformed"; extract: ExtractResult; rawBuffer: string; finalDisplay: string }
  | { kind: "unrecognized_title"; rawBuffer: string; finalDisplay: string }
  | { kind: "no_tag_retryable"; rawBuffer: string }
  | {
      kind: "no_tag_final";
      rawBuffer: string;
      finalDisplay: string;
      missKind: "opinion" | "watchlist" | "recommendation" | null;
    }
  | { kind: "empty"; rawBuffer: string }
  | { kind: "http_error"; detail: string };

/**
 * Drives the whole chat experience: loads persisted history (FR-006), sends a
 * user turn, streams the assistant reply token-by-token (FR-002), extracts
 * `<ADD>`/`<UPDATE>`/`<RECOMMEND>` tags via the generic parser as the stream arrives
 * (FR-003, FR-008, FR-009), and handles every failure mode without ever throwing past
 * this hook (FR-004). `accessToken` (Cycle 4 / FR-009) is optional and, when provided,
 * is forwarded to the edge function so it can read this user's own logged titles
 * (RLS-scoped) for <UPDATE> fuzzy-matching and <RECOMMEND> grounding — omitting it just
 * means <UPDATE>/<RECOMMEND> never fire and every reply falls back to normal <ADD>
 * behavior, never a crash. `hasRatedItems` (Cycle 6 / FR-004/FR-008) tells the missing-
 * <RECOMMEND> classifier whether the user has any rated items at all, so a tag-less
 * reply to "what should I watch?" from a brand-new user is never mislogged as a
 * compliance miss (it's the system prompt's own correct, graceful decline).
 */
export function useChat(userId: string, accessToken?: string, hasRatedItems?: boolean) {
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
        .select("id, role, content, raw_content")
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
          // null raw_content (compliance miss, or a legacy pre-Cycle-7 row) maps to
          // undefined: displayed normally, but excluded from model history below.
          modelContent: (row as { raw_content?: string | null }).raw_content ?? undefined,
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

      // Cycle 7 (history-poisoning fix): the model must see its own past replies WITH
      // their tags (raw output), never the tag-stripped display text — one persisted
      // tag-less "I'll update your rating now" claim is enough few-shot evidence to
      // make the model stop emitting tags for the rest of the conversation (reproduced
      // live; see docs/ARCHITECTURE.md, Cycle 7). Assistant turns with no model-visible
      // form (compliance misses, malformed turns, legacy rows) are dropped entirely —
      // a user turn with no assistant reply is harmless, a poisoned reply is not.
      // PRD v8 / FR-002 (stale-response hardening): `messagesRef.current` reflects
      // whatever the last COMMITTED render saw. In production (a real network await
      // below, unlike a synchronous test mock), React has ample time to commit the
      // `setMessages` call above before this line runs, so `messagesRef.current` may
      // ALREADY include this exact `userMessage` object. Explicitly de-duplicating by id
      // (rather than assuming it's always still absent) guarantees the model is sent
      // this turn's user message exactly once no matter how that timing lands — a
      // latent "send the same turn twice" chat-history mis-assembly risk this cycle's
      // audit found and closed, distinct from (but in the same family as) the stale/
      // cached-response defect this cycle's regression guard targets below.
      const historyForModel = [...messagesRef.current.filter((m) => m.id !== userMessage.id), userMessage]
        .filter((m) => m.status !== "error")
        .filter((m) => m.role === "user" || m.modelContent !== undefined)
        .map((m) => ({ role: m.role, content: m.role === "user" ? m.content : m.modelContent! }));

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
          // PRD v8 / FR-002: explicitly opt out of the HTTP cache. Every turn's request
          // body is already unique (it always carries this turn's full history, see
          // above), so this is defense-in-depth rather than a fix for an observed cache
          // hit — audited and found no caching layer anywhere in this path (no service
          // worker, no HTTP library with its own cache, no Cache-Control response header
          // that would make this a stale revalidation candidate) — but ruling the
          // browser HTTP cache out categorically costs nothing and directly answers the
          // "cached promise" candidate root cause this cycle's work order named.
          cache: "no-store",
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
            // Cycle 7: a clear watch-intent ("I want to watch Toy Story") whose reply
            // carries no <ADD status="want_to_watch" /> gets the same silent-retry
            // safety net as a missed opinion — before this it was completely invisible
            // (no retry, no log, no footnote; found via the live history-poisoning
            // incident, where the model claimed the watchlist add in prose).
            const watchlistLikely = looksLikeWatchlistIntent(trimmed);
            const attemptsRemain = attempt < MAX_ATTEMPTS;
            if ((opinionLikely || watchlistLikely) && attemptsRemain) {
              continue; // silent retry (FR-004 Issue 1, extended in Cycle 6 to also
              // cover rewatch/changed-opinion phrasing) — loop again
            }
            // Either it never looked retry-worthy, or we've exhausted every attempt.
            // Cycle 6 / FR-004 + FR-008: a missed <RECOMMEND> is logged too (as
            // "missing", same as a missed <ADD>/<UPDATE>) but is NOT retried — the PRD
            // only asks for fallback + logging there, not the 2-retry safety net, and
            // `hasRatedItems` gates it so a brand-new user's expected, tag-less "log a
            // few movies first" decline is never mislabeled as a compliance miss.
            const recommendationLikely = hasRatedItems === true && looksLikeRecommendationRequest(trimmed);
            outcome = {
              kind: "no_tag_final",
              rawBuffer: attemptOutcome.rawBuffer,
              finalDisplay: stripTrailingPartialTag(
                extractTags(attemptOutcome.rawBuffer, registryRef.current).cleanedText,
              ).trim(),
              missKind: opinionLikely
                ? "opinion"
                : watchlistLikely
                  ? "watchlist"
                  : recommendationLikely
                    ? "recommendation"
                    : null,
            };
            break;
          }

          if (attemptOutcome.kind === "success") {
            // PRD v8 / FR-003/FR-004: a compound message ("I hated Chicago, but I loved
            // A Star is Born") may come back with tags for only SOME of its distinct
            // opinions — extract.matches.length > 0 alone doesn't mean every opinion was
            // captured. Only apply this check when the user's own message reads as
            // genuinely compound (>= 2 distinct opinion-bearing segments) — a single
            // opinion phrased across a comma/"but" (e.g. "I finally watched Dune, loved
            // it") must NOT be misclassified as "partial": `countLikelyOpinions` returns
            // 1 for that case, so the gate below never fires and existing single-opinion
            // dispatch behavior is unchanged. For a genuinely compound message, compare
            // what was actually tagged against how many opinions were expressed; if some
            // are still unaccounted for, this is the SAME "compliance miss" class FR-004
            // already retries for a fully-missing tag — re-run the WHOLE turn (discarding
            // this attempt entirely, per the dev's confirmed whole-turn-not-per-tag
            // semantics) rather than silently keeping only the opinions that did land.
            const itemMatches = attemptOutcome.extract.matches.filter((m) => m.tag === "ADD" || m.tag === "UPDATE");
            const isCompound = countLikelyOpinions(trimmed) >= 2;
            const missingSegments = isCompound
              ? findUncapturedOpinionSegments(
                  trimmed,
                  itemMatches.map((m) => (m.attrs as { item: string }).item),
                )
              : [];
            const attemptsRemain = attempt < MAX_ATTEMPTS;

            if (missingSegments.length > 0 && attemptsRemain) {
              continue; // whole-turn silent retry — discard this attempt entirely
            }

            outcome =
              missingSegments.length > 0
                ? {
                    kind: "partial_multi",
                    extract: attemptOutcome.extract,
                    rawBuffer: attemptOutcome.rawBuffer,
                    finalDisplay: attemptOutcome.finalDisplay,
                    missingSegments,
                  }
                : attemptOutcome;
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
            // Cycle 7: deliberately no modelContent — replaying a broken tag back to
            // the model as history would teach it the broken syntax.
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
            // A legitimate tag-less reply, so it stays model-visible (Cycle 7).
            await logParseFailure(outcome.rawBuffer, "unrecognized_title");
            updateMessage(assistantId, {
              status: "done",
              content: outcome.finalDisplay,
              modelContent: outcome.rawBuffer,
            });
            break;
          }

          case "no_tag_final": {
            if (outcome.missKind) {
              await logParseFailure(outcome.rawBuffer, "missing");
            }
            // PRD v8 / FR-004: when NOTHING got tagged across all 3 whole-turn attempts
            // and the message reads as compound (>= 2 distinct opinions), name every
            // opinion that went uncaptured instead of the generic single-opinion
            // fallback — "no silent drops" applies just as much to the fully-missed case
            // as to the partially-missed one. A genuinely single-opinion miss keeps the
            // exact pre-existing generic text (compoundSegments.length is 1 there).
            const compoundSegments = outcome.missKind === "opinion" ? identifyOpinionSegments(trimmed) : [];
            const footnote: FootnoteInfo | undefined =
              outcome.missKind === "opinion"
                ? compoundSegments.length > 1
                  ? { tone: "neutral", text: `Didn't catch: ${compoundSegments.map((s) => `"${s}"`).join(", ")}` }
                  : { tone: "neutral", text: "Didn't catch an item to log there." }
                : outcome.missKind === "watchlist"
                  ? { tone: "neutral", text: "Didn't catch a watchlist add there." }
                  : outcome.missKind === "recommendation"
                    ? { tone: "neutral", text: "Didn't catch a recommendation there." }
                    : undefined;
            // Cycle 7: a compliance miss (missKind set) is displayed but NEVER shown
            // back to the model — its tag-less prose claim is exactly the poison that
            // caused the self-reinforcing history bug. An ordinary conversational
            // reply (missKind null) is a legitimate tag-less turn and stays visible.
            updateMessage(assistantId, {
              status: "done",
              content: outcome.finalDisplay,
              footnote,
              modelContent: outcome.missKind === null ? outcome.rawBuffer : undefined,
            });
            break;
          }

          case "success":
          case "partial_multi": {
            // Cycle 6 / FR-003/FR-008: <ADD>/<UPDATE> write a row; <RECOMMEND> is
            // display-only (FR-008) and never touches the database, so the two tag
            // families are dispatched independently here. PRD v8 / FR-004: "partial_multi"
            // reaches here too — the opinions that DID get tagged are written exactly
            // like a full success (never silently discarded just because a sibling
            // opinion in the same compound message didn't resolve); the ones that didn't
            // are surfaced below instead.
            const itemMatches = outcome.extract.matches.filter((m) => m.tag === "ADD" || m.tag === "UPDATE");
            const recommendMatches = outcome.extract.matches.filter((m) => m.tag === "RECOMMEND");

            let footnote: FootnoteInfo | undefined;

            if (itemMatches.length > 0) {
              /**
               * Cycle 8 (dev-directed): <UPDATE> is now a TRUE in-place update, not a
               * fresh insert — the dev explicitly reversed Cycle 4's keep-every-row
               * design after seeing duplicate entries live ("I want the update to be a
               * true update rather than a new log"). `008_items_true_update.sql` adds
               * the RLS update policy and deduped the rows the old behavior produced.
               *
               * The target row is found by title, case-insensitively (the model is
               * told to reuse the reference-list spelling verbatim, but ilike keeps a
               * stray case difference from silently missing; wildcards are escaped so
               * a title containing % or _ still matches literally). The want-to-watch
               * -> watched transition (Cycle 6 / FR-009) now flips that same row's
               * status and fills in its rating. If no row exists at all — the model
               * emitted <UPDATE> for a never-logged title — fall back to the old
               * insert so the user's rating is never dropped on the floor.
               */
              async function applyItemMatch(
                match: (typeof itemMatches)[number],
              ): Promise<{ error: { message: string } | null }> {
                if (match.tag === "ADD") {
                  const attrs = match.attrs as unknown as AddTagAttrs;
                  return supabase.from("items").insert({
                    user_id: userId,
                    item: attrs.item,
                    rating: attrs.rating,
                    category: "movies",
                    raw_user_text: trimmed,
                    status: attrs.status,
                  });
                }

                const attrs = match.attrs as unknown as UpdateTagAttrs;
                const escapedTitle = attrs.item.replace(/([\\%_])/g, "\\$1");
                const { data: existingRows, error: findError } = await supabase
                  .from("items")
                  .select("id")
                  .eq("user_id", userId)
                  .ilike("item", escapedTitle)
                  .order("created_at", { ascending: false })
                  .limit(1);

                const existingId =
                  !findError && existingRows && existingRows.length > 0
                    ? (existingRows[0] as { id: string }).id
                    : null;

                if (existingId) {
                  return supabase
                    .from("items")
                    .update({ rating: attrs.rating, status: "watched", raw_user_text: trimmed })
                    .eq("id", existingId)
                    .eq("user_id", userId);
                }

                return supabase.from("items").insert({
                  user_id: userId,
                  item: attrs.item,
                  rating: attrs.rating,
                  category: "movies",
                  raw_user_text: trimmed,
                  status: "watched",
                });
              }

              const writeResults = await Promise.all(itemMatches.map(applyItemMatch));

              const failedInsert = writeResults.find((r) => r.error);

              if (failedInsert) {
                await logParseFailure(outcome.rawBuffer, "other");
                footnote = { tone: "danger", text: "Couldn't save that item — logged for review." };
              } else {
                const watchedNames = itemMatches
                  .filter((m) => m.tag === "ADD" && (m.attrs as unknown as AddTagAttrs).status === "watched")
                  .map((m) => (m.attrs as unknown as AddTagAttrs).item);
                const watchlistNames = itemMatches
                  .filter((m) => m.tag === "ADD" && (m.attrs as unknown as AddTagAttrs).status === "want_to_watch")
                  .map((m) => (m.attrs as unknown as AddTagAttrs).item);
                const updateNames = itemMatches
                  .filter((m) => m.tag === "UPDATE")
                  .map((m) => (m.attrs as unknown as UpdateTagAttrs).item);

                const parts: FootnoteInfo[] = [];
                if (watchedNames.length) parts.push({ tone: "success", text: `Saved · ${watchedNames.join(", ")}` });
                if (watchlistNames.length)
                  // Cycle 6 / FR-005: a distinct want-to-watch marker, never confused
                  // with a rated "Saved" log or an <UPDATE> "Rating updated" badge.
                  parts.push({ tone: "watchlist", text: `Want to watch · ${watchlistNames.join(", ")}` });
                if (updateNames.length)
                  // Cycle 4 / FR-009: distinct "rating updated" confirmation.
                  parts.push({ tone: "update", text: `Rating updated · ${updateNames.join(", ")}` });

                if (parts.length === 1) {
                  footnote = parts[0];
                } else if (parts.length > 1) {
                  // PRD v8 / FR-003: the system prompt now explicitly asks for one
                  // <ADD>/<UPDATE> tag PER distinct opinion in a compound message, so
                  // multiple parts here is the expected common case (not just a
                  // defensive fallback) — surface every confirmation, never collapse or
                  // silently drop one.
                  footnote = { tone: parts[0].tone, text: parts.map((p) => p.text).join(" · ") };
                }
              }
            }

            if (outcome.kind === "partial_multi") {
              // PRD v8 / FR-004: after MAX_ATTEMPTS whole-turn retries, this compound
              // message still has opinions the model never tagged. Never drop them
              // silently — log it (same "missing" reason a fully-missed tag gets) and
              // fold a visible, named callout into the footnote alongside whatever DID
              // get saved above.
              await logParseFailure(outcome.rawBuffer, "missing");
              const missNote: FootnoteInfo = {
                tone: "neutral",
                text: `Didn't catch: ${outcome.missingSegments.map((s) => `"${s}"`).join(", ")}`,
              };
              footnote = footnote
                ? { tone: footnote.tone, text: `${footnote.text} · ${missNote.text}` }
                : missNote;
            }

            // Cycle 6 / FR-008: fire-and-forget, display-only — no DB write, rendered
            // as a distinct card (ChatPanel.tsx) rather than the footnote pill.
            const recommendation =
              recommendMatches.length > 0
                ? (recommendMatches[0].attrs as unknown as RecommendTagAttrs)
                : undefined;

            updateMessage(assistantId, {
              status: "done",
              content: outcome.finalDisplay,
              footnote,
              recommendation,
              modelContent: outcome.rawBuffer,
            });
            break;
          }
        }

        const persistedContent =
          outcome.kind === "malformed" || outcome.kind === "unrecognized_title" || outcome.kind === "no_tag_final"
            ? outcome.finalDisplay
            : outcome.kind === "success" || outcome.kind === "partial_multi"
              ? outcome.finalDisplay
              : undefined;

        if (persistedContent !== undefined) {
          // Cycle 7: persist the model-visible form alongside the cleaned display text,
          // mirroring the modelContent rules applied to the in-session message above —
          // raw output (tags intact) for healthy turns, NULL for compliance misses and
          // malformed turns so they are never replayed to the model as history.
          const persistedRawContent =
            outcome.kind === "success" ||
            outcome.kind === "partial_multi" ||
            outcome.kind === "unrecognized_title" ||
            (outcome.kind === "no_tag_final" && outcome.missKind === null)
              ? outcome.rawBuffer
              : null;
          const { error: assistantInsertError } = await supabase.from("chat_messages").insert({
            user_id: userId,
            role: "assistant",
            content: persistedContent,
            raw_content: persistedRawContent,
          });
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
    [sending, userId, accessToken, hasRatedItems, updateMessage, logParseFailure],
  );

  return { messages, historyStatus, sending, sendMessage };
}
