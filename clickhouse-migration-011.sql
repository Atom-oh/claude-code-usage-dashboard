-- migration: 011 | requires: 004 and otel_traces (002) | records itself: schema_migrations
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
  'Migration 011 requires migration ledger 004');
SELECT throwIf((SELECT count() FROM system.tables WHERE database='claude_code' AND name='otel_traces')=0,
  'Migration 011 requires otel_traces from migration 002');

ALTER TABLE claude_code.otel_traces ON CLUSTER 'replicated'
    ADD COLUMN IF NOT EXISTS WorkflowRunId String MATERIALIZED SpanAttributes['workflow.run_id'],
    ADD COLUMN IF NOT EXISTS WorkflowName  LowCardinality(String) MATERIALIZED SpanAttributes['workflow.name'];

SELECT throwIf(
  (SELECT count() FROM system.columns WHERE database='claude_code' AND table='otel_traces'
    AND (name,type) IN (('WorkflowRunId','String'),('WorkflowName','LowCardinality(String)'))
    AND default_kind='MATERIALIZED') != 2,
  'otel_traces workflow columns differ; repair before recording migration 011');

INSERT INTO claude_code.schema_migrations (version,name,checksum) SELECT 11, '011-trace-workflow-columns', '5e01293f1278f063ceb7e0fd4e4a47b6f399cda33b472abe1b1bacc61535e12c'
WHERE (SELECT count() FROM claude_code.schema_migrations WHERE version=4) > 0
AND (SELECT count() FROM claude_code.schema_migrations WHERE version=11) = 0;
