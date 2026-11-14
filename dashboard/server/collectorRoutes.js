import express from "express";
import { createHash } from "node:crypto";
import { openSync, readFileSync, fstatSync, closeSync } from "node:fs";
import { resolve } from "node:path";
import { createDeviceTokenService, DeviceTokenError, TOKEN_LIFETIME_DAYS } from "./deviceTokens.js";
import { createDynamoDeviceStore } from "./deviceTokenStore.js";
import { collectorInstallScript } from "./collectorInstallScript.js";
import { createEnrollmentService, isPollToken } from "./collectorEnrollment.js";

const BODY_LIMIT = 2 * 1024 * 1024;
const RESPONSE_LIMIT = 64 * 1024;
const TYPES = new Set(["application/json", "application/x-protobuf"]);
const SIGNAL_PATHS = new Set(["/api/ingest/v1/metrics", "/api/ingest/v1/logs", "/api/ingest/v1/traces"]);
const RENEW_PATH = "/api/ingest/renew";
const INSTALL_PATH = "/api/ingest/install.sh";
const DEVICE_PACKAGE_PATH = /^\/api\/ingest\/package\/([a-z]+)$/;
const HELPER_PATH = "/api/ingest/enroll.py";
const ENROLL_START_PATH = "/api/ingest/enroll/start";
const ENROLL_POLL_PATH = "/api/ingest/enroll/poll";
const ENROLL_BODY_LIMIT = 1024;
const COLLECTOR_VERSION = "0.163.1";
const mediaType = value => (value || "").split(";")[0].trim().toLowerCase();
const fail = (code, status) => new DeviceTokenError(code, status);
const noStore = (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); };

function configuration(env, authentication) {
  if (![undefined, "", "0", "1"].includes(env.INGEST_ENABLED)) throw new Error("INGEST_ENABLED must be 0 or 1");
  if (env.INGEST_ENABLED !== "1") return { enabled: false };
  if (authentication?.mode !== "oidc") throw new Error("Device ingestion requires OIDC authentication");
  for (const name of ["INGEST_TOKEN_TABLE", "INGEST_UPSTREAM_URL", "INGEST_UPSTREAM_TOKEN_FILE",
    "APP_PUBLIC_URL", "OIDC_ISSUER"])
    if (typeof env[name] !== "string" || !env[name].trim()) throw new Error(`Device ingestion requires ${name}`);
  if (!/^[A-Za-z0-9_.-]{3,255}$/.test(env.INGEST_TOKEN_TABLE)) throw new Error("INGEST_TOKEN_TABLE is invalid");
  let publicUrl, upstream, issuer;
  try {
    publicUrl = new URL(env.APP_PUBLIC_URL);
    upstream = new URL(env.INGEST_UPSTREAM_URL);
    issuer = new URL(env.OIDC_ISSUER);
  } catch { throw new Error("Device ingestion URL configuration is invalid"); }
  if (publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password
    || publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash
    || issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.search || issuer.hash
    || !["http:", "https:"].includes(upstream.protocol) || upstream.username || upstream.password
    || upstream.search || upstream.hash || upstream.pathname !== "/")
    throw new Error("Device ingestion URL configuration is invalid");
  let upstreamToken;
  let descriptor;
  try {
    descriptor = openSync(env.INGEST_UPSTREAM_TOKEN_FILE, "r");
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 4096) throw new Error();
    upstreamToken = readFileSync(descriptor, "utf8").trim();
    if (!/^[A-Za-z0-9._~-]{32,256}$/.test(upstreamToken)) throw new Error();
  } catch { throw new Error("INGEST_UPSTREAM_TOKEN_FILE must contain a valid internal bearer token"); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
  return { enabled: true, publicOrigin: publicUrl.origin, endpoint: publicUrl.origin + "/api/ingest",
    upstream: upstream.origin, upstreamToken, issuer: issuer.href, tableName: env.INGEST_TOKEN_TABLE };
}

