# English documentation video

This is the November 10, 2026 English guide walkthrough. See the
[brief](BRIEF.md), [storyboard](STORYBOARD.md) and [scoped instructions](AGENTS.md).
The older project in the parent directory remains historical.

Install Node 22.12+, Chromium, FFmpeg and ffprobe. The npm scripts pin HyperFrames
0.7.77; do not upgrade it while reproducing this composition. Set
`HYPERFRAMES_BROWSER_PATH`, `HYPERFRAMES_FFMPEG_PATH` and
`HYPERFRAMES_FFPROBE_PATH` to verified executables if automatic discovery fails.
The relative `assets` symlink points to the shared site media, without copies.

From the repository root, run `python3 scripts/fetch-docs-media.py` before previewing
or rendering. It hydrates the images, encoded video and local runtime assets from
the immutable commit in `media.lock.json`, checking every size and SHA256 before
writing. The `docs-media-20261110` tag retains that snapshot; URLs use its commit
identity. Use `--offline` to verify a populated cache without network access.
Pages runs the same helper with `--site-only` and fails rather than publishing
missing or corrupt media. HTML, captions, composition, provenance and licenses
remain tracked source; generated media and the pinned runtime are ignored cache.

Run from this directory:

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
1920×1080, 24 fps and no audio stream. Test the site player and English VTT track:
the WebM source also supports Chromium builds without H.264 decoding.
For replacement media, retain a new immutable snapshot and update the lock and
`site/assets/media.json` together after verification. Rendering does not publish
the site.

GSAP 3.14.2 retains its license header and standard-license URL. The hydrated
Noto Sans 2.013 font includes its copyright notice and SIL Open Font License in
`runtime/Noto-LICENSE.txt`. Source captures use synthetic fixtures and English
display labels translated by `openai.gpt-6-luna`; product locale behavior is
unchanged.
