// Operator-only comparison; imported by tests without issuing queries.
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { buildCodexQuery, foldClientMetrics } from "./clientMetrics.js";
import { codexPrices } from "./priceCatalog.js";
import { parseCostReadFrom } from "./codexCostSource.js";
import { query, assertReadonlySession } from "./clickhouse.js";

const stable = value => Array.isArray(value) ? value.map(stable).sort((a, b) => {
  const left = JSON.stringify(a), right = JSON.stringify(b);
  return left < right ? -1 : left > right ? 1 : 0;
}) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;

export async function compareCodexCost(options, runQuery = query) {
  const from = parseCostReadFrom(options.from), to = parseCostReadFrom(options.to);
  if (!from || !to || +to <= +from || +to - +from > 86400000)
    throw new Error("Comparison requires a positive timestamp interval of at most one day");
  const filters = { userExact: options.userExact || "", modelExact: options.modelExact || "",
    backend: options.backend || "" };
  // Both reads and both folds price against the same table.
  const prices = codexPrices();
  const results = [];
  for (const costSource of ["raw", "facts"]) {
    const request = buildCodexQuery(from, to, filters, prices, "codex", undefined,
      { costView: true, costSource });
    results.push(await runQuery(request.sql, request.params, AbortSignal.timeout(25000)));
  }
  // SQL row order is unspecified. Use identical ordering before folding so
  // floating-point accumulation order cannot masquerade as a schema mismatch.
  // Every SQL value and duplicate remains subject to exact comparison.
  const [raw, facts] = results.map(stable);
  const sqlMatch = isDeepStrictEqual(raw, facts);
  const foldMatch = [false, true].every(compactTime => {
    const fold = rows => stable(foldClientMetrics(rows.map(row => ({ ...row, client: "codex" })),
      ["codex"], prices, { costView: true, modelTime: true, compactTime }));
    return isDeepStrictEqual(fold(raw), fold(facts));
  });
  return { matched: sqlMatch && foldMatch, sql_match: sqlMatch, fold_match: foldMatch,
    raw_rows: raw.length, facts_rows: facts.length, has_evidence: raw.length > 0 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: Object.fromEntries(
      ["from", "to", "user-exact", "model-exact", "backend"].map(key => [key, { type: "string" }])) });
    if (await assertReadonlySession() !== true)
      throw new Error("Readonly database session could not be confirmed");
    const result = await compareCodexCost({ from: values.from, to: values.to,
      userExact: values["user-exact"], modelExact: values["model-exact"], backend: values.backend });
    console.log(JSON.stringify(result));
    process.exitCode = result.matched ? 0 : 1;
  } catch {
    // DB errors can contain SQL and identities. Keep diagnostics private.
    console.error("Codex cost comparison failed. Check UTC bounds, readonly credentials, schema and private database logs.");
    process.exitCode = 1;
  }
}
