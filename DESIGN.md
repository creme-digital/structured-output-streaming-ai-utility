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
