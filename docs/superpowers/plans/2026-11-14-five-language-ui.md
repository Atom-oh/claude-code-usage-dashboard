# Five-language application and guide implementation plan

> For agentic workers: execute the owned translation tasks only; the host owns application behavior and integration.

**Goal:** Let users choose English, Simplified Chinese, Japanese, Spanish or Korean in the application and public guide; then finish the separately requested detailed HyperFrames introduction with Korean narration and English captions.

**Architecture:** Use explicit source-message translation calls and a small locale store subscribed by React components. Localize only authored presentation copy, never telemetry, identifiers, request parameters or user text. Static presentation records resolve their labels at read time. Keep component identity and state when the locale changes. Luna owns translations; the host validates catalog completeness and semantic contracts.

**Tech stack:** Existing React 18/Vite application, JSON catalogs, Intl formatting; static HTML documentation; the existing pinned HyperFrames toolchain for the subsequent film.

## Constraints and review focus

- Preserve cost basis, partial/unavailable distinctions, masking, permission gates and request/filter semantics.
- Preserve open user/task/Trace state, date ranges and table selection across locale changes.
- Persist only a validated locale in local storage; denied storage must remain usable.
- Use standard locale codes en, zh-CN, ja, es and ko; display native language names.
- Preserve technical identifiers, code samples and synthetic-only media.
- Translate all seven guide pages into Spanish and keep equivalent-page locale navigation.
- Catalog loading failure must keep the current language and remain retryable.

## Work

- [x] Inventory authored UI copy and add locale store, selector and behavior tests.
- [x] Have Luna translate catalogs and Spanish guide; record source/output hashes.
- [x] Migrate presentation strings and date/number formats; verify dynamic tooltips, errors, Trace and state retention.
- [x] Add five-language guide links, Spanish interaction labels and provenance.
- [x] Run web tests/build, documentation checks and browser checks across all locales and representative routes.
- [ ] Integrate reviewable PRs within review-size limits; preserve the release process.
- [ ] Complete the detailed HyperFrames film with Korean narration, English captions, readable captures and architecture; verify and publish the final media through the documented pipeline.
