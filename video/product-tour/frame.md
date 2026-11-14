# Detailed tour design

A calm guided inspection of one product, with the real screen as the focal point.
Use a 1920×1080 canvas, 24 fps, dark navy surround (#0b1524), white/slate type and
blue/teal accents. Bundle Pretendard Variable; do not rely on host fonts.

Keep the chapter label at the upper left, the page/action title below it, and one
large screenshot viewport in the center. Use 80-pixel outer gutters. Provide a
brief action cue above the screen and a quiet synthetic-data note below it.
Reserve the bottom 120 pixels for player captions. Dense tables and call detail
need crops or two complementary close-ups, not a tiny full-page screenshot.

Use `coordinate-target-zoom` for one deliberate focus move after the screen has
settled, and `stat-bars-and-fills` for the thin chapter progress indicator. Hold
while the narration explains. Avoid decorative glitch, elastic text or moving
numbers. Transitions must preserve reading time and remain deterministic under seek.
