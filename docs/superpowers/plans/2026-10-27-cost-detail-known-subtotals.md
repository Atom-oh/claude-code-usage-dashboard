# Cost Detail Known Subtotals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve usable reported costs in Claude detail Effort, model-share, agent, and efficiency panels while disclosing incomplete reporting.

**Architecture:** Extend the existing additive known-report contract to dimension rollups and efficiency joins. Cost opts into these fields; strict reports, diagnostic computations, and unavailable unit costs remain compatible.

**Tech Stack:** Express, ClickHouse SQL, React, node:test, Vitest.

**Spec:** [Known cost subtotals](../../decisions/ADR-013-known-cost-subtotals.md); [Cost API](../../api-reference.md).

## Global Constraints

- Never substitute computed prices for unavailable reported costs.
- Positive reports survive missing local model rates; zero requires observed report evidence.
- Preserve temporality, model/channel attribution, filters, and existing SQL boundaries.
- All-unknown costs remain unavailable; partial totals and exports disclose exclusions.
- Partial efficiency costs do not establish valid $/LOC or $/commit.
- Keep customer data, identities, and deployment configuration out of public fixtures.

## Review Focus

- Missing/null/invalid reports, zero with positive tokens, and overflow remain unavailable.
- Lookback-only zero counters do not establish measured zero or partial coverage.
- A measured zero subtotal survives excluded positive-token model scopes.
- Unknown items remain visible without suppressing known donut amounts.
- CSV preserves cost status and diagnostic columns follow the existing opt-in control.

### Task 1: Dimension and efficiency report coverage

**Files:** `dashboard/server/reportedCost.js`, `pricing.js`, `queries.js`, `costEfficiency.js`, and their tests.

**Interfaces:** Optional `known_reported_cost` and `reported_partial` accompany strict reports. Dimension queries provide in-window `cost_counter_rows`. Legacy rollup callers retain their existing fields.

- [x] Add failing tests for mixed/all-unknown reports, measured zero, lookback-only scopes, invalid values, and compatibility.
- [x] Observe expected failures using targeted node:test runs.
- [x] Add opt-in report coverage to dimension rollups and in-window evidence to Effort/agent SQL.
- [x] Add known report coverage to efficiency joins without relaxing unit-cost validity.
- [x] Verify targeted tests and execute generated queries against isolated ClickHouse fixtures.

### Task 2: Cost panels and exports

**Files:** `dashboard/web/src/spend.js`, `pages/Cost.jsx`, and their tests.

**Interfaces:** The Cost adapter selects additive subtotals; legacy responses retain strict selection. Donut totals use `sumKnownSpend`; cost status remains available in tables and CSV.

- [x] Add failing render tests for Effort, model shares, agents, and efficiency, including all-unknown and partial-zero cases.
- [x] Observe expected failures using targeted Vitest runs.
- [x] Display known donut data with partial coverage; retain unavailable items in textual details.
- [x] Display additive agent/efficiency amounts and export status; preserve unavailable efficiency units.
- [x] Verify targeted tests, complete server/web suites, production build, and shell checks.

### Task 3: Documentation, review, and release

**Files:** `docs/api-reference.md`, `docs/decisions/ADR-013-known-cost-subtotals.md`.

- [x] Document additive endpoints, evidence grain, partial charts, and unavailable unit costs.
- [ ] Complete independent latest-HEAD review and the content quality gate.
- [ ] Commit, push, create PR, apply blocking review feedback, and pass required CI.
- [ ] Merge the reviewed HEAD and publish its verified ARM64 image.
- [ ] Roll out to the authorized demo cluster; verify runtime identity, cost fixtures, auth, and scheduled backup monitoring.
