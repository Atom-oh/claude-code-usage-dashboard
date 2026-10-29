import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { claudePricing, codexPrices, priceListStatus, priceListConfig, refreshPriceList,
  startPriceListRefresh, stopPriceListRefresh, setPriceListLayersForTesting } from "./priceCatalog.js";
import { buildPricing, computeCost } from "./pricing.js";
import { DEFAULT_CODEX_PRICING, priceCodexUsage } from "./codexPricing.js";

// Network-free: every refresh here injects its fetch. Each test restores the committed snapshot.
const committed = JSON.parse(readFileSync(new URL("./awsPriceSnapshot.json", import.meta.url), "utf8"));
const fixture = (name) => JSON.parse(readFileSync(new URL(`./test/fixtures/${name}`, import.meta.url), "utf8")).PriceList;
const products = () => ({ AmazonBedrockFoundationModels: fixture("aws-price-list-AmazonBedrockFoundationModels.json"),
  AmazonBedrock: fixture("aws-price-list-AmazonBedrock.json") });
const claudeRates = (input) => ({ input, output: input * 5, cacheWrite: input * 1.25, cacheWrite1h: input * 2, cacheRead: input / 10 });
const codexRates = (input) => ({ input, cacheWrite: input * 1.25, cacheRead: input / 10, output: input * 5 });
const layer = (fetchedAt, claude = {}, codex = {}) => ({ fetchedAt, claude, codex });
const restore = (t) => t.after(() => { setPriceListLayersForTesting(); stopPriceListRefresh(); });
const quiet = (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const log = t.mock.method(console, "log", () => {});
  return { warn, log, warnings: () => warn.mock.calls.map((call) => call.arguments.join(" ")) };
};

test("the committed snapshot is the default layer and /api/config metadata carries no rates", () => {
  assert.equal(committed.region, "us-east-1");
  assert.deepEqual(committed.serviceCodes, ["AmazonBedrockFoundationModels", "AmazonBedrock"]);
  const status = priceListStatus();
  assert.equal(status.source, "snapshot");
  assert.equal(status.fetchedAt, committed.fetchedAt);
  assert.deepEqual(status.models, [...Object.keys(committed.claude), ...Object.keys(committed.codex)].sort());
  assert.deepEqual(Object.keys(status), ["source", "fetchedAt", "models"]);
  assert.ok(status.models.includes("claude-fable-5-1") && status.models.includes("moonshotai.kimi-k3"));
  // On the 2026-10-28 data every model the code tables price keeps the same Claude rates.
  const code = buildPricing({}).table;
  for (const [model, rates] of Object.entries(committed.claude))
    if (code[model]) assert.deepEqual(claudePricing().table[model], rates, model);
});

test("precedence per model: operator env > runtime refresh > snapshot > code table", (t) => {
  restore(t);
  const model = "claude-sonnet-5";
  const code = buildPricing({}).table[model];
  setPriceListLayersForTesting({ snapshot: null });
  assert.deepEqual(claudePricing().table[model], code);
  assert.equal(priceListStatus().source, "code");
  assert.deepEqual(priceListStatus().models, []);
  setPriceListLayersForTesting({ snapshot: layer("2026-10-01T00:00:00Z", { [model]: claudeRates(3) }) });
  assert.deepEqual(claudePricing().table[model], claudeRates(3));
  setPriceListLayersForTesting({ snapshot: layer("2026-10-01T00:00:00Z", { [model]: claudeRates(3) }),
    runtime: layer("2026-10-28T00:00:00Z", { [model]: claudeRates(4) }) });
  assert.deepEqual(claudePricing().table[model], claudeRates(4));
  assert.deepEqual(priceListStatus(), { source: "runtime", fetchedAt: "2026-10-28T00:00:00Z", models: [model] });
  assert.equal(computeCost(model, "", { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }), 4);
  process.env.PRICING_JSON = JSON.stringify({ [model]: { input: 1, output: 2 } });
  try {
    assert.equal(claudePricing().table[model].input, 1);
  } finally {
    delete process.env.PRICING_JSON;
  }
  assert.equal(claudePricing().table[model].input, 4);
});