// Refuse new keys when full: evicting active keys would let callers reset their rate budget.
function fixedWindow(limit, duration, now) {
  const entries = new Map();
  return key => {
    const time = now();
    for (const [entryKey, value] of entries) if (value.until <= time) entries.delete(entryKey);
    let entry = entries.get(key);
    if (!entry) {
      if (entries.size >= 2048) return false;
      entry = { count: 0, until: time + duration };
      entries.set(key, entry);
    }
    if (entry.count >= limit) return false;
    entry.count++;
    return true;
  };
}

function requestBody(req, signal, limit = BODY_LIMIT) {
  return new Promise((resolveBody, reject) => {
    let bytes = 0;
    const chunks = [];
    const cleanup = () => {
      req.off("data", data);
      req.off("end", end);
      req.off("error", error);
      req.off("aborted", aborted);
      signal.removeEventListener("abort", cancelled);
    };
    const error = cause => { cleanup(); req.pause(); reject(cause); };
    const cancelled = () => error(signal.reason);
    const aborted = () => error(fail("request_aborted", 400));
    const data = chunk => {
      bytes += chunk.length;
      if (bytes > limit) return error(fail("body_too_large", 413));
      chunks.push(chunk);
    };
    const end = () => { cleanup(); resolveBody(Buffer.concat(chunks, bytes)); };
    req.on("data", data);
    req.on("end", end);
    req.on("error", error);
    req.on("aborted", aborted);
    signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) cancelled();
    else req.resume();
  });
}

async function responseBody(response, signal) {
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > RESPONSE_LIMIT)) {
    await response.body?.cancel();
    throw fail("upstream_unavailable", 502);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.length;
      if (size > RESPONSE_LIMIT) throw fail("upstream_unavailable", 502);
      chunks.push(Buffer.from(value));
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function errorResponse(res, error, fallback = "store_unavailable") {
  if (res.headersSent || res.destroyed) return;
  const known = error instanceof DeviceTokenError;
  res.status(known ? error.status : 503).json({ error: known ? error.code : fallback });
}

// Built by collector/build-packages.mjs next to the archives. Absent files disable browser enrollment.
function enrollmentArtifacts(packageDir) {
  let helper = null;
  let packageHashes = {};
  try {
    helper = readFileSync(resolve(packageDir, "enroll.py"));
    const manifest = JSON.parse(readFileSync(resolve(packageDir, "manifest.json"), "utf8"));
    for (const platform of ["linux", "darwin"]) {
      const hash = manifest?.packages?.[`ccdash-collector-${platform}.tar.gz`];
      if (typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)) packageHashes[platform] = hash;
    }
  } catch { helper = null; packageHashes = {}; }
  if (!helper || !Object.keys(packageHashes).length) return null;
  return { helper, helperSha256: createHash("sha256").update(helper).digest("hex"), packageHashes };
}

