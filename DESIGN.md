# Design System — Structured-Output & Streaming AI Utility

## Starting point

No design files were uploaded by the client for this project (`intake_agent` recorded
`file_references: []`), and the repo contained no prior design work — only a bare
Vite/Netlify skeleton (`.gitignore`, `netlify.toml`, `public/_redirects`). There is no
competitor reference or existing StealthCo brand to reconcile with, so this system is
built directly from `design_direction.prose` and the client's own words captured in the
PRD.

## What the client actually asked for

> "Clean simple chat interface is fine" — no StealthCo branding needed for this demo.

Two things were called out as **load-bearing**, not cosmetic:

1. It must be visibly obvious that text is streaming token-by-token (FR-002).
2. It must be visibly obvious that a row was actually written after a successful
   `<ADD>` extraction (FR-003/FR-005).

Fallback/error states (malformed tag, missing tag, ambiguous/off-topic input) must also
be visible and non-crashing, since the evaluator will pressure-test the bot (FR-004).

Everything else — layout, color, chrome — is intentionally kept out of the way of those
two signals.

## Direction chosen

**A single-column, neutral, standard chat-bubble interface with one accent color.**

- **Layout**: one centered content column (`--content-max-width: 720px`) under a slim,
  unbranded header. A single chat panel is the entire app, matching "a single chat box
  is sufficient" (FR-005) — no sidebar, no multi-panel dashboard, nothing that implies
  StealthCo product scope.
- **Color**: a neutral gray/white surface scale (`--color-bg`, `--color-surface`,
  `--color-border`) carries the whole UI. One accent (`--color-accent`, indigo) is used
  sparingly: primary buttons, the user's own chat bubble, and focus rings. Assistant
  bubbles stay neutral (`--color-surface-sunken`) so the user's accent-colored bubble
  and the assistant's neutral one are trivially distinguishable at a glance — useful
  when an evaluator is scanning a fast-moving pressure-test transcript.
- **Feedback colors are a first-class part of the palette, not an afterthought**:
  `--color-success` / `--color-success-bg` for the write-confirmation badge, and
  `--color-danger` / `--color-danger-bg` for FR-004's fallback/failure states. Both are
  defined in the theme up front so the build step has a consistent place to express
  "saved" vs. "couldn't parse that" without inventing new colors.
- **Streaming affordance**: `MessageBubble` takes a `streaming` prop that renders a
  blinking caret at the end of the bubble's text — a small, unambiguous, always-visible
  signal that tokens are still arriving, independent of whatever loading spinner or
  network state the build step wires up.
- **Typography**: system-first sans stack (`Inter` if available, falling back to the
  OS default) at a slightly-larger-than-browser-default base size (15px) for chat
  readability, with a relaxed line-height (1.55) since prose replies are the primary
  content.
- **Radius**: bubbles get a distinctly larger radius (`--radius-bubble: 18px`, with one
  corner flattened per speaker) than buttons/inputs/cards (`--radius-md: 10px`,
  `--radius-lg: 16px`) so the chat bubbles read as "chat bubbles" specifically, not just
  "rounded boxes," while the rest of the UI stays understated.
- **No branding**: no logo, no StealthCo color, no wordmark — per
  `out_of_scope: "StealthCo branding, logo, or custom color theming."` The header shows
  only the plain project title as text.

## Primitives shipped this step

All under `src/components/ui/`, each a small typed component + scoped CSS file, no CSS
framework dependency:

| Component | Purpose |
|---|---|
| `Button` | primary/secondary/ghost/danger variants, sm/md sizes |
| `Input` | labeled text input w/ error + hint slots (for auth forms) |
| `TextArea` | composer input, disabled/placeholder states styled |
| `Card` | generic elevated surface (chat panel, auth panel, etc.) |
| `Spinner` | inline three-dot loader for pre-first-token wait |
| `Badge` | neutral/success/danger status pill — "Saved" / failure tags |
| `MessageBubble` | presentational chat bubble incl. streaming caret + footnote slot |

`MessageBubble` is presentational only — it owns no data, no streaming logic, no
Supabase calls. Its `footnote` slot exists specifically so the build step can drop a
`<Badge tone="success">Saved · Inception</Badge>` under a completed assistant turn, or a
`<Badge tone="danger">Couldn't log that</Badge>` for FR-004's fallback path, without
inventing new markup.