test("Codex precedence: CODEX_PRICING_JSON > runtime > snapshot > code, per model and scope", (t) => {
  restore(t);
  const model = "moonshotai.kimi-k3";
  const code = DEFAULT_CODEX_PRICING[model];
  setPriceListLayersForTesting({ snapshot: layer("2026-10-01T00:00:00Z", {}, { [model]: { global: { short: codexRates(2) } } }),
    runtime: null });
  assert.deepEqual(codexPrices()[model].global, { short: codexRates(2), long: codexRates(2) });
  assert.equal(codexPrices()[model].regional, code.regional, "a scope the layer lacks keeps the code rates");
  setPriceListLayersForTesting({ snapshot: layer("2026-10-01T00:00:00Z", {}, { [model]: { global: { short: codexRates(2) } } }),
    runtime: layer("2026-10-28T00:00:00Z", {}, { [model]: { global: { short: codexRates(5) } } }) });
  assert.deepEqual(codexPrices()[model].global.short, codexRates(5));
  const own = { short_context_limit: 10, regional: { short: codexRates(9), long: codexRates(9) } };
  process.env.CODEX_PRICING_JSON = JSON.stringify({ [model]: own });
  try {
    assert.deepEqual(codexPrices()[model], own);
  } finally {
    delete process.env.CODEX_PRICING_JSON;
  }
  assert.deepEqual(codexPrices()[model].global.short, codexRates(5));
});

test("an incomplete Price List entry never shadows the code rate", async (t) => {
  restore(t);
  quiet(t);
  setPriceListLayersForTesting({ snapshot: null });
  // Real fixture with Fable's input repriced and its 1h cache-write row removed: incomplete, skipped.
  const edited = products();
  edited.AmazonBedrockFoundationModels = edited.AmazonBedrockFoundationModels
    .filter((entry) => JSON.parse(entry).product.attributes.usagetype !== "USE1-MP:USE1_cache_write_tokens_1h_global_standard-Units")
    .map((entry) => {
      const parsed = JSON.parse(entry);
      if (parsed.product.attributes.usagetype === "USE1-MP:USE1_input_tokens_global_standard-Units") {
        const term = Object.values(parsed.terms.OnDemand)[0];
        Object.values(term.priceDimensions)[0].pricePerUnit.USD = "99.0000000000";
      }
      return JSON.stringify(parsed);
    });
  assert.equal(await refreshPriceList({ fetch: async () => edited }), true);
  assert.equal(priceListStatus().source, "runtime");
  assert.ok(!priceListStatus().models.includes("claude-fable-5-1"));
  assert.equal(claudePricing().table["claude-fable-5-1"].input, 10);
});

test("a failed or empty refresh keeps the last good layer", async (t) => {
  restore(t);
  const { warnings } = quiet(t);
  setPriceListLayersForTesting();
  assert.equal(await refreshPriceList({ fetch: async () => { throw new Error("offline"); } }), false);
  assert.equal(priceListStatus().source, "snapshot");
  assert.equal(await refreshPriceList({ fetch: async () => products(), now: () => new Date("2026-10-28T05:06:07.890Z") }), true);
  assert.deepEqual(priceListStatus(), { source: "runtime", fetchedAt: "2026-10-28T05:06:07Z",
    models: ["claude-fable-5-1", "moonshotai.kimi-k3", "openai.gpt-6-astra", "zai.glm-4.7"] });
  assert.equal(await refreshPriceList({ fetch: async () => ({ AmazonBedrock: [], AmazonBedrockFoundationModels: [] }) }), false);
  const secret = new Error("User: arn:aws:sts::123456789012:assumed-role/x is not authorized");
  secret.name = "AccessDeniedException";
  secret.$metadata = { httpStatusCode: 400 };
  assert.equal(await refreshPriceList({ fetch: async () => { throw secret; } }), false);
  assert.equal(priceListStatus().fetchedAt, "2026-10-28T05:06:07Z");
  const failures = warnings().filter((line) => line.includes("refresh failed"));
  assert.equal(failures.length, 3);
  assert.match(failures[0], /keeping snapshot rates: Error$/);
  assert.match(failures[2], /keeping runtime rates: AccessDeniedException 400$/);
  assert.ok(!failures.some((line) => line.includes("123456789012")), "provider messages are not logged");
});

test("concurrent refreshes share one fetch", async (t) => {
  restore(t);
  quiet(t);
  let calls = 0;
  const fetch = async () => { calls += 1; return products(); };
  const [a, b] = await Promise.all([refreshPriceList({ fetch }), refreshPriceList({ fetch })]);
  assert.deepEqual([a, b, calls], [true, true, 1]);
});

test("refreshed Codex rates price rows and label them aws_price_list", async (t) => {
  restore(t);
  quiet(t);
  setPriceListLayersForTesting({ snapshot: null });
  const usage = { backend: "bedrock-mantle", model: "moonshotai.kimi-k3", context_tier: "short",
    input_tokens_total: 1000, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 100, reasoning_tokens: 0 };
  assert.equal(priceCodexUsage(usage, codexPrices()).price_source, undefined);
  await refreshPriceList({ fetch: async () => products() });
  const row = priceCodexUsage(usage, codexPrices());
  assert.equal(row.price_source, "aws_price_list");
  assert.equal(row.cost_usd, 0.00495);
});

