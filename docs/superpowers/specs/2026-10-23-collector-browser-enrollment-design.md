# Collector installation with browser SSO

Status: implemented (2026-11-14); not yet released or deployed. Implementation decisions
that refine this proposal are recorded in [Implementation](#implementation).

## Intent

An editor/admin runs one shell command on macOS or Linux, signs in through the
deployment's existing SSO, confirms the device, and lets the installer finish.
They never copy, paste or see a collector credential. Both Claude Code and Codex
use the existing local Collector package.

This extends the [device collector design](2026-10-21-device-collector-design.md).
The existing [collector runbook](../../runbooks/device-collectors.md) describes the
currently deployed manual flow. This proposal does not claim deployed behavior.

## User experience

1. **Collector installation** shows one command for both operating systems:

   ```sh
   curl -fsSL https://dashboard.example.com/api/ingest/install.sh | sh
   ```

   The command uses the installation's configured public origin, without a baked-in
   domain.
2. The launcher uses `uname` to detect Darwin/Linux and a supported architecture,
   checks Python 3.9+, and starts the enrollment helper. Unsupported environments
   receive actionable instructions before any client or service changes.
3. The helper displays a short confirmation code and opens the system browser.
   On an EC2 host without a desktop, it prints the same HTTPS verification link
   for the user to open on their own computer. No tunnel is required.
4. Existing ccdash SSO handles sign-in. A valid existing browser session avoids
   another password prompt. The callback returns to the device connection page.
5. The page shows the signed-in account, requested device name, operating system,
   and confirmation code. The user checks that the code matches their terminal
   and selects **Connect this device**. Warn users to approve only an installation
   they started themselves, never a code or link sent by another person. This
   explicit action is required even
   when the browser is already signed in. The page explains that the device
   receives ingestion access that expires after 30 days but renews automatically while the
   Collector keeps reporting, and that access ends only when the device is revoked or stops
   renewing.
6. The helper notices approval, obtains package access, verifies/downloads the
   package, constructs and privately saves the device credential, and invokes
   the existing installer. No token prompt is shown.
7. Known legacy installations keep the current migration consent, private backup
   and rollback behavior. Migration/privacy conflicts are not silently accepted.
   The helper connects interactive prompts to the controlling terminal even
   when the launcher arrived through a pipe.
8. The result reports installation/service status and links to the existing
   device list and telemetry receipt guidance. Database receipt remains
   explicitly unverified until checked. This feature adds no synthetic events,
   correlated receipt API or automatic database verification.

Explicit confirmation prevents a verification link alone from granting device
access. It does not require entering or copying a token.
Cancellation, denial, expiration and missing editor permissions have explicit
messages. A denial does not create a registered device.

Code matching alone does not establish device ownership: an attacker can send
both their verification link and matching code to an editor. This remote-phishing
risk remains even with explicit confirmation, as described in RFC 8628 section
5.4. Treat the warning as mitigation, not a guarantee, and make the renewable
ingestion permission (30-day expiry, automatic renewal, revocation as the only hard stop)
visible before approval.

## Boundaries

- Existing generic OIDC login remains responsible for identity and role mapping.
  Cognito, Okta and Keycloak deployments share the same application flow; this
  does not require those providers to implement a device grant.
- Approval and device details require `collector:manage`, currently editor
  (`analyst`) or admin. Viewer/demo users cannot approve, register, download a
  package, or obtain credentials. Enforce this on the server.
- Two small credential-free bootstrap artifacts must be publicly downloadable:
  the shell launcher and its Python enrollment helper. They reveal no customer
  settings or package credentials. Package archives remain access controlled.
  This limited public entry point is necessary for a terminal without SSO
  cookies; it is not a public device registration permission.
- Browser refresh tokens, IdP access tokens, session cookies and client secrets
  never go to the installer. Device credentials authorize OTLP ingestion only.
  Short-lived enrollment credentials authorize only this installation flow.
- Keep the manual download/token flow as an advanced recovery option.
  Workshop organizer provisioning remains a separate documented mode.
- Browser enrollment requires OIDC sign-in. Basic-auth deployments do not offer it and
  keep the manual download/token flow.
- No new service, user pool, domain, collector port, database engine or node
  expansion is required.

## Enrollment protocol

Use an application device-pairing protocol informed by RFC 8628. Do not advertise
it as a new OAuth grant supported by the configured IdP.

### Request

The Python helper generates a random 256-bit future device secret and holds it
in memory. It submits only the SHA-256 digest of its canonical base64url string,
plus a bounded device name and platform, to an enrollment-start endpoint.

The server generates an unpredictable public request handle, a separate
256-bit polling credential, a short human-readable confirmation code and a
ten-minute deadline. The polling credential is stored only as a digest; the other
request fields are stored as written. Return the verification URL, confirmation
code, polling credential, polling interval and deadline to the helper once, in the
HTTPS response body. Never include the polling credential or device secret in a
URL, shell argument, browser page or log.

The request's device-secret digest, device metadata and deadline become immutable.
The verification handle allows lookup by an authenticated editor; it does not
authorize polling, package download, approval or ingestion by itself.

### Approval

The connection page uses the existing safe `returnTo` login support. Reading a
page or following an SSO callback never approves a device. Approval is a
same-origin POST with the authenticated editor's role checked again.

Atomically transition the request from pending to approved and create exactly
one device record under that editor's issuer-scoped owner identifier. The record
uses the request's immutable secret digest and the existing 30-day expiry.
Conditional writes prevent concurrent approvals from rebinding ownership or
creating multiple devices. Denial and expiration are terminal.

Use the existing DynamoDB table with a separate enrollment key namespace and
short TTL; never include enrollment records in owner device lists. Application
deadline checks are mandatory regardless of DynamoDB TTL cleanup. Review the
transactional store implementation and effective IAM requirements before rollout.

### Delivery and retry

The helper polls no faster than every five seconds with the private polling
credential, with backoff for throttling and transient failures. Approval returns
the owner/device identifiers needed to construct the existing
`ccd1.<owner>.<id>.<secret>` credential locally. The registry still stores only
the device secret's hash; no bearer token is persisted server-side or displayed
in the browser.

The same approved enrollment can return its same result until its deadline to
recover a lost response. Retrying must never create a second device, extend the
30-day lifetime, or reverse revocation. Before returning approved metadata or a
package, verify that the registered device remains unrevoked and unexpired.

Approval returns the expected package hash. The helper downloads the package with
the locally constructed device token through the existing device package route
(v1.8.0 made device tokens package credentials for the manual `curl | sh` flow). The
polling credential grants no package, dashboard or management access.

The helper creates a mode-0600 temporary token file within a private directory
and passes only its path through the existing `--token-file` interface. Clean
temporary material on success, interruption and failure. Installed credential
storage remains private. Never extend enrollment after its absolute deadline.

## Bootstrap and installation

- Pin the Python helper digest in the generated launcher. Bind package hashes
  and bytes to one release so a rolling deployment cannot silently mix versions.
  A release mismatch fails with a retry instruction before client changes.
- Use TLS validation, bounded response sizes/timeouts, private random temporary
  directories, safe archive extraction, and same-origin downloads for the
  launcher, helper and dashboard packages. Reject redirects for those requests.
- Preserve the installer's separate checksum-pinned OpenTelemetry binary
  download from the official GitHub release, including its necessary HTTPS
  release-asset redirects. Never attach enrollment/ingest credentials to this
  separate download client. Dashboard packages continue to omit binaries.
- A piped script must not consume user input from its source stream. Missing
  controlling-terminal access fails with an interactive-run instruction when
  migration consent is necessary.
- Run as the normal user. Do not automatically install Python, invoke root
  package managers, or enable Linux user lingering with implicit privileges.
  Preserve existing prerequisite and service-persistence guidance.
- Preserve current telemetry attribution on a recognized migration/reinstall.
  New installations default to the approving account's IdP-verified email, falling
  back to the local login, with an optional `--user-id` override. The approving SSO
  account owns the device; the attribution remains client-configured and editable on
  the device, not verified per-event identity.
- An aborted or failed installation after approval leaves a revocable device
  entry. Explain how to remove it; do not imply that local rollback revokes it.
- Collect no additional diagnostic telemetry for the enrollment process.

## Abuse controls and operations

Exact public paths are mounted separately from the existing authenticated APIs.
All enrollment responses are `no-store`; verification pages use a restrictive
referrer policy and contain no third-party resources.

Bound start/poll request bodies, concurrent work, database timeouts and in-memory
rate-limit state. Apply start limits, approval limits per authenticated owner,
and polling limits per enrollment. Accommodate a workshop sharing a NAT address;
do not select an IP limit that blocks ordinary 140-participant enrollment.
Failures must not consume unbounded memory or bypass existing ingest admission.

At a five-second interval, 140 simultaneous pending installers produce about
28 polls/second before retries. Measure this path independently from ClickHouse
queries; it must not query telemetry tables. Avoid expensive database writes on
every normal poll. Document each replica's limit scope.

Audit approval/denial outcomes using the existing privacy policy, with opaque
identifiers. Never log request bodies, enrollment credentials, device secrets,
verification URLs, raw identity claims or token files.

## Acceptance and release

Before implementation is released, add and run installer/auth regression tests:

- macOS/Linux detection, supported architectures and prerequisite errors;
- open-browser and headless-link paths, including piped interactive migration;
- anonymous start cannot issue a token; demo/viewer approval and download denied;
- browser GET/callback cannot approve; cross-origin approval denied;
- distinct browser handle and polling credential; the polling credential is delivered
  once in the start response body; wrong or expired proof denied;
- two API replicas, concurrent approval, lost responses and idempotent delivery;
- secret digest immutability and absence of raw credentials from stored records;
- revocation before package download, failure after approval, and expiration;
- role-gated UI, SSO return path, confirmation, rejection and retry messages;
- wrong release/hash, archive traversal, redirects, cleanup and private files;
- preserved existing client configuration and legacy migration rollback.

Review the complete latest change, complete required CI and obtain the mandatory
content review before publishing/deploying. Deploy the verified immutable image
to the existing demo EKS target following the release runbook. Check both API
replicas and public bootstrap behavior without exposing real user credentials.
Report actual browser/native-host checks separately from simulated tests.

## Builder decisions

Route names, component layout, confirmation-code alphabet, transaction wrapper,
private scratch paths, rate-limit constants and retry presentation may be chosen
during planning within the requirements above. The product decision requiring
review is the single explicit browser confirmation after SSO.

## Implementation

- Routes: `GET /api/ingest/enroll.py`, `POST /api/ingest/enroll/start`,
  `POST /api/ingest/enroll/poll` (public); `GET /api/collector/enrollments/:handle`,
  `POST .../approve`, `POST .../deny` (`collector:manage`, same origin); the page is
  `/collector/connect/:handle`. See the [API reference](../../api-reference.md).
- `install.sh` runs browser enrollment by default and pins the helper's SHA-256;
  `sh -s -- --token` keeps the manual flow, which is the only flow when packages or the
  helper are absent. `collector/build-packages.mjs` publishes `enroll.py` beside the
  archives, outside them.
- Enrollment records use the existing table under the `enrollment` partition key, which no
  owner digest can equal, with a TTL one day after the deadline. Approval is a conditional
  pending-to-approved update that fixes the owner, device ID and approval time; the device
  record is then written with the existing conditional put. If that write fails, a retried
  approval or the next poll writes the same record, so no transaction or new IAM action is
  needed. A revoked device is never recreated.
- The OIDC principal cookie keeps a verified `email` only for this default. Approval stores
  it on the enrollment, never in logs.
- Limits per replica: 600 starts per ten minutes, 30 polls per request per minute,
  30 decisions per account per hour, 16 enrollment requests in flight (separate from the
  eight ingest slots), 1 KiB start bodies and a ten-second request deadline.
- Not implemented: approval/denial audit events. The routes log nothing, like renewal.

## References

- [RFC 8628: device authorization, particularly sections 3.3.1 and 5.4](https://www.rfc-editor.org/rfc/rfc8628)
- [RFC 8252: native application browser authorization](https://www.rfc-editor.org/rfc/rfc8252)
- [Organization SSO](../../runbooks/organization-sso.md)
- [Device collectors](../../runbooks/device-collectors.md)
- [Production deployment](../../runbooks/deploy-production.md)