## App skeleton

- `AppShell` (`src/components/layout/`): slim header (title only, plus an optional
  `headerRight` slot the build step will use for the signed-in user / sign-out control)
  + centered single-column main area.
- `Home` (`src/pages/`): placeholder screen exercising every primitive against a static
  example conversation (welcome message, a user turn, an assistant turn with a "Saved"
  badge, and one bubble with `streaming` set) plus a disabled composer bar. This is
  intentionally not wired to any backend — it exists to prove the design system reads
  correctly as a real conversation before the build step replaces the static data with
  the live chat/parsing/persistence logic.

## Explicitly deferred to the build step

Per this step's scope: auth screens/flows, the chat function and OpenAI call, the
streaming consumer, the tag parser, all Supabase reads/writes, and all tests. No
database schema or migrations were touched. The theme and primitives above are meant to
make that step purely "wire behavior into existing components," not "invent UI."

## Cycle 3 (PRD v4 — recolor re-affirmation)

The work order for this cycle frames the #A0B9BF recolor as an idempotent re-run of the
v2 change ("that change already shipped in v2... byte-identical to the v2 outcome").
That framing did not match the repo: git history shows only a single prior
design/build/qa/docs cycle (PRD v1), and `theme.css` still had the original purple
accent (`#4338ca`) — the v2/v3 change_log entries were never actually built. This was
flagged as a soft blocker for the record; since FR-005's target color and scope are
unambiguous, the fix proceeded without waiting.

**What changed** — `src/styles/theme.css` only, four tokens:

| Token | Before | After |
|---|---|---|
| `--color-accent` | `#4338ca` | `#a0b9bf` |
| `--color-accent-hover` | `#3730a3` | `#8ba7ae` (darkened for hover affordance) |
| `--color-accent-contrast` | `#ffffff` | `#16171b` (see below) |
| `--color-accent-soft` | `#eeecfd` | `#dbe4e7` |

**Contrast fix, not a cosmetic tweak**: white text on `#A0B9BF` measures ~2.1:1
(fails WCAG AA's 4.5:1, and the PRD explicitly warns against "white-on-light-blue
illegibility"). Dark text (`#16171b`, matching `--color-text`) on `#A0B9BF` measures
~8.7:1. `--color-accent-contrast` now resolves to the dark value, so primary buttons
and the user's chat bubble (both of which render their label/content in
`--color-accent-contrast` on an `--color-accent` background) stay readable.

