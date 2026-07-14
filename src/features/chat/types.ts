export type MessageStatus = "pending" | "streaming" | "done" | "error";

export interface FootnoteInfo {
  // "update" (Cycle 4 / FR-009): distinct "rating updated" confirmation for a
  // successful <UPDATE> tag, separate from "success" ("Saved" on <ADD>).
  tone: "success" | "danger" | "neutral" | "update";
  text: string;
}

export interface ChatUiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: MessageStatus;
  footnote?: FootnoteInfo;
}
