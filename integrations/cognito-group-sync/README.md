# Optional Cognito group reconciliation

This standalone administration integration assigns existing Cognito users to explicitly
managed groups from private configuration. The dashboard continues to authorize signed
OIDC claims; it has no email/domain policy or Cognito administration credentials.
Other OIDC providers do not need this integration.

## Policy and ownership

Use [policy.example.json](policy.example.json) as a fictional example. Supply actual
identities and groups only through a protected deployment input.

- `managedGroups`: 1–16 existing group names; ASCII letters, digits and `_+=,.@-`.
- `emailGroups`: exact email to group-list assignments. An empty list explicitly denies
  managed grants for that email.
- `domainGroups`: complete domains, without wildcards, suffix or subdomain matching.
- The three safety flags must all be `true`. Disabled users, missing/unverified email,
  duplicate attributes and malformed addresses receive no managed grants.
- Email/domain comparisons are case insensitive. Addresses must be ASCII dot-atom email
  addresses with DNS domains; internationalized addresses need an explicit future policy.
- Exact email assignments override domain assignments. Unknown keys, normalized duplicate
  assignments, duplicate JSON keys and unmanaged target groups reject the entire policy.

The module owns its Lambda, encrypted SSM parameter, IAM role, schedule, log group and
alarms. The shared pool, users, app clients, login triggers and groups remain externally
owned. Managed groups must not have Cognito identity-pool `RoleArn` assignments.
Use application-specific groups; do not share these groups with an unrelated application.
Only one reconciler/operator should manage their membership.

The execution role can administer membership within the selected pool. Cognito IAM
resource scoping is at pool level; the validated policy and code restrict group names.
Protect code deployment and parameter-write permissions as authorization administration.
The function cannot create users/groups or update the pool, clients or triggers.

## Reconciliation behavior

Each run reads the full paginated user list and designated group memberships, validates
group metadata, and completes fresh candidate-user and membership reads before its first
write. Failed/incomplete initial or preflight reads produce no membership writes.
Changed users are reread again during application, with a further eligibility and
membership check before every grant. Obsolete managed grants are removed before new ones;
unrelated memberships are preserved. Unchanged users cause no membership writes or
`AdminGetUser` calls.

The APIs do not provide an atomic user/group snapshot or conditional membership update.
A concurrent administrator can change eligibility immediately after a read. Reserved
concurrency prevents this function overlapping itself; it does not lock other writers.
Later runs reconcile that drift. A failure after writes start can leave partial progress,
and successful earlier removals are not rolled back. Failures expose sanitized reasons
and aggregate completed-write counts, never user names, emails or provider response bodies.

Reads are bounded at 100 pages / 5,000 items per listing and 5,000 distinct users.
The 45-second function stops starting SDK calls with less than 15 seconds remaining.
Large or throttled pools may not fit; source tests do not establish a pool capacity limit.
Review observed duration and dry-run completion for the actual pool before enabling writes.
[`AdminGetUser`](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_AdminGetUser.html)
can contribute to Cognito monthly active-user billing; it is used only for changed users.

## Deployment

Use a separate protected Terraform backend. **Sensitive values remain in Terraform state
and saved plans**, despite `sensitive = true` and SSM encryption. Never commit private
variable files, state, plans, policy values or provider responses.

1. Create/review the externally owned managed groups without IAM roles.
2. Prepare a private variable file using
   [terraform.tfvars.example](terraform/terraform.tfvars.example); supply `policy_json`
   from the private policy file. Keep `dry_run = true`.
3. Initialize, review and apply this module's plan through the deployment review process.
4. Inspect aggregate dry-run logs, verify the selected pool and groups independently,
   and require a complete run before setting `dry_run = false` in a new reviewed plan.
5. Confirm membership readback and successful subsequent no-change runs. Configure
   `alarm_action_arns` to receive notifications; empty defaults create alarms without
   notification destinations.

```bash
terraform -chdir=integrations/cognito-group-sync/terraform init
terraform -chdir=integrations/cognito-group-sync/terraform validate
terraform -chdir=integrations/cognito-group-sync/terraform plan \
  -var-file=/protected/identity.tfvars.json -out=/protected/identity.tfplan
```

The template schedules once per minute, with 128 MiB memory and reserved concurrency 1.
Lambda and scheduler retries are disabled; a later schedule recomputes current policy.
There is no failure-payload archive or public endpoint. Error, missing-run and delivery
alarms provide operational signals; monitor them because login does not depend on this job.
The IAM decryption grant is scoped to the exact key, SSM service and parameter encryption
context. A supplied KMS key must permit this role; otherwise the default is `alias/aws/ssm`.

The zip contains only `group_sync.py`. The supported Python 3.13 managed runtime provides
boto3/botocore; no third-party dependencies are bundled. AWS may update those SDK versions.
Record runtime/SDK versions with deployment acceptance evidence when reproducibility is
required; source-unit success does not verify live AWS behavior.
See [Lambda Python runtimes](https://docs.aws.amazon.com/lambda/latest/dg/lambda-python.html)
and [SSM encryption context](https://docs.aws.amazon.com/systems-manager/latest/userguide/secure-string-parameter-kms-encryption.html).

## Delay, maintenance and removal

New membership has a schedule/execution delay; one minute is the schedule, not an
end-to-end guarantee. Already-issued ID tokens and application principals retain earlier
claims until their next renewal/expiry. Keep the dashboard authorization session short
when enabling long refresh persistence; neither a group removal nor this job revokes an
already-issued token immediately.

Set `schedule_enabled = false` to stop scheduled work, or `dry_run = true` to stop writes.
Neither change undoes existing membership. To remove a group from management, first
retain it in `managedGroups` while removing its assignments, run and verify revocation,
then remove it from the list. Destroying the module leaves external users/groups and
their existing memberships intact.

## Offline checks

```bash
python3 -m unittest discover -s integrations/cognito-group-sync -p 'test_*.py'
bash tests/run-all.sh cognito-group-sync
terraform fmt -check -recursive integrations/cognito-group-sync/terraform
```
