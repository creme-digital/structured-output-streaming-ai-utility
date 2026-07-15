import { ReactNode } from "react";
import "./AppShell.css";

export interface AppShellProps {
  children: ReactNode;
  /** Right-aligned header slot — the build step plugs in the signed-in user / sign-out control here. */
  headerRight?: ReactNode;
  /**
   * Cycle 6 / FR-010: widen the content column beyond the default single
   * chat-box width (`--content-max-width`) to `--content-max-width-wide`, for
   * screens with more than one panel side by side (chat + history). Only
   * affects `.app-shell__content` — the header stays the same width so it
   * reads consistently across every screen, and the auth screen (which never
   * opts in) is unaffected.
   */
  wide?: boolean;
}

/** App-wide frame: slim header + centered content column. No StealthCo branding per design_direction. */
export function AppShell({ children, headerRight, wide = false }: AppShellProps) {
  const contentClasses = ["app-shell__content", wide && "app-shell__content--wide"].filter(Boolean).join(" ");
  return (
    <div className="app-shell">
      <header className="app-shell__header">
        <div className="app-shell__header-inner">
          <span className="app-shell__title">Structured-Output & Streaming AI Utility</span>
          {headerRight && <div className="app-shell__header-right">{headerRight}</div>}
        </div>
      </header>
      <main className="app-shell__main">
        <div className={contentClasses}>{children}</div>
      </main>
    </div>
  );
}
