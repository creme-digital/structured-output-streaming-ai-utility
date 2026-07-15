export type MessageStatus = "pending" | "streaming" | "done" | "error";

export interface FootnoteInfo {
  // "update" (Cycle 4 / FR-009): distinct "rating updated" confirmation for a
  // successful <UPDATE> tag, separate from "success" ("Saved" on <ADD>).
  // "watchlist" (Cycle 6 / FR-005): distinct want-to-watch confirmation for a
  // successful <ADD status="want_to_watch" /> (no rating), separate from all
  // of the above so it's never mistaken for a rated log.
  tone: "success" | "danger" | "neutral" | "update" | "watchlist";
  text: string;
}

/** Cycle 6 / FR-008: a successful, display-only <RECOMMEND> — never persisted. */
export interface RecommendationInfo {
  item: string;
  reason: string;
}

export interface ChatUiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: MessageStatus;
  footnote?: FootnoteInfo;
  recommendation?: RecommendationInfo;
  /**
   * Cycle 7 (history-poisoning fix): for assistant turns, the model-visible form of
   * this message — the raw output with its <ADD>/<UPDATE>/<RECOMMEND> tags intact —
   * mirroring `chat_messages.raw_content`. `undefined` means this assistant turn must
   * be EXCLUDED from the history sent back to the model: compliance misses and
   * malformed-tag turns (whose tag-less prose claims would otherwise teach the model
   * that tags are optional), and legacy rows persisted before raw output was stored.
   * Unused on user turns (`content` is always the model-visible form there).
   */
  modelContent?: string;
}
