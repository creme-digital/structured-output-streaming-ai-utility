import { HTMLAttributes } from "react";
import "./Badge.css";

export type BadgeTone = "neutral" | "success" | "danger";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

/**
 * Small status pill. Intended use in the build step: a "Saved" confirmation
 * after a successful structured-output write, or a failure tone for FR-004's
 * fallback state.
 */
export function Badge({ tone = "neutral", className, ...rest }: BadgeProps) {
  const classes = ["ui-badge", `ui-badge--${tone}`, className].filter(Boolean).join(" ");
  return <span className={classes} {...rest} />;
}
