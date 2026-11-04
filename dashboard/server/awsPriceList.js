// AWS Price List (Bedrock) parser and fetcher. Imports no repository module: pricing modules depend
// on this file, so an import back would create a cycle.
import { PricingClient, GetProductsCommand } from "@aws-sdk/client-pricing";

export const PRICE_LIST_REGION = "us-east-1";
export const PRICE_LIST_SERVICE_CODES = Object.freeze(["AmazonBedrockFoundationModels", "AmazonBedrock"]);

const FM_USAGE = /^USE1-MP:USE1_(.+)-Units$/;
const FM_SNAKE = /^(input|output|cache_read|cache_write)_tokens(?:_(5m|30m|1h))?(_long_ctx)?(_global)?_standard$/;
const FM_CAMEL = /^(InputTokenCount|OutputTokenCount|CacheReadInputTokenCount|CacheWriteInputTokenCount|CacheWrite1hInputTokenCount)(_Global)?$/;
const AB_USAGE = /^USE1-([a-z0-9][a-z0-9._-]*?)(-mantle)?-(input|output|cache-read|cache-write)-tokens(?:-(5m|30m|1h))?(?:-(standard|global-standard))?$/;
const VENDOR_KEY = /^[a-z][a-z0-9-]*[a-z]\.[a-z0-9][a-z0-9._-]*$/;
const CLAUDE_KEY = /^claude-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

const CAMEL_BUCKETS = {
  InputTokenCount: ["input"],
  OutputTokenCount: ["output"],
  CacheReadInputTokenCount: ["cache_read"],
  CacheWriteInputTokenCount: ["cache_write"],
  CacheWrite1hInputTokenCount: ["cache_write", "1h"],
};

const INVALID = Symbol("invalid");
const CONFLICT = Symbol("conflict");

