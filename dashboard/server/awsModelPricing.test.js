import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAwsModelCard, discoverAwsModelCards, createAwsModelPriceUpdater, priceCatalogFits } from "./awsModelPricing.js";
import { priceCodexUsage } from "./codexPricing.js";
import { foldClientMetrics, buildCodexQuery } from "./clientMetrics.js";
import { createPriceDiscovery } from "./pricingDiscovery.js";
import { codexPrices, priceListStatus, publishModelCardPrices, setPriceListLayersForTesting } from "./priceCatalog.js";

const card = `# Example
## Pricing
All prices are in USD per 1 million tokens for the Standard tier.
### Commercial Regions — short context (272K input tokens or fewer)
| **Inference option** | **Input** | **Input — 30-minute cache write** | **Input — cache read** | **Output** |
| --- | --- | --- | --- | --- |
| In-Region | $1.10 | $1.375 | $0.055 | $5.50 |
| Geo CRIS | $1.10 | $1.375 | $0.055 | $5.50 |
| Global CRIS | $1.00 | $1.25 | $0.05 | $5.00 |
### Commercial Regions — long context (more than 272K input tokens)
| **Inference option** | **Input** | **Input — 30-minute cache write** | **Input — cache read** | **Output** |
| --- | --- | --- | --- | --- |
| In-Region | $2.20 | $2.75 | $0.11 | $8.25 |
| Geo CRIS | $2.20 | $2.75 | $0.11 | $8.25 |
| Global CRIS | $2.00 | $2.50 | $0.10 | $7.50 |
## Programmatic Access
| **Endpoint** | **Model ID** | **In-Region endpoint URL** | **Geo inference ID** | **Global inference ID** |
| --- | --- | --- | --- | --- |
| bedrock-mantle | openai.gpt-6.1-terra | https://bedrock-mantle.{region}.api.aws/openai/v1 | Not supported | Not supported |
| bedrock-runtime | openai.gpt-6.1-terra | Not supported | us.openai.gpt-6.1-terra | global.openai.gpt-6.1-terra |
## Service Tiers`;

test("model-card fallback preserves Price List precedence and query snapshots", () => {
  setPriceListLayersForTesting({ snapshot: null });
  const previousOverride = process.env.CODEX_PRICING_JSON;
  try {
    const before = codexPrices(), parsed = parseAwsModelCard(card);
    publishModelCardPrices({ [parsed.model]: parsed.price });
    const withCard = codexPrices();
    assert.equal(before[parsed.model], undefined);
    assert.equal(withCard[parsed.model].short_context_limit, 272000);
    assert.deepEqual(priceListStatus().modelCardModels, [parsed.model]);
    const rates = { input: 9, cacheWrite: 9, cacheRead: 9, output: 9 };
    setPriceListLayersForTesting({ snapshot: null, runtime: { fetchedAt: "2026-10-14T00:00:00Z", claude: {},
      codex: { [parsed.model]: { regional: { short: rates } } } } });
    publishModelCardPrices({ [parsed.model]: parsed.price });
    assert.equal(codexPrices()[parsed.model].regional.short.input, 9);
    assert.equal(withCard[parsed.model].regional.short.input, 1.1);
    process.env.CODEX_PRICING_JSON = JSON.stringify({ [parsed.model]: {
      short_context_limit: 272000, regional: { short: { ...rates, input: 12 }, long: rates },
    } });
    assert.equal(codexPrices()[parsed.model].regional.short.input, 12);
    assert.equal(priceListStatus().modelCardModels, undefined);
    assert.equal(priceCatalogFits(withCard), true);
  } finally {
    if (previousOverride === undefined) delete process.env.CODEX_PRICING_JSON;
    else process.env.CODEX_PRICING_JSON = previousOverride;
    setPriceListLayersForTesting();
  }
});

test("observing an unpriced model discovers and applies its AWS card in the background", async () => {
  const prices = {}, requests = [];
  const fetchText = async name => {
    requests.push(name);
    return name === "model-cards.md" ? "[a](model-card-openai-a.md)" : card;
  };
  const updater = createAwsModelPriceUpdater({ prices, fetchText });
  let revisions = 0;
  const discovery = createPriceDiscovery({ prices, refresh: () => updater.refresh(), onChanged: () => { revisions++; } });
  const usage = { model: "openai.gpt-6.1-terra", backend: "bedrock-mantle", context_tier: "short",
    input_tokens_total: 100, cache_read_tokens: 40, cache_write_tokens: 11, output_tokens: 30, reasoning_tokens: 10 };
  assert.equal(priceCodexUsage(usage, prices).cost_usd, null);
  discovery.observe([usage]);
  assert.equal(priceCodexUsage(usage, prices).cost_usd, null);
  await discovery.idle();
  assert.equal(priceCodexUsage(usage, prices).cost_usd, 0.000236225);
  assert.equal(revisions, 1);
  discovery.observe([usage]);
  assert.deepEqual(requests, ["model-cards.md", "model-card-openai-a.md"]);
});

