# Client observability implementation record

[Accepted scope](../specs/2026-09-14-client-observability.md). The planned slices were
configuration/collection, API aggregation/pricing, client-aware UI, then verification
and documentation. Node 22, existing packages/authentication and Claude counter
semantics were retained. Engineering documentation is English; UI remains Korean.

Implemented: activation flags, native Codex log fixtures and launcher, Collector
isolation/timestamp handling, bounded client API, labelled cost bases, null-preserving
folds, common navigation/filtering, and owning references. Independent review corrected
Claude event names, missing-usage handling, empty states and cache identity. PR feedback
added staged configuration validation and bounded Collector startup recovery.

Validation at implementation completion:

- Server: 203 passed; separately executed real ClickHouse suite: 14 passed.
- Web: 188 passed and production build passed.
- Harness: 115 passed; seven local-tooling skips and one opt-in Collector skip.
  Actual Collector 0.119 replay passed separately across activation modes.
- Terraform format/validation passed. Bootstrap failure fixtures exercise recovery.
- Actual Express/ClickHouse browser checks passed all three client modes, including
  totals, filters, masked CSV, missing/empty data and mobile navigation.
- Native Codex 0.154 produced local tool/OTLP fixtures. Seven bounded raw AWS calls
  established endpoint streaming/functions and the Runtime hosted-search limitation;
  they do not establish live native CLI authentication or invoice coverage.

Publication is split within the existing complete-review input budget. Latest-HEAD AI
review, Critical/Major fixes, required CI and predecessor/base checks remain release
gates under the user's standing merge policy. Validation does not deploy production.
