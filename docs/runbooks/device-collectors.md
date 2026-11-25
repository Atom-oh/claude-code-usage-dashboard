# Device collectors

## Access and installation

When device ingestion is enabled, users with the generic `analyst` (editor) or `admin`
role open **Collector installation** (`/collector`). Viewer/demo users have neither
navigation nor management/download API access. Group names remain configurable through
[organization OIDC](organization-sso.md); no account or domain is hardcoded.

1. Select Linux or macOS. Both packages configure Claude Code and Codex; install those
   clients separately if absent.
2. On the device, run the page's `curl -fsSL <origin>/api/ingest/install.sh | sh`
   command. It downloads the digest-pinned `enroll.py` helper, which prints a
   confirmation code and an approval link and opens the browser on a desktop. On a
   headless host, open the link on another computer.
3. Sign in, check that the page shows the terminal's code, and select **Connect this device**.
   Approve only an installation you started; a link and code sent by someone else can
   enroll their device under your account. The helper then builds the device token
   locally from its own secret, downloads and hash-checks the package, and runs the
   installer with a private token file. No token is shown or pasted.
4. Follow the included README for Python prerequisites, configuration checks, service
   status and uninstall. Linux uses a user systemd service; EC2 reboot persistence
   requires `loginctl enable-linger` for that user. macOS uses a per-user LaunchAgent,
   which runs in that user's login session.
5. Start new Claude Code/Codex sessions. Check device last-delivery time and dashboard
   receipt separately. A healthy process or accepted OTLP batch is not proof of a
   database commit or complete cost telemetry.

Device identity: the ingest proxy forwards each verified token's `<owner>.<id>` as
`x-ccdash-device`. The pair identifies a device but cannot authenticate one: ingestion
still needs the token's secret part. The device receiver deletes any client-sent
`ccdash.device` resource attribute and sets it from that header on logs and traces. On
metrics it only deletes a client-sent value: setting a new resource attribute would split
cumulative series that are running at rollout. Only dashboard pods reach the receiver
(network policy), so for rows that came through device ingestion the value is
server-verified, unlike `user.email`. The repository's other collector configurations
(`collector-config.yaml` and the generated `local.yaml`) delete a client-sent value, so
honest participant collectors cannot claim a device. Anyone holding ClickHouse insert
credentials, as participant collectors on the direct path do, can still write any value. The user
detail drawer lists devices from it (`/api/users/devices`), with registry names only while
the PII mask is off. Data from before this change, or from other paths, has no device.
During the receiver rollout, a batch retried across the change can be stored once without
and once with the attribute; whole-row deduplication then keeps both copies.

Existing model/provider/login settings are preserved. Conflicting unmanaged OTel
settings/services are rejected; migrate their owner explicitly. Codex's
`analytics.enabled=false` disables its custom metrics export too; the installer does
not silently override this privacy choice. Browser enrollment sets the
attribution ID to the approving account's IdP-verified email, including on a reinstall or a
migration from an older collector whose recorded, migrated or typed ID differs; `| sh -s --
--user-id ID` applies only when that login has no verified email. The device Collector then
sets every Claude and Codex resource `user.email` to the installed ID, so shell, settings or
Codex values edited locally do not change it. Token-flow installs keep the typed or recorded
ID. The override applies in every install mode, token flow included: the device
Collector uses whatever ID is installed. A cumulative metric series keeps one identity for
its whole life. The installer records identity epochs in
`~/.local/share/ccdash-collector/state.json` (`identity`: one `{since, userId}` per installed
ID, appended only when it changes, plus the defaults the first replaced Collector inserted
for Claude and Codex). A metric series gets the ID of the epoch it started in; a series that
started before the first epoch, or reports no start time, keeps its own ID or that first
default. Logs and traces switch immediately. Restart Claude Code and Codex after
reinstalling so new series start under the new ID. Earlier rows stay under the previous ID
(no merge), and collectors installed before this change keep insert-only attribution until
reinstalled. `claude_code.session.count` is keyed by labels only (ADR-003), so a session that
spans an identity change is counted once under each ID. The history survives uninstall
(`state.json` is kept). Renewal is scheduled before the Collector starts, so a failed install
rolls back before new-epoch telemetry is exported; only a legacy migration's post-start
health check can still roll back after the new Collector ran briefly. A legacy migration records nothing for Claude and the legacy
`CODEX_DEFAULT_USER_EMAIL` for Codex as those defaults; close clients first, as prompted. This is still device-configured attribution, not server-verified per-event
identity: a device owner can edit the Collector configuration itself.

