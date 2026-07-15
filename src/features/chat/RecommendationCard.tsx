import { Badge } from "../../components/ui";
import "./RecommendationCard.css";

export interface RecommendationCardProps {
  item: string;
  reason: string;
}

/**
 * Cycle 6 / FR-008: renders a successful, on-request `<RECOMMEND>` as its own distinct
 * visual element — a bordered card, not just another footnote pill — so it's plainly
 * obvious to an evaluator that the parser caught a different tag type and did something
 * different with it (per FR-005/FR-008's design intent, same precedent as the `<ADD>`
 * "Saved" and `<UPDATE>` "Rating updated" confirmations, but a full card rather than a
 * pill since a recommendation carries a reason worth reading, not just a short label).
 * Purely presentational — no data fetching, no Supabase calls.
 */
export function RecommendationCard({ item, reason }: RecommendationCardProps) {
  return (
    <div className="recommendation-card">
      <Badge tone="update">Recommended for you</Badge>
      <p className="recommendation-card__title">{item}</p>
      <p className="recommendation-card__reason">{reason}</p>
    </div>
  );
}
