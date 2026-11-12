-- migration: 010 | requires: 004 and otel_traces (002) | records itself: schema_migrations
-- Promote the Claude Code workflow run id (span attribute `workflow.run_id`, `wf_` prefix)
-- to WorkflowRunId on otel_traces. Additive MATERIALIZED column only; operators run this
-- through one pod (docs/runbooks/schema-migrations.md). Local installations use the
-- equivalent block in clickhouse-schema.sql.
--
-- No MATERIALIZE COLUMN, for the reasons in migration 005: a single map lookup is evaluated
-- on read for older parts, and a mutation would rewrite the table without adding data.
-- `workflow.name` is deliberately not promoted: device collectors drop it from spans.
SELECT throwIf((SELECT count() FROM claude_code.schema_migrations WHERE version=4)=0,
  'Migration 010 requires migration ledger 004');
SELECT throwIf((SELECT count() FROM system.tables WHERE database='claude_code' AND name='otel_traces')=0,
  'Migration 010 requires otel_traces from migration 002');

ALTER TABLE claude_code.otel_traces ON CLUSTER 'replicated'
    ADD COLUMN IF NOT EXISTS WorkflowRunId String MATERIALIZED SpanAttributes['workflow.run_id'];

SELECT throwIf(
  (SELECT count() FROM system.columns WHERE database='claude_code' AND table='otel_traces'
    AND name='WorkflowRunId' AND type='String' AND default_kind='MATERIALIZED') != 1,
  'otel_traces.WorkflowRunId differs; repair before recording migration 010');

INSERT INTO claude_code.schema_migrations (version,name,checksum) SELECT 10, '010-trace-workflow-run-id', '4b13f566a926811e288bf0edeaea3bf2cd0f2002756628e7e4bde8b32479a882'
WHERE (SELECT count() FROM claude_code.schema_migrations WHERE version=4) > 0
AND (SELECT count() FROM claude_code.schema_migrations WHERE version=10) = 0;
