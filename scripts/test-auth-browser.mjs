// Actual production SPA + actual auth middleware; synthetic identity, no IdP/AWS calls.
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAuthentication, createSessionCodec, parseAuthConfig } from "../dashboard/server/auth.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverRequire = createRequire(path.join(root, "dashboard/server/package.json"));
const webRequire = createRequire(path.join(root, "dashboard/web/package.json"));
const express = serverRequire("express");
const { chromium } = webRequire("playwright");
const policy = readFileSync(path.join(root, "dashboard/server/index.js"), "utf8")
  .match(/res\.set\("Referrer-Policy", "([^"]+)"\)/)?.[1];
assert.equal(policy, "strict-origin", "Use a policy preserving same-origin form POST Origin");
const directory = mkdtempSync(path.join(tmpdir(), "ccdash-auth-browser-"));
let browser;

try {
  const keyPath = path.join(directory, "key.pem"), certPath = path.join(directory, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  chmodSync(keyPath, 0o600);
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
    args: ["--no-sandbox"],
  });
  for (const selectedPolicy of ["no-referrer", policy]) {
    const app = express();
    const server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, app);
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    let context;
    try {
      const origin = `https://127.0.0.1:${server.address().port}`;
      const env = { AUTH_MODE: "oidc", APP_PUBLIC_URL: origin, OIDC_ISSUER: "https://identity.example.invalid/",
        OIDC_CLIENT_ID: "fixture-client", OIDC_CLIENT_SECRET: "synthetic-client-secret",
        SESSION_SECRET: randomBytes(32).toString("base64url"), OIDC_ROLE_GROUPS: '{"analyst":["fixture-analysts"]}' };
      const auth = createAuthentication({ env, audit: () => {} });
      let observedOrigin;
      app.use((req, res, next) => {
        res.set("Cache-Control", "no-store");
        res.set("Referrer-Policy", selectedPolicy);
        if (req.path === "/auth/logout") observedOrigin = req.get("origin");
        next();
      });
      auth.installRoutes(app);
      app.use(auth.middleware);
      app.get("/api/config", (req, res) => res.json({ enabledClients: ["claude"], piiMask: true,
        groupMode: "single", defaultRangeDays: 2, rangeCapDays: 90, schema: {},
        session: auth.sessionInfo(req) }));
      app.get("/api/health/data", (_req, res) => res.json({ status: "ok", latest: null, ageMinutes: 0, staleAfterMinutes: 360 }));
      app.get("/api/*", (_req, res) => res.json([]));
      app.use(express.static(path.join(root, "dashboard/web/dist")));
      app.get("*", (_req, res) => res.sendFile(path.join(root, "dashboard/web/dist/index.html")));
      // TLS is ignored only for this isolated self-signed loopback fixture.
      context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
      const token = createSessionCodec(parseAuthConfig(env)).seal({ subject: "fixture-subject",
        name: "Fixture", role: "analyst", exp: Math.floor(Date.now() / 1000) + 600 }, "session");
      await context.addCookies([{ name: "__Host-ccdash-session", value: token, url: origin,
        secure: true, httpOnly: true, sameSite: "Lax" }]);
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(origin + "/analytics?client=claude&view=detail");
      const logout = page.getByRole("button", { name: "로그아웃" });
      await logout.waitFor();
      const [response] = await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname === "/auth/logout" && response.request().method() === "POST"),
        logout.click(),
      ]);
      if (selectedPolicy === "no-referrer") {
        assert.equal(observedOrigin, "null");
        assert.equal(response.status(), 403);
        assert.ok((await context.cookies()).some(cookie => cookie.name === "__Host-ccdash-session"));
      } else {
        assert.equal(observedOrigin, origin);
        assert.equal(response.status(), 303);
        await page.getByRole("heading", { name: "조직 계정으로 로그인" }).waitFor();
        assert.ok(!(await context.cookies()).some(cookie => cookie.name === "__Host-ccdash-session"));
        const protectedResponse = await context.request.get(origin + "/api/config");
        assert.equal(protectedResponse.status(), 401);
      }
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ policy: selectedPolicy, originMatches: observedOrigin === origin,
        logoutStatus: response.status(), expected: true, pageErrors: errors.length }));
    } finally {
      await context?.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
} finally {
  await browser?.close();
  rmSync(directory, { recursive: true, force: true });
}
