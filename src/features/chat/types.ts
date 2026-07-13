export type MessageStatus = "pending" | "streaming" | "done" | "error";

export interface FootnoteInfo {
  tone: "success" | "danger" | "neutral";
  text: string;
}

export interface ChatUiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: MessageStatus;
  footnote?: FootnoteInfo;
}
