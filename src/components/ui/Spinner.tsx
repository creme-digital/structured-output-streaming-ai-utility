import "./Spinner.css";

export interface SpinnerProps {
  label?: string;
}

/** Small inline loading indicator, e.g. for an in-flight assistant turn before the first token arrives. */
export function Spinner({ label = "Loading" }: SpinnerProps) {
  return (
    <span className="ui-spinner" role="status" aria-live="polite">
      <span className="ui-spinner__dot" />
      <span className="ui-spinner__dot" />
      <span className="ui-spinner__dot" />
      <span className="ui-spinner__sr-only">{label}</span>
    </span>
  );
}
