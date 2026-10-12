import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import * as oidc from "openid-client";
import { generateKeyPairSync, randomBytes, createHash, sign } from "node:crypto";
import { createAuthentication, createSessionCodec, parseAuthConfig } from "./auth.js";
import { createRateLimiter } from "./rateLimit.js";

const issuer = "https://identity.example.invalid/";
const origin = "https://dashboard.example.invalid";
const secret = randomBytes(32).toString("base64url");
const env = { AUTH_MODE: "oidc", OIDC_ISSUER: issuer, APP_PUBLIC_URL: origin,
  OIDC_CLIENT_ID: "fixture-client", OIDC_CLIENT_SECRET: "test-only-client-secret",
  SESSION_SECRET: secret, OIDC_ROLE_GROUPS: JSON.stringify({
    viewer: ["dashboard-viewers"], analyst: ["dashboard-analysts"], admin: ["dashboard-admins"],
  }) };
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const wrongKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicKey = { ...keys.publicKey.export({ format: "jwk" }), kid: "fixture-key", use: "sig", alg: "RS256" };
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json" },
});

function idToken(claims, badSignature = false) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = encode({ alg: "RS256", kid: "fixture-key" }) + "." + encode(claims);
  return input + "." + sign("RSA-SHA256", Buffer.from(input), badSignature ? wrongKeys.privateKey : keys.privateKey).toString("base64url");
}

async function fixture(t, options = {}) {
  const events = [];
  const codes = new Map();
  const tokenRequests = [];
  let consumed = 0;
  const configEnv = { ...env, ...options.env };
  const transport = async (url, request = {}) => {
    const path = new URL(url).pathname;
    if (path === "/.well-known/openid-configuration") return json({
      issuer, authorization_endpoint: issuer + "authorize", token_endpoint: issuer + "token",
      jwks_uri: issuer + "keys", response_types_supported: ["code"], subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"], token_endpoint_auth_methods_supported: ["client_secret_post"],
      code_challenge_methods_supported: ["S256"],
    });
    if (path === "/keys") return json({ keys: [publicKey] });
    if (path === "/token") {
      const body = new URLSearchParams(request.body);
      tokenRequests.push(Object.fromEntries(body));
      const code = codes.get(body.get("code"));
      codes.delete(body.get("code"));
      if (!code || createHash("sha256").update(body.get("code_verifier") || "").digest("base64url") !== code.challenge
        || body.get("redirect_uri") !== origin + "/auth/callback"
        || body.get("client_secret") !== configEnv.OIDC_CLIENT_SECRET) return json({ error: "invalid_grant" }, 400);
      consumed++;
      const now = Math.floor(Date.now() / 1000);
      return json({ token_type: "Bearer", access_token: "synthetic-access-token", expires_in: 600,
        id_token: idToken({ iss: issuer, aud: configEnv.OIDC_CLIENT_ID, sub: "fixture-subject",
          name: "Fixture Analyst", iat: now, exp: now + 600, nonce: code.nonce,
          groups: ["dashboard-analysts"], ...options.claims }, options.badSignature) });
    }
    throw new Error("Unexpected fixture endpoint");
  };
  const authentication = createAuthentication({
    env: configEnv, now: options.now, audit: entry => events.push(entry),
    discoverClient: options.discoverClient || (config => oidc.discovery(new URL(config.issuer),
      config.clientId, { client_secret: config.clientSecret }, oidc.ClientSecretPost(config.clientSecret),
      { execute: [oidc.enableNonRepudiationChecks], [oidc.customFetch]: transport })),
  });
  const app = express();
  app.set("trust proxy", 1);
  app.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  authentication.installRoutes(app);
  app.use(authentication.middleware);
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.get("/readyz", (_req, res) => res.json({ ready: true }));
  app.get("/api/session", (req, res) => res.json(authentication.sessionInfo(req)));
  app.get("/api/data", authentication.requirePermission("telemetry:read"), (_req, res) => res.json({ rows: 1 }));
  app.post("/api/chat", authentication.requirePermission("chat:query"), (_req, res) => res.json({ queried: true }));
  app.get("/asset.js", (_req, res) => res.type("js").send("private fixture asset"));
  app.get("/", (_req, res) => res.send("private dashboard"));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = "http://127.0.0.1:" + server.address().port;
  const request = (path, init = {}) => fetch(base + path, { redirect: "manual", ...init });
  async function login(returnTo = "/cost?client=codex") {
    const start = await request("/auth/login?returnTo=" + encodeURIComponent(returnTo));
    assert.equal(start.status, 302);
    const authorization = new URL(start.headers.get("location"));
    const code = "fixture-code-" + authorization.searchParams.get("state");
    codes.set(code, { challenge: authorization.searchParams.get("code_challenge"), nonce: authorization.searchParams.get("nonce") });
    const cookie = start.headers.getSetCookie()[0].split(";")[0];
    const callback = "/auth/callback?code=" + code + "&state=" + authorization.searchParams.get("state");
    return { start, cookie, callback, authorization };
  }
  async function complete(returnTo) {
    const flow = await login(returnTo);
    const response = await request(flow.callback, { headers: { cookie: flow.cookie,
      host: "attacker.example.invalid", "x-forwarded-host": "attacker.example.invalid" } });
    const session = response.headers.getSetCookie().find(cookie => cookie.startsWith("__Host-ccdash-session="))?.split(";")[0];
    return { ...flow, response, session };
  }
  return { request, login, complete, events, tokenRequests, get consumed() { return consumed; } };
}

