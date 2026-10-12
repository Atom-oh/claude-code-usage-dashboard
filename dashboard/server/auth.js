import basicAuth from "express-basic-auth";
import * as oidc from "openid-client";
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createRateLimiter } from "./rateLimit.js";

const SESSION_COOKIE = "__Host-ccdash-session";
const LOGIN_COOKIE = "__Host-ccdash-login";
const PROBES = new Set(["/healthz", "/readyz"]);
const ROLES = ["viewer", "analyst", "admin"];
const PERMISSIONS = {
  viewer: ["telemetry:read"],
  analyst: ["telemetry:read", "chat:query"],
  admin: ["telemetry:read", "chat:query", "installation:read"],
};
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function httpsUrl(value, name, originOnly = false) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an HTTPS URL`); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || (originOnly && url.pathname !== "/")) throw new Error(`${name} must be an HTTPS ${originOnly ? "origin" : "issuer URL"}`);
  return originOnly ? url.origin : url.href;
}

export function parseAuthConfig(env) {
  if (!env.AUTH_MODE && Object.keys(env).some(name => (name.startsWith("OIDC_") || name === "SESSION_SECRET") && env[name]))
    throw new Error("AUTH_MODE is required when OIDC settings are present");
  const mode = env.AUTH_MODE || "basic";
  if (!["basic", "oidc"].includes(mode)) throw new Error("AUTH_MODE must be basic or oidc");
  if (mode === "basic") {
    const enabled = !!(env.BASIC_AUTH_USER && env.BASIC_AUTH_PASSWORD);
    if (!enabled && env.AUTH_ALLOW_INSECURE !== "1")
      throw new Error("BASIC_AUTH_USER and BASIC_AUTH_PASSWORD are both required");
    // A partially configured credential must never silently enable the development bypass.
    if (!enabled && (env.BASIC_AUTH_USER || env.BASIC_AUTH_PASSWORD))
      throw new Error("BASIC_AUTH_USER and BASIC_AUTH_PASSWORD must be configured together");
    return { mode, enabled, user: env.BASIC_AUTH_USER, password: env.BASIC_AUTH_PASSWORD };
  }
  const issuer = httpsUrl(env.OIDC_ISSUER, "OIDC_ISSUER");
  const origin = httpsUrl(env.APP_PUBLIC_URL, "APP_PUBLIC_URL", true);
  if (!env.OIDC_CLIENT_ID || !env.OIDC_CLIENT_SECRET) throw new Error("OIDC_CLIENT_ID and OIDC_CLIENT_SECRET are required");
  if (!/^[A-Za-z0-9_-]{43}$/.test(env.SESSION_SECRET || ""))
    throw new Error("SESSION_SECRET must be a base64url-encoded 32-byte random key");
  const key = Buffer.from(env.SESSION_SECRET, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== env.SESSION_SECRET)
    throw new Error("SESSION_SECRET must be a base64url-encoded 32-byte random key");
  const maxAge = env.SESSION_MAX_AGE_SECONDS === undefined ? 900 : Number(env.SESSION_MAX_AGE_SECONDS);
  if (!Number.isInteger(maxAge) || maxAge < 300 || maxAge > 3600)
    throw new Error("SESSION_MAX_AGE_SECONDS must be an integer from 300 to 3600");
  const claim = env.OIDC_GROUPS_CLAIM || "groups";
  if (!/^[A-Za-z][A-Za-z0-9:_-]{0,127}$/.test(claim)) throw new Error("OIDC_GROUPS_CLAIM must name a top-level claim");
  let roleGroups;
  try { roleGroups = JSON.parse(env.OIDC_ROLE_GROUPS); } catch { throw new Error("OIDC_ROLE_GROUPS must be a JSON object"); }
  if (!roleGroups || typeof roleGroups !== "object" || Array.isArray(roleGroups)
    || Object.keys(roleGroups).some(role => !ROLES.includes(role))
    || !Object.keys(roleGroups).length
    || Object.values(roleGroups).some(groups => !Array.isArray(groups) || !groups.length || groups.length > 64
      || groups.some(group => typeof group !== "string" || !group.trim() || group.length > 128)))
    throw new Error("OIDC_ROLE_GROUPS must map viewer, analyst or admin to explicit group arrays");
  return { mode, enabled: true, issuer, origin, key, maxAge, claim, roleGroups,
    clientId: env.OIDC_CLIENT_ID, clientSecret: env.OIDC_CLIENT_SECRET };
}

function cookieValue(header, name) {
  const matches = (header || "").split(";").map(item => item.trim()).filter(item => item.startsWith(name + "="));
  return matches.length === 1 ? matches[0].slice(name.length + 1) : null;
}

export function createSessionCodec(config, now = Date.now) {
  const aad = purpose => Buffer.from(JSON.stringify(["ccdash-auth-v1", purpose, config.issuer, config.clientId, config.origin]));
  return {
    seal(payload, purpose) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", config.key, iv);
      cipher.setAAD(aad(purpose));
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
      const token = ["v1", iv.toString("base64url"), encrypted.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
      if (token.length > 3500) throw new Error("Session payload exceeds cookie limit");
      return token;
    },
    open(token, purpose) {
      try {
        if (typeof token !== "string" || token.length > 3500 || !/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
        const [, iv, body, tag] = token.split(".").map((part, index) => index ? Buffer.from(part, "base64url") : part);
        if (iv.length !== 12 || tag.length !== 16) return null;
        const decipher = createDecipheriv("aes-256-gcm", config.key, iv);
        decipher.setAAD(aad(purpose));
        decipher.setAuthTag(tag);
        const payload = JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8"));
        if (!payload || !Number.isInteger(payload.exp) || payload.exp <= Math.floor(now() / 1000)) return null;
        return payload;
      } catch { return null; }
    },
  };
}

function setCookie(res, name, value, seconds) {
  res.append("Set-Cookie", `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${seconds}`);
}

function safeReturnTo(value) {
  if (typeof value !== "string" || value.length > 2048 || !value.startsWith("/") || value.startsWith("//")
    || /[\\\u0000-\u0020\u007f]/.test(value) || value.toLowerCase().startsWith("/auth/")) return "/";
  // WHATWG normalizes paths such as /..//example.invalid into network-path redirects.
  const url = new URL(value, "https://return.invalid");
  const normalized = url.pathname + url.search;
  return url.origin === "https://return.invalid" && !normalized.startsWith("//") ? normalized : "/";
}

function loginPage(res, status = 401, failed = false, returnTo = "/") {
  const nonce = randomBytes(16).toString("base64");
  res.set("Content-Security-Policy", `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
  const loginUrl = "/auth/login?returnTo=" + encodeURIComponent(safeReturnTo(returnTo));
  res.status(status).type("html").send(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>조직 로그인 · AI 사용량 대시보드</title><style nonce="${nonce}">*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#f5f7fb;color:#172033;font:16px/1.6 system-ui,sans-serif}main{width:100%;max-width:440px;padding:36px;background:white;border:1px solid #dde3ed;border-radius:16px;box-shadow:0 12px 40px #1720330a}h1{font-size:24px;line-height:1.3;margin:16px 0}p{color:#4a586e}a{display:block;margin-top:28px;padding:12px 18px;border-radius:8px;background:#2457cc;color:white;text-align:center;text-decoration:none;font-weight:600}a:focus-visible{outline:3px solid #172033;outline-offset:4px}small{display:block;margin-top:24px;color:#4a586e}.label{color:#2457cc;font-weight:600}</style></head><body><main><div class="label">AI 사용량 대시보드</div><h1>조직 계정으로 로그인</h1><p>${failed ? "로그인을 완료하지 못했습니다. 접근 권한을 확인하거나 조직 관리자에게 문의해 주세요." : "조직의 AI 사용량과 비용을 확인하세요. 관리자가 허용한 계정만 접근할 수 있습니다."}</p><a href="${loginUrl}">조직 SSO로 계속</a><small>사용량·비용 관측 데이터이며 개인의 생산성이나 성과를 평가하는 지표가 아닙니다.</small></main></body></html>`);
}

