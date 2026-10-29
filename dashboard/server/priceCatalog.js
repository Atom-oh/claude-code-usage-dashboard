import { readFileSync } from "node:fs";
import { buildPricing } from "./pricing.js";
import { DEFAULT_CODEX_PRICING, mergeCodexPriceList, parseCodexPricing } from "./codexPricing.js";
import { fetchPriceList, parsePriceList } from "./awsPriceList.js";

// Merged rate view for every pricing path (ADR-017 amendment 2026-10-28). Precedence per model:
// PRICING_JSON / CODEX_PRICING_JSON > runtime AWS Price List refresh > build-time snapshot
// (awsPriceSnapshot.json) > the code tables in pricing.js / codexPricing.js.
//
// pricing.js imports claudePricing() from here while this module imports buildPricing() from it.
// The cycle is safe only because neither module calls into the other while being evaluated: this
// module's top level reads the snapshot file with local code only, and merged tables are built
// lazily on the first getter call.

const SNAPSHOT_URL = new URL("./awsPriceSnapshot.json", import.meta.url);
const REFRESH_TIMEOUT_MS = 120_000;
const RATE_RATIO_WARNING = 2;
const CLAUDE_KEY = /^claude-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VENDOR_KEY = /^[a-z][a-z0-9-]*[a-z]\.[a-z0-9][a-z0-9._-]*$/;
const CLAUDE_FIELDS = ["input", "output", "cacheWrite", "cacheWrite1h", "cacheRead"];
const CODEX_FIELDS = ["input", "cacheWrite", "cacheRead", "output"];

const object = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const rate = (x) => typeof x === "number" && Number.isFinite(x) && x >= 0;
const rates = (x, fields) => object(x) && fields.every((field) => rate(x[field]));

// A layer is { fetchedAt, claude, codex } in awsPriceList.js shape. Anything else is rejected whole:
// a hand-edited or truncated snapshot must not half-apply.
function validLayer(layer) {
  if (!object(layer) || typeof layer.fetchedAt !== "string" || Number.isNaN(Date.parse(layer.fetchedAt))
      || !object(layer.claude) || !object(layer.codex)) return false;
  for (const [key, entry] of Object.entries(layer.claude))
    if (!CLAUDE_KEY.test(key) || !rates(entry, CLAUDE_FIELDS)) return false;
  for (const [key, entry] of Object.entries(layer.codex)) {
    if (!VENDOR_KEY.test(key) || !object(entry) || !(entry.regional || entry.global)) return false;
    for (const scope of ["regional", "global"]) {
      if (entry[scope] === undefined) continue;
      if (!object(entry[scope]) || !rates(entry[scope].short, CODEX_FIELDS)
          || (entry[scope].long !== undefined && !rates(entry[scope].long, CODEX_FIELDS))) return false;
    }
  }
  return true;
}

function readSnapshot(url) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(url, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") console.warn(`[price-list] ignoring unreadable snapshot: ${error.message}`);
    return null;
  }
  if (!validLayer(parsed)) {
    console.warn("[price-list] ignoring snapshot with an invalid shape");
    return null;
  }
  return { fetchedAt: parsed.fetchedAt, claude: parsed.claude, codex: parsed.codex };
}

let snapshot = readSnapshot(SNAPSHOT_URL);
let runtime = null;
let version = 0;
let claudeMemo = null;
let codexMemo = null;
let refreshing = null;
let timer = null;

const activeLayer = () => runtime ?? snapshot;

// Memoized per layer version and env text. The env is part of the key so a test that re-imports
// pricing.js under a different PRICING_* env sees its own table.
export function claudePricing() {
  const key = [version, process.env.PRICING_JSON ?? "", process.env.PRICING_CACHE_WRITE_TTL ?? ""].join("\u0000");
  if (claudeMemo?.key !== key) claudeMemo = { key, value: buildPricing(process.env, activeLayer()?.claude) };
  return claudeMemo.value;
}

export function codexPrices() {
  const key = `${version}\u0000${process.env.CODEX_PRICING_JSON ?? ""}`;
  if (codexMemo?.key !== key) codexMemo = { key, value: parseCodexPricing(process.env.CODEX_PRICING_JSON, activeLayer()?.codex) };
  return codexMemo.value;
}

// /api/config metadata: never rates.
export function priceListStatus() {
  const layer = activeLayer();
  return {
    source: runtime ? "runtime" : snapshot ? "snapshot" : "code",
    fetchedAt: layer?.fetchedAt ?? null,
    models: layer ? [...new Set([...Object.keys(layer.claude), ...Object.keys(layer.codex)])].sort() : [],
  };
}

