---
workflow: general-video
flow: companion
storyboard: no
message: "Follow observed usage from the overview to a user's task, model call and tools, then interpret cost and collection coverage."
destination: documentation-site
aspect: 1920x1080
language: ko
voice: Seoyeon
length: speech-led detailed tour
---

## Intent

Create a detailed product introduction for first-time users, with Korean narration
and English captions as explicitly selected by the user. Cover every menu and the
main workflows: client/time selection, user and task Trace, cost and cache
interpretation, tools/MCP/Skills/plugins, reliability, analytics and device setup.
Use readable real React captures and the verified architecture illustration.
This is a complete-product walkthrough; release notes are supporting context.

## Assets

- `../../site/assets/img/guide-*.png` — synthetic captures of the actual React UI.
- `../../site/assets/diagrams/system.svg` — verified logical OIDC device-path example.
- `../../site/assets/fonts/PretendardVariable.woff2` — bundled Korean/Latin typography.
- `../docs-demo/runtime/gsap.min.js` — pinned local animation runtime.

## Customizations

- Korean Amazon Polly narration; English captions translated by Luna.
- Measured speech determines scene durations; never truncate speech to fit a cut.
- Chapter navigation, gentle focus moves and sustained close-ups for dense screens.
- Original deterministic music, kept quiet under narration.

## Notes

Use HyperFrames 0.7.77 without dependency upgrades. Keep the separate 48-second
release walkthrough reproducible. Captures use reserved identities and fictional
costs; never record customer telemetry or execute setup/administrative actions.
Cost sources and incomplete coverage remain explicit. Activity is not employee
performance or causal ROI. Codex diagnostic feeds are not additive spend.
The architecture image is an example, not proof of deployed infrastructure.
