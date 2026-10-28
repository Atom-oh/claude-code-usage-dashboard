# Unified cost breakdowns implementation plan

**Goal:** consistent model, effort and input-cache cards across cost views.
**Spec:** [design](../specs/2026-10-28-unified-cost-breakdowns-design.md).
**Execution:** subagent-driven web task; host owns server integration and release.

## Tasks

- [x] Server: add a shared-filter Claude effort adapter, reuse the local counter
  query, preserve backend identities and known-cost coverage, cache by all filters.
  Add/run failing regression tests before implementation.
- [x] Web: share breakdown presentation, insert consistent cards in the common
  cost layout, reuse Codex insights data, retain Claude detail behavior and
  persistent headings. Add/run failing regression tests before implementation.
- [ ] Verify web/server suites and build, review both tasks and the full branch,
  commit/push, process latest-HEAD PR review, then merge and deploy approved demo.

## Review focus

Unknown costs and partial zero; missing canonical cache components; backend
selection and cache isolation; old responses during client/range changes;
independent effort failures leaving model/cache views usable.

## Progress

- Base: `5e13196`; root feature branch and unrelated files preserved.
- Regression test addition/execution approved by the user on 2026-10-28.
- Ruling: existing deployment/PR approvals remain applicable to this demo fix.
- Independent reviews resolved session-coverage folding, backend inference,
  ClickHouse alias predicates and parent-error presentation.
- Final web suite: 814 passed; production build passed.
- Final server suite: 723 passed, seven opt-in SQL cases skipped. The separate
  isolated ClickHouse suite owns database execution evidence.
- Isolated ClickHouse verification: seven suites, 122 passed, no failures.
- Synthetic Chromium: three charts per selected client, six combined; one
  Codex effort request; no browser errors or mobile overflow.
- Deployment and native latest-HEAD review remain pending.
