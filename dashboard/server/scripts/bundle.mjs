// Bundles the runtime entries into a standalone directory so the image needs no node_modules.
import { build } from "esbuild";
import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRIES = ["index.js", "backupHealth.js", "clickhouse.js"];
// Non-JS files the bundle reads next to its entries (package.json, awsPriceSnapshot.json),
// plus the lockfile that identifies the bundled dependency tree for verify-runtime.mjs.
// The Dockerfile ships the whole output directory except meta.json.
export const RUNTIME_FILES = ["package.json", "package-lock.json", "awsPriceSnapshot.json"];

// Each entry: { text (exact esbuild warning text), reason (one line why it is safe) }.
export const ALLOWED_WARNINGS = [];

export async function bundleServer({ outdir }) {
  const target = path.resolve(outdir);
  if (existsSync(target)) throw new Error(`output directory already exists: ${target}`);
  const result = await build({
    entryPoints: ENTRIES,
    absWorkingDir: serverDir,
    outdir: target,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    splitting: false,
    minify: false,
    sourcemap: false,
    metafile: true,
    logLevel: "silent",
    // Bundled CommonJS dependencies need require() for Node builtins.
    banner: { js: 'import { createRequire as __ccdashCreateRequire } from "node:module"; const require = __ccdashCreateRequire(import.meta.url);' },
  });
  const allowed = new Set(ALLOWED_WARNINGS.map((warning) => warning.text));
  const unexpected = result.warnings.filter((warning) => !allowed.has(warning.text));
  if (unexpected.length) {
    throw new Error(`esbuild warnings:\n${unexpected.map((warning) => `${warning.location?.file ?? ""}: ${warning.text}`).join("\n")}`);
  }
  for (const file of RUNTIME_FILES) copyFileSync(path.join(serverDir, file), path.join(target, file));
  writeFileSync(path.join(target, "meta.json"), JSON.stringify(result.metafile));
  return { entries: [...ENTRIES].sort(), metafile: result.metafile };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outdir = process.argv[2];
  if (!outdir) {
    console.error("usage: node scripts/bundle.mjs OUTDIR");
    process.exit(1);
  }
  try {
    const { entries } = await bundleServer({ outdir });
    console.log(`bundled ${entries.join(", ")} into ${path.resolve(outdir)}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
