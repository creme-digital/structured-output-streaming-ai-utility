import { TextareaHTMLAttributes, forwardRef } from "react";
import "./TextArea.css";

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {}

/** Auto-sized-by-CSS message composer input. Submit wiring is a build-step concern. */
export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(
  ({ className, rows = 1, ...rest }, ref) => {
    return (
      <textarea
        ref={ref}
        rows={rows}
        className={["ui-textarea", className].filter(Boolean).join(" ")}
        {...rest}
      />
    );
  },
);

TextArea.displayName = "TextArea";
