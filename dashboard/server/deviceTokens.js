import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const TOKEN_LIFETIME_DAYS = 30;
const LIFETIME_MS = TOKEN_LIFETIME_DAYS * 86400000;
// A device renews once its current token has at most seven days left.
const RENEW_WINDOW_MS = 7 * 86400000;
const TOKEN = /^ccd1\.([a-f0-9]{64})\.([a-f0-9]{32})\.([A-Za-z0-9_-]{43})$/;
const ID = /^[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const digest = value => createHash("sha256").update(value).digest("hex");
const purgeFor = expiresAt => Math.floor((expiresAt + 7 * 86400000) / 1000);

export class DeviceTokenError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

// Pending rotation fields are internal: views expose only the completed renewal time.
function deviceView(record) {
  const date = value => Number.isFinite(value) ? new Date(value).toISOString() : null;
  return { id: record.id, name: record.name, platform: record.platform,
    createdAt: date(record.createdAt), expiresAt: date(record.expiresAt),
    revokedAt: date(record.revokedAt), lastSeenAt: date(record.lastSeenAt), renewedAt: date(record.renewedAt),
    reuseDetectedAt: date(record.reuseDetectedAt) };
}

// Each stored hash is valid only before its own expiry; comparison is timing-safe.
function matches(storedHash, expiresAt, hash, at) {
  return typeof storedHash === "string" && HASH.test(storedHash) && Number.isFinite(expiresAt) && expiresAt > at
    && timingSafeEqual(Buffer.from(storedHash, "hex"), hash);
}

/** Store timestamps are milliseconds except DynamoDB TTL purgeAt (seconds). */
export function createDeviceTokenService({ store, issuer, now = Date.now }) {
  if (!store || typeof issuer !== "string" || !issuer)
    throw new Error("Device token service requires a store and issuer");
  const cache = new Map();
  const ownerFor = subject => {
    if (typeof subject !== "string" || !subject || subject.length > 1024)
      throw new DeviceTokenError("authentication_required", 401);
    return digest(issuer + "\0" + subject);
  };
  const cacheKey = (owner, id) => `${owner}:${id}`;

  // Matches the current secret, or promotes a pending one once. Results stay internal.
  async function authenticate(token, options) {
    if (typeof token !== "string") return null;
    const match = TOKEN.exec(token);
    if (!match) return null;
    const [, owner, id, secret] = match;
    if (Buffer.from(secret, "base64url").toString("base64url") !== secret) return null;
    const hash = Buffer.from(digest(secret), "hex");
    const key = cacheKey(owner, id);
    let cached = cache.get(key);
    if (cached && cached.until <= now()) {
      cache.delete(key);
      cached = undefined;
    }
    if (cached && matches(cached.record.secretHash, cached.record.expiresAt, hash, now()))
      return { owner, id, hash: cached.record.secretHash, expiresAt: cached.record.expiresAt, promoted: false };
    // A cached record cannot know about a renewal on another replica, so a mismatch reads again.
    for (let attempt = 0; attempt < 2; attempt++) {
      const readStarted = now();
      const record = await store.get(owner, id, options);
      const at = now();
      if (!record || record.owner !== owner || record.id !== id || record.revokedAt !== undefined) {
        cache.delete(key);
        return null;
      }
      if (matches(record.secretHash, record.expiresAt, hash, at)) {
        if (!cache.has(key) && cache.size >= 2048) cache.delete(cache.keys().next().value);
        cache.set(key, { record, until: Math.min(readStarted + 10000, record.expiresAt) });
        return { owner, id, hash: record.secretHash, expiresAt: record.expiresAt, promoted: attempt > 0 };
      }
      if (attempt > 0 || !matches(record.pendingHash, record.pendingExpiresAt, hash, at)) {
        // A token superseded by promotion should never return; its use suggests a copied token.
        // Flag the device once (the owner sees it on /collector) and still reject the request.
        if (record.reuseDetectedAt === undefined && matches(record.previousHash, Number.MAX_SAFE_INTEGER, hash, at))
          await store.flagReuse(owner, id, at, options).catch(() => {});
        return null;
      }
      cache.delete(key);
      const pending = { hash: record.pendingHash, expiresAt: record.pendingExpiresAt,
        purgeAt: purgeFor(record.pendingExpiresAt), previous: record.secretHash };
      if (await store.promote(owner, id, pending, at, options))
        return { owner, id, hash: pending.hash, expiresAt: pending.expiresAt, promoted: true };
      // Another replica won the promotion (or the record changed): verify the fresh record normally.
    }
    return null;
  }

  return {
    async issue(subject, input, options) {
      const owner = ownerFor(subject);
      if (!input || typeof input.name !== "string" || /[\u0000-\u001f\u007f-\u009f]/u.test(input.name)
        || !input.name.trim() || [...input.name.trim()].length > 64
        || !["linux", "darwin"].includes(input.platform))
        throw new DeviceTokenError("invalid_device");
      const createdAt = now();
      const secret = randomBytes(32).toString("base64url");
      const record = { owner, id: randomBytes(16).toString("hex"),
        name: input.name.trim(), platform: input.platform, secretHash: digest(secret),
        createdAt, expiresAt: createdAt + LIFETIME_MS,
        purgeAt: Math.floor((createdAt + LIFETIME_MS + 7 * 86400000) / 1000) };
      await store.put(record, options);
      return { device: deviceView(record), token: `ccd1.${owner}.${record.id}.${secret}` };
    },

    async list(subject, cursor, options) {
      const owner = ownerFor(subject);
      let key;
      if (cursor !== undefined && cursor !== null && cursor !== "") {
        try {
          if (typeof cursor !== "string" || cursor.length > 512 || !/^[\w-]+$/.test(cursor))
            throw new Error();
          key = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
          if (key.owner !== owner || !ID.test(key.id) || Object.keys(key).length !== 2)
            throw new Error();
        } catch { throw new DeviceTokenError("invalid_cursor"); }
      }
      const { items = [], lastKey } = await store.list(owner, key, options);
      if (items.length > 50 || items.some(item => item.owner !== owner)
        || (lastKey && (lastKey.owner !== owner || !ID.test(lastKey.id))))
        throw new DeviceTokenError("store_unavailable", 503);
      return { devices: items.map(deviceView),
        nextCursor: lastKey ? Buffer.from(JSON.stringify({ owner, id: lastKey.id })).toString("base64url") : null };
    },

    async revoke(subject, id, options) {
      const owner = ownerFor(subject);
      if (typeof id !== "string" || !ID.test(id)) throw new DeviceTokenError("device_not_found", 404);
      if (!await store.revoke(owner, id, now(), options)) throw new DeviceTokenError("device_not_found", 404);
      cache.delete(cacheKey(owner, id));
    },

    async verify(token, options) {
      const verified = await authenticate(token, options);
      // Internal identity only; callers never receive stored secret hashes.
      return verified ? { owner: verified.owner, id: verified.id } : null;
    },

    // `admit` rate-limits verified devices. A pending token is promoted here but never mints another.
    async renew(token, { admit, ...options } = {}) {
      const verified = await authenticate(token, options);
      if (!verified) throw new DeviceTokenError("invalid_token", 401);
      if (admit && !admit({ owner: verified.owner, id: verified.id }))
        throw new DeviceTokenError("renew_rate_limited", 429);
      const at = now();
      if (verified.promoted || verified.expiresAt - at > RENEW_WINDOW_MS)
        return { renewed: false, expiresAt: new Date(verified.expiresAt).toISOString() };
      const secret = randomBytes(32).toString("base64url");
      const expiresAt = at + LIFETIME_MS;
      // Replaces any earlier pending token; the current token stays valid until promotion.
      if (!await store.stage(verified.owner, verified.id, verified.hash,
        { hash: digest(secret), issuedAt: at, expiresAt, purgeAt: purgeFor(expiresAt) }, options))
        throw new DeviceTokenError("invalid_token", 401);
      return { renewed: true, token: `ccd1.${verified.owner}.${verified.id}.${secret}`,
        expiresAt: new Date(expiresAt).toISOString() };
    },

    async touch(identity, options) {
      if (!identity || !/^[a-f0-9]{64}$/.test(identity.owner) || !ID.test(identity.id))
        throw new DeviceTokenError("invalid_token", 401);
      return store.touch(identity.owner, identity.id, now(), options);
    },
  };
}
