# Runbook: Cut Collectors Over to the Ingest-Scoped ClickHouse User

## Scope and prerequisites

`infra/clickhouse.tf` declares `otel_ingest` with `INSERT ON claude_code.*` and
`SELECT ON claude_code.otel_metrics_sum`. The second grant is required because the
existing materialized view evaluates its SELECT under the inserting user's privileges.
`otel_writer` remains the privileged account for schema-init and backup jobs.

Use this procedure before a new fleet launch or planned ingest-password rotation. Have
Terraform inputs/state, writer/admin SQL access, and SSM SecureString/KMS permissions.
Use the `kube`/`ch` helpers in [incident response](incident-response.md).
Verify the target account, context, region, and parameter mapping before changing anything.

A password change immediately affects authentication to ClickHouse, while running
collectors retain their boot-time password. Coordinate rotation with fleet replacement;
updating SSM alone does not refresh running instances. Preserve/drain queues before removing
instances. Existing workshop instances using `otel_writer` remain on that account until
reprovisioned; this is an intentional transition policy.

## 1. Apply and verify the account

Generate/store the password through the approved secret workflow. Supply
`clickhouse_ingest_password` using a protected, gitignored `infra/secrets.auto.tfvars` or
secret-injected `TF_VAR_clickhouse_ingest_password`. Do not put values in `-var` command
arguments, shell history, examples, or logs. Terraform sensitive marking does not remove
secret values from state.

```bash
terraform -chdir=infra plan
terraform -chdir=infra apply
CH_USER=otel_writer CH_SECRET=clickhouse-writer ch <<'SQL'
SHOW GRANTS FOR otel_ingest;
SQL
```

Review the plan before apply. Require both effective grants:

```text
GRANT INSERT ON claude_code.* TO otel_ingest
GRANT SELECT ON claude_code.otel_metrics_sum TO otel_ingest
```

Source declarations do not establish that the operator rendered both grants. If SELECT is
missing, stop before launching collectors; INSERT itself can fail with `ACCESS_DENIED`.
Inspect the operator's rendered user configuration. A reviewed `users.d/*.xml` entry with
two `<query>` elements is the documented fallback if the list-valued grant configuration
is not supported by the installed operator. Do not grant full database SELECT or switch the
collector back to a privileged account merely to bypass the diagnostic.

## 2. Synchronize the SSM SecureString

Terraform does not manage `/claude-code/ab/clickhouse-ingest-password`. Its value must match
the applied `clickhouse_ingest_password`, also stored in Secret `clickhouse-ingest`.
The following creates the parameter using a private temporary file, without displaying
credentials. `REGION` must match the participant template's SSM lookup region:

```bash
: "${REGION:?Set the participant SSM region}"
(
  set -euo pipefail
  set +x
  umask 077
  ingest_secret_file=$(mktemp)
  trap 'rm -f "$ingest_secret_file"' EXIT
  kube get secret clickhouse-ingest -o jsonpath='{.data.CH_PASSWORD}' \
    | base64 -d > "$ingest_secret_file"
  test -s "$ingest_secret_file"
  aws ssm put-parameter --region "$REGION" \
    --name /claude-code/ab/clickhouse-ingest-password --type SecureString \
    --value "file://$ingest_secret_file" --query Version --output text
)
```

For a confirmed rotation of this exact parameter, add `--overwrite`; an existing-parameter
error otherwise protects against accidental replacement. Supply the approved `--key-id` if
a customer-managed KMS key is required. The writing identity needs the appropriate SSM/KMS
permissions; participant instance profiles independently need `ssm:GetParameter` and
`kms:Decrypt`. Verify scope for this parameter instead of assuming writer-password access
covers it. If SSM and ClickHouse are in different accounts, provision through the intended
identity and parameter path for that participant account.

## 3. Launch and verify fresh instances

`user-data.sh` is a cloud-init template, not a fleet updater. Render it for the target,
including collector config delivery and `CH_USER=otel_ingest`, then launch replacement
instances. Do not edit `/etc/otelcol/env` on running workshop instances for this cutover.
On a fresh instance, verify only non-secret fields/status:

```bash
sudo grep '^CH_USER=' /etc/otelcol/env
sudo stat -c '%a' /etc/otelcol/env
sudo systemctl status otelcol.service
sudo grep -c 'CH_PASSWORD=' /var/log/cloud-init-output.log
```

Expect `CH_USER=otel_ingest`, file mode `600`, an active service, and zero traced password
assignments. `grep -c` exits 1 for zero matches; that is expected for the final check, not
a failed cutover. It is a targeted check, not proof that no secret leaked through any path.

During authorized participant activity, verify new raw metrics/logs and advancing hourly
rollup values. Both raw INSERT and MV output must work with the scoped account. A running
service without new rows is insufficient; inspect exporter errors and queue state.

## Rollback and follow-up

If new instances cannot ingest, stop rollout and fix the mapping/grants. For a deliberate
rollback, restore the approved prior launch-template configuration (`CH_USER=otel_writer`
and its SSM parameter) and reprovision; do not patch the live fleet ad hoc. If the ingest
password itself changed, coordinate restoring the previous approved value in both
ClickHouse and SSM or finish replacement with the new value. Account/SSM changes are not
rolled back by changing the dashboard image.

Once the last writer-authenticated collector is gone, review writer reachability separately.
Do not delete `otel_writer`: schema-init and the daily backup still depend on it.
