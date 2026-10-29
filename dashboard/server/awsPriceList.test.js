import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PRICE_LIST_REGION,
  PRICE_LIST_SERVICE_CODES,
  parsePriceList,
  fetchPriceList,
} from "./awsPriceList.js";
import { buildPricing } from "./pricing.js";
import { DEFAULT_CODEX_PRICING } from "./codexPricing.js";

const EXPECTED = {
  claude: {
    "claude-fable-5-1": { input: 10, output: 50, cacheWrite: 12.5, cacheWrite1h: 20, cacheRead: 0.25 },
  },
  codex: {
    "moonshotai.kimi-k3": {
      regional: { short: { input: 3.3, cacheWrite: 4.125, cacheRead: 0.33, output: 16.5 } },
      global: { short: { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 } },
    },
    "openai.gpt-6-astra": {
      regional: {
        short: { input: 11, cacheWrite: 13.75, cacheRead: 1.1, output: 55 },
        long: { input: 22, cacheWrite: 27.5, cacheRead: 2.2, output: 82.5 },
      },
      global: {
        short: { input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50 },
        long: { input: 20, cacheWrite: 25, cacheRead: 2, output: 75 },
      },
    },
    "zai.glm-4.7": {
      regional: { short: { input: 0.6, cacheWrite: 0.6, cacheRead: 0.6, output: 2.2 } },
    },
  },
  skipped: [],
};

const load = (name) =>
  JSON.parse(readFileSync(new URL(`./test/fixtures/${name}`, import.meta.url), "utf8")).PriceList;
const fm = load("aws-price-list-AmazonBedrockFoundationModels.json");
const ab = load("aws-price-list-AmazonBedrock.json");
const parse = (a = fm, b = ab) => parsePriceList({ AmazonBedrockFoundationModels: a, AmazonBedrock: b });
const attrs = (s) => JSON.parse(s).product.attributes;
const usage = (s) => attrs(s).usagetype;
const edit = (s, fn) => {
  const p = JSON.parse(s);
  fn(p);
  return JSON.stringify(p);
};
const dimension = (p) => Object.values(Object.values(p.terms.OnDemand)[0].priceDimensions)[0];
const isFable = (s) => attrs(s).model === "Claude Fable 5.1";
const isAstra = (s) => attrs(s).model === "OpenAI GPT-6 Astra";
const find = (list, usagetype) => {
  const entry = list.find((s) => usage(s) === usagetype);
  assert.ok(entry, `fixture entry ${usagetype} exists`);
  return entry;
};

test("fixtures parse to the expected Claude and Codex rate tables", () => {
  assert.deepEqual(parse(), EXPECTED);
});

test("per-1K prices are converted by decimal shift without float error", () => {
  const { codex } = parse();
  assert.equal(codex["moonshotai.kimi-k3"].regional.short.input, 3.3);
  assert.equal(codex["zai.glm-4.7"].regional.short.input, 0.6);
});

test("parsed rates match the hand-maintained code tables", () => {
  const { claude, codex } = parse();
  const fable = buildPricing({}).table["claude-fable-5-1"];
  const { input, output, cacheWrite, cacheWrite1h, cacheRead } = fable;
  assert.deepEqual(claude["claude-fable-5-1"], { input, output, cacheWrite, cacheWrite1h, cacheRead });

  const astra = codex["openai.gpt-6-astra"];
  const astraCode = DEFAULT_CODEX_PRICING["openai.gpt-6-astra"];
  for (const scope of ["regional", "global"]) {
    for (const tier of ["short", "long"]) {
      assert.deepEqual(astra[scope][tier], astraCode[scope][tier], `astra ${scope}/${tier}`);
    }
  }

  for (const key of ["moonshotai.kimi-k3", "zai.glm-4.7"]) {
    for (const scope of Object.keys(codex[key])) {
      assert.deepEqual(codex[key][scope].short, DEFAULT_CODEX_PRICING[key][scope].short, `${key} ${scope}`);
    }
  }
});

test("flex, priority and batch tier rows are ignored", () => {
  const tiers = new Set([
    "USE1-moonshotai.kimi-k3-mantle-input-tokens-flex",
    "USE1-moonshotai.kimi-k3-mantle-output-tokens-global-priority",
    "USE1-moonshotai.kimi-k3-mantle-input-tokens-batch",
  ]);
  const filtered = ab.filter((s) => !tiers.has(usage(s)));
  assert.equal(filtered.length, ab.length - 3);
  assert.deepEqual(parse(fm, filtered), EXPECTED);
});

test("entries outside us-east-1 are ignored", () => {
  const moved = fm.map((s) => (isFable(s) ? edit(s, (p) => { p.product.attributes.regionCode = "eu-west-1"; }) : s));
  const result = parse(moved);
  assert.deepEqual(result.claude, {});
  assert.deepEqual(result.skipped, []);
});

test("a Claude model missing a global rate slot is skipped as incomplete", () => {
  const removed = fm.filter(
    (s) => !(isFable(s) && usage(s) === "USE1-MP:USE1_cache_write_tokens_1h_global_standard-Units"),
  );
  assert.equal(removed.length, fm.length - 1);
  const result = parse(removed);
  assert.deepEqual(result.claude, {});
  assert.deepEqual(result.skipped, [{ table: "claude", model: "claude-fable-5-1", reason: "incomplete" }]);
});

test("a Claude model without global rows is skipped as no_global_rates", () => {
  const regionalOnly = fm.filter((s) => !(isFable(s) && usage(s).includes("_global_")));
  const result = parse(regionalOnly);
  assert.deepEqual(result.claude, {});
  assert.deepEqual(result.skipped, [{ table: "claude", model: "claude-fable-5-1", reason: "no_global_rates" }]);
});

