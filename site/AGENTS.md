# Public documentation site

Follow [root guidance](../AGENTS.md) and
[documentation policy](../docs/documentation-policy.md). The user requested
English, Korean, Japanese, Simplified Chinese and Spanish public guides.

## Locales

English source guides are `index.html`, `user-guide.html`, `installation.html`,
`architecture.html`, `api.html` and `operations.html`; English media credits are
`assets/credits.html`. Mirror these seven pages under `ko/`, `ja/`, `zh/` and `es/`, with HTML language codes `ko`,
`ja`, `zh-CN` and `es`. Keep language switches on the equivalent page, five hreflang
alternates, section IDs, endpoint/config identifiers and code examples aligned.
Translate titles, descriptions, navigation, captions, alt text and accessible
labels. Existing literal Korean application labels may identify the actual UI;
they do not establish product localization.

The requested translation model is `openai.gpt-6-luna`. Record actual model calls,
source/output checksums and follow-up corrections in `assets/translations.json`.
Do not claim that host-written translations came from a delegated model.

## Media

The homepage introduces the complete product and links the menu-by-menu user
guide. Keep its coverage aligned with the actual navigation and conditional
features; see [coverage](../docs/reference/guide-coverage.md). Release changes
and the November 14 video are optional examples, not the guide's primary scope.
Keep the user, cost-efficiency and tool workflows illustrated with readable
synthetic captures and numbered actions. Retain an inline architecture preview.
Menu coverage alone is not a usability check: inspect typography, reading width,
screen detail and mobile navigation before replacing an existing guide.

The overview uses the English November 14 video in `assets/video/`, with
HyperFrames visuals, Polly narration and Remotion audio composition. It includes
an English VTT track and poster. The composition owner is
[video/docs-demo](../video/docs-demo/AGENTS.md). Retain historical media provenance
without applying its review score to newer artifacts.

Use synthetic fixtures, masked reserved identities and fictional costs only.
English demo screenshots use translated DOM labels on the actual React component;
they do not change product behavior. Keep file sizes, dimensions and checksums
in `assets/media.json`. Shared images, CSS and videos have one owner in `assets/`.
Hydrate the pinned generated media with `python3 scripts/fetch-docs-media.py
--site-only` before local previews. Pages verifies the same snapshot before upload;
see [delivery instructions](../video/docs-demo/README.md).

## Verification

Check local links and anchors, four-locale navigation, identical executable code
examples, translation/media checksums, and all pages at desktop and mobile widths.
Verify video playback and the VTT track as well as the encoded MP4 properties.
For the visual guide, also verify screenshot enlargement, original-size viewing,
Escape/close behavior, focus return, and the mobile contents control.
Run the documentation group in `tests/run-all.sh` for English Markdown checks.
Local verification and rendering do not establish deployment.
