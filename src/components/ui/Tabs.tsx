import { KeyboardEvent } from "react";
import "./Tabs.css";

export interface TabItem {
  id: string;
  label: string;
}

export interface TabsProps {
  tabs: TabItem[];
  activeId: string;
  onChange: (id: string) => void;
  "aria-label"?: string;
}

/**
 * Small accessible tab strip (`role="tablist"`/`role="tab"`, arrow-key
 * navigation) for switching between views within a single panel without
 * navigating away — introduced in Cycle 6 for the history panel's "Rated" /
 * "Want to Watch" tabs (FR-010), but generic so any future panel can reuse
 * it. Purely presentational: the caller owns which tab is active and what
 * renders below it.
 */
export function Tabs({ tabs, activeId, onChange, "aria-label": ariaLabel }: TabsProps) {
  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const nextIndex = (index + delta + tabs.length) % tabs.length;
    onChange(tabs[nextIndex].id);
  }

  return (
    <div className="ui-tabs" role="tablist" aria-label={ariaLabel}>
      {tabs.map((tab, index) => {
        const isActive = tab.id === activeId;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            className={["ui-tabs__tab", isActive && "ui-tabs__tab--active"].filter(Boolean).join(" ")}
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
