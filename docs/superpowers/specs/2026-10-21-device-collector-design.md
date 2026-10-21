# Device collector installation

## Intent and agreed scope

Provide an authenticated ccdash installation page for EC2 Linux and macOS. Each
package configures both Claude Code and Codex through one loopback OpenTelemetry
Collector. The user chose device-specific collection tokens; database passwords
must remain on the server. Demo/viewer users cannot manage tokens, download packages,
or ingest through a browser session. Existing editor (generic `analyst`) and admin
roles can manage their own devices. OIDC group mapping remains provider-neutral.

The user authorized implementation, tests, public PR/merge and deployment to the
existing demo EKS cluster. Preserve unrelated worktrees and the existing login,
30-day refresh session, ClickHouse schema, raw SQL ingest endpoint and client/model
accounting contracts. This is an ingestion feature, not employee productivity proof.

## Implementation decisions

These defaults are engineering choices, not additional user requirements:

- `/collector` is separate from admin-only installation diagnostics. It explains
  three steps: download for Linux/macOS, register a named device and copy its token
  once, run the installer and paste the token at a hidden prompt. Show devices,
  expiry, last accepted delivery and a revoke action. Never save tokens in browser
  storage, URLs, archives or generated shell commands.
- Tokens expire after 30 days, independently of browser sessions. A device is replaced
  by issuing a fresh token and rerunning setup; usage never extends expiry. Registry
  metadata is retained seven days beyond expiry. No automatic IdP role-demotion
  claim: minting requires the current editor/admin session; existing device tokens
  remain valid until expiry or explicit revocation.
- Use a DynamoDB table keyed by `owner` and `id`, consistent reads, and TTL `purgeAt`.
  Owner is SHA-256 of the configured issuer and authenticated subject. Tokens are
  `ccd1.<64 lowercase hex owner>.<32 lowercase hex id>.<43 base64url secret>`.
  Secret material is 32 random bytes; only its SHA-256 is stored. Token comparisons
  are timing-safe. Queries/list/revoke are restricted to the authenticated owner.
  Management requires OIDC; explicit opt-in fails closed on incomplete configuration.
- Default feature off for existing installations. New config: `INGEST_ENABLED=1`,
  `INGEST_TOKEN_TABLE`, `INGEST_UPSTREAM_URL`, `INGEST_UPSTREAM_TOKEN_FILE` and existing
  `APP_PUBLIC_URL`/`OIDC_ISSUER`. Public endpoint is `${APP_PUBLIC_URL}/api/ingest`.
  AWS credentials use the default SDK chain (IRSA in EKS). No Cognito-specific code.
- Accept machine-authenticated POST only at `/api/ingest/v1/metrics`, `/v1/logs` and
  `/v1/traces`, before human authentication. Device tokens grant ingestion only.
  Limit bodies to 2 MiB uncompressed, reject compressed requests, accept only OTLP
  protobuf or JSON, bound concurrency to 8 per process, enforce a 15-second total
  gateway deadline and bounded per-device requests. Authenticate before buffering.
  Do not forward cookies, arbitrary headers, query strings or upstream error bodies.
  Device validation caches at most 2,048 entries for at most 10 seconds; expiry is
  always enforced. Revocation reaches other replicas within that cache window.
- Forward to a private Collector service with a separate internal bearer secret
  mounted from Kubernetes Secret files. No public receiver load balancer. The
  Collector owns the existing INSERT-only ClickHouse credential. Dashboard queries
  retain their read-only DB account. Two small receiver replicas fit existing nodes;
  no node type/count expansion is authorized by this feature.
- Local Collector listens only on 127.0.0.1:4317/4318, sends OTLP/HTTP with
  `compression: none`, and preserves bounded persistent retry buffering. Server
  queues are bounded memory queues; acceptance does not guarantee a DB commit.
  Preserve current privacy filters, client isolation, Codex backend provenance and
  metric temporality. Central processing must not erase host-resolved provenance.
- Installer supports Linux amd64/arm64 with systemd and macOS amd64/arm64 with a
  per-user LaunchAgent. Pin Collector release 0.163.1 and all four official archive
  SHA-256 values. Verify downloads before execution. Confirm exporter compatibility
  with the existing ClickHouse schema before selecting the central receiver image.
  Do not perform a schema migration implicitly to accommodate an exporter.
- Reuse tracked generic client configuration logic, preserving model/provider/auth
  settings and rejecting unmanaged conflicts. No legacy test-script secrets may be
  copied. Provide check/status, token replacement and uninstall instructions. Never
  replace an existing unmanaged service or remove unrelated client configuration.
  Store local tokens only in mode-0600 files inside a private directory. Avoid token
  command-line arguments, shell interpolation and logging. Ask for a local user ID
  for telemetry attribution; this ID is client-provided, not verified SSO identity.
- Packages contain scripts/configuration and download verified upstream binaries;
  they do not install Claude Code/Codex themselves or contain their credentials.
  Dashboard build consumes only tracked package sources. Generated canonical policy
  copies are checked against their owners so privacy rules cannot silently diverge.

## HTTP interfaces

All management responses are JSON with no-store, and require `collector:manage`.
Existing unsafe-request same-origin enforcement applies. Raw tokens appear only in
successful issuance responses. Errors contain stable codes, not SDK/credential text.

- `GET /api/collector`: `{ enabled, endpoint, tokenLifetimeDays: 30,
  collectorVersion, platforms: ["linux", "darwin"] }` (endpoint only if enabled).
- `GET /api/collector/devices?cursor=...`: `{ devices, nextCursor }`. At most 50 per
  page, opaque bounded cursor, owner-bound. Device fields: `id`, `name`, `platform`,
  `createdAt`, `expiresAt`, `revokedAt`, `lastSeenAt`; dates are ISO strings or null.
- `POST /api/collector/devices` body `{ name, platform }`: 201 `{ device, token }`.
  Trimmed name 1–64 characters, no control characters; platform linux/darwin only.
- `DELETE /api/collector/devices/:id`: 204, idempotent for the owner's existing
  record, 404 for absent records. Never create a new record from a revoke/touch.
- `GET /api/collector/package/:platform`: attachment `ccdash-collector-<platform>.tar.gz`.
  Permission before any file access; missing package produces 503, invalid platform 404.

## Acceptance and limits

Regression tests cover viewer denial (including direct URLs), cross-owner isolation,
forged/revoked/expired tokens, origin checks, bounded bodies/deadlines/concurrency,
store failures, package integrity and preservation of both clients' configuration.
Run existing server/web tests, harness, builds, docs checks and Terraform validation.
Use actual Collector binaries to validate rendered configuration and isolated OTLP
fixtures to prove both clients reach existing-schema tables without duplication.
Inspect desktop/mobile installation UX. Native macOS launchd execution requires a
Mac and must be disclosed if unavailable; Linux fixtures are not macOS proof.

Deployment requires latest-HEAD specialist review and CI, content review >=85,
reviewed Terraform plan with no unrelated replacement, immutable image identity,
healthy rollout, auth/role checks and runtime ingestion/revocation evidence. An
installed client or idle queue alone is not proof of end-to-end telemetry delivery.
