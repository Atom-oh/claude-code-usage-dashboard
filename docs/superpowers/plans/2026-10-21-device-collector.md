# Device collector implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Independent tasks share the interfaces below; root integrates and owns deployment.

**Goal:** Let editor/admin users install Claude Code and Codex telemetry on Linux/Mac with revocable device tokens.

**Architecture:** Authenticated management APIs issue hash-only DynamoDB device tokens. A bounded machine-authenticated gateway forwards OTLP to a private Collector; downloadable installers configure loopback client collection.

**Tech Stack:** Express/Node, React, DynamoDB SDK v3, Python standard library and Bash, OTel Collector, Terraform/EKS.

**Spec:** `docs/superpowers/specs/2026-10-21-device-collector-design.md`

## Global constraints

- Provider-neutral OIDC; generic analyst/admin permission `collector:manage`; viewer denied.
- Tokens expire after 30 days; cache <=10 seconds / 2,048 entries; registry has `owner`/`id`, TTL `purgeAt`.
- OTLP POST body <=2 MiB, no compression; 8 concurrent requests and 15-second total deadline per gateway process.
- Both clients preserved, no CH secrets in packages, no schema migration or node expansion.
- Public source contains no deployment identities or secrets. Keep server/web lockfiles.

## Review focus

- Revocation on a different replica and fresh token verification must honor expiry/store failures.
- Cookie-only ingestion, direct package URLs and cross-owner cursor/revoke cannot bypass RBAC.
- Existing client settings/services and shell-sensitive paths must not be overwritten or executed.
- Collector configuration changes must preserve backend provenance and existing insert schema.
- Overload, upstream timeout and malformed bodies must release admission slots and avoid memory growth.

## Task 1 — Device API and gateway

**Files:** `dashboard/server/deviceTokens.js`, `deviceTokenStore.js`, `collectorRoutes.js`, matching `.test.js`, server package/lock.
**Consumes:** validated authenticated `req.principal.subject`; `authentication.requirePermission`; package directory at `/app/collector-packages` (local override injected by root).
**Produces:** `createDeviceTokenService({store, issuer, now})` with issue/list/revoke/verify/touch; `createDynamoDeviceStore({tableName, client})`; `createCollectorFeature({env, authentication, packageDir, store, fetchImpl, now})` returning `{installIngest(app),installManagement(app),enabled}`. Follow spec HTTP contracts.

- [x] Write and run focused failing token/RBAC/gateway tests against injected stores/upstreams.
- [x] Implement bounded SDK store, token lifecycle, configuration validation and both route installers.
- [x] Run targeted tests covering ownership, errors, expiry, revoke, body/header/admission/deadline limits.

## Task 2 — Package and collector policy

**Files:** `dashboard/collector/`, `scripts/sync-collector-package.py`, package tests, canonical policy edits only if required for existing-schema compatibility.
**Consumes:** spec machine token syntax/public endpoint; canonical `collector-config.yaml` and `scripts/configure-client-telemetry.py`.
**Produces:** deterministic archives `ccdash-collector-linux.tar.gz` and `ccdash-collector-darwin.tar.gz` via `node dashboard/collector/build-packages.mjs OUTPUT_DIR`; local and central configuration sources usable by Terraform. Runtime archives contain no tokens or binaries.

- [x] Add failing installer/configuration-preservation and archive-integrity tests.
- [x] Implement pinned/checksummed downloads, hidden token input, systemd/launchd lifecycle and repeatable setup.
- [x] Generate reviewed local/central policies preserving privacy/backend/client identity; pin release metadata.
- [x] Validate actual binaries/config and both-client OTLP/schema compatibility with isolated fixtures.

## Task 3 — Installation UI

**Files:** `dashboard/web/src/pages/CollectorSetup.jsx`, matching tests, `App.jsx`, `clientNavigation.js`, `components/Sidebar.jsx`.
**Consumes:** spec management APIs; `session.permissions`; existing design components.
**Produces:** `/collector` editor/admin flow, OS downloads, one-time secret display and device list/revoke.

- [x] Add failing viewer/direct-route, token-once, download and revoke UI tests.
- [x] Implement responsive Korean UI with loading/errors/expiry and no persistent token storage.
- [x] Run targeted UI tests and production build.

## Task 4 — Integration and infrastructure (root)

**Files:** `auth.js`, `index.js`, `Dockerfile`, `infra/device_ingest.tf`, dashboard/variable/example inputs, docs/reference and runbook.

- [x] Wire new permission, ingestion before human auth and management after auth/admission.
- [ ] Build archives from tracked sources into the runtime; retain runtime-distribution checks/notices.
- [x] Add opt-in DynamoDB/least-privilege IAM, internal authenticated receiver and Secret mounts.
- [x] Validate full suites, docs, package configs, Terraform and route integration.

## Task 5 — Review, release and deploy (root)

- [ ] Obtain independent task and full latest-HEAD specialist reviews; fix correctness/security defects.
- [ ] Commit/push/PR, pass mandatory CI and merge under existing authorization.
- [ ] Content-review score >=85; build and inspect immutable release image; publish ECR.
- [ ] Review full environment plan; apply only intended resources/config; verify rollout and both-client ingest/revoke.
- [ ] Record evidence and actual platform limitations; remove only completed owned worktree.

## Decisions and progress

- Existing user instruction to complete work autonomously supersedes repeating design/execution-method approvals. Device-token choice and new test scope were explicitly approved.
- Root selected 30-day device expiry, owner-only device management, DynamoDB metadata and a private receiver. These are reversible implementation choices.

- Implementation and independent task reviews completed. Slow-upload authorization, accepted-delivery metadata errors, installer rollback, systemd expansion and uncertain Codex launch provenance were corrected.
- Native Collector 0.163.1 fixtures verify both hops and all seven existing ClickHouse tables without DDL changes. Central synchronous inserts and an EventName adapter preserve the materialized-column contract.
- Web suite: 751 passed; harness: 124 passed, eight expected skips. Native macOS installation remains unverified.

- Final pre-PR verification: server 659 passed / five expected integration skips; web 751 passed and build passed; harness 124 passed / eight expected skips; device Terraform mock 5 passed. Content review passed 90/90. Four stacked PRs keep each reviewed diff under the existing size limits.
