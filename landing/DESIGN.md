# Design language

Shared with the rest of the Formstr suite. The reference implementation is
nostr-calendar (`src/theme/tokens.ts`, "calm paper, loud ink"); this page
follows the same rules. If they ever disagree, nostr-calendar wins and this
file should be updated to match.

## Calm paper, loud ink

The base is monochrome. Near-white paper, near-black ink, a few greys for
lines and secondary text. That's the whole canvas — structure comes from
weight, size, and space, not colour.

- `paper` `#f4f4f3` — the canvas
- `surface` `#ffffff` — cards / raised things
- `ink` `#0b0b0c` — text and the primary (loud) action
- `line` `#e4e4e2` — hairlines and borders
- greys — Tailwind `gray-400/500/600` for secondary and muted text

The primary action is loud ink, not a colour: a black button on paper.

## Colour is functional, not a brand

We do not have a brand colour. Colour is a **tool with a job** — you reach for
whatever hue *sticks* for a given use case, use it there, and keep it rare.
The same product can carry different hues in different spots; none of them
"owns" the identity.

A colour earns its place by doing one of these:

- **Emphasis** — the one attention hue, spent sparingly where we most want the
  eye: a key phrase, the logo's mark, and the single filled action button.
- **Action** — the one thing we most want you to do (Compose/Write): a filled
  button in the *emphasis* hue (not its own colour), distinct from a neutral
  primary confirm which stays loud ink. Exactly one control per view wears it.
- **Status / semantics** — error (red), warning (amber), success (green),
  live/healthy (green). Conventional and read instantly; don't repurpose them.
- **A mark** — a small deliberate spark (e.g. the logo's asterisk).

Rules of thumb:

- Monochrome first. If a screen works in black and white, it ships in black
  and white.
- One functional colour visible at a time in a given view. Two competing pops
  cancel out.
- Don't colour a thing just to decorate it. If you can't name the job, drop it.
- Mind the connotation. A red ring on an input reads as *error*, so we don't
  use red for a neutral focus state — focus stays ink.

### Name colour tokens for their job

A token called `accent` invites you to "accent" anything, anywhere — which is
exactly the decoration we're avoiding. Name each colour for the **job** it
does (`--color-emphasis`, and later `--color-success`, `--color-warning`, …).
That keeps reuse honest: you reuse `emphasis` only when you genuinely need
emphasis, so the same hue stays consistent *and* stays in the right scenario.
Reach for a new job-named token before you overload an existing one.

### Where colour is spent on this page

- **`--color-emphasis` `#e5484d`** — the emphasis hue. Used on the headline
  word ("your key.") and the logo asterisk. Editorial red: it was chosen
  because it *stuck* here, not because it's "the brand." Swap it freely if a
  different hue does the job better.
- **Semantic red / amber** — kept inline in the signer styles (error text,
  key-backup warning). Left as-is on purpose.

Everything else is ink, paper, and grey.

## Type

Inter for everything, mono (`--font-mono`) for eyebrows/labels and code-like
bits. Big headings are tight (`tracking-tight`, weight 800). Section labels are
small uppercase mono with wide tracking.
