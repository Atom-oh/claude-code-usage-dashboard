import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePriceList } from "./awsPriceList.js";

const script = fileURLToPath(new URL("./scripts/prices-snapshot.js", import.meta.url));
const fmPath = fileURLToPath(new URL("./test/fixtures/aws-price-list-AmazonBedrockFoundationModels.json", import.meta.url));
const abPath = fileURLToPath(new URL("./test/fixtures/aws-price-list-AmazonBedrock.json", import.meta.url));
const products = {
  AmazonBedrockFoundationModels: JSON.parse(readFileSync(fmPath, "utf8")).PriceList,
  AmazonBedrock: JSON.parse(readFileSync(abPath, "utf8")).PriceList,
};

const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "price-snapshot-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("writes a snapshot from saved files and keeps it when rates are unchanged", (t) => {
  const out = join(tempDir(t), "s.json");
  const first = run("--from-files", fmPath, abPath, "--fetched-at", "2026-10-28T03:19:00.123Z", "--out", out);
  assert.equal(first.status, 0, first.stderr);
  const { claude, codex, skipped } = parsePriceList(products);
  const expected = JSON.stringify({
    fetchedAt: "2026-10-28T03:19:00Z",
    region: "us-east-1",
    serviceCodes: ["AmazonBedrockFoundationModels", "AmazonBedrock"],
    claude,
    codex,
    skipped,
  }, null, 2) + "\n";
  assert.equal(readFileSync(out, "utf8"), expected);

  const second = run("--from-files", fmPath, abPath, "--fetched-at", "2026-10-29T00:00:00Z", "--out", out);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /unchanged/);
  assert.equal(readFileSync(out, "utf8"), expected);
});

test("a file without a PriceList array fails and keeps the existing snapshot", (t) => {
  const dir = tempDir(t);
  const bad = join(dir, "bad.json");
  const out = join(dir, "s.json");
  writeFileSync(bad, JSON.stringify({ FormatVersion: "aws_v1" }));
  writeFileSync(out, "previous\n");
  const result = run("--from-files", bad, abPath, "--out", out);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /prices:snapshot failed/);
  assert.equal(readFileSync(out, "utf8"), "previous\n");
});

test("unknown arguments print usage", () => {
  const result = run("--bogus");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: node scripts\/prices-snapshot\.js/);
});
