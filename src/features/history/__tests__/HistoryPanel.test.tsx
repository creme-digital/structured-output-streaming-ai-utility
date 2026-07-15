import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { HistoryPanel } from "../HistoryPanel";
import { HistoryEntry } from "../types";

const RATED: HistoryEntry[] = [
  { id: "1", item: "Inception", rating: 2, status: "watched", createdAt: "2024-01-01T00:00:00Z" },
  { id: "2", item: "Inception", rating: 5, status: "watched", createdAt: "2024-01-05T00:00:00Z" },
];

const WATCHLIST: HistoryEntry[] = [
  { id: "3", item: "Dune", rating: null, status: "want_to_watch", createdAt: "2024-01-02T00:00:00Z" },
];

describe("HistoryPanel (FR-010)", () => {
  it("shows the Rated tab by default with every historical row uncollapsed", () => {
    render(<HistoryPanel ratedItems={RATED} watchlistItems={WATCHLIST} status="ready" />);

    const ratings = screen.getAllByText(/★/);
    expect(ratings).toHaveLength(2);
    expect(screen.getByText("★ 2")).toBeInTheDocument();
    expect(screen.getByText("★ 5")).toBeInTheDocument();
    expect(screen.queryByText("Dune")).not.toBeInTheDocument();
  });

  it("switches to the Want to Watch tab and shows the distinct watchlist marker, no rating", async () => {
    render(<HistoryPanel ratedItems={RATED} watchlistItems={WATCHLIST} status="ready" />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("tab", { name: "Want to Watch" }));

    expect(screen.getByText("Dune")).toBeInTheDocument();
    expect(screen.getByText("Want to watch")).toBeInTheDocument();
    expect(screen.queryByText("Inception")).not.toBeInTheDocument();
  });

  it("shows a loading state", () => {
    render(<HistoryPanel ratedItems={[]} watchlistItems={[]} status="loading" />);
    expect(screen.getByText(/loading your history/i)).toBeInTheDocument();
  });

  it("shows an error state", () => {
    render(<HistoryPanel ratedItems={[]} watchlistItems={[]} status="error" />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("shows an empty state per tab when there's nothing yet", () => {
    render(<HistoryPanel ratedItems={[]} watchlistItems={[]} status="ready" />);
    expect(screen.getByText(/movies you rate in chat/i)).toBeInTheDocument();
  });
});
