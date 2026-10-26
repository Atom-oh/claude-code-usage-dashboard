import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { costBackfillSql, costSchemaSql } from "./codexCostSchema.js";

test("bootstrap and bounded backfill retain the same insertion transformations", () => {
  const ddl = costSchemaSql(), replicated = costSchemaSql({ replicated: true });
  const backfill = costBackfillSql();
  assert.match(ddl, /AggregateFunction\(groupUniqArray, UInt8\)/);
  assert.match(ddl, /mapSort\(ResourceAttributes\),mapSort\(LogAttributes\)/);
  assert.doesNotMatch(ddl, /Hash|POPULATE/);
  assert.match(replicated, /ReplicatedAggregatingMergeTree/);
  assert.match(replicated, /ON CLUSTER 'replicated'/);
  assert.match(ddl, /INTERVAL 90 DAY DELETE/);
  assert.match(replicated, /INTERVAL 45 DAY TO VOLUME 'cold'/);
  assert.doesNotMatch(ddl + replicated, /180 DAY|ttl_only_drop_parts/);
  assert.match(backfill, /Timestamp >= \{backfillFrom:DateTime\} AND Timestamp < \{backfillTo:DateTime\}/);
  assert.match(backfill, /mapSort\(ResourceAttributes\),mapSort\(LogAttributes\)/);
  assert.match(backfill, /> 86400/);
});

test("migration checksum follows the ledger convention and is shared by both bootstraps", () => {
  const read = name => readFileSync(new URL(`../../${name}`, import.meta.url), "utf8");
  const migration = read("clickhouse-migration-007.sql");
  const checksum = createHash("sha256").update(migration.split("\n")
    .filter(line => !line.includes("INSERT INTO claude_code.schema_migrations")).join("\n")).digest("hex");
  for (const source of [migration, read("clickhouse-schema.sql"), read("infra/files/clickhouse-schema-replicated.sql")])
    assert.ok(source.includes(`SELECT 7, '007-codex-cost-facts', '${checksum}'`));
});
