import { InputHTMLAttributes, forwardRef, useId } from "react";
import "./Input.css";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
}

/** Labeled text input with an optional inline error, e.g. for the auth forms. */
export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, hint, id, className, ...rest }, ref) => {
    const generatedId = useId();
    const inputId = id ?? generatedId;

    return (
      <div className="ui-field">
        {label && (
          <label className="ui-field__label" htmlFor={inputId}>
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          className={["ui-input", error && "ui-input--error", className].filter(Boolean).join(" ")}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined}
          {...rest}
        />
        {error ? (
          <p className="ui-field__error" id={`${inputId}-error`}>
            {error}
          </p>
        ) : hint ? (
          <p className="ui-field__hint" id={`${inputId}-hint`}>
            {hint}
          </p>
        ) : null}
      </div>
    );
  },
);

Input.displayName = "Input";
