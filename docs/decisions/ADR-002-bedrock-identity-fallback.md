# ADR-002: Provision Bedrock identity with a limited query fallback

- Status: Accepted with the original fallback-only approach superseded in part
- Date: 2026-08-11
- Follow-up decision: 2026-08-11
- Reconciled: 2026-09-13

## Context and original decision

The 2026-08-11 census recorded missing Claude-account fields, including `user.email` and
`organization.id`, in Bedrock sessions across a 75.7-million-row dataset. Anonymous `user.id`
and `session.id` remained. This explained missing users in views keyed on `UserEmail`; it
was an observation of that fleet, not a claim about every future client/authentication path.

The original decision was to have [user-data.sh](../../user-data.sh) read the per-instance
`Email` tag through IMDSv2, fall back to a configured SSM parameter, and inject `enduser.id`
into `OTEL_RESOURCE_ATTRIBUTES`. Selected queries would use:

```sql
coalesce(nullIf(UserEmail, ''), nullIf(EndUserId, ''))
```

`EndUserId` is promoted from `ResourceAttributes`. Per-instance metadata avoids baking an
identity into an AMI. The script rejects spaces, commas, and equals signs in the value,
then warns and omits injection rather than stopping boot.

## Same-day follow-up: populate UserEmail at the source

The operator chose to make the provisioned identifier available as **`user.email` as well
as `enduser.id` for the fixed Bedrock group**. Enterprise sessions can already supply an
authenticated email; unverified attribute-merge precedence made forcing a second identity
there undesirable. The current template gates `FORCED_USER_EMAIL` on
`EXPERIMENT_GROUP=bedrock` and a nonempty validated `END_USER_ID`.

This preserves existing `UserEmail`-based leaderboard/query contracts without extending
`incFlat`/`incBucketed` or rewriting the leaderboard's joins. The original coalesce path
remains in selected queries and [grafana-ab-queries.sql](../../grafana-ab-queries.sql), not
universally across the dashboard. A historical tester setup script mentioned by the earlier
record is not part of the current tracked repository and is not a setup prerequisite.

## Preconditions and limitations

The launch configuration must provide the `Email` tag with instance metadata tags enabled,
or a valid configured SSM fallback. This ADR and the warning-only bootstrap do not enforce
that external provisioning. Verify emitted identity and the relevant view on actual instances.
A checked-in template is not evidence that an existing fleet was reprovisioned.

Both injected fields use the same validated source. If that value is missing or rejected,
the script does **not** retain a separate valid `enduser.id`; both injections can be absent.
Coalesce helps only where a usable fallback value exists and the query actually reads it.
Do not promise leaderboard coverage merely because `EndUserId` is a schema column.

Identity is distinct from channel classification, which remains per session. For a shared
Workshop Studio image with participant-selected authentication, use the adaptations in
[Workshop Studio notes](../workshop-studio-notes.md), not the fixed-group overlay unchanged.
See [ADR-001](ADR-001-local-diff-over-shared-incflat-extension.md),
[server guidance](../../dashboard/server/AGENTS.md), and the
[data reference](../reference/data.md) before altering shared identity/grouping behavior.
