# Detailed product tour

A 25-scene, 1920×1080 product walkthrough with Korean narration and English
captions. The measured timeline is 549.4167 seconds at 24 fps. It covers every
menu and the main user/Trace, cost, tool and setup workflows. All screenshots use
synthetic data and reserved identities; the architecture is a logical example.

## Sources

- `script.json`: Korean narrative, chapter labels and source images.
- `captions.en.json`: English translations requested through a Luna CLI subagent.
- `audio.json` / `timing.json`: measured Polly audio, speech marks and scene bounds.
- `capture.mjs` / `capture-evidence.json`: real React interactions with fixture APIs.
- `build.py` / `camera.js` / `styles.css`: deterministic HyperFrames composition.
- `registry.json`: source attribution for the adapted UI Focus Zoom camera primitive.
- `remotion/`: audio composition with quiet, ducked original music.

The `assets` and `runtime` symlinks reuse canonical site assets and the existing
local GSAP runtime. Pretendard's license is in `site/assets/fonts/OFL.txt`;
GSAP attribution remains with the shared documentation runtime.

## Build and verify

Use Node 22.12+, Python 3.9+, Chromium, FFmpeg and ffprobe. Install this package
with `npm ci`, hydrate the pinned shared media, then use:

```bash
npm run build
npm test
npm run check -- --strict
npm run dev -- --port 4182
npm run render -- --output renders/product-tour-visual.mp4 --fps 24 --quality high --workers 2
npm run audio:mix -- --browser-executable=/path/to/chromium
```

Set `HYPERFRAMES_BROWSER_PATH`, `HYPERFRAMES_FFMPEG_PATH` and
`HYPERFRAMES_FFPROBE_PATH` where the renderer cannot discover local binaries.
The CLI remains pinned to HyperFrames 0.7.77; Remotion audio uses 4.0.542.

`npm run audio:generate` is the explicit paid Polly regeneration command. It
reuses clips whose SSML/voice hashes match, stores completed clip receipts before
requesting speech marks, and cancels queued work after an error. Checks, rendering
and hydration do not call Polly. Never trim speech to fit an estimated duration.

Inspect all scene midpoints and the encoded result. The English and Korean VTT
files are derived from measured SSML marks. Record final media sizes, codecs,
frames, full-decode results and SHA256 values in the shared media manifest before
publication. A successful render alone does not establish deployment.
