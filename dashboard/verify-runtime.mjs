import { createHash } from "node:crypto";
import { readFileSync, lstatSync, readdirSync } from "node:fs";
import path from "node:path";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// This inspector is evaluated inside the built image using Node's builtins. It
// never imports application modules, reads credentials or contacts a database.
export function verifyRuntime({
  root = "/",
  revision = process.env.APP_REVISION,
  uid = process.getuid(),
  versions = process.versions,
  expectedRevision,
  expectedLicenseSha256,
  expectedLockfiles,
} = {}) {
  const fail = (message) => { throw new Error(`runtime verification: ${message}`); };
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(expectedRevision || "") ||
      revision !== expectedRevision) fail("revision differs from committed source");
  if (uid !== 1000) fail("expected the nonroot Node user");
  if (!/^24\./.test(versions.node || "") || !versions.openssl) {
    fail("expected Node 24 and its OpenSSL version");
  }
  const location = (name) => path.join(root, name);
  const absent = (name) => {
    try { lstatSync(location(name)); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    fail(`unexpected build artifact: ${name}`);
  };
  for (const name of [
    "usr/local/lib/node_modules/npm",
    "usr/local/bin/npm", "usr/local/bin/npx", "usr/local/bin/yarn",
    "usr/local/bin/yarnpkg", "usr/local/bin/corepack",
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
  return {
    revision, uid, node: versions.node, openssl: versions.openssl,
    packageManagersAbsent: true,
    noticePackageCount: notices.packages.length,
    noticesJsonSha256: sha256(noticeJson),
    noticesTextSha256: sha256(noticeText),
    applicationLicenseSha256: sha256(license),
    serverLockSha256,
  };
}
