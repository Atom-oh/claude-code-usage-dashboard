# Workshop Studio Deployment Notes

This guide covers adapting the participant infrastructure for the dashboard. The repository
contains Terraform for the admin workload and an EC2 cloud-init template, not a completed
Workshop Studio CloudFormation deployment. Validate the actual workshop account constraints
and deployed endpoints before a session; repository declarations do not prove availability.

## 1. Participant identity

For the workshop scenario with one AWS account per participant, an account-based synthetic
identifier can provide a fallback without a separate lookup table. In the CloudFormation
resource that owns the participant's telemetry environment, the substitution pattern is:

```yaml
OTEL_RESOURCE_ATTRIBUTES: !Sub "user.email=${AWS::AccountId}@ws"
```

Integrate this into the rendered environment/managed-settings document; it is not a standalone
CloudFormation resource. Check actual emitted `user.email` and `enduser.id` per auth path.
Enterprise login can provide a real authenticated email, which should not be overwritten
without verifying precedence and the privacy decision. In the separate fixed-group EC2
template, `user-data.sh` reads the `Email` IMDS tag (or configured SSM fallback) and forces
`user.email` only for Bedrock. That requires instance metadata tags to be enabled.

Most existing user queries use `UserEmail`, not a universal `EndUserId` fallback. Verify
identification in the actual dashboard and raw data; an injected fallback alone is insufficient.

## 2. Auth choice and group inference

For a shared image where participants choose login method, do not bake in a static Bedrock
managed-setting overlay. Provide the Bedrock environment selection or Enterprise sign-in
instructions through the workshop's chosen participant flow. `user-data.sh` currently has
fixed-group behavior and must be adapted for this scenario.

`dashboard/server/grouping.js` infers each `SessionId` from the hourly rollup:

1. Any nonempty `Model` not starting with `claude-` is Bedrock evidence, including
   non-Anthropic model names.
2. Otherwise `max(has_org)=1` is Enterprise evidence; `has_org` comes from datapoint
   `Attributes['organization.id']`.
3. Otherwise the session is unknown. Empty `SessionId` values are excluded from the classifier.

`EXPERIMENT_GROUP`/`ExperimentGroup` is not the dashboard's classification source. Remove or
neutralize the collector's static `experiment.group` upsert for the shared-image scenario
as appropriate, and validate the rendered pipeline. Inferred channels do not identify the
emitting client and are not evidence of a controlled A/B experiment.

## 3. Reuse the operational bootstrap

Adapt the concrete blocks in `user-data.sh`:

- Install the selected collector binary at `/usr/local/bin/otelcol-contrib`, provide
  `/etc/otelcol/config.yaml`, and supervise it with `otelcol.service`, `Restart=always`,
  `RestartSec=5`, and `EnvironmentFile=/etc/otelcol/env`. The template's placeholder config
  bucket must be replaced or the file preinstalled/inlined in UserData.
- Preserve the writable disk queue (`OTELCOL_QUEUE_DIR`, normally `/var/lib/otelcol/queue`),
  `file_storage`, bounded queue size, and retry settings from `collector-config.yaml`.
  Process restart and queued retries cover different failures; neither guarantees no loss.
- Fetch the ingest password from the correct SSM SecureString at boot with xtrace disabled;
  keep `/etc/otelcol/env` mode 600. Follow
  [ingest user cutover](runbooks/clickhouse-ingest-user-cutover.md). Do not embed credentials
  in CloudFormation, command examples, or logs.
- Write managed telemetry settings to `/etc/claude-code/managed-settings.json`. Keep local
  OTLP/gRPC on port 4317, cumulative temporality, and `OTEL_METRICS_INCLUDE_SESSION_ID=true`.
  Trace collection also needs the beta/export settings and an existing traces table.
- Validate actual client/collector versions on sample instances. `user-data.sh` declares
  versions, but installation failure can leave a different client installed. Do not invent
  a version requirement from an old cohort observation.

A repository `project.name` tag is not an instance identity. Managed settings currently own
`OTEL_RESOURCE_ATTRIBUTES`, so a project-local setting cannot override that string on this
fleet. Choose the documented project-tag injection policy before expecting project panels
to populate; migration 005 cannot create absent tags retrospectively.

## 4. Post-deployment verification

Use the `kube`/`ch` access setup in [incident response](runbooks/incident-response.md).
On sample participant instances, inspect status and redacted logs:

```bash
sudo systemctl status otelcol.service
sudo journalctl -u otelcol.service -n 50 --no-pager
```

During authorized participant activity, verify both raw freshness and rollup coverage:

