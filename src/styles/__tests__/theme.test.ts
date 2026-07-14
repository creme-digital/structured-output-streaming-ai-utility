import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for FR-005's recolor (change_log v2, re-affirmed idempotently
 * in v4). The build step for v2 was, per the design step's cycle-3 notes,
 * apparently never actually applied to this file despite the PRD recording it
 * as shipped - this test pins the intended end state so a future cycle can't
 * silently regress back to the old purple theme or drift from #A0B9BF.
 *
 * Read via node:fs rather than a Vite `?raw` import: vitest stubs `.css` module
 * bodies to an empty string by default (its `test.css` option is off), which
 * would make every assertion below vacuously pass against ''.
 */
const themeCss = readFileSync(resolve(__dirname, "../theme.css"), "utf-8");

// Historical purple accent values this theme must never reintroduce.
const RETIRED_PURPLE_HEXES = ["#4338ca", "#3730a3", "#eeecfd"];

describe("theme.css accent color (FR-005)", () => {
  it("pins the primary accent to the soft slate blue #A0B9BF", () => {
    expect(themeCss).toMatch(/--color-accent:\s*#a0b9bf;/i);
  });

  it("uses a dark, readable contrast color on accent surfaces (not white-on-light-blue)", () => {
    expect(themeCss).toMatch(/--color-accent-contrast:\s*#16171b;/i);
  });

  it("contains no leftover purple/indigo hex values anywhere in the theme", () => {
    for (const hex of RETIRED_PURPLE_HEXES) {
      expect(themeCss.toLowerCase()).not.toContain(hex);
    }
  });
});