function decode(entry) {
  if (typeof entry === "string" || entry instanceof String) {
    try {
      const parsed = JSON.parse(String(entry));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  return entry && typeof entry === "object" ? entry : null;
}

function classifyFoundationModel(usage, attrs, skipped) {
  const m = FM_USAGE.exec(usage);
  if (!m) return null;
  const body = m[1];
  let bucket, ttl, long, global;
  const s = FM_SNAKE.exec(body);
  if (s) {
    [bucket, ttl, long, global] = [s[1], s[2], !!s[3], !!s[4]];
  } else {
    const c = FM_CAMEL.exec(body);
    if (!c) return null;
    [bucket, ttl] = CAMEL_BUCKETS[c[1]];
    long = false;
    global = !!c[2];
  }
  if (ttl && bucket !== "cache_write") return null;
  const name = typeof attrs.model === "string" ? attrs.model.trim() : "";
  let table, key;
  if (attrs.provider === "Anthropic") {
    table = "claude";
    key = name.toLowerCase().replace(/[ .]+/g, "-");
    if (!CLAUDE_KEY.test(key) || /-v\d+$/.test(key) || /-\d{8}$/.test(key)) {
      skipped.push({ table, model: key || name, reason: "unrecognized_model" });
      return null;
    }
  } else if (attrs.provider === "OpenAI") {
    table = "codex";
    key = "openai." + name.replace(/^openai\s+/i, "").toLowerCase().replace(/\s+/g, "-");
    if (!VENDOR_KEY.test(key)) {
      skipped.push({ table, model: key, reason: "unrecognized_model" });
      return null;
    }
  } else {
    return null;
  }
  return { table, key, bucket, ttl, long, global };
}

function classifyBedrock(usage, attrs) {
  const m = AB_USAGE.exec(usage);
  if (!m) return null;
  const key = m[1];
  const bucket = m[3].replace("-", "_");
  const ttl = m[4];
  const suffix = m[5];
  if (ttl && bucket !== "cache_write") return null;
  // Display-style ids and Anthropic rows (priced via FoundationModels) are not model ids here.
  if (!VENDOR_KEY.test(key) || key.startsWith("anthropic.")) return null;
  if (attrs.service_tier !== undefined && attrs.service_tier !== (suffix ?? "standard")) return null;
  return { table: "codex", key, bucket, ttl, long: false, global: suffix === "global-standard" };
}

// Shift the decimal point in the string so "0.0033" per 1K becomes exactly 3.3 per 1M.
function priceOf(entry) {
  const dims = Object.values(entry.terms?.OnDemand ?? {}).flatMap((term) => Object.values(term?.priceDimensions ?? {}));
  if (dims.length !== 1) return INVALID;
  const d = dims[0];
  if ((d.beginRange ?? "0") !== "0" || (d.endRange ?? "Inf") !== "Inf") return INVALID;
  const usd = d.pricePerUnit?.USD;
  const m = typeof usd === "string" ? DECIMAL.exec(usd) : null;
  if (!m) return INVALID;
  const unit = String(d.unit).toLowerCase();
  const shift = unit === "1m tokens" ? 0 : unit === "1k tokens" ? 3 : -1;
  if (shift < 0) return INVALID;
  const whole = m[1];
  const frac = (m[2] ?? "").padEnd(shift, "0");
  return Number(`${whole}${frac.slice(0, shift)}.${frac.slice(shift) || "0"}`);
}

function slotError(cell) {
  const values = [...cell.values()];
  if (values.includes(INVALID)) return "invalid_rate";
  if (values.includes(CONFLICT)) return "conflicting_rates";
  return null;
}

function codexRates(cell) {
  const error = slotError(cell);
  if (error) return { error };
  if (!cell.has("input") || !cell.has("output")) return { error: "incomplete" };
  const writes = [...cell.keys()].filter((slot) => slot.startsWith("cache_write_"));
  let write;
  if (writes.length === 1) write = cell.get(writes[0]);
  else if (writes.includes("cache_write_5m")) write = cell.get("cache_write_5m");
  else if (writes.length > 1) return { error: "ambiguous_cache_write" };
  if (!cell.has("cache_read") && write !== undefined) return { error: "incomplete" };
  const input = cell.get("input");
  return { rates: { input, cacheWrite: write ?? input, cacheRead: cell.get("cache_read") ?? input, output: cell.get("output") } };
}

export function parsePriceList(products) {
  const skipped = [];
  const cells = new Map();
  for (const serviceCode of PRICE_LIST_SERVICE_CODES) {
    for (const raw of products?.[serviceCode] ?? []) {
      const entry = decode(raw);
      if (!entry) continue;
      const attrs = entry.product?.attributes ?? {};
      if (attrs.regionCode !== PRICE_LIST_REGION) continue;
      const usage = typeof attrs.usagetype === "string" ? attrs.usagetype : "";
      const c = serviceCode === "AmazonBedrock" ? classifyBedrock(usage, attrs) : classifyFoundationModel(usage, attrs, skipped);
      if (!c) continue;
      const scopeTier = `${c.global ? "global" : "regional"}/${c.long ? "long" : "short"}`;
      const slot = c.bucket === "cache_write" ? `cache_write_${c.ttl ?? "5m"}` : c.bucket;
      const id = `${c.table}\u0000${c.key}`;
      if (!cells.has(id)) cells.set(id, new Map());
      const scopes = cells.get(id);
      if (!scopes.has(scopeTier)) scopes.set(scopeTier, new Map());
      const cell = scopes.get(scopeTier);
      const v = priceOf(entry);
      const prev = cell.get(slot);
      if (v === INVALID || prev === INVALID) cell.set(slot, INVALID);
      else if (prev === undefined) cell.set(slot, v);
      else if (prev !== v) cell.set(slot, CONFLICT);
    }
  }

  const claude = {};
  const codex = {};
  for (const id of [...cells.keys()].sort()) {
    const [table, key] = id.split("\u0000");
    const scopes = cells.get(id);
    if (table === "claude") {
      const cell = scopes.get("global/short");
      if (!cell) {
        skipped.push({ table, model: key, reason: "no_global_rates" });
        continue;
      }
      const error = slotError(cell);
      const required = ["input", "output", "cache_read", "cache_write_5m", "cache_write_1h"];
      if (error || !required.every((slot) => cell.has(slot))) {
        skipped.push({ table, model: key, reason: error ?? "incomplete" });
        continue;
      }
      claude[key] = {
        input: cell.get("input"),
        output: cell.get("output"),
        cacheWrite: cell.get("cache_write_5m"),
        cacheWrite1h: cell.get("cache_write_1h"),
        cacheRead: cell.get("cache_read"),
      };
      continue;
    }
    const result = {};
    for (const scope of ["regional", "global"]) {
      const shortCell = scopes.get(`${scope}/short`);
      const longCell = scopes.get(`${scope}/long`);
      if (!shortCell && !longCell) continue;
      if (!shortCell) {
        skipped.push({ table, model: key, scope, reason: "incomplete" });
        continue;
      }
      const short = codexRates(shortCell);
      if (short.error) {
        skipped.push({ table, model: key, scope, reason: short.error });
        continue;
      }
      if (!longCell) {
        result[scope] = { short: short.rates };
        continue;
      }
      const long = codexRates(longCell);
      if (long.error) {
        skipped.push({ table, model: key, scope, reason: long.error });
        continue;
      }
      result[scope] = { short: short.rates, long: long.rates };
    }
    if (Object.keys(result).length) codex[key] = result;
  }

  const unique = new Map(skipped.map((item) => [JSON.stringify([item.table, item.model, item.scope ?? "", item.reason]), item]));
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const sortedSkipped = [...unique.values()].sort((a, b) =>
    cmp(a.table, b.table) || cmp(a.model, b.model) || cmp(a.scope ?? "", b.scope ?? "") || cmp(a.reason, b.reason));
  return { claude: sortKeys(claude), codex: sortKeys(codex), skipped: sortedSkipped };
}

function sortKeys(object) {
  return Object.fromEntries(Object.keys(object).sort().map((key) => [key, object[key]]));
}

export async function fetchPriceList({ client, signal, maxPages = 100 } = {}) {
  const pricing = client ?? new PricingClient({ region: PRICE_LIST_REGION });
  const result = {};
  for (const serviceCode of PRICE_LIST_SERVICE_CODES) {
    const items = [];
    let NextToken;
    let pages = 0;
    do {
      if (pages >= maxPages) throw new Error(`AWS Price List ${serviceCode} exceeded ${maxPages} pages`);
      pages += 1;
      const response = await pricing.send(new GetProductsCommand({
        ServiceCode: serviceCode,
        FormatVersion: "aws_v1",
        Filters: [{ Type: "TERM_MATCH", Field: "regionCode", Value: PRICE_LIST_REGION }],
        MaxResults: 100,
        NextToken,
      }), { abortSignal: signal });
      // The SDK returns String wrapper objects; normalize to primitives.
      for (const item of response.PriceList ?? []) items.push(String(item));
      NextToken = response.NextToken || undefined;
    } while (NextToken);
    result[serviceCode] = items;
  }
  return result;
}
