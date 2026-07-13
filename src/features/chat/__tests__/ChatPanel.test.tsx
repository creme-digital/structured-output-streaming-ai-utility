import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabaseTables } from "../../../test/mockSupabase";

let fakeSupabase: ReturnType<typeof createFakeSupabaseTables>;

vi.mock("../../../lib/supabaseClient", () => ({
  supabase: {
    get from() {
      return fakeSupabase.from;
    },
  },
}));

const { ChatPanel } = await import("../ChatPanel");

function streamingResponse(fullText: string): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: fullText } }] })}\n\n`),
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

beforeEach(() => {
  fakeSupabase = createFakeSupabaseTables();
});

describe("ChatPanel (FR-005)", () => {
  it("shows an empty-state prompt before any messages exist", async () => {
    render(<ChatPanel userId="user-1" />);
    expect(await screen.findByText(/tell me about a movie/i)).toBeInTheDocument();
  });

  it("lets the user send a message and shows a write-confirmation badge after a successful <ADD>", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(streamingResponse('Nice! <ADD item="Inception" rating="5" />'))),
    );

    render(<ChatPanel userId="user-1" />);
    const user = userEvent.setup();

    const input = await screen.findByLabelText("Message");
    await user.type(input, "I loved Inception");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("I loved Inception")).toBeInTheDocument();
    expect(await screen.findByText("Saved · Inception")).toBeInTheDocument();

    vi.unstubAllGlobals();
  });

  it("disables the composer while a reply is in flight", async () => {
    let finishStream!: () => void;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "Sure" } }] })}\n\n`),
        );
        finishStream = () => {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        };
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(body, { status: 200 }))),
    );

    render(<ChatPanel userId="user-1" />);
    const user = userEvent.setup();

    const input = await screen.findByLabelText("Message");
    await user.type(input, "hello");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.getByLabelText("Message")).toBeDisabled());

    finishStream();
    await waitFor(() => expect(screen.getByLabelText("Message")).not.toBeDisabled());

    vi.unstubAllGlobals();
  });
});