```bash
ch <<'SQL'
SELECT count(), max(TimeUnix) FROM claude_code.otel_metrics_sum;
SELECT count(), max(Timestamp) FROM claude_code.otel_logs;
SELECT count(), min(hour), max(hour), max(hour) >= toStartOfHour(now()) AS current_bucket
FROM claude_code.otel_metrics_sum_hourly;
SELECT min(toStartOfHour(TimeUnix)) FROM claude_code.otel_metrics_sum;
SELECT DISTINCT AggregationTemporality FROM claude_code.otel_metrics_sum;
SQL
```

Check `count()` before interpreting min/max on an empty table. An hourly bucket can lag
wall-clock time by nearly an hour; a missing current bucket is only suspicious while raw
telemetry is arriving. MV creation does not backfill old history. The watermark backfill
helper needs a nonempty rollup and only fills before its earliest bucket; interior gaps and
segment cutover need the [rollup procedure](runbooks/rollup-rebuild-segment-key.md).

Also verify:

- Actual CHI status, desired replicas, and available NodePool capacity. Terraform declares
  three replicas and a Karpenter pool, not guaranteed scheduling. Inspect Pending events
  and node limits before reducing redundancy or changing capacity.
- Both inferred channels and participant identity using the current `GROUP_CTE`, not a
  query grouped by `ExperimentGroup`. Compare version cohorts before interpreting differences.
- Actual attribute keys in `Attributes`, `LogAttributes`, and `SpanAttributes`; inspect
  counts/key names without copying prompt bodies or personal values into shared logs.
  Schema/query/Grafana/collector changes may all be needed when mappings change.
- Effective reader grants and `getSetting('readonly')`. The explicit reader grant is
  `SELECT ON claude_code.*`; limited system introspection can differ by server defaults.
  With the reader, verify a query to `system.query_log` is denied. A table-function denial
  test must use an operator-controlled harmless target in a planned test, since a broken
  grant could cause an outbound request. Never use metadata/credential endpoints as probes.
- Effective ingest INSERT plus source-table SELECT grants, raw inserts, and MV output.
  A source grant declaration alone does not prove the installed operator applied it.
- Actual prompt/tool-detail privacy: the collector removes log `prompt` and `prompt_text`
  keys, but `tool_parameters` and other fields can still contain sensitive material.
  `create_schema: false` and the pre-created schema are intentional; do not switch to
  automatic schema creation to suppress a version/schema mismatch.

Cumulative values (`AggregationTemporality=2`) require counter differencing. Delta values
(`1`) are supported but make overlapping backfills non-idempotent. Reported cost is an
estimate, computed cost is diagnostic, and neither alone establishes billed spend or a
causal productivity difference.

## 5. Admin and participant infrastructure boundary

Read the target endpoints from Terraform outputs after verifying the deployment:

```bash
terraform -chdir=infra output -raw ch_ingest_url
terraform -chdir=infra output -raw dashboard_url
```

The participant collector writes to ClickHouse through the ingest endpoint; it does not
send OTLP directly to the dashboard API. The declared public path is HTTPS to CloudFront,
then HTTP over internal TCP NLBs to ClickHouse 8123 or dashboard 8080. The NLB listener
named for port 443 does not terminate TLS in this configuration. `AllViewer` forwards
viewer headers and `CachingDisabled` is declared; verify the applied policies.

The committed collector exporter uses `tcp://...?...secure=true`, which is a native TLS
connection template. For CloudFront, configure the exporter with the actual **HTTPS
ClickHouse endpoint** and its existing `username`/`password` fields; CloudFront cannot proxy
native ClickHouse TCP. Do not introduce a fabricated `headers.Authorization` configuration.
Validate the rendered configuration with the installed exporter and verify ingestion.
The collector's local OTLP/gRPC receiver remains on `127.0.0.1:4317`.

Participant infrastructure is separate from the admin stack. Provision the actual endpoint,
network path, SSM/KMS access, and ingest credentials before the workshop; do not assume an
endpoint is live because its hostname appears in a template.

For dashboard chat, inspect `chat_model_id`, `bedrock_region`, and the applied dashboard IRSA
policy. `chat_model_id` drives both `CHAT_MODEL_ID` and model/profile ARN selection.
The client chooses `BEDROCK_REGION`, then `AWS_REGION`, then `us-east-1`.
**For the known Workshop Studio account configuration that permits Bedrock only in
`us-west-2`, set `bedrock_region = "us-west-2"` when moving the dashboard image there.**
Verify that restriction for the current event; it is not a universal statement about AWS
accounts. The image can be reused while the environment and IAM/model availability change.
An empty `bedrock_region` omits the override and follows the infrastructure region.

The workshop can disable `pii_mask_enabled` so participants recognize synthetic `@ws`
identifiers, but verify Enterprise sessions have not introduced real emails before doing so.
UI masking is not an API boundary. Basic Auth and chat's readonly probe remain required.
Chat exposes the permitted database read surface to everyone sharing the admin credential;
per-participant isolation requires additional authorization design. The product UI stays
Korean; these notes describe its fields and behavior in English.