**Confirmed no other files hardcode purple** — every component CSS file references the
token (`var(--color-accent...)`), never a raw hex, so this is a complete, single-source
recolor with zero component-level changes required. `global.css`'s generic `a { color:
var(--color-accent) }` and `:focus-visible` outline also now resolve to the new color
per the PRD's explicit "links/focus rings" enumeration; note there are currently no
live `<a>` tags in the app (the auth screen's mode-toggle is a ghost `Button`, styled
neutral gray, not accent), so this only affects the focus-visible outline in practice.
The outline's contrast against a white background is lower than before (~2:1 vs. the
old ~7.9:1) — kept as directed since the PRD names focus rings explicitly and its
contrast acceptance criterion is scoped to text/icons *on* accent surfaces, not the
accent's use as an outline color; noting this here rather than silently deviating or
silently under-fixing.

No components, layout, or primitives changed — this cycle is theme-tokens only.

## Cycle 4 (PRD v5 — retry/temperature/title-recognition fixes + FR-009 `<UPDATE>`)

This cycle's work order (change_log v5) amends FR-001/FR-003/FR-004 and adds FR-009.
Reading the amendments against what design actually owns:

- **FR-001 (temperature + unrecognized-title clarification) and FR-004 (silent
  retry-then-fallback + `unrecognized_title` logging) are prompt/logic-only.** Neither
  introduces a new UI state: a "please clarify the title" reply is just ordinary
  assistant prose (no tag emitted), and the silent 2-retry behavior is explicitly
  invisible to the user by design (only the final attempt's output ever streams). No
  design work is needed for either — the existing streaming bubble and existing
  danger-toned fallback badge already cover every visible outcome these two FRs
  produce. Confirmed by reading `useChat.ts`/`tagParser.ts`/`ChatPanel.tsx`: nothing
  there needs a new visual state, only new backend/parsing logic (build step's job).
- **FR-009 (`<UPDATE>` as a third tag type) is the one FR with a real design need**: a
  "rating updated" confirmation that must be visually distinct from the existing
  `<ADD>` "Saved" badge (`tone="success"`, green) and the fallback badge
  (`tone="danger"`, red), per FR-005's acceptance criteria and the FR-008 precedent
  this PRD explicitly points to. Rather than inventing a one-off component, this cycle
  adds a fourth tone to the existing `Badge` primitive and reuses the app's own accent
  color for it — since `Badge`'s `footnote` slot in `MessageBubble`/`ChatPanel` already
  generically renders any tone, this makes the build step "pass `tone="update""`,
  nothing more.
  - `theme.css`: new `--color-accent-text: #3d5960` — a darkened slate-blue for text
    on `--color-accent-soft` backgrounds (~5.8:1 contrast, passes WCAG AA). The
    existing `--color-accent-contrast` (`#16171b`, near-black) is tuned for text on
    the *solid* `--color-accent` fill (buttons, user bubble) and would read as plain
    neutral gray-black on the pale `--color-accent-soft` fill this badge uses instead
    — a new token was needed to keep the badge's color identity legible as "accent",
    not just "another gray pill."
  - `Badge.tsx` / `Badge.css`: `BadgeTone` gains `"update"` →
    `background: var(--color-accent-soft)`, `border-color: var(--color-accent)`,
    `color: var(--color-accent-text)`. Visually: a blue-tinted pill, distinct in hue
    from the green "success" and red "danger" tones and from the plain-gray
    "neutral" tone.
  - `features/chat/types.ts`: `FootnoteInfo["tone"]` gains `"update"` so the build
    step can set `{ tone: "update", text: "Rating updated · <title>" }` (or similar)
    without touching `ChatPanel.tsx` — the footnote rendering path
    (`<Badge tone={message.footnote.tone}>{message.footnote.text}</Badge>`) is
    already generic over tone.
- **No new components, pages, or layout changes.** `<UPDATE>`'s confirmation reuses
  the exact same footnote slot `<ADD>`'s "Saved" badge already uses — there is no new
  screen real estate to design, per the "extend, don't invent" brief for this step.
- **Carried-forward flag, not newly introduced by this cycle**: FR-008 (`<RECOMMEND>`,
  a distinct card/badge for on-request recommendations) was documented at the end of
  Cycle 3 as never actually implemented in code (`ARCHITECTURE.md`'s own Cycle 3
  section; `tagParser.ts`'s `createDefaultTagRegistry` still registers only `ADD` as
  of the start of this cycle). This cycle's `change_log` entry does not list FR-008
  among its `changes`, so per the touch-only-what's-required rule it is not
  opportunistically built or designed here. Noting it again so it isn't silently
  dropped a second cycle running — a future cycle's work order should explicitly
  decide whether to reopen FR-008.

## Cycle 5 (PRD v6 — Netlify edge-function build/deploy fix)

**No design changes.** This cycle's work order (change_log v6, FR-007 only) swaps the
Supabase client import in `netlify/edge-functions/chat.ts` from an npm specifier
(`npm:@supabase/supabase-js@2.110.3`) to a Deno-native ESM import
(`https://esm.sh/@supabase/supabase-js@2.110.3`), to unblock Netlify's edge bundler.
Confirmed by reading the file: it's pure Deno runtime glue (env vars, the OpenAI
`fetch` passthrough, and a best-effort RLS-scoped read of the user's own item titles
for FR-009's `<UPDATE>` matching) with zero UI surface — no component, page, badge, or
theme token is implicated. The PRD's own migration_notes and acceptance criteria frame
this explicitly as build/deploy-only with "no behavior, streaming shape, tag
emission/parsing, or DB writes change," which matches: nothing here is a design-system
concern.

Verified `npm run build` (`tsc --noEmit && vite build`) still exits 0 against the
pre-existing `src/` tree — this cycle touches no file under `src/`, `index.html`, or
`package.json`, so the app skeleton, primitives, and theme from Cycles 1-4 are
byte-identical. The actual import-line swap in `netlify/edge-functions/chat.ts` is the
build step's job (it's outside `tsc`/`vite`'s compilation graph — Netlify's edge
bundler builds it separately at deploy time).