test("authentication configuration is explicit and fails closed", () => {
  assert.throws(() => parseAuthConfig({}), /BASIC_AUTH_USER/);
  assert.throws(() => parseAuthConfig({ AUTH_MODE: "unknown", AUTH_ALLOW_INSECURE: "1" }), /AUTH_MODE/);
  assert.throws(() => parseAuthConfig({ BASIC_AUTH_USER: "partial", AUTH_ALLOW_INSECURE: "1" }), /together/);
  assert.throws(() => parseAuthConfig({ BASIC_AUTH_USER: "fixture", BASIC_AUTH_PASSWORD: "fixture", OIDC_ISSUER: issuer }), /AUTH_MODE/);
  assert.equal(parseAuthConfig({ AUTH_ALLOW_INSECURE: "1" }).enabled, false);
  assert.equal(parseAuthConfig({ BASIC_AUTH_USER: "fixture", BASIC_AUTH_PASSWORD: "fixture" }).enabled, true);
  for (const override of [
    { OIDC_ISSUER: "http://identity.example.invalid" }, { APP_PUBLIC_URL: origin + "/path" },
    { OIDC_CLIENT_SECRET: "" }, { SESSION_SECRET: "short" }, { SESSION_MAX_AGE_SECONDS: "0" },
    { OIDC_ROLE_GROUPS: '{"viewer":["*"],"owner":["admins"]}' }, { OIDC_ROLE_GROUPS: '{"viewer":[]}' },
    { OIDC_ROLE_GROUPS: "{}" }, { OIDC_ROLE_GROUPS: "[]" }, { OIDC_GROUPS_CLAIM: "nested.groups" },
  ]) assert.throws(() => parseAuthConfig({ ...env, ...override, AUTH_ALLOW_INSECURE: "1" }));
  assert.equal(parseAuthConfig({ ...env, OIDC_ISSUER: issuer + "realm/" }).issuer, issuer + "realm/");
  assert.equal(parseAuthConfig({ ...env, OIDC_GROUPS_CLAIM: "cognito:groups" }).claim, "cognito:groups");
});

