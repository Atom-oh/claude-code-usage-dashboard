import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setDirectorySnapshot } from "./teamDirectoryParams.js";

// Smallest seam: point the real client at a local HTTP server and inspect the request URL.
async function capture(run) {
  const urls = [];
  const server = createServer((req, res) => { urls.push(req.url); res.end("{\"x\":1}\n"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.CH_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    const database = await import("./clickhouse.js");
    await run(database);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  return urls;
}

test("queryReadonly never injects directory params; query does", async () => {
  setDirectorySnapshot({ issuer: "i", keys: ["k"], teams: ["t"], froms: [0], tos: [1000], labels: {}, historyStart: null }, "v");
  const sql = "SELECT {dirKey:Array(String)} AS k";
  const urls = await capture(async (database) => {
    await database.queryReadonly(sql);
    await database.query(sql);
  });
  assert.equal(urls.length, 2);
  assert.doesNotMatch(urls[0], /param_dir/);
  assert.match(urls[1], /param_dirKey/);
});