// Startup validation, called at module scope by index.js so a bad value fails the boot.
export function priceListConfig(env = process.env) {
  const mode = env.AWS_PRICE_LIST ?? "";
  if (!["", "on", "off"].includes(mode)) throw new Error(`AWS_PRICE_LIST must be "on" or "off", got "${mode}"`);
  const rawHours = env.AWS_PRICE_REFRESH_HOURS ?? "";
  const refreshHours = rawHours === "" ? 12 : Number(rawHours);
  if (!Number.isFinite(refreshHours) || refreshHours < 1 || refreshHours > 168)
    throw new Error(`AWS_PRICE_REFRESH_HOURS must be a number of hours from 1 to 168, got "${rawHours}"`);
  return { enabled: mode !== "off", refreshHours };
}

// Log lines for a layer: merge decisions plus rates more than 2x away from the code tables (still
// applied: the operator chose live list prices).
function layerNotes(layer) {
  const notes = [];
  mergeCodexPriceList(DEFAULT_CODEX_PRICING, layer.codex, notes);
  const far = (code, listed) => code > 0 && listed > 0
    ? Math.max(code / listed, listed / code) > RATE_RATIO_WARNING : code !== listed;
  const compare = (label, code, listed, fields) => {
    for (const field of fields)
      if (code && listed && far(code[field], listed[field]))
        notes.push(`${label} ${field}: AWS ${listed[field]} vs code table ${code[field]} (more than ${RATE_RATIO_WARNING}x apart)`);
  };
  const claudeCode = buildPricing({}).table;
  for (const [model, listed] of Object.entries(layer.claude)) compare(model, claudeCode[model], listed, CLAUDE_FIELDS);
  for (const [model, listed] of Object.entries(layer.codex)) {
    const code = DEFAULT_CODEX_PRICING[model];
    for (const scope of ["regional", "global"])
      for (const tier of ["short", "long"])
        compare(`${model} ${scope}/${tier}`, code?.[scope]?.[tier], listed[scope]?.[tier], CODEX_FIELDS);
  }
  return notes;
}

function logLayer(label, layer) {
  if (!layer) return;
  console.log(`[price-list] ${label}: ${Object.keys(layer.claude).length} Claude, ${Object.keys(layer.codex).length} Codex models (fetched ${layer.fetchedAt})`);
  for (const note of layerNotes(layer)) console.warn(`[price-list] ${note}`);
}

// Error names/codes only: provider messages can carry account or role identifiers.
const describe = (error) => [error?.name || "Error", error?.code, error?.$metadata?.httpStatusCode]
  .filter(Boolean).join(" ");

/**
 * Fetch and parse the Price List once. A failure, or a response with no complete model, keeps the
 * previous layer. Concurrent calls share one refresh. Response caches keep serving their entries
 * until their own TTL; nothing is flushed here.
 */
export function refreshPriceList({ fetch = fetchPriceList, now = () => new Date() } = {}) {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const parsed = parsePriceList(await fetch({ signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS) }));
      const layer = { fetchedAt: now().toISOString().replace(/\.\d{3}Z$/, "Z"), claude: parsed.claude, codex: parsed.codex };
      if (!Object.keys(layer.claude).length && !Object.keys(layer.codex).length)
        throw new Error("no complete model rates in the AWS Price List response");
      runtime = layer;
      version += 1;
      logLayer(`runtime refresh, ${parsed.skipped.length} skipped entries`, layer);
      return true;
    } catch (error) {
      console.warn(`[price-list] refresh failed; keeping ${priceListStatus().source} rates: ${describe(error)}`);
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

// Called once the server listens. The first refresh runs in the background; neither startup nor a
// request ever waits for it.
export function startPriceListRefresh(config = priceListConfig(), options = {}) {
  logLayer("build snapshot", snapshot);
  if (!snapshot) console.warn("[price-list] no build snapshot; code tables apply until a refresh succeeds");
  if (!config.enabled) {
    console.log("[price-list] runtime refresh disabled (AWS_PRICE_LIST=off)");
    return null;
  }
  stopPriceListRefresh();
  void refreshPriceList(options);
  timer = setInterval(() => void refreshPriceList(options), config.refreshHours * 3_600_000);
  timer.unref();
  return timer;
}

export function stopPriceListRefresh() {
  if (timer) clearInterval(timer);
  timer = null;
}

// Tests only: replace both layers (null clears one; the committed snapshot is the default).
export function setPriceListLayersForTesting({ snapshot: nextSnapshot = readSnapshot(SNAPSHOT_URL), runtime: nextRuntime = null } = {}) {
  for (const layer of [nextSnapshot, nextRuntime])
    if (layer !== null && !validLayer(layer)) throw new Error("invalid price list layer");
  snapshot = nextSnapshot;
  runtime = nextRuntime;
  version += 1;
}
