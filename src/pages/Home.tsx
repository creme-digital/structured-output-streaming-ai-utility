import { Badge, Button, Card, MessageBubble, TextArea } from "../components/ui";
import "./Home.css";

/**
 * Placeholder home screen. Demonstrates the theme + primitives on a static
 * example conversation so the design system is visible end-to-end. The build
 * step replaces the static bubbles with real streamed messages, wires the
 * composer up to the chat function, and adds the auth screens.
 */
export function Home() {
  return (
    <Card className="home-panel" padded={false}>
      <div className="home-panel__scroll">
        <MessageBubble role="assistant">
          Hi! Tell me about a movie you watched and how you felt about it — I'll keep track of it
          for you.
        </MessageBubble>
        <MessageBubble role="user">I loved Inception.</MessageBubble>
        <MessageBubble
          role="assistant"
          footnote={<Badge tone="success">Saved &middot; Inception</Badge>}
        >
          Great pick — Nolan's mind-bending heist thriller. Logging that as a high rating.
        </MessageBubble>
        <MessageBubble role="assistant" streaming>
          This bubble shows the in-progress streaming state
        </MessageBubble>
      </div>

      <form className="home-panel__composer" onSubmit={(event) => event.preventDefault()}>
        <TextArea
          placeholder="Chat is wired up in the next build step..."
          disabled
          aria-label="Message"
        />
        <Button type="submit" disabled>
          Send
        </Button>
      </form>
    </Card>
  );
}
