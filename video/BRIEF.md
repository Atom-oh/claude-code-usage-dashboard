---
workflow: product-launch-video
flow: automation
storyboard: no
message: "Show the telemetry dashboard and its inferred Bedrock and Enterprise channels"
destination: web-hero
aspect: 1920x1080
language: ko
overlay_language: en
length: 28s
original_target_length: 30s
angle: product-demo
---

# Existing demo brief

This is the recorded brief for the silent documentation-site hero loop, reconciled on
2026-09-13. The original target was at most 30 seconds; `index.html` and the committed MP4
are 28 seconds. `meta.json` records creation on 2026-07-28. Workflow/flow fields preserve
provenance and are not instructions to restart generation during a documentation edit.

## Intent and evidence

Show the dashboard's telemetry, adoption, cost, and activity views through curated captures
and composed callouts. The original storyboard attributes the sample to 2026-07-26 through
2026-07-28: 72 users over two days. Those figures describe the historical demo, not a current
fleet census or validated productivity study.

The video retains its original computed-spend example. Current reported-primary behavior is
in [ADR-009](../docs/decisions/ADR-009-reported-spend-with-computed-diagnostics.md); this brief
does not relabel captured costs as invoices or imply that a later UI change is in the MP4.

## Assets and presentation

Source captures live in `../site/assets/img/`; the runtime uses ignored copies under
`video/assets/`. The actual image dependencies are Overview, Cost, and Analytics. Users is
a reference for composed comparison figures; Executive and Productivity captures remain
available reference material rather than additional scenes. See the
[asset inventory](capture/extracted/asset-descriptions.md) for paths and dimensions.

There is no narration, music, or audio stream. The existing `<video>` is embedded as a muted
autoplay loop on the docs site. Korean UI text remains inside screenshots; composition
callouts use Latin text. The `language: ko` field describes captured product language, not
the language of these Markdown documents. No new captions or media are generated here.

Use the captured UI palette: light gray canvas `#F4F6F9`, dark ink `#0F172A`, Bedrock blue
`#6183F0`, and Enterprise green `#3F9C79`. The HTML requests Inter/sans-serif; a bundled font
must not be assumed. Existing values come from the historical capture/composition and must
not be refreshed or invented as a documentation change.

The recorded workflow used supplied, anonymized screenshots rather than crawling the
Basic-Auth-protected dashboard. Preserve the curated synthetic participant labels and avoid
raw account/customer captures. Asset copies, rendering, and publication are separate
operations governed by [video instructions](AGENTS.md).
