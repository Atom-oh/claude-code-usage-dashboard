import express from "express";
import { openSync, readFileSync, fstatSync, closeSync } from "node:fs";
import { resolve } from "node:path";
import { createDeviceTokenService, DeviceTokenError, TOKEN_LIFETIME_DAYS } from "./deviceTokens.js";
import { createDynamoDeviceStore } from "./deviceTokenStore.js";

const BODY_LIMIT = 2 * 1024 * 1024;
const RESPONSE_LIMIT = 64 * 1024;
const TYPES = new Set(["application/json", "application/x-protobuf"]);
const SIGNAL_PATHS = new Set(["/api/ingest/v1/metrics", "/api/ingest/v1/logs", "/api/ingest/v1/traces"]);
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

function requestBody(req, signal) {
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
      if (bytes > BODY_LIMIT) return error(fail("body_too_large", 413));
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

/** Install ingestion before human authentication/body parsers, and management after human auth. */
export function createCollectorFeature({ env = process.env, authentication, packageDir = "/app/collector-packages",
  store, fetchImpl = globalThis.fetch, now = Date.now }) {
  const config = configuration(env, authentication);
  const service = config.enabled ? createDeviceTokenService({
    store: store || createDynamoDeviceStore({ tableName: config.tableName }), issuer: config.issuer, now,
  }) : null;
  const mintAllowed = fixedWindow(10, 3600000, now);
  const ingestAllowed = fixedWindow(120, 60000, now);
  let active = 0;
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

  async function ingest(req, res) {
    res.set("Cache-Control", "no-store");
    // Closing early failures prevents unread upload bytes becoming another keep-alive request.
    const rejectEarly = (code, status) => {
      res.set("Connection", "close");
      errorResponse(res, fail(code, status));
    };
    if (!config.enabled || !SIGNAL_PATHS.has(req.path)) return rejectEarly("not_found", 404);
    if (req.method !== "POST") { res.set("Allow", "POST"); return rejectEarly("method_not_allowed", 405); }
    if (req.originalUrl.includes("?")) return rejectEarly("invalid_request", 400);
    const type = mediaType(req.get("content-type"));
    if ((req.get("content-encoding") && req.get("content-encoding").toLowerCase() !== "identity")
      || !TYPES.has(type)) return rejectEarly("unsupported_media_type", 415);
    const length = req.get("content-length");
    if (length && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) return rejectEarly("body_too_large", 413);
    const authorization = /^Bearer (\S+)$/i.exec(req.get("authorization") || "");
    if (!authorization || req.rawHeaders.filter((value, i) => i % 2 === 0 && value.toLowerCase() === "authorization").length !== 1)
      return rejectEarly("invalid_token", 401);
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
        const identity = await service.verify(authorization[1], { signal });
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
        if (!await service.verify(authorization[1], { signal })) throw fail("invalid_token", 401);
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
      res.status(result.status).set("Content-Type", result.responseType).send(result.bytes);
      touchAccepted(result.identity);
    } catch (error) {
      if (!req.complete) res.set("Connection", "close");
      if (error?.status === 429) res.set("Retry-After", "60");
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
        ...(config.enabled ? { endpoint: config.endpoint } : {}),
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
      router.get("/package/:platform", (req, res) => {
        if (!["linux", "darwin"].includes(req.params.platform)) return errorResponse(res, fail("not_found", 404));
        const filename = `ccdash-collector-${req.params.platform}.tar.gz`;
        res.set("Content-Type", "application/gzip");
        res.download(resolve(packageDir, filename), filename, error => {
          if (!error) return;
          if (res.headersSent) { res.destroy(); return; }
          res.removeHeader("Content-Disposition");
          errorResponse(res, fail("package_unavailable", 503));
        });
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
