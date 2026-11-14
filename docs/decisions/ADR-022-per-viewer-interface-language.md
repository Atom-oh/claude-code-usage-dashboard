# ADR-022: Per-viewer interface language

- Status: Accepted
- Date: 2026-11-14
- Supersedes: The product-language deferral and deployment-time preference in
  [ADR-007](ADR-007-korean-first-ui-i18n-deferred.md)

## Context

The product now has an explicit requirement for English, Simplified Chinese,
Japanese, Spanish and Korean, selectable by each viewer. People using the same
deployment may prefer different languages. Language changes must retain the
current period, filters, user and task selection, and must not reinterpret
telemetry, cost coverage or authorization.

## Options considered

- **Deployment configuration through `/api/config`**, as anticipated by ADR-007:
  preserves runtime configuration and one reusable image, but gives every viewer
  the same default and does not satisfy independent selection.
- **A browser preference with shared catalogs**: gives each viewer a choice in
  the same image and requires no API or database change. It adds catalog assets,
  asynchronous loading and translation-maintenance obligations.

## Decision

Use the browser preference `ccdash.locale`, defaulting to Korean. Accept only
`en`, `zh-CN`, `ja`, `es` and `ko`. Keep Korean in the initial bundle and load the
other catalogs on demand. Invalid stored values use Korean; a failed catalog
load retains the current language and remains retryable. A later selection
supersedes an earlier pending request. Unavailable storage must not prevent use.

Subscribe React components to the locale store without remounting them. Translate
authored presentation messages and explicitly opted-in static label records.
Render rich messages as React text/elements, preserving positional placeholders.
Do not translate API parameters, identifiers, user text or collected values.
Keep unavailable, unpriced, not-computed and measured-zero states distinct.

Short dates, numbers and time units follow the selected locale. Exact diagnostic
timestamps retain their padded numeric form in the browser time zone. Language
selection does not change UTC calendar presets, exact-time boundaries, rollup
precision, filters or permissions. The user-guide link selects the equivalent
public guide locale.

## Consequences

One image serves all five languages, and viewers can change language while a
task remains open. No deployment-specific language is baked into a separate
frontend build. Preferences are local to one browser, not synchronized between
devices, and may be lost when storage is cleared or blocked.

Catalogs increase asset size and require complete key/placeholder coverage.
Luna translations retain source/output provenance and receive semantic review,
especially for cost origin and incomplete telemetry. The interface does not
translate model-generated answers, captured prompts or other user content.
Maintained engineering documentation remains English under
[ADR-010](ADR-010-english-documentation-and-review-context.md).

## Owners and evidence

- [Locale store](../../dashboard/web/src/i18n/store.js)
- [Catalog provenance](../../dashboard/web/src/i18n/translations.json)
- [Locale-store tests](../../dashboard/web/src/i18n/store.test.js)
- [Frontend state](../reference/frontend.md) and [display contracts](../reference/ui.md)
