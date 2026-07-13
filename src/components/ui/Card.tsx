import { HTMLAttributes } from "react";
import "./Card.css";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  padded?: boolean;
}

/** Generic elevated surface used for panels (chat panel, auth panel, etc). */
export function Card({ padded = true, className, ...rest }: CardProps) {
  const classes = ["ui-card", padded && "ui-card--padded", className].filter(Boolean).join(" ");
  return <div className={classes} {...rest} />;
}
