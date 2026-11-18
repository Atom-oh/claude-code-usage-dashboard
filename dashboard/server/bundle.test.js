import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
let root;
let out;
let metafile;

before(async () => {
  const { bundleServer } = await import("./scripts/bundle.mjs");
  root = mkdtempSync(path.join(tmpdir(), "ccdash-bundle-"));
  out = path.join(root, "out");
  const result = await bundleServer({ outdir: out });
  metafile = result.metafile;
  // The Dockerfile copies these next to the bundle; the server reads both at runtime.
  for (const file of ["package.json", "awsPriceSnapshot.json"]) copyFileSync(path.join(here, file), path.join(out, file));
});

after(() => { if (root) rmSync(root, { recursive: true, force: true }); });

const freePort = () => new Promise((resolve, reject) => {
  const srv = createServer();
  srv.once("error", reject);
  srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("bundle emits exactly the three runtime entries and a metafile", () => {
  assert.deepEqual(readdirSync(out).sort(),
    ["awsPriceSnapshot.json", "backupHealth.js", "clickhouse.js", "index.js", "meta.json", "package.json"]);
});

test("the server bundle excludes CLI entry modules", () => {
  const entry = Object.values(metafile.outputs).find((output) => output.entryPoint === "index.js");
  assert.ok(entry, "index.js output present in metafile");
  const inputs = Object.keys(entry.inputs);
  assert.ok(!inputs.includes("backupHealth.js"));
  assert.ok(!inputs.includes("compareCodexCost.js"));
});

test("the server bundle boots, answers /healthz and reads its price snapshot", async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(out, "index.js")], {
    env: { AUTH_ALLOW_INSECURE: "1", CH_URL: "http://127.0.0.1:1", AWS_PRICE_LIST: "off", PORT: String(port), PATH: process.env.PATH },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk) => { log += chunk; });
  child.stderr.on("data", (chunk) => { log += chunk; });
  try {
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 15_000;
    let health = null;
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        const res = await fetch(`${base}/healthz`);
        if (res.status === 200) { health = await res.json(); break; }
      } catch { /* not listening yet */ }
      await sleep(100);
    }
    assert.ok(health, `healthz did not return 200; child output:\n${log}`);
    assert.equal(typeof health.ok, "boolean");
    const config = await (await fetch(`${base}/api/config`)).json();
    const expected = JSON.parse(readFileSync(path.join(out, "awsPriceSnapshot.json"), "utf8")).fetchedAt;
    assert.equal(config.pricing.priceList.source, "snapshot");
    assert.equal(config.pricing.priceList.fetchedAt, expected);
  } finally {
    child.kill("SIGKILL");
  }
});

test("the runbook can import the bundled clickhouse module and its client loads", () => {
  const script = `
    const { query, ping } = await import(${JSON.stringify(pathToFileURL(path.join(out, "clickhouse.js")).href)});
    if (typeof query !== "function") throw new Error("query is not a function");
    let ok = false; let err = null;
    try { await ping(); ok = true; } catch (e) { err = e; }
    console.log(JSON.stringify({ ok, error: err?.message ?? null }));
    process.exit(0);
  `;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { CH_URL: "http://127.0.0.1:1", PATH: process.env.PATH }, encoding: "utf8", timeout: 30_000,
  });
  assert.equal(res.status, 0, res.stderr);
  const { error } = JSON.parse(res.stdout.trim().split("\n").pop());
  assert.ok(!/Dynamic require|ERR_MODULE_NOT_FOUND|Cannot find/.test(error ?? ""), error);
});

test("the backup monitor bundle runs its own main and fails closed without a service account", () => {
  const res = spawnSync(process.execPath, [path.join(out, "backupHealth.js")], {
    env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 15_000,
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /"reason":"MONITOR_FAILED"/);
  const output = res.stdout + res.stderr;
  assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND/);
  assert.doesNotMatch(output, /dashboard listening/);
});
