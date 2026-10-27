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
  const revocations = [];
  let consumed = 0;
  const configEnv = { ...env, ...options.env };
  const originalFetch = globalThis.fetch;
  const clientBasicMatches = request => {
    const header = new Headers(request.headers).get("authorization") || "";
    if (!header.startsWith("Basic ")) return false;
    const credentials = Buffer.from(header.slice(6), "base64").toString().split(":")
      .map(value => decodeURIComponent(value.replace(/\+/g, " ")));
    return credentials.length === 2 && credentials[0] === configEnv.OIDC_CLIENT_ID
      && credentials[1] === configEnv.OIDC_CLIENT_SECRET;
  };
  const transport = async (url, request = {}) => {
    if (new URL(url).protocol === "http:") return originalFetch(url, request);
    const path = new URL(url).pathname;
    if (path === "/.well-known/openid-configuration") return json({
      issuer, authorization_endpoint: issuer + "authorize", token_endpoint: issuer + "token",
      jwks_uri: issuer + "keys", response_types_supported: ["code"], subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"], token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
      code_challenge_methods_supported: ["S256"],
      ...(!options.noRevocation ? { revocation_endpoint: issuer + "revoke" } : {}),
    });
    if (path === "/keys") return json({ keys: [publicKey] });
    if (path === "/token") {
      const body = new URLSearchParams(request.body);
      tokenRequests.push(Object.fromEntries(body));
      const authorizedClient = options.defaultDiscovery ? clientBasicMatches(request)
        : body.get("client_secret") === configEnv.OIDC_CLIENT_SECRET;
      if (!authorizedClient) return json({ error: "invalid_client" }, 401);
      if (body.get("grant_type") === "refresh_token") {
        if (options.refreshWait) await options.refreshWait();
        if (options.refreshError) return json({ error: options.refreshError }, options.refreshStatus || 400);
        const now = Math.floor((options.now || Date.now)() / 1000);
        return json({ token_type: "Bearer", access_token: "synthetic-renewed-access-token", expires_in: 600,
          ...(options.rotatedToken ? { refresh_token: options.rotatedToken } : {}),
          id_token: idToken({ iss: issuer, aud: configEnv.OIDC_CLIENT_ID, sub: "fixture-subject",
            name: "Renewed Fixture", iat: now, exp: now + 600,
            groups: ["dashboard-analysts"], ...options.refreshClaims }, options.refreshBadSignature) });
      }
      const code = codes.get(body.get("code"));
      codes.delete(body.get("code"));
      if (!code || createHash("sha256").update(body.get("code_verifier") || "").digest("base64url") !== code.challenge
        || body.get("redirect_uri") !== origin + "/auth/callback") return json({ error: "invalid_grant" }, 400);
      consumed++;
      const now = Math.floor(Date.now() / 1000);
      return json({ token_type: "Bearer", access_token: "synthetic-access-token", expires_in: 600,
        ...(options.refreshToken !== undefined ? { refresh_token: options.refreshToken } : {}),
        id_token: idToken({ iss: issuer, aud: configEnv.OIDC_CLIENT_ID, sub: "fixture-subject",
          name: "Fixture Analyst", iat: now, exp: now + 600, nonce: code.nonce,
          groups: ["dashboard-analysts"], ...options.claims }, options.badSignature) });
    }
    if (path === "/revoke") {
      const body = new URLSearchParams(request.body);
      revocations.push(Object.fromEntries(body));
      if (options.defaultDiscovery && !clientBasicMatches(request)) return json({ error: "invalid_client" }, 401);
      if (options.revocationWait) await options.revocationWait();
      return options.revocationError ? json({ error: "temporarily_unavailable" }, 503) : new Response(null);
    }
    throw new Error("Unexpected fixture endpoint");
  };
  if (options.defaultDiscovery) {
    globalThis.fetch = transport;
    t.after(() => { globalThis.fetch = originalFetch; });
  }
  const authentication = createAuthentication({
    env: configEnv, now: options.now, audit: entry => events.push(entry),
    discoverClient: options.defaultDiscovery ? undefined : options.discoverClient || (config => oidc.discovery(new URL(config.issuer),
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
  app.post("/api/collector/access", authentication.requirePermission("collector:manage"), (_req, res) => res.json({ allowed: true }));
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
    const cookies = response.headers.getSetCookie().filter(value => !value.includes("Max-Age=0")).map(value => value.split(";")[0]).join("; ");
    return { ...flow, response, session, cookies };
  }
  return { request, login, complete, events, tokenRequests, revocations, get consumed() { return consumed; } };
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
  assert.deepEqual(body.permissions, ["telemetry:read", "chat:query", "collector:manage"]);
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

test("collector management uses signed generic roles and keeps unsafe origin checks", async t => {
  for (const [group, allowed] of [["dashboard-viewers", false], ["dashboard-analysts", true], ["dashboard-admins", true]]) {
    const f = await fixture(t, { claims: { groups: [group] } });
    const { session } = await f.complete();
    const profile = await (await f.request("/api/session", { headers: { cookie: session } })).json();
    assert.equal(profile.permissions.includes("collector:manage"), allowed);
    assert.equal((await f.request("/api/collector/access", {
      method: "POST", headers: { cookie: session, origin },
    })).status, allowed ? 200 : 403);
    for (const headers of [{ cookie: session }, { cookie: session, origin: "https://untrusted.example.invalid" }]) {
      assert.equal((await f.request("/api/collector/access", { method: "POST", headers })).status, 403);
    }
  }
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

test("configured scopes reach authorization URLs and require a bounded OIDC scope set", async t => {
  const f = await fixture(t, { env: { OIDC_SCOPES: "openid profile email groups offline_access" } });
  const flow = await f.login();
  assert.equal(flow.authorization.searchParams.get("scope"), "openid profile email groups offline_access");
  assert.equal(parseAuthConfig(env).scopes, "openid profile");
  for (const scopes of ["", "profile", "openid  profile", " openid", "openid ", "openid\nprofile", 'openid "profile', "openid \\profile", "openid " + "x".repeat(512)]) {
    assert.throws(() => parseAuthConfig({ ...env, OIDC_SCOPES: scopes }), /OIDC_SCOPES/);
  }
});

const refreshEnv = { SESSION_REFRESH_MAX_AGE_SECONDS: "2592000" };
const refreshToken = "synthetic-private-refresh-token";
function refreshCookies(config, now, overrides = {}) {
  const time = Math.floor(now / 1000);
  const token = createSessionCodec(parseAuthConfig({ ...env, ...refreshEnv, ...config }), () => now)
    .seal({ token: refreshToken, subject: "fixture-subject", iat: time, exp: time + 2592000, ...overrides }, "refresh");
  const mid = Math.ceil(token.length / 2);
  return `__Host-ccdash-refresh-0=${token.slice(0, mid)}; __Host-ccdash-refresh-1=${token.slice(mid)}`;
}
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

function applyResponseCookies(cookies, response) {
  const jar = new Map(cookies.split("; ").filter(Boolean).map(cookie => {
    const separator = cookie.indexOf("=");
    return [cookie.slice(0, separator), cookie.slice(separator + 1)];
  }));
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(";");
    const separator = pair.indexOf("=");
    const name = pair.slice(0, separator);
    if (/(?:^|; )Max-Age=0(?:;|$)/.test(cookie)) jar.delete(name);
    else jar.set(name, pair.slice(separator + 1));
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

for (const failure of ["missing transaction", "invalid transaction", "mismatched state"]) {
  test(`failed callback with ${failure} preserves an existing persistent login`, async t => {
    let time = Date.now();
    const f = await fixture(t, { env: refreshEnv, now: () => time, refreshToken });
    const logged = await f.complete();
    assert.equal(logged.response.status, 303);
    const flow = await f.login();
    const callback = new URL(flow.callback, origin);
    if (failure === "mismatched state") callback.searchParams.set("state", "forged");
    const transaction = failure === "missing transaction" ? ""
      : failure === "invalid transaction" ? "__Host-ccdash-login=invalid" : flow.cookie;
    const cookies = [logged.cookies, transaction].filter(Boolean).join("; ");
    const response = await f.request(callback.pathname + callback.search, { headers: { cookie: cookies } });
    assert.equal(response.status, 400);
    assert.equal(f.consumed, 1, "the invalid callback must not exchange another code");
    const retainedCookies = applyResponseCookies(cookies, response);
    time += 650_000;
    const renewed = await f.request("/api/session", { headers: { cookie: retainedCookies } });
    assert.equal(renewed.status, 200, "the prior refresh credentials must survive the rejected callback");
    const profile = await renewed.json();
    assert.equal(profile.role, "analyst");
    assert.ok(Date.parse(profile.expiresAt) > time);
    assert.ok(Date.parse(profile.refreshExpiresAt) > time);
    assert.equal(response.headers.getSetCookie().filter(cookie =>
      cookie.startsWith("__Host-ccdash-session=") || cookie.startsWith("__Host-ccdash-refresh-")).length, 0);
  });
}

test("callback with a verified unauthorized identity clears the existing persistent login", async t => {
  const original = await fixture(t, { env: refreshEnv, refreshToken });
  const logged = await original.complete();
  assert.equal(logged.response.status, 303);
  const denied = await fixture(t, { env: refreshEnv, refreshToken, claims: { groups: ["unrelated-group"] } });
  const flow = await denied.login();
  const cookies = logged.cookies + "; " + flow.cookie;
  const response = await denied.request(flow.callback, { headers: { cookie: cookies } });
  assert.equal(response.status, 403);
  assert.equal(denied.consumed, 1);
  for (const name of ["__Host-ccdash-session", "__Host-ccdash-refresh-0", "__Host-ccdash-refresh-1"]) {
    assert.ok(response.headers.getSetCookie().some(cookie => cookie.startsWith(name + "=") && cookie.includes("Max-Age=0")));
  }
  const clearedCookies = applyResponseCookies(cookies, response);
  assert.equal((await original.request("/api/session", { headers: { cookie: clearedCookies } })).status, 401);
  assert.ok(denied.events.some(event => event.event === "login.access" && event.outcome === "denied"));
});

test("persistent login retains encrypted split refresh cookies and exposes only expiry metadata", async t => {
  const f = await fixture(t, { env: refreshEnv, refreshToken });
  const { response, cookies } = await f.complete();
  assert.equal(response.status, 303);
  const retained = response.headers.getSetCookie().filter(value => value.startsWith("__Host-ccdash-refresh-"));
  assert.equal(retained.length, 2);
  for (const cookie of retained) {
    assert.match(cookie, /Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/);
    assert.ok(cookie.split(";")[0].length < 3100);
    assert.ok(!cookie.includes(refreshToken));
  }
  const profile = await f.request("/api/session", { headers: { cookie: cookies } });
  const body = await profile.json();
  assert.ok(Date.parse(body.refreshExpiresAt) > Date.now() + 2591990_000);
  assert.equal(body.role, "analyst");
  assert.ok(!JSON.stringify(body).includes("token"));
  assert.ok(!JSON.stringify(f.events).includes(refreshToken));
});

test("refresh config bounds and missing provider capability/token fail closed", async t => {
  for (const age of ["1", "3599", "2592001", "1.5", "NaN", "-1"]) {
    assert.throws(() => parseAuthConfig({ ...env, SESSION_REFRESH_MAX_AGE_SECONDS: age }), /SESSION_REFRESH/);
  }
  const unsupported = await fixture(t, { env: refreshEnv, noRevocation: true });
  assert.equal((await unsupported.request("/auth/login")).status, 503);
  for (const token of [undefined, "", "x".repeat(4097)]) {
    const f = await fixture(t, { env: refreshEnv, refreshToken: token });
    const { response, session } = await f.complete();
    assert.equal(response.status, 400);
    assert.equal(session, undefined);
  }
});

test("renewal validates signed identity and refreshes groups without extending the absolute deadline", async t => {
  let time = Date.now();
  const f = await fixture(t, { env: refreshEnv, now: () => time, refreshToken,
    refreshClaims: { groups: ["dashboard-viewers"] } });
  const logged = await f.complete();
  const before = await (await f.request("/api/session", { headers: { cookie: logged.cookies } })).json();
  time += 550_000;
  const response = await f.request("/api/session", { headers: { cookie: logged.cookies } });
  assert.equal(response.status, 200);
  const after = await response.json();
  assert.equal(after.role, "viewer");
  assert.deepEqual(after.permissions, ["telemetry:read"]);
  assert.ok(Date.parse(after.expiresAt) > Date.parse(before.expiresAt));
  assert.equal(after.refreshExpiresAt, before.refreshExpiresAt);
  assert.equal(response.headers.getSetCookie().length, 1);
  assert.match(response.headers.getSetCookie()[0], /^__Host-ccdash-session=/);
  assert.equal(f.tokenRequests.filter(body => body.grant_type === "refresh_token").length, 1);
});

test("refresh cannot authenticate bad signatures or mismatched issuer/audience/subject/groups", async t => {
  const cases = [
    { refreshBadSignature: true, expectedStatus: 503 },
    { refreshClaims: { iss: "https://other.example.invalid/" }, expectedStatus: 503 },
    { refreshClaims: { aud: "another-client" }, expectedStatus: 503 },
    { refreshClaims: { sub: "different-subject" }, expectedStatus: 401 },
    { refreshClaims: { groups: [] }, expectedStatus: 401 },
    { refreshClaims: { groups: "dashboard-admins" }, expectedStatus: 401 },
  ];
  for (const options of cases) {
    const f = await fixture(t, { env: refreshEnv, ...options });
    const response = await f.request("/api/data", { headers: { cookie: refreshCookies({}, Date.now()) } });
    assert.equal(response.status, options.expectedStatus);
    assert.ok(!response.headers.getSetCookie().some(value => value.startsWith("__Host-ccdash-session=v1")));
    assert.ok(!f.events.some(event => event.event === "session.refresh" && event.outcome === "granted"));
  }
});

test("revoked credentials and rotated refresh responses require fresh login", async t => {
  for (const options of [{ refreshError: "invalid_grant" }, { rotatedToken: "new-rotated-fixture" }]) {
    const f = await fixture(t, { env: refreshEnv, ...options });
    const response = await f.request("/api/data", { headers: { cookie: refreshCookies({}, Date.now()) } });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, "authentication_required");
    assert.equal(response.headers.getSetCookie().length, 4);
    assert.ok(response.headers.getSetCookie().every(value => value.includes("Max-Age=0")));
  }
});

test("missing, duplicated, tampered, expired and cross-installation refresh cookies never reach the provider", async t => {
  const time = Date.now();
  // Keep one-second future/maximum-lifetime boundaries fixed even on a busy runner.
  const f = await fixture(t, { env: refreshEnv, now: () => time });
  const cookie = refreshCookies({}, time);
  for (const value of [cookie.split("; ")[0], cookie + "; " + cookie.split("; ")[0], cookie + "x",
    refreshCookies({}, time, { exp: Math.floor(time / 1000) - 1 }),
    refreshCookies({}, time, { iat: Math.floor(time / 1000) + 1 }),
    refreshCookies({ OIDC_CLIENT_ID: "other-client" }, time),
    refreshCookies({}, time, { exp: Math.floor(time / 1000) + 2592001 }),
  ]) assert.equal((await f.request("/api/data", { headers: { cookie: value } })).status, 401);
  assert.equal(f.tokenRequests.length, 0);
});

test("absolute refresh expiry caps short principals and avoids renewals at the capped deadline", async t => {
  let time = Date.now();
  const f = await fixture(t, { env: refreshEnv, now: () => time });
  const deadline = Math.floor(time / 1000) + 20;
  const cookie = refreshCookies({}, time, { exp: deadline });
  const first = await f.request("/api/session", { headers: { cookie } });
  const profile = await first.json();
  assert.equal(Date.parse(profile.expiresAt), deadline * 1000);
  const principal = first.headers.getSetCookie()[0].split(";")[0];
  const repeated = await f.request("/api/session", { headers: { cookie: cookie + "; " + principal } });
  assert.equal(repeated.status, 200);
  assert.equal(f.tokenRequests.length, 1);
  time += 21_000;
  assert.equal((await f.request("/api/session", { headers: { cookie: cookie + "; " + principal } })).status, 401);
  assert.equal(f.tokenRequests.length, 1);
});

test("session metadata advertises persistence only for an enabled matching refresh credential", async t => {
  const active = await fixture(t, { env: refreshEnv, refreshToken });
  const logged = await active.complete();
  const disabled = await fixture(t);
  const cases = [
    [active, logged.session],
    [active, logged.session + "; " + refreshCookies({}, Date.now(), { subject: "other-subject" })],
    [active, logged.session + "; " + refreshCookies({}, Date.now(), { exp: Math.floor(Date.now() / 1000) + 100 })],
    [disabled, logged.cookies],
  ];
  for (const [f, cookie] of cases) {
    const response = await f.request("/api/session", { headers: { cookie } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).refreshExpiresAt, undefined);
    assert.equal(f.tokenRequests.filter(body => body.grant_type === "refresh_token").length, 0);
  }
  assert.equal((await disabled.request("/api/data", { headers: { cookie: refreshCookies({}, Date.now()) } })).status, 401);
});

test("cross-origin requests reject refresh and revocation before any provider request", async t => {
  const f = await fixture(t, { env: refreshEnv });
  for (const path of ["/api/chat", "/auth/logout"]) {
    for (const requestOrigin of [undefined, "null", "https://attacker.example.invalid"]) {
      const response = await f.request(path, { method: "POST", headers: {
        cookie: refreshCookies({}, Date.now()), ...(requestOrigin ? { origin: requestOrigin } : {}),
      } });
      assert.equal(response.status, 403);
      assert.equal(response.headers.getSetCookie().length, 0);
    }
  }
  assert.equal(f.tokenRequests.length, 0);
  assert.equal(f.revocations.length, 0);
});

test("refresh work deduplicates concurrent callers and does not cache successful credentials", async t => {
  const wait = deferred();
  const entered = deferred();
  const f = await fixture(t, { env: refreshEnv, refreshWait: () => { entered.resolve(); return wait.promise; } });
  const cookie = refreshCookies({}, Date.now());
  const first = f.request("/api/data", { headers: { cookie } });
  await entered.promise;
  const concurrent = Array.from({ length: 5 }, () => f.request("/api/data", { headers: { cookie } }));
  // Allow all request handlers to join the outstanding exchange.
  await new Promise(resolve => setTimeout(resolve, 30));
  wait.resolve();
  for (const response of await Promise.all([first, ...concurrent])) assert.equal(response.status, 200);
  assert.equal(f.tokenRequests.length, 1);
  assert.equal((await f.request("/api/data", { headers: { cookie } })).status, 200);
  assert.equal(f.tokenRequests.length, 2);
});

test("temporary refresh failure cooldown bounds provider retries and preserves retryable cookies", async t => {
  let time = Date.now();
  const f = await fixture(t, { env: refreshEnv, now: () => time, refreshError: "temporarily_unavailable", refreshStatus: 503 });
  const cookie = refreshCookies({}, time);
  for (let i = 0; i < 3; i++) {
    const response = await f.request("/api/data", { headers: { cookie } });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "5");
    assert.equal(response.headers.getSetCookie().length, 0);
    assert.equal((await response.json()).error, "authentication_temporarily_unavailable");
  }
  assert.equal(f.tokenRequests.length, 1);
  time += 5001;
  assert.equal((await f.request("/api/data", { headers: { cookie } })).status, 503);
  assert.equal(f.tokenRequests.length, 2);
});

test("refresh failure storage rejects new work at capacity and releases expired entries", async t => {
  let time = Date.now();
  const f = await fixture(t, { env: refreshEnv, now: () => time, refreshError: "temporarily_unavailable", refreshStatus: 503 });
  for (let i = 0; i < 1025; i++) {
    const response = await f.request("/api/data", { headers: { cookie: refreshCookies({}, time, { token: "fixture-" + i }) } });
    assert.equal(response.status, 503);
    await response.arrayBuffer();
  }
  assert.equal(f.tokenRequests.length, 1024);
  time += 5001;
  const response = await f.request("/api/data", { headers: { cookie: refreshCookies({}, time, { token: "new-fixture" }) } });
  assert.equal(response.status, 503);
  assert.equal(f.tokenRequests.length, 1025);
});

test("logout revokes the original credential and reports provider failure after clearing cookies", async t => {
  for (const revocationError of [false, true]) {
    const f = await fixture(t, { env: refreshEnv, revocationError });
    const response = await f.request("/auth/logout", { method: "POST", headers: { cookie: refreshCookies({}, Date.now()), origin } });
    assert.equal(response.status, revocationError ? 503 : 303);
    assert.equal(response.headers.getSetCookie().length, 4);
    assert.ok(response.headers.getSetCookie().every(value => value.includes("Max-Age=0")));
    assert.equal(f.revocations.length, 1);
    assert.equal(f.revocations[0].token, refreshToken);
    assert.equal(f.revocations[0].token_type_hint, "refresh_token");
    assert.ok(!JSON.stringify(f.events).includes(refreshToken));
  }
});

test("refresh admission caps simultaneous distinct exchanges and recovers after completion", async t => {
  const wait = deferred();
  const entered = deferred();
  let active = 0;
  const f = await fixture(t, { env: refreshEnv, refreshWait: () => {
    if (++active === 16) entered.resolve();
    return wait.promise;
  } });
  const pending = Array.from({ length: 16 }, (_, i) => f.request("/api/data", {
    headers: { cookie: refreshCookies({}, Date.now(), { token: "concurrent-" + i }) },
  }));
  await entered.promise;
  const overflow = await f.request("/api/data", { headers: { cookie: refreshCookies({}, Date.now(), { token: "overflow" }) } });
  assert.equal(overflow.status, 503);
  assert.equal(f.tokenRequests.length, 16);
  wait.resolve();
  for (const response of await Promise.all(pending)) assert.equal(response.status, 200);
  assert.equal((await f.request("/api/data", { headers: { cookie: refreshCookies({}, Date.now(), { token: "released" }) } })).status, 200);
  assert.equal(f.tokenRequests.length, 17);
});

test("concurrent and replayed logout requests share bounded revocation work", async t => {
  const wait = deferred();
  const entered = deferred();
  const f = await fixture(t, { env: refreshEnv, revocationWait: () => { entered.resolve(); return wait.promise; } });
  const request = () => f.request("/auth/logout", { method: "POST", headers: { cookie: refreshCookies({}, Date.now()), origin } });
  const first = request();
  await entered.promise;
  const second = request();
  await new Promise(resolve => setTimeout(resolve, 30));
  wait.resolve();
  for (const response of await Promise.all([first, second])) assert.equal(response.status, 303);
  assert.equal(f.revocations.length, 1);
  assert.equal((await request()).status, 303);
  assert.equal(f.revocations.length, 1);
});

test("logout revocation admission is bounded while clearing every browser's cookies", async t => {
  const wait = deferred();
  const entered = deferred();
  let active = 0;
  const f = await fixture(t, { env: refreshEnv, revocationWait: () => {
    if (++active === 16) entered.resolve();
    return wait.promise;
  } });
  const request = token => f.request("/auth/logout", { method: "POST", headers: {
    cookie: refreshCookies({}, Date.now(), { token }), origin,
  } });
  const pending = Array.from({ length: 16 }, (_, i) => request("logout-" + i));
  await entered.promise;
  const overflow = await request("overflow");
  assert.equal(overflow.status, 503);
  assert.equal(overflow.headers.getSetCookie().length, 4);
  assert.equal(f.revocations.length, 16);
  wait.resolve();
  for (const response of await Promise.all(pending)) assert.equal(response.status, 303);
});

test("production discovery uses confidential Basic authentication for login, renewal and revocation", async t => {
  let time = Date.now();
  const f = await fixture(t, { defaultDiscovery: true, env: refreshEnv, refreshToken, now: () => time });
  const logged = await f.complete();
  assert.equal(logged.response.status, 303);
  time += 601_000;
  const renewed = await f.request("/api/session", { headers: { cookie: logged.cookies } });
  assert.equal(renewed.status, 200);
  const logout = await f.request("/auth/logout", { method: "POST", headers: { cookie: logged.cookies, origin } });
  assert.equal(logout.status, 303);
  assert.equal(f.revocations.length, 1);
  assert.ok(f.tokenRequests.every(body => body.client_secret === undefined));
});
