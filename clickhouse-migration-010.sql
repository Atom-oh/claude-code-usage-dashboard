-- migration: 010 | requires: 004 and otel_traces (002) | records itself: schema_migrations
-- Promote the Claude Code workflow run id (span attribute `workflow.run_id`, `wf_` prefix)
-- and name (`workflow.name`) to WorkflowRunId/WorkflowName on otel_traces. Additive
-- MATERIALIZED columns only; operators run this through one pod
-- (docs/runbooks/schema-migrations.md). Local installations use the equivalent block in
-- clickhouse-schema.sql.
--
-- No MATERIALIZE COLUMN, for the reasons in migration 005: a single map lookup is evaluated
-- on read for older parts, and a mutation would rewrite the table without adding data.
-- Device collectors keep `workflow.name` only when it is a short label (no spaces, slashes or
-- quotes); the central collector does not rewrite span attributes.
SELECT throwIf((SELECT count() FROM claude_code.schema_migrations WHERE version=4)=0,
  'Migration 010 requires migration ledger 004');
SELECT throwIf((SELECT count() FROM system.tables WHERE database='claude_code' AND name='otel_traces')=0,
  'Migration 010 requires otel_traces from migration 002');

ALTER TABLE claude_code.otel_traces ON CLUSTER 'replicated'
    ADD COLUMN IF NOT EXISTS WorkflowRunId String MATERIALIZED SpanAttributes['workflow.run_id'],
    ADD COLUMN IF NOT EXISTS WorkflowName  LowCardinality(String) MATERIALIZED SpanAttributes['workflow.name'];

SELECT throwIf(
  (SELECT count() FROM system.columns WHERE database='claude_code' AND table='otel_traces'
    AND (name,type) IN (('WorkflowRunId','String'),('WorkflowName','LowCardinality(String)'))
    AND default_kind='MATERIALIZED') != 2,
  'otel_traces workflow columns differ; repair before recording migration 010');

INSERT INTO claude_code.schema_migrations (version,name,checksum) SELECT 10, '010-trace-workflow-columns', 'e904a50eaa6bc691c55cb9fe4a16ce9eb8ec0f8f3a6ac8a4eb1b5aaaba071d4d'
WHERE (SELECT count() FROM claude_code.schema_migrations WHERE version=4) > 0
AND (SELECT count() FROM claude_code.schema_migrations WHERE version=10) = 0;
