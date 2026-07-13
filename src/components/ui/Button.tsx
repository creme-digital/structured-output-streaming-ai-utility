import { ButtonHTMLAttributes, forwardRef } from "react";
import "./Button.css";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

/** Base action control. Loading/disabled states are left to callers via `disabled`. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "primary", size = "md", className, ...rest }, ref) => {
    const classes = ["ui-button", `ui-button--${variant}`, `ui-button--${size}`, className]
      .filter(Boolean)
      .join(" ");

    return <button ref={ref} className={classes} {...rest} />;
  },
);

Button.displayName = "Button";
