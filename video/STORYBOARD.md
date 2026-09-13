---
format: 1920x1080
duration: 28s
message: "A silent tour of the telemetry dashboard and its inferred usage channels"
arc: Hook -> Product -> Channel comparison -> Cost -> Agent -> Outro
audience: Workshop participants and internal stakeholders visiting the documentation site
mode: autonomous
music: none
---

# Existing demo storyboard

Reconciled on 2026-09-13 from `index.html` and the six frame HTML files. This describes the
existing artifact, not an instruction to regenerate it. The original sample period is
2026-07-26 through 2026-07-28. All captions/figures below are retained media content, not
claims about today's dashboard, billed spend, or causal productivity.

## Timeline

Root times and durations are declared in [index.html](index.html). Local frame times start
at zero. The three 0.5-second overlaps are intentional, so durations sum to 29.5 seconds
while the complete timeline lasts 28 seconds.

| Scene | Root start | Clip duration | Root end | Transition in | Source |
|---|---:|---:|---:|---|---|
| Hook | 0 s | 4.5 s | 4.5 s | Cut | [01-hook.html](compositions/frames/01-hook.html) |
| Product | 4 s | 5 s | 9 s | 0.5 s crossfade | [02-product.html](compositions/frames/02-product.html) |
| Channel comparison | 9 s | 5.5 s | 14.5 s | Cut | [03-ab.html](compositions/frames/03-ab.html) |
| Cost | 14 s | 5 s | 19 s | 0.5 s crossfade | [04-cost.html](compositions/frames/04-cost.html) |
| Agent | 19 s | 6 s | 25 s | Cut | [05-agent.html](compositions/frames/05-agent.html) |
| Outro | 24.5 s | 3.5 s | 28 s | 0.5 s crossfade | [06-outro.html](compositions/frames/06-outro.html) |

The checked-in MP4 is 1920x1080 at 30 fps, 28 seconds long, with no audio stream. Its metadata
was inspected locally; no render was run for this reconciliation.

## 1. Hook

A centered token counter reaches **405,422,042**, with the existing two-day/72-developer
sublabel. The opening caption describes the figures as measured rather than estimated;
that is preserved media wording, not a guarantee for the demo's cost or score calculations.

The eyebrow/counter enter during the first 0.6 seconds. The count-up runs from 0.6 to 2.4,
with scale increasing to 1.12 and a blue glow. Sublabels enter from 2.4 seconds, followed by
a short whole-frame push to scale 1.04 from 3.2 to 4.0. The clip remains present through
4.5 seconds for the transition. No image asset is loaded.

## 2. Product

`assets/overview.png` sits in a white rounded card with a subtle shadow. The camera moves
from the full view toward the KPI row at local 0.8-2.2 seconds, with a 3px blur on the
background screenshot wrapper. Chips show **72 users**, **1,587 sessions**, and
**46,539 lines**. At 3.4 seconds, the camera shifts toward the channel table, reduces zoom,
removes the blur, and adds blue/green row highlights. This scene has two camera targets;
the earlier generic “one camera move per frame” rule did not describe its implementation.

## 3. Channel comparison

Two composed cards enter with opposite 14-degree Y rotations. The Users capture supplies
historical reference figures, but `03-ab.html` does not load `assets/users.png` at runtime.

| Displayed quantity | Bedrock | Enterprise |
|---|---:|---:|
| Developers | 52 | 65 |
| Sessions | 602 | 755 |
| Activity-based score | 58.1 | 48.1 |
| Approval-rate badge | 98% | 98% |

Counts animate from local 0.7 seconds; scores/bars start at 2.0/2.15 seconds. The approval
badges appear at 3.4 seconds, while the cards move by opposite 8px offsets with yoyo motion.
The clip lasts 5.5 seconds, including the outgoing overlap. Users may occur in both inferred
channels, and unknown-channel activity is separate; do not sum these rows as disjoint users.
The original productivity/acceptance captions do not establish code quality or causal benefit.

## 4. Cost

The hero counts to **$507.88**, explicitly labeled computed spend for two days. Supporting
cards retain **$7,618** as a 30-day projection, **$7.05** per developer, and **$11** per
1,000 lines. These are historical estimates/ratios, not invoice figures or current spend.

The amount animates at local 1.8-2.95 seconds. At 3.0 seconds, the tile wrapper blurs to
5px and the camera zooms to 2.2 around the cache-donut region in `assets/cost.png`.
Chips show **91.7%** and **94.0%** cached at 4.4/4.55 seconds. Do not reinterpret these
as measured dollar savings. The current application uses reported spend by default; this
frame remains a record of its earlier computed-cost presentation.

## 5. Agent

An input card types the existing English channel-cost question from local 0.5 seconds for
1.7 seconds. At 2.3 seconds it presses/releases; a ClickHouse-query status appears at 2.5.
The answer table enters at 3.0 seconds, with rows staggered from 3.2 seconds:

| Existing example row | Amount |
|---|---:|
| Bedrock, 52 users | $286.61 |
| Enterprise, 65 users | $221.28 |
| Opus family, per user | $6.81 |
| Haiku family, per user | $0.04 |

`assets/analytics.png` is the faded/blurred background reference. The answer is precomposed
HTML, not a live model/SQL call during playback. The scene lasts 6 seconds for the outgoing
crossfade, although its main choreography ends earlier. The two displayed channel amounts
sum to $507.89 while the cost hero is $507.88; preserve the captured/example values rather
than silently modifying media to reconcile the one-cent difference.

## 6. Outro

A rounded-square **CC** mark appears first, followed by the product name assembled by word.
A line and the OTel-to-ClickHouse/channel subtitle enter, then a footer points to docs,
architecture, and runbooks. There is no literal website address in the existing frame.
A final glow and scale 1.0-to-1.02 settle fill the remaining time. No image asset is loaded.

## Design and source boundaries

Use [frame.md](frame.md) for the actual palette/layout reference and
[the asset inventory](capture/extracted/asset-descriptions.md) for image provenance.
Korean screenshot text is described in English here and remains unchanged in the pixels.
HTML/caption or financial-message revisions require their own authorized media change;
this documentation pass does not imply a new visual or runtime check.