test("rates more than 2x away from the code table are applied and logged", async (t) => {
  restore(t);
  const { warnings } = quiet(t);
  const runtime = products();
  runtime.AmazonBedrock = runtime.AmazonBedrock.map((entry) => {
    const parsed = JSON.parse(entry);
    if (parsed.product.attributes.usagetype === "USE1-zai.glm-4.7-output-tokens"
        || parsed.product.attributes.usagetype === "USE1-zai.glm-4.7-mantle-output-tokens-standard")
      Object.values(Object.values(parsed.terms.OnDemand)[0].priceDimensions)[0].pricePerUnit.USD = "0.0100000000";
    return JSON.stringify(parsed);
  });
  assert.equal(await refreshPriceList({ fetch: async () => runtime }), true);
  assert.equal(codexPrices()["zai.glm-4.7"].regional.short.output, 10);
  assert.ok(warnings().some((line) => line.includes("zai.glm-4.7 regional/short output: AWS 10 vs code table 2.2")));
});

test("price list settings: AWS_PRICE_LIST on/off and a bounded refresh interval", () => {
  assert.deepEqual(priceListConfig({}), { enabled: true, refreshHours: 12 });
  assert.deepEqual(priceListConfig({ AWS_PRICE_LIST: "off" }), { enabled: false, refreshHours: 12 });
  assert.deepEqual(priceListConfig({ AWS_PRICE_LIST: "on", AWS_PRICE_REFRESH_HOURS: "6" }), { enabled: true, refreshHours: 6 });
  for (const env of [{ AWS_PRICE_LIST: "false" }, { AWS_PRICE_REFRESH_HOURS: "0" },
    { AWS_PRICE_REFRESH_HOURS: "169" }, { AWS_PRICE_REFRESH_HOURS: "soon" }])
    assert.throws(() => priceListConfig(env), /AWS_PRICE_/, JSON.stringify(env));
  assert.equal(process.env.AWS_PRICE_LIST, "off", "npm test runs with AWS_PRICE_LIST=off");
});

test("startup never waits for or fetches the Price List when disabled", async (t) => {
  restore(t);
  quiet(t);
  let calls = 0;
  const fetch = async () => { calls += 1; return products(); };
  assert.equal(startPriceListRefresh({ enabled: false, refreshHours: 12 }, { fetch }), null);
  assert.equal(calls, 0);
  const timer = startPriceListRefresh({ enabled: true, refreshHours: 12 }, { fetch });
  assert.equal(typeof timer.unref, "function");
  assert.equal(timer.hasRef(), false, "the interval never keeps the process alive");
  assert.equal(calls, 1, "the first refresh starts immediately in the background");
  await refreshPriceList({ fetch });
  assert.equal(priceListStatus().source, "runtime");
});

test("invalid layers are rejected whole", () => {
  for (const bad of [
    { claude: {}, codex: {} },
    layer("not a date"),
    layer("2026-10-28T00:00:00Z", { "claude-x": { input: 1 } }),
    layer("2026-10-28T00:00:00Z", { "Claude X": claudeRates(1) }),
    layer("2026-10-28T00:00:00Z", {}, { "openai.x": { regional: { short: { input: -1, cacheWrite: 0, cacheRead: 0, output: 0 } } } }),
    layer("2026-10-28T00:00:00Z", {}, { "openai.x": {} }),
  ]) assert.throws(() => setPriceListLayersForTesting({ runtime: bad }), /invalid price list layer/);
});

test("invalid price settings still fail the server import", () => {
  for (const [env, message] of [[{ CODEX_PRICING_JSON: "{" }, /CODEX_PRICING_JSON must be a JSON object/],
    [{ AWS_PRICE_LIST: "maybe" }, /AWS_PRICE_LIST must be "on" or "off"/],
    [{ PRICING_JSON: "{" }, /PRICING_JSON is not valid JSON/]]) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", 'await import("./index.js")'], {
      cwd: fileURLToPath(new URL(".", import.meta.url)), encoding: "utf8", timeout: 20000,
      env: { ...process.env, AUTH_ALLOW_INSECURE: "1", CH_URL: "http://127.0.0.1:1", ...env } });
    assert.notEqual(result.status, 0, JSON.stringify(env));
    assert.match(result.stderr, message);
  }
});