async function discover(config) {
  return oidc.discovery(new URL(config.issuer), config.clientId, {
    client_secret: config.clientSecret,
    redirect_uris: [config.origin + "/auth/callback"],
    response_types: ["code"],
  }, oidc.ClientSecretPost(config.clientSecret), {
    timeout: 10,
    execute: [oidc.enableNonRepudiationChecks],
  });
}

export function createAuthentication({ env = process.env, now = Date.now, discoverClient = discover,
  audit = entry => console.log(JSON.stringify(entry)) } = {}) {
  const config = parseAuthConfig(env);
  const basic = config.mode === "basic" && config.enabled
    ? basicAuth({ users: { [config.user]: config.password }, challenge: true }) : null;
  const codec = config.mode === "oidc" ? createSessionCodec(config, now) : null;
  const authRateLimit = createRateLimiter({ now });
  let clientPromise;
  let retryAfter = 0;
  const getClient = () => {
    if (!clientPromise) {
      if (now() < retryAfter) return Promise.reject(new Error("Identity provider temporarily unavailable"));
      clientPromise = discoverClient(config).catch(error => {
        clientPromise = null;
        retryAfter = now() + 5000;
        throw error;
      });
    }
    return clientPromise;
  };
  const emit = (event, principal, outcome, failure) => {
    const actor = principal?.subject && config.key
      ? createHmac("sha256", config.key).update(config.issuer + "\0" + principal.subject).digest("hex").slice(0, 24) : undefined;
    audit({ type: "security", event, outcome, id: randomUUID(), at: new Date(now()).toISOString(), actor, role: principal?.role, failure });
  };
  // Classify failures without recording provider messages, tokens, URLs or callback data.
  const failureClass = error => error instanceof oidc.AuthorizationResponseError ? "authorization_response"
    : error instanceof oidc.ResponseBodyError ? "token_response"
      : error instanceof oidc.ClientError ? "protocol"
        : error instanceof TypeError ? "configuration" : "unclassified";
  function roleFromClaims(claims) {
    const groups = claims?.[config.claim];
    if (!Array.isArray(groups) || groups.some(group => typeof group !== "string")) return null;
    return [...ROLES].reverse().find(role => config.roleGroups[role]?.some(group => groups.includes(group))) || null;
  }
  function readPrincipal(req) {
    const session = codec.open(cookieValue(req.headers.cookie, SESSION_COOKIE), "session");
    if (!session || !ROLES.includes(session.role) || typeof session.subject !== "string" || !session.subject
      || session.subject.length > 256 || typeof session.name !== "string" || session.name.length > 160) return null;
    return session;
  }
  function checkOrigin(req, res, next) {
    if (config.mode !== "oidc" || SAFE_METHODS.has(req.method) || req.get("origin") === config.origin) return next();
    emit("request.origin", req.principal, "denied");
    res.status(403).json({ error: "origin_not_allowed" });
  }
  const requirePermission = permission => (req, res, next) => {
    if (config.mode === "basic" || PERMISSIONS[req.principal?.role]?.includes(permission)) return next();
    emit("permission." + permission, req.principal, "denied");
    res.status(403).json({ error: "permission_denied" });
  };
  return {
    mode: config.mode,
    enabled: config.enabled,
    requirePermission,
    sessionInfo(req) {
      return config.mode === "oidc" ? { mode: "oidc", name: req.principal.name, role: req.principal.role,
        permissions: PERMISSIONS[req.principal.role], expiresAt: new Date(req.principal.exp * 1000).toISOString() }
        : { mode: config.enabled ? "basic" : "development", role: "admin", permissions: PERMISSIONS.admin };
    },
    installRoutes(app) {
      if (config.mode !== "oidc") return;
      app.get("/auth/login", authRateLimit, async (req, res) => {
        try {
          const client = await getClient();
          const verifier = oidc.randomPKCECodeVerifier();
          const transaction = { verifier, state: oidc.randomState(), nonce: oidc.randomNonce(),
            returnTo: safeReturnTo(req.query.returnTo), exp: Math.floor(now() / 1000) + 300 };
          const challenge = await oidc.calculatePKCECodeChallenge(verifier);
          const url = oidc.buildAuthorizationUrl(client, { redirect_uri: config.origin + "/auth/callback",
            scope: "openid profile", response_type: "code", code_challenge: challenge,
            code_challenge_method: "S256", state: transaction.state, nonce: transaction.nonce });
          setCookie(res, LOGIN_COOKIE, codec.seal(transaction, "login"), 300);
          res.redirect(302, url.href);
        } catch (error) {
          emit("login.start", null, "failed", { stage: "discovery", class: failureClass(error) });
          loginPage(res, 503, true);
        }
      });
      app.get("/auth/callback", authRateLimit, async (req, res) => {
        setCookie(res, LOGIN_COOKIE, "", 0);
        let stage = "transaction";
        try {
          const transaction = codec.open(cookieValue(req.headers.cookie, LOGIN_COOKIE), "login");
          if (!transaction || typeof transaction.state !== "string" || typeof transaction.nonce !== "string"
            || typeof transaction.verifier !== "string") throw new Error("Invalid login transaction");
          // Reconstruct from configured public origin, never Host or forwarded headers.
          const callback = new URL("/auth/callback", config.origin);
          callback.search = new URL(req.originalUrl, config.origin).search;
          stage = "exchange";
          const tokens = await oidc.authorizationCodeGrant(await getClient(), callback, {
            pkceCodeVerifier: transaction.verifier, expectedState: transaction.state,
            expectedNonce: transaction.nonce, idTokenExpected: true,
          });
          const claims = tokens.claims();
          stage = "claims";
          const role = roleFromClaims(claims);
          const expires = Math.min(claims?.exp, Math.floor(now() / 1000) + config.maxAge);
          if (!role || typeof claims?.sub !== "string" || !claims.sub || claims.sub.length > 256
            || !Number.isInteger(expires) || expires <= Math.floor(now() / 1000)) {
            emit("login.access", null, "denied");
            setCookie(res, SESSION_COOKIE, "", 0);
            return loginPage(res, 403, true);
          }
          const principal = { subject: claims.sub, role, name: typeof claims.name === "string"
            ? claims.name.slice(0, 160) : "조직 사용자", exp: expires };
          setCookie(res, SESSION_COOKIE, codec.seal(principal, "session"), expires - Math.floor(now() / 1000));
          emit("login.access", principal, "granted");
          res.redirect(303, safeReturnTo(transaction.returnTo));
        } catch (error) {
          emit("login.callback", null, "failed", { stage, class: failureClass(error) });
          loginPage(res, 400, true);
        }
      });
      app.post("/auth/logout", checkOrigin, (req, res) => {
        const principal = readPrincipal(req);
        setCookie(res, SESSION_COOKIE, "", 0);
        setCookie(res, LOGIN_COOKIE, "", 0);
        emit("logout", principal, "completed");
        // Local logout; no retained ID/access/refresh tokens or IdP-session promises.
        res.redirect(303, "/");
      });
    },
    middleware(req, res, next) {
      if (PROBES.has(req.path)) return next();
      if (config.mode === "basic") return basic ? basic(req, res, next) : next();
      const principal = readPrincipal(req);
      if (!principal) {
        if (req.path.startsWith("/api/") || !SAFE_METHODS.has(req.method))
          return res.status(401).json({ error: "authentication_required", loginUrl: "/auth/login" });
        return loginPage(res, 401, false, req.originalUrl);
      }
      req.principal = principal;
      checkOrigin(req, res, next);
    },
  };
}
