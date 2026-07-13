import { ReactNode } from "react";
import "./AppShell.css";

export interface AppShellProps {
  children: ReactNode;
  /** Right-aligned header slot — the build step plugs in the signed-in user / sign-out control here. */
  headerRight?: ReactNode;
}

/** App-wide frame: slim header + centered content column. No StealthCo branding per design_direction. */
export function AppShell({ children, headerRight }: AppShellProps) {
  return (
    <div className="app-shell">
      <header className="app-shell__header">
        <div className="app-shell__header-inner">
          <span className="app-shell__title">Structured-Output & Streaming AI Utility</span>
          {headerRight && <div className="app-shell__header-right">{headerRight}</div>}
        </div>
      </header>
      <main className="app-shell__main">
        <div className="app-shell__content">{children}</div>
      </main>
    </div>
  );
}
