import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  REQUIRED_RUNTIME_ZLIB_VERSION, REQUIRED_RUNTIME_NODE_VERSION,
  REQUIRED_RUNTIME_OPENSSL_VERSION, REQUIRED_RUNTIME_OPENSSL_PACKAGE_VERSION, verifyRuntime,
} from "../verify-runtime.mjs";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const opensslMetadata = ["libcrypto3", "libssl3"].map(name =>
  `P:${name}\nV:${REQUIRED_RUNTIME_OPENSSL_PACKAGE_VERSION}\n\n`).join("");

function fixture(run) {
  const root = mkdtempSync(path.join(tmpdir(), "ccdash-runtime-"));
  try {
    for (const directory of ["opt", "app/notices", "app/server", "usr/local/bin", "lib/apk/db"]) {
      mkdirSync(path.join(root, directory), { recursive: true });
    }
    const license = "Synthetic fixture license.\n";
    const serverLock = '{"fixture":"server"}\n';
    const expectedLockfiles = { server: hash(serverLock), web: hash('{"fixture":"web"}\n') };
    const notices = {
      schemaVersion: 1, complete: true, unresolved: [],
      packages: [{ name: "synthetic-fixture", version: "1.0.0" }],
      lockfiles: expectedLockfiles,
    };
    writeFileSync(path.join(root, "app/APPLICATION_LICENSE"), license);
    writeFileSync(path.join(root, "app/server/package-lock.json"), serverLock);
    writeFileSync(path.join(root, "app/notices/THIRD_PARTY_NOTICES.json"), JSON.stringify(notices));
    writeFileSync(path.join(root, "app/notices/THIRD_PARTY_NOTICES.txt"), "Synthetic dependency notices.\n");
    writeFileSync(path.join(root, "lib/apk/db/installed"),
      `P:busybox\nV:synthetic\n\nP:zlib\nV:${REQUIRED_RUNTIME_ZLIB_VERSION}\nA:aarch64\n\n${opensslMetadata}`);
    const options = {
      root, uid: 1000, sharedOpenSSL: true,
      versions: { node: REQUIRED_RUNTIME_NODE_VERSION, openssl: REQUIRED_RUNTIME_OPENSSL_VERSION, zlib: "synthetic-node-zlib" },
      revision: "a".repeat(40), expectedRevision: "a".repeat(40),
      expectedLicenseSha256: hash(license), expectedLockfiles,
    };
    run({ root, options, notices });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("runtime inspection binds actual notices, license, lock and nonroot release identity", () => {
  fixture(({ options }) => {
    const result = verifyRuntime(options);
    assert.equal(result.uid, 1000);
    assert.equal(result.node, "24.22.0");
    assert.equal(result.openssl, REQUIRED_RUNTIME_OPENSSL_VERSION);
    assert.equal(result.sharedOpenSSL, true);
    assert.deepEqual(result.opensslPackages, {
      libcrypto3: REQUIRED_RUNTIME_OPENSSL_PACKAGE_VERSION,
      libssl3: REQUIRED_RUNTIME_OPENSSL_PACKAGE_VERSION,
    });
    assert.equal(result.zlibPackageVersion, REQUIRED_RUNTIME_ZLIB_VERSION);
    assert.equal(result.nodeZlibVersion, "synthetic-node-zlib");
    assert.equal(result.revision, options.expectedRevision);
    assert.equal(result.noticePackageCount, 1);
    assert.equal(result.packageManagersAbsent, true);
    assert.equal(result.applicationLicenseSha256, options.expectedLicenseSha256);
    assert.equal(result.serverLockSha256, options.expectedLockfiles.server);
    assert.match(result.noticesJsonSha256, /^[a-f0-9]{64}$/);
    assert.match(result.noticesTextSha256, /^[a-f0-9]{64}$/);
  });
});

test("runtime inspection rejects unpatched or statically linked OpenSSL", () => {
  fixture(({ options }) => {
    assert.throws(() => verifyRuntime({ ...options, sharedOpenSSL: false }), /shared OpenSSL/);
    assert.throws(() => verifyRuntime({ ...options, versions: { ...options.versions, openssl: "3.5.8" } }),
      /shared OpenSSL/);
  });
});

test("runtime inspection rejects absent, old and ambiguous OpenSSL package records", () => {
  for (const name of ["libcrypto3", "libssl3"]) {
    for (const replacement of [
      "", `P:${name}\nV:3.5.8-r0\n\n`, `P:${name}\n\n`,
      `P:${name}\nV:${REQUIRED_RUNTIME_OPENSSL_PACKAGE_VERSION}\nV:3.5.8-r0\n\n`,
      `P:${name}\nP:other\nV:${REQUIRED_RUNTIME_OPENSSL_PACKAGE_VERSION}\n\n`,
      `P:${name}\nV:${REQUIRED_RUNTIME_OPENSSL_PACKAGE_VERSION}\n\n`.repeat(2),
    ]) {
      fixture(({ root, options }) => {
        const file = path.join(root, "lib/apk/db/installed");
        writeFileSync(file, readFileSync(file, "utf8").replace(
          `P:${name}\nV:${REQUIRED_RUNTIME_OPENSSL_PACKAGE_VERSION}\n\n`, replacement));
        assert.throws(() => verifyRuntime(options), new RegExp(`OS ${name}`));
      });
    }
  }
});

test("runtime Dockerfile pin agrees with actual-image OS zlib verification", () => {
  const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  const runtime = dockerfile.split("FROM server-deps AS runtime\n")[1];
  assert.ok(runtime?.includes(`apk add --no-cache 'zlib=${REQUIRED_RUNTIME_ZLIB_VERSION}'`));
  assert.ok(!runtime.includes("--allow-untrusted"));
});

test("Node source build and OpenSSL pins agree with the runtime inspector", () => {
  const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.ok(dockerfile.includes(`https://nodejs.org/dist/v${REQUIRED_RUNTIME_NODE_VERSION}/node-v${REQUIRED_RUNTIME_NODE_VERSION}.tar.xz`));
  assert.ok(dockerfile.includes("./configure --shared-openssl --without-npm"));
  for (const name of ["openssl-dev", "libcrypto3", "libssl3"])
    assert.ok(dockerfile.includes(`'${name}=${REQUIRED_RUNTIME_OPENSSL_PACKAGE_VERSION}'`));
  assert.ok(dockerfile.includes("sha256sum -c -"));
  assert.ok(!dockerfile.includes("--allow-untrusted"));
});

test("runtime inspection rejects a missing OS package database or zlib record", () => {
  fixture(({ root, options }) => {
    rmSync(path.join(root, "lib/apk/db/installed"));
    assert.throws(() => verifyRuntime(options), /OS package database is missing/);
  });
  for (const metadata of ["", "P:busybox\nV:synthetic\n\n", "P:zlib-ng\nV:synthetic\n\n"]) {
    fixture(({ root, options }) => {
      writeFileSync(path.join(root, "lib/apk/db/installed"), metadata);
      assert.throws(() => verifyRuntime(options), /one installed OS zlib package/);
    });
  }
});

test("runtime inspection rejects old, missing, duplicate or malformed OS zlib versions", () => {
  for (const metadata of [
    "P:zlib\nV:1.3.2-r0\n\n",
    "P:zlib\n\n",
    `P:zlib\nV:${REQUIRED_RUNTIME_ZLIB_VERSION}\nV:${REQUIRED_RUNTIME_ZLIB_VERSION}\n\n`,
    `P:zlib\nP:zlib\nV:${REQUIRED_RUNTIME_ZLIB_VERSION}\n\n`,
    `P:zlib\nP:other\nV:${REQUIRED_RUNTIME_ZLIB_VERSION}\n\n`,
    `P:zlib\nV:${REQUIRED_RUNTIME_ZLIB_VERSION}\n\nP:zlib\nV:${REQUIRED_RUNTIME_ZLIB_VERSION}\n\n`,
    `P:zlib\nV:${REQUIRED_RUNTIME_ZLIB_VERSION} \n\n`,
  ]) {
    fixture(({ root, options }) => {
      writeFileSync(path.join(root, "lib/apk/db/installed"), metadata);
      assert.throws(() => verifyRuntime(options), /(?:OS zlib|one installed OS zlib package)/);
    });
  }
});

test("runtime inspection accepts APK CRLF metadata and keeps Node zlib separate", () => {
  fixture(({ root, options }) => {
    writeFileSync(path.join(root, "lib/apk/db/installed"),
      (`P:busybox\nV:synthetic\n\nP:zlib\nV:${REQUIRED_RUNTIME_ZLIB_VERSION}\n\n${opensslMetadata}`).replaceAll("\n", "\r\n"));
    const result = verifyRuntime({ ...options, versions: {
      node: REQUIRED_RUNTIME_NODE_VERSION, openssl: REQUIRED_RUNTIME_OPENSSL_VERSION,
    } });
    assert.equal(result.zlibPackageVersion, REQUIRED_RUNTIME_ZLIB_VERSION);
    assert.equal(result.nodeZlibVersion, null);
  });
});

test("runtime inspection rejects root, unsupported Node and missing release identity", () => {
  fixture(({ options }) => {
    assert.throws(() => verifyRuntime({ ...options, uid: 0 }), /nonroot/);
    assert.throws(() => verifyRuntime({ ...options, versions: { node: "22.0.0", openssl: "x" } }), /Node 24/);
    assert.throws(() => verifyRuntime({ ...options, versions: { node: "24.22.0" } }), /OpenSSL/);
    assert.throws(() => verifyRuntime({ ...options, revision: undefined }), /revision/);
    assert.throws(() => verifyRuntime({ ...options, expectedRevision: "short" }), /revision/);
  });
});

test("runtime inspection detects broken package-manager symlinks, Corepack and Yarn directories", () => {
  fixture(({ root, options }) => {
    const npm = path.join(root, "usr/local/bin/npm");
    symlinkSync("/synthetic/missing/npm", npm);
    assert.throws(() => verifyRuntime(options), /unexpected build artifact/);
    rmSync(npm);
    const corepack = path.join(root, "usr/local/lib/node_modules/corepack");
    mkdirSync(corepack, { recursive: true });
    assert.throws(() => verifyRuntime(options), /unexpected build artifact/);
    rmSync(corepack, { recursive: true });
    mkdirSync(path.join(root, "opt/yarn-v1.22.22"));
    assert.throws(() => verifyRuntime(options), /Yarn installation/);
  });
});

test("runtime inspection rejects frontend modules and build collectors", () => {
  for (const filename of ["app/web/node_modules", "app/collect-notices.mjs", "app/verify-runtime.mjs",
    "usr/local/include/node"]) {
    fixture(({ root, options }) => {
      mkdirSync(path.dirname(path.join(root, filename)), { recursive: true });
      writeFileSync(path.join(root, filename), "synthetic build artifact");
      assert.throws(() => verifyRuntime(options), /unexpected build artifact/);
    });
  }
});

test("runtime inspection rejects different application terms and missing license hash", () => {
  fixture(({ root, options }) => {
    assert.throws(() => verifyRuntime({ ...options, expectedLicenseSha256: undefined }), /license differs/);
    writeFileSync(path.join(root, "app/APPLICATION_LICENSE"), "Different synthetic terms.");
    assert.throws(() => verifyRuntime(options), /license differs/);
  });
});

test("runtime inspection rejects incomplete, unresolved or empty distribution notices", () => {
  for (const change of [{ complete: false }, { unresolved: ["synthetic"] }, { packages: [] }]) {
    fixture(({ root, options, notices }) => {
      writeFileSync(path.join(root, "app/notices/THIRD_PARTY_NOTICES.json"),
        JSON.stringify({ ...notices, ...change }));
      assert.throws(() => verifyRuntime(options), /notices are incomplete/);
    });
  }
  fixture(({ root, options }) => {
    writeFileSync(path.join(root, "app/notices/THIRD_PARTY_NOTICES.txt"), " \n");
    assert.throws(() => verifyRuntime(options), /notices are incomplete/);
  });
});

test("runtime inspection rejects notices or installed locks from another source", () => {
  for (const component of ["server", "web"]) {
    fixture(({ root, options, notices }) => {
      writeFileSync(path.join(root, "app/notices/THIRD_PARTY_NOTICES.json"), JSON.stringify({
        ...notices, lockfiles: { ...notices.lockfiles, [component]: "b".repeat(64) },
      }));
      assert.throws(() => verifyRuntime(options), /notices lock differs/);
    });
  }
  fixture(({ root, options }) => {
    writeFileSync(path.join(root, "app/server/package-lock.json"), '{"different":"fixture"}');
    assert.throws(() => verifyRuntime(options), /runtime server lock differs/);
  });
});
