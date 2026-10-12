import { createHash } from "node:crypto";
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const hash = text => createHash("sha256").update(text).digest("hex");
const licenseName = /^(licen[sc]e|copying|notice)(?:[-_][^.]+)?(?:\.(?:txt|md|rst))?$/i;
const hasLicenseText = files => files.some(file => file.kind === "license");
const awsSharedLicensePackages = new Set([
  "@aws-sdk/credential-provider-http@3.972.56",
  "@aws-sdk/credential-provider-login@3.972.60",
  "@aws-sdk/nested-clients@3.997.28",
]);
const catalogRoot = fileURLToPath(new URL("./notices/", import.meta.url));

function licenseFiles(directory, relative = "") {
  const found = [];
  for (const entry of readdirSync(path.join(directory, relative), { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name === "node_modules") continue;
    const name = path.join(relative, entry.name);
    if (entry.isFile() && licenseName.test(entry.name)) {
      const text = readFileSync(path.join(directory, name), "utf8");
      if (text.trim()) found.push({ path: name.split(path.sep).join("/"), text, sha256: hash(text),
        kind: /^notice/i.test(entry.name) ? "notice" : relative ? "supplementary" : "license" });
    } else if (entry.isDirectory()) {
      found.push(...licenseFiles(directory, name));
    }
  }
  return found.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

function readmeLicense(directory) {
  const name = readdirSync(directory).find(value => /^readme(?:\.md|\.txt)?$/i.test(value));
  if (!name) return [];
  const text = readFileSync(path.join(directory, name), "utf8");
  const heading = /^(#{1,6})\s+(?:license|licence)\s*$/im.exec(text);
  if (!heading) return [];
  const level = heading[1].length;
  const tail = text.slice(heading.index + heading[0].length);
  const next = new RegExp(`^\\s*#{1,${level}}\\s+`, "m").exec(tail);
  const section = tail.slice(0, next ? next.index : undefined).trim();
  // A link/badge/declaration alone is not a license text.
  if (!/permission is hereby granted|redistribution and use|terms and conditions/i.test(section)) return [];
  return [{ path: name + "#license", text: section, sha256: hash(section), kind: "license" }];
}

function sharedRepositoryLicense(packageRoot, manifest, key) {
  if (!awsSharedLicensePackages.has(key) || manifest.license !== "Apache-2.0" ||
      manifest.repository?.url !== "https://github.com/aws/aws-sdk-js-v3.git") return [];
  const peerRoot = path.join(packageRoot, "node_modules/@aws-sdk/core");
  if (!existsSync(path.join(peerRoot, "package.json"))) return [];
  const peer = JSON.parse(readFileSync(path.join(peerRoot, "package.json"), "utf8"));
  if (peer.license !== manifest.license || peer.repository?.url !== manifest.repository.url)
    throw new Error("shared repository license provenance differs");
  return licenseFiles(peerRoot).map(file => ({
    ...file,
    path: `shared-repository/@aws-sdk/core@${peer.version}/${file.path}`,
    provenance: "same declared Apache-2.0 license and publisher repository; exact installed peer text",
  }));
}

function declaredStandardLicense(manifest, key) {
  const provenance = JSON.parse(readFileSync(path.join(catalogRoot, "provenance.json"), "utf8"));
  const declaration = provenance.packageDeclarations[key];
  if (!declaration) return [];
  const repository = String(manifest.repository?.url || manifest.repository || "")
    .replace(/^git\+/, "").replace(/\.git$/, "");
  if (manifest.license !== declaration.declaredLicense ||
      repository !== declaration.repository || manifest.author !== declaration.authorMetadata)
    throw new Error("standard license declaration differs from reviewed publisher metadata");
  const filename = declaration.licenseFile || "MIT-spdx.txt";
  const file = provenance.catalog[filename];
  const text = readFileSync(path.join(catalogRoot, filename), "utf8");
  if (hash(text) !== file.sha256 || file.licenseId !== (declaration.packageLicenseId || declaration.declaredLicense))
    throw new Error("pinned standard license source differs");
  return [{ path: "catalog-license/" + filename, text, sha256: file.sha256,
    source: file.source, publisherDeclaration: declaration, standardLicenseText: !declaration.licenseFile, kind: "license" }];
}

export function collectNotices(dashboardRoot) {
  const packages = new Map();
  const lockfiles = {};
  const unresolved = [];
  for (const component of ["server", "web"]) {
    const root = path.join(dashboardRoot, component);
    const lockText = readFileSync(path.join(root, "package-lock.json"), "utf8");
    const lock = JSON.parse(lockText);
    lockfiles[component] = hash(lockText);
    for (const [location, metadata] of Object.entries(lock.packages)) {
      if (!location || metadata.dev || !location.startsWith("node_modules/")) continue;
      if (path.isAbsolute(location) || location.split("/").includes("..")) throw new Error("unsafe package location");
      const directory = path.join(root, location);
      if (!existsSync(path.join(directory, "package.json"))) {
        if (metadata.optional) continue; // Other-platform optional packages are not installed.
        throw new Error(`production dependency is not installed: ${component}/${location}`);
      }
      const manifest = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
      if (manifest.version !== metadata.version || typeof manifest.name !== "string")
        throw new Error(`installed dependency differs from lockfile: ${component}/${location}`);
      const key = `${manifest.name}@${manifest.version}`;
      let entry = packages.get(key);
      if (!entry) {
        const files = licenseFiles(directory);
        if (!hasLicenseText(files)) files.push(...readmeLicense(directory));
        if (!hasLicenseText(files)) files.push(...sharedRepositoryLicense(root, manifest, key));
        if (!hasLicenseText(files)) files.push(...declaredStandardLicense(manifest, key));
        entry = { name: manifest.name, version: manifest.version,
          declaredLicense: typeof manifest.license === "string" ? manifest.license : null,
          repository: typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url,
          components: [], files };
        packages.set(key, entry);
      }
      if (!entry.components.includes(component)) entry.components.push(component);
    }
  }
  const entries = [...packages.values()].sort((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, "en"));
  for (const entry of entries) {
    if (!entry.declaredLicense || entry.declaredLicense === "UNLICENSED" || !hasLicenseText(entry.files))
      unresolved.push({ package: `${entry.name}@${entry.version}`,
        reason: !entry.declaredLicense ? "missing_declaration"
          : entry.declaredLicense === "UNLICENSED" ? "unlicensed_dependency" : "missing_license_text" });
  }
  const report = { schemaVersion: 1, lockfiles, complete: unresolved.length === 0,
    packages: entries, unresolved };
  const text = [
    "Third-party dependency notices",
    "Source: installed production dependency manifests and packaged license/notice texts.",
    "Web dependencies are conservatively inventoried; this is not a bundler inclusion proof.",
    "The application remains governed by its separate LICENSE and customer agreement.",
    "Standard license texts are labelled; copyright placeholders are not invented upstream notices.",
    report.complete ? "All inventoried packages have license declarations and texts."
      : "INCOMPLETE: unresolved packages are listed in THIRD_PARTY_NOTICES.json.",
    ...entries.flatMap(entry => [
      `\n===== ${entry.name}@${entry.version} =====`,
      `Components: ${entry.components.join(", ")}`,
      `Declared license: ${entry.declaredLicense || "unknown"}`,
      ...entry.files.filter(file => file.standardLicenseText).flatMap(file => [
        `Publisher metadata attribution: ${file.publisherDeclaration.authorMetadata}`,
        `Declaration note: ${file.publisherDeclaration.notice}`,
        `Standard text source: ${file.source}`,
      ]),
      ...entry.files.flatMap(file => [`--- ${file.path} (SHA-256 ${file.sha256}) ---`, file.text]),
    ]),
  ].join("\n") + "\n";
  return { report, text };
}

function main() {
  const [root, output] = process.argv.slice(2);
  if (!root || !output) throw new Error("usage: node collect-notices.mjs DASHBOARD_ROOT NEW_OUTPUT_DIRECTORY");
  if (existsSync(output)) throw new Error("notice output must be a new directory");
  const result = collectNotices(path.resolve(root));
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, "THIRD_PARTY_NOTICES.json"), JSON.stringify(result.report, null, 2) + "\n");
  writeFileSync(path.join(output, "THIRD_PARTY_NOTICES.txt"), result.text);
  console.log(JSON.stringify({ packages: result.report.packages.length,
    complete: result.report.complete, unresolved: result.report.unresolved, output }));
  if (!result.report.complete) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
