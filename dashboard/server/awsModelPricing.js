import { buildCodexLogAggregateQuery } from "./codexLogAggregates.js";

// AWS's published model-card index is public; no usage data or credentials are sent.
// Only the explicitly described Standard, commercial, 30-minute-cache format is
// accepted. Other formats stay unpriced (or use the existing offline catalog).
const BASE = "https://docs.aws.amazon.com/bedrock/latest/userguide/";
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_CARDS = 256;
const WORKERS = 6;

// Leave room for HTTP headers and long filters. Both cost SQL paths use bound
// parameters; the log aggregation catalog is the larger of the two.
export function priceCatalogFits(prices) {
  const from = new Date("2026-01-01T00:00:00Z"), to = new Date("2026-01-02T00:00:00Z");
  const { params } = buildCodexLogAggregateQuery(from, to, { user: "x".repeat(128), model: "x".repeat(128) }, prices);
  return Object.entries(params).reduce((n, [key, value]) =>
    n + `param_${key}=${encodeURIComponent(String(value))}&`.length, 0) < 8192;
}

export function discoverAwsModelCards(index) {
  return [...new Set([...index.matchAll(/\]\((model-card-[a-z0-9-]+\.md)\)/g)].map(m => m[1]))].slice(0, MAX_CARDS);
}

function section(text, name) {
  return text.match(new RegExp(`^## ${name}\\s*$([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "mi"))?.[1] || "";
}

function tableRows(text) {
  return text.split("\n").filter(line => /^\s*\|/.test(line))
    .map(line => line.trim().replace(/^\||\|$/g, "").split("|").map(cell => cell.trim().replaceAll("**", "").replace(/^`([^`]+)`$/, "$1")));
}

function priceTable(text, kind, multipleTiers) {
  const heading = multipleTiers ? "Standard — Commercial Regions, " : "Commercial Regions — ";
  const expression = new RegExp(kind === "short"
    ? `^### ${heading}short context \\((\\d+)K input tokens or fewer\\)\\s*$`
    : `^### ${heading}long context \\(more than (\\d+)K input tokens\\)\\s*$`, "mi");
  const match = expression.exec(text);
  if (!match) return null;
  const rest = text.slice(match.index + match[0].length).split(/^### /m)[0];
  const rows = tableRows(rest);
  const header = ["Inference option", "Input", "Input — 30-minute cache write", "Input — cache read", "Output"];
  if (rows[0]?.[2] === "Input — cache write" && /\*\*Input — 30-minute cache write\*\* column/.test(text))
    rows[0][2] = "Input — 30-minute cache write";
  if (rows.length !== 5 || JSON.stringify(rows[0]) !== JSON.stringify(header)) return null;
  const values = {}; let geoPrefix = null;
  for (const row of rows.slice(2)) {
    const label = row[0] === "In-Region" || /^Regional \(bedrock-mantle in .+\)$/.test(row[0]) ? "In-Region"
      : row[0] === "Geo CRIS" || /^US CRIS \(bedrock-runtime\)$/.test(row[0]) ? "Geo CRIS"
      : row[0] === "Global CRIS" || row[0] === "Global CRIS (bedrock-runtime)" ? "Global CRIS" : "";
    if (row.length !== 5 || !label || values[label]) return null;
    if (row[0] === "US CRIS (bedrock-runtime)") geoPrefix = "us";
    if (row.slice(1).some(value => !/^\$\d+(?:\.\d+)?$/.test(value))) return null;
    const [input, cacheWrite, cacheRead, output] = row.slice(1).map(value => Number(value.slice(1)));
    if (![input, cacheWrite, cacheRead, output].every(Number.isFinite)) return null;
    values[label] = { input, cacheWrite, cacheRead, output };
  }
  if (!values["In-Region"] || !values["Geo CRIS"] || !values["Global CRIS"]
      || JSON.stringify(values["In-Region"]) !== JSON.stringify(values["Geo CRIS"])) return null;
  return { limit: Number(match[1]) * 1000, regional: values["In-Region"], global: values["Global CRIS"], geoPrefix };
}

export function parseAwsModelCard(document) {
  if (typeof document !== "string" || document.length > MAX_DOCUMENT_BYTES) return null;
  const pricing = section(document, "Pricing");
  if (!/\bUSD per 1 million tokens\b/i.test(pricing)
      || !(/for the Standard tier\b/i.test(pricing) || /Standard and Ultrafast prices\b/i.test(pricing))) return null;
  const multipleTiers = /Standard and Ultrafast prices\b/i.test(pricing);
  const short = priceTable(pricing, "short", multipleTiers), long = priceTable(pricing, "long", multipleTiers);
  if (!short || !long || short.limit !== long.limit || short.geoPrefix !== long.geoPrefix
      || !Number.isSafeInteger(short.limit) || short.limit <= 0) return null;
  const access = tableRows(section(document, "Programmatic Access"));
  const header = ["Endpoint", "Model ID", "In-Region endpoint URL", "Geo inference ID", "Global inference ID"];
  const index = access.findIndex(row => JSON.stringify(row) === JSON.stringify(header));
  if (index < 0) return null;
  const mantle = access.slice(index + 2).filter(row => row[0] === "bedrock-mantle");
  const runtime = access.slice(index + 2).filter(row => row[0] === "bedrock-runtime");
  if (mantle.length !== 1 || runtime.length !== 1 || mantle[0][1] !== runtime[0][1]) return null;
  const model = mantle[0][1];
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(model) || /^(us|eu|apac|jp|au|in|global)\./.test(model)) return null;
  if (!/^https:\/\/bedrock-mantle\.[a-z0-9{}.-]+\.api\.aws\/openai\/v1\/?$/.test(mantle[0][2])
      || mantle[0][3] !== "Not supported" || mantle[0][4] !== "Not supported"
      || runtime[0][4] !== `global.${model}`
      || !["us", "eu", "apac", "jp", "au", "in"].some(prefix => runtime[0][3] === `${prefix}.${model}`)) return null;
  if (short.geoPrefix && runtime[0][3] !== `${short.geoPrefix}.${model}`) return null;
  const runtimeInRegion = runtime[0][2] !== "Not supported";
  if (runtimeInRegion && !/^https:\/\/bedrock-runtime\./.test(runtime[0][2])) return null;
  return { model, price: { short_context_limit: short.limit, runtime_geo_prefix: runtime[0][3].split(".")[0],
    runtime_in_region: runtimeInRegion,
    regional: { short: short.regional, long: long.regional },
    global: { short: short.global, long: long.global } } };
}

async function fetchAwsDocument(name) {
  if (name !== "model-cards.md" && !/^model-card-[a-z0-9-]+\.md$/.test(name)) throw new Error("invalid AWS document name");
  const response = await fetch(BASE + name, { redirect: "error", signal: AbortSignal.timeout(8000) });
  if (!response.ok || !response.body) throw new Error("AWS model card unavailable");
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_DOCUMENT_BYTES) throw new Error("AWS model card too large");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString("utf8");
}

