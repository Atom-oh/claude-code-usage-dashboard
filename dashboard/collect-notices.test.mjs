import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { collectNotices } from "./collect-notices.mjs";
import { readFileSync } from "node:fs";

test("packaged application license matches the canonical repository license", () => {
  const dashboard = path.dirname(fileURLToPath(import.meta.url));
  assert.equal(readFileSync(path.join(dashboard, "APPLICATION_LICENSE"), "utf8"),
    readFileSync(path.join(dashboard, "..", "LICENSE"), "utf8"));
});

function fixture(packages = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccdash-notices-test-"));
  for (const component of ["server", "web"]) {
    mkdirSync(path.join(root, component));
    writeFileSync(path.join(root, component, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3, packages: component === "server" ? packages : {} }));
  }
  return {
    root,
    add(location, manifest, files) {
      const target = path.join(root, "server", location);
      mkdirSync(target, { recursive: true });
      writeFileSync(path.join(target, "package.json"), JSON.stringify(manifest));
      for (const [name, text] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(target, name)), { recursive: true });
        writeFileSync(path.join(target, name), text);
      }
    },
    close() { rmSync(root, { recursive: true, force: true }); },
  };
}

test("notices retain nested license and NOTICE contents with deterministic hashes", () => {
  const f = fixture({ "node_modules/example": { version: "1.2.3" } });
  try {
    f.add("node_modules/example", { name: "example", version: "1.2.3", license: "MIT" },
      { LICENSE: "Synthetic permissive license\n", "vendor/NOTICE": "Synthetic bundled attribution\n" });
    const a = collectNotices(f.root), b = collectNotices(f.root);
    assert.deepEqual(a, b);
    assert.equal(a.report.complete, true);
    assert.equal(a.report.packages[0].files.length, 2);
    assert.equal(a.report.packages[0].files[0].sha256.length, 64);
    assert.match(a.text, /Synthetic bundled attribution/);
  } finally { f.close(); }
});

test("missing license text stays explicitly incomplete instead of fabricating permission", () => {
  const f = fixture({ "node_modules/example": { version: "1.2.3" } });
  try {
    f.add("node_modules/example", { name: "example", version: "1.2.3", license: "MIT" },
      { "README.md": "## License\nMIT\n" });
    const result = collectNotices(f.root);
    assert.equal(result.report.complete, false);
    assert.deepEqual(result.report.unresolved, [{ package: "example@1.2.3", reason: "missing_license_text" }]);
  } finally { f.close(); }
});

test("a full README license section is retained without unrelated README content", () => {
  const f = fixture({ "node_modules/example": { version: "1.2.3" } });
  try {
    f.add("node_modules/example", { name: "example", version: "1.2.3", license: "MIT" },
      { "README.md": "# Synthetic\nPrivate-example-not-for-notices\n## License\nPermission is hereby granted (synthetic test).\n## Usage\nnot-a-license\n" });
    const result = collectNotices(f.root);
    assert.equal(result.report.complete, true);
    assert.doesNotMatch(result.text, /Private-example|not-a-license/);
  } finally { f.close(); }
});

test("reviewed MIT declaration uses pinned standard text without inventing copyright", () => {
  const f = fixture({ "node_modules/express-basic-auth": { version: "1.2.1" } });
  try {
    f.add("node_modules/express-basic-auth", {
      name: "express-basic-auth", version: "1.2.1", license: "MIT",
      repository: { url: "git+https://github.com/LionC/express-basic-auth.git" },
      author: "LionC <me@lionc.de>",
    }, {});
    const result = collectNotices(f.root);
    assert.equal(result.report.complete, true);
    assert.equal(result.report.packages[0].files[0].standardLicenseText, true);
    assert.match(result.text, /Copyright \(c\) <year> <copyright holders>/);
    assert.match(result.text, /without inventing copyright owner\/year/i);
    assert.match(result.text, /Publisher metadata attribution:/);
  } finally { f.close(); }
});

test("changed publisher metadata cannot reuse a standard-license binding", () => {
  const f = fixture({ "node_modules/express-basic-auth": { version: "1.2.1" } });
  try {
    f.add("node_modules/express-basic-auth", { name: "express-basic-auth", version: "1.2.1",
      license: "MIT", repository: { url: "https://example.invalid/unrelated" }, author: "Different author" }, {});
    assert.throws(() => collectNotices(f.root), /differs from reviewed publisher/);
  } finally { f.close(); }
});

test("missing required dependencies and version drift fail; dev/absent optional packages are omitted", () => {
  for (const mismatch of [false, true]) {
    const f = fixture({ "node_modules/example": { version: "1.2.3" } });
    try {
      if (mismatch) f.add("node_modules/example", { name: "example", version: "9.9.9", license: "MIT" }, {});
      assert.throws(() => collectNotices(f.root), mismatch ? /differs/ : /not installed/);
    } finally { f.close(); }
  }
  const f = fixture({ "node_modules/dev": { version: "1.0.0", dev: true },
    "node_modules/optional": { version: "1.0.0", optional: true } });
  try { assert.equal(collectNotices(f.root).report.packages.length, 0); } finally { f.close(); }
});
