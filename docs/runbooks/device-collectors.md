# Device collectors

## Access and installation

When device ingestion is enabled, users with the generic `analyst` (editor) or `admin`
role open **Collector installation** (`/collector`). Viewer/demo users have neither
navigation nor management/download API access. Group names remain configurable through
[organization OIDC](organization-sso.md); no account or domain is hardcoded.

1. Download the Linux or macOS archive while signed in. Both configure Claude Code
   and Codex; install those clients separately if absent.
2. Register a named device. Copy its token once; the server stores only a hash.
3. Extract the archive and run the command shown on the page. Supply the HTTPS
   dashboard ingestion endpoint, then paste the token at the hidden prompt. Do not
   put it in shell arguments, URLs, screenshots or shared files.
4. Follow the included README for Python prerequisites, configuration checks, service
   status and uninstall. Linux uses a user systemd service; EC2 reboot persistence
   requires `loginctl enable-linger` for that user. macOS uses a per-user LaunchAgent,
   which runs in that user's login session.
5. Start new Claude Code/Codex sessions. Check device last-delivery time and dashboard
   receipt separately. A healthy process or accepted OTLP batch is not proof of a
   database commit or complete cost telemetry.

Existing model/provider/login settings are preserved. Conflicting unmanaged OTel
settings/services are rejected; migrate their owner explicitly. Codex's
`analytics.enabled=false` disables its custom metrics export too; the installer does
not silently override this privacy choice. Identity entered during setup is
client-provided telemetry attribution, not verified SSO identity.

A token authorizes ingestion only and expires 30 days after issue. To replace it,
issue a new token, rerun setup, verify delivery and revoke the old device. Revocation
may take up to ten seconds to reach another API replica's validation cache. Browser
logout or removal of an IdP group does not revoke previously issued device tokens;
revoke them explicitly during offboarding. Owners manage only their own devices.
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
the receiver separately mounts the existing INSERT-only ClickHouse credential.
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
  device token cannot read dashboard APIs and browser cookies cannot ingest.
- Send isolated Claude and Codex OTLP fixtures through the gateway, then inspect
  the correct existing-schema tables and retained client/backend identities.
- Revoke one fixture token and verify both API replicas reject it after ten seconds.
- Exercise upstream outage/retry and confirm bounded queue/admission behavior.
- Check `/readyz`, receiver health, errors and telemetry receipt after rollout.

Gateway admission is separate from expensive query admission: eight in-flight
requests, a 15-second deadline and a 2 MiB uncompressed body maximum per process.
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
