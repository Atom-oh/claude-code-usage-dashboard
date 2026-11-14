# English documentation demo

This project owns the November 14, 2026 English documentation video.
The user authorized synthetic captures, local rendering, Amazon Polly English
narration and background music composed with Remotion. Follow the root
and parent instructions; preserve the separate historical video project.

Use HyperFrames **0.7.77** through this package's pinned scripts. The root ID is
`docs-demo`; six consecutive eight-second scenes make a 48-second, 1920×1080
composition. GSAP timelines are paused and deterministic. Runtime libraries and
the Noto Sans font are local, with license attribution.

`assets` is a relative symlink to `../../site/assets`, the single owner of the
synthetic screenshots and delivered video. Never replace these captures with
customer telemetry. The English screenshot labels were translated by
`openai.gpt-6-luna` for the demo; they do not establish product locale support.

Run `npm run check`, inspect each scene's midpoint, render, and inspect encoded
frames before claiming completion. Keep generated caches, snapshots and renders
untracked. Hydrate media/runtime with `scripts/fetch-docs-media.py` and preserve the
immutable snapshot and SHA256 lock. See [delivery instructions](README.md).
Local rendering does not authorize deployment or publication.

Preserve the pinned HyperFrames visuals; Remotion **4.0.542** owns the final audio
composition in `remotion/`. Hydration, rendering and testing use cached media and
must not call Polly. `npm run audio` is the explicit paid regeneration command.
Keep spoken text, VTT, six eight-second scenes and measured clip durations aligned.
Never truncate a clip to fit a scene. Music ducks under narration and fades out.
