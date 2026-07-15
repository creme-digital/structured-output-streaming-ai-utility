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

  it("shows a distinct want-to-watch badge for a want-to-watch <ADD> (Cycle 6 / FR-005)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(streamingResponse('Noted! <ADD item="Dune" status="want_to_watch" />'))),
    );

    render(<ChatPanel userId="user-1" />);
    const user = userEvent.setup();

    const input = await screen.findByLabelText("Message");
    await user.type(input, "I want to watch Dune");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Want to watch · Dune")).toBeInTheDocument();

    vi.unstubAllGlobals();
  });

  it("renders a distinct recommendation card for a successful <RECOMMEND> (Cycle 6 / FR-008)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          streamingResponse('Try this one. <RECOMMEND item="Arrival" reason="Similar to Inception." />'),
        ),
      ),
    );

    render(<ChatPanel userId="user-1" hasRatedItems />);
    const user = userEvent.setup();

    const input = await screen.findByLabelText("Message");
    await user.type(input, "What should I watch next?");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Recommended for you")).toBeInTheDocument();
    expect(await screen.findByText("Arrival")).toBeInTheDocument();
    expect(await screen.findByText("Similar to Inception.")).toBeInTheDocument();

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