The approval request lasts ten minutes and is decided once (approve or deny); a later
approval by another account fails. Opening the link or returning from SSO never decides
it. Delivery of an approved result ends at the same deadline, so a helper that misses it
leaves a registered device to revoke. A failed installation after approval does the same.
Deployments without built packages (no `enroll.py`/`manifest.json`) and Basic-auth
deployments offer only the manual flow.

Manual flow (recovery, or when browser approval is unavailable): register a named device
in the advanced **manual token installation** section, copy its token once (the server stores only a hash),
and run `curl -fsSL <origin>/api/ingest/install.sh | sh -s -- --token`. The script asks for
the attribution ID and then the token at a hidden prompt. Do not put the token in shell
arguments, URLs, screenshots or shared files.

The [package guide](../../dashboard/collector/README.md) includes the complete personal
installation flow, legacy macOS/Linux service migration, receipt checks and recovery.
Use the [Workshop Studio preparation notes](../workshop-studio-notes.md#installation-and-ingestion-choices)
for organizer-provisioned participant EC2 instances. Those instances keep their prepared
Collector and do not need individual device enrollment.

Owners can delete a revoked device from their list. The registry keeps a deletion marker
until its existing TTL cleanup so a retry of browser enrollment cannot reactivate the token.
Historical usage stays available.

A token authorizes ingestion only and expires 30 days after issue. Installed packages
[renew it](../../dashboard/collector/README.md#automatic-token-renewal) within seven days of
expiry; the replacement becomes current on first use and the old token is then rejected.
There is no maximum lifetime: a renewing device stays enrolled until revoked, while one that
is off or cannot renew for 30 days expires. Earlier installations must rerun the latest
installer once. Do not roll the dashboard back to a release without renewal: it rejects
replacement tokens that have not been used yet, and those devices must be registered again.
During a rolling update, a device that renews through a new pod can be rejected by an old
pod for a few minutes; it recovers once a new pod accepts the replacement.
To replace a token manually, issue a new token, rerun setup, verify delivery
and revoke the old device. Revocation
may take up to ten seconds to reach another API replica's validation cache. Browser
logout or removal of an IdP group does not revoke previously issued device tokens;
revoke them explicitly during offboarding. Renewal does not recheck IdP group membership.
A stolen token can also be renewed: if someone else renews and uses it first, the
legitimate device fails with `invalid_token`, its last receipt stops and `renewedAt`
changes unexpectedly. Revoke that device. A token superseded by renewal is rejected; its
first later use sets `reuseDetectedAt` once and shows a revocation warning on the device,
since either copy may be the stolen one. Owners manage only their own devices.
An installation operator can revoke an inaccessible owner's record through its
controlled DynamoDB operational workflow; never copy the stored hash into a token.

Local token files are private (0600) and absent from archives. Local disk queues are
bounded and may contain scrubbed telemetry; retain host disk access controls. Queue
exhaustion, expired credentials and persistent exporter errors can lose data. The
central receiver uses bounded memory queues, so a receiver restart can lose accepted
but unflushed records. These limits are not delivery guarantees.

## Enable on EKS

Source: `infra/device_ingest.tf`. This is opt-in and requires
OIDC. The application mounts the internal receiver credential from a Kubernetes Secret;
the receiver separately mounts the existing `otel_ingest` ClickHouse credential.
Its grants include `INSERT ON claude_code.*` and
`SELECT ON claude_code.otel_metrics_sum`; it is not strictly write-only.
The application query account remains read-only. The receiver has only a ClusterIP
service, bearer authentication and dashboard-pod ingress policy; there is no new public
load balancer or DNS name. Verify CNI NetworkPolicy enforcement on the target cluster.

Provision a namespace Secret through the installation's secret manager, with key
`token` containing at least 32 base64url characters. Keep values out of Terraform and
its plan output. Set these nonsecret private deployment inputs:

```hcl
device_ingest_enabled     = true
device_ingest_secret_name = "dashboard-device-ingest"
```

Terraform creates a KMS-encrypted DynamoDB table with owner/device keys, expiry cleanup
and deletion protection. The IRSA role receives only item get/put/update and owner
query operations on that table. `purgeAt` is expiry plus seven days; DynamoDB TTL cleanup
is asynchronous and never substitutes for application expiry checks. Restore of old
registry data can restore revoked credentials; do not restore without invalidating
or reconciling every affected token.

Follow the [release procedure](deploy-production.md): review the complete plan, create
the internal receiver/registry, deploy the matching immutable dashboard image, and
verify rollout. New receiver requests total 200m CPU and 384Mi memory across two
replicas; these are scheduling requests, not measured capacity. Confirm available
capacity without expanding nodes. Preserve live schema, login and unrelated workloads.

Application settings are `INGEST_ENABLED=1`, `INGEST_TOKEN_TABLE`,
`INGEST_UPSTREAM_URL`, `INGEST_UPSTREAM_TOKEN_FILE`, and the existing `APP_PUBLIC_URL`
and `OIDC_ISSUER`. The public endpoint is the dashboard origin plus `/api/ingest`.
Existing raw ClickHouse HTTP ingest remains a separate legacy path; per-device
revocation does not revoke credentials previously issued for that path.

## Verify and recover

- Deny unauthenticated and viewer management/download requests. Confirm a valid
  device token cannot read dashboard APIs and browser cookies cannot ingest or download
  `/api/ingest/package/*`. `/api/ingest/install.sh` and `/api/ingest/enroll.py` are
  intentionally public: `install.sh` must contain only the ingestion endpoint and the
  helper's SHA-256, and `enroll.py` contains no credential or digest of its own (it is
  pinned by `install.sh`).
- Run one browser enrollment end to end: anonymous start returns only a code, link and
  polling credential; approval needs an editor session and same-origin POST; the device
  appears under the approver's devices.
- Send isolated Claude and Codex OTLP fixtures through the gateway, then inspect
  the correct existing-schema tables and retained client/backend identities.
- Revoke one fixture token and verify both API replicas reject it after ten seconds.
- After a device's first renewal, check its `status` (`lastRenewal`) and `renewedAt`.
- Exercise upstream outage/retry and confirm bounded queue/admission behavior.
- Check `/readyz`, receiver health, errors and telemetry receipt after rollout.

Gateway admission is separate from expensive query admission: eight in-flight
requests (OTLP, renewal and device package token checks share them), a 15-second deadline and a 2 MiB uncompressed body maximum per process.
Only JSON/protobuf OTLP POST is accepted, with no content compression. Local packages
configure OTLP/HTTP `compression: none`. Metadata-store failures fail authentication
closed after cached validations expire. Last-delivery time is metadata, not a meter.
It can remain stale or null when metadata updates fail or their separate bounded
queue-free admission is full. Such failures do not turn an already accepted batch
into a retryable response. Authorization is checked again immediately before
forwarding; revocation cannot recall a batch already sent to the receiver.

For application rollback, use the previous verified image. Disable device management
in private Terraform inputs only after planning resource consequences: turning the
feature off also proposes receiver/table removal, and deletion protection intentionally
blocks destroying the registry. Do not disable deletion protection to make a rollback
pass. Preserve the table and investigate/redeploy the compatible image/configuration.

Native macOS service behavior must be checked on a Mac before certifying that platform;
configuration and Linux tests alone cannot establish a macOS installation.

## Upstream references

- [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Claude Code monitoring](https://code.claude.com/docs/en/monitoring-usage)
- [Collector 0.163.1 release](https://github.com/open-telemetry/opentelemetry-collector-releases/releases/tag/v0.163.1)
- [OTLP HTTP exporter](https://github.com/open-telemetry/opentelemetry-collector/tree/v0.163.0/exporter/otlphttpexporter)
