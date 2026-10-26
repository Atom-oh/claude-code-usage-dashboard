import { createHash } from "node:crypto";
import { readFileSync, lstatSync, readdirSync } from "node:fs";
import path from "node:path";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const REQUIRED_RUNTIME_ZLIB_VERSION = "1.3.2-r1";
export const REQUIRED_RUNTIME_NODE_VERSION = "24.22.1";
export const REQUIRED_RUNTIME_OPENSSL_VERSION = "3.5.9";
export const REQUIRED_RUNTIME_OPENSSL_PACKAGE_VERSION = "3.5.9-r0";

// This inspector is evaluated inside the built image using Node's builtins. It
// never imports application modules, reads credentials or contacts a database.
export function verifyRuntime({
  root = "/",
  revision = process.env.APP_REVISION,
  uid = process.getuid(),
  versions = process.versions,
  sharedOpenSSL = process.config.variables.node_shared_openssl,
  expectedRevision,
  expectedLicenseSha256,
  expectedLockfiles,
} = {}) {
  const fail = (message) => { throw new Error(`runtime verification: ${message}`); };
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(expectedRevision || "") ||
      revision !== expectedRevision) fail("revision differs from committed source");
  if (uid !== 1000) fail("expected the nonroot Node user");
  if (versions.node !== REQUIRED_RUNTIME_NODE_VERSION)
    fail(`expected Node ${REQUIRED_RUNTIME_NODE_VERSION}`);
  if (versions.openssl !== REQUIRED_RUNTIME_OPENSSL_VERSION || sharedOpenSSL !== true)
    fail(`expected shared OpenSSL ${REQUIRED_RUNTIME_OPENSSL_VERSION}`);
  const location = (name) => path.join(root, name);
  let installedPackages;
  try {
    installedPackages = readFileSync(location("lib/apk/db/installed"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") fail("OS package database is missing");
    throw error;
  }
  const zlibRecords = installedPackages.split(/\r?\n\r?\n/)
    .map((record) => record.split(/\r?\n/))
    .filter((fields) => fields.includes("P:zlib"));
  if (zlibRecords.length !== 1) fail("expected one installed OS zlib package");
  const zlibNames = zlibRecords[0].filter((field) => field.startsWith("P:"));
  const zlibVersions = zlibRecords[0].filter((field) => field.startsWith("V:"));
  if (zlibNames.length !== 1 || zlibVersions.length !== 1 ||
      zlibVersions[0] !== `V:${REQUIRED_RUNTIME_ZLIB_VERSION}`) {
    fail(`expected OS zlib ${REQUIRED_RUNTIME_ZLIB_VERSION}`);
  }
  const zlibPackageVersion = zlibVersions[0].slice(2);
  const opensslPackages = {};
  for (const name of ["libcrypto3", "libssl3"]) {
    const records = installedPackages.split(/\r?\n\r?\n/)
      .map(record => record.split(/\r?\n/))
      .filter(fields => fields.includes(`P:${name}`));
    if (records.length !== 1) fail(`expected one installed OS ${name} package`);
    const names = records[0].filter(field => field.startsWith("P:"));
    const versions = records[0].filter(field => field.startsWith("V:"));
    if (names.length !== 1 || versions.length !== 1 ||
        versions[0] !== `V:${REQUIRED_RUNTIME_OPENSSL_PACKAGE_VERSION}`)
      fail(`expected OS ${name} ${REQUIRED_RUNTIME_OPENSSL_PACKAGE_VERSION}`);
    opensslPackages[name] = versions[0].slice(2);
  }
  const absent = (name) => {
    try { lstatSync(location(name)); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    fail(`unexpected build artifact: ${name}`);
  };
  for (const name of [
    "usr/local/lib/node_modules/npm",
    "usr/local/lib/node_modules/corepack",
    "usr/local/bin/npm", "usr/local/bin/npx", "usr/local/bin/yarn",
    "usr/local/bin/yarnpkg", "usr/local/bin/corepack",
    "usr/local/include/node",
    "app/web/node_modules", "app/collect-notices.mjs", "app/verify-runtime.mjs",
  ]) absent(name);
  if (readdirSync(location("opt")).some((name) => /^yarn-v/.test(name))) {
    fail("unexpected Yarn installation");
  }
  const license = readFileSync(location("app/APPLICATION_LICENSE"));
  if (!/^[a-f0-9]{64}$/.test(expectedLicenseSha256 || "") ||
      sha256(license) !== expectedLicenseSha256) fail("application license differs");
  const noticeJson = readFileSync(location("app/notices/THIRD_PARTY_NOTICES.json"));
  const noticeText = readFileSync(location("app/notices/THIRD_PARTY_NOTICES.txt"));
  const notices = JSON.parse(noticeJson);
  if (notices.schemaVersion !== 1 || notices.complete !== true ||
      !Array.isArray(notices.packages) || !notices.packages.length ||
      !Array.isArray(notices.unresolved) || notices.unresolved.length ||
      !noticeText.toString("utf8").trim()) fail("distribution notices are incomplete");
  for (const component of ["server", "web"]) {
    const expected = expectedLockfiles?.[component];
    if (!/^[a-f0-9]{64}$/.test(expected || "") ||
        notices.lockfiles?.[component] !== expected) fail(`${component} notices lock differs`);
  }
  const serverLockSha256 = sha256(readFileSync(location("app/server/package-lock.json")));
  if (serverLockSha256 !== expectedLockfiles.server) fail("runtime server lock differs");
  let collectorManifest;
  const packageNames = ["ccdash-collector-darwin.tar.gz", "ccdash-collector-linux.tar.gz"];
  try {
    const directory = location("app/collector-packages");
    const names = readdirSync(directory).sort();
    if (JSON.stringify(names) !== JSON.stringify([...packageNames, "manifest.json"].sort()))
      fail("unexpected collector package files");
    for (const name of names) {
      if (!lstatSync(path.join(directory, name)).isFile())
        fail("collector package must be a regular file");
    }
    collectorManifest = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8"));
    if (!/^\d+\.\d+\.\d+$/.test(collectorManifest.collectorVersion || "") ||
        JSON.stringify(Object.keys(collectorManifest.packages || {}).sort()) !== JSON.stringify(packageNames))
      fail("invalid collector package manifest");
    for (const name of packageNames) {
      const digest = collectorManifest.packages[name];
      const bytes = readFileSync(path.join(directory, name));
      if (!bytes.length || !/^[a-f0-9]{64}$/.test(digest || "") || sha256(bytes) !== digest)
        fail("collector package digest differs");
    }
  } catch (error) {
    if (error.message?.startsWith("runtime verification:")) throw error;
    fail("collector package inspection failed");
  }
  return {
    revision, uid, node: versions.node, openssl: versions.openssl, sharedOpenSSL,
    opensslPackages,
    zlibPackageVersion, nodeZlibVersion: versions.zlib ?? null,
    packageManagersAbsent: true,
    noticePackageCount: notices.packages.length,
    noticesJsonSha256: sha256(noticeJson),
    noticesTextSha256: sha256(noticeText),
    applicationLicenseSha256: sha256(license),
    serverLockSha256,
    collectorVersion: collectorManifest.collectorVersion,
    collectorPackages: collectorManifest.packages,
  };
}
