import { ReactNode } from "react";
import "./MessageBubble.css";

export type MessageRole = "user" | "assistant";

export interface MessageBubbleProps {
  role: MessageRole;
  children: ReactNode;
  /** Show a blinking caret at the end of the text — the visible cue that tokens are still streaming in (FR-002). */
  streaming?: boolean;
  /** Optional trailing content under the bubble, e.g. a Badge confirming a write, or a fallback notice. */
  footnote?: ReactNode;
}

/**
 * Purely presentational chat bubble. Owns only the visual style from
 * design_direction; the build step supplies real message data, the live
 * streaming buffer, and the tag-parse outcome that feeds `footnote`.
 */
export function MessageBubble({ role, children, streaming, footnote }: MessageBubbleProps) {
  return (
    <div className={`ui-message ui-message--${role}`}>
      <div className="ui-message__bubble">
        {children}
        {streaming && <span className="ui-message__caret" aria-hidden="true" />}
      </div>
      {footnote && <div className="ui-message__footnote">{footnote}</div>}
    </div>
  );
}
