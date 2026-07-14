import { HTMLAttributes } from "react";
import "./Badge.css";

export type BadgeTone = "neutral" | "success" | "danger" | "update";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

/**
 * Small status pill. Intended use in the build step: a "Saved" confirmation
 * after a successful structured-output write, or a failure tone for FR-004's
 * fallback state. `tone="update"` (Cycle 4 / FR-009) is for the "rating
 * updated" confirmation on a successful <UPDATE> tag — deliberately a
 * different hue (accent-based) from both "success" (green, <ADD>/"Saved")
 * and "danger" (red, fallback), so an evaluator can tell at a glance which
 * of the three registered tag types the parser acted on.
 */
export function Badge({ tone = "neutral", className, ...rest }: BadgeProps) {
  const classes = ["ui-badge", `ui-badge--${tone}`, className].filter(Boolean).join(" ");
  return <span className={classes} {...rest} />;
}
