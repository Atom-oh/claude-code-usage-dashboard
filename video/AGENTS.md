# Video project instructions

This directory owns the historical silent documentation-site demo. Follow
[root guidance](../AGENTS.md); this file owns video-specific rules. `CLAUDE.md` imports it.
Documentation changes do not authorize recapturing the dashboard, changing captions,
calling models, rendering, publishing, or upgrading dependencies.

## Sources and runtime

- `index.html` composes six files in `compositions/frames/` on a 1920x1080, 28-second
  timeline. `meta.json` records project ID `video` and creation time 2026-07-28T03:51:04.072Z;
  the root composition ID is `main`, a separate identifier.
- `package.json` pins every script to **HyperFrames 0.7.77**. Use those scripts for an
  authorized video operation; do not substitute an unpinned/latest CLI or auto-upgrade.
- `npm run dev` starts a persistent preview server; `npm run check` validates compositions;
  `npm run render` and `npm run publish` produce or publish output. Do not run them for a
  Markdown-only reconciliation. After an authorized HTML change, check with the pinned
  script before rendering and report any unverified runtime/layout behavior.
- The existing setup notes require Node.js >=22 and usable Chromium, ffmpeg, and ffprobe.
  On Linux arm64, explicit `HYPERFRAMES_BROWSER_PATH`, `HYPERFRAMES_FFMPEG_PATH`, and
  `HYPERFRAMES_FFPROBE_PATH` were previously needed. The package declares scripts, not an
  engines constraint or bundled tool binaries; verify the actual environment.

## Composition rules

Keep scene IDs, timing, and `window.__timelines` registrations aligned. Timelines are paused;
local scene times differ from their starts in the root. Preserve the 0.5-second crossfade
overlap at 4, 14, and 24.5 seconds. Root scene mounts use `class="scene"`; timed child layers
use `class="clip"`. Do not mechanically apply a generic scaffold rule to change this layout.

Animations use explicit GSAP time and deterministic numeric formatting. Do not add random,
wall-clock, or live-data dependencies. The root already loads GSAP 3.14.2 from a CDN with
integrity metadata; offline rendering still needs that dependency resolved. CSS requests
Inter with a sans-serif fallback; no font files are bundled here. Do not claim typography
is reproducible merely because the family name is present.

## Assets and meaning

Runtime images are `assets/overview.png`, `assets/cost.png`, and `assets/analytics.png`.
They are ignored local copies of tracked images in `../site/assets/img/`. All seven source
screenshots and their roles are listed in [the inventory](capture/extracted/asset-descriptions.md).
For a separately authorized render, restore the copies from `video/`:

```bash
mkdir -p assets capture/assets
cp ../site/assets/img/*.png capture/assets/
cp ../site/assets/img/{overview,cost,analytics}.png assets/
```

Do not commit these duplicate copies, `.hyperframes/`, `renders/`, or `snapshots/`.
The committed delivery is `../site/assets/video/dashboard-demo.mp4`, embedded by
`../site/index.html` with `../site/assets/img/demo-poster.jpg`. Rendering does not by itself
replace that delivery file.

Keep this demo's dated figures/captions separate from current application behavior. It shows
historical computed spend; today's spend contract is reported-primary with opt-in computed
diagnostics. Channel counts may overlap by user, scores are activity heuristics, and approval
rates do not prove code quality. Do not turn a media caption into an invoice or causal claim.

Maintain English Markdown. Describe existing Korean screenshot labels in English without
changing their pixels; existing composition overlays use Latin text. Use the curated site
screenshots, not raw customer/account captures. [BRIEF.md](BRIEF.md),
[STORYBOARD.md](STORYBOARD.md), and [frame.md](frame.md) describe the current artifact;
HTML and actual media metadata establish timing and content.