test("AWS model cards identify the model and per-context commercial rates", () => {
  const parsed = parseAwsModelCard(card);
  assert.equal(parsed.model, "openai.gpt-6.1-terra");
  assert.equal(parsed.price.short_context_limit, 272000);
  const prices = { [parsed.model]: parsed.price };
  const row = { model: parsed.model, backend: "bedrock-mantle", context_tier: "short",
    input_tokens_total: 100, cache_read_tokens: 40, cache_write_tokens: 11, output_tokens: 30, reasoning_tokens: 10 };
  assert.equal(priceCodexUsage(row, prices).cost_usd, 0.000236225);
  assert.equal(priceCodexUsage({ ...row, backend: "bedrock-runtime", model: `global.${parsed.model}`, context_tier: "long" }, prices).cost_usd, 0.0003545);
  assert.equal(priceCodexUsage({ ...row, backend: "bedrock-runtime", model: `eu.${parsed.model}` }, prices).cost_usd, null);
  assert.equal(priceCodexUsage({ ...row, backend: "bedrock-runtime" }, prices).cost_usd, null);
  const summary = foldClientMetrics([{ ...row, client: "codex", kind: "usage", count: 1 }], ["codex"], prices);
  assert.equal(summary.by_model[0].cost_usd, 0.000236225);
  assert.equal(summary.by_model[0].cost_basis, "aws_list_estimate");
  const { params } = buildCodexQuery(new Date("2026-10-26T00:00:00Z"), new Date("2026-10-27T00:00:00Z"), {}, prices);
  const key = Object.keys(params).find(key => key.startsWith("priceModel") && params[key] === parsed.model);
  assert.ok(key);
  assert.equal(params.priceLimit272000, 272000);
});

test("Standard and Ultrafast model cards select only Standard prices", () => {
  const alternate = card
    .replace("All prices are in USD per 1 million tokens for the Standard tier.",
      "All prices are in USD per 1 million tokens. The following tables list Standard and Ultrafast prices. The **Input — 30-minute cache write** column is per million tokens.")
    .replaceAll("Commercial Regions — short context", "Standard — Commercial Regions, short context")
    .replaceAll("Commercial Regions — long context", "Standard — Commercial Regions, long context")
    .replaceAll("Input — 30-minute cache write**", "Input — cache write**")
    .replace("The **Input — cache write** column", "The **Input — 30-minute cache write** column")
    .replaceAll("| In-Region |", "| Regional (bedrock-mantle in US East (N. Virginia)) |")
    .replaceAll("| Geo CRIS |", "| US CRIS (bedrock-runtime) |")
    .replaceAll("| Global CRIS |", "| Global CRIS (bedrock-runtime) |")
    .replace("## Programmatic Access", "### Ultrafast — Commercial Regions, short context (272K input tokens or fewer)\n| In-Region | $99 | $99 | $99 | $99 |\n## Programmatic Access");
  const parsed = parseAwsModelCard(alternate);
  assert.equal(parsed.price.regional.short.input, 1.1);
  assert.equal(parsed.price.global.long.output, 7.5);
  assert.equal(parseAwsModelCard(alternate.replace("### Standard — Commercial Regions, short", "### Ultrafast — Commercial Regions, short")), null);
  assert.equal(parseAwsModelCard(alternate.replaceAll("Standard — Commercial Regions,", "Commercial Regions —")), null);
  assert.equal(parseAwsModelCard(alternate.replace("us.openai.gpt-6.1-terra", "eu.openai.gpt-6.1-terra")), null);
});

test("automatic prices do not override the Anthropic pricing and cache TTL contract", async () => {
  const prices = {};
  const fetchText = async name => name === "model-cards.md" ? "[a](model-card-anthropic-a.md)"
    : card.replaceAll("openai.gpt-6.1-terra", "anthropic.claude-example");
  await createAwsModelPriceUpdater({ prices, fetchText }).refresh();
  assert.deepEqual(prices, {});
});

test("ambiguous units, tiers, routing or identity never become prices", () => {
  for (const malformed of [
    card.replace("USD per 1 million tokens", "USD per 1 thousand tokens"),
    card.replace("more than 272K", "more than 128K"),
    card.replace("Geo CRIS | $1.10", "Geo CRIS | $1.20"),
    card.replace("| bedrock-runtime | openai.gpt-6.1-terra", "| bedrock-runtime | openai.other"),
    card.replace("global.openai.gpt-6.1-terra", "Not supported"),
    card.replace("us.openai.gpt-6.1-terra", "us.openai.other"),
    card.replace("https://bedrock-mantle.{region}.api.aws/openai/v1", "Not supported"),
    card.replace("30-minute cache write", "5-minute cache write"),
    card.replace("$0.055", "unknown"),
  ]) assert.equal(parseAwsModelCard(malformed), null);
});

