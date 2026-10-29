// Builds awsPriceSnapshot.json from the AWS Price List (live or saved GetProducts output).
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PRICE_LIST_REGION, PRICE_LIST_SERVICE_CODES, parsePriceList, fetchPriceList } from "../awsPriceList.js";

const USAGE = "Usage: node scripts/prices-snapshot.js [--from-files <AmazonBedrockFoundationModels.json> <AmazonBedrock.json>] [--fetched-at <ISO-8601>] [--out <path>]";

class UsageError extends Error {}

function parseArgs(argv) {
  const options = { out: fileURLToPath(new URL("../awsPriceSnapshot.json", import.meta.url)) };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new UsageError(`missing value for ${arg}`);
      i += 1;
      return next;
    };
    if (arg === "--from-files") options.fromFiles = [value(), value()];
    else if (arg === "--fetched-at") options.fetchedAt = value();
    else if (arg === "--out") options.out = value();
    else throw new UsageError(`unknown argument ${arg}`);
  }
  return options;
}

// Second precision keeps the snapshot text stable across tools.
function normalizeTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid --fetched-at: ${value}`);
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function readPriceList(path) {
  const data = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(data?.PriceList)) throw new Error(`${path} has no PriceList array`);
  return data.PriceList;
}

function readExisting(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

const comparable = (s) => JSON.stringify([s?.region, s?.serviceCodes, s?.claude, s?.codex, s?.skipped]);

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  try {
    let products;
    let fetchedAt;
    if (options.fromFiles) {
      const [fm, ab] = options.fromFiles;
      products = { AmazonBedrockFoundationModels: readPriceList(fm), AmazonBedrock: readPriceList(ab) };
      fetchedAt = options.fetchedAt ?? new Date(Math.max(statSync(fm).mtimeMs, statSync(ab).mtimeMs));
    } else {
      if (options.fetchedAt !== undefined) normalizeTime(options.fetchedAt);
      products = await fetchPriceList({ signal: AbortSignal.timeout(120_000) });
      fetchedAt = options.fetchedAt ?? new Date();
    }
    fetchedAt = normalizeTime(fetchedAt);
    const parsed = parsePriceList(products);
    const claudeCount = Object.keys(parsed.claude).length;
    const codexCount = Object.keys(parsed.codex).length;
    if (!claudeCount && !codexCount) throw new Error("no complete model rates were parsed");
    const snapshot = {
      fetchedAt,
      region: PRICE_LIST_REGION,
      serviceCodes: [...PRICE_LIST_SERVICE_CODES],
      claude: parsed.claude,
      codex: parsed.codex,
      skipped: parsed.skipped,
    };
    const old = readExisting(options.out);
    if (old && comparable(old) === comparable(snapshot)) {
      console.log(`AWS price snapshot unchanged (fetched ${old.fetchedAt}): ${options.out}`);
      return;
    }
    // Temp file + rename so a failure never leaves a partial snapshot.
    const tmp = `${options.out}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + "\n");
    renameSync(tmp, options.out);
    console.log(`Wrote ${options.out}: ${claudeCount} Claude, ${codexCount} Codex models; ${parsed.skipped.length} skipped entries (fetched ${fetchedAt})`);
  } catch (error) {
    console.error(`prices:snapshot failed: ${error.message}`);
    console.error("The existing snapshot was not changed. Fix the cause and re-run; building with the committed snapshot needs an explicit --skip-price-snapshot decision.");
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`prices:snapshot failed: ${error.message}`);
  process.exitCode = 1;
});
