import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { COST_COLUMNS, costBackfillSql, costSchemaSql } from "./codexCostSchema.js";

test("backfill names every destination column and binds UTC independently of server timezone", () => {
  const sql = costBackfillSql();
  for (const [type, columns] of Object.entries(COST_COLUMNS))
    assert.ok(sql.includes(`INSERT INTO claude_code.codex_cost_${type}_v1 (${columns.map(([name]) => name).join(", ")})`));
  assert.match(sql, /\{backfillFrom:DateTime\('UTC'\)\}/);
  assert.match(sql, /\{backfillTo:DateTime\('UTC'\)\}/);
});

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
  assert.ok(backfill.includes("Timestamp >= {backfillFrom:DateTime('UTC')} AND Timestamp < {backfillTo:DateTime('UTC')}"));
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
