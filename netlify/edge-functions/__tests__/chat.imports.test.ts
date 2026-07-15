import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

// chat.ts is a Deno-only Netlify Edge Function: it uses top-level URL import
// specifiers (`https://esm.sh/...`) that Node/Vite cannot resolve, so it can never be
// `import`-ed directly by vitest (that's exactly why all testable logic lives in plain
// src/lib modules instead). This test statically inspects the source text to lock in
// the Cycle 6 / FR-007 build fix: Netlify's edge bundler only experimentally supports
// `npm:` specifiers and failed to bundle the previous `npm:@supabase/supabase-js`
// import, so it was swapped for a Deno-native ESM import served by esm.sh, pinned to
// the same version already used by package.json's `@supabase/supabase-js` dependency
// to avoid an unreviewed dependency bump.
const SOURCE = readFileSync(resolve(HERE, "../chat.ts"), "utf-8");
const PACKAGE_JSON = JSON.parse(readFileSync(resolve(HERE, "../../../package.json"), "utf-8"));

describe("netlify/edge-functions/chat.ts Supabase import (FR-007 build fix)", () => {
  it("imports the Supabase client via a Deno-native esm.sh ESM URL, not an npm specifier", () => {
    expect(SOURCE).toMatch(
      /import\s*\{\s*createClient\s*\}\s*from\s*"https:\/\/esm\.sh\/@supabase\/supabase-js@[^"]+"/,
    );
  });

  it("does not use any npm: specifier anywhere in the file (Netlify's edge bundler cannot bundle them)", () => {
    expect(SOURCE).not.toMatch(/from\s+"npm:/);
  });

  it("pins the esm.sh import to the same @supabase/supabase-js version as package.json (no unreviewed dependency bump)", () => {
    const match = SOURCE.match(/https:\/\/esm\.sh\/@supabase\/supabase-js@([\d.]+)/);
    expect(match).not.toBeNull();
    const pinnedVersion = match![1];
    const packageJsonRange = PACKAGE_JSON.dependencies["@supabase/supabase-js"] as string;
    const packageJsonVersion = packageJsonRange.replace(/^[^\d]*/, "");
    expect(pinnedVersion).toBe(packageJsonVersion);
  });

  it("only the @supabase/supabase-js import was moved off npm — the other two imports remain plain relative src/lib modules", () => {
    const importLines = [...SOURCE.matchAll(/^import .+$/gm)].map((m) => m[0]);
    expect(importLines).toHaveLength(3);
    expect(importLines.filter((l) => l.includes("../../src/lib/"))).toHaveLength(2);
    expect(importLines.filter((l) => l.includes("esm.sh"))).toHaveLength(1);
  });
});