/** Install ingestion before human authentication/body parsers, and management after human auth. */
export function createCollectorFeature({ env = process.env, authentication, packageDir = "/app/collector-packages",
  store, fetchImpl = globalThis.fetch, now = Date.now }) {
  const config = configuration(env, authentication);
  const deviceStore = config.enabled ? store || createDynamoDeviceStore({ tableName: config.tableName }) : null;
  const service = config.enabled ? createDeviceTokenService({ store: deviceStore, issuer: config.issuer, now }) : null;
  const mintAllowed = fixedWindow(10, 3600000, now);
  const ingestAllowed = fixedWindow(120, 60000, now);
  const renewAllowed = fixedWindow(6, 3600000, now);
  const packageAllowed = fixedWindow(10, 3600000, now);
  const artifacts = config.enabled ? enrollmentArtifacts(packageDir) : null;
  const enrollment = artifacts ? createEnrollmentService({ store: deviceStore, issuer: config.issuer,
    publicOrigin: config.publicOrigin, now, packageHashes: artifacts.packageHashes }) : null;
  const installScript = config.enabled ? collectorInstallScript(config.endpoint, artifacts?.helperSha256 ?? null) : null;
  // Per replica. Per source (req.ip behind the trusted proxy hop): a workshop sharing one NAT
  // address can still start ~140 installs with retries; the global ceiling only bounds store work.
  const startFromSourceAllowed = fixedWindow(200, 600000, now);
  const startAllowed = fixedWindow(1200, 600000, now);
  // Bounds anonymous poll traffic per client address before any per-enrollment state exists
  // (sized for a workshop behind one NAT address: ~140 helpers polling every 5 s).
  const pollFromSourceAllowed = fixedWindow(2400, 60000, now);
  const pollAllowed = fixedWindow(30, 60000, now);
  const decideAllowed = fixedWindow(30, 3600000, now);
  let active = 0;
  let enrollActive = 0;
  let pendingTouches = 0;

  function touchAccepted(identity) {
    // Last-seen is optional metadata. Never retry accepted telemetry because this write failed.
    // No queue: saturation may leave lastSeenAt stale, while memory and store work remain bounded.
    if (pendingTouches >= 8) return;
    pendingTouches++;
    const controller = new AbortController();
    let timer;
    const timeout = new Promise(resolveTimeout => {
      timer = setTimeout(() => { controller.abort(); resolveTimeout(); }, 3000);
      timer.unref();
    });
    void Promise.race([
      Promise.resolve().then(() => service.touch(identity, { signal: controller.signal })),
      timeout,
    ]).catch(() => {}).finally(() => {
      clearTimeout(timer);
      controller.abort();
      pendingTouches--;
    });
  }

  const bearer = req => {
    const authorization = /^Bearer (\S+)$/i.exec(req.get("authorization") || "");
    return authorization && req.rawHeaders.filter((value, i) => i % 2 === 0
      && value.toLowerCase() === "authorization").length === 1 ? authorization[1] : null;
  };

  function sendPackage(res, platform) {
    const filename = `ccdash-collector-${platform}.tar.gz`;
    res.set("Content-Type", "application/gzip");
    res.download(resolve(packageDir, filename), filename, error => {
      if (!error) return;
      if (res.headersSent) { res.destroy(); return; }
      res.removeHeader("Content-Disposition");
      errorResponse(res, fail("package_unavailable", 503));
    });
  }

  // Public bootstrap script and device-token package download for `curl | sh`; neither reads a body.
  async function install(req, res, platform) {
    if (!["GET", "HEAD"].includes(req.method)) {
      res.set({ Allow: "GET, HEAD", Connection: "close" });
      return errorResponse(res, fail("method_not_allowed", 405));
    }
    if (req.originalUrl.includes("?")) return errorResponse(res, fail("invalid_request", 400));
    if (platform === undefined) return void res.type("text/plain; charset=utf-8").send(installScript);
    if (!["linux", "darwin"].includes(platform)) return errorResponse(res, fail("not_found", 404));
    const token = bearer(req);
    if (!token) return errorResponse(res, fail("invalid_token", 401));
    // Unknown tokens are never cached, so verification shares the gateway's store admission.
    if (active >= 8) {
      res.set("Retry-After", "1");
      return errorResponse(res, fail("ingest_busy", 429));
    }
    active++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(fail("ingest_timeout", 504)), 15000);
    const closed = () => controller.abort(fail("request_aborted", 400));
    res.once("close", closed);
    let identity;
    try {
      identity = await service.verify(token, { signal: controller.signal });
      controller.signal.throwIfAborted();
    } catch (error) {
      return errorResponse(res, controller.signal.aborted ? controller.signal.reason : error);
    } finally {
      clearTimeout(timer);
      res.off("close", closed);
      active--;
    }
    if (!identity) return errorResponse(res, fail("invalid_token", 401));
    // Charged before the file read so a missing archive still costs a request.
    if (!packageAllowed(`${identity.owner}:${identity.id}`)) {
      res.set("Retry-After", "3600");
      return errorResponse(res, fail("package_rate_limited", 429));
    }
    sendPackage(res, platform);
  }

  // Public terminal side of browser enrollment. Neither route accepts cookies or issues ingest access.
  async function enroll(req, res) {
    res.set("Connection", "close");
    if (req.method !== "POST") { res.set("Allow", "POST"); return errorResponse(res, fail("method_not_allowed", 405)); }
    if (req.originalUrl.includes("?") || (req.get("content-encoding")
      && req.get("content-encoding").toLowerCase() !== "identity")) return errorResponse(res, fail("invalid_request", 400));
    const starting = req.path === ENROLL_START_PATH;
    const length = req.get("content-length");
    let pollToken;
    if (starting) {
      if (mediaType(req.get("content-type")) !== "application/json") return errorResponse(res, fail("unsupported_media_type", 415));
      if (length && (!/^\d+$/.test(length) || Number(length) > ENROLL_BODY_LIMIT))
        return errorResponse(res, fail("body_too_large", 413));
      // The source check runs first so one source exhausting its budget never spends the global one.
      if (!startFromSourceAllowed(req.ip || req.socket?.remoteAddress || "unknown") || !startAllowed("all")) {
        res.set("Retry-After", "60");
        return errorResponse(res, fail("enroll_rate_limited", 429));
      }
    } else {
      if (req.get("transfer-encoding") || (length !== undefined && length !== "0"))
        return errorResponse(res, fail("invalid_request", 400));
      pollToken = bearer(req);
      if (!isPollToken(pollToken)) return errorResponse(res, fail("invalid_enrollment", 401));
      // Anonymous traffic spends a per-source budget first; per-enrollment limiter state is
      // allocated only after the polling credential verifies (see enrollment.poll admit).
      if (!pollFromSourceAllowed(req.ip || req.socket?.remoteAddress || "unknown")) {
        res.set("Retry-After", "10");
        return errorResponse(res, fail("poll_rate_limited", 429));
      }
    }
    // Separate admission from ingest: pending installers must never starve telemetry delivery.
    if (enrollActive >= 16) { res.set("Retry-After", "2"); return errorResponse(res, fail("enroll_busy", 429)); }
    enrollActive++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(fail("enroll_timeout", 504)), 10000);
    const closed = () => controller.abort(fail("request_aborted", 400));
    res.once("close", closed);
    try {
      let reply;
      if (starting) {
        let input;
        try { input = JSON.parse((await requestBody(req, controller.signal, ENROLL_BODY_LIMIT)).toString("utf8")); }
        catch (error) {
          if (error instanceof DeviceTokenError || controller.signal.aborted) throw controller.signal.reason || error;
          throw fail("invalid_json", 400);
        }
        reply = await enrollment.start(input, { signal: controller.signal });
        controller.signal.throwIfAborted();
        res.status(201);
      } else {
        reply = await enrollment.poll(pollToken, { signal: controller.signal, admit: handle => pollAllowed(handle) });
        controller.signal.throwIfAborted();
      }
      res.json(reply);
    } catch (error) {
      const failure = controller.signal.aborted ? controller.signal.reason : error;
      if (failure?.code === "poll_rate_limited") res.set("Retry-After", "10");
      errorResponse(res, failure);
    } finally {
      clearTimeout(timer);
      res.off("close", closed);
      enrollActive--;
    }
  }

  function helper(req, res) {
    if (!["GET", "HEAD"].includes(req.method)) {
      res.set({ Allow: "GET, HEAD", Connection: "close" });
      return errorResponse(res, fail("method_not_allowed", 405));
    }
    if (req.originalUrl.includes("?")) return errorResponse(res, fail("invalid_request", 400));
    res.type("text/x-python; charset=utf-8").send(artifacts.helper);
  }

  async function ingest(req, res) {
    res.set("Cache-Control", "no-store");
    if (enrollment && req.path === HELPER_PATH) return helper(req, res);
    if (enrollment && (req.path === ENROLL_START_PATH || req.path === ENROLL_POLL_PATH)) return enroll(req, res);
    if (config.enabled && req.path === INSTALL_PATH) return install(req, res);
    const devicePackage = config.enabled && DEVICE_PACKAGE_PATH.exec(req.path);
    if (devicePackage) return install(req, res, devicePackage[1]);
    // Closing early failures prevents unread upload bytes becoming another keep-alive request.
    const rejectEarly = (code, status) => {
      res.set("Connection", "close");
      errorResponse(res, fail(code, status));
    };
    const renewal = req.path === RENEW_PATH;
    if (!config.enabled || (!renewal && !SIGNAL_PATHS.has(req.path))) return rejectEarly("not_found", 404);
    if (req.method !== "POST") { res.set("Allow", "POST"); return rejectEarly("method_not_allowed", 405); }
    if (req.originalUrl.includes("?")) return rejectEarly("invalid_request", 400);
    const type = mediaType(req.get("content-type"));
    if ((req.get("content-encoding") && req.get("content-encoding").toLowerCase() !== "identity")
      || !TYPES.has(type)) return rejectEarly("unsupported_media_type", 415);
    const length = req.get("content-length");
    // Renewal carries only the bearer token; any request body is refused unread.
    if (renewal && (req.get("transfer-encoding") || (length !== undefined && length !== "0")))
      return rejectEarly("invalid_request", 400);
    if (length && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) return rejectEarly("body_too_large", 413);
    const token = bearer(req);
    if (!token) return rejectEarly("invalid_token", 401);
    if (active >= 8) { res.set("Retry-After", "1"); return rejectEarly("ingest_busy", 429); }
    active++;
    const controller = new AbortController();
    const { signal } = controller;
    const closed = () => controller.abort(fail("request_aborted", 400));
    const timer = setTimeout(() => controller.abort(fail("ingest_timeout", 504)), 15000);
    let rejectAborted;
    const aborted = new Promise((_resolve, reject) => {
      rejectAborted = () => reject(signal.reason);
      signal.addEventListener("abort", rejectAborted, { once: true });
    });
    req.once("aborted", closed);
    res.once("close", closed);
    try {
      const result = await Promise.race([aborted, (async () => {
        if (renewal) {
          // The only response that carries a secret: the one-time replacement token (no-store).
          const reply = await service.renew(token, { signal,
            admit: identity => renewAllowed(`${identity.owner}:${identity.id}`) });
          signal.throwIfAborted();
          return { reply };
        }
        const identity = await service.verify(token, { signal });
        signal.throwIfAborted();
        if (!identity) throw fail("invalid_token", 401);
        if (!ingestAllowed(`${identity.owner}:${identity.id}`)) throw fail("ingest_rate_limited", 429);
        const body = await requestBody(req, signal);
        signal.throwIfAborted();
        if (type === "application/json") {
          try {
            const parsed = JSON.parse(body.toString("utf8"));
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
          } catch { throw fail("invalid_json", 400); }
        }
        // A slow upload must not extend fixed expiry or the revocation cache window.
        if (!await service.verify(token, { signal })) throw fail("invalid_token", 401);
        signal.throwIfAborted();
        let upstream;
        let bytes;
        let responseType;
        try {
          upstream = await fetchImpl(config.upstream + req.path.slice("/api/ingest".length), {
            method: "POST", body, headers: { authorization: `Bearer ${config.upstreamToken}`, "content-type": type },
            redirect: "manual", signal,
          });
          signal.throwIfAborted();
          if (!upstream.ok) {
            await upstream.body?.cancel();
            throw fail("upstream_unavailable", 502);
          }
          responseType = mediaType(upstream.headers.get("content-type")) || type;
          if (!TYPES.has(responseType)) {
            await upstream.body?.cancel();
            throw fail("upstream_unavailable", 502);
          }
          bytes = await responseBody(upstream, signal);
        } catch {
          signal.throwIfAborted();
          throw fail("upstream_unavailable", 502);
        }
        signal.throwIfAborted();
        return { bytes, responseType, status: upstream.status, identity };
      })()]);
      // Renewal is not a delivery, so it never updates last-seen metadata.
      if (result.reply) return void res.json(result.reply);
      res.status(result.status).set("Content-Type", result.responseType).send(result.bytes);
      touchAccepted(result.identity);
    } catch (error) {
      if (!req.complete) res.set("Connection", "close");
      if (error?.status === 429) res.set("Retry-After", error.code === "renew_rate_limited" ? "3600" : "60");
      errorResponse(res, error);
    } finally {
      clearTimeout(timer);
      req.off("aborted", closed);
      res.off("close", closed);
      signal.removeEventListener("abort", rejectAborted);
      controller.abort();
      active--;
    }
  }

  return {
    enabled: config.enabled,
    installIngest(app) {
      app.use((req, res, next) => {
        const path = req.path.toLowerCase();
        if (path !== "/api/ingest" && !path.startsWith("/api/ingest/")) return next();
        void ingest(req, res);
      });
    },
    installManagement(app) {
      const router = express.Router({ strict: true, caseSensitive: true });
      router.use(noStore, authentication.requirePermission("collector:manage"));
      router.get("/", (_req, res) => res.json({ enabled: config.enabled,
        ...(config.enabled ? { endpoint: config.endpoint, installScriptUrl: `${config.endpoint}/install.sh`,
          browserEnrollment: !!enrollment } : {}),
        tokenLifetimeDays: TOKEN_LIFETIME_DAYS, collectorVersion: COLLECTOR_VERSION, platforms: ["linux", "darwin"] }));
      router.use((req, res, next) => {
        if (!config.enabled) return errorResponse(res, fail("collector_disabled", 503));
        if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.get("origin") !== config.publicOrigin)
          return errorResponse(res, fail("origin_not_allowed", 403));
        next();
      });
      const route = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);
      router.get("/devices", route(async (req, res) => {
        res.json(await service.list(req.principal?.subject, req.query.cursor));
      }));
      router.post("/devices", (req, res, next) => {
        if (!mintAllowed(req.principal?.subject)) {
          res.set("Retry-After", "3600");
          return errorResponse(res, fail("mint_rate_limited", 429));
        }
        next();
      }, express.json({ limit: "4kb", inflate: false }), route(async (req, res) => {
        res.status(201).json(await service.issue(req.principal?.subject, req.body));
      }));
      router.delete("/devices/:id", route(async (req, res) => {
        await service.revoke(req.principal?.subject, req.params.id);
        res.status(204).end();
      }));
      router.get("/enrollments/:handle", route(async (req, res) => {
        if (!enrollment) throw fail("enrollment_unavailable", 503);
        res.json(await enrollment.view(req.principal, req.params.handle));
      }));
      // Only an explicit same-origin POST decides; GET and the SSO callback never do.
      for (const decision of ["approve", "deny"]) router.post(`/enrollments/:handle/${decision}`, route(async (req, res) => {
        if (!enrollment) throw fail("enrollment_unavailable", 503);
        if (req.get("content-length") && req.get("content-length") !== "0") throw fail("invalid_request", 400);
        if (!decideAllowed(req.principal?.subject)) {
          res.set("Retry-After", "3600");
          throw fail("decision_rate_limited", 429);
        }
        res.json(await enrollment[decision](req.principal, req.params.handle));
      }));
      router.get("/package/:platform", (req, res) => {
        if (!["linux", "darwin"].includes(req.params.platform)) return errorResponse(res, fail("not_found", 404));
        sendPackage(res, req.params.platform);
      });
      router.use((_req, res) => errorResponse(res, fail("not_found", 404)));
      router.use((error, _req, res, _next) => {
        if (error?.type === "entity.too.large") return errorResponse(res, fail("body_too_large", 413));
        if (error?.type === "entity.parse.failed") return errorResponse(res, fail("invalid_json", 400));
        if (error?.status === 415) return errorResponse(res, fail("unsupported_media_type", 415));
        errorResponse(res, error);
      });
      app.use("/api/collector", router);
    },
  };
}
