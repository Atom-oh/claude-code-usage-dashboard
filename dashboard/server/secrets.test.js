import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSecret } from "./secrets.js";
import { parseAuthConfig } from "./auth.js";

test("secret files preserve exact contents and reject ambiguous or unsafe input", t => {
  const dir = mkdtempSync(join(tmpdir(), "ccdash-secrets-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "secret");
  writeFileSync(file, " value \n");
  assert.equal(readSecret({ SECRET: "legacy" }, "SECRET"), "legacy");
  assert.equal(readSecret({ SECRET_FILE: file }, "SECRET"), " value \n");
  writeFileSync(file, "\ufeffvalue");
  assert.equal(readSecret({ SECRET_FILE: file }, "SECRET"), "\ufeffvalue");
  assert.throws(() => readSecret({ SECRET: "legacy", SECRET_FILE: file }, "SECRET"), /SECRET/);
  assert.throws(() => readSecret({ SECRET_FILE: join(dir, "missing") }, "SECRET"), /SECRET/);
  assert.throws(() => readSecret({ SECRET_FILE: dir }, "SECRET"), /SECRET/);
  writeFileSync(file, "x".repeat(65537));
  assert.throws(() => readSecret({ SECRET_FILE: file }, "SECRET"), /SECRET/);
  writeFileSync(file, "");
  assert.throws(() => readSecret({ SECRET_FILE: file }, "SECRET"), /SECRET/);
});

test("basic and OIDC configuration accept file-backed credentials", t => {
  const dir = mkdtempSync(join(tmpdir(), "ccdash-auth-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const user = join(dir, "user"), pass = join(dir, "pass"), key = join(dir, "key");
  writeFileSync(user, "fixture-user");
  writeFileSync(pass, "fixture-secret");
  writeFileSync(key, Buffer.alloc(32, 7).toString("base64url"));
  const basic = parseAuthConfig({ BASIC_AUTH_USER_FILE: user, BASIC_AUTH_PASSWORD_FILE: pass });
  assert.equal(basic.user, "fixture-user");
  assert.equal(basic.password, "fixture-secret");
  const oidc = parseAuthConfig({ AUTH_MODE: "oidc", OIDC_ISSUER: "https://identity.example.invalid/",
    APP_PUBLIC_URL: "https://dashboard.example.invalid", OIDC_CLIENT_ID: "client",
    OIDC_CLIENT_SECRET_FILE: pass, SESSION_SECRET_FILE: key, OIDC_ROLE_GROUPS: '{"viewer":["readers"]}' });
  assert.equal(oidc.clientSecret, "fixture-secret");
  assert.deepEqual(oidc.key, Buffer.alloc(32, 7));
  assert.throws(() => parseAuthConfig({ SESSION_SECRET_FILE: key }), /AUTH_MODE/);
  assert.throws(() => parseAuthConfig({ BASIC_AUTH_USER: "a", BASIC_AUTH_USER_FILE: user,
    BASIC_AUTH_PASSWORD_FILE: pass }), /BASIC_AUTH_USER/);
});