test("encrypted sessions reject tampering, wrong purpose, another installation and expiration", () => {
  let time = Date.now();
  const config = parseAuthConfig(env);
  const codec = createSessionCodec(config, () => time);
  const payload = { subject: "fixture-subject", role: "viewer", exp: Math.floor(time / 1000) + 900 };
  const token = codec.seal(payload, "session");
  assert.deepEqual(codec.open(token, "session"), payload);
  assert.ok(!token.includes("fixture-subject"));
  const parts = token.split("."); parts[2] = (parts[2][0] === "a" ? "b" : "a") + parts[2].slice(1);
  assert.equal(codec.open(parts.join("."), "session"), null);
  assert.equal(codec.open(token, "login"), null);
  assert.equal(createSessionCodec({ ...config, origin: "https://another.example.invalid" }).open(token, "session"), null);
  assert.equal(createSessionCodec({ ...config, key: randomBytes(32) }).open(token, "session"), null);
  assert.equal(codec.open("v1.bad.bad.bad", "session"), null);
  time += 901_000;
  assert.equal(codec.open(token, "session"), null);
});

test("OIDC protects APIs and static files while health probes remain unauthenticated", async t => {
  const f = await fixture(t);
  for (const path of ["/healthz", "/readyz"]) assert.equal((await f.request(path)).status, 200);
  for (const path of ["/api/data", "/api/session", "/api/health/data"]) {
    const response = await f.request(path, { headers: { authorization: "Basic Zml4dHVyZTpmaXh0dXJl" } });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json()).error, "authentication_required");
  }
  const response = await f.request("/asset.js");
  assert.equal(response.status, 401);
  assert.ok(!(await response.text()).includes("private fixture asset"));
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
});

test("real OIDC library validates a signed code flow with PKCE, state and nonce", async t => {
  const f = await fixture(t);
  const { response, session, authorization } = await f.complete();
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorization.searchParams.get("response_type"), "code");
  assert.equal(authorization.searchParams.get("redirect_uri"), origin + "/auth/callback");
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/cost?client=codex");
  assert.ok(session);
  const cookie = response.headers.getSetCookie().find(value => value.startsWith("__Host-ccdash-session="));
  assert.match(cookie, /Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=\d+/);
  const ttl = Number(cookie.match(/Max-Age=(\d+)/)[1]);
  assert.ok(ttl > 0 && ttl <= 600);
  const profile = await f.request("/api/session", { headers: { cookie: session } });
  assert.equal(profile.status, 200);
  const body = await profile.json();
  assert.equal(body.role, "analyst");
  assert.deepEqual(body.permissions, ["telemetry:read", "chat:query"]);
  assert.ok(!JSON.stringify(body).includes("fixture-subject"));
  assert.equal((await f.request("/api/chat", { method: "POST", headers: { cookie: session, origin } })).status, 200);
  assert.equal(f.consumed, 1);
  assert.ok(f.events.some(event => event.event === "login.access" && event.outcome === "granted"));
  assert.ok(!JSON.stringify(f.events).includes("fixture-subject"));
  assert.ok(!JSON.stringify(f.events).includes("test-only-client-secret"));
});

test("viewer access cannot run SQL chat; highest explicitly mapped group wins", async t => {
  const f = await fixture(t, { claims: { groups: ["dashboard-viewers"] } });
  const { session } = await f.complete();
  assert.equal((await f.request("/api/data", { headers: { cookie: session } })).status, 200);
  assert.equal((await f.request("/api/chat", { method: "POST", headers: { cookie: session, origin } })).status, 403);
  assert.ok(f.events.some(event => event.event === "permission.chat:query" && event.outcome === "denied"));
  const admin = await fixture(t, { claims: { groups: ["dashboard-viewers", "dashboard-admins"] } });
  const logged = await admin.complete();
  const profile = await admin.request("/api/session", { headers: { cookie: logged.session } });
  assert.equal((await profile.json()).role, "admin");
});

test("valid identity without an authorized group is denied, not defaulted to viewer", async t => {
  for (const groups of [undefined, [], ["unrelated-group"], "dashboard-viewers"]) {
    const f = await fixture(t, { claims: { groups } });
    const { response, session } = await f.complete();
    assert.equal(response.status, 403);
    assert.equal(session, "__Host-ccdash-session=");
    assert.ok(f.events.some(event => event.event === "login.access" && event.outcome === "denied"));
  }
});

