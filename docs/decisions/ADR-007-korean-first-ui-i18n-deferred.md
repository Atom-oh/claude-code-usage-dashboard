# ADR-007: Korean-first UI; defer internationalization

- Status: Accepted for product UI; documentation-language requirement superseded by ADR-010
- Date: 2026-09-03
- Updated: 2026-09-13

## Context

The workshop audience primarily uses Korean. The SPA contains Korean explanatory
labels alongside English product, page, model, and code identifiers. There is no
central translation table or runtime language selector.

## Decision

Keep the product Korean-first and do not add an internationalization dependency
without an actual second-language requirement. If that requirement arises, the
recorded option is a shared string lookup and deployment-time language configuration
through `/api/config`, following the existing runtime-config pattern.

`strings.js`, `t(key)`, and `UI_LANG` are design options, not implemented interfaces.
A per-viewer language selector is also deferred.

The original decision retained bilingual documentation. That part is superseded by
[ADR-010](ADR-010-english-documentation-and-review-context.md): maintained project
documentation is English-only. This does not change runtime labels or rendered media.

## Rationale and consequences

The image is reused across deployments, so a future deployment-specific language
choice should not be baked into a frontend build. Avoiding an unused translation
framework keeps the current application small, at the cost of later string extraction.
Adding an English-only UI or a translation dependency now was rejected because it
would change the existing workshop experience without a demonstrated requirement.
