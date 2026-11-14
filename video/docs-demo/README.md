# English documentation video

This is the November 14, 2026 English guide walkthrough. See the
[brief](BRIEF.md), [storyboard](STORYBOARD.md) and [scoped instructions](AGENTS.md).
The older project in the parent directory remains historical.

Install Python 3.9+, Node 22.12+, Chromium, FFmpeg and ffprobe. The npm scripts pin HyperFrames
0.7.77; do not upgrade it while reproducing this composition. Set
`HYPERFRAMES_BROWSER_PATH`, `HYPERFRAMES_FFMPEG_PATH` and
`HYPERFRAMES_FFPROBE_PATH` to verified executables if automatic discovery fails.
The relative `assets` symlink points to the shared site media, without copies.

From the repository root, run `python3 scripts/fetch-docs-media.py` before previewing
or rendering. It hydrates the images, encoded video and local runtime assets from
the immutable commit in `media.lock.json`, checking every size and SHA256 before
writing. The `docs-media-20261114-narrated` tag retains that snapshot; URLs use its commit
identity. Use `--offline` to verify a populated cache without network access.
Pages runs the same helper with `--site-only` and fails rather than publishing
missing or corrupt media. HTML, captions, composition, provenance and licenses
remain tracked source; generated media and the pinned runtime are ignored cache.

The final film keeps the HyperFrames visuals and composes Amazon Polly English
narration plus an original quiet score with Remotion 4.0.542. Cached Polly clips
need no AWS credentials or cloud calls. Install the locked Remotion packages and
render the narrated delivery from this directory:

```bash
npm ci
npm run test:audio
npm run render:narrated -- --browser-executable=/path/to/chromium
npm run render:mix -- --browser-executable=/path/to/chromium
ffmpeg -i renders/dashboard-demo-en-narrated.mp4 -i renders/narrated-mix.wav \
  -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 160k \
  -movflags +faststart -t 48 renders/dashboard-demo-en-final.mp4
ffmpeg -i renders/dashboard-demo-en-final.mp4 \
  -c:v libvpx-vp9 -crf 30 -b:v 0 -pix_fmt yuv420p -row-mt 1 -threads 2 \
  -c:a libopus -b:a 96k renders/dashboard-demo-en-narrated.webm
```

Hydration supplies `remotion/public/visual-base.mp4`, the current silent
HyperFrames output identified by the same immutable media lock.
The first Remotion pass re-encodes those visuals; the WAV pass composes the tracked
speech and music. FFmpeg copies that Remotion video stream into the final delivery
and encodes the WAV as AAC. There is no post-render audio correction or filter:
the final gain and fade values live in `remotion/mix.mjs`. The visual content is
preserved, but its encoded bytes differ from the original HyperFrames base.
The lock identifies existing delivery bytes; a fresh encode need not be byte-identical.
When a PR changes the media lock, push the referenced immutable media tag before the
PR branch. An independent media snapshot is not included by pushing the branch alone.

The explicit regeneration command `npm run audio` calls the paid Amazon Polly
API using the caller's AWS credentials. It requires AWS CLI, FFmpeg and ffprobe.
`remotion/narration.json` defines the English text, Matthew neural voice, region
and scene timing. Each clip is normalized and measured; an overlong clip fails
rather than cutting off words. Polly output can change across regeneration;
the locked existing clip bytes identify this delivery. The score is synthesized
locally from deterministic sine waves without external samples. Its gain falls
under narration, with an opening fade and a two-second closing fade.

To regenerate only the silent visual base, use the separate pinned HyperFrames
scripts:

```bash
npm run check -- --at 4,12,20,28,36,44 --strict
npm run snapshot -- --at 4,12,20,28,36,44 --no-end
mkdir -p renders
npm run render -- --output renders/dashboard-demo-en.mp4 \
  --fps 24 --quality high --workers 2
ffmpeg -i renders/dashboard-demo-en.mp4 -an -c:v libvpx-vp9 \
  -crf 30 -b:v 0 -pix_fmt yuv420p -row-mt 1 -threads 2 \
  renders/dashboard-demo-en.webm
```

Inspect the six scene frames, decode the complete files, and verify 48 seconds,
1920×1080, 24 fps and the AAC/Opus streams in the narrated delivery. Check complete
speech, background ducking and the matching English VTT track.
The WebM source also supports Chromium builds without H.264 decoding.
For replacement media, retain a new immutable snapshot and update the lock and
`site/assets/media.json` together after verification. Rendering does not publish
the site.

GSAP 3.14.2 retains its license header and standard-license URL. The hydrated
Noto Sans 2.013 font includes its copyright notice and SIL Open Font License in
`runtime/Noto-LICENSE.txt`. Source captures use synthetic fixtures and English
display labels translated by `openai.gpt-6-luna`; product locale behavior is
unchanged.

Remotion's [license terms](https://github.com/remotion-dev/remotion/blob/v4.0.542/LICENSE.md)
apply separately; this project does not modify or bundle its implementation.

## Refresh the synthetic captures

Start the Vite server in `dashboard/web`, then run `capture/capture.mjs` from the
repository with `CCDASH_CAPTURE_URL` set to its loopback URL and
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` set to Chromium if needed. `--collect <file>`
collects the display strings for a separately authorized Luna translation call;
the default mode uses `capture/labels.en.json` and writes the shared images.
`capture/evidence.json` records the source revision, dimensions and browser errors.
The runner intercepts API requests with fixed synthetic fixtures and never connects
to production. It must not be used as an authentication or deployment test.