test("signature, issuer, audience and nonce mismatches never create a session", async t => {
  for (const options of [
    { badSignature: true }, { claims: { iss: "https://wrong.example.invalid/" } },
    { claims: { aud: "another-client" } }, { claims: { nonce: "wrong-nonce" } },
  ]) {
    const f = await fixture(t, options);
    const { response, session } = await f.complete();
    assert.equal(response.status, 400);
    assert.equal(session, undefined);
  }
});

test("missing/mismatched state and duplicate cookies fail before token exchange", async t => {
  const f = await fixture(t);
  const flow = await f.login();
  const bad = new URL(flow.callback, origin); bad.searchParams.set("state", "forged");
  assert.equal((await f.request(bad.pathname + bad.search, { headers: { cookie: flow.cookie } })).status, 400);
  assert.equal((await f.request(flow.callback)).status, 400);
  assert.equal((await f.request(flow.callback, { headers: { cookie: flow.cookie + "; " + flow.cookie } })).status, 400);
  assert.equal(f.tokenRequests.length, 0);
});

test("authorization codes are consumed once and return paths cannot escape installation", async t => {
  const f = await fixture(t);
  for (const target of ["https://evil.example.invalid", "//evil.example.invalid", "/\\evil.example.invalid", "/..//evil.example.invalid", "/auth/logout", "/AUTH/logout"]) {
    const flow = await f.complete(target);
    assert.equal(flow.response.status, 303);
    assert.equal(flow.response.headers.get("location"), "/");
    const replay = await f.request(flow.callback, { headers: { cookie: flow.cookie } });
    assert.equal(replay.status, 400);
  }
});

test("unsafe session requests and logout require the exact configured origin", async t => {
  const f = await fixture(t);
  const { session } = await f.complete();
  for (const requestOrigin of [undefined, "https://attacker.example.invalid", origin + ".attacker.invalid", "null"]) {
    for (const path of ["/api/chat", "/auth/logout"]) {
      const headers = { cookie: session };
      if (requestOrigin) headers.origin = requestOrigin;
      const response = await f.request(path, { method: "POST", headers });
      assert.equal(response.status, 403);
      assert.equal(response.headers.getSetCookie().length, 0);
    }
  }
  const logout = await f.request("/auth/logout", { method: "POST", headers: { cookie: session, origin } });
  assert.equal(logout.status, 303);
  assert.ok(logout.headers.getSetCookie().every(value => value.includes("Max-Age=0")));
  assert.equal((await f.request("/api/data")).status, 401);
});

test("identity-provider failure is generic, bounded and never falls back to Basic Auth", async t => {
  let attempts = 0;
  const f = await fixture(t, { env: { BASIC_AUTH_USER: "legacy", BASIC_AUTH_PASSWORD: "legacy" },
    discoverClient: async () => { attempts++; throw new Error("private identity provider error"); } });
  for (let i = 0; i < 3; i++) {
    const response = await f.request("/auth/login");
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes("private identity provider error"));
  }
  assert.equal(attempts, 1);
  assert.ok(f.events.some(event => event.failure?.stage === "discovery"));
  assert.equal((await f.request("/api/data", { headers: { authorization: "Basic bGVnYWN5OmxlZ2FjeQ==" } })).status, 401);
});

test("bounded admission limiter rejects active buckets and releases expired capacity", () => {
  let time = 100;
  const limit = createRateLimiter({ max: 2, capacity: 2, windowMs: 1000, now: () => time });
  const result = ip => {
    const response = { code: 200, headers: {}, set(name, value) { this.headers[name] = value; },
      status(code) { this.code = code; return this; }, json(value) { this.body = value; } };
    limit({ ip }, response, () => { response.allowed = true; });
    return response;
  };
  assert.ok(result("one").allowed); assert.ok(result("one").allowed);
  assert.equal(result("one").code, 429);
  assert.ok(result("two").allowed);
  assert.equal(result("three").code, 429);
  time += 1001;
  assert.ok(result("three").allowed);
  assert.ok(result("one").allowed);
});