test("discovery accepts only bounded relative AWS model-card names", () => {
  assert.deepEqual(discoverAwsModelCards("[a](model-card-openai-a.md) [b](https://evil.invalid/x.md) [x](../model-card-escape.md) [a](model-card-openai-a.md)"), ["model-card-openai-a.md"]);
});

test("refresh publishes verified prices and preserves operator overrides on source failure", async () => {
  const prices = { "openai.override": { sentinel: true } };
  const index = "[a](model-card-openai-a.md) [b](model-card-openai-b.md)";
  const requests = [];
  const fetchText = async name => {
    requests.push(name);
    if (name === "model-cards.md") return index;
    if (name === "model-card-openai-b.md") throw new Error("unavailable");
    return card;
  };
  const updater = createAwsModelPriceUpdater({ prices, overrides: new Set(["openai.override"]), fetchText });
  const [result] = await Promise.all([updater.refresh(), updater.refresh()]);
  assert.deepEqual(result, { changed: 1, parsed: 1, failed: 1, total: 2, excluded: 0, conflicts: 0 });
  assert.equal(requests.filter(name => name === "model-cards.md").length, 1);
  assert.equal(prices["openai.gpt-6.1-terra"].short_context_limit, 272000);
  assert.deepEqual(prices["openai.override"], { sentinel: true });
});

test("an empty index or a wholly unparseable catalog reports a refresh failure", async () => {
  for (const fetchText of [async () => "no cards", async name => name === "model-cards.md"
    ? "[a](model-card-openai-a.md)" : "unexpected format"]) {
    await assert.rejects(createAwsModelPriceUpdater({ prices: {}, fetchText }).refresh());
  }
});

test("catalog growth respects the query parameter budget", async () => {
  const prices = {};
  const fetchText = async name => name === "model-cards.md"
    ? "[a](model-card-openai-a.md) [b](model-card-openai-b.md)"
    : name.endsWith("-b.md") ? card.replaceAll("openai.gpt-6.1-terra", "openai.gpt-example") : card;
  const result = await createAwsModelPriceUpdater({ prices, fetchText,
    acceptPrices: next => Object.keys(next).length <= 1 }).refresh();
  assert.equal(result.changed, 1);
  assert.equal(result.excluded, 1);
  assert.deepEqual(Object.keys(prices), ["openai.gpt-6.1-terra"]);
});

test("a changed price rejected by the query budget does not leave a known stale price", async () => {
  const prices = { "openai.gpt-6.1-terra": { old: true } };
  const fetchText = async name => name === "model-cards.md" ? "[a](model-card-openai-a.md)" : card;
  const result = await createAwsModelPriceUpdater({ prices, fetchText, acceptPrices: () => false }).refresh();
  assert.equal(result.excluded, 1);
  assert.equal(prices["openai.gpt-6.1-terra"], undefined);
});

test("a failed refresh never publishes a partial catalog", async () => {
  const prices = { existing: { keep: true } };
  let checks = 0;
  const fetchText = async name => name === "model-cards.md" ? "[a](model-card-openai-a.md) [b](model-card-openai-b.md)"
    : name.endsWith("-b.md") ? card.replaceAll("openai.gpt-6.1-terra", "openai.gpt-example") : card;
  await assert.rejects(createAwsModelPriceUpdater({ prices, fetchText, acceptPrices: () => {
    if (++checks === 2) throw new Error("budget check failed");
    return true;
  } }).refresh());
  assert.deepEqual(prices, { existing: { keep: true } });
});

test("conflicting model cards do not leave a known price in the live catalog", async () => {
  const prices = { "openai.gpt-6.1-terra": { old: true } };
  const fetchText = async name => name === "model-cards.md"
    ? "[a](model-card-openai-a.md) [b](model-card-openai-b.md)"
    : name.endsWith("-b.md") ? card.replaceAll("$1.10", "$3.00") : card;
  await createAwsModelPriceUpdater({ prices, fetchText }).refresh();
  assert.equal(prices["openai.gpt-6.1-terra"], undefined);
});

test("duplicate cards preserve index order regardless of fetch completion order", async () => {
  const prices = {};
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const fetchText = async name => {
    if (name === "model-cards.md") return "[a](model-card-openai-a.md) [b](model-card-openai-b.md) [c](model-card-openai-c.md)";
    if (name.endsWith("-a.md")) { await held; return card; }
    if (name.endsWith("-b.md")) return card.replaceAll("openai.gpt-6.1-terra", "openai.gpt-example");
    release(); return card;
  };
  await createAwsModelPriceUpdater({ prices, fetchText, acceptPrices: next => Object.keys(next).length <= 1 }).refresh();
  assert.deepEqual(Object.keys(prices), ["openai.gpt-6.1-terra"]);
});
