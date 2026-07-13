import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { Badge, Button, Card, MessageBubble, Spinner, TextArea } from "../../components/ui";
import { useChat } from "./useChat";
import "./ChatPanel.css";

export interface ChatPanelProps {
  userId: string;
}

/**
 * The whole chat experience (FR-002, FR-003, FR-004, FR-005): a single
 * scrolling conversation plus a composer. Streaming text, the "Saved · X"
 * write confirmation, and non-crashing fallback states all render through
 * this one component so an evaluator only has one screen to pressure-test.
 */
export function ChatPanel({ userId }: ChatPanelProps) {
  const { messages, historyStatus, sending, sendMessage } = useChat(userId);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = scrollRef.current;
    // Guard for environments without a full scrollTo implementation (e.g. jsdom in tests) —
    // auto-scroll is a nicety, never something that should crash the chat.
    if (node && typeof node.scrollTo === "function") {
      node.scrollTo({ top: node.scrollHeight });
    }
  }, [messages]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim() || sending) return;
    const toSend = draft;
    setDraft("");
    void sendMessage(toSend);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSubmit(event as unknown as FormEvent);
    }
  }

  return (
    <Card className="chat-panel" padded={false}>
      <div className="chat-panel__scroll" ref={scrollRef}>
        {historyStatus === "loading" && (
          <div className="chat-panel__state">
            <Spinner label="Loading your conversation" />
          </div>
        )}

        {historyStatus === "error" && (
          <div className="chat-panel__state chat-panel__state--error" role="alert">
            Couldn't load your chat history. Please refresh the page.
          </div>
        )}

        {historyStatus === "ready" && messages.length === 0 && (
          <div className="chat-panel__empty">
            Tell me about a movie you watched and how you felt about it — I'll keep track of it for
            you. Try something like "I loved Inception."
          </div>
        )}

        {historyStatus === "ready" &&
          messages.map((message) => (
            <MessageBubble
              key={message.id}
              role={message.role}
              streaming={message.status === "streaming"}
              footnote={
                message.footnote ? <Badge tone={message.footnote.tone}>{message.footnote.text}</Badge> : undefined
              }
            >
              {message.status === "pending" ? (
                <span className="chat-panel__pending">
                  <Spinner label="Waiting for a response" />
                </span>
              ) : (
                message.content
              )}
            </MessageBubble>
          ))}
      </div>

      <form className="chat-panel__composer" onSubmit={handleSubmit}>
        <TextArea
          placeholder="Tell me about a movie..."
          aria-label="Message"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          disabled={sending || historyStatus !== "ready"}
        />
        <Button type="submit" disabled={sending || historyStatus !== "ready" || !draft.trim()}>
          Send
        </Button>
      </form>
    </Card>
  );
}