test("conflicting duplicate rates drop the scope while identical duplicates are harmless", () => {
  const original = find(ab, "USE1-moonshotai.kimi-k3-mantle-input-tokens-standard");
  const conflicting = edit(original, (p) => { dimension(p).pricePerUnit.USD = "0.0040000000"; });
  const result = parse(fm, [...ab, conflicting]);
  assert.deepEqual(result.codex["moonshotai.kimi-k3"], { global: EXPECTED.codex["moonshotai.kimi-k3"].global });
  assert.deepEqual(result.skipped, [
    { table: "codex", model: "moonshotai.kimi-k3", scope: "regional", reason: "conflicting_rates" },
  ]);

  assert.deepEqual(parse(fm, [...ab, original]), EXPECTED);
});

test("an unsupported price unit marks the rate invalid", () => {
  const changed = ab.map((s) =>
    usage(s) === "USE1-zai.glm-4.7-input-tokens" ? edit(s, (p) => { dimension(p).unit = "1M TPM Hour"; }) : s,
  );
  const result = parse(fm, changed);
  assert.equal("zai.glm-4.7" in result.codex, false);
  assert.deepEqual(result.skipped, [
    { table: "codex", model: "zai.glm-4.7", scope: "regional", reason: "invalid_rate" },
  ]);
});

test("an incomplete long-context tier drops the whole scope", () => {
  const removed = fm.filter(
    (s) => !(isAstra(s) && usage(s) === "USE1-MP:USE1_output_tokens_long_ctx_standard-Units"),
  );
  assert.equal(removed.length, fm.length - 1);
  const result = parse(removed);
  assert.deepEqual(result.codex["openai.gpt-6-astra"], { global: EXPECTED.codex["openai.gpt-6-astra"].global });
  assert.deepEqual(result.skipped, [
    { table: "codex", model: "openai.gpt-6-astra", scope: "regional", reason: "incomplete" },
  ]);
});

test("an OpenAI model name that is not a valid id is skipped as unrecognized_model", () => {
  const renamed = fm.map((s) =>
    isAstra(s) ? edit(s, (p) => { p.product.attributes.model = "OpenAI GPT-6 Astra (Preview)"; }) : s,
  );
  const result = parse(renamed);
  assert.equal("openai.gpt-6-astra" in result.codex, false);
  assert.deepEqual(result.skipped, [
    { table: "codex", model: "openai.gpt-6-astra-(preview)", reason: "unrecognized_model" },
  ]);
});

test("display-style AmazonBedrock usage ids are ignored", () => {
  const extra = edit(find(ab, "USE1-zai.glm-4.7-input-tokens"), (p) => {
    p.product.attributes.usagetype = "USE1-Kimi-K2-Thinking-input-tokens";
  });
  assert.deepEqual(parse(fm, [...ab, extra]), EXPECTED);
});

test("String objects and parsed objects are accepted; bad JSON and unknown service codes are ignored", () => {
  assert.deepEqual(parse(fm.map((s) => new String(s)), ab.map((s) => new String(s))), EXPECTED);
  assert.deepEqual(parse(fm.map((s) => JSON.parse(s)), ab.map((s) => JSON.parse(s))), EXPECTED);
  assert.deepEqual(
    parsePriceList({
      AmazonBedrockFoundationModels: [...fm, "{not json"],
      AmazonBedrock: ab,
      AmazonEC2: ["{not json", ...ab],
    }),
    EXPECTED,
  );
});

test("fetchPriceList pages each service code and forwards the abort signal", async () => {
  const calls = [];
  const client = {
    send: async (command, options) => {
      calls.push({ input: command.input, options });
      if (command.input.ServiceCode === "AmazonBedrockFoundationModels") {
        return command.input.NextToken === undefined
          ? { PriceList: [new String("a")], NextToken: "t1" }
          : { PriceList: [new String("b")] };
      }
      return { PriceList: ["c"] };
    },
  };
  const signal = new AbortController().signal;
  const result = await fetchPriceList({ client, signal });
  assert.deepEqual(result, { AmazonBedrockFoundationModels: ["a", "b"], AmazonBedrock: ["c"] });
  for (const list of Object.values(result)) {
    for (const item of list) assert.equal(typeof item, "string");
  }

  const filters = [{ Type: "TERM_MATCH", Field: "regionCode", Value: PRICE_LIST_REGION }];
  const expectedInput = (ServiceCode, NextToken) => ({
    ServiceCode,
    FormatVersion: "aws_v1",
    Filters: filters,
    MaxResults: 100,
    NextToken,
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => c.input.ServiceCode), [
    PRICE_LIST_SERVICE_CODES[0],
    PRICE_LIST_SERVICE_CODES[0],
    PRICE_LIST_SERVICE_CODES[1],
  ]);
  assert.deepEqual(calls[0].input, expectedInput("AmazonBedrockFoundationModels", undefined));
  assert.deepEqual(calls[1].input, expectedInput("AmazonBedrockFoundationModels", "t1"));
  assert.deepEqual(calls[2].input, expectedInput("AmazonBedrock", undefined));
  for (const call of calls) assert.equal(call.options.abortSignal, signal);
});

test("fetchPriceList stops after maxPages pages", async () => {
  let sends = 0;
  const client = {
    send: async () => {
      sends += 1;
      return { PriceList: [], NextToken: "again" };
    },
  };
  await assert.rejects(fetchPriceList({ client, maxPages: 2 }), /AmazonBedrockFoundationModels exceeded 2 pages/);
  assert.equal(sends, 2);
});