export function createAwsModelPriceUpdater({ prices, overrides = new Set(), aliases = {},
  fetchText = fetchAwsDocument, acceptPrices = priceCatalogFits }) {
  let pending;
  async function update() {
    const names = discoverAwsModelCards(await fetchText("model-cards.md"));
    if (!names.length) throw new Error("AWS model index has no recognized cards");
    const found = new Map(); let cursor = 0, parsed = 0, failed = 0;
    await Promise.all(Array.from({ length: Math.min(WORKERS, names.length) }, async () => {
      while (cursor < names.length) {
        const order = cursor++, name = names[order];
        try {
          const entry = parseAwsModelCard(await fetchText(name));
          if (!entry) { failed++; continue; }
          parsed++;
          if (!entry.model.startsWith("anthropic.") && !overrides.has(entry.model)) {
            // Conflicting cards cannot silently choose an arbitrary price.
            if (found.has(entry.model)) {
              const previous = found.get(entry.model);
              if (!previous || JSON.stringify(previous.price) !== JSON.stringify(entry.price)) found.set(entry.model, null);
              else previous.order = Math.min(previous.order, order);
            }
            else found.set(entry.model, { price: entry.price, order });
          }
        } catch { failed++; /* One unavailable card does not block other models. */ }
      }
    }));
    if (!parsed) throw new Error("AWS model cards have no recognized prices");
    let updated = 0, excluded = 0, conflicts = 0, working = { ...prices };
    for (const [model, value] of found) {
      if (value) continue;
      conflicts++;
      if (Object.hasOwn(working, model)) {
        delete working[model];
        for (const [alias, target] of Object.entries(aliases))
          if (target === model && !overrides.has(alias)) delete working[alias];
        updated++;
      }
    }
    const entries = [...found].filter(([, value]) => value).sort((a, b) => a[1].order - b[1].order);
    for (const [model, { price }] of entries) {
      if (JSON.stringify(working[model]) !== JSON.stringify(price)) {
        const next = { ...working, [model]: price };
        for (const [alias, target] of Object.entries(aliases))
          if (target === model && !overrides.has(alias)) next[alias] = price;
        if (!acceptPrices(next)) {
          excluded++;
          if (Object.hasOwn(working, model)) {
            delete working[model];
            for (const [alias, target] of Object.entries(aliases))
              if (target === model && !overrides.has(alias)) delete working[alias];
            updated++;
          }
          continue;
        }
        working = next;
        updated++;
      }
    }
    for (const model of Object.keys(prices)) if (!Object.hasOwn(working, model)) delete prices[model];
    Object.assign(prices, working);
    return { changed: updated, parsed, failed, total: names.length, excluded, conflicts };
  }
  return { refresh() {
    if (!pending) pending = update().finally(() => { pending = null; });
    return pending;
  } };
}
