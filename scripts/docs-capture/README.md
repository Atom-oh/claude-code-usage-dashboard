# Visual guide assets

These captures use current React components with fixed synthetic responses, Korean
UI labels, reserved `example.test` identities and fictional prices. The independent
fixtures preserve cost/token subtotals, exact-user filtering, task cost bases,
missing attempts and the cost-equation/decomposition relationship. They are not a
production-data, authentication or vendor-pricing test.

Start Vite on loopback port 4178 from `dashboard/web`, then run from the repository:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chromium node scripts/docs-capture/capture.mjs
node scripts/docs-capture/capture.mjs --only tools,mcp
```

The second command uses Playwright's installed Chromium unless the environment
variable is set. `evidence.json` records source/fixture hashes, dimensions, errors
and image checks. Capture requests outside the loopback origin are blocked.
Generated images belong to `site/assets/img/guide-*.png`. The current lock also
includes companion captures for more detailed views.

`system.architecture.json` defines the logical device path and authenticated read
path. Archify 2.16 validated source evidence and delivered the interactive HTML
with nine showcase checks, no errors and no warnings. `render-preview.py` renders
a larger-label static SVG of the same nodes and connections for inline reading.
The interactive viewer is English. `font.json` identifies Pretendard v1.3.9 and
its SIL Open Font License; the complete license is in `site/assets/fonts/OFL.txt`.

The shared media lock and `scripts/fetch-docs-media.py` hydrate the generated
screens, diagram and font. Publish a new immutable media snapshot before pushing
any lock change. Preserve the existing video bytes and their historical review
scope when refreshing only the guide. Inspect the actual guide pages and image
viewer, not only checksums or screenshot dimensions.
