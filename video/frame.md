---
name: Dashboard demo frame reference
format: 1920x1080
status: Descriptive reference for existing HTML
colors:
  canvas: "#F4F6F9"
  ink: "#0F172A"
  bedrock: "#6183F0"
  enterprise: "#3F9C79"
font_family: Inter, sans-serif
---

# Frame design reference

Reconciled on 2026-09-13 against `compositions/frames/*.html`. The original document was an
adapted Blue Professional preset; its single-accent, cream-canvas, shadow-free, and responsive
aspect-ratio rules did not match the implemented demo. This file records the project as it
exists. It does not request a restyle or override the root/scoped AGENTS instructions.

## Canvas and palette

The composition is fixed at **1920x1080**, with pixel-based positioning and hidden overflow.
It does not implement the former preset's `cqw` container system or vertical/square layouts.
A different aspect ratio requires separate composition work and validation.

Use light gray `#F4F6F9` for frame backgrounds and dark `#0F172A` for primary text. Bedrock
blue `#6183F0` and Enterprise green `#3F9C79` are both intentional accents. Existing CSS
also uses darker blue/green text variants and neutral gray labels; do not replace them with
a generic “one cobalt accent” rule. White cards and faint blue/green fills distinguish
product captures and channel comparisons.

## Typography and figures

All frame CSS requests **Inter, sans-serif**. No Inter font binary or `@font-face` declaration
is bundled with these files, so actual typography depends on the rendering environment.
Existing composition overlays use Latin text/digits, while screenshots retain Korean UI.
English documentation descriptions are not translated replacement captions.

Representative source sizes are the 168px hook counter, 74px comparison counts, 40px channel
scores, and 82px outro title. These are descriptive values, not a new typography framework.
Counters use fixed formatting/decimal precision under GSAP time; preserve that determinism.

The historical figures come from the capture/storyboard, not a live API. Computed costs,
projections, activity scores, and approval rates remain distinct from invoices, realized
savings, code quality, or causal productivity. Consult [STORYBOARD.md](STORYBOARD.md) for
exact retained values and their limits instead of inventing replacements.

## Surfaces and composition

| Frame | Implemented treatment |
|---|---|
| Hook | Centered blue count-up, radial blue glow, dark sublabel, short underline. |
| Product | White screenshot card with 14px corners, 1.5px tinted border, and a subtle shadow; blue callout chips and blue/green row highlights. |
| Channel comparison | Two tinted 700x640 cards, blue and green borders, score tracks, approval badges, mirrored entry rotations. |
| Cost | Computed-spend cards beside a screenshot surface; blur and targeted zoom toward cache-donut details. |
| Agent | White input/result surfaces with a faint Analytics screenshot behind them; deterministic text typing and staggered rows. |
| Outro | Rounded-square blue CC mark, centered dark title, divider, subtitle/footer, and a restrained glow/scale settle. |

The existing product-card shadow is intentional. Content is not uniformly shadow-free,
card radii are not globally interchangeable, and there is no persistent progress strip or
interactive CTA in the root composition. The outro mark is a rounded square, not a circle.
Do not add unused preset components to satisfy an old catalog.

## Motion and validation boundary

[STORYBOARD.md](STORYBOARD.md) records root/scene timings and crossfade overlaps. HTML owns
the actual motion: paused GSAP timelines, transforms, blur, count-up drivers, and explicit
text/opacity state. The product frame uses more than one camera target; comparison cards
use opposite 8px yoyo movement. Generic motion labels are not a reason to change those values.

For a separately authorized composition edit, preserve registration, deterministic seeking,
asset paths, and the pinned HyperFrames 0.7.77 workflow in [AGENTS.md](AGENTS.md). Review the
rendered frame before claiming visual fidelity. Markdown/source reconciliation alone is not
a fresh layout, motion, contrast, or browser validation.
